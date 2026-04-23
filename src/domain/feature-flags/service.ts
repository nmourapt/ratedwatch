// Public feature-flag service. Reads a rule from KV, validates it,
// and evaluates it for the given context. Default to OFF on any
// failure: missing key, malformed JSON, or Zod-invalid value.
//
// The evaluator itself is pure (evaluator.ts); this module is only
// responsible for the KV read and the graceful-fallback contract.

import { evaluateRule } from "./evaluator";
import { ruleSchema, type FlagContext } from "./types";

export interface FeatureFlagsEnv {
  FLAGS: KVNamespace;
}

/**
 * Return true iff the feature flag is enabled for the given context.
 *
 * Default-off semantics — for any of these failure modes the caller
 * sees `false`, never an exception:
 *
 *   • KV key not set
 *   • KV value is not valid JSON
 *   • KV value fails schema validation
 *
 * The only thing a caller needs to handle is a KV-transport failure
 * (unreachable KV, timeout) which this function lets propagate; that
 * path is rare enough in practice that we'd rather see the error in
 * logs than silently feature-disable everyone.
 */
export async function isEnabled(
  flag: string,
  ctx: FlagContext,
  env: FeatureFlagsEnv,
): Promise<boolean> {
  const raw = await env.FLAGS.get(flag);
  if (raw === null) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Malformed JSON shouldn't happen in practice — the CLI validates
    // before writing — but we defensively swallow it so a hand-poked
    // KV entry can't take the feature down. Log so an operator can
    // see it in tail.
    console.warn(`feature-flags: malformed JSON for flag "${flag}":`, err);
    return false;
  }

  const result = ruleSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `feature-flags: schema validation failed for flag "${flag}":`,
      result.error.issues,
    );
    return false;
  }

  return evaluateRule(result.data, ctx, flag);
}
