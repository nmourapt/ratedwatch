// Worker entry. Composes the Hono app from the route modules.
//
// Slice 4 adds the auth surface at /api/v1/auth/* (handed off to Better
// Auth verbatim) and the `requireAuth`-gated /api/v1/me endpoint. The
// landing page at `/` is unchanged from slice 3.
import { Hono } from "hono";
import { LandingPage } from "@/public/landing";
import { getAuth, type AuthEnv } from "@/server/auth";
import { watchImagePublicRoute, watchImageRoute } from "@/server/routes/images";
import { meRoute } from "@/server/routes/me";
import { movementsRoute } from "@/server/routes/movements";
import { readingsByIdRoute, readingsByWatchRoute } from "@/server/routes/readings";
import { watchesRoute } from "@/server/routes/watches";

// The Worker's full env extends the narrower AuthEnv used by getAuth.
type Bindings = AuthEnv & {
  // Keep the rest untyped here — the generated Cloudflare.Env
  // already provides full shape information for the other bindings
  // when a handler reaches for them.
  [key: string]: unknown;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => {
  return c.html(<LandingPage />);
});

// Better Auth owns every method under /api/v1/auth/*. We pass the raw
// Request straight through — Better Auth reads method, URL, headers,
// and body directly off it.
app.all("/api/v1/auth/*", (c) => {
  const auth = getAuth(c.env);
  return auth.handler(c.req.raw);
});

// App API surface. Currently the "who am I" probe used by the SPA's
// auth gate and the public movements taxonomy search (slice 7);
// later slices add watches/readings here.
app.route("/api/v1/me", meRoute);
app.route("/api/v1/movements", movementsRoute);
// Readings live under two paths: nested under a watch for
// list/create, and flat at /api/v1/readings/:id for delete. Mount
// the nested route BEFORE /api/v1/watches so its requireAuth
// middleware doesn't catch anonymous GETs on public-watch readings.
app.route("/api/v1/watches/:watchId/readings", readingsByWatchRoute);
// Slice 10: PUT/DELETE image on a watch. Same mount-before-watches
// rule so the nested :watchId param is bound before the blanket
// /api/v1/watches routes claim /:id.
app.route("/api/v1/watches/:watchId/image", watchImageRoute);
app.route("/api/v1/readings", readingsByIdRoute);
app.route("/api/v1/watches", watchesRoute);

// Public image-serving path. Sits OUTSIDE /api/v1 because the SPA's
// <img src> references it directly and a future CDN cache rule will
// key off the stable /images/* prefix.
app.route("/images/watches", watchImagePublicRoute);

export default app;
