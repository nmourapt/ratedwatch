-- Slice 8 (issue #9): watches table.
--
-- A "watch" is a user-owned piece of hardware being tracked for
-- timekeeping accuracy. Each watch belongs to exactly one user and
-- optionally references a row in `movements` (the caliber powering
-- it). Readings, sessions, and drift calculations in later slices
-- all anchor off a watch id.
--
-- Design notes:
--   * SQLite has no native boolean, so `is_public` is INTEGER 0/1 with
--     a CHECK constraint. The Kysely schema surfaces it as `number`
--     and the API layer flips it to/from boolean at the wire boundary.
--   * `movement_id` is nullable — when slice #10 lands user-submitted
--     pending movements, a watch may initially point at a pending row
--     and the row could later be withdrawn (ON DELETE SET NULL).
--   * `custom_movement_name` is reserved for the same pending flow so
--     the UI can render "Custom: <name>" without a second join.
--   * `created_at` defaults to millisecond-precision ISO 8601 UTC so
--     readings (same format) can be sorted against the creation time.

CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  movement_id TEXT,
  custom_movement_name TEXT,
  notes TEXT,
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (movement_id) REFERENCES movements(id) ON DELETE SET NULL
);

-- The two hot lookup paths: "list my watches" (by user_id) and
-- per-movement leaderboards (by movement_id). Both fit a single
-- non-unique index each.
CREATE INDEX IF NOT EXISTS idx_watches_user_id ON watches(user_id);
CREATE INDEX IF NOT EXISTS idx_watches_movement_id ON watches(movement_id);
