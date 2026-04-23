// Worker entry. Composes the Hono app from the route modules.
//
// Slice 4 adds the auth surface at /api/v1/auth/* (handed off to Better
// Auth verbatim) and the `requireAuth`-gated /api/v1/me endpoint. The
// landing page at `/` is unchanged from slice 3.
import { Hono } from "hono";
import { createDb } from "@/db";
import { queryLeaderboard } from "@/domain/leaderboard-query";
import { LandingPage } from "@/public/landing";
import { LeaderboardPage } from "@/public/leaderboard/page";
import { getAuth, type AuthEnv } from "@/server/auth";
import { leaderboardRoute } from "@/server/routes/leaderboard";
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

app.get("/", async (c) => {
  // Hero extension (slice #13): surface the top-5 verified watches so
  // first-time visitors see the social proof immediately. Falls back
  // to an empty-state card when nobody has crossed the threshold yet.
  const db = createDb(c.env);
  const topVerified = await queryLeaderboard({ verified_only: true, limit: 5 }, db);
  return c.html(<LandingPage topVerified={topVerified} />);
});

// Public HTML leaderboard. Owned by the Worker (see run_worker_first in
// wrangler.jsonc) rather than the SPA fallback, so crawlers + no-JS
// clients see the rendered markup. The page is cacheable for 5 minutes
// at the edge with a 24-hour SWR window — reading mutations purge it
// explicitly so first-time viewers never see a stale ranking for long.
app.get("/leaderboard", async (c) => {
  const db = createDb(c.env);
  const verifiedOnly = c.req.query("verified") === "1";
  const watches = await queryLeaderboard({ verified_only: verifiedOnly, limit: 50 }, db);
  c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
  return c.html(<LeaderboardPage watches={watches} verifiedOnly={verifiedOnly} />);
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
// Global leaderboard + per-movement leaderboard (filter via query param).
// Public — no auth middleware. See src/server/routes/leaderboard.ts.
app.route("/api/v1/leaderboard", leaderboardRoute);
// Readings live under two paths: nested under a watch for
// list/create, and flat at /api/v1/readings/:id for delete. Mount
// the nested route BEFORE /api/v1/watches so its requireAuth
// middleware doesn't catch anonymous GETs on public-watch readings.
app.route("/api/v1/watches/:watchId/readings", readingsByWatchRoute);
app.route("/api/v1/readings", readingsByIdRoute);
app.route("/api/v1/watches", watchesRoute);

export default app;
