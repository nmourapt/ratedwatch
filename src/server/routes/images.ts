// Watch image upload + serving (slice #10, issue #11).
//
// Two things live here because they share knowledge of the R2 key
// format and the same content-type whitelist:
//
//   * `watchImageRoute` — PUT + DELETE under
//     /api/v1/watches/:watchId/image. Authed + owner-only. Stores the
//     upload at `watches/{id}/image` with its contentType preserved on
//     R2's httpMetadata, and writes the key back to
//     watches.image_r2_key.
//
//   * `watchImagePublicRoute` — GET /images/watches/:id. Public for
//     public watches (with long cache headers), owner-only for private
//     ones (short private cache). Non-owners of a private watch get
//     404, not 401, so the surface doesn't leak whether the watch or
//     its image exists.
//
// The 5 MB size cap + the allow-list of content types are enforced
// here and mirrored in the integration tests (watch-images.test.ts).
// Clients send multipart/form-data with a single field named `image`.
//
// Shape conventions (matches src/server/routes/watches.ts):
//   * 400 `{ error: "invalid_input" }` when the form doesn't include
//     an `image` file part.
//   * 401 `{ error: "unauthorized" }` from requireAuth.
//   * 403 `{ error: "forbidden" }` for non-owner writes.
//   * 404 `{ error: "not_found" }` for unknown or private-without-
//     owner lookups.
//   * 413 `{ error: "payload_too_large" }` when the upload exceeds
//     MAX_IMAGE_BYTES.
//   * 415 `{ error: "unsupported_media_type" }` when the content-type
//     is not in ALLOWED_IMAGE_TYPES.

import { Hono } from "hono";
import { createDb } from "@/db";
import { assertWatchOwnership } from "@/domain/watches/ownership";
import { getAuth, type AuthEnv } from "@/server/auth";
import { requireAuth, type RequireAuthVariables } from "@/server/middleware/require-auth";

// 5 MB per the issue ACs. Enforced on the File.size because miniflare
// materialises the whole body into memory for multipart parsing
// anyway; a streaming cap wouldn't buy us anything here.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Content-type allow-list from the issue. HEIC is included so iOS
// uploads don't need a client-side convert in this slice.
export const ALLOWED_IMAGE_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
];

/** R2 key layout for a watch's single photo. */
function keyForWatch(watchId: string): string {
  return `watches/${watchId}/image`;
}

type Bindings = AuthEnv & {
  DB: D1Database;
  WATCH_IMAGES: R2Bucket;
  [key: string]: unknown;
};

// -------------------------------------------------------------------
// Authed: PUT / DELETE /api/v1/watches/:watchId/image
// -------------------------------------------------------------------

export const watchImageRoute = new Hono<{
  Bindings: Bindings;
  Variables: RequireAuthVariables;
}>();

watchImageRoute.use("*", requireAuth);

watchImageRoute.put("/", async (c) => {
  const user = c.get("user");
  const watchId = c.req.param("watchId");
  if (!watchId) {
    return c.json({ error: "not_found" }, 404);
  }
  const db = createDb(c.env);

  // Ownership first — no point parsing a 5 MB body if the caller
  // isn't allowed to write.
  const ownership = await assertWatchOwnership(db, watchId, user.id);
  if (ownership.status === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (ownership.status === "forbidden") {
    return c.json({ error: "forbidden" }, 403);
  }

  // Parse multipart. Hono re-exposes the runtime FormData parser.
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "invalid_input" }, 400);
  }
  const file = form.get("image");
  if (!(file instanceof File)) {
    return c.json(
      { error: "invalid_input", fieldErrors: { image: "File is required" } },
      400,
    );
  }

  const contentType = (file.type || "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
    return c.json({ error: "unsupported_media_type" }, 415);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: "payload_too_large" }, 413);
  }

  const key = keyForWatch(watchId);
  const bytes = await file.arrayBuffer();
  const put = await c.env.WATCH_IMAGES.put(key, bytes, {
    httpMetadata: { contentType },
  });

  await db
    .updateTable("watches")
    .set({ image_r2_key: key })
    .where("id", "=", watchId)
    .execute();

  return c.json({ ok: true, key, etag: put.httpEtag });
});

watchImageRoute.delete("/", async (c) => {
  const user = c.get("user");
  const watchId = c.req.param("watchId");
  if (!watchId) {
    return c.json({ error: "not_found" }, 404);
  }
  const db = createDb(c.env);

  const ownership = await assertWatchOwnership(db, watchId, user.id);
  if (ownership.status === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (ownership.status === "forbidden") {
    return c.json({ error: "forbidden" }, 403);
  }

  const key = ownership.watch.image_r2_key ?? keyForWatch(watchId);
  try {
    await c.env.WATCH_IMAGES.delete(key);
  } catch (err) {
    // Non-fatal: the DB state is what the rest of the app keys off
    // of. Log and proceed. Swallowing keeps a transient R2 glitch
    // from blocking the user's "remove my photo" action.
    console.error("images: R2 delete failed", { key, err });
  }

  await db
    .updateTable("watches")
    .set({ image_r2_key: null })
    .where("id", "=", watchId)
    .execute();

  return c.body(null, 204);
});

// -------------------------------------------------------------------
// Public: GET /images/watches/:id
// -------------------------------------------------------------------

export const watchImagePublicRoute = new Hono<{ Bindings: Bindings }>();

watchImagePublicRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env);

  // Resolve session without forcing one. Matches the pattern used
  // by the public GET /api/v1/watches/:id route.
  const auth = getAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const callerId = (session?.user as { id: string } | undefined)?.id ?? null;

  const watch = await db
    .selectFrom("watches")
    .select(["user_id", "is_public", "image_r2_key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!watch || !watch.image_r2_key) {
    return c.body(null, 404);
  }
  const isOwner = callerId !== null && watch.user_id === callerId;
  const isPublic = watch.is_public === 1;
  if (!isPublic && !isOwner) {
    // 404 rather than 401/403 — we don't want anonymous probes to
    // distinguish "this private watch exists and has a photo" from
    // "there's nothing here".
    return c.body(null, 404);
  }

  const object = await c.env.WATCH_IMAGES.get(watch.image_r2_key);
  if (!object) {
    return c.body(null, 404);
  }

  const headers = new Headers();
  headers.set(
    "content-type",
    object.httpMetadata?.contentType ?? "application/octet-stream",
  );
  if (object.httpEtag) {
    headers.set("etag", object.httpEtag);
  }
  headers.set(
    "cache-control",
    isPublic
      ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
      : "private, max-age=300",
  );
  return new Response(object.body, { status: 200, headers });
});
