'use strict';
const express = require('express');
const router  = express.Router();

// ─── Google Sheets live sync ──────────────────────────────────────────────────
// Pulls from 3 tabs: "IM 2024", "IM 2025", "IM 2026" in one batchGet call.
// Sheet structure (wide format):
//   Row 2  (index 1): month labels  e.g. "1 Jan to 31 Jan"
//   Row 6  (index 5): L3 electricity (kWh)
//   Row 14 (index 13): L3 water (m³)
//   Row 20 (index 19): L4 electricity (kWh)
//   Row 24 (index 23): L4 water (m³)
//   Cols D–P (index 3–15): Jan–Dec
const ENERGY_SHEET_ID = process.env.ENERGY_SHEET_ID || '14RDK73qYY-9bO1UXXAxrFhL6AziRhVIljQCzTpFZSoc';
const API_KEY         = process.env.GOOGLE_SHEETS_API_KEY;

const SHEET_YEARS    = ['2024', '2025', '2026'];
const DATA_START_COL = 3;
const ROW = { label: 1, l3Elec: 5, l3Water: 13, l4Elec: 19, l4Water: 23 };
const MAX_KWH_MONTH  = 500000;
const MAX_M3_MONTH   = 5000;

let cache = { electricity: [], water: [], lastFetched: null, source: null };
const CACHE_TTL_MS = 10 * 60 * 1000;

const MONTH_MAP = {
  jan:'Jan', feb:'Feb', mar:'Mar', apr:'Apr', may:'May', jun:'Jun',
  jul:'Jul', aug:'Aug', sep:'Sep', oct:'Oct', nov:'Nov', dec:'Dec',
  june:'Jun', july:'Jul',
};
function parseLabelToMonth(label, year) {
  const match = String(label || '').match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|june|july)\b/i);
  if (!match) return null;
  const abbr = MONTH_MAP[match[1].toLowerCase()];
  return abbr ? `${abbr} ${year}` : null;
}

function safeNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[,\s]/g, '');
  if (s.startsWith('#')) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

async function fetchFromSheets() {
  if (!API_KEY) {
    console.warn('[Energy] GOOGLE_SHEETS_API_KEY not set — using static fallback');
    return null;
  }
  const ranges = SHEET_YEARS.map(y => `'IM ${y}'!A1:P30`);
  const params = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
  const url    = `https://sheets.googleapis.com/v4/spreadsheets/${ENERGY_SHEET_ID}/values:batchGet?${params}&key=${API_KEY}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sheets API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json        = await res.json();
  const valueRanges = json.valueRanges || [];
  const elecPoints  = [];
  const waterPoints = [];

  for (let yi = 0; yi < SHEET_YEARS.length; yi++) {
    const year = SHEET_YEARS[yi];
    const rows = (valueRanges[yi] && valueRanges[yi].values) || [];

    const labelRow   = rows[ROW.label]   || [];
    const l3ElecRow  = rows[ROW.l3Elec]  || [];
    const l3WaterRow = rows[ROW.l3Water] || [];
    const l4ElecRow  = rows[ROW.l4Elec]  || [];
    const l4WaterRow = rows[ROW.l4Water] || [];

    for (let col = DATA_START_COL; col < labelRow.length; col++) {
      const month = parseLabelToMonth(labelRow[col], year);
      if (!month) continue;

      const l3e = safeNum(l3ElecRow[col]);
      const l4e = safeNum(l4ElecRow[col]);
      if (l3e !== null && l4e !== null) {
        const t = l3e + l4e;
        if (t > 0 && t <= MAX_KWH_MONTH) elecPoints.push({ month, kwh: Math.round(t) });
      } else if (l3e !== null && l3e > 0 && l3e <= MAX_KWH_MONTH) {
        elecPoints.push({ month, kwh: Math.round(l3e) });
      }

      const l3w = safeNum(l3WaterRow[col]);
      const l4w = safeNum(l4WaterRow[col]);
      if (l3w !== null && l4w !== null) {
        const t = l3w + l4w;
        if (t > 0 && t <= MAX_M3_MONTH) waterPoints.push({ month, m3: Math.round(t * 100) / 100 });
      } else if (l3w !== null && l3w > 0 && l3w <= MAX_M3_MONTH) {
        waterPoints.push({ month, m3: Math.round(l3w * 100) / 100 });
      }
    }
  }
  return { electricity: elecPoints, water: waterPoints };
}

async function getData() {
  const now = Date.now();
  if (cache.lastFetched && (now - cache.lastFetched) < CACHE_TTL_MS) return cache;

  try {
    const live = await fetchFromSheets();
    if (live && live.electricity.length > 0) {
      cache = { ...live, lastFetched: now, source: 'live' };
      console.log(`[Energy] Live: ${live.electricity.length} elec, ${live.water.length} water records`);
    } else {
      throw new Error('no live data');
    }
  } catch (err) {
    console.warn('[Energy] Using static fallback:', err.message);
    // eslint-disable-next-line global-require
    const { electricityData, waterData } = require('../data/energy');
    cache = {
      electricity: (electricityData || []).filter(r => r.kwh),
      water:       (waterData || []).filter(r => r.m3),
      lastFetched: now,
      source:      'fallback',
    };
  }
  return cache;
}

router.get('/electricity', async (_req, res) => { const d = await getData(); res.json(d.electricity); });
router.get('/water',       async (_req, res) => { const d = await getData(); res.json(d.water); });

router.get('/summary', async (_req, res) => {
  const d = await getData();
  res.json({
    electricity: { latest: d.electricity.slice(-1)[0] || null, total: Math.round(d.electricity.reduce((s, r) => s + (r.kwh || 0), 0)) },
    water:       { latest: d.water.slice(-1)[0] || null },
    source:      d.source,
    cachedAt:    d.lastFetched,
  });
});

router.get('/status', (_req, res) => {
  res.json({
    apiKeySet:       !!API_KEY,
    sheetId:         ENERGY_SHEET_ID,
    source:          cache.source || 'not-yet-fetched',
    electricityRecs: cache.electricity ? cache.electricity.length : null,
    waterRecs:       cache.water ? cache.water.length : null,
    cacheAgeMs:      cache.lastFetched ? Date.now() - cache.lastFetched : null,
  });
});

router.post('/refresh', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (_req, res) => {
  cache.lastFetched = null;
  const d = await getData();
  res.json({ ok: true, source: d.source, electricityRecs: d.electricity.length, waterRecs: d.water.length });
});

// Export getData for weekly snapshot
router.getData = getData;

module.exports = router;
