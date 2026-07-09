'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { validateCommsPost, validateCommsPatch, sanitise } = require('../middleware/validate');
const { getClient } = require('../utils/supabase');
const db = require('../utils/supabase');

const COMMS_FILE = path.join(__dirname, '../data/comms.json');
// Planning flow: idea/draft/planned -> pending_review (member submitted) ->
// approved (TL ok'd it) -> posted (TL posted it via the bot). `archived` can
// be applied any time. Reject sends a post back to 'draft' with
// rejected_reason set — see extend_comms_posts_for_planning.sql.
const VALID_STATUS = ['planned', 'draft', 'idea', 'pending_review', 'approved', 'posted', 'archived'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

// Seed used only as a local-file fallback when Supabase is unreachable —
// Supabase (comms_posts table) is now the primary source of truth. See
// create_comms_posts_table.sql / extend_comms_posts_for_planning.sql for schema.
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
// comms_posts row shape ≈ { id, date, theme, owner, notes, status, posted_at,
// caption, details, image_url, created_by, submitted_at, approved_by,
// approved_at, rejected_reason, posted_by }. Mapped to the frontend's
// camelCase at the API boundary.
function fromDbRow(row) {
  return {
    id: row.id, date: row.date, theme: row.theme, owner: row.owner,
    notes: row.notes, status: row.status,
    caption: row.caption || '', details: row.details || '',
    imageUrl: row.image_url || null,
    createdBy: row.created_by || '',
    rejectedReason: row.rejected_reason || null,
    ...(row.posted_at    ? { postedAt: row.posted_at }       : {}),
    ...(row.submitted_at ? { submittedAt: row.submitted_at } : {}),
    ...(row.approved_by  ? { approvedBy: row.approved_by }   : {}),
    ...(row.approved_at  ? { approvedAt: row.approved_at }   : {}),
    ...(row.posted_by    ? { postedBy: row.posted_by }       : {}),
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

// POST — add new entry. Deliberately NOT admin-gated: any comms team member
// plans posts straight from the portal calendar (matches the ministry's
// "anyone can propose, TL approves before it goes live" workflow — the actual
// gate is the pending_review -> approve step, not post creation).
router.post('/',
  validateCommsPost,
  async (req, res) => {
    const { theme, owner, notes, date, caption, details, createdBy, status } = req.body;
    const entry = {
      date:       date   || '',
      theme:      theme,
      owner:      owner  || createdBy || '',
      notes:      notes  || '',
      caption:    caption || '',
      details:    details || '',
      created_by: createdBy || owner || '',
      status:     VALID_STATUS.includes(status) ? status : 'draft',
    };

    const dbc = getClient();
    if (dbc) {
      const { data, error } = await dbc.from('comms_posts').insert(entry).select().single();
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

// POST /:id/image — upload/replace the post's image (multipart form field "image")
router.post('/:id/image', upload.single('image'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });
  if (!req.file) return res.status(400).json({ error: 'No image file provided (field name must be "image")' });

  const dbc = getClient();
  if (!dbc) return res.status(503).json({ error: 'Image upload requires Supabase (not configured)' });

  const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const filename = `post_${id}_${Date.now()}.${ext}`;
  const imageUrl = await db.uploadImage(req.file.buffer, filename, req.file.mimetype, 'comms');
  if (!imageUrl) return res.status(502).json({ error: 'Image upload to storage failed' });

  const { data, error } = await dbc.from('comms_posts').update({ image_url: imageUrl }).eq('id', id).select().single();
  if (error) return res.status(404).json({ error: 'Post not found' });
  res.json(fromDbRow(data));
});

// POST /:id/submit — member pushes their (self-checked) post to the TLs for
// review. Sets status to pending_review and DMs every TL a preview with
// Approve/Reject buttons via the bot.
router.post('/:id/submit', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const dbc = getClient();
  if (!dbc) return res.status(503).json({ error: 'Requires Supabase (not configured)' });

  const { data, error } = await dbc.from('comms_posts')
    .update({ status: 'pending_review', submitted_at: new Date().toISOString(), rejected_reason: null })
    .eq('id', id).select().single();
  if (error) return res.status(404).json({ error: 'Post not found' });

  try {
    const { notifyTLsSubmitted } = require('../utils/commsNotify');
    await notifyTLsSubmitted(data);
  } catch (err) {
    console.warn('[Comms] Failed to notify TLs of submission:', err.message);
  }

  res.json(fromDbRow(data));
});

// PATCH /:id — update status (mark as posted / revert, etc.) or edit fields
// — no auth required (intentional, matches the rest of this route's design)
router.patch('/:id', validateCommsPatch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const { status, theme, owner, notes, date, caption, details } = req.body;
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
  if (theme   !== undefined) patch.theme   = theme;
  if (owner   !== undefined) patch.owner   = owner;
  if (notes   !== undefined) patch.notes   = notes;
  if (date    !== undefined) patch.date    = date;
  if (caption !== undefined) patch.caption = caption;
  if (details !== undefined) patch.details = details;

  const dbc = getClient();
  if (dbc) {
    const { data, error } = await dbc.from('comms_posts').update(patch).eq('id', id).select().single();
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
  if (theme   !== undefined) entry.theme   = theme;
  if (owner   !== undefined) entry.owner   = owner;
  if (notes   !== undefined) entry.notes   = notes;
  if (date    !== undefined) entry.date    = date;
  if (caption !== undefined) entry.caption = caption;
  if (details !== undefined) entry.details = details;
  saveCommsFile(comms);
  res.json(entry);
});

module.exports = router;
