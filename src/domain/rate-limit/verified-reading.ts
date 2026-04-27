// Worker-side helper for the verified-reading rate-limit gate.
//
// Slice #82 of PRD #73 implements user story #25 ("50 verified-
// reading attempts per 24-hour rolling window per user"). Both
// photo-bearing reading endpoints — `POST /readings/verified` and
// `POST /readings/manual_with_photo` — share a single quota; pure
// manual readings (no photo) are unrelated and stay unlimited.
//
// Two cooperating gates
// ---------------------
// 1. **Burst gate (binding)**: the `VERIFIED_READING_LIMITER`
//    Cloudflare ratelimit binding. The GA shape caps `simple.period`
//    at 60 seconds, so this is a per-minute burst guard, not the
//    24h cap. It exists to deflect runaway clients cheaply at the
//    edge before any DB lookup runs.
//
// 2. **Daily-cap gate (D1 row-count)**: counts photo-bearing
//    readings (`photo_r2_key IS NOT NULL`) inserted by this user
//    over the last 24h via the partial index added in migration
//    0007. This is the gate that matches the product spec exactly
//    and is what end users see at the 51st attempt of the day.
//
// Both gates emit the same outcome shape so the route layer can
// branch once and emit one structured 429 body. Both gates fail
// OPEN: the cap is a cost guardrail, not a security perimeter, so
// a transient outage of either layer must not take down the
// verified-reading flow for legitimate users. Failures are logged
// once each so an operator tail catches systemic outages.
//
// Test escape hatch
// -----------------
// `__setTestRateLimiter(fn)` lets integration tests install a
// deterministic fake for the binding layer. The pattern mirrors
// `__setTestDialReader` / `__setTestAiRunner` already in the
// codebase. miniflare under vitest-pool-workers does simulate the
// ratelimit binding, but counter state across test files is
// fragile (the bucket persists across the file boundary), so a
// module-level fake is the only ordering-independent way to drive
// the burst-gate behaviour.

import { sql } from "kysely";
import type { DB } from "@/db";

/** The cap from PRD #73 user story #25. */
export const DAILY_CAP = 50;

/**
 * Window over which the daily cap is counted. 24 hours expressed
 * in milliseconds, kept here so the route layer can echo the same
 * value back to the SPA in the structured 429 body if needed.
 */
export const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The minimum env shape this helper needs. The binding is OPTIONAL
 * at the type level: legacy / preview environments may not have
 * it provisioned and the helper fails open in that case.
 */
export interface RateLimitEnv {
  VERIFIED_READING_LIMITER?: RateLimit;
}

/**
 * Adapter the helper uses to count photo-bearing readings. Defined
 * as a small interface so tests can inject a fake without dragging
 * in Kysely. Real callers use {@link createRateLimitDb}.
 */
export interface RateLimitDb {
  countPhotoReadings(userId: string): Promise<number>;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "burst" | "daily_cap" };

/**
 * Test-only interface: a callable matching the binding's `limit`
 * shape. Tests inject one of these via `__setTestRateLimiter` to
 * deterministically control whether subsequent burst-gate calls
 * are allowed or blocked.
 */
export type RateLimiter = (key: string) => Promise<{ success: boolean }>;

let testLimiter: RateLimiter | null = null;

/**
 * TEST-ONLY. Install a fake limiter that subsequent calls to
 * `checkVerifiedReadingLimit` will route to until cleared. Pass
 * `null` in a teardown hook to restore the production binding path.
 *
 * Deliberately not re-exported from any barrel — the only callers
 * are test files that import this module directly.
 */
export function __setTestRateLimiter(fn: RateLimiter | null): void {
  testLimiter = fn;
}

interface CheckArgs {
  env: RateLimitEnv;
  db: RateLimitDb;
  userId: string;
}

/**
 * Run the two-layer rate-limit check.
 *
 * Order matters:
 *   * Burst gate runs first (cheap, no DB hit).
 *   * If the burst gate succeeds OR fails open, the daily-cap gate
 *     runs and is the authoritative answer for the product spec.
 */
export async function checkVerifiedReadingLimit(
  args: CheckArgs,
): Promise<RateLimitDecision> {
  const { env, db, userId } = args;

  // ---- Burst gate ------------------------------------------------
  const burstAllowed = await checkBurst(env, userId);
  if (burstAllowed === false) {
    // Real signal that this user is hammering us. Short-circuit
    // before incurring a D1 read.
    return { allowed: false, reason: "burst" };
  }
  // Either allowed=true or the gate failed open. Either way the
  // daily-cap gate must still run.

  // ---- Daily-cap gate -------------------------------------------
  let count: number;
  try {
    count = await db.countPhotoReadings(userId);
  } catch (err) {
    console.warn("rate-limit: daily-cap query threw, failing open:", err);
    return { allowed: true };
  }
  if (count >= DAILY_CAP) {
    return { allowed: false, reason: "daily_cap" };
  }

  return { allowed: true };
}

/**
 * Internal — run the burst gate. Returns:
 *   true  → the binding (or test override) said success.
 *   false → the binding said success=false. Caller MUST block.
 *   true  → on transport / missing-binding error (fail open). The
 *           caller cannot tell this apart from a real success, but
 *           that's the intended fail-open semantic.
 */
async function checkBurst(env: RateLimitEnv, userId: string): Promise<boolean> {
  const override = testLimiter;
  if (override) {
    try {
      const out = await override(userId);
      return Boolean(out.success);
    } catch (err) {
      console.warn("rate-limit: test limiter threw, failing open:", err);
      return true;
    }
  }

  const binding = env.VERIFIED_READING_LIMITER;
  if (!binding) {
    // Preview environments / freshly-provisioned tests / early-boot
    // states. Silently fail open — a missing binding is an expected
    // state in dev, not an error.
    return true;
  }

  try {
    const out = await binding.limit({ key: userId });
    return Boolean(out.success);
  } catch (err) {
    console.warn("rate-limit: binding threw, failing open:", err);
    return true;
  }
}

/**
 * Build a {@link RateLimitDb} adapter from a Kysely DB instance.
 * Counts photo-bearing readings (`photo_r2_key IS NOT NULL`) by
 * the given user inserted in the last 24h. Uses the partial index
 * `idx_readings_photo_r2_key` added in migration 0007.
 *
 * The ISO-8601 lower bound is materialised in JS rather than via
 * SQLite's `datetime('now', '-24 hours')` so the test fixtures can
 * precisely control "now" by inserting rows with explicit
 * `created_at` timestamps. SQLite's clock arithmetic is not vi-fake-
 * clock-aware.
 */
export function createRateLimitDb(db: DB): RateLimitDb {
  return {
    async countPhotoReadings(userId: string): Promise<number> {
      const sinceIso = new Date(Date.now() - DAILY_WINDOW_MS).toISOString();
      // SQLite's `created_at` column is a TEXT in the schema's ISO-
      // 8601-with-millisecond-precision format, so a string compare
      // works as a chronological compare here. We use an aliased
      // count to keep Kysely's typing strict.
      const row = await db
        .selectFrom("readings")
        .select(({ fn }) => fn.countAll<number>().as("c"))
        .where("user_id", "=", userId)
        .where("photo_r2_key", "is not", null)
        .where("created_at", ">=", sinceIso)
        .executeTakeFirst();
      // Defensive — `executeTakeFirst` could in theory return
      // undefined (it shouldn't for an aggregate); coerce to 0 so
      // the caller never NaNs out.
      const count = Number(row?.c ?? 0);
      // SQLite returns counts as numbers; coerce defensively for
      // the case where a future Kysely rev hands back BigInt.
      return Number.isFinite(count) ? count : 0;
    },
  };
}

// Suppress unused-import warning if Kysely's `sql` template tag is
// not referenced — kept here in case future tweaks need it for a
// raw expression.
void sql;
