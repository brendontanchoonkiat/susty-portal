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
    // Only accept months ending in '25 — Jan'26 also appears here as a duplicate and must be skipped
    if (row[0] && row[1] && String(row[0]).includes("'25")) {
      const kg = parseFloat(String(row[1]).replace(/[^0-9.]/g, ''));
      if (!isNaN(kg) && kg > 0)
        target.push({ month: String(row[0]).replace("'", ' 20').trim(), kg });
    }
    // 2026 column: D (index 3) = month, E (index 4) = kg
    // Only accept months ending in '26
    if (row[3] && row[4] && String(row[3]).includes("'26")) {
      const kg = parseFloat(String(row[4]).replace(/[^0-9.]/g, ''));
      if (!isNaN(kg) && kg > 0)
        target.push({ month: String(row[3]).replace("'", ' 20').trim(), kg });
    }
  }

  return { cardboard, plastic };
}

// Consolidate multiple rows with the same month, then sort chronologically
function aggregateByMonth(arr) {
  if (!arr || !arr.length) return [];
  const map = {};
  arr.forEach(r => {
    if (!map[r.month]) map[r.month] = 0;
    map[r.month] += r.kg;
  });
  return Object.entries(map)
    .map(([month, kg]) => ({ month, kg: Math.round(kg * 100) / 100 }))
    .sort((a, b) => new Date(a.month + ' 1') - new Date(b.month + ' 1'));
}

async function getData() {
  const now = Date.now();
  if (cache.lastFetched && (now - cache.lastFetched) < CACHE_TTL_MS) return cache;

  // ── 1. Try Supabase first ────────────────────────────────────────────────
  try {
    const db   = require('../utils/supabase');
    const rows = await db.getRecyclingStats();
    if (rows && rows.length > 0) {
      const toArr = (type) => rows.map(r => ({ month: r.month, kg: Number(r[type] || 0) }))
                                  .filter(r => r.kg > 0);
      cache = {
        cardboard:   aggregateByMonth(toArr('cardboard_kg')),
        plastic:     aggregateByMonth(toArr('plastic_kg')),
        lastFetched: now,
        source:      'supabase',
      };
      console.log(`[Recycling] Supabase: ${rows.length} monthly records`);
      return cache;
    }
  } catch (err) {
    console.warn('[Recycling] Supabase read failed, trying Sheets:', err.message);
  }

  // ── 2. Fall back to Google Sheets ───────────────────────────────────────
  try {
    const live = await fetchFromSheets();
    if (live && (live.cardboard.length > 0 || live.plastic.length > 0)) {
      cache = {
        cardboard:   aggregateByMonth(filterFromTrackingStart(
                       live.cardboard.length > 0 ? live.cardboard : FALLBACK.cardboard)),
        plastic:     aggregateByMonth(filterFromTrackingStart(
                       live.plastic.length   > 0 ? live.plastic   : FALLBACK.plastic)),
        lastFetched: now,
        source:      'live',
        liveCardboard: live.cardboard.length > 0,
        livePlastic:   live.plastic.length   > 0,
      };
    } else {
      throw new Error('no live data from Sheets');
    }
  } catch (err) {
    // ── 3. Last resort: static JSON file ──────────────────────────────────
    console.warn('[Recycling] Using static fallback:', err.message);
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

// ─── Admin write endpoints (Supabase-backed) ─────────────────────────────────
const db = require('../utils/supabase');
const adminOnly = (req, res, next) => req.app.get('requireApiKey')(req, res, next);

// GET /api/recycling/rows — all monthly rows for the editor table
router.get('/rows', adminOnly, async (_req, res) => {
  const supa = db.getClient();
  if (!supa) return res.status(503).json({ error: 'Supabase not configured' });
  const { data, error } = await supa.from('recycling_monthly')
    .select('*').order('year').order('month');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/recycling — add or update a monthly record
// Body: { month, year, cardboard_kg, plastic_kg }
router.post('/', adminOnly, async (req, res) => {
  const supa = db.getClient();
  if (!supa) return res.status(503).json({ error: 'Supabase not configured' });
  const { month, year, cardboard_kg, plastic_kg, notes } = req.body;
  if (!month || !year) return res.status(400).json({ error: 'month and year are required' });
  const { data, error } = await supa.from('recycling_monthly')
    .upsert({
      month, year: Number(year),
      cardboard_kg: cardboard_kg ?? 0,
      plastic_kg:   plastic_kg   ?? 0,
      notes:        notes || '',
      source:       'manual',
      updated_at:   new Date().toISOString(),
    }, { onConflict: 'month' })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  cache.lastFetched = null;
  res.json({ ok: true, data });
});

// PATCH /api/recycling/:id — edit individual fields
router.patch('/:id', adminOnly, async (req, res) => {
  const supa = db.getClient();
  if (!supa) return res.status(503).json({ error: 'Supabase not configured' });
  const allowed = ['cardboard_kg', 'plastic_kg', 'notes', 'month', 'year'];
  const patch   = { updated_at: new Date().toISOString() };
  for (const key of allowed) if (req.body[key] !== undefined) patch[key] = req.body[key];
  const { data, error } = await supa.from('recycling_monthly')
    .update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  cache.lastFetched = null;
  res.json({ ok: true, data });
});

// DELETE /api/recycling/:id
router.delete('/:id', adminOnly, async (req, res) => {
  const supa = db.getClient();
  if (!supa) return res.status(503).json({ error: 'Supabase not configured' });
  const { error } = await supa.from('recycling_monthly').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  cache.lastFetched = null;
  res.json({ ok: true });
});

// Export getData so weeklySnapshot.js can reuse the cache
router.getData = getData;

module.exports = router;
