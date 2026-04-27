#!/usr/bin/env tsx
/**
 * Operator CLI: summarise the rated-watch-corpus R2 bucket. Slice
 * #81 of PRD #73.
 *
 * Usage:
 *   npx tsx scripts/corpus-summary.ts --days=7
 *
 * Lists every corpus object whose date prefix
 * (`corpus/YYYY-MM-DD/...`) falls within the last N days (default
 * 7), downloads the sidecar JSON for each reading, and prints
 * aggregate statistics:
 *
 *   - Total readings ingested
 *   - Count by `dial_reader_version`
 *   - Count by `rejection_reason` (success rows show as "success")
 *   - Mean confidence (across rows that have a confidence)
 *
 * The script shells out to `wrangler r2 object list` and
 * `wrangler r2 object get` against the production binding name
 * `R2_CORPUS` so it always uses the same credentials chain as
 * `wrangler deploy`. There's no D1 or PII access — the corpus
 * bucket is the only data source.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const BUCKET_NAME = "rated-watch-corpus";

interface Sidecar {
  reading_id?: string;
  dial_reader_version?: string | null;
  confidence?: number | null;
  verified?: boolean;
  rejection_reason?: string | null;
}

function usage(): never {
  // eslint-disable-next-line no-console
  console.error(
    "usage: npx tsx scripts/corpus-summary.ts [--days=N] [--bucket=NAME]\n" +
      "  --days   number of trailing days to include (default 7)\n" +
      `  --bucket R2 bucket name (default ${BUCKET_NAME})`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { days: number; bucket: string } {
  let days = 7;
  let bucket = BUCKET_NAME;
  for (const a of argv) {
    if (a.startsWith("--days=")) {
      const n = Number(a.slice("--days=".length));
      if (!Number.isFinite(n) || n < 1 || n > 365) usage();
      days = Math.floor(n);
    } else if (a.startsWith("--bucket=")) {
      bucket = a.slice("--bucket=".length);
      if (bucket.length === 0) usage();
    } else if (a === "-h" || a === "--help") {
      usage();
    } else {
      usage();
    }
  }
  return { days, bucket };
}

/**
 * UTC `YYYY-MM-DD` for a Date. Mirrors the helper in
 * `src/domain/corpus/maybeIngest.ts` so the prefix scan and the
 * ingest path agree on date framing.
 */
function utcDateString(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lastNDates(now: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(utcDateString(d));
  }
  return out;
}

interface WranglerOpts {
  args: string[];
  capture: boolean;
}

function runWrangler(opts: WranglerOpts): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("npx", ["wrangler", ...opts.args], {
    cwd: REPO_ROOT,
    stdio: opts.capture ? "pipe" : "inherit",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

/**
 * List all objects under `corpus/{date}/` for the supplied bucket.
 * Returns the full list of object keys. Errors are propagated as
 * exceptions; the caller decides whether to ignore (e.g. a date
 * with no data may surface a non-zero exit).
 */
function listForDate(bucket: string, date: string): string[] {
  const prefix = `corpus/${date}/`;
  const result = runWrangler({
    args: ["r2", "object", "list", bucket, "--prefix", prefix, "--remote", "--json"],
    capture: true,
  });
  if (result.status !== 0) {
    // Wrangler returns non-zero when no objects match. Treat empty
    // as "no objects" rather than fatal.
    if (result.stderr.includes("No objects") || result.stdout.trim() === "") {
      return [];
    }
    process.stderr.write(result.stderr);
    throw new Error(`wrangler r2 list failed for prefix ${prefix}`);
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) return [];
  // Wrangler may output a single JSON array or a JSON-lines stream
  // depending on version. Try array first, fall back to lines.
  try {
    const arr = JSON.parse(stdout) as Array<{ key?: string } | string>;
    return arr
      .map((row) => (typeof row === "string" ? row : (row.key ?? "")))
      .filter((s) => s.length > 0);
  } catch {
    return stdout
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return "";
        try {
          const obj = JSON.parse(trimmed) as { key?: string };
          return obj.key ?? "";
        } catch {
          return "";
        }
      })
      .filter((k) => k.length > 0);
  }
}

/**
 * Fetch a single object's body as a string. Used to download
 * sidecars. Returns null on any error so a missing object doesn't
 * abort the whole walk.
 */
function getObjectText(bucket: string, key: string): string | null {
  // `wrangler r2 object get` writes to a file by default. Use
  // `--pipe` to send to stdout.
  const result = runWrangler({
    args: ["r2", "object", "get", `${bucket}/${key}`, "--pipe", "--remote"],
    capture: true,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
}

interface Aggregate {
  totalReadings: number;
  byVersion: Map<string, number>;
  byRejectionReason: Map<string, number>;
  confidenceSum: number;
  confidenceCount: number;
}

function freshAggregate(): Aggregate {
  return {
    totalReadings: 0,
    byVersion: new Map(),
    byRejectionReason: new Map(),
    confidenceSum: 0,
    confidenceCount: 0,
  };
}

function ingestSidecar(agg: Aggregate, sc: Sidecar): void {
  agg.totalReadings += 1;
  const version = sc.dial_reader_version ?? "(unknown)";
  agg.byVersion.set(version, (agg.byVersion.get(version) ?? 0) + 1);
  // Bucket success rows under the synthetic "success" key so the
  // operator gets a single tabulation showing both halves of the
  // corpus.
  const reasonKey = sc.verified ? "success" : (sc.rejection_reason ?? "(unknown)");
  agg.byRejectionReason.set(reasonKey, (agg.byRejectionReason.get(reasonKey) ?? 0) + 1);
  if (typeof sc.confidence === "number" && Number.isFinite(sc.confidence)) {
    agg.confidenceSum += sc.confidence;
    agg.confidenceCount += 1;
  }
}

function printAggregate(agg: Aggregate, days: number): void {
  // eslint-disable-next-line no-console
  console.log(`Corpus summary — last ${days} days`);
  // eslint-disable-next-line no-console
  console.log(`Total readings ingested: ${agg.totalReadings}`);
  if (agg.totalReadings === 0) return;

  // eslint-disable-next-line no-console
  console.log("\nBy dial_reader_version:");
  for (const [version, n] of [...agg.byVersion.entries()].sort((a, b) =>
    b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0]),
  )) {
    // eslint-disable-next-line no-console
    console.log(`  ${version}: ${n}`);
  }

  // eslint-disable-next-line no-console
  console.log("\nBy rejection_reason (or 'success'):");
  for (const [reason, n] of [...agg.byRejectionReason.entries()].sort((a, b) =>
    b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0]),
  )) {
    // eslint-disable-next-line no-console
    console.log(`  ${reason}: ${n}`);
  }

  if (agg.confidenceCount > 0) {
    const mean = agg.confidenceSum / agg.confidenceCount;
    // eslint-disable-next-line no-console
    console.log(`\nMean confidence: ${mean.toFixed(3)} (n=${agg.confidenceCount})`);
  } else {
    // eslint-disable-next-line no-console
    console.log("\nMean confidence: n/a (no confidence values present)");
  }
}

async function main(): Promise<void> {
  const { days, bucket } = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(`[corpus-summary] scanning bucket=${bucket} days=${days} (--remote)`);

  const dates = lastNDates(new Date(), days);
  const agg = freshAggregate();

  for (const date of dates) {
    const keys = listForDate(bucket, date);
    const sidecarKeys = keys.filter((k) => k.endsWith("/sidecar.json"));
    for (const key of sidecarKeys) {
      const text = getObjectText(bucket, key);
      if (text === null) continue;
      try {
        const parsed = JSON.parse(text) as Sidecar;
        ingestSidecar(agg, parsed);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[corpus-summary] skipping unparseable sidecar ${key}:`, err);
      }
    }
  }

  printAggregate(agg, days);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) {
  void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[corpus-summary] fatal:", err);
    process.exit(1);
  });
}
