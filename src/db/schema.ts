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

export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number; // 0 | 1 — SQLite has no bool
  image: string | null;
  username: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
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
  is_public: number; // 0 | 1
  created_at: string; // ISO 8601, populated by DEFAULT
}

export interface Database {
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
  movements: MovementsTable;
  watches: WatchesTable;
}
