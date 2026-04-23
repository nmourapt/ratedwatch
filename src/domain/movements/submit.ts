// Movement-submission domain module (slice #10).
//
// Input: validated SubmitMovementInput (from src/schemas/movement.ts)
// + the submitting user's id.
//
// Output: a discriminated result that the HTTP layer maps to 201 / 200
// / 409:
//
//   * "created"             → new pending row inserted.
//   * "exists_approved"     → the generated slug already exists and is
//                              approved. The route maps this to 409 so
//                              the SPA can auto-select the approved row
//                              instead of duplicating the request.
//   * "exists_pending_own"  → the same user re-submitted (same slug,
//                              still pending, still theirs). Idempotent
//                              200 with the existing row.
//
// `exists_pending_other` (slug clash with another user's pending row)
// is an edge case that slice #10 treats the same as "created" for that
// other user — in practice the slug is deterministic from
// `<manufacturer>-<caliber>`, and allowing two pending rows with the
// same slug is forbidden by the PK. We therefore also cover it as
// "exists_approved" semantics: another user's pending row means the
// caller should use it by id, so we surface the same 409 shape. Note
// expanded in mapResult below.

import type { Kysely } from "kysely";
import type { Database } from "@/db/schema";
import type { Movement } from "./taxonomy";
import type { SubmitMovementInput } from "@/schemas/movement";

const MOVEMENT_COLUMNS = [
  "id",
  "canonical_name",
  "manufacturer",
  "caliber",
  "type",
  "status",
  "notes",
] as const;

export type SubmitMovementResult =
  | { status: "created"; movement: Movement }
  | { status: "exists_approved"; movement: Movement }
  | { status: "exists_pending_own"; movement: Movement }
  | { status: "exists_pending_other"; movement: Movement };

/**
 * Generate a kebab-case slug from `<manufacturer>-<caliber>`. Matches
 * the pattern used by the seed fixture (`eta-2892-a2`, `seiko-nh35`):
 *
 *   * Lower-cased.
 *   * Spaces + underscores + slashes collapsed into single dashes.
 *   * Non-[a-z0-9-] characters dropped.
 *   * Leading/trailing dashes trimmed.
 *   * Consecutive dashes collapsed.
 *
 * Exported (unprefixed) so tests can assert the contract directly
 * without spinning up the full submit pipeline.
 */
export function generateMovementSlug(manufacturer: string, caliber: string): string {
  const raw = `${manufacturer}-${caliber}`;
  return raw
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toMovement(row: {
  id: string;
  canonical_name: string;
  manufacturer: string;
  caliber: string;
  type: Movement["type"];
  status: Movement["status"];
  notes: string | null;
}): Movement {
  return {
    id: row.id,
    canonical_name: row.canonical_name,
    manufacturer: row.manufacturer,
    caliber: row.caliber,
    type: row.type,
    status: row.status,
    notes: row.notes,
  };
}

/**
 * Submit a user-proposed movement. Idempotent when the same user
 * re-submits the same slug (returns the existing pending row). When
 * the slug collides with an approved row, the approved row is
 * returned — the caller should use it by id rather than duplicating.
 *
 * The function does NOT validate input — callers are expected to run
 * it through `submitMovementSchema` first.
 */
export async function submitMovement(
  db: Kysely<Database>,
  input: SubmitMovementInput,
  submittingUserId: string,
): Promise<SubmitMovementResult> {
  const id = generateMovementSlug(input.manufacturer, input.caliber);

  // Look up first so the happy path for an idempotent re-submit and
  // the collision path both stay cheap. D1 is a single-writer SQLite
  // instance — the race between this SELECT and the INSERT is
  // vanishingly small, and on conflict the INSERT's PK violation would
  // surface as an error which we retry-read below.
  const existing = await db
    .selectFrom("movements")
    .select([...MOVEMENT_COLUMNS, "submitted_by_user_id"])
    .where("id", "=", id)
    .executeTakeFirst();

  if (existing) {
    const movement = toMovement(existing);
    if (existing.status === "approved") {
      return { status: "exists_approved", movement };
    }
    // status === "pending"
    if (existing.submitted_by_user_id === submittingUserId) {
      return { status: "exists_pending_own", movement };
    }
    return { status: "exists_pending_other", movement };
  }

  try {
    await db
      .insertInto("movements")
      .values({
        id,
        canonical_name: input.canonical_name,
        manufacturer: input.manufacturer,
        caliber: input.caliber,
        type: input.type,
        status: "pending",
        submitted_by_user_id: submittingUserId,
        notes: input.notes ?? null,
        // `MovementsTable.created_at` is `string`, not `Generated<string>`,
        // even though the SQL column has a DEFAULT. Supply one explicitly
        // to keep the insert type-check clean without having to mutate
        // the shared schema module (which is Worker J's lane).
        created_at: new Date().toISOString(),
      })
      .execute();
  } catch (err) {
    // Lost the race with another INSERT of the same slug. Re-read and
    // classify based on the current row state so the caller still
    // gets a deterministic result.
    const row = await db
      .selectFrom("movements")
      .select([...MOVEMENT_COLUMNS, "submitted_by_user_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      // Truly unexpected — re-throw so it surfaces as a 500.
      throw err;
    }
    const movement = toMovement(row);
    if (row.status === "approved") {
      return { status: "exists_approved", movement };
    }
    if (row.submitted_by_user_id === submittingUserId) {
      return { status: "exists_pending_own", movement };
    }
    return { status: "exists_pending_other", movement };
  }

  const created = await db
    .selectFrom("movements")
    .select([...MOVEMENT_COLUMNS])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

  return { status: "created", movement: toMovement(created) };
}
