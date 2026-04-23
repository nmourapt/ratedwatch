-- Slice 4 initial schema: Better Auth core tables + the rated.watch
-- `username` column on `user`.
--
-- Better Auth's canonical Kysely schema (see
-- node_modules/@better-auth/core/dist/db/get-tables.mjs) ships these
-- four tables with the exact column names/types referenced here.
-- Dates are stored as ISO 8601 TEXT because the Better Auth Kysely
-- adapter for SQLite expects the driver to accept/emit ISO strings —
-- D1's prepared-statement binder stringifies Date objects to ISO by
-- default.
--
-- `username` is rated.watch-specific and added as an additional field
-- on the `user` model via `user.additionalFields` in src/server/auth.ts.
-- NOCASE collation gives us case-insensitive uniqueness so the public
-- URL /u/:name is stable regardless of how it was typed during signup.

CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  username TEXT NOT NULL COLLATE NOCASE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Username uniqueness is enforced case-insensitively so "Foo" and "foo"
-- can't both exist. Declared as a separate index because SQLite only
-- honours COLLATE on a UNIQUE index when the collation is attached to
-- the index, not the column-level UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS user_username_unique
  ON user (username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS session_userId_idx ON session (userId);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS account_userId_idx ON account (userId);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx
  ON verification (identifier);
