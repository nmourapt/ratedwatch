// GET /api/v1/movements?q=<query>&limit=<n>
//
// Public, unauthenticated endpoint used by:
//   * the add-watch typeahead in the SPA (PRD slice 8)
//   * future public browse pages
//
// Always returns `{ approved, suggestions }` — the latter is an empty
// array until slice #10 wires up user-submitted pending movements.
// Keeping the envelope stable from day one avoids a breaking shape
// change when suggestions start landing.

import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "@/db";
import { createMovementTaxonomy } from "@/domain/movements/taxonomy";

type Bindings = { DB: D1Database; [key: string]: unknown };

const movementsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const movementsRoute = new Hono<{ Bindings: Bindings }>();

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

  const db = createDb(c.env);
  const taxonomy = createMovementTaxonomy(db);
  const result = await taxonomy.search(q, { limit });
  return c.json(result);
});
