'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { sanitise } = require('../middleware/validate');
const { notifyTelegram } = require('../utils/telegram');
const { rosterChangeMsg, fiveDayReminderMsg, oneDayReminderMsg } = require('../data/messages');

const ROSTER_FILE = path.join(__dirname, '../data/roster.json');

// ─── Google Sheets live sync ──────────────────────────────────────────────────
// Set ROSTER_SHEET_ID in your .env to enable live sync from Google Sheets.
// The sheet must have a tab named "Roster" with columns:
//   A: Date (e.g. "6 Jun 2026")
//   B: Week (e.g. "Jun W1")
//   C: Session (SAT / SUN / GPC)
//   D: Member 1
//   E: Member 2
//   F: Member 3
//   G: Member 4
//   H: Member 5
//   I: Notes
// Row 1 = headers (skipped). Empty rows are skipped.
// kg values are NOT in the sheet — they are preserved from roster.json.
const ROSTER_SHEET_ID  = process.env.ROSTER_SHEET_ID;
const GOOGLE_API_KEY   = process.env.GOOGLE_SHEETS_API_KEY;
const ROSTER_RANGE     = process.env.ROSTER_SHEET_RANGE || 'Roster!A1:I100';

// In-memory cache: refreshed every 5 minutes
let sheetCache = { data: null, lastFetched: null };
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Seed data ────────────────────────────────────────────────────────────────
const SEED = [
  // June 2026
  { id: 1,  week: 'Jun W1',  date: '6 Jun 2026',  session: 'SAT', team: ['Matthew', 'Wee Shing'],               kg: null, notes: '' },
  { id: 2,  week: 'Jun W1',  date: '7 Jun 2026',  session: 'SUN', team: ['Jia Yu', 'Jeslyn'],                   kg: null, notes: '' },
  { id: 3,  week: 'Jun W2',  date: '13 Jun 2026', session: 'SAT', team: ['Candice', 'Clara'],                   kg: null, notes: '' },
  { id: 4,  week: 'Jun W2',  date: '14 Jun 2026', session: 'SUN', team: ['Jace', 'Debs'],                       kg: null, notes: '' },
  { id: 5,  week: 'Jun W3',  date: '20 Jun 2026', session: 'SAT', team: ['Matthew', 'Pamela'],                  kg: null, notes: '' },
  { id: 6,  week: 'Jun W3',  date: '21 Jun 2026', session: 'SUN', team: ['Kai Jie', 'Brendon'],                 kg: null, notes: '' },
  { id: 7,  week: 'Jun W4',  date: '27 Jun 2026', session: 'SAT', team: ['Candice', 'Wee Shing'],               kg: null, notes: '' },
  { id: 8,  week: 'Jun W4',  date: '28 Jun 2026', session: 'SUN', team: ['Jace', 'Jia Yu'],                     kg: null, notes: '' },
  // July 2026
  { id: 9,  week: 'Jul W1',  date: '4 Jul 2026',  session: 'SAT', team: ['Wee Shing', 'Pamela', 'Esther'],      kg: null, notes: 'TL: Wee Shing' },
  { id: 10, week: 'Jul W1',  date: '5 Jul 2026',  session: 'SUN', team: ['Judy', 'Jiayi', 'Jace'],              kg: null, notes: 'TL: Judy' },
  { id: 11, week: 'Jul W2',  date: '11 Jul 2026', session: 'SAT', team: ['Wee Shing', 'Victor', 'Berry'],       kg: null, notes: 'TL: Wee Shing' },
  { id: 12, week: 'Jul W2',  date: '12 Jul 2026', session: 'SUN', team: ['Brendon', 'Jonathan Poon', 'Sok Min'],kg: null, notes: 'TL: Brendon' },
  { id: 13, week: 'Jul W3',  date: '18 Jul 2026', session: 'SAT', team: ['Wee Shing', 'Matthew', 'Clara'],      kg: null, notes: 'TL: Wee Shing' },
  { id: 14, week: 'Jul W3',  date: '19 Jul 2026', session: 'SUN', team: ['Judy', 'Jia Yu', 'Jeslyn'],           kg: null, notes: 'TL: Judy' },
  // GPC 2026
  { id: 15, week: 'GPC D1',  date: '23 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Clara', 'Debs'],         kg: null, notes: 'GPC Day 1 (Thu) — TL: Wee Shing' },
  { id: 16, week: 'GPC D2',  date: '24 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Jiayi', 'Victor'],       kg: null, notes: 'GPC Day 2 (Fri) — TL: Wee Shing' },
  { id: 17, week: 'GPC D3',  date: '25 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Alan Low', 'Elaine C'],  kg: null, notes: 'GPC Day 3 (Sat) — TL: Wee Shing' },
  { id: 18, week: 'GPC D4',  date: '26 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Jace', 'Jia Yu'],        kg: null, notes: 'GPC Day 4 (Sun) — TL: Wee Shing' },
  { id: 19, week: 'GPC D5',  date: '27 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Jonathan Poon', 'Berry'],kg: null, notes: 'GPC Day 5 (Mon) — TL: Wee Shing' },
];

// ─── Storage helpers ──────────────────────────────────────────────────────────
function loadRosterFile() {
  try {
    const raw = fs.readFileSync(ROSTER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : SEED;
  } catch {
    return SEED;
  }
}

function saveRoster(data) {
  const tmp = ROSTER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, ROSTER_FILE);
}

// Initialise file if not exists
if (!fs.existsSync(ROSTER_FILE)) saveRoster(SEED);

// ─── Google Sheets fetch & parse ──────────────────────────────────────────────
function normaliseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';

  // Google Sheets serial date (integer like 46579 = 6 Jun 2026)
  if (/^\d{4,6}$/.test(s)) {
    const serial = parseInt(s, 10);
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    if (!isNaN(d)) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // ISO / datetime string like "2026-06-06 00:00:00"
  const iso = new Date(s);
  if (!isNaN(iso)) {
    return iso.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  return s; // already human-readable like "6 Jun 2026"
}

function parseRosterSheetRows(rows) {
  const slots = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;

    const date    = normaliseDate(r[0]);
    const week    = (r[1] || '').trim();
    const session = (r[2] || '').trim().toUpperCase();
    if (!date || !session) continue;
    if (!['SAT', 'SUN', 'GPC'].includes(session)) continue;

    const team = [r[3], r[4], r[5], r[6], r[7]]
      .map(v => (v || '').trim())
      .filter(Boolean);
    if (team.length === 0) continue;

    const notes = (r[8] || '').trim();
    slots.push({ date, week, session, team, notes });
  }
  return slots;
}

async function fetchRosterFromSheets() {
  if (!ROSTER_SHEET_ID || !GOOGLE_API_KEY) return null;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${ROSTER_SHEET_ID}/values/${encodeURIComponent(ROSTER_RANGE)}?key=${GOOGLE_API_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const json = await res.json();
  const parsed = parseRosterSheetRows(json.values || []);
  return parsed.length > 0 ? parsed : null;
}

function mergeWithLocal(sheetSlots, localSlots) {
  const localMap = {};
  for (const s of localSlots) {
    const key = `${s.date}|${s.session}`;
    localMap[key] = s;
  }
  return sheetSlots.map((s, i) => {
    const key      = `${s.date}|${s.session}`;
    const existing = localMap[key];
    return {
      id:      existing ? existing.id : Date.now() + i,
      week:    s.week || (existing && existing.week) || '',
      date:    s.date,
      session: s.session,
      team:    s.team,
      kg:      existing ? existing.kg : null,
      notes:   s.notes,
    };
  });
}

async function getRoster() {
  const now = Date.now();
  if (sheetCache.data && sheetCache.lastFetched && (now - sheetCache.lastFetched) < CACHE_TTL_MS) {
    return { data: sheetCache.data, source: 'sheets-cache' };
  }

  if (ROSTER_SHEET_ID && GOOGLE_API_KEY) {
    try {
      const sheetSlots = await fetchRosterFromSheets();
      if (sheetSlots) {
        const local  = loadRosterFile();
        const merged = mergeWithLocal(sheetSlots, local);
        sheetCache   = { data: merged, lastFetched: now };
        saveRoster(merged);
        return { data: merged, source: 'sheets-live' };
      }
    } catch (err) {
      console.warn('[Roster] Sheets fetch failed, using local file:', err.message);
    }
  } else if (ROSTER_SHEET_ID) {
    console.warn('[Roster] ROSTER_SHEET_ID set but GOOGLE_SHEETS_API_KEY missing — using local file');
  }

  return { data: loadRosterFile(), source: 'local' };
}

// ─── GET all slots ────────────────────────────────────────────────────────────
router.get('/', async (_req, res) => {
  const { data } = await getRoster();
  res.json(data);
});

router.get('/upcoming', async (_req, res) => {
  const { data: roster } = await getRoster();
  const today = new Date().toISOString().split('T')[0];
  const upcoming = roster.filter(s => {
    const d = new Date(s.date);
    return !isNaN(d) && d.toISOString().split('T')[0] >= today;
  }).slice(0, 6);
  res.json(upcoming);
});

// ─── GET /sync-status ─────────────────────────────────────────────────────────
router.get('/sync-status', (_req, res) => {
  res.json({
    sheetsEnabled: !!(ROSTER_SHEET_ID && GOOGLE_API_KEY),
    sheetIdSet:    !!ROSTER_SHEET_ID,
    apiKeySet:     !!GOOGLE_API_KEY,
    cacheAge:      sheetCache.lastFetched ? Date.now() - sheetCache.lastFetched : null,
    cacheTtlMs:    CACHE_TTL_MS,
    range:         ROSTER_RANGE,
    cachedSlots:   sheetCache.data ? sheetCache.data.length : null,
    cacheHit:      !!(sheetCache.data && sheetCache.lastFetched && (Date.now() - sheetCache.lastFetched) < CACHE_TTL_MS),
  });
});

// ─── GET /debug-sheets — shows raw + parsed rows from Google Sheets ───────────
router.get('/debug-sheets', async (_req, res) => {
  if (!ROSTER_SHEET_ID || !GOOGLE_API_KEY) {
    return res.json({ error: 'Sheets not configured', sheetIdSet: !!ROSTER_SHEET_ID, apiKeySet: !!GOOGLE_API_KEY });
  }
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${ROSTER_SHEET_ID}/values/${encodeURIComponent(ROSTER_RANGE)}?key=${GOOGLE_API_KEY}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await response.json();
    if (!response.ok) return res.status(502).json({ sheetsError: json });
    const rawRows = json.values || [];
    const parsed  = parseRosterSheetRows(rawRows);
    res.json({
      rawFirstRows: rawRows.slice(0, 5),
      parsedCount:  parsed.length,
      parsedSlots:  parsed.slice(0, 5),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── POST /sync — force pull from Sheets (admin) ─────────────────────────────
router.post('/sync', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (_req, res) => {
  if (!ROSTER_SHEET_ID || !GOOGLE_API_KEY) {
    return res.status(400).json({ error: 'Google Sheets sync not configured.' });
  }
  try {
    sheetCache.lastFetched = null;
    const { data, source } = await getRoster();
    res.json({ ok: true, source, slots: data.length });
  } catch (err) {
    res.status(502).json({ error: `Sheets sync failed: ${err.message}` });
  }
});

// ─── POST — create a new slot (admin) ────────────────────────────────────────
router.post('/', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (req, res) => {
  const { week, date, session, team, notes } = req.body;
  if (!week || !date || !session || !Array.isArray(team))
    return res.status(400).json({ error: 'week, date, session, and team[] are required' });
  if (!['SAT','SUN','GPC'].includes(session.toUpperCase()))
    return res.status(400).json({ error: 'session must be SAT, SUN, or GPC' });
  if (team.length < 1 || team.length > 5)
    return res.status(400).json({ error: 'team must have 1–5 members' });

  const { data: roster } = await getRoster();
  const newSlot = {
    id:      Date.now(),
    week:    sanitise(week),
    date:    sanitise(date),
    session: session.toUpperCase(),
    team:    team.map(t => sanitise(String(t))),
    kg:      null,
    notes:   notes ? sanitise(notes) : '',
  };
  roster.push(newSlot);
  saveRoster(roster);
  sheetCache.data = roster;
  res.status(201).json(newSlot);
});

// ─── PATCH — update a slot ────────────────────────────────────────────────────
router.patch('/:id', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const { data: roster } = await getRoster();
  const slot = roster.find(s => s.id === id);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });

  const { team, kg, notes, week, date, session } = req.body;
  if (team !== undefined) {
    if (!Array.isArray(team) || team.length < 1 || team.length > 10)
      return res.status(400).json({ error: 'team must be an array of 1–10 names' });
    if (team.some(t => String(t).length > 60))
      return res.status(400).json({ error: 'Each team member name must be under 60 chars' });
    slot.team = team.map(t => sanitise(String(t)));
  }
  if (kg !== undefined) {
    if (typeof kg !== 'number' || kg < 0 || kg > 2000)
      return res.status(400).json({ error: 'kg must be a number 0–2000' });
    slot.kg = kg;
  }
  if (notes   !== undefined) slot.notes   = sanitise(String(notes));
  if (week    !== undefined) slot.week    = sanitise(String(week));
  if (date    !== undefined) slot.date    = sanitise(String(date));
  if (session !== undefined) {
    if (!['SAT','SUN','GPC'].includes(session.toUpperCase()))
      return res.status(400).json({ error: 'session must be SAT, SUN, or GPC' });
    slot.session = session.toUpperCase();
  }

  saveRoster(roster);
  sheetCache.data = roster;
  res.json(slot);
});

// ─── DELETE — remove a slot (admin) ──────────────────────────────────────────
router.delete('/:id', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const { data: roster } = await getRoster();
  const idx = roster.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Slot not found' });

  roster.splice(idx, 1);
  saveRoster(roster);
  sheetCache.data = roster;
  res.json({ ok: true });
});

// ─── POST /remind ─────────────────────────────────────────────────────────────
router.post('/remind', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (_req, res) => {
  const { data: roster } = await getRoster();
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const results = [];

  for (const slot of roster) {
    const slotDate = new Date(slot.date);
    if (isNaN(slotDate)) continue;
    const slotDay  = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate());
    const daysAway = Math.round((slotDay - today) / 86400000);

    let msg = null;
    if (daysAway === 5) msg = fiveDayReminderMsg(slot);
    if (daysAway === 1) msg = oneDayReminderMsg(slot);

    if (msg) {
      const result = await notifyTelegram(msg);
      results.push({ slotId: slot.id, date: slot.date, session: slot.session, daysAway, telegram: result });
    }
  }

  res.json({ ok: true, reminders_sent: results.length, results });
});

// ─── POST /notify-change ──────────────────────────────────────────────────────
router.post('/notify-change', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (req, res) => {
  const { name, newSlotId, oldSlot } = req.body;
  if (!name || !newSlotId)
    return res.status(400).json({ error: 'name and newSlotId are required' });

  const { data: roster } = await getRoster();
  const newSlot = roster.find(s => s.id === Number(newSlotId));
  if (!newSlot) return res.status(404).json({ error: 'Slot not found' });
  if (!newSlot.team.includes(name))
    return res.status(400).json({ error: `${name} is not in the team for slot ${newSlotId}` });

  const msg    = rosterChangeMsg(name, newSlot, oldSlot || null);
  const result = await notifyTelegram(msg);

  res.json({ ok: result.ok, name, slot: newSlot, telegram: result });
});

module.exports = router;
