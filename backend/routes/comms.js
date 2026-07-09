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
// Planning flow: idea/draft/planned -> pending_review (member pushed it to
// the TLs) -> approved (TL ok'd it) -> posted (TL posted it via the bot).
// `needs_changes` is the comment-loop state: TL sent feedback instead of a
// hard reject — the post stays linked, the member edits and pushes again
// (back to pending_review), no need to start over. `archived` can be applied
// any time. See extend_comms_posts_for_planning.sql / extend_comms_posts_v2.sql.
const VALID_STATUS = ['planned', 'draft', 'idea', 'pending_review', 'needs_changes', 'approved', 'posted', 'archived'];

// Accepts common web image types plus iPhone's default HEIC/HEIF — most
// members will be uploading straight from their phone's camera roll, and a
// too-narrow allowlist here silently failed the upload with no clear reason
// surfaced to the user (found 9 Jul 2026 — "pictures... not really saved").
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — phone camera photos can be large
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|jpg|png|webp|gif|heic|heif|bmp)$/i.test(file.mimetype)) {
      return cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
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
    assignees: row.assignees || [],
    rejectedReason: row.rejected_reason || null,
    deleteRequested: !!row.delete_requested,
    deleteRequestedBy: row.delete_requested_by || null,
    ...(row.posted_at              ? { postedAt: row.posted_at }               : {}),
    ...(row.submitted_at           ? { submittedAt: row.submitted_at }         : {}),
    ...(row.approved_by            ? { approvedBy: row.approved_by }           : {}),
    ...(row.approved_at            ? { approvedAt: row.approved_at }           : {}),
    ...(row.posted_by              ? { postedBy: row.posted_by }               : {}),
    ...(row.scheduled_post_time    ? { scheduledPostTime: row.scheduled_post_time } : {}),
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
    const { theme, owner, notes, date, caption, details, createdBy, status, assignees } = req.body;
    const cleanAssignees = Array.isArray(assignees) ? assignees : [];
    const entry = {
      date:       date   || '',
      theme:      theme,
      // `owner` stays as a display fallback for older UI bits — derived from
      // assignees when tagging is used, otherwise whoever filled the form in.
      owner:      owner || cleanAssignees.join(', ') || createdBy || '',
      notes:      notes  || '',
      caption:    caption || '',
      details:    details || '',
      created_by: createdBy || owner || '',
      assignees:  cleanAssignees,
      status:     VALID_STATUS.includes(status) ? status : 'draft',
    };

    const dbc = getClient();
    if (dbc) {
      const { data, error } = await dbc.from('comms_posts').insert(entry).select().single();
      if (!error) {
        if (cleanAssignees.length) {
          try { await require('../utils/commsNotify').notifyAssigneesTagged(data); }
          catch (err) { console.warn('[Comms] Failed to notify assignees of tagging:', err.message); }
        }
        return res.status(201).json(fromDbRow(data));
      }
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

// POST /:id/image — upload/replace the post's image (multipart form field "image").
// Wraps multer's middleware manually (instead of passing it straight to the
// router) so a fileFilter/size-limit rejection returns a clear 400 with the
// real reason instead of falling through to the generic 500 handler in
// server.js, which just said "Internal server error" with no detail.
router.post('/:id/image', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Image upload failed' });
    next();
  });
}, async (req, res) => {
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
// Approve/Request Changes buttons via the bot. Works from any pre-review
// status (idea/draft/planned) and also from needs_changes (the comment-loop
// re-submit after editing).
router.post('/:id/submit', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const dbc = getClient();
  if (!dbc) return res.status(503).json({ error: 'Requires Supabase (not configured)' });

  const { data, error } = await dbc.from('comms_posts')
    .update({ status: 'pending_review', submitted_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) {
    console.warn('[Comms] Submit update failed:', error.message);
    return res.status(404).json({ error: error.message || 'Post not found' });
  }

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

  const { status, theme, owner, notes, date, caption, details, assignees } = req.body;
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
  if (theme     !== undefined) patch.theme     = theme;
  if (owner     !== undefined) patch.owner     = owner;
  if (notes     !== undefined) patch.notes     = notes;
  if (date      !== undefined) patch.date      = date;
  if (caption   !== undefined) patch.caption   = caption;
  if (details   !== undefined) patch.details   = details;
  if (assignees !== undefined) {
    patch.assignees = assignees;
    // Keep the legacy owner/created_by display fields in sync when nothing
    // explicitly overrides them — assignees is the single source of truth
    // for "who" now (no separate "filled in by" field in the portal).
    if (owner === undefined) patch.owner = assignees.join(', ');
    if (req.body.createdBy === undefined) patch.created_by = assignees.join(', ');
  }

  const dbc = getClient();
  if (dbc) {
    const { data, error } = await dbc.from('comms_posts').update(patch).eq('id', id).select().single();
    if (!error && data) {
      if (assignees !== undefined) {
        try { await require('../utils/commsNotify').notifyAssigneesTagged(data); }
        catch (err) { console.warn('[Comms] Failed to notify assignees of tagging:', err.message); }
      }
      return res.json(fromDbRow(data));
    }
    if (error) {
      console.warn('[Comms] Supabase update failed, falling back to local file:', error.message);
      if (error.code !== 'PGRST116') return res.status(400).json({ error: error.message });
    }
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
  if (theme     !== undefined) entry.theme     = theme;
  if (owner     !== undefined) entry.owner     = owner;
  if (notes     !== undefined) entry.notes     = notes;
  if (date      !== undefined) entry.date      = date;
  if (caption   !== undefined) entry.caption   = caption;
  if (details   !== undefined) entry.details   = details;
  if (assignees !== undefined) entry.assignees = assignees;
  saveCommsFile(comms);
  res.json(entry);
});

// POST /:id/request-delete — a member flags a post for deletion instead of
// deleting it outright. Notifies the comms TLs (Judy/Brendon) with
// Confirm/Keep buttons via the bot — nothing is actually removed until a TL
// confirms. No auth required (same open-creation philosophy as the rest of
// this route) since this only *requests*, it can't destroy data on its own.
router.post('/:id/request-delete', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });
  const requestedBy = typeof req.body?.requestedBy === 'string' ? sanitise(req.body.requestedBy).slice(0, 60) : '';

  const dbc = getClient();
  if (!dbc) return res.status(503).json({ error: 'Requires Supabase (not configured)' });

  const { data, error } = await dbc.from('comms_posts')
    .update({ delete_requested: true, delete_requested_by: requestedBy || null })
    .eq('id', id).select().single();
  if (error) return res.status(404).json({ error: error.message || 'Post not found' });

  try {
    const { notifyTLsDeleteRequested } = require('../utils/commsNotify');
    await notifyTLsDeleteRequested(data);
  } catch (err) {
    console.warn('[Comms] Failed to notify TLs of delete request:', err.message);
  }

  res.json(fromDbRow(data));
});

// DELETE /:id — TL-only immediate delete (admin key required, same gate the
// roster editor uses). Members go through POST /:id/request-delete instead.
router.delete('/:id',
  (req, res, next) => req.app.get('requireApiKey')(req, res, next),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

    const dbc = getClient();
    if (dbc) {
      const { error } = await dbc.from('comms_posts').delete().eq('id', id);
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ success: true });
    }

    // Local-file fallback
    const comms = loadCommsFile();
    const idx = comms.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
    comms.splice(idx, 1);
    saveCommsFile(comms);
    res.json({ success: true });
  }
);

module.exports = router;
