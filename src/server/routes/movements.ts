// GET /api/v1/movements?q=<query>&limit=<n>
// POST /api/v1/movements (authed)
//
// The GET surface is public and consumed by:
//   * the add-watch typeahead in the SPA (PRD slice 8)
//   * future public browse pages
//
// The POST surface is authed and lets a user submit a new pending
// movement when their watch's caliber isn't in the curated list
// (slice #10). Response envelope is always `{ approved, suggestions }`
// so the SPA can render both in the same dropdown.
//
// Auth detection for GET is best-effort: if a session exists we enrich
// the response with the caller's own pending rows in `suggestions[]`;
// if not, we quietly return an empty suggestions array and carry on.
// Any auth error here (cookie rot, provider config hiccup) is isolated
// from the anonymous fast path so a broken session never takes the
// typeahead offline.

import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "@/db";
import { queryLeaderboard } from "@/domain/leaderboard-query";
import { createMovementTaxonomy } from "@/domain/movements/taxonomy";
import { submitMovement } from "@/domain/movements/submit";
import { logEvent } from "@/observability/events";
import { formatSubmitMovementErrors, submitMovementSchema } from "@/schemas/movement";
import { getAuth, type AuthEnv } from "@/server/auth";
import { requireAuth, type RequireAuthVariables } from "@/server/middleware/require-auth";

type Bindings = AuthEnv & {
  DB: D1Database;
  // Analytics Engine (slice #19). Optional — logEvent handles absence.
  ANALYTICS?: AnalyticsEngineDataset;
  [key: string]: unknown;
};

const movementsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Shared query schema for the per-movement leaderboard JSON endpoint.
// Mirrors the shape of the global leaderboard query — same caps, same
// boolean coercion rules — so the SPA can compose both endpoints with
// identical client code.
const perMovementLeaderboardQuerySchema = z.object({
  verified_only: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const movementsRoute = new Hono<{
  Bindings: Bindings;
  Variables: RequireAuthVariables;
}>();

movementsRoute.get("/", async (c) => {
  const parsed = movementsQuerySchema.safeParse({
    q: c.req.query("q"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
  }

  const { q, limit } = parsed.data;
  // No query → empty list. The typeahead mounts before the user types,
  // and we don't want an accidental blanket dump of all ~100 rows.
  if (!q) {
    return c.json({ approved: [], suggestions: [] });
  }

  // Best-effort session read. The GET endpoint is public, but an authed
  // caller sees their own pending submissions in `suggestions[]`. We
  // swallow any error here so a broken cookie doesn't take the
  // anonymous path offline.
  let submittingUserId: string | undefined;
  try {
    const auth = getAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    submittingUserId = (session?.user as { id: string } | undefined)?.id;
  } catch {
    submittingUserId = undefined;
  }

  const db = createDb(c.env);
  const taxonomy = createMovementTaxonomy(db);
  const result = await taxonomy.search(q, {
    limit,
    suggestionsForUserId: submittingUserId,
  });
  return c.json(result);
});

// GET /api/v1/movements/:id/leaderboard — public, unauthed. Delegates
// to queryLeaderboard with a movement_id filter. Returns 404 when
// the movement is unknown or still pending; the public URL surface
// must not leak pending submissions.
movementsRoute.get("/:id/leaderboard", async (c) => {
  const movementId = c.req.param("id");
  const parsed = perMovementLeaderboardQuerySchema.safeParse({
    verified_only: c.req.query("verified_only"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
  }
  const { verified_only, limit, offset } = parsed.data;

  const db = createDb(c.env);
  const taxonomy = createMovementTaxonomy(db);
  const movement = await taxonomy.getBySlug(movementId);
  if (!movement || movement.status !== "approved") {
    return c.json({ error: "movement_not_found" }, 404);
  }

  const watches = await queryLeaderboard(
    { movement_id: movement.id, verified_only, limit, offset },
    db,
  );
  return c.json({ watches });
});

// POST is authed. Mounted after GET so the public search stays open.
movementsRoute.post("/", requireAuth, async (c) => {
  const user = c.get("user");

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const parsed = submitMovementSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", fieldErrors: formatSubmitMovementErrors(parsed.error) },
      400,
    );
  }

  const db = createDb(c.env);
  const result = await submitMovement(db, parsed.data, user.id);

  switch (result.status) {
    case "created":
      // Product telemetry (slice #19). Only emit on a genuinely new
      // submission — `exists_*` branches are either idempotent
      // re-submits or collisions, neither of which represent
      // intent-to-add.
      await logEvent(
        "movement_suggested",
        { userId: user.id, movementId: result.movement.id },
        c.env,
      );
      return c.json({ movement: result.movement }, 201);
    case "exists_pending_own":
      // Idempotent re-submit — same user, same slug, still pending.
      return c.json({ movement: result.movement }, 200);
    case "exists_approved":
      // The slug already exists as an approved row. Surface it so the
      // SPA can auto-select it instead of duplicating the submission.
      return c.json(
        {
          error: "movement_exists_approved",
          id: result.movement.id,
          canonical_name: result.movement.canonical_name,
          movement: result.movement,
        },
        409,
      );
    case "exists_pending_other":
      // Slug clashes with another user's pending row. Treat the same
      // as an approved collision from the caller's perspective — they
      // should use the existing row by id rather than duplicate.
      return c.json(
        {
          error: "movement_exists_pending",
          id: result.movement.id,
          canonical_name: result.movement.canonical_name,
          movement: result.movement,
        },
        409,
      );
  }
});
