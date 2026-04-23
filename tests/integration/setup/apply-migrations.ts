// vitest setup file. Runs once per worker before any test file.
//
// `applyD1Migrations` is idempotent — it only applies migrations that
// haven't already been recorded in D1's internal `d1_migrations`
// table, so re-running inside miniflare's per-test storage isolation
// is safe.

import { applyD1Migrations, env } from "cloudflare:test";

const ambient = env as {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

await applyD1Migrations(ambient.DB, ambient.TEST_MIGRATIONS);
