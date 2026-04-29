// Worker entry. Composes the Hono app from the route modules.
//
// Slice 4 adds the auth surface at /api/v1/auth/* (handed off to Better
// Auth verbatim) and the `requireAuth`-gated /api/v1/me endpoint. The
// landing page at `/` is unchanged from slice 3.
import { Container } from "@cloudflare/containers";
import { env as workerEnv } from "cloudflare:workers";
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
import {
  resolvePublicSession,
  type PublicSessionUser,
} from "@/public/auth/resolve-session";
import { loadPublicWatch } from "@/public/watch/load";
import { WatchNotFoundPage, WatchPage } from "@/public/watch/page";
import { getAuth, type AuthEnv } from "@/server/auth";
import { watchImagePublicRoute, watchImageRoute } from "@/server/routes/images";
import { leaderboardRoute } from "@/server/routes/leaderboard";
import { meRoute } from "@/server/routes/me";
import { movementsRoute } from "@/server/routes/movements";
import { outRoute } from "@/server/routes/out";
import { readingsByIdRoute, readingsByWatchRoute } from "@/server/routes/readings";
import { seoRoute } from "@/server/routes/seo";
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

/**
 * Cache-Control picker for session-aware public pages.
 *
 * Anonymous visitors get the old `public, s-maxage=300,
 * stale-while-revalidate=86400` — CF edge caches the rendered HTML
 * so repeat anonymous hits are served without reaching the Worker.
 *
 * Signed-in visitors get `private, max-age=0, must-revalidate` —
 * the personalised `@username` in the header makes the HTML unique
 * per session, and a shared public cache would poison responses
 * for subsequent viewers (first signed-in view would be cached and
 * served to everyone).
 *
 * Both branches emit `Vary: Cookie` unconditionally. Browser (per-
 * device) caches honour it today: after a user signs out, their
 * local cache won't replay the personalised HTML because the Cookie
 * header that keyed the stored response is no longer on the request.
 *
 * The matching CF edge cache-rule that would let the shared edge
 * keep caching signed-in HTML (keyed on the session cookie) is
 * intentionally deferred — it needs real-traffic validation and
 * Terraform infra work. Emitting the header now means that future
 * rule can be layered on without re-touching this helper.
 */
function applyPublicCacheHeader(
  c: { header: (name: string, value: string) => void },
  user: PublicSessionUser | null,
): void {
  c.header("Vary", "Cookie");
  if (user) {
    c.header("Cache-Control", "private, max-age=0, must-revalidate");
    return;
  }
  c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
}

app.get("/", async (c) => {
  // Hero extension (slice #13): surface the top-5 verified watches so
  // first-time visitors see the social proof immediately. Falls back
  // to an empty-state card when nobody has crossed the threshold yet.
  const db = createDb(c.env);
  const user = await resolvePublicSession(c.env, c.req.raw);
  const topVerified = await queryLeaderboard({ verified_only: true, limit: 5 }, db);
  await logEvent("page_view_home", {}, c.env);
  applyPublicCacheHeader(c, user);
  return c.html(<LandingPage topVerified={topVerified} user={user} />);
});

// Public HTML leaderboard. Owned by the Worker (see run_worker_first in
// wrangler.jsonc) rather than the SPA fallback, so crawlers + no-JS
// clients see the rendered markup. The page is cacheable for 5 minutes
// at the edge with a 24-hour SWR window — reading mutations purge it
// explicitly so first-time viewers never see a stale ranking for long.
app.get("/leaderboard", async (c) => {
  const db = createDb(c.env);
  const user = await resolvePublicSession(c.env, c.req.raw);
  const { verifiedOnly, setCookie } = resolveVerifiedFilter(c.req.raw);
  const watches = await queryLeaderboard({ verified_only: verifiedOnly, limit: 50 }, db);
  await logEvent("page_view_leaderboard", { verifiedOnly }, c.env);
  // Session-aware pages can't share a public cache entry (the header
  // personalises). `applyPublicCacheHeader` picks private-no-cache
  // for signed-in callers and the usual public SWR window otherwise.
  // Filter-cookie toggles (setCookie) still take the no-store path
  // because the Set-Cookie side-effect must not be shared either.
  if (setCookie) {
    c.header("Set-Cookie", setCookie);
    // no-store is correct here (the Set-Cookie side-effect must not
    // be shared), but the Vary: Cookie contract still applies so
    // browser caches differentiate a subsequent signed-out replay.
    c.header("Vary", "Cookie");
    c.header("Cache-Control", "private, no-store");
    await logEvent("leaderboard_filter_changed", { verifiedOnly }, c.env);
  } else {
    applyPublicCacheHeader(c, user);
  }
  return c.html(
    <LeaderboardPage watches={watches} verifiedOnly={verifiedOnly} user={user} />,
  );
});

// Public per-movement leaderboard (slice #14). 404 for unknown or
// still-pending movements so the URL surface never leaks unapproved
// submissions. Same cache header as the global page — reading
// mutations explicitly purge both.
app.get("/m/:movementId", async (c) => {
  const db = createDb(c.env);
  const user = await resolvePublicSession(c.env, c.req.raw);
  const taxonomy = createMovementTaxonomy(db);
  const movement = await taxonomy.getBySlug(c.req.param("movementId"));
  if (!movement || movement.status !== "approved") {
    applyPublicCacheHeader(c, user);
    return c.html(<MovementNotFoundPage user={user} />, 404);
  }
  const { verifiedOnly, setCookie } = resolveVerifiedFilter(c.req.raw);
  const watches = await queryLeaderboard(
    { movement_id: movement.id, verified_only: verifiedOnly, limit: 50 },
    db,
  );
  if (setCookie) {
    c.header("Set-Cookie", setCookie);
    // See /leaderboard above — same reasoning for keeping the
    // Vary: Cookie contract on the no-store branch.
    c.header("Vary", "Cookie");
    c.header("Cache-Control", "private, no-store");
    await logEvent("leaderboard_filter_changed", { verifiedOnly }, c.env);
  } else {
    applyPublicCacheHeader(c, user);
  }
  return c.html(
    <MovementPage
      movement={movement}
      watches={watches}
      verifiedOnly={verifiedOnly}
      user={user}
    />,
  );
});

// Public user profile (slice #15). Case-insensitive lookup: a
// non-canonical URL (e.g. /u/Alice when the canonical form is
// /u/alice) 301-redirects to the lowercased form so shares + crawlers
// converge on one URL. Unknown usernames render a 404 page.
app.get("/u/:username", async (c) => {
  const db = createDb(c.env);
  const user = await resolvePublicSession(c.env, c.req.raw);
  const raw = c.req.param("username");
  const result = await loadPublicProfile(db, raw);
  if (result.status === "redirect") {
    return c.redirect(`/u/${result.canonical_username}`, 301);
  }
  if (result.status === "not_found") {
    applyPublicCacheHeader(c, user);
    return c.html(<UserNotFoundPage username={raw} user={user} />, 404);
  }
  applyPublicCacheHeader(c, user);
  return c.html(<UserPage profile={result.profile} user={user} />);
});

// Public per-watch page (slice #15). 404s for unknown AND private
// watches — loadPublicWatch deliberately collapses both states to one
// response so the existence of private rows isn't leaked.
app.get("/w/:watchId", async (c) => {
  const db = createDb(c.env);
  const user = await resolvePublicSession(c.env, c.req.raw);
  const watchId = c.req.param("watchId");
  const result = await loadPublicWatch(db, watchId);
  if (result.status === "not_found") {
    applyPublicCacheHeader(c, user);
    return c.html(<WatchNotFoundPage watchId={watchId} user={user} />, 404);
  }
  applyPublicCacheHeader(c, user);
  return c.html(<WatchPage data={result.data} user={user} />);
});

// SEO plumbing — /robots.txt + /sitemap.xml. Owned by the Worker so
// crawlers see the real responses (not the SPA fallback HTML). The
// sub-app declares both bare-path routes; mounting at "/" makes them
// reachable at their advertised URLs.
app.route("/", seoRoute);

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

// CV-based dial reader container. Registered as a Durable Object
// (container-enabled DOs are SQLite-backed — see
// `migrations.new_sqlite_classes` in wrangler.jsonc). The Worker
// reaches it via the `DIAL_READER` binding using
// `getContainer(env.DIAL_READER, "global").fetch(req)` from
// src/domain/dial-reader/.
//
// `defaultPort = 8080` matches the uvicorn `--port 8080` in the
// container's CMD; `sleepAfter = "15m"` keeps a warm instance for
// the 15-minute window where the verified-reading flow is most
// likely to see repeat hits, then lets the runtime reclaim memory.
//
// Slice #74 scaffolded the container, slice #75 wired it into the
// verified-reading flow, and slice #11 (cutover) made it the sole
// dial-reader backend. The CV pipeline is gated by the
// `verified_reading_cv` feature flag (renamed from the legacy
// `ai_reading_v2` in slice #11; the backward-compat fallback that
// read the legacy key during the rollover window was removed in
// the post-cutover cleanup PR).
//
// Slice #83 of PRD #73 added the `envVars` block so the container
// receives `SENTRY_DSN` at startup. We pull from the Worker's
// process-level `env` (via `cloudflare:workers`) rather than from
// the per-request `Bindings`-typed env because envVars must be
// resolvable when the Container DO instantiates — which can happen
// before the first fetch. When SENTRY_DSN is unset on the Worker
// the field is `undefined`; `sentry_init.init(None)` handles that
// as a no-op so the container still boots cleanly in previews
// without the secret provisioned.
export class DialReaderContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = "15m";
  override envVars = {
    // Reading the secret here lets the container init Sentry with
    // the same DSN the Worker uses, so Worker errors and Python
    // errors land in the same project (with `runtime` tags
    // distinguishing them).
    //
    // ESLint forbids non-null assertion below; the literal `?? ""`
    // is fine because `sentry_init.init` short-circuits on empty.
    SENTRY_DSN: (workerEnv as { SENTRY_DSN?: string }).SENTRY_DSN ?? "",
  };
}

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
