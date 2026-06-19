'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { sanitise } = require('../middleware/validate');
const { notifyTelegram } = require('../utils/telegram');
const { rosterChangeMsg, fiveDayReminderMsg, oneDayReminderMsg } = require('../data/messages');

const ROSTER_FILE = path.join(__dirname, '../data/roster.json');

// ─── Seed data ────────────────────────────────────────────────────────────────
// June dates corrected (-1 day from original off-by-one).
// July schedule revised: team leaders assigned from Jul onwards (Wee Shing, Brendon, Judy).
// GPC 2026: GenerationS Pastors' Conference 23–27 Jul, Wee Shing leads all days.
const SEED = [
  // June 2026 (Sat/Sun corrected)
  { id: 1,  week: 'Jun W1',  date: '6 Jun 2026',  session: 'SAT', team: ['Matthew', 'Wee Shing'],              kg: null, notes: '' },
  { id: 2,  week: 'Jun W1',  date: '7 Jun 2026',  session: 'SUN', team: ['Jia Yu', 'Jeslyn'],                  kg: null, notes: '' },
  { id: 3,  week: 'Jun W2',  date: '13 Jun 2026', session: 'SAT', team: ['Candice', 'Clara'],                  kg: null, notes: '' },
  { id: 4,  week: 'Jun W2',  date: '14 Jun 2026', session: 'SUN', team: ['Jace', 'Debs'],                      kg: null, notes: '' },
  { id: 5,  week: 'Jun W3',  date: '20 Jun 2026', session: 'SAT', team: ['Matthew', 'Pamela'],                 kg: null, notes: '' },
  { id: 6,  week: 'Jun W3',  date: '21 Jun 2026', session: 'SUN', team: ['Kai Jie', 'Brendon'],                kg: null, notes: '' },
  { id: 7,  week: 'Jun W4',  date: '27 Jun 2026', session: 'SAT', team: ['Candice', 'Wee Shing'],              kg: null, notes: '' },
  { id: 8,  week: 'Jun W4',  date: '28 Jun 2026', session: 'SUN', team: ['Jace', 'Jia Yu'],                    kg: null, notes: '' },
  // July 2026 — weekends (team leaders assigned from here)
  { id: 9,  week: 'Jul W1',  date: '4 Jul 2026',  session: 'SAT', team: ['Brendon', 'Pamela', 'Esther'],       kg: null, notes: 'TL: Brendon' },
  { id: 10, week: 'Jul W1',  date: '5 Jul 2026',  session: 'SUN', team: ['Wee Shing', 'Candice', 'Jiayi'],    kg: null, notes: 'TL: Wee Shing' },
  { id: 11, week: 'Jul W2',  date: '11 Jul 2026', session: 'SAT', team: ['Judy', 'Victor', 'Berry'],            kg: null, notes: 'TL: Judy' },
  { id: 12, week: 'Jul W2',  date: '12 Jul 2026', session: 'SUN', team: ['Brendon', 'Jonathan Poon', 'Sok Min'],kg: null, notes: 'TL: Brendon' },
  { id: 13, week: 'Jul W3',  date: '18 Jul 2026', session: 'SAT', team: ['Wee Shing', 'Jeslyn', 'Jia Yu'],    kg: null, notes: 'TL: Wee Shing' },
  { id: 14, week: 'Jul W3',  date: '19 Jul 2026', session: 'SUN', team: ['Judy', 'Jace', 'Matthew'],           kg: null, notes: 'TL: Judy' },
  // GPC 2026 — GenerationS Pastors' Conference (23–27 Jul)
  { id: 15, week: 'GPC D1',  date: '23 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Clara', 'Debs'],        kg: null, notes: 'GPC Day 1 (Thu) — TL: Wee Shing' },
  { id: 16, week: 'GPC D2',  date: '24 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Jiayi', 'Victor'],     kg: null, notes: 'GPC Day 2 (Fri) — TL: Wee Shing' },
  { id: 17, week: 'GPC D3',  date: '25 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Alan Low', 'Elaine C'],kg: null, notes: 'GPC Day 3 (Sat) — TL: Wee Shing' },
  { id: 18, week: 'GPC D4',  date: '26 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Pamela', 'Candice'],   kg: null, notes: 'GPC Day 4 (Sun) — TL: Wee Shing' },
  { id: 19, week: 'GPC D5',  date: '27 Jul 2026', session: 'GPC', team: ['Wee Shing', 'Jonathan Poon', 'Berry'],kg: null, notes: 'GPC Day 5 (Mon) — TL: Wee Shing' },
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
  if (!['SAT','SUN','GPC'].includes(session.toUpperCase()))
    return res.status(400).json({ error: 'session must be SAT, SUN, or GPC' });
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

// ─── POST /remind — send 5-day and 1-day reminders (admin) ──────────────────
// Scans the full roster for slots exactly 5 or 1 day(s) away and sends reminders.
// Body: {} (no params needed — uses today's date)
// Returns: list of slots messaged
router.post('/remind', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (_req, res) => {
  const roster = loadRoster();

  // Compute today at midnight local time, ignoring time-of-day
  const now    = new Date();
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const results = [];

  for (const slot of roster) {
    const slotDate = new Date(slot.date);
    if (isNaN(slotDate)) continue;
    const slotDay = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate());
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

// ─── POST /notify-change — send change notification for one person (admin) ───
// Body: { name, newSlotId, oldSlot?: { date, session } }
// `newSlotId` must match an id in the current roster.
router.post('/notify-change', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (req, res) => {
  const { name, newSlotId, oldSlot } = req.body;

  if (!name || !newSlotId)
    return res.status(400).json({ error: 'name and newSlotId are required' });

  const roster  = loadRoster();
  const newSlot = roster.find(s => s.id === Number(newSlotId));
  if (!newSlot)
    return res.status(404).json({ error: 'Slot not found' });
  if (!newSlot.team.includes(name))
    return res.status(400).json({ error: `${name} is not in the team for slot ${newSlotId}` });

  const msg    = rosterChangeMsg(name, newSlot, oldSlot || null);
  const result = await notifyTelegram(msg);

  res.json({ ok: result.ok, name, slot: newSlot, telegram: result });
});

module.exports = router;
