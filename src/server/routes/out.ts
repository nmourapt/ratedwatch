// Outbound click-tracking redirects.
//
// Mounted at /out/*. Every CTA on the public pages that sends the
// visitor to a third-party site flows through here so we can count
// clicks in Analytics Engine — critical for revenue attribution once
// the Chrono24 affiliate wrapper lands in a future slice.
//
// Current surface:
//   GET /out/chrono24/:movementId
//     Logs a `chrono24_click` event and 302s to the Chrono24 search
//     URL for that movement's canonical caliber name.
//
// Unknown / pending movements return 404 — the same rule as /m/:id
// (see src/worker/index.tsx) so the public URL surface does not leak
// pending submissions.
//
// Responses carry Cache-Control: no-store because the redirect's
// purpose is to emit an analytics event; a cached 302 would silently
// skip the `logEvent` call.

import { Hono } from "hono";
import { createDb } from "@/db";
import { buildChrono24UrlForMovement } from "@/domain/chrono24-link";
import { createMovementTaxonomy } from "@/domain/movements/taxonomy";
import { logEvent } from "@/observability/events";

type Bindings = {
  DB: D1Database;
  ANALYTICS?: AnalyticsEngineDataset;
  [key: string]: unknown;
};

export const outRoute = new Hono<{ Bindings: Bindings }>();

outRoute.get("/chrono24/:movementId", async (c) => {
  const movementId = c.req.param("movementId");
  const db = createDb(c.env);
  const taxonomy = createMovementTaxonomy(db);
  const movement = await taxonomy.getBySlug(movementId);

  if (!movement || movement.status !== "approved") {
    // 404 so pending / unknown movements don't confirm their existence
    // to probers.
    return c.text("Not found", 404);
  }

  // Fire-and-forget event. logEvent catches internally, so a broken AE
  // binding won't stop the redirect from completing.
  await logEvent(
    "chrono24_click",
    { movementId: movement.id, canonical_name: movement.canonical_name },
    c.env,
  );

  const target = buildChrono24UrlForMovement({
    canonical_name: movement.canonical_name,
    manufacturer: movement.manufacturer,
    caliber: movement.caliber,
  }).toString();

  // no-store — we want every click to hit the Worker so the event fires.
  c.header("Cache-Control", "no-store");
  return c.redirect(target, 302);
});
