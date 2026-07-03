'use strict';

// ─── W2R Telegram Message Templates ──────────────────────────────────────────
// Uses Telegram HTML formatting: <b>bold</b>, <i>italic</i>
// ─────────────────────────────────────────────────────────────────────────────

function dayName(dateStr) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(dateStr);
  return isNaN(d) ? dateStr : days[d.getDay()];
}

function rosterChangeMsg(name, newSlot, oldSlot) {
  const partner = newSlot.team.filter(t => t !== name).join(' & ') || '—';
  const oldLine = oldSlot ? `\n🔁 <i>Previously: ${oldSlot.date} (${oldSlot.session})</i>` : '';
  return (
    `📣 <b>Roster Update — W2R</b>${oldLine}\n\n` +
    `Hi <b>${name}</b>! Your recycling roster slot has been updated.\n\n` +
    `✅ <b>New slot:</b>\n📅 ${newSlot.date} (${newSlot.session})\n👥 Serving with: ${partner}\n\n` +
    `Please take note of the change. If you have any questions, reach out to your team lead!\n\n` +
    `— Sustainability Ministry 🌿`
  );
}

// fiveDayReminderMsg / oneDayReminderMsg (group-broadcast templates with
// placeholder [LOCATION]/[TIME] + "bring gloves" text) removed 3 Jul 2026 —
// duty reminders are now sent per-member via DM, see utils/reminders.js.

function weeklySnapshotMsg(data) {
  const { cardboard, plastic, electricity, water, energySource, weekLabel } = data;
  const wLabel = weekLabel || `Week of ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const cbLine   = cardboard   ? `📦 Cardboard: <b>${cardboard.latestKg} kg</b> (${cardboard.latestMonth}) — cumulative: ${cardboard.totalKg} kg`   : `📦 Cardboard: <i>no data</i>`;
  const plLine   = plastic     ? `🧴 Plastic: <b>${plastic.latestKg} kg</b> (${plastic.latestMonth}) — cumulative: ${plastic.totalKg} kg`             : `🧴 Plastic: <i>no data</i>`;
  const elecLine = electricity ? `⚡ Electricity: <b>${electricity.latestKwh.toLocaleString()} kWh</b> (${electricity.latestMonth})`                  : `⚡ Electricity: <i>no data</i>`;
  const waterLine= water       ? `💧 Water: <b>${water.latestM3} m³</b> (${water.latestMonth})`                                                       : `💧 Water: <i>no data</i>`;
  const note     = energySource === 'fallback' ? `\n⚠️ <i>Energy from static backup — live sheet unavailable.</i>` : '';

  return (
    `📊 <b>Weekly Sustainability Snapshot</b>\n<i>${wLabel}</i>\n\n` +
    `♻️ <b>Waste to Resource (W2R)</b>\n${cbLine}\n${plLine}\n\n` +
    `🏢 <b>Energy Consumption</b>\n${elecLine}\n${waterLine}${note}\n\n` +
    `— Sustainability Ministry 🌿`
  );
}

module.exports = { rosterChangeMsg, weeklySnapshotMsg };
