import { env } from "cloudflare:workers";
import { afterEach, describe, it, expect, vi } from "vitest";
import { isEnabled } from "@/domain/feature-flags";

// Exercises the service end-to-end against miniflare's KV binding.
// The evaluator's maths are covered by its own unit tests — here we
// only care that (a) KV round-trips drive the right branch of the
// evaluator and (b) the default-off fallback really doesn't throw.

type FlagsEnv = { FLAGS: KVNamespace };
const flagsEnv = env as unknown as FlagsEnv;

// Use a unique flag name per test so the implicit per-file storage
// isolation from vitest-pool-workers doesn't leak one test's KV
// writes into the next.
function uniqueFlag(name: string): string {
  return `test_${name}_${crypto.randomUUID()}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isEnabled", () => {
  it("returns false when KV has no rule for the flag", async () => {
    const flag = uniqueFlag("missing");
    expect(await isEnabled(flag, { userId: "u-1" }, flagsEnv)).toBe(false);
  });

  it("returns false and does not throw when KV value is malformed JSON", async () => {
    const flag = uniqueFlag("malformed");
    await flagsEnv.FLAGS.put(flag, "{this is not valid json");
    // Swallow the expected warn so it doesn't pollute test output.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isEnabled(flag, { userId: "u-1" }, flagsEnv)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("returns false when the rule fails schema validation", async () => {
    const flag = uniqueFlag("bogus");
    await flagsEnv.FLAGS.put(flag, JSON.stringify({ mode: "sometimes" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isEnabled(flag, { userId: "u-1" }, flagsEnv)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("always-mode rule is true regardless of context", async () => {
    const flag = uniqueFlag("always");
    await flagsEnv.FLAGS.put(flag, JSON.stringify({ mode: "always" }));
    expect(await isEnabled(flag, {}, flagsEnv)).toBe(true);
    expect(await isEnabled(flag, { userId: "u-1" }, flagsEnv)).toBe(true);
  });

  it("never-mode rule is false regardless of context", async () => {
    const flag = uniqueFlag("never");
    await flagsEnv.FLAGS.put(flag, JSON.stringify({ mode: "never" }));
    expect(await isEnabled(flag, { userId: "u-1" }, flagsEnv)).toBe(false);
  });

  it("users-mode rule gates by userId", async () => {
    const flag = uniqueFlag("users");
    await flagsEnv.FLAGS.put(
      flag,
      JSON.stringify({ mode: "users", users: ["alice", "bob"] }),
    );
    expect(await isEnabled(flag, { userId: "alice" }, flagsEnv)).toBe(true);
    expect(await isEnabled(flag, { userId: "bob" }, flagsEnv)).toBe(true);
    expect(await isEnabled(flag, { userId: "eve" }, flagsEnv)).toBe(false);
    expect(await isEnabled(flag, {}, flagsEnv)).toBe(false);
  });

  it("rollout:100 → enabled for any seeded user", async () => {
    const flag = uniqueFlag("rollout100");
    await flagsEnv.FLAGS.put(flag, JSON.stringify({ mode: "rollout", rolloutPct: 100 }));
    expect(await isEnabled(flag, { userId: "any-user" }, flagsEnv)).toBe(true);
  });

  it("rollout:0 → disabled for any seeded user", async () => {
    const flag = uniqueFlag("rollout0");
    await flagsEnv.FLAGS.put(flag, JSON.stringify({ mode: "rollout", rolloutPct: 0 }));
    expect(await isEnabled(flag, { userId: "any-user" }, flagsEnv)).toBe(false);
  });
});
