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

export interface Database {
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
}
