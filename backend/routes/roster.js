'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { sanitise } = require('../middleware/validate');

const ROSTER_FILE = path.join(__dirname, '../data/roster.json');

// ─── Seed data from Google Drive (Sun team: 6C2 pairs, Sat team: 5C2 pairs) ──
const SEED = [
  // June 2026
  { id: 1, week: 'Jun W1',  date: '7 Jun 2026',  session: 'SAT', team: ['Matthew', 'Shing'],    kg: null, notes: '' },
  { id: 2, week: 'Jun W1',  date: '8 Jun 2026',  session: 'SUN', team: ['Jiayu', 'Jeslyn'],     kg: null, notes: '' },
  { id: 3, week: 'Jun W2',  date: '14 Jun 2026', session: 'SAT', team: ['Candice', 'Clara'],    kg: null, notes: '' },
  { id: 4, week: 'Jun W2',  date: '15 Jun 2026', session: 'SUN', team: ['Jace', 'Clarice'],     kg: null, notes: '' },
  { id: 5, week: 'Jun W3',  date: '21 Jun 2026', session: 'SAT', team: ['Matthew', 'Pamela'],   kg: null, notes: '' },
  { id: 6, week: 'Jun W3',  date: '22 Jun 2026', session: 'SUN', team: ['Kai Jie', 'Brendon'],  kg: null, notes: '' },
  { id: 7, week: 'Jun W4',  date: '28 Jun 2026', session: 'SAT', team: ['Candice', 'Shing'],    kg: null, notes: '' },
  { id: 8, week: 'Jun W4',  date: '29 Jun 2026', session: 'SUN', team: ['Jace', 'Jiayu'],       kg: null, notes: '' },
  // July 2026
  { id: 9,  week: 'Jul W1', date: '5 Jul 2026',  session: 'SAT', team: ['Clara', 'Matthew'],    kg: null, notes: '' },
  { id: 10, week: 'Jul W1', date: '6 Jul 2026',  session: 'SUN', team: ['Brendon', 'Jeslyn'],   kg: null, notes: '' },
  { id: 11, week: 'Jul W2', date: '12 Jul 2026', session: 'SAT', team: ['Candice', 'Pamela'],   kg: null, notes: '' },
  { id: 12, week: 'Jul W2', date: '13 Jul 2026', session: 'SUN', team: ['Jiayu', 'Clarice'],    kg: null, notes: '' },
  { id: 13, week: 'Jul W3', date: '19 Jul 2026', session: 'SAT', team: ['Clara', 'Shing'],      kg: null, notes: '' },
  { id: 14, week: 'Jul W3', date: '20 Jul 2026', session: 'SUN', team: ['Kai Jie', 'Jace'],     kg: null, notes: '' },
  { id: 15, week: 'Jul W4', date: '26 Jul 2026', session: 'SAT', team: ['Candice', 'Matthew'],  kg: null, notes: '' },
  { id: 16, week: 'Jul W4', date: '27 Jul 2026', session: 'SUN', team: ['Clarice', 'Jeslyn'],   kg: null, notes: '' },
];

// ─── Storage helpers ──────────────────────────────────────────────────────────
function loadRoster() {
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

// ─── GET all slots ────────────────────────────────────────────────────────────
router.get('/', (_req, res) => res.json(loadRoster()));

router.get('/upcoming', (_req, res) => {
  const roster = loadRoster();
  const today  = new Date().toISOString().split('T')[0];
  const upcoming = roster.filter(s => {
    const d = new Date(s.date);
    return !isNaN(d) && d.toISOString().split('T')[0] >= today;
  }).slice(0, 6);
  res.json(upcoming);
});

// ─── POST — create a new slot (admin) ────────────────────────────────────────
router.post('/', (req, res, next) => req.app.get('requireApiKey')(req, res, next), (req, res) => {
  const { week, date, session, team, notes } = req.body;
  if (!week || !date || !session || !Array.isArray(team))
    return res.status(400).json({ error: 'week, date, session, and team[] are required' });
  if (!['SAT','SUN'].includes(session.toUpperCase()))
    return res.status(400).json({ error: 'session must be SAT or SUN' });
  if (team.length < 1 || team.length > 5)
    return res.status(400).json({ error: 'team must have 1–5 members' });

  const roster = loadRoster();
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
  res.status(201).json(newSlot);
});

// ─── PATCH — update a slot (log weight, edit team, notes) ────────────────────
router.patch('/:id', (req, res, next) => req.app.get('requireApiKey')(req, res, next), (req, res) => {
  const id     = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const roster = loadRoster();
  const slot   = roster.find(s => s.id === id);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });

  const { team, kg, notes, week, date, session } = req.body;

  if (team !== undefined) {
    if (!Array.isArray(team) || team.length < 1 || team.length > 5)
      return res.status(400).json({ error: 'team must be an array of 1–5 names' });
    slot.team = team.map(t => sanitise(String(t)));
  }
  if (kg !== undefined) {
    if (typeof kg !== 'number' || kg < 0 || kg > 2000)
      return res.status(400).json({ error: 'kg must be a number 0–2000' });
    slot.kg = kg;
  }
  if (notes  !== undefined) slot.notes   = sanitise(String(notes));
  if (week   !== undefined) slot.week    = sanitise(String(week));
  if (date   !== undefined) slot.date    = sanitise(String(date));
  if (session !== undefined) {
    if (!['SAT','SUN'].includes(session.toUpperCase()))
      return res.status(400).json({ error: 'session must be SAT or SUN' });
    slot.session = session.toUpperCase();
  }

  saveRoster(roster);
  res.json(slot);
});

// ─── DELETE — remove a slot (admin) ──────────────────────────────────────────
router.delete('/:id', (req, res, next) => req.app.get('requireApiKey')(req, res, next), (req, res) => {
  const id     = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const roster  = loadRoster();
  const idx     = roster.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Slot not found' });

  roster.splice(idx, 1);
  saveRoster(roster);
  res.json({ ok: true });
});

module.exports = router;
