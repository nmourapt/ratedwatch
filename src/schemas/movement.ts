// Shared Zod schemas for the movement-submission flow (slice #10).
// Imported by src/server/routes/movements.ts and the SPA's "submit a
// new movement" inline sub-form in src/app/watches/WatchForm.tsx so the
// two sides agree on validation + messages.
//
// Wire format:
//   * `canonical_name` is the user-facing display string ("Seiko NH36A").
//   * `manufacturer` + `caliber` drive the generated slug id on the
//     server side (kebab-case, matches the curated seed pattern).
//   * `type` is the movement CHECK-constraint enum from
//     migrations/0002_movements.sql.
//   * `notes` is optional, capped at 500 chars so the pending-review
//     queue stays scannable.

import { z } from "zod";

const CANONICAL_MAX = 100;
const MANUFACTURER_MAX = 50;
const CALIBER_MAX = 50;
const NOTES_MAX = 500;

export const submitMovementSchema = z.object({
  canonical_name: z
    .string({ message: "Display name is required" })
    .trim()
    .min(2, { message: "Display name must be at least 2 characters" })
    .max(CANONICAL_MAX, {
      message: `Display name must be ${CANONICAL_MAX} characters or fewer`,
    }),
  manufacturer: z
    .string({ message: "Manufacturer is required" })
    .trim()
    .min(1, { message: "Manufacturer is required" })
    .max(MANUFACTURER_MAX, {
      message: `Manufacturer must be ${MANUFACTURER_MAX} characters or fewer`,
    }),
  caliber: z
    .string({ message: "Caliber is required" })
    .trim()
    .min(1, { message: "Caliber is required" })
    .max(CALIBER_MAX, {
      message: `Caliber must be ${CALIBER_MAX} characters or fewer`,
    }),
  type: z.enum(["automatic", "manual", "quartz", "spring-drive", "other"], {
    message: "Pick a movement type",
  }),
  notes: z
    .string()
    .trim()
    .max(NOTES_MAX, { message: `Notes must be ${NOTES_MAX} characters or fewer` })
    .optional(),
});

export type SubmitMovementInput = z.infer<typeof submitMovementSchema>;

/**
 * Flatten a `z.ZodError` from `submitMovementSchema` into a
 * `{ field: string }` record, keyed by the top-level field name.
 * Matches the shape used by the watches + profile forms so the SPA
 * renders inline errors the same way for every mutation.
 */
export function formatSubmitMovementErrors(
  error: z.ZodError<SubmitMovementInput>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in out)) {
      out[key] = issue.message;
    }
  }
  return out;
}
