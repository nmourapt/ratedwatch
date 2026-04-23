// Shared Zod schemas for the readings surface. Imported by the API
// route (src/server/routes/readings.ts) and (later) by the SPA form
// that logs manual readings so the two sides agree on the wire
// contract.
//
// Ubiquitous language (AGENTS.md):
//   * `reference_timestamp` — unix milliseconds the watch was read
//     against.
//   * `deviation_seconds` — signed seconds the watch is ahead (+) or
//     behind (−). Forced to 0 server-side when is_baseline=true.
//   * `is_baseline` — marks the start of a new tracking session.
//
// The route is responsible for the `is_baseline ⇒ deviation = 0`
// rule so a client that sends a stale deviation on a baseline reading
// gets corrected rather than rejected.

import { z } from "zod";

const NOTES_MAX = 500;

export const createReadingSchema = z.object({
  reference_timestamp: z
    .number({ message: "reference_timestamp is required" })
    .int({ message: "reference_timestamp must be an integer" })
    .positive({ message: "reference_timestamp must be positive (unix ms)" }),
  deviation_seconds: z
    .number({ message: "deviation_seconds is required" })
    .finite({ message: "deviation_seconds must be a finite number" }),
  is_baseline: z.boolean().default(false),
  notes: z
    .string()
    .trim()
    .max(NOTES_MAX, { message: `Notes must be ${NOTES_MAX} characters or fewer` })
    .optional(),
});

export type CreateReadingInput = z.infer<typeof createReadingSchema>;

// Wire shape returned by the readings API. Flattens the DB row's
// 0/1 booleans to real booleans and leaves everything else as-is.
export const readingResponseSchema = z.object({
  id: z.string(),
  watch_id: z.string(),
  user_id: z.string(),
  reference_timestamp: z.number(),
  deviation_seconds: z.number(),
  is_baseline: z.boolean(),
  verified: z.boolean(),
  notes: z.string().nullable(),
  created_at: z.string(),
});

export type ReadingResponse = z.infer<typeof readingResponseSchema>;

/**
 * Flatten a Zod error from `createReadingSchema` into a compact
 * `{ field: message }` record for inline form errors. Mirrors the
 * formatWatchErrors helper so the SPA can render failures the same
 * way everywhere.
 */
export function formatReadingErrors(
  error: z.ZodError<CreateReadingInput>,
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
