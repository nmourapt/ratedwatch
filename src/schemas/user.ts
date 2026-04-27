// Shared Zod schemas for user-profile mutations. Imported by both the
// API route (src/server/routes/me.ts) and the SPA settings form
// (src/app/pages/SettingsPage.tsx) so the two sides always agree on
// the validation rules — the PRD and AGENTS.md both require Zod as the
// source of truth at every boundary.
//
// Error messages are written as human-readable strings rather than
// the default Zod codes so they can be surfaced in the UI verbatim.
//
// Slice #80 (PRD #73 User Stories #13-#16) added the corpus-consent
// toggle. Both fields are optional in the schema — a PATCH carrying
// only `username` or only `consent_corpus` is valid; the route only
// updates whichever fields the caller sent. The empty-object case
// (`{}`) is rejected at the route layer.

import { z } from "zod";

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]+$/;
const NO_EDGE_DOT_DASH = /^[^.-].*[^.-]$|^[^.-]$/;

export const updateMeSchema = z.object({
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
  consent_corpus: z.boolean({ message: "consent_corpus must be a boolean" }).optional(),
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
