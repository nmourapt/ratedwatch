-- Slice 2 (issue #75) of the CV-pipeline replacement (PRD #73): add
-- the metadata columns the new dial-reader pipeline writes on a
-- successful verified reading, plus the per-user toggle that gates
-- whether a rejected/low-confidence photo is shared into the
-- training corpus.
--
-- The columns mirror the contract documented in #73 and persisted
-- by `src/domain/reading-verifier/verifier.ts` once the
-- `ai_reading_v2` flag routes through the container path:
--
--   * `photo_r2_key` — opaque object key in the IMAGES R2 bucket
--     pointing at the photo for a given reading. Format:
--     `readings/{reading_id}/photo.{ext}`. NULL means no photo was
--     stored (manual reading, or best-effort upload failed). The
--     existing AI path also writes this column on success — the new
--     CV path is just the second writer.
--
--   * `dial_reader_confidence` — composite 0..1 score returned by
--     the CV pipeline. NULL on the AI path (the legacy runner has
--     no confidence signal) and on manual rows. We persist it even
--     when verified=1 so a future operator can audit borderline
--     reads (PRD User Story #19).
--
--   * `dial_reader_version` — the semver-ish container build
--     identifier (e.g. `v0.0.1-scaffolding`). Lets operators
--     correlate a misread with the container build that produced
--     it. NULL on the AI path / manual.
--
--   * `consent_corpus` (on user) — opt-in toggle. When 1, rejected
--     or low-confidence photos may be copied to the corpus bucket
--     (PRD User Stories #13-#16). Default 0 — privacy-preserving.
--     Stored as INTEGER 0/1 per the SQLite-no-bool convention from
--     the rest of the schema.
--
-- The partial index `idx_readings_corpus_eligible` is the cheap
-- "list rows with a stored photo, newest first" query that the
-- nightly corpus job (PRD User Story #30) will run. The WHERE
-- clause restricts the index to rows that actually have a photo,
-- which keeps the index small (most readings will be manual / no
-- photo) without needing a full table scan to skip NULLs.
--
-- All three readings columns are nullable so this migration is a
-- pure ADD COLUMN — no backfill required, no rewrites of historical
-- data. The `consent_corpus` column has a NOT NULL default so it is
-- safe for existing rows (they all become 0 = no consent).

ALTER TABLE readings ADD COLUMN photo_r2_key TEXT;
ALTER TABLE readings ADD COLUMN dial_reader_confidence REAL;
ALTER TABLE readings ADD COLUMN dial_reader_version TEXT;

ALTER TABLE user ADD COLUMN consent_corpus INTEGER NOT NULL
  DEFAULT 0 CHECK (consent_corpus IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_readings_corpus_eligible
  ON readings(photo_r2_key, created_at)
  WHERE photo_r2_key IS NOT NULL;
