// vitest setup file. Runs once per worker before any test file.
//
// `applyD1Migrations` is idempotent — it only applies migrations that
// haven't already been recorded in D1's internal `d1_migrations`
// table, so re-running inside miniflare's per-test storage isolation
// is safe.

import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

// The wrangler-generated `Env` only covers real Worker bindings; our
// TEST_MIGRATIONS binding is a miniflare-only extension declared in
// vitest.config.ts, so narrow the env through unknown.
const ambient = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

await applyD1Migrations(ambient.DB, ambient.TEST_MIGRATIONS);
