-- Slice 12 (issue #13): readings table.
--
-- A "reading" is one recorded observation of a watch's displayed time
-- against an authoritative reference time. The `deviation_seconds`
-- is the signed difference at that moment (positive = watch ahead).
-- Readings anchor sessions and drift calculations (see
-- src/domain/drift-calc/).
--
-- Design notes:
--   * `user_id` is denormalised from `watches.user_id` so per-user
--     queries (e.g. "all my readings this week") stay a single-table
--     scan. Integrity is maintained by always setting it on INSERT
--     from the authed session and by the `watches` ownership check
--     at the API layer.
--   * `reference_timestamp` is unix milliseconds INTEGER — easier to
--     arithmetic on than ISO strings, and matches Date.now() on the
--     client side without conversion. `created_at` stays ISO for
--     consistency with the rest of the schema.
--   * SQLite has no native boolean, so `is_baseline` / `verified`
--     are INTEGER 0/1 with CHECK constraints. The Kysely schema
--     surfaces them as `number` and the API layer flips them to
--     boolean at the wire boundary.
--   * `deviation_seconds` is REAL so sub-second precision from the
--     verified-capture flow (slice #16) survives the DB round-trip.
--   * ON DELETE CASCADE on watch_id so removing a watch cleans up
--     its readings. Same for user_id so account deletion is clean.

CREATE TABLE IF NOT EXISTS readings (
  id TEXT PRIMARY KEY NOT NULL,
  watch_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reference_timestamp INTEGER NOT NULL,
  deviation_seconds REAL NOT NULL,
  is_baseline INTEGER NOT NULL DEFAULT 0 CHECK (is_baseline IN (0, 1)),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (watch_id) REFERENCES watches(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

-- The two hot lookup paths:
--   1. "list readings for a watch in chronological order" (session stats)
--   2. "list readings for a user" (per-user summaries in later slices)
CREATE INDEX IF NOT EXISTS idx_readings_watch_id_ref_ts
  ON readings(watch_id, reference_timestamp);
CREATE INDEX IF NOT EXISTS idx_readings_user_id ON readings(user_id);
