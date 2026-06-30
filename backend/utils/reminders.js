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
  }, { timezone: 'UTC' });

  console.log('[Reminders] Cron scheduled: daily at 09:00 SGT');
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

module.exports = { startReminderCron, postSessionSummary };
