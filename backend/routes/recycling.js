'use strict';
const express = require('express');
const router  = express.Router();

// ─── Google Sheets live sync ──────────────────────────────────────────────────
// Sheet ID from Google Drive
const SHEET_ID  = '1ELi47Yq9oPcMqElZGYjWDgnRfS1gVHTwjOseEx5ZPmk';
const API_KEY   = process.env.GOOGLE_SHEETS_API_KEY;

// In-memory cache: refreshed every 5 minutes
let cache = { cardboard: [], plastic: [], lastFetched: null };
const CACHE_TTL_MS = 5 * 60 * 1000;

// Hardcoded fallback (used if Sheets API key not configured)
const FALLBACK = {
  cardboard: [
    { month: 'Mar 2025', kg: 71 }, { month: 'Apr 2025', kg: 25 },
    { month: 'May 2025', kg: 33 }, { month: 'Jun 2025', kg: 60 },
    { month: 'Jul 2025', kg: 292 },{ month: 'Aug 2025', kg: 52 },
    { month: 'Sep 2025', kg: 83 }, { month: 'Oct 2025', kg: 54 },
    { month: 'Nov 2025', kg: 46 }, { month: 'Dec 2025', kg: 58 },
    { month: 'Jan 2026', kg: 280 },{ month: 'Feb 2026', kg: 48 },
    { month: 'Mar 2026', kg: 64 },
  ],
  plastic: [
    { month: 'Jul 2025', kg: 40 }, { month: 'Sep 2025', kg: 8 },
    { month: 'Oct 2025', kg: 9 },  { month: 'Nov 2025', kg: 3 },
    { month: 'Dec 2025', kg: 4 },  { month: 'Jan 2026', kg: 13.09 },
    { month: 'Feb 2026', kg: 1 },  { month: 'Mar 2026', kg: 8 },
  ],
};

async function fetchFromSheets() {
  if (!API_KEY) return null; // no key = use fallback

  // Sheet uses named ranges: "CardboardSummary" and "PlasticSummary"
  // We fetch the summary tab (first sheet) values via Sheets API v4
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A1:L50?key=${API_KEY}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const json = await res.json();
  return parseSheetData(json.values || []);
}

function parseSheetData(rows) {
  // The summary table starts at row 1 (0-indexed) with headers
  // Columns: Month | Cardboard kg | Cumulative | (blank) | Month | Cardboard kg | ...
  // We parse both 2025 and 2026 columns
  const cardboard = [];
  const plastic   = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // 2025 cardboard column (col 0 = month, col 1 = kg)
    if (row[0] && row[1] && row[1].replace(/[^0-9.]/g,'')) {
      const kg = parseFloat(row[1].replace(/[^0-9.]/g,''));
      if (!isNaN(kg) && kg > 0) cardboard.push({ month: row[0].replace("'", ' 20'), kg });
    }
    // 2026 cardboard column (col 3 = month, col 4 = kg)
    if (row[3] && row[4] && row[4].replace(/[^0-9.]/g,'')) {
      const kg = parseFloat(row[4].replace(/[^0-9.]/g,''));
      if (!isNaN(kg) && kg > 0) cardboard.push({ month: row[3].replace("'", ' 20'), kg });
    }
  }

  // Plastic rows follow cardboard rows — detected by offset
  // For now return cardboard only from live; plastic uses fallback
  // (extend this when plastic gets its own summary tab)
  return { cardboard, plastic: null };
}

async function getData() {
  const now = Date.now();
  if (cache.lastFetched && (now - cache.lastFetched) < CACHE_TTL_MS) return cache;

  try {
    const live = await fetchFromSheets();
    if (live && live.cardboard.length > 0) {
      cache = {
        cardboard:   live.cardboard,
        plastic:     live.plastic || FALLBACK.plastic,
        lastFetched: now,
        source:      'live',
      };
    } else {
      cache = { ...FALLBACK, lastFetched: now, source: 'fallback' };
    }
  } catch (err) {
    console.warn('[Recycling] Sheets fetch failed, using fallback:', err.message);
    cache = { ...FALLBACK, lastFetched: now, source: 'fallback' };
  }
  return cache;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get('/cardboard', async (_req, res) => {
  const d = await getData();
  res.json(d.cardboard);
});

router.get('/plastic', async (_req, res) => {
  const d = await getData();
  res.json(d.plastic);
});

router.get('/summary', async (_req, res) => {
  const d = await getData();
  const cbTotal = d.cardboard.reduce((s, r) => s + r.kg, 0);
  const plTotal = d.plastic.reduce((s, r) => s + r.kg, 0);
  res.json({
    cardboard: { total: Math.round(cbTotal * 100) / 100, latest: d.cardboard.slice(-1)[0] },
    plastic:   { total: Math.round(plTotal * 100) / 100, latest: d.plastic.slice(-1)[0] },
    source:    d.source,
    cachedAt:  d.lastFetched,
  });
});

// Force cache refresh (admin only)
router.post('/refresh', (req, res, next) => {
  req.app.get('requireApiKey')(req, res, next);
}, async (_req, res) => {
  cache.lastFetched = null;
  const d = await getData();
  res.json({ ok: true, source: d.source, records: d.cardboard.length });
});

module.exports = router;
