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

// Tap-reading flow (new manual UX, replaces the typed-deviation form).
//
// The user looks at their watch, waits for the second hand to cross
// one of the four canonical dial positions (0 / 15 / 30 / 45, i.e.
// 12 / 3 / 6 / 9 o'clock), and taps the matching button the instant
// the hand lands on that mark. The server's own `Date.now()` at
// request receipt is the reference time — the client timestamp is
// deliberately NOT part of the wire contract so a client clock can't
// be spoofed.
//
// Granularity is 15 s by design; this isn't meant to replace the
// verified-reading (camera-based) flow for competitive rankings.
export const createTapReadingSchema = z.object({
  // The second-hand position the user saw at the moment of tap.
  // Constrained to the four canonical marks so deviation math stays
  // unambiguous (see the wrap logic in the route).
  dial_position: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)], {
    message: "dial_position must be one of 0, 15, 30, 45",
  }),
  is_baseline: z.boolean().default(false),
  notes: z
    .string()
    .trim()
    .max(NOTES_MAX, { message: `Notes must be ${NOTES_MAX} characters or fewer` })
    .optional(),
});

export type CreateTapReadingInput = z.infer<typeof createTapReadingSchema>;

// Slice #80 (PRD #73 User Story #10) — manual-with-photo readings.
//
// The flow: the SPA captured a photo, the dial-reader rejected it
// (unsupported_dial / low_confidence), the user clicked "Enter
// manually" and typed in HH:MM:SS. The endpoint persists a normal
// manual reading row (verified=0) but keeps the photo in R2 alongside
// it, so we have evidence even though the deviation came from the
// keyboard.
//
// HH/MM/SS are integers in the canonical 24h ranges. The route
// turns them into a wall-clock dial time of "today at HH:MM:SS in
// the reference clock's timezone" and computes deviation against
// the same EXIF-or-server-arrival reference timestamp used by the
// verified-reading flow (see verifier.ts).
export const createManualWithPhotoSchema = z.object({
  hh: z
    .number({ message: "hh is required" })
    .int({ message: "hh must be an integer" })
    .min(0, { message: "hh must be 0–23" })
    .max(23, { message: "hh must be 0–23" }),
  mm: z
    .number({ message: "mm is required" })
    .int({ message: "mm must be an integer" })
    .min(0, { message: "mm must be 0–59" })
    .max(59, { message: "mm must be 0–59" }),
  ss: z
    .number({ message: "ss is required" })
    .int({ message: "ss must be an integer" })
    .min(0, { message: "ss must be 0–59" })
    .max(59, { message: "ss must be 0–59" }),
  is_baseline: z.boolean().default(false),
  notes: z
    .string()
    .trim()
    .max(NOTES_MAX, { message: `Notes must be ${NOTES_MAX} characters or fewer` })
    .optional(),
});

export type CreateManualWithPhotoInput = z.infer<typeof createManualWithPhotoSchema>;

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
 * Flatten a Zod error from `createReadingSchema` or
 * `createTapReadingSchema` into a compact `{ field: message }`
 * record for inline form errors. Mirrors the formatWatchErrors
 * helper so the SPA can render failures the same way everywhere.
 *
 * Typed as `z.ZodError` (unparameterised) so it works for both
 * reading-schema variants without a generic on the call site.
 */
export function formatReadingErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in out)) {
      out[key] = issue.message;
    }
  }
  return out;
}
