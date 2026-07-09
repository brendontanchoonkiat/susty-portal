-- Adds a resolved flag to comms_comments (9 Jul 2026, per Brendon) — needed
-- so the daily comms reminder can tell "unresolved feedback waiting on a
-- reply" apart from comments that have already been addressed. Defaults to
-- false (unresolved) on insert; the portal lets anyone toggle it.

ALTER TABLE comms_comments ADD COLUMN IF NOT EXISTS resolved boolean NOT NULL DEFAULT false;

-- Verification
SELECT id, post_id, author_name, resolved, created_at FROM comms_comments ORDER BY created_at DESC LIMIT 5;
