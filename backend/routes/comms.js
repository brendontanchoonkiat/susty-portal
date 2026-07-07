'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { validateCommsPost, validateCommsPatch, sanitise } = require('../middleware/validate');
const { getClient } = require('../utils/supabase');

const COMMS_FILE = path.join(__dirname, '../data/comms.json');
const VALID_STATUS = ['planned', 'draft', 'idea', 'posted', 'archived'];

// Seed used only as a local-file fallback when Supabase is unreachable —
// Supabase (comms_posts table) is now the primary source of truth. See
// create_comms_posts_table.sql for the migration + the exact seed values.
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

// ─── Local-file fallback helpers (used only if Supabase is unreachable) ───────
function loadCommsFile() {
  try {
    const raw    = fs.readFileSync(COMMS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : SEED;
  } catch {
    return SEED;
  }
}

function saveCommsFile(data) {
  const tmp = COMMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, COMMS_FILE);
}

if (!fs.existsSync(COMMS_FILE)) saveCommsFile(SEED);

// ─── Supabase (primary) ────────────────────────────────────────────────────────
// comms_posts row shape ≈ { id, date, theme, owner, notes, status, posted_at }.
// Mapped to the frontend's camelCase `postedAt` at the API boundary so the
// existing frontend code (renderCommsCalendar, renderPostedComms) needs no changes.
function fromDbRow(row) {
  return {
    id: row.id, date: row.date, theme: row.theme, owner: row.owner,
    notes: row.notes, status: row.status,
    ...(row.posted_at ? { postedAt: row.posted_at } : {}),
  };
}

async function getCommsFromSupabase() {
  const db = getClient();
  if (!db) return null;
  try {
    const { data, error } = await db.from('comms_posts').select('*').order('date', { ascending: true });
    if (error) { console.warn('[Comms] Supabase error:', error.message); return null; }
    return data ? data.map(fromDbRow) : null;
  } catch (err) {
    console.warn('[Comms] Supabase fetch failed:', err.message);
    return null;
  }
}

async function getComms() {
  const supaRows = await getCommsFromSupabase();
  if (supaRows) return { data: supaRows, source: 'supabase' };
  return { data: loadCommsFile(), source: 'local' };
}

// GET all entries
router.get('/', async (_req, res) => {
  const { data } = await getComms();
  res.json(data);
});

// GET upcoming (non-posted, from today)
router.get('/upcoming', async (_req, res) => {
  const { data } = await getComms();
  const today = new Date().toISOString().split('T')[0];
  res.json(data.filter(e => e.date >= today && e.status !== 'posted'));
});

// POST — add new entry (admin only)
router.post('/',
  (req, res, next) => req.app.get('requireApiKey')(req, res, next),
  validateCommsPost,
  async (req, res) => {
    const { theme, owner, notes, date, status } = req.body;
    const entry = {
      date:   date   || '',
      theme:  theme,
      owner:  owner  || '',
      notes:  notes  || '',
      status: VALID_STATUS.includes(status) ? status : 'planned',
    };

    const db = getClient();
    if (db) {
      const { data, error } = await db.from('comms_posts').insert(entry).select().single();
      if (!error) return res.status(201).json(fromDbRow(data));
      console.warn('[Comms] Supabase insert failed, falling back to local file:', error.message);
    }

    // Local-file fallback
    const comms = loadCommsFile();
    const localEntry = { id: Date.now(), ...entry };
    comms.push(localEntry);
    saveCommsFile(comms);
    res.status(201).json(localEntry);
  }
);

// PATCH /:id — update status (mark as posted / revert, etc.) — no auth required (intentional)
router.patch('/:id', validateCommsPatch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const { status, theme, owner, notes, date } = req.body;
  if (status !== undefined && !VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const patch = {};
  if (status !== undefined) {
    patch.status = status;
    // Only stamp posted_at when newly marking as posted; clear it on revert
    // so a reverted post doesn't carry a stale "posted" timestamp.
    patch.posted_at = status === 'posted' ? new Date().toISOString() : null;
  }
  if (theme !== undefined) patch.theme = theme;
  if (owner !== undefined) patch.owner = owner;
  if (notes !== undefined) patch.notes = notes;
  if (date  !== undefined) patch.date  = date;

  const db = getClient();
  if (db) {
    const { data, error } = await db.from('comms_posts').update(patch).eq('id', id).select().single();
    if (!error && data) return res.json(fromDbRow(data));
    if (error && error.code !== 'PGRST116') console.warn('[Comms] Supabase update failed, falling back to local file:', error.message);
  }

  // Local-file fallback
  const comms = loadCommsFile();
  const entry = comms.find(e => e.id === id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (status !== undefined) {
    entry.status = status;
    if (status === 'posted') entry.postedAt = new Date().toISOString();
    else delete entry.postedAt;
  }
  if (theme !== undefined) entry.theme = theme;
  if (owner !== undefined) entry.owner = owner;
  if (notes !== undefined) entry.notes = notes;
  if (date  !== undefined) entry.date  = date;
  saveCommsFile(comms);
  res.json(entry);
});

module.exports = router;
