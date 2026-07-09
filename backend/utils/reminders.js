'use strict';
// ─── Duty Reminders Cron ─────────────────────────────────────────────────────
// Sends Telegram DMs to members 5 days and 1 day before their duty slot.
// Requires: grammy bot instance, Supabase configured.
// Run via: startReminderCron(bot) in server.js
// ─────────────────────────────────────────────────────────────────────────────

let cron;
try { cron = require('node-cron'); }
catch { console.warn('[Reminders] node-cron not installed — run npm install node-cron. Reminders disabled.'); }

const { InlineKeyboard } = require('grammy');
const db = require('./supabase');
const commsNotify = require('./commsNotify');

/**
 * Start reminder cron. Fires daily at 09:00 SGT (01:00 UTC).
 * @param {import('grammy').Bot} bot
 */
function startReminderCron(bot) {
  if (!cron) return;

  // Daily at 01:00 UTC (09:00 SGT)
  cron.schedule('0 1 * * *', async () => {
    console.log('[Reminders] Running daily duty check...');
    await sendDutyReminders(bot);
    await sendBirthdayReminders(bot);
    await sendCommsReminders(bot);
  }, { timezone: 'UTC' });

  console.log('[Reminders] Cron scheduled: daily at 09:00 SGT');
}

// TLs who get birthday heads-up DMs (same list the bot uses for admin access)
const BIRTHDAY_TL_NAMES = (process.env.TL_NAMES || 'Brendon,Judy,Wee Shing').split(',').map(n => n.trim());

// Who gets a CC digest whenever duty reminders actually go out. Defaults to
// just Brendon; set REMINDER_CC_NAMES on Railway (comma-separated) to add
// others without a redeploy.
const REMINDER_CC_NAMES = (process.env.REMINDER_CC_NAMES || 'Brendon').split(',').map(n => n.trim());

// Sends a single digest DM (not a per-member duplicate) to REMINDER_CC_NAMES
// listing everything sendDutyReminders just sent out. Skipped entirely if
// nothing was sent that day (expected on most days — only fires when a slot
// is exactly 5 or 1 day out).
async function ccDutyReminders(bot, sentLog) {
  if (!sentLog.length) return;
  const supa = db.getClient();
  if (!supa) return;

  const lines = sentLog.map(s =>
    `  • <b>${s.memberName}</b> — ${s.daysUntil}d reminder for ${s.date} (${s.session})`
  ).join('\n');
  const msg = `📋 <b>Duty Reminder Digest</b>\n\n${lines}`;

  for (const ccName of REMINDER_CC_NAMES) {
    const { data: cc } = await supa.from('members').select('telegram_id').ilike('name', ccName).single();
    if (!cc?.telegram_id) continue;
    try {
      await bot.api.sendMessage(cc.telegram_id, msg, { parse_mode: 'HTML' });
      console.log(`[Reminders] Sent CC digest to ${ccName}`);
    } catch (err) {
      console.warn(`[Reminders] CC digest to ${ccName} failed:`, err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

/**
 * DMs the TLs when a member's birthday is today, or exactly 7 days away —
 * mirrors the 5-day/1-day pattern used for duty reminders. Runs as part of
 * the daily cron; only sends a message on days where something's actually
 * upcoming, so it doesn't repeat for the same birthday every day.
 */
async function sendBirthdayReminders(bot) {
  const supa = db.getClient();
  if (!supa) return;

  const { data: rows } = await supa.from('member_roster')
    .select('name, date_of_birth')
    .eq('is_active', true)
    .not('date_of_birth', 'is', null);
  if (!rows?.length) return;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmtMD = (d) => d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short' });

  const todayList = [];
  const weekList  = [];

  for (const r of rows) {
    const dob = new Date(r.date_of_birth + 'T00:00:00');
    let next = new Date(today.getFullYear(), dob.getMonth(), dob.getDate());
    if (next < today) next = new Date(today.getFullYear() + 1, dob.getMonth(), dob.getDate());
    const daysUntil = Math.round((next - today) / 86400000);

    if (daysUntil === 0) todayList.push({ name: r.name, display: fmtMD(dob) });
    else if (daysUntil === 7) weekList.push({ name: r.name, display: fmtMD(dob) });
  }

  if (!todayList.length && !weekList.length) return;

  let msg = `🎂 <b>Birthday Reminder</b>\n\n`;
  if (todayList.length) {
    msg += `🎉 <b>Today:</b>\n${todayList.map(u => `  • ${u.name} (${u.display})`).join('\n')}\n\n`;
  }
  if (weekList.length) {
    msg += `📅 <b>In 7 days:</b>\n${weekList.map(u => `  • ${u.name} (${u.display})`).join('\n')}\n\n`;
  }
  msg += `<i>Worth factoring into next month's roster.</i>`;

  for (const tlName of BIRTHDAY_TL_NAMES) {
    const { data: tl } = await supa.from('members').select('telegram_id').ilike('name', tlName).single();
    if (!tl?.telegram_id) continue;
    try {
      await bot.api.sendMessage(tl.telegram_id, msg, { parse_mode: 'HTML' });
      console.log(`[Reminders] Sent birthday reminder to ${tlName}`);
    } catch (err) {
      console.warn(`[Reminders] Birthday DM to ${tlName} failed:`, err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function sendDutyReminders(bot) {
  const supa = db.getClient();
  if (!supa) return;

  const today    = new Date();
  const in5Days  = new Date(today); in5Days.setDate(today.getDate() + 5);
  const in1Day   = new Date(today); in1Day.setDate(today.getDate() + 1);

  const fmt = (d) => d.toISOString().split('T')[0];

  // Get slots on both target dates
  const { data: slots } = await supa.from('roster_slots')
    .select('*')
    .in('date', [fmt(in5Days), fmt(in1Day)]);

  if (!slots?.length) return;

  const sentLog = []; // { memberName, daysUntil, date, session } — for the CC digest below

  for (const slot of slots) {
    const daysUntil = slot.date === fmt(in1Day) ? 1 : 5;

    for (const memberName of (slot.team || [])) {
      // Look up Telegram ID for this member
      const { data: member } = await supa.from('members')
        .select('telegram_id, remind_on')
        .ilike('name', memberName)
        .single();

      if (!member || !member.remind_on) continue;

      const msg = daysUntil === 1
        ? oneDayMsg(slot, memberName)
        : fiveDayMsg(slot, memberName);
      const kb = confirmKb(slot.id);

      try {
        await bot.api.sendMessage(member.telegram_id, msg, { parse_mode: 'HTML', reply_markup: kb });
        console.log(`[Reminders] Sent ${daysUntil}d reminder to ${memberName}`);
        sentLog.push({ memberName, daysUntil, date: slot.date, session: slot.session });
      } catch (err) {
        console.warn(`[Reminders] Failed to DM ${memberName}:`, err.message);
      }

      // Small delay to avoid Telegram rate limits
      await new Promise(r => setTimeout(r, 200));
    }
  }

  await ccDutyReminders(bot, sentLog);
}

function fiveDayMsg(slot, name) {
  const partners = (slot.team || []).filter(n => n !== name).join(' & ') || '—';
  return (
    `⏰ <b>W2R Reminder — 5 Days to Go!</b>\n\n` +
    `Hi <b>${name}</b> 👋\n\n` +
    `You're rostered to serve W2R on:\n` +
    `📅 <b>${slot.date}</b> (${slot.session})\n` +
    `👥 Serving with: ${partners}\n\n` +
    `Can you still make it? Tap below to confirm, or use Roster → Request Swap if not.\n\n` +
    `— Sustainability Ministry 🌿`
  );
}

function oneDayMsg(slot, name) {
  const partners = (slot.team || []).filter(n => n !== name).join(' & ') || '—';
  return (
    `🌿 <b>W2R Reminder — Serving Tomorrow!</b>\n\n` +
    `Hi <b>${name}</b>!\n\n` +
    `You're on duty <b>tomorrow</b>:\n` +
    `📅 <b>${slot.date}</b> (${slot.session})\n` +
    `👥 With: ${partners}\n\n` +
    `Please confirm you're all set below!\n\n` +
    `— Sustainability Ministry 🌿`
  );
}

// Inline confirm / can't-make-it buttons attached to each DM reminder.
// slotId lets the bot's callback handler (bot/index.js, remind:confirm /
// remind:cantmake) know which duty this was about.
function confirmKb(slotId) {
  return new InlineKeyboard()
    .text('✅ I\'ll be there', `remind:confirm:${slotId}`)
    .text('⚠️ Can\'t make it', `remind:cantmake:${slotId}`);
}

// Post a session summary to the group after a duty day
async function postSessionSummary(bot, slotDate) {
  const supa = db.getClient();
  if (!supa || !process.env.TELEGRAM_CHAT_ID) return;

  const { data: logs } = await supa.from('data_logs')
    .select('*').eq('session_date', slotDate);

  if (!logs?.length) return;

  const cb    = logs.filter(l => l.type === 'cardboard').reduce((s, l) => s + Number(l.kg), 0);
  const pl    = logs.filter(l => l.type === 'plastic').reduce((s, l) => s + Number(l.kg), 0);
  const by    = [...new Set(logs.map(l => l.logged_by))].join(', ');
  const pics  = logs.filter(l => l.image_url || l.file_id).length;

  const { calcCO2e } = require('./carbon');
  const impact = calcCO2e(cb, pl);

  const msg =
    `📊 <b>Session Summary — ${slotDate}</b>\n\n` +
    `📦 Cardboard: <b>${cb.toFixed(1)} kg</b>\n` +
    `🍶 Plastic:   <b>${pl.toFixed(1)} kg</b>\n` +
    `🌍 CO₂e avoided: <b>${impact.co2eKg} kg</b>\n` +
    `📷 ${pics} photo${pics !== 1 ? 's' : ''} logged\n` +
    `👥 Logged by: ${by}\n\n` +
    `Great work team! 💪🌿`;

  await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' }).catch(() => {});
}

/**
 * Comms post-planning reminders — runs as part of the daily cron alongside
 * duty/birthday reminders. Three separate nudges, all opt-in via what's
 * actually due (skips silently if nothing qualifies, same pattern as the
 * duty reminders):
 *   1. Owner nudge — post is scheduled for tomorrow but still idea/draft/
 *      planned (never submitted for review).
 *   2. TL nudge — any post currently sitting in pending_review, so approvals
 *      don't get missed.
 *   3. TL nudge — approved posts due today/tomorrow, ready to actually publish.
 */
async function sendCommsReminders(bot) {
  const supa = db.getClient();
  if (!supa) return;

  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const fmt = (d) => d.toISOString().split('T')[0];

  const { data: posts } = await supa.from('comms_posts')
    .select('*')
    .in('status', ['idea', 'draft', 'planned', 'pending_review', 'approved'])
    .gte('date', fmt(today));
  if (!posts?.length) return;

  // 1. Owner nudge
  const needsSubmit = posts.filter(p => p.date === fmt(tomorrow) && ['idea', 'draft', 'planned'].includes(p.status));
  for (const p of needsSubmit) {
    const ownerName = p.created_by || p.owner;
    const id = await commsNotify.getTelegramIdForName(ownerName);
    if (!id) continue;
    try {
      await bot.api.sendMessage(id,
        `⏰ <b>Comms reminder</b>\n\n📅 "${p.theme}" is scheduled for tomorrow (${commsNotify.fmtDate(p.date)}) but hasn't been submitted for review yet.\n\n` +
        `Finish it up in the portal Comms tab and tap Submit for Review.`,
        { parse_mode: 'HTML' }
      );
      console.log(`[Reminders] Sent comms submit-nudge to ${ownerName}`);
    } catch (err) {
      console.warn(`[Reminders] Comms nudge to ${ownerName} failed:`, err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // 2. TL nudge — pending approvals
  const pendingReview = posts.filter(p => p.status === 'pending_review');
  if (pendingReview.length) {
    const lines = pendingReview.map(p => `  • ${commsNotify.fmtDate(p.date)} — ${p.theme}`).join('\n');
    const msg = `✅ <b>Comms — Pending Your Approval</b>\n\n${lines}\n\nOpen the bot's 📢 Comms menu to review.`;
    const tls = await commsNotify.getTLTelegramIds();
    for (const tl of tls) {
      try {
        await bot.api.sendMessage(tl.telegram_id, msg, { parse_mode: 'HTML' });
      } catch (err) {
        console.warn(`[Reminders] Comms approval nudge to ${tl.name} failed:`, err.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // 3. TL nudge — ready to post
  const readyToPost = posts.filter(p => p.status === 'approved' && (p.date === fmt(today) || p.date === fmt(tomorrow)));
  if (readyToPost.length) {
    const lines = readyToPost.map(p => `  • ${commsNotify.fmtDate(p.date)} — ${p.theme}`).join('\n');
    const msg = `📮 <b>Comms — Ready to Post</b>\n\n${lines}\n\nOpen the bot's 📢 Comms menu → Ready to Post, publish it, then tap Mark as Posted.`;
    const tls = await commsNotify.getTLTelegramIds();
    for (const tl of tls) {
      try {
        await bot.api.sendMessage(tl.telegram_id, msg, { parse_mode: 'HTML' });
      } catch (err) {
        console.warn(`[Reminders] Comms ready-to-post nudge to ${tl.name} failed:`, err.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

module.exports = { startReminderCron, postSessionSummary, sendBirthdayReminders, sendDutyReminders, sendCommsReminders };
