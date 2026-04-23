// Watches CRUD. All mutating routes require a session; GET /:id is
// available anonymously for public watches so the future public watch
// page (slice #15) can share the same endpoint shape as the SPA.
//
// Shape conventions (matching src/server/routes/me.ts):
//   * 400 `{ error: "invalid_input", fieldErrors }` on Zod failure.
//   * 400 `{ error: "invalid_movement" }` when movement_id doesn't exist
//     or isn't visible to the caller (pending + not owned).
//   * 401 `{ error: "unauthorized" }` from the requireAuth middleware.
//   * 403 `{ error: "forbidden" }` when the caller isn't the owner.
//   * 404 `{ error: "not_found" }` when the id is unknown OR when an
//     anonymous/non-owner caller looks up a private watch (we don't
//     leak existence).
//
// Everything is typed through Kysely; no raw `db.prepare` escapes
// this module.

import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Database } from "@/db/schema";
import { createDb } from "@/db";
import {
  createWatchSchema,
  formatWatchErrors,
  updateWatchSchema,
  type WatchResponse,
} from "@/schemas/watch";
import { assertWatchOwnership, type Watch } from "@/domain/watches/ownership";
import { getAuth, type AuthEnv } from "@/server/auth";
import { requireAuth, type RequireAuthVariables } from "@/server/middleware/require-auth";

type Bindings = AuthEnv & {
  DB: D1Database;
  // R2 bucket used by the image-upload slice (#10). The delete handler
  // below no-ops against it for now — the `image_r2_key` column doesn't
  // exist yet, so we have nothing to address. Declared here so slice
  // #10 can hook in without another round of type surgery.
  IMAGES?: R2Bucket;
  [key: string]: unknown;
};

export const watchesRoute = new Hono<{
  Bindings: Bindings;
  Variables: RequireAuthVariables;
}>();

/**
 * Turn a DB row into the API response shape: flips `is_public` to a
 * boolean, joins the movement canonical name, and leaves everything
 * else untouched.
 */
function toResponse(watch: Watch, movementCanonicalName: string | null): WatchResponse {
  return {
    id: watch.id,
    user_id: watch.user_id,
    name: watch.name,
    brand: watch.brand,
    model: watch.model,
    movement_id: watch.movement_id,
    movement_canonical_name: movementCanonicalName,
    custom_movement_name: watch.custom_movement_name,
    notes: watch.notes,
    is_public: watch.is_public === 1,
    created_at: watch.created_at,
  };
}

/**
 * Fetch the movement canonical name for a watch's movement_id. Returns
 * null when the watch has no movement attached (slice #10 pending flow).
 */
async function resolveMovementName(
  db: Kysely<Database>,
  movementId: string | null,
): Promise<string | null> {
  if (!movementId) return null;
  const row = await db
    .selectFrom("movements")
    .select(["canonical_name"])
    .where("id", "=", movementId)
    .executeTakeFirst();
  return row?.canonical_name ?? null;
}

/**
 * Validate the client-supplied movement_id. It must exist AND be either
 * approved, or pending-and-owned-by-the-caller. Returns `true` on success,
 * or a JSON error body the handler should surface with 400.
 */
async function validateMovementAccess(
  db: Kysely<Database>,
  movementId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: { error: string } }> {
  const row = await db
    .selectFrom("movements")
    .select(["id", "status", "submitted_by_user_id"])
    .where("id", "=", movementId)
    .executeTakeFirst();
  if (!row) {
    return { ok: false, error: { error: "invalid_movement" } };
  }
  if (row.status === "approved") {
    return { ok: true };
  }
  // pending — only the submitter can attach it.
  if (row.status === "pending" && row.submitted_by_user_id === userId) {
    return { ok: true };
  }
  return { ok: false, error: { error: "invalid_movement" } };
}

/**
 * Public GET /:id — allowed anonymously for public watches. We wire it
 * BEFORE the blanket `requireAuth` middleware so it can resolve a
 * session if present but not demand one. The `.use("*", requireAuth)`
 * further down applies only to routes declared after it.
 */
watchesRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env);

  // Resolve session without forcing one; we need to know whether the
  // caller is the owner so private watches stay accessible to them.
  const auth = getAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const callerId = (session?.user as { id: string } | undefined)?.id ?? null;

  const watch = await db
    .selectFrom("watches")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!watch) {
    return c.json({ error: "not_found" }, 404);
  }
  const isOwner = callerId !== null && watch.user_id === callerId;
  const isPublic = watch.is_public === 1;
  if (!isPublic && !isOwner) {
    // Don't leak existence — 404 rather than 403.
    return c.json({ error: "not_found" }, 404);
  }

  const movementName = await resolveMovementName(db, watch.movement_id);
  return c.json(toResponse(watch, movementName));
});

// Everything after this line requires a session. GET /:id is already
// registered above and is not affected.
watchesRoute.use("*", requireAuth);

/**
 * GET /api/v1/watches — list the caller's own watches. Joins against
 * `movements` so the dashboard card headers render without a second
 * round-trip.
 */
watchesRoute.get("/", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);

  const rows = await db
    .selectFrom("watches")
    .leftJoin("movements", "movements.id", "watches.movement_id")
    .select([
      "watches.id",
      "watches.user_id",
      "watches.name",
      "watches.brand",
      "watches.model",
      "watches.movement_id",
      "watches.custom_movement_name",
      "watches.notes",
      "watches.is_public",
      "watches.created_at",
      "movements.canonical_name as movement_canonical_name",
    ])
    .where("watches.user_id", "=", user.id)
    .orderBy("watches.created_at", "desc")
    .execute();

  const watches = rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { movement_canonical_name, ...watch } = row;
    return toResponse(watch as Watch, movement_canonical_name ?? null);
  });

  return c.json({ watches });
});

/**
 * POST /api/v1/watches — create a new watch for the authed caller.
 */
watchesRoute.post("/", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = createWatchSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", fieldErrors: formatWatchErrors(parsed.error) },
      400,
    );
  }
  const input = parsed.data;

  // Movement must exist and be visible to the caller.
  const movementCheck = await validateMovementAccess(db, input.movement_id, user.id);
  if (!movementCheck.ok) {
    return c.json(movementCheck.error, 400);
  }

  const id = crypto.randomUUID();
  await db
    .insertInto("watches")
    .values({
      id,
      user_id: user.id,
      name: input.name,
      brand: input.brand ?? null,
      model: input.model ?? null,
      movement_id: input.movement_id,
      custom_movement_name: input.custom_movement_name ?? null,
      notes: input.notes ?? null,
      is_public: input.is_public ? 1 : 0,
      // created_at picks up the SQL DEFAULT. Kysely + kysely-d1 don't
      // mind missing columns that have defaults.
    })
    .execute();

  // Re-read the row (cheapest way to get the DEFAULT-populated
  // created_at plus the joined movement name in one shape).
  const created = await db
    .selectFrom("watches")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const movementName = await resolveMovementName(db, created.movement_id);

  return c.json(toResponse(created, movementName), 201);
});

/**
 * PATCH /api/v1/watches/:id — update owned watch.
 */
watchesRoute.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = createDb(c.env);

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = updateWatchSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", fieldErrors: formatWatchErrors(parsed.error) },
      400,
    );
  }
  const input = parsed.data;

  const ownership = await assertWatchOwnership(db, id, user.id);
  if (ownership.status === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (ownership.status === "forbidden") {
    return c.json({ error: "forbidden" }, 403);
  }

  // Validate movement_id only when the caller is actually changing it.
  if (input.movement_id && input.movement_id !== ownership.watch.movement_id) {
    const movementCheck = await validateMovementAccess(db, input.movement_id, user.id);
    if (!movementCheck.ok) {
      return c.json(movementCheck.error, 400);
    }
  }

  // Build the update set from only the fields the caller sent. Zod
  // already trimmed strings; we map empty-optional ("brand": "" after
  // trim) to null so the DB state stays consistent with "cleared".
  const patch: Partial<{
    name: string;
    brand: string | null;
    model: string | null;
    movement_id: string;
    custom_movement_name: string | null;
    notes: string | null;
    is_public: number;
  }> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.brand !== undefined) patch.brand = input.brand === "" ? null : input.brand;
  if (input.model !== undefined) patch.model = input.model === "" ? null : input.model;
  if (input.movement_id !== undefined) patch.movement_id = input.movement_id;
  if (input.custom_movement_name !== undefined) {
    patch.custom_movement_name =
      input.custom_movement_name === "" ? null : input.custom_movement_name;
  }
  if (input.notes !== undefined) patch.notes = input.notes === "" ? null : input.notes;
  if (input.is_public !== undefined) patch.is_public = input.is_public ? 1 : 0;

  if (Object.keys(patch).length > 0) {
    await db.updateTable("watches").set(patch).where("id", "=", id).execute();
  }

  const updated = await db
    .selectFrom("watches")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const movementName = await resolveMovementName(db, updated.movement_id);
  return c.json(toResponse(updated, movementName));
});

/**
 * DELETE /api/v1/watches/:id — destroy an owned watch.
 *
 * TODO(slice #10): the image-upload slice adds an `image_r2_key`
 * column. At that point we should also `await c.env.IMAGES?.delete(key)`
 * here before the DB delete so a deleted watch doesn't leave orphaned
 * R2 objects behind. The hook is left as a comment rather than a
 * no-op call so the follow-up is obvious at review time.
 */
watchesRoute.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = createDb(c.env);

  const ownership = await assertWatchOwnership(db, id, user.id);
  if (ownership.status === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (ownership.status === "forbidden") {
    return c.json({ error: "forbidden" }, 403);
  }

  await db.deleteFrom("watches").where("id", "=", id).execute();
  return c.body(null, 204);
});
