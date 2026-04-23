// GET /api/v1/leaderboard
//
// Public (no auth) JSON surface the SPA and future native app consume
// when they want the current rankings. All the real work lives in the
// leaderboard-query domain module; this file is just a thin validation
// + marshalling layer.
//
// Query params (all optional, all validated with Zod):
//   * movement_id    — narrow to one caliber (reused by /m/:id pages)
//   * verified_only  — "1" | "true" → require verified_badge
//   * limit          — 1..200, default 50
//   * offset         — 0+, default 0
//
// Response envelope:
//   { watches: RankedWatch[] }
//
// `total` is intentionally absent from the default response — paginating
// a ranked list doesn't need a total count to render the "next" link,
// and computing it would force the expensive drift pass to run against
// every candidate just to count them. If we end up needing a total for
// the SPA's infinite scroll we can add it behind a `?include_total=1`
// opt-in.

import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "@/db";
import { queryLeaderboard } from "@/domain/leaderboard-query";

type Bindings = { DB: D1Database; [key: string]: unknown };

// Zod coerces incoming query-string scalars to their typed shape. Booleans
// accept the two wire conventions we already use elsewhere ("1" and
// "true") so the SPA can pass whichever is handier.
const leaderboardQuerySchema = z.object({
  movement_id: z.string().trim().min(1).max(200).optional(),
  verified_only: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const leaderboardRoute = new Hono<{ Bindings: Bindings }>();

leaderboardRoute.get("/", async (c) => {
  const parsed = leaderboardQuerySchema.safeParse({
    movement_id: c.req.query("movement_id"),
    verified_only: c.req.query("verified_only"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
  }
  const { movement_id, verified_only, limit, offset } = parsed.data;

  const db = createDb(c.env);
  const watches = await queryLeaderboard(
    { movement_id, verified_only, limit, offset },
    db,
  );
  return c.json({ watches });
});
