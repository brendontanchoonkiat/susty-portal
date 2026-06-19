'use strict';

// ─── W2R Telegram Message Templates ──────────────────────────────────────────
// DRAFT — edit these before going live.
// Fields in [SQUARE BRACKETS] need to be filled in.
// Uses Telegram HTML formatting: <b>bold</b>, <i>italic</i>
// ─────────────────────────────────────────────────────────────────────────────

function dayName(dateStr) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(dateStr);
  return isNaN(d) ? dateStr : days[d.getDay()];
}

// ─── 1. Roster Change Notification ───────────────────────────────────────────
// Sent to group when a member's slot has been updated.
// `name`    — the person whose slot changed
// `newSlot` — { date, session, team }
// `oldSlot` — { date, session } of their previous assignment (optional)

function rosterChangeMsg(name, newSlot, oldSlot) {
  const partner = newSlot.team.filter(t => t !== name).join(' & ') || '—';
  const oldLine = oldSlot
    ? `\n🔁 <i>Previously: ${oldSlot.date} (${oldSlot.session})</i>`
    : '';

  return (
    `📣 <b>Roster Update — W2R</b>${oldLine}\n\n` +
    `Hi <b>${name}</b>! Your recycling roster slot has been updated.\n\n` +
    `✅ <b>New slot:</b>\n` +
    `📅 ${newSlot.date} (${newSlot.session})\n` +
    `👥 Serving with: ${partner}\n\n` +
    `Please take note of the change. If you have any questions, reach out to your team lead!\n\n` +
    `— Sustainability Ministry 🌿`
  );
}

// ─── 2. 5-Day Reminder ───────────────────────────────────────────────────────
// Sent to group 5 days before the serving date.
// `slot` — { date, session, team: ['Name1', 'Name2'] }

function fiveDayReminderMsg(slot) {
  const names   = slot.team.join(' & ');
  const dayWord = dayName(slot.date);

  return (
    `⏰ <b>W2R Reminder — Serving in 5 Days!</b>\n\n` +
    `Hi <b>${names}</b> 👋\n\n` +
    `You're rostered to serve W2R this coming <b>${dayWord}, ${slot.date}</b>.\n\n` +
    `📅 Session: ${slot.session}\n` +
    `👥 Team: ${names}\n` +
    `📦 Remember to bring: Gloves &amp; comfortable clothes\n` +
    `📍 Meet at: <b>[LOCATION — edit this]</b>\n` +
    `🕐 Report by: <b>[TIME — edit this]</b>\n\n` +
    `See you there! 💪🌿`
  );
}

// ─── 3. 1-Day Reminder ───────────────────────────────────────────────────────
// Sent to group 1 day before the serving date.
// `slot` — { date, session, team: ['Name1', 'Name2'] }

function oneDayReminderMsg(slot) {
  const names   = slot.team.join(' & ');
  const dayWord = dayName(slot.date);

  return (
    `🌿 <b>W2R Reminder — Serving Tomorrow!</b>\n\n` +
    `Hi <b>${names}</b> 👋\n\n` +
    `Just a reminder that you're serving W2R <b>tomorrow, ${dayWord} ${slot.date}</b> (${slot.session})!\n\n` +
    `📍 Meet at: <b>[LOCATION — edit this]</b>\n` +
    `🕐 Report by: <b>[TIME — edit this]</b>\n` +
    `📦 Bring: Gloves &amp; comfortable clothes\n\n` +
    `Please reply <b>✅</b> to confirm you're all set!\n\n` +
    `— Sustainability Ministry 🌿`
  );
}

module.exports = { rosterChangeMsg, fiveDayReminderMsg, oneDayReminderMsg };
