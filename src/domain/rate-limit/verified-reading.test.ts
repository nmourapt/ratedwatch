// Unit tests for the verified-reading rate-limit helper.
//
// The helper is a two-layer gate that wraps the
// `VERIFIED_READING_LIMITER` binding (per-minute burst protection)
// AND a D1 row-count over the readings table (per-24h product cap
// from PRD #73 user story #25). Both gates emit the same outcome
// shape so the route layer never branches on which one fired.
//
// Behaviour summary:
//
//   * Test override installed → delegate, skip the real binding.
//   * Burst gate (binding) reports failure → block immediately.
//     We do NOT touch D1 in this case; the burst gate is the cheap
//     edge filter that exists precisely to avoid the DB lookup
//     when the user is hammering us.
//   * Burst gate passes, D1 row-count >= 50 photo-bearing readings
//     by this user in the last 24h → block.
//   * Burst gate passes, D1 row-count < 50 → allow.
//   * Binding throws / missing → fail OPEN on the burst layer (the
//     daily cap still runs and is the source of truth for the
//     product spec).
//   * D1 throws → fail OPEN. Both layers fail open by design: the
//     cap is a cost guardrail, not a security perimeter.

import { afterEach, describe, expect, it, vi } from "vitest";
import { __setTestRateLimiter, checkVerifiedReadingLimit } from "./verified-reading";

interface FakeBinding {
  limit: ReturnType<typeof vi.fn>;
}

interface FakeDb {
  // Mirrors the surface our helper actually uses on a Kysely-like
  // builder. The helper computes a count of photo-bearing readings
  // for a user_id in a 24h window.
  countPhotoReadings: ReturnType<typeof vi.fn>;
}

interface FakeEnv {
  VERIFIED_READING_LIMITER?: FakeBinding;
}

function makeBinding(success: boolean): FakeBinding {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

function makeDb(count: number | "throw"): FakeDb {
  if (count === "throw") {
    return {
      countPhotoReadings: vi.fn().mockRejectedValue(new Error("d1 boom")),
    };
  }
  return { countPhotoReadings: vi.fn().mockResolvedValue(count) };
}

afterEach(() => {
  __setTestRateLimiter(null);
});

describe("checkVerifiedReadingLimit — burst gate (binding)", () => {
  it("returns allowed=true when binding succeeds AND daily count < cap", async () => {
    const env: FakeEnv = { VERIFIED_READING_LIMITER: makeBinding(true) };
    const db = makeDb(10);
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-123",
    });
    expect(result).toEqual({ allowed: true });
    expect(env.VERIFIED_READING_LIMITER!.limit).toHaveBeenCalledWith({ key: "user-123" });
    expect(db.countPhotoReadings).toHaveBeenCalledWith("user-123");
  });

  it("returns allowed=false with reason 'burst' when binding fails", async () => {
    const env: FakeEnv = { VERIFIED_READING_LIMITER: makeBinding(false) };
    // DB shouldn't even be touched on the burst-fail short-circuit.
    const db = makeDb(0);
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-123",
    });
    expect(result).toEqual({ allowed: false, reason: "burst" });
    expect(db.countPhotoReadings).not.toHaveBeenCalled();
  });

  it("fails open on binding error and continues to the daily-cap layer", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env: FakeEnv = {
      VERIFIED_READING_LIMITER: {
        limit: vi.fn().mockRejectedValue(new Error("transport boom")),
      },
    };
    const db = makeDb(0);
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-123",
    });
    expect(result).toEqual({ allowed: true });
    expect(consoleSpy).toHaveBeenCalled();
    expect(db.countPhotoReadings).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("fails open on missing binding and continues to the daily-cap layer", async () => {
    const env: FakeEnv = {};
    const db = makeDb(0);
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-123",
    });
    expect(result).toEqual({ allowed: true });
    expect(db.countPhotoReadings).toHaveBeenCalled();
  });
});

describe("checkVerifiedReadingLimit — daily-cap gate (D1 row count)", () => {
  it("returns allowed=true when count == 49 (one slot left)", async () => {
    const env: FakeEnv = { VERIFIED_READING_LIMITER: makeBinding(true) };
    const db = makeDb(49);
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-123",
    });
    expect(result).toEqual({ allowed: true });
  });

  it("returns allowed=false with reason 'daily_cap' at count == 50", async () => {
    const env: FakeEnv = { VERIFIED_READING_LIMITER: makeBinding(true) };
    const db = makeDb(50);
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-123",
    });
    expect(result).toEqual({ allowed: false, reason: "daily_cap" });
  });

  it("fails open when the D1 query throws", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env: FakeEnv = { VERIFIED_READING_LIMITER: makeBinding(true) };
    const db = makeDb("throw");
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-123",
    });
    expect(result).toEqual({ allowed: true });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("checkVerifiedReadingLimit — test override", () => {
  it("delegates to the test override and skips the real binding", async () => {
    const fake = vi.fn().mockResolvedValue({ success: false });
    __setTestRateLimiter(fake);
    const env: FakeEnv = { VERIFIED_READING_LIMITER: makeBinding(true) };
    const db = makeDb(0);
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-xyz",
    });
    expect(result).toEqual({ allowed: false, reason: "burst" });
    expect(fake).toHaveBeenCalledWith("user-xyz");
    // Real binding wasn't consulted.
    expect(env.VERIFIED_READING_LIMITER!.limit).not.toHaveBeenCalled();
    // DB wasn't consulted either (burst short-circuit).
    expect(db.countPhotoReadings).not.toHaveBeenCalled();
  });

  it("test override returning success allows daily-cap to run", async () => {
    const fake = vi.fn().mockResolvedValue({ success: true });
    __setTestRateLimiter(fake);
    const env: FakeEnv = { VERIFIED_READING_LIMITER: makeBinding(true) };
    const db = makeDb(50);
    const result = await checkVerifiedReadingLimit({
      env: env as never,
      db: db as never,
      userId: "user-xyz",
    });
    expect(result).toEqual({ allowed: false, reason: "daily_cap" });
  });
});
