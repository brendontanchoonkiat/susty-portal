-- Multi-photo support for comms_posts (9 Jul 2026, per Esther/Jonathan's
-- feedback in the 9 Jul walkthrough — most posts use 1-2 photos, occasionally
-- more, and the portal only supported one image per post).
--
-- image_url (existing single-image column) is left in place and kept in sync
-- as image_urls[0] by the backend for anything not yet updated to read the
-- array — nothing reading the old column breaks.

ALTER TABLE comms_posts ADD COLUMN IF NOT EXISTS image_urls text[] DEFAULT '{}';

-- Backfill: wrap any existing single image_url into the new array so
-- existing posts don't lose their photo.
UPDATE comms_posts
SET image_urls = ARRAY[image_url]
WHERE image_url IS NOT NULL
  AND (image_urls IS NULL OR image_urls = '{}');

-- Verification
SELECT id, theme, image_url, image_urls FROM comms_posts ORDER BY id;
