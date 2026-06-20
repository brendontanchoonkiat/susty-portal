'use strict';
const express = require('express');
const router  = express.Router();
const { cardboardData, plasticData } = require('../data/recycling');
 
// ─── Google Sheets live sync ──────────────────────────────────────────────────
// Sheet ID from Google Drive — set GOOGLE_SHEETS_API_KEY in .env to enable.
// Without GOOGLE_SHEETS_API_KEY the server falls back to backend/data/recycling.js.
const SHEET_ID  = process.env.W2R_SHEET_ID || '1ELi47Yq9oPcMqElZGYjWDgnRfS1gVHTwjOseEx5ZPmk';
const API_KEY   = process.env.GOOGLE_SHEETS_API_KEY;
 
// In-memory cache: refreshed every 5 minutes
let cache = { cardboard: [], plastic: [], lastFetched: null };
const CACHE_TTL_MS = 5 * 60 * 1000;
 
// Fallback sourced from backend/data/recycling.js (Sep 2025 – present)
// If GOOGLE_SHEETS_API_KEY is not set, this is what the API returns.
const FALLBACK = { cardboard: cardboardData, plastic: plasticData };
 
// Only include months at or after formal tracking start (Sep 2025)
const TRACKING_START = new Date('2025-09-01');
function filterFromTrackingStart(arr) {
  return arr.filter(r => {
    const d = new Date(r.month + ' 1');
    return !isNaN(d) && d >= TRACKING_START;
  });
}
 
async function fetchFromSheets() {
  if (!API_KEY) {
    console.warn('[Recycling] GOOGLE_SHEETS_API_KEY not set — using fallback data. Set it in .env to enable live sync.');
    return null;
  }
 
  // Fetch cols A–F, rows 1–50 — covers both cardboard (rows ~1-15) and plastic (rows ~23-37)
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Total!A1:F50?key=${API_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sheets API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return parseSheetData(json.values || []);
}
 
// ─── Sheet layout (Total tab) ─────────────────────────────────────────────────
// Cardboard block: rows 1–15, col A = 2025 month, col B = 2025 kg,
//                             col D = 2026 month, col E = 2026 kg
// Plastic block:   rows 23–37, SAME column structure as cardboard
// Section detected by col B containing "Cardboard" or "Plastic" in row 1 / row 23.
// Month strings look like "Mar'25" → replace "'" → "Mar 2025".
function parseSheetData(rows) {
  const cardboard = [];
  const plastic   = [];
  let section     = null; // 'cardboard' | 'plastic'
 
  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i] || [];
    const col2 = String(row[1] || '').toLowerCase();
 
    // Detect section boundary rows (e.g. "📦 Cardboards" / "Plastic")
    if (col2.includes('cardboard')) { section = 'cardboard'; continue; }
    if (col2.includes('plastic'))   { section = 'plastic';   continue; }
    if (!section) continue;
 
    // Skip sub-header rows ("Month", "Collection / mo...")
    if (String(row[0] || '').toLowerCase().startsWith('month')) continue;
 
    const target = section === 'cardboard' ? cardboard : plastic;
 
    // 2025 column: A (index 0) = month, B (index 1) = kg
    if (row[0] && row[1]) {
      const kg = parseFloat(String(row[1]).replace(/[^0-9.]/g, ''));
      if (!isNaN(kg) && kg > 0)
        target.push({ month: String(row[0]).replace("'", ' 20').trim(), kg });
    }
    // 2026 column: D (index 3) = month, E (index 4) = kg
    if (row[3] && row[4]) {
      const kg = parseFloat(String(row[4]).replace(/[^0-9.]/g, ''));
      if (!isNaN(kg) && kg > 0)
        target.push({ month: String(row[3]).replace("'", ' 20').trim(), kg });
    }
  }
 
  return { cardboard, plastic };
}
 
// Consolidate multiple rows with the same month into a single summed entry
function aggregateByMonth(arr) {
  if (!arr || !arr.length) return [];
  const map = {};
  arr.forEach(r => {
    if (!map[r.month]) map[r.month] = 0;
    map[r.month] += r.kg;
  });
  return Object.entries(map).map(([month, kg]) => ({ month, kg: Math.round(kg * 100) / 100 }));
}
 
async function getData() {
  const now = Date.now();
  if (cache.lastFetched && (now - cache.lastFetched) < CACHE_TTL_MS) return cache;
 
  try {
    const live = await fetchFromSheets();
    if (live && (live.cardboard.length > 0 || live.plastic.length > 0)) {
      cache = {
        // Use live data where available; fall back per-type if a column is missing
        cardboard:   aggregateByMonth(filterFromTrackingStart(
                       live.cardboard.length > 0 ? live.cardboard : FALLBACK.cardboard)),
        plastic:     aggregateByMonth(filterFromTrackingStart(
                       live.plastic.length   > 0 ? live.plastic   : FALLBACK.plastic)),
        lastFetched: now,
        source:      'live',
        liveCardboard: live.cardboard.length > 0,
        livePlastic:   live.plastic.length   > 0,
      };
      if (live.cardboard.length === 0)
        console.warn('[Recycling] No live cardboard data parsed — check sheet column layout.');
      if (live.plastic.length === 0)
        console.warn('[Recycling] No live plastic data parsed — check Total tab has a row with "Plastic" in col B.');
    } else {
      console.warn('[Recycling] No live data parsed from Sheets — using fallback. Check GOOGLE_SHEETS_API_KEY and sheet structure.');
      cache = {
        cardboard:   aggregateByMonth(FALLBACK.cardboard),
        plastic:     aggregateByMonth(FALLBACK.plastic),
        lastFetched: now,
        source:      'fallback',
      };
    }
  } catch (err) {
    console.warn('[Recycling] Sheets fetch failed, using fallback:', err.message);
    cache = {
      cardboard:   aggregateByMonth(FALLBACK.cardboard),
      plastic:     aggregateByMonth(FALLBACK.plastic),
      lastFetched: now,
      source:      'fallback',
    };
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
 
// ─── GET /status — diagnostic: shows sync config & current source (public) ───
router.get('/status', (_req, res) => {
  res.json({
    apiKeySet:       !!API_KEY,
    sheetId:         SHEET_ID,
    source:          cache.source || 'not-yet-fetched',
    liveCardboard:   cache.liveCardboard ?? null,
    livePlastic:     cache.livePlastic   ?? null,
    cacheAgeMs:      cache.lastFetched ? Date.now() - cache.lastFetched : null,
    cacheTtlMs:      CACHE_TTL_MS,
    fallbackMonths:  { cardboard: FALLBACK.cardboard.length, plastic: FALLBACK.plastic.length },
  });
});
 
// Force cache refresh (admin only)
router.post('/refresh', (req, res, next) => {
  req.app.get('requireApiKey')(req, res, next);
}, async (_req, res) => {
  cache.lastFetched = null;
  const d = await getData();
  res.json({ ok: true, source: d.source, cardboardRecords: d.cardboard.length, plasticRecords: d.plastic.length });
});
 
module.exports = router;
 
