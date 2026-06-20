'use strict';
// ─── Weekly Snapshot ──────────────────────────────────────────────────────────
// Called by the Monday 09:00 SGT cron in server.js AND by
// POST /api/telegram/weekly-snapshot for manual testing.
// Lazy-loads route modules so their getData() caches are shared.
// ─────────────────────────────────────────────────────────────────────────────

const { notifyTelegram }    = require('./telegram');
const { weeklySnapshotMsg } = require('../data/messages');

let _recycling = null;
let _energy    = null;
function recycling() { return _recycling || (_recycling = require('../routes/recycling')); }
function energy()    { return _energy    || (_energy    = require('../routes/energy'));    }

async function sendWeeklySnapshot(weekLabel) {
  const [recycData, energyData] = await Promise.all([
    recycling().getData(),
    energy().getData(),
  ]);

  const cb = recycData.cardboard || [];
  const pl = recycData.plastic   || [];

  const cardboard = cb.length ? {
    latestMonth: cb[cb.length - 1].month,
    latestKg:    cb[cb.length - 1].kg,
    totalKg:     Math.round(cb.reduce((s, r) => s + r.kg, 0) * 100) / 100,
  } : null;

  const plastic = pl.length ? {
    latestMonth: pl[pl.length - 1].month,
    latestKg:    pl[pl.length - 1].kg,
    totalKg:     Math.round(pl.reduce((s, r) => s + r.kg, 0) * 100) / 100,
  } : null;

  const elecArr  = energyData.electricity || [];
  const waterArr = energyData.water       || [];

  const electricity = elecArr.length ? {
    latestMonth: elecArr[elecArr.length - 1].month,
    latestKwh:   elecArr[elecArr.length - 1].kwh,
  } : null;

  const water = waterArr.length ? {
    latestMonth: waterArr[waterArr.length - 1].month,
    latestM3:    waterArr[waterArr.length - 1].m3,
  } : null;

  const msg = weeklySnapshotMsg({
    cardboard,
    plastic,
    electricity,
    water,
    energySource: energyData.source,
    weekLabel:    weekLabel || null,
  });

  return await notifyTelegram(msg);
}

module.exports = { sendWeeklySnapshot };
