-- Slice 10 (issue #11): watch image upload.
--
-- Each watch gets at most one photo, stored in R2 at the key
-- `watches/{watchId}/image` with the uploaded content-type preserved
-- on the R2 object's httpMetadata. We remember the R2 key on the
-- watch row both as a presence flag ("this watch has an image") and
-- so the watch-delete handler can clean up R2 in the same path.
--
-- Design notes:
--   * Single nullable TEXT column — no separate images table needed
--     for a 1:1 relation with a trivial payload shape.
--   * No index: the column is always read through a point-lookup on
--     the watch id.
--   * We keep the key in the column rather than deriving it from
--     watch_id so a future slice that changes the key layout (e.g.
--     variant sizes) doesn't need a backfill. The current uploader
--     always writes `watches/{id}/image`, but the DB is the source
--     of truth for reads.

ALTER TABLE watches ADD COLUMN image_r2_key TEXT;
