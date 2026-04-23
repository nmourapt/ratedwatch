// Shared Zod schemas for watch CRUD. Imported by the API routes in
// src/server/routes/watches.ts and the SPA add/edit forms so the two
// sides agree on validation rules and error messages.
//
// Wire format:
//   * `is_public` is a boolean (flipped to 0/1 at the DB boundary).
//   * `movement_id` is the movements.id slug ("eta-2892-a2",
//     "seiko-nh35"). The route validates that it exists + is allowed
//     (approved OR pending-and-owned-by-the-authed-user).
//   * All free-text fields are trimmed; max lengths match reasonable
//     UI affordances and guard against pathological inputs.

import { z } from "zod";

const NAME_MAX = 100;
const MODEL_MAX = 100;
const NOTES_MAX = 1000;

// Reused across create + update so a later switch to a single
// "upsert"-style handler stays trivial. Partial() on update keeps
// every field optional.
export const createWatchSchema = z.object({
  name: z
    .string({ message: "Name is required" })
    .trim()
    .min(1, { message: "Name is required" })
    .max(NAME_MAX, { message: `Name must be ${NAME_MAX} characters or fewer` }),
  brand: z
    .string()
    .trim()
    .max(NAME_MAX, { message: `Brand must be ${NAME_MAX} characters or fewer` })
    .optional(),
  model: z
    .string()
    .trim()
    .max(MODEL_MAX, { message: `Model must be ${MODEL_MAX} characters or fewer` })
    .optional(),
  movement_id: z
    .string({ message: "Movement is required" })
    .trim()
    .min(1, { message: "Movement is required" }),
  custom_movement_name: z
    .string()
    .trim()
    .max(NAME_MAX, {
      message: `Custom movement name must be ${NAME_MAX} characters or fewer`,
    })
    .optional(),
  notes: z
    .string()
    .trim()
    .max(NOTES_MAX, { message: `Notes must be ${NOTES_MAX} characters or fewer` })
    .optional(),
  is_public: z.boolean().default(true),
});

export type CreateWatchInput = z.infer<typeof createWatchSchema>;

export const updateWatchSchema = createWatchSchema.partial();
export type UpdateWatchInput = z.infer<typeof updateWatchSchema>;

// Response shape returned by the watches API. Joined against
// `movements` so the SPA never has to issue a second request to
// surface the caliber name in a card header.
export const watchResponseSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  movement_id: z.string().nullable(),
  movement_canonical_name: z.string().nullable(),
  custom_movement_name: z.string().nullable(),
  notes: z.string().nullable(),
  is_public: z.boolean(),
  created_at: z.string(),
  // Slice 10 (issue #11). Non-null when the watch has a photo in R2;
  // the SPA keys its uploader UI off this flag (present → show
  // /images/watches/:id + delete button, absent → show uploader).
  image_r2_key: z.string().nullable(),
});

export type WatchResponse = z.infer<typeof watchResponseSchema>;

/**
 * Flatten a `z.ZodError` from `createWatchSchema` / `updateWatchSchema`
 * into a `{ field: string }` record, keyed by the top-level field
 * name. Matches the shape used by the profile form so the SPA can
 * render inline errors the same way for every mutation.
 */
export function formatWatchErrors(
  error: z.ZodError<CreateWatchInput | UpdateWatchInput>,
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
