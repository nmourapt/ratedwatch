// Kysely `Database` interface matching the slice 4 init migration
// (migrations/0001_init.sql). Column types mirror the SQL declarations;
// SQLite has no native boolean or date types so those columns are
// surfaced here as their storage type (integer for booleans, ISO-string
// text for dates). Better Auth's Kysely adapter handles the marshalling
// on its side — when our own code reads these tables (e.g. username
// uniqueness check in src/server/auth.ts), we work with the raw types.
//
// Future slices extend this interface with rated.watch's own tables
// (movement, watch, reading, …).

import type { Generated } from "kysely";

export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number; // 0 | 1 — SQLite has no bool
  image: string | null;
  username: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  // Slice 2 of PRD #73 (issue #75): per-user opt-in toggle for
  // sharing rejected / low-confidence photos into the training
  // corpus. Stored as INTEGER 0/1; default 0. See
  // migrations/0007_verified_reading_cv.sql.
  consent_corpus: Generated<number>;
}

export interface SessionTable {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountTable {
  id: string;
  userId: string;
  accountId: string;
  providerId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
  password: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// Slice 7 (issue #8): movements taxonomy. Columns mirror
// migrations/0002_movements.sql. `type` and `status` are string enums
// at the SQL layer (CHECK constraints); we surface them as literal
// unions so Kysely queries get compile-time narrowing.
export type MovementType = "automatic" | "manual" | "quartz" | "spring-drive" | "other";
export type MovementStatus = "approved" | "pending";

export interface MovementsTable {
  id: string;
  canonical_name: string;
  manufacturer: string;
  caliber: string;
  type: MovementType;
  status: MovementStatus;
  submitted_by_user_id: string | null;
  notes: string | null;
  created_at: string; // ISO 8601, populated by DEFAULT
}

// Slice 8 (issue #9): watches. Columns mirror migrations/0003_watches.sql.
// `is_public` is stored as INTEGER 0/1 (SQLite has no native boolean)
// and converted to/from `boolean` at the API boundary — see the mapper
// in src/server/routes/watches.ts. `movement_id` + `custom_movement_name`
// are both nullable because the add-watch flow allows a user-submitted
// pending caliber (slice #10) to land before the movement is approved.
export interface WatchesTable {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  model: string | null;
  movement_id: string | null;
  custom_movement_name: string | null;
  notes: string | null;
  // `Generated<number>` lets Kysely treat `is_public` as an optional
  // column on INSERT (it has a SQL DEFAULT of 1) while still emitting
  // `number` on SELECT.
  is_public: Generated<number>; // 0 | 1
  created_at: Generated<string>; // ISO 8601, populated by DEFAULT
  // Slice 10 (issue #11): R2 key for the watch photo (format
  // `watches/{watchId}/image`). NULL when no image is set. See
  // migrations/0005_watch_images.sql.
  image_r2_key: string | null;
  // Slice (issue #57): manufacturer reference number, e.g. "3570.50"
  // for an Omega Speedmaster or "126610LN" for a Rolex Submariner.
  // Nullable because plenty of watches (vintage, microbrands,
  // one-offs) have no official reference. Max length enforced at the
  // Zod layer — see migrations/0006_watch_reference.sql.
  reference: string | null;
}

// Slice 12 (issue #13): readings. Columns mirror
// migrations/0004_readings.sql. Booleans are stored as INTEGER 0/1
// and converted to `boolean` at the API boundary. `reference_timestamp`
// is unix milliseconds (not ISO) so drift math works directly on the
// stored value.
export interface ReadingsTable {
  id: string;
  watch_id: string;
  // Denormalised from watches.user_id for per-user queries — always
  // set from the authed session at INSERT time; never trust client.
  user_id: string;
  reference_timestamp: number; // unix ms
  deviation_seconds: number; // signed REAL
  is_baseline: Generated<number>; // 0 | 1, default 0
  verified: Generated<number>; // 0 | 1, default 0 (slice #16 flips this)
  notes: string | null;
  created_at: Generated<string>; // ISO 8601, populated by DEFAULT
  // Slice 2 of PRD #73 (issue #75): CV-pipeline metadata. All three
  // are nullable — populated only when the verified-reading path
  // routes through the dial-reader container (and a photo upload
  // succeeds, in `photo_r2_key`'s case). Manual / tap / AI-path
  // readings leave these NULL. See
  // migrations/0007_verified_reading_cv.sql.
  photo_r2_key: string | null;
  dial_reader_confidence: number | null;
  dial_reader_version: string | null;
}

export interface Database {
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
  movements: MovementsTable;
  watches: WatchesTable;
  readings: ReadingsTable;
}
