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

// Editorial-stage auto status (added 9 Jul 2026 per Brendon): while a post is
// still pre-review, its status reflects how much content it actually has —
// `planned` = bare entry (date/theme/tagged member, nothing written yet),
// `draft` = someone's started on it (caption and/or image and/or details
// present). Only applies while the status is still one of these two — never
// overrides pending_review/needs_changes/approved/posted/archived, and an
// explicit `status` in the request body always wins (e.g. manually reverting
// something, or picking `idea`).
const PRE_REVIEW_STATUSES = ['planned', 'draft'];
function deriveEditorialStatus(currentStatus, content) {
  if (currentStatus && !PRE_REVIEW_STATUSES.includes(currentStatus)) return currentStatus;
  const hasImage = !!content.image_url || (Array.isArray(content.image_urls) && content.image_urls.length > 0);
  const hasContent = !!(content.caption || content.details || hasImage);
  return hasContent ? 'draft' : 'planned';
}

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
    // Multi-photo (added 9 Jul 2026, per Esther/Jonathan's feedback). Falls
    // back to wrapping the legacy single image_url so older posts (and any
    // code path that hasn't been updated to the array yet) still show a photo.
    imageUrls: (Array.isArray(row.image_urls) && row.image_urls.length) ? row.image_urls : (row.image_url ? [row.image_url] : []),
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
    try {
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
        status:     status !== undefined && VALID_STATUS.includes(status)
                      ? status
                      : deriveEditorialStatus(null, { caption, details, image_url: null }),
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
    } catch (err) {
      // Catches anything unexpected (Supabase client throwing instead of
      // returning {error}, local-file fs errors, etc.) — without this,
      // an async throw here doesn't reach server.js's error middleware at
      // all in Express 4 (it becomes a silent unhandled rejection and the
      // request just hangs), so surfacing it explicitly here is the only
      // way the caller gets a real response instead of a timeout.
      console.error('[Comms] POST / failed:', err.stack || err.message);
      res.status(500).json({ error: `Save failed: ${err.message}` });
    }
  }
);

// POST /:id/image — upload another image onto the post (multipart form field
// "image"). Appends to image_urls (multi-photo, added 9 Jul 2026 per
// Esther/Jonathan's feedback — most posts use 1-2 photos, occasionally more,
// so this is additive rather than replace-only). image_url (legacy single
// column) is kept in sync as image_urls[0] for any code still reading it.
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
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });
    if (!req.file) return res.status(400).json({ error: 'No image file provided (field name must be "image")' });

    const dbc = getClient();
    if (!dbc) return res.status(503).json({ error: 'Image upload requires Supabase (not configured)' });

    const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const filename = `post_${id}_${Date.now()}.${ext}`;
    const imageUrl = await db.uploadImage(req.file.buffer, filename, req.file.mimetype, 'comms');
    if (!imageUrl) return res.status(502).json({ error: 'Image upload to storage failed' });

    const { data: existing } = await dbc.from('comms_posts').select('status, image_urls, image_url').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'Post not found' });

    const currentUrls = Array.isArray(existing.image_urls) && existing.image_urls.length
      ? existing.image_urls
      : (existing.image_url ? [existing.image_url] : []);
    const newUrls = [...currentUrls, imageUrl];

    // An attached image always counts as "started on" — bump planned -> draft
    // the same way adding a caption/details does (deriveEditorialStatus is a
    // no-op once the post is past the pre-review stage).
    const patch = {
      image_urls: newUrls,
      image_url: newUrls[0], // legacy column, kept as "first photo" for back-compat
      status: deriveEditorialStatus(existing.status, { image_urls: newUrls }),
    };

    const { data, error } = await dbc.from('comms_posts').update(patch).eq('id', id).select().single();
    if (error) return res.status(404).json({ error: 'Post not found' });
    res.json(fromDbRow(data));
  } catch (err) {
    // Same rationale as POST / — without this, an unexpected throw here
    // (e.g. Supabase Storage client rejecting instead of returning null)
    // becomes a silent hang instead of a response the frontend can show.
    console.error('[Comms] POST /:id/image failed:', err.stack || err.message);
    res.status(500).json({ error: `Image upload failed: ${err.message}` });
  }
});

// DELETE /:id/image — removes one image from the post's image_urls by exact
// URL (body: { url }). Added 9 Jul 2026 alongside multi-photo support so a
// member can remove a wrongly-added photo without clearing all of them.
router.delete('/:id/image', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });
    const url = req.body?.url;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const dbc = getClient();
    if (!dbc) return res.status(503).json({ error: 'Requires Supabase (not configured)' });

    const { data: existing } = await dbc.from('comms_posts').select('image_urls, image_url').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'Post not found' });

    const currentUrls = Array.isArray(existing.image_urls) && existing.image_urls.length
      ? existing.image_urls
      : (existing.image_url ? [existing.image_url] : []);
    const newUrls = currentUrls.filter(u => u !== url);

    const patch = { image_urls: newUrls, image_url: newUrls[0] || null };
    const { data, error } = await dbc.from('comms_posts').update(patch).eq('id', id).select().single();
    if (error) return res.status(404).json({ error: 'Post not found' });
    res.json(fromDbRow(data));
  } catch (err) {
    console.error('[Comms] DELETE /:id/image failed:', err.stack || err.message);
    res.status(500).json({ error: `Image removal failed: ${err.message}` });
  }
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
  try {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

  const { status, theme, owner, notes, date, caption, details, assignees } = req.body;
  if (status !== undefined && !VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const dbcEarly = getClient();
  // Content is changing and the caller didn't explicitly set a status —
  // recompute planned/draft from the merged (existing + incoming) content so
  // editing a bare entry's caption/details correctly bumps it to "draft".
  let derivedStatus;
  if (status === undefined && (caption !== undefined || details !== undefined) && dbcEarly) {
    const { data: existing } = await dbcEarly.from('comms_posts').select('status, caption, details, image_url').eq('id', id).single();
    if (existing) {
      derivedStatus = deriveEditorialStatus(existing.status, {
        caption: caption !== undefined ? caption : existing.caption,
        details: details !== undefined ? details : existing.details,
        image_url: existing.image_url,
      });
    }
  }

  const patch = {};
  if (status !== undefined) {
    patch.status = status;
    // Only stamp posted_at when newly marking as posted; clear it on revert
    // so a reverted post doesn't carry a stale "posted" timestamp.
    patch.posted_at = status === 'posted' ? new Date().toISOString() : null;
  } else if (derivedStatus !== undefined) {
    patch.status = derivedStatus;
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
  } catch (err) {
    console.error('[Comms] PATCH /:id failed:', err.stack || err.message);
    res.status(500).json({ error: `Save failed: ${err.message}` });
  }
});

// POST /:id/duplicate — copies a post's content (theme, caption, details,
// images, assignees) into a brand-new post so a TL can reuse an archived
// idea/photo another time (added 9 Jul 2026, per Brendon). Date is left
// blank and status reset to planned/draft (re-derived from the copied
// content) — it's a fresh post from here, not linked back to the original.
router.post('/:id/duplicate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });

    const dbc = getClient();
    if (!dbc) return res.status(503).json({ error: 'Requires Supabase (not configured)' });

    const { data: original, error: fetchErr } = await dbc.from('comms_posts').select('*').eq('id', id).single();
    if (fetchErr || !original) return res.status(404).json({ error: 'Post not found' });

    const copy = {
      date: '',
      theme: original.theme,
      owner: original.owner || '',
      notes: original.notes || '',
      caption: original.caption || '',
      details: original.details || '',
      image_url: original.image_url || null,
      image_urls: original.image_urls || [],
      assignees: [],
      created_by: '',
      status: deriveEditorialStatus(null, { caption: original.caption, details: original.details, image_urls: original.image_urls }),
    };

    const { data, error } = await dbc.from('comms_posts').insert(copy).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(fromDbRow(data));
  } catch (err) {
    console.error('[Comms] POST /:id/duplicate failed:', err.stack || err.message);
    res.status(500).json({ error: `Duplicate failed: ${err.message}` });
  }
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

// ─── Comments (added 9 Jul 2026, per Esther's feedback) ────────────────────
// Right now only the TL's "Request Changes" note goes back to the assignee
// privately. This gives any member a visible comment thread on a post —
// no auth required, same open-creation philosophy as the rest of this route.
// See create_comms_comments_table.sql.

// Comments only open up once a post has actually gone to the TL for review
// (added 9 Jul 2026, per Brendon) — before that it's still a private draft
// the assignee is working on, so there's nothing to comment on yet.
const COMMENTABLE_STATUSES = ['pending_review', 'needs_changes', 'approved', 'posted', 'archived'];

function mapComment(c) {
  return { id: c.id, postId: c.post_id, author: c.author_name, comment: c.comment, resolved: !!c.resolved, createdAt: c.created_at };
}

// GET /:id/comments — list, oldest first
router.get('/:id/comments', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });
  const dbc = getClient();
  if (!dbc) return res.json([]); // no Supabase configured — comments simply unavailable, not an error
  const { data, error } = await dbc.from('comms_comments').select('*').eq('post_id', id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(mapComment));
});

// POST /:id/comments — add a comment { author, comment }. Only allowed once
// the post has been submitted for review — see COMMENTABLE_STATUSES above.
router.post('/:id/comments', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });
    const author  = sanitise(req.body?.author || '').slice(0, 60);
    const comment = sanitise(req.body?.comment || '').slice(0, 1000);
    if (!author)  return res.status(400).json({ error: 'Your name is required' });
    if (!comment) return res.status(400).json({ error: 'Comment cannot be empty' });

    const dbc = getClient();
    if (!dbc) return res.status(503).json({ error: 'Requires Supabase (not configured)' });

    const { data: post } = await dbc.from('comms_posts').select('*').eq('id', id).single();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!COMMENTABLE_STATUSES.includes(post.status)) {
      return res.status(400).json({ error: 'Comments open up once this post is submitted for review.' });
    }

    const { data, error } = await dbc.from('comms_comments')
      .insert({ post_id: id, author_name: author, comment }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    try {
      const { notifyOnNewComment } = require('../utils/commsNotify');
      await notifyOnNewComment(post, author, comment);
    } catch (err) {
      console.warn('[Comms] Failed to notify on new comment:', err.message);
    }

    res.status(201).json(mapComment(data));
  } catch (err) {
    console.error('[Comms] POST /:id/comments failed:', err.stack || err.message);
    res.status(500).json({ error: `Comment failed: ${err.message}` });
  }
});

// PATCH /:id/comments/:commentId — toggle resolved { resolved: true|false }.
// No auth required (same open philosophy as the rest of comms) — anyone
// (assignee or TL) can mark feedback addressed. Drives the reminder logic
// in reminders.js: unresolved comments on a draft keep nudging the assignee.
router.patch('/:id/comments/:commentId', async (req, res) => {
  const commentId = Number(req.params.commentId);
  if (!Number.isInteger(commentId) || commentId <= 0) return res.status(400).json({ error: 'Invalid comment ID' });
  if (typeof req.body?.resolved !== 'boolean') return res.status(400).json({ error: 'resolved (boolean) is required' });
  const dbc = getClient();
  if (!dbc) return res.status(503).json({ error: 'Requires Supabase (not configured)' });
  const { data, error } = await dbc.from('comms_comments').update({ resolved: req.body.resolved }).eq('id', commentId).select().single();
  if (error || !data) return res.status(404).json({ error: error?.message || 'Comment not found' });
  res.json(mapComment(data));
});

// DELETE /:id/comments/:commentId — TL-only moderation (admin key required,
// same gate as the roster editor / post delete).
router.delete('/:id/comments/:commentId',
  (req, res, next) => req.app.get('requireApiKey')(req, res, next),
  async (req, res) => {
    const commentId = Number(req.params.commentId);
    if (!Number.isInteger(commentId) || commentId <= 0) return res.status(400).json({ error: 'Invalid comment ID' });
    const dbc = getClient();
    if (!dbc) return res.status(503).json({ error: 'Requires Supabase (not configured)' });
    const { error } = await dbc.from('comms_comments').delete().eq('id', commentId);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  }
);

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
