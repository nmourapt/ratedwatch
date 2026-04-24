// Worker entry. Composes the Hono app from the route modules.
//
// Slice 4 adds the auth surface at /api/v1/auth/* (handed off to Better
// Auth verbatim) and the `requireAuth`-gated /api/v1/me endpoint. The
// landing page at `/` is unchanged from slice 3.
import { Hono } from "hono";
import { createDb } from "@/db";
import { queryLeaderboard } from "@/domain/leaderboard-query";
import { createMovementTaxonomy } from "@/domain/movements/taxonomy";
import { logEvent } from "@/observability/events";
import { captureException, withSentry } from "@/observability/sentry";
import { LandingPage } from "@/public/landing";
import { LeaderboardPage } from "@/public/leaderboard/page";
import { buildSetCookie, parseCookie } from "@/public/lib/cookie";
import { MovementNotFoundPage, MovementPage } from "@/public/movement/page";
import { loadPublicProfile } from "@/public/user/load";
import { UserNotFoundPage, UserPage } from "@/public/user/page";
import { loadPublicWatch } from "@/public/watch/load";
import { WatchNotFoundPage, WatchPage } from "@/public/watch/page";
import { getAuth, type AuthEnv } from "@/server/auth";
import { watchImagePublicRoute, watchImageRoute } from "@/server/routes/images";
import { leaderboardRoute } from "@/server/routes/leaderboard";
import { meRoute } from "@/server/routes/me";
import { movementsRoute } from "@/server/routes/movements";
import { outRoute } from "@/server/routes/out";
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

// Hono catches handler errors internally and returns 500 — the
// exception never reaches the outer fetch handler where
// Sentry.withSentry's auto-capture lives. Route Hono's onError hook
// through captureException so errors still land in Sentry with route
// context. Return the default 500 response afterwards (Hono's default
// behaviour) so we don't regress error responses.
app.onError((err, c) => {
  const user = (c.get as (k: string) => { id?: string } | undefined)("user");
  const flushPromise = captureException(err, {
    route: c.req.routePath ?? c.req.path,
    method: c.req.method,
    userId: user?.id ?? null,
  });
  // Defer Sentry's HTTP POST to after-response via waitUntil so the
  // user's 500 isn't blocked by Sentry ingestion latency, but the
  // Worker isolate stays alive long enough for Sentry's transport
  // to actually send. Without this, @sentry/cloudflare queues the
  // event internally but the Worker terminates before the outbound
  // request completes, silently dropping the event.
  if (flushPromise) {
    c.executionCtx.waitUntil(flushPromise);
  }
  return c.text("Internal Server Error", 500);
});

// ---- Verified-filter cookie helpers -------------------------------
//
// Public leaderboard pages remember the visitor's "Verified only"
// preference via a first-party cookie (`rw_verified_filter`). The
// resolution rules are:
//
//   1. If `?verified=1` or `?verified=0` is present → use it, and
//      set/clear the cookie so a follow-up plain visit remembers it.
//   2. Otherwise → fall back to the cookie value. Absent/anything
//      else → show all watches.
//
// Kept here rather than in a middleware because only two routes need
// it and factoring it out would make the Worker graph feel heavier
// than the value it provides.
const VERIFIED_COOKIE = "rw_verified_filter";
// 365 days — the "remember my preference" lifespan. Long enough to
// survive casual browsing resets; short enough to age out inactive
// profiles. Marketed copy below the toggle makes it clear.
const VERIFIED_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * Resolve the effective verified-only filter for a request. Returns
 * the boolean filter state plus, when a query param asked us to
 * change it, a Set-Cookie header string to stamp the preference.
 */
function resolveVerifiedFilter(req: Request): {
  verifiedOnly: boolean;
  setCookie: string | null;
} {
  const url = new URL(req.url);
  const rawQuery = url.searchParams.get("verified");
  const cookies = parseCookie(req.headers.get("cookie"));
  const cookieValue = cookies[VERIFIED_COOKIE];

  // Query param is explicit intent — trust it and update the cookie.
  if (rawQuery === "1") {
    return {
      verifiedOnly: true,
      setCookie: buildSetCookie({
        name: VERIFIED_COOKIE,
        value: "1",
        maxAge: VERIFIED_COOKIE_MAX_AGE,
      }),
    };
  }
  if (rawQuery === "0") {
    return {
      verifiedOnly: false,
      setCookie: buildSetCookie({
        name: VERIFIED_COOKIE,
        value: "",
        maxAge: 0,
      }),
    };
  }

  // No query param — read the cookie only. Never write in this path
  // so crawlers hitting bare URLs don't get set-cookie noise.
  return { verifiedOnly: cookieValue === "1", setCookie: null };
}

app.get("/", async (c) => {
  // Hero extension (slice #13): surface the top-5 verified watches so
  // first-time visitors see the social proof immediately. Falls back
  // to an empty-state card when nobody has crossed the threshold yet.
  const db = createDb(c.env);
  const topVerified = await queryLeaderboard({ verified_only: true, limit: 5 }, db);
  await logEvent("page_view_home", {}, c.env);
  return c.html(<LandingPage topVerified={topVerified} />);
});

// Public HTML leaderboard. Owned by the Worker (see run_worker_first in
// wrangler.jsonc) rather than the SPA fallback, so crawlers + no-JS
// clients see the rendered markup. The page is cacheable for 5 minutes
// at the edge with a 24-hour SWR window — reading mutations purge it
// explicitly so first-time viewers never see a stale ranking for long.
app.get("/leaderboard", async (c) => {
  const db = createDb(c.env);
  const { verifiedOnly, setCookie } = resolveVerifiedFilter(c.req.raw);
  const watches = await queryLeaderboard({ verified_only: verifiedOnly, limit: 50 }, db);
  await logEvent("page_view_leaderboard", { verifiedOnly }, c.env);
  // Cookie-toggled responses are unique per preference, so drop the
  // shared-cache directive when we're setting/clearing the cookie.
  if (setCookie) {
    c.header("Set-Cookie", setCookie);
    c.header("Cache-Control", "private, no-store");
    await logEvent("leaderboard_filter_changed", { verifiedOnly }, c.env);
  } else {
    c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
  }
  return c.html(<LeaderboardPage watches={watches} verifiedOnly={verifiedOnly} />);
});

// Public per-movement leaderboard (slice #14). 404 for unknown or
// still-pending movements so the URL surface never leaks unapproved
// submissions. Same cache header as the global page — reading
// mutations explicitly purge both.
app.get("/m/:movementId", async (c) => {
  const db = createDb(c.env);
  const taxonomy = createMovementTaxonomy(db);
  const movement = await taxonomy.getBySlug(c.req.param("movementId"));
  if (!movement || movement.status !== "approved") {
    return c.html(<MovementNotFoundPage />, 404);
  }
  const { verifiedOnly, setCookie } = resolveVerifiedFilter(c.req.raw);
  const watches = await queryLeaderboard(
    { movement_id: movement.id, verified_only: verifiedOnly, limit: 50 },
    db,
  );
  if (setCookie) {
    c.header("Set-Cookie", setCookie);
    c.header("Cache-Control", "private, no-store");
    await logEvent("leaderboard_filter_changed", { verifiedOnly }, c.env);
  } else {
    c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
  }
  return c.html(
    <MovementPage movement={movement} watches={watches} verifiedOnly={verifiedOnly} />,
  );
});

// Public user profile (slice #15). Case-insensitive lookup: a
// non-canonical URL (e.g. /u/Alice when the canonical form is
// /u/alice) 301-redirects to the lowercased form so shares + crawlers
// converge on one URL. Unknown usernames render a 404 page.
app.get("/u/:username", async (c) => {
  const db = createDb(c.env);
  const raw = c.req.param("username");
  const result = await loadPublicProfile(db, raw);
  if (result.status === "redirect") {
    return c.redirect(`/u/${result.canonical_username}`, 301);
  }
  if (result.status === "not_found") {
    return c.html(<UserNotFoundPage username={raw} />, 404);
  }
  c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
  return c.html(<UserPage profile={result.profile} />);
});

// Public per-watch page (slice #15). 404s for unknown AND private
// watches — loadPublicWatch deliberately collapses both states to one
// response so the existence of private rows isn't leaked.
app.get("/w/:watchId", async (c) => {
  const db = createDb(c.env);
  const watchId = c.req.param("watchId");
  const result = await loadPublicWatch(db, watchId);
  if (result.status === "not_found") {
    return c.html(<WatchNotFoundPage watchId={watchId} />, 404);
  }
  c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
  return c.html(<WatchPage data={result.data} />);
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

// Outbound click-tracking redirects — /out/chrono24/:movementId and
// friends. See src/server/routes/out.ts. Owned by the Worker (see
// `/out/*` in run_worker_first / wrangler.jsonc) so each click emits
// an Analytics Engine event before the 302.
app.route("/out", outRoute);

// Wrap the Hono app so Sentry auto-captures unhandled exceptions.
// With SENTRY_DSN set as a Worker secret, every throw in any handler
// above shows up in Sentry with request/response context. Without the
// secret, withSentry returns a passthrough so local dev and anonymous
// previews still boot. The Worker runtime only sees the exported
// `fetch` shape — no Hono-specific methods need to be preserved on
// the default export.
const sentryWrappedHandler: ExportedHandler<Bindings> = withSentry({
  fetch: app.fetch.bind(app),
});
export default sentryWrappedHandler;
