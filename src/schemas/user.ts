// Shared Zod schemas for user-profile mutations. Imported by both the
// API route (src/server/routes/me.ts) and the SPA settings form
// (src/app/pages/SettingsPage.tsx) so the two sides always agree on
// the validation rules — the PRD and AGENTS.md both require Zod as the
// source of truth at every boundary.
//
// Error messages are written as human-readable strings rather than
// the default Zod codes so they can be surfaced in the UI verbatim.

import { z } from "zod";

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]+$/;
const NO_EDGE_DOT_DASH = /^[^.-].*[^.-]$|^[^.-]$/;

// PATCH /api/v1/me accepts a partial profile update — the caller may
// change `username`, `consent_corpus`, or both in a single request.
// Both fields are optional individually, but a refinement at the
// bottom of the schema enforces that at least ONE field is present
// (an empty PATCH body is rejected with 400 invalid_input). This
// mirrors the original `{ username }`-only contract: a request with
// nothing to do is a programmer error and we want a clear 400 over
// a silent no-op success.
export const updateMeSchema = z
  .object({
    username: z
      .string({ message: "Username is required" })
      .trim()
      .min(2, { message: "Username must be 2–30 characters" })
      .max(30, { message: "Username must be 2–30 characters" })
      .regex(USERNAME_REGEX, {
        message: "Only letters, numbers, `_`, `.`, `-`",
      })
      .regex(NO_EDGE_DOT_DASH, {
        message: "No leading/trailing dot or dash",
      })
      .optional(),
    // Slice #81 (PRD #73): per-user opt-in to corpus collection.
    // Boolean on the wire so the SPA toggle code path is intuitive;
    // the route maps it onto the SQLite INTEGER 0/1 column.
    consent_corpus: z.boolean({ message: "consent_corpus must be a boolean" }).optional(),
  })
  .refine((data) => data.username !== undefined || data.consent_corpus !== undefined, {
    message: "At least one of username or consent_corpus must be provided",
    path: ["username"],
  });

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

/**
 * Flatten a `z.ZodError` from `updateMeSchema` into a `{ field: string }`
 * record keyed by field name, picking the first error per field. Used
 * by the route handler to return a compact, UI-friendly error shape
 * and by the SPA form to render inline errors beneath each input.
 */
export function formatUpdateMeErrors(
  error: z.ZodError<UpdateMeInput>,
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
