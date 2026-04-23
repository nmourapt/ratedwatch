// Pure rule evaluator. No KV, no env — callers pass the already-parsed
// rule and the request context, get a boolean back.
//
// Keeping this separate from `service.ts` means the bucketing maths
// are unit-testable without Miniflare, and the public `isEnabled`
// stays a thin adapter around KV-read-then-evaluate.

import type { FlagRule, FlagContext } from "./types";

/**
 * Evaluate a parsed feature-flag rule for the given context.
 *
 * The rule-evaluation must be deterministic and side-effect-free.
 * `flag` is used (together with the userId) as the stable bucketing
 * key for `rollout` mode, so the same user is not trivially either
 * in or out of every percentage rollout at once.
 *
 * The function is async only because `rollout` mode uses
 * `crypto.subtle.digest` — `always`, `never`, and `users` resolve
 * synchronously. Callers should `await` regardless for consistency.
 */
export async function evaluateRule(
  rule: FlagRule,
  ctx: FlagContext,
  flag = "",
): Promise<boolean> {
  switch (rule.mode) {
    case "always":
      return true;
    case "never":
      return false;
    case "users":
      return ctx.userId !== undefined && rule.users.includes(ctx.userId);
    case "rollout": {
      // Anonymous callers default out. Without a user id we would
      // have to bucket on e.g. the request IP, which then hides the
      // same user on different networks. Safer to just say no.
      if (ctx.userId === undefined) return false;
      // Fast paths — avoid a needless SHA-256 on every request when
      // the answer is constant.
      if (rule.rolloutPct <= 0) return false;
      if (rule.rolloutPct >= 100) return true;

      const bucket = await bucketFor(ctx.userId, flag);
      return bucket < rule.rolloutPct;
    }
  }
}

/**
 * Stable per-(user, flag) bucket in the range [0, 100).
 *
 * We hash with SHA-256 and take the first four bytes as a big-endian
 * uint32. Modulo 100 is biased in theory (2^32 is not divisible by
 * 100 so buckets 0..95 each receive one extra value out of 2^32), but
 * the bias is ~1e-8 — undetectable in any real rollout sample.
 */
async function bucketFor(userId: string, flag: string): Promise<number> {
  const encoded = new TextEncoder().encode(`${userId}:${flag}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  const asUint32 =
    ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return asUint32 % 100;
}
