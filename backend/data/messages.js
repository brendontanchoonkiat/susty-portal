'use strict';

// ─── W2R Telegram Message Templates ──────────────────────────────────────────
// Uses Telegram HTML formatting: <b>bold</b>, <i>italic</i>
// ─────────────────────────────────────────────────────────────────────────────

function dayName(dateStr) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(dateStr);
  return isNaN(d) ? dateStr : days[d.getDay()];
}

// ─── 1. Roster Change Notification ───────────────────────────────────────────
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

// ─── 4. Weekly Snapshot ───────────────────────────────────────────────────────
// Auto-sent every Monday 09:00 SGT. Also triggerable via POST /api/telegram/weekly-snapshot
function weeklySnapshotMsg(data) {
  const { cardboard, plastic, electricity, water, energySource, weekLabel } = data;

  const wLabel = weekLabel || (() => {
    const d = new Date();
    return `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  })();

  const cbLine = cardboard
    ? `📦 Cardboard: <b>${cardboard.latestKg} kg</b> (${cardboard.latestMonth}) — cumulative: ${cardboard.totalKg} kg`
    : `📦 Cardboard: <i>no data</i>`;

  const plLine = plastic
    ? `🧴 Plastic bottles: <b>${plastic.latestKg} kg</b> (${plastic.latestMonth}) — cumulative: ${plastic.totalKg} kg`
    : `🧴 Plastic bottles: <i>no data</i>`;

  const elecLine = electricity
    ? `⚡ Electricity: <b>${electricity.latestKwh.toLocaleString()} kWh</b> (${electricity.latestMonth})`
    : `⚡ Electricity: <i>no data</i>`;

  const waterLine = water
    ? `💧 Water: <b>${water.latestM3} m³</b> (${water.latestMonth})`
    : `💧 Water: <i>no data</i>`;

  const energyNote = energySource === 'fallback'
    ? `\n⚠️ <i>Energy figures from static backup — live sheet unavailable.</i>`
    : '';

  return (
    `📊 <b>Weekly Sustainability Snapshot</b>\n` +
    `<i>${wLabel}</i>\n\n` +
    `♻️ <b>Waste to Resource (W2R)</b>\n` +
    `${cbLine}\n` +
    `${plLine}\n\n` +
    `🏢 <b>Energy Consumption</b>\n` +
    `${elecLine}\n` +
    `${waterLine}` +
    `${energyNote}\n\n` +
    `— Sustainability Ministry 🌿`
  );
}

module.exports = { rosterChangeMsg, fiveDayReminderMsg, oneDayReminderMsg, weeklySnapshotMsg };
