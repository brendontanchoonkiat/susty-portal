-- Visible comments on comms posts (9 Jul 2026, per Esther's feedback — right
-- now only the TL's "Request Changes" note goes back to the assignee
-- privately; there was no way for any other member to leave feedback that's
-- visible to the team, e.g. Wee Shing suggesting a tweak to a caption).
--
-- Any member can post a comment (no login system in this app, so author_name
-- is free text, same trust model as the rest of comms_posts). Comments are
-- shown to everyone viewing the post in the portal editor, in order.

CREATE TABLE IF NOT EXISTS comms_comments (
  id          bigserial PRIMARY KEY,
  post_id     bigint NOT NULL REFERENCES comms_posts(id) ON DELETE CASCADE,
  author_name text NOT NULL,
  comment     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comms_comments_post_id_idx ON comms_comments(post_id);

-- Same RLS posture as the rest of the app (see enable_rls_all_tables.sql) —
-- enable with no policies, since the backend only ever talks to Supabase via
-- the service_role key, which bypasses RLS.
ALTER TABLE comms_comments ENABLE ROW LEVEL SECURITY;

-- Verification
SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'comms_comments';
SELECT * FROM comms_comments ORDER BY created_at DESC LIMIT 5;
