#!/usr/bin/env tsx
/**
 * Admin CLI: set a feature-flag rule in the `FLAGS` KV namespace.
 *
 * Usage:
 *
 *   npm run flags:set -- <flag-name> '<rule-json>'
 *
 * Examples:
 *
 *   npm run flags:set -- ai_reading_v2 '{"mode":"always"}'
 *   npm run flags:set -- ai_reading_v2 '{"mode":"never"}'
 *   npm run flags:set -- ai_reading_v2 '{"mode":"users","users":["u-1","u-2"]}'
 *   npm run flags:set -- ai_reading_v2 '{"mode":"rollout","rolloutPct":25}'
 *
 * The rule JSON is validated with the same Zod schema the Worker uses
 * to read it back (src/domain/feature-flags/parse.ts), so a malformed
 * rule gets rejected at write time instead of silently disabling the
 * flag for everyone at runtime.
 *
 * Wrangler resolves the namespace id from wrangler.jsonc via the
 * `--binding FLAGS` flag — keeps this script in sync whenever the
 * namespace id rotates.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuleJson } from "../../src/domain/feature-flags/parse";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function usage(): never {
  // eslint-disable-next-line no-console
  console.error(
    "usage: npm run flags:set -- <flag-name> '<rule-json>'\n" +
      'example: npm run flags:set -- ai_reading_v2 \'{"mode":"always"}\'',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 2) usage();
  const [flag, rawRule] = argv as [string, string];
  if (flag.length === 0) usage();

  // Canonicalise the JSON before writing so stored values don't
  // carry the operator's whitespace or key ordering.
  const { canonicalJson } = parseRuleJson(rawRule);

  // eslint-disable-next-line no-console
  console.log(
    `[flags:set] writing ${flag} = ${canonicalJson} (--binding FLAGS --remote)`,
  );

  const args = [
    "wrangler",
    "kv",
    "key",
    "put",
    "--binding",
    "FLAGS",
    "--remote",
    flag,
    canonicalJson,
  ];

  const result = spawnSync("npx", args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Only run when invoked as a script — prevents any accidental
// side-effects if a tooling crawl imports this file.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) {
  void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
