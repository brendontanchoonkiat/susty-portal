'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { validateCommsPost, validateCommsPatch, sanitise } = require('../middleware/validate');

const COMMS_FILE = path.join(__dirname, '../data/comms.json');

const SEED = [
  { id: 1, date: '2026-06-05', theme: 'World Environment Day',                          owner: 'Alan',       notes: 'Ask other teams their plan for Unicon',          status: 'planned' },
  { id: 2, date: '2026-06-07', theme: 'UNICON (5–7 Jun)',                                owner: 'All',        notes: 'Check if any recycling efforts here',            status: 'planned' },
  { id: 3, date: '2026-06-23', theme: 'Youth Camp (23–25 Jun)',                          owner: 'Matthew',    notes: 'Check if collecting recyclables',                status: 'planned' },
  { id: 4, date: '2026-07-01', theme: 'Plastic-Free July kickoff',                      owner: 'Comms Team', notes: 'Reduce single-use plastic focus for the month',  status: 'planned' },
  { id: 5, date: '2026-07-07', theme: 'Tip: Refill your bottle',                        owner: 'Berry',      notes: 'Sustainable living series',                      status: 'draft'   },
  { id: 6, date: '2026-07-14', theme: 'Behind-the-scenes: cardboard recycling vlog',    owner: 'W2R team',   notes: 'Follow rostered person; vlog style',             status: 'draft'   },
  { id: 7, date: '2026-07-21', theme: 'HOGC Utility Bill feature',                      owner: 'Energy team',notes: 'How much do we pay/month in utilities?',         status: 'draft'   },
  { id: 8, date: '2026-07-28', theme: 'Feature a team member #greenfluencer',           owner: 'Sok Min',    notes: 'Skits / did you know format',                    status: 'idea'    },
];

function loadComms() {
  try {
    const raw    = fs.readFileSync(COMMS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : SEED;
  } catch {
    return SEED;
  }
}

function saveComms(data) {
  const tmp = COMMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, COMMS_FILE);
}

if (!fs.existsSync(COMMS_FILE)) saveComms(SEED);

// GET all entries
router.get('/', (_req, res) => res.json(loadComms()));

// GET upcoming (non-posted, from today)
router.get('/upcoming', (_req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json(loadComms().filter(e => e.date >= today && e.status !== 'posted'));
});

// POST — add new entry (admin only)
router.post('/',
  (req, res, next) => req.app.get('requireApiKey')(req, res, next),
  validateCommsPost,
  (req, res) => {
    const { theme, owner, notes, date, status } = req.body;
    const VALID_STATUS = ['planned', 'draft', 'idea', 'posted', 'archived'];
    const comms = loadComms();
    const entry = {
      id:     Date.now(),
      date:   date   || '',
      theme:  theme,
      owner:  owner  || '',
      notes:  notes  || '',
      status: VALID_STATUS.includes(status) ? status : 'planned',
    };
    comms.push(entry);
    saveComms(comms);
    res.status(201).json(entry);
  }
);

// PATCH /:id — update status (mark as posted, etc.) — no auth required (intentional)
router.patch('/:id', validateCommsPatch, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const comms = loadComms();
  const entry = comms.find(e => e.id === id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  const VALID = ['planned', 'draft', 'idea', 'posted', 'archived'];
  const { status, theme, owner, notes, date } = req.body;

  if (status !== undefined) {
    if (!VALID.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    entry.status = status;
    if (status === 'posted') entry.postedAt = new Date().toISOString();
  }
  if (theme !== undefined) entry.theme = theme;
  if (owner !== undefined) entry.owner = owner;
  if (notes !== undefined) entry.notes = notes;
  if (date  !== undefined) entry.date  = date;

  saveComms(comms);
  res.json(entry);
});

module.exports = router;
