// Shared helpers for validating a caller-supplied rule at the edge
// (admin CLI today; possibly an admin-UI route later). Both entry
// points need to reject bad input with the exact same rules the
// runtime evaluator uses, so the Zod schema is the single source of
// truth.

import { ruleSchema } from "./types";

/**
 * Parse + validate a rule JSON string. Returns the canonicalised JSON
 * (re-serialised from the parsed value, so whitespace / quoting noise
 * is stripped) plus the parsed rule itself.
 *
 * Throws a readable `Error` on:
 *   • invalid JSON syntax
 *   • schema mismatch (unknown mode, out-of-range rolloutPct, etc.)
 */
export function parseRuleJson(raw: string): {
  rule: import("./types").FlagRule;
  canonicalJson: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `rule JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = ruleSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`rule failed schema validation:\n${issues}`);
  }

  return { rule: result.data, canonicalJson: JSON.stringify(result.data) };
}
