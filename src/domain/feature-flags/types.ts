// Feature-flag rule shapes and their Zod schema.
//
// Rules are stored in the `FLAGS` KV namespace as JSON under the flag
// name (e.g. KV key `verified_reading_cv` → value `{"mode":"always"}`).
// The Worker reads and validates with `ruleSchema` on every call to
// `isEnabled`; a missing or malformed value defaults to OFF so a
// broken KV entry cannot brick a production Worker.

import { z } from "zod";

export const ruleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("always") }),
  z.object({ mode: z.literal("never") }),
  z.object({
    mode: z.literal("users"),
    // We don't constrain the ids beyond non-empty to keep rollout
    // examples like the product's numeric / UUID user ids unchanged.
    users: z.array(z.string().min(1)),
  }),
  z.object({
    mode: z.literal("rollout"),
    // Percentage of the stable-hashed user population to include.
    // 0 → nobody, 100 → everybody with a userId. Fractional values
    // get rounded down by the bucket compare (`<`), which means 50.5
    // behaves identically to 50 — we therefore require ints.
    rolloutPct: z.number().int().min(0).max(100),
  }),
]);

export type FlagRule = z.infer<typeof ruleSchema>;

export interface FlagContext {
  /** The authenticated user's id, if any. Anonymous calls omit it. */
  userId?: string;
}
