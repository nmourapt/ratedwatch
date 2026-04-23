// Reusable ownership + lookup helper for watches. Every mutating
// watches route needs the same "fetch by id, 404 if missing, 403 if
// not owned by the caller" sequence — putting it here avoids copy-
// pasting the check across four handlers and keeps the authz rule
// a single testable unit.
//
// `assertWatchOwnership` intentionally returns a discriminated union
// instead of throwing so route handlers can map each state to the
// right HTTP status (404 vs 403) without try/catch plumbing.

import type { Kysely, Selectable } from "kysely";
import type { Database, WatchesTable } from "@/db/schema";

// The `Selectable<>` helper resolves `Generated<T>` columns to their
// runtime T — so on read, `is_public` is `number` and `created_at`
// is `string` without any unwrap ceremony at call sites.
export type Watch = Selectable<WatchesTable>;

export type WatchOwnershipResult =
  | { status: "ok"; watch: Watch }
  | { status: "not_found" }
  | { status: "forbidden"; watch: Watch };

/**
 * Look up a watch by id and decide whether `userId` may mutate it.
 *
 * Returns:
 *   - `{ status: "not_found" }` when the row does not exist.
 *   - `{ status: "forbidden", watch }` when the row exists but is not
 *     owned by the caller. The watch itself is returned so the caller
 *     could, in theory, decide to surface a "watch exists but isn't
 *     yours" message — the routes here still map it to 403.
 *   - `{ status: "ok", watch }` when the caller owns the row.
 */
export async function assertWatchOwnership(
  db: Kysely<Database>,
  watchId: string,
  userId: string,
): Promise<WatchOwnershipResult> {
  const watch = await db
    .selectFrom("watches")
    .selectAll()
    .where("id", "=", watchId)
    .executeTakeFirst();
  if (!watch) {
    return { status: "not_found" };
  }
  if (watch.user_id !== userId) {
    return { status: "forbidden", watch };
  }
  return { status: "ok", watch };
}
