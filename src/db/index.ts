// Kysely factory. One place that wraps a D1 binding in a typed Kysely
// client so handlers never call `env.DB.prepare(...)` directly — that
// would bypass the typed query builder and is explicitly out-of-bounds
// per AGENTS.md ("No raw `db.prepare(...)` outside the data layer").
//
// The Database interface lives in ./schema.ts and is the single source
// of truth for column names + types across the app.

import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { Database } from "./schema";

export type DB = Kysely<Database>;

/**
 * Build a Kysely client bound to the Worker's D1 database. Call this
 * once per request; Kysely instances are cheap and stateless.
 */
export function createDb(env: { DB: D1Database }): DB {
  return new Kysely<Database>({
    dialect: new D1Dialect({ database: env.DB }),
  });
}
