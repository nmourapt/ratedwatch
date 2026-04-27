import { describe, it, expect } from "vitest";
import { evaluateRule } from "./evaluator";
import type { FlagRule } from "./types";

// Pure-function tests. Evaluator has no I/O, no KV, no env — everything
// the public `isEnabled` depends on is validated here so the rest of
// the service is a thin wrapper around KV-read-and-parse.

describe("evaluateRule (always / never)", () => {
  it("always → true for any context", async () => {
    expect(await evaluateRule({ mode: "always" }, {})).toBe(true);
    expect(await evaluateRule({ mode: "always" }, { userId: "u-1" })).toBe(true);
  });

  it("never → false for any context", async () => {
    expect(await evaluateRule({ mode: "never" }, {})).toBe(false);
    expect(await evaluateRule({ mode: "never" }, { userId: "u-1" })).toBe(false);
  });
});

describe("evaluateRule (users)", () => {
  const rule: FlagRule = { mode: "users", users: ["a", "b"] };

  it("includes listed user → true", async () => {
    expect(await evaluateRule(rule, { userId: "a" })).toBe(true);
    expect(await evaluateRule(rule, { userId: "b" })).toBe(true);
  });

  it("excludes other user → false", async () => {
    expect(await evaluateRule(rule, { userId: "c" })).toBe(false);
  });

  it("no userId → false", async () => {
    expect(await evaluateRule(rule, {})).toBe(false);
  });
});

describe("evaluateRule (rollout)", () => {
  it("rolloutPct:0 → always false", async () => {
    const rule: FlagRule = { mode: "rollout", rolloutPct: 0 };
    for (const userId of ["u-1", "u-2", "u-3", "a-very-different-id"]) {
      expect(await evaluateRule(rule, { userId })).toBe(false);
    }
  });

  it("rolloutPct:100 → true for any userId", async () => {
    const rule: FlagRule = { mode: "rollout", rolloutPct: 100 };
    for (const userId of ["u-1", "u-2", "u-3", "a-very-different-id"]) {
      expect(await evaluateRule(rule, { userId })).toBe(true);
    }
  });

  it("rolloutPct:50 with no userId → false (anon users default out)", async () => {
    const rule: FlagRule = { mode: "rollout", rolloutPct: 50 };
    expect(await evaluateRule(rule, {})).toBe(false);
  });

  it("rolloutPct is stable per (user, flag) — same call twice gives same result", async () => {
    const rule: FlagRule = { mode: "rollout", rolloutPct: 37 };
    const a = await evaluateRule(rule, { userId: "stable-user-id" }, "flag-x");
    const b = await evaluateRule(rule, { userId: "stable-user-id" }, "flag-x");
    expect(a).toBe(b);
  });

  it("rolloutPct:25 distributes ~25 % across 1000 synthetic users", async () => {
    const rule: FlagRule = { mode: "rollout", rolloutPct: 25 };
    let enabled = 0;
    for (let i = 0; i < 1000; i++) {
      if (await evaluateRule(rule, { userId: `user-${i}` }, "verified_reading_cv")) {
        enabled++;
      }
    }
    // SHA-256 distributes uniformly; empirically this runs ~250 ± 15
    // for a 1k sample. 20-30 % is a safe-but-tight band that will
    // still catch a systematically-wrong bucketing impl.
    expect(enabled).toBeGreaterThanOrEqual(200);
    expect(enabled).toBeLessThanOrEqual(300);
  });
});
