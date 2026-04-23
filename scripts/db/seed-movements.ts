#!/usr/bin/env tsx
/**
 * Seed the `movements` table from src/domain/movements/seed.json.
 *
 * Usage:
 *
 *   npm run db:seed:movements           # seeds --remote (production D1)
 *   npm run db:seed:movements -- --local  # seeds the miniflare local D1
 *
 * Strategy: generate a single .sql file with `INSERT OR IGNORE` per
 * row (idempotent on the `id` primary key) and hand it to
 * `wrangler d1 execute`. We prefer `--file=` over `--command=` because
 * the ~100-row statement list exceeds what most shells accept as an
 * inline arg without headaches around quoting.
 *
 * Run order: the operator MUST apply migration 0002_movements.sql
 * before running this script (`wrangler d1 migrations apply
 * rated-watch-db --remote`). Until 0002 lands, `movements` doesn't
 * exist and the INSERTs error out.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSeedSql, type SeedRow } from "../../src/domain/movements/seed-sql";

// Resolve paths relative to this file so the script runs from any cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SEED_PATH = path.resolve(REPO_ROOT, "src/domain/movements/seed.json");
const DB_NAME = "rated-watch-db";

function parseArgs(argv: readonly string[]): { local: boolean } {
  const local = argv.includes("--local");
  const remote = argv.includes("--remote");
  if (local && remote) {
    throw new Error("pass only one of --local / --remote");
  }
  // Default to --remote (production) per the issue; --local is opt-in.
  return { local };
}

async function main(): Promise<void> {
  const { local } = parseArgs(process.argv.slice(2));
  const raw = readFileSync(SEED_PATH, "utf8");
  const rows = JSON.parse(raw) as SeedRow[];
  const sqlText = buildSeedSql(rows);

  const tmp = mkdtempSync(path.join(tmpdir(), "ratedwatch-seed-"));
  const sqlFile = path.join(tmp, "movements-seed.sql");
  writeFileSync(sqlFile, sqlText, "utf8");

  const scopeFlag = local ? "--local" : "--remote";
  const args = ["wrangler", "d1", "execute", DB_NAME, scopeFlag, `--file=${sqlFile}`];

  // eslint-disable-next-line no-console
  console.log(
    `[seed-movements] seeding ${rows.length} rows into ${DB_NAME} ${scopeFlag}`,
  );

  const result = spawnSync("npx", args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });

  // Best-effort tmp cleanup. If wrangler wrote nothing to the file,
  // fine — we've already handed it off.
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Only run when invoked as a script — keeps `buildSeedSql` importable
// from the unit test without kicking off a wrangler spawn.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) {
  void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
