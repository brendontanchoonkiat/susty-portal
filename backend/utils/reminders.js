'use strict';
// ─── Duty Reminders Cron ─────────────────────────────────────────────────────
// Sends Telegram DMs to members 5 days and 1 day before their duty slot.
// Requires: grammy bot instance, Supabase configured.
// Run via: startReminderCron(bot) in server.js
// ─────────────────────────────────────────────────────────────────────────────

let cron;
try { cron = require('node-cron'); }
catch { console.warn('[Reminders] node-cron not installed — run npm install node-cron. Reminders disabled.'); }

const db = require('./supabase');

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
  }, { timezone: 'UTC' });

  console.log('[Reminders] Cron scheduled: daily at 09:00 SGT');
}

// TLs who get birthday heads-up DMs (same list the bot uses for admin access)
const BIRTHDAY_TL_NAMES = (process.env.TL_NAMES || 'Brendon,Judy,Wee Shing').split(',').map(n => n.trim());

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

      try {
        await bot.api.sendMessage(member.telegram_id, msg, { parse_mode: 'HTML' });
        console.log(`[Reminders] Sent ${daysUntil}d reminder to ${memberName}`);
      } catch (err) {
        console.warn(`[Reminders] Failed to DM ${memberName}:`, err.message);
      }

      // Small delay to avoid Telegram rate limits
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

function fiveDayMsg(slot, name) {
  const partners = (slot.team || []).filter(n => n !== name).join(' & ') || '—';
  return (
    `⏰ <b>W2R Reminder — 5 Days to Go!</b>\n\n` +
    `Hi <b>${name}</b> 👋\n\n` +
    `You're rostered to serve W2R on:\n` +
    `📅 <b>${slot.date}</b> (${slot.session})\n` +
    `👥 Serving with: ${partners}\n\n` +
    `Can't make it? Open the bot and tap Roster → Request Swap.\n\n` +
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
    `See you there! 💪\n\n` +
    `— Sustainability Ministry 🌿`
  );
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

module.exports = { startReminderCron, postSessionSummary, sendBirthdayReminders };
