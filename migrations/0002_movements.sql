-- Slice 7 (issue #8): movements taxonomy.
--
-- Watches compete on leaderboards grouped by their movement (caliber).
-- `movements` is a curated, reference-data-style table:
--
--   * Approved rows are seeded by the operator via scripts/db/seed-movements.ts
--     (the seed file lives under src/domain/movements/seed.json).
--   * Pending rows are user-submitted and hidden from the default search;
--     the submission flow is slice #10 and not part of this migration.
--   * The primary key is a URL-safe slug (`eta-2892-a2`, `seiko-nh35`) so
--     the future /m/:movementId public pages have stable URLs.
--
-- `submitted_by_user_id` is nullable so the seed rows (which have no
-- submitter) insert cleanly. When a user is deleted, their pending
-- submissions are detached rather than cascaded — the movement row
-- itself may already be referenced from watches.

CREATE TABLE IF NOT EXISTS movements (
  id TEXT PRIMARY KEY NOT NULL,
  canonical_name TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  caliber TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('automatic', 'manual', 'quartz', 'spring-drive', 'other')),
  status TEXT NOT NULL CHECK (status IN ('approved', 'pending')),
  submitted_by_user_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (submitted_by_user_id) REFERENCES user(id) ON DELETE SET NULL
);

-- Search and browse indexes. All three use NOCASE for the text columns
-- because the public-facing typeahead is case-insensitive and we don't
-- want to force `LOWER(...)` wrapping at every query site.
CREATE INDEX IF NOT EXISTS idx_movements_status ON movements(status);
CREATE INDEX IF NOT EXISTS idx_movements_manufacturer ON movements(manufacturer COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_movements_canonical_name_ci ON movements(canonical_name COLLATE NOCASE);
