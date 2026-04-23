// Slice 11 (issue #12). End-to-end behaviour of the per-watch
// `is_public` toggle. The PATCH endpoint itself already accepts the
// field (slice #9); this file exercises the user-visible consequence:
//
//   * Private watches are hidden from /api/v1/leaderboard (and the
//     public HTML page that composes the same query).
//   * Flipping back to public restores the watch.
//   * Non-owners still get 403 on PATCH (sanity check — keeps us
//     honest when refactoring the handler).
//
// We seed a watch via the real POST endpoint and readings directly
// into D1 (same pattern as tests/integration/leaderboard.test.ts)
// because the leaderboard query needs a 7-day, 3-reading session —
// easier to fabricate with fixed timestamps than to work around the
// API's reading cadence rules.
//
// NOTE: the "private watch → /w/:id returns 404" assertion from the
// issue body is deferred to slice #15 (the public watch page doesn't
// exist on main yet). Once that page lands, add the assertion here.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";

const approvedMovementId = "test-vis-mov";
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      approvedMovementId,
      "Test ETA (visibility)",
      "ETA",
      "2824-vis",
      "automatic",
      "approved",
      null,
    )
    .run();
});

// ---- Auth / fetch helpers (same shape as watches.test.ts) ---------

function makeEmail(): string {
  return `vis-${crypto.randomUUID()}@ratedwatch.test`;
}

async function signUp(email: string, password: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: email.split("@")[0]!, email, password }),
    }),
  );
}

async function signIn(email: string, password: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

interface TestUser {
  cookie: string;
  userId: string;
  username: string;
}

async function registerAndGetCookie(): Promise<TestUser> {
  const email = makeEmail();
  const password = "correct-horse-42";
  const reg = await signUp(email, password);
  expect(reg.status).toBe(200);
  const regBody = (await reg.json()) as {
    user: { id: string; username: string };
  };
  const loginRes = await signIn(email, password);
  expect(loginRes.status).toBe(200);
  const rawCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(";")[0] ?? "";
  return { cookie, userId: regBody.user.id, username: regBody.user.username };
}

async function createWatch(body: unknown, cookie: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/watches", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}

async function patchWatch(id: string, body: unknown, cookie: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}

async function getLeaderboardIds(verifiedOnly = false): Promise<string[]> {
  const qs = verifiedOnly ? "?verified_only=1&limit=200" : "?limit=200";
  const res = await exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/leaderboard${qs}`),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { watches: Array<{ watch_id: string }> };
  return body.watches.map((w) => w.watch_id);
}

/**
 * Seed 3 readings across 14 days so the watch clears the leaderboard
 * eligibility gate (≥ 7 days session, ≥ 3 readings). Written directly
 * to D1 because the readings API enforces cadence rules that would
 * make a multi-day session tedious to construct.
 */
async function seedEligibleReadings(watchId: string, userId: string): Promise<void> {
  const db = (env as unknown as { DB: D1Database }).DB;
  const now = Date.now();
  const readings: Array<{ t: number; dev: number; baseline: 0 | 1 }> = [
    { t: 0, dev: 0, baseline: 1 },
    { t: 7, dev: 3.5, baseline: 0 },
    { t: 14, dev: 7, baseline: 0 },
  ];
  for (const r of readings) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO readings (id, watch_id, user_id, reference_timestamp, deviation_seconds, is_baseline, verified) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `vis-r-${watchId}-${r.t}`,
        watchId,
        userId,
        now + r.t * DAY_MS,
        r.dev,
        r.baseline,
        0,
      )
      .run();
  }
}

interface WatchBody {
  id: string;
  is_public: boolean;
}

const TWO_USER_TIMEOUT = 30_000;

// ---- Tests ---------------------------------------------------------

describe("Watch visibility toggle (slice #11)", () => {
  it("flipping a public watch to private removes it from the leaderboard", async () => {
    const owner = await registerAndGetCookie();
    const create = await createWatch(
      {
        name: "Flip to Private",
        brand: "VisTest",
        model: "Priv-001",
        movement_id: approvedMovementId,
        is_public: true,
      },
      owner.cookie,
    );
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as WatchBody;
    await seedEligibleReadings(id, owner.userId);

    // Sanity: public + eligible → visible.
    expect(await getLeaderboardIds()).toContain(id);

    // Flip to private via PATCH.
    const patch = await patchWatch(id, { is_public: false }, owner.cookie);
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as WatchBody;
    expect(patchBody.is_public).toBe(false);

    // No longer ranked.
    expect(await getLeaderboardIds()).not.toContain(id);
  });

  it("flipping a private watch back to public restores leaderboard presence", async () => {
    const owner = await registerAndGetCookie();
    const create = await createWatch(
      {
        name: "Toggle to Public",
        brand: "VisTest",
        model: "Pub-002",
        movement_id: approvedMovementId,
        is_public: false,
      },
      owner.cookie,
    );
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as WatchBody;
    await seedEligibleReadings(id, owner.userId);

    // Sanity: private → hidden.
    expect(await getLeaderboardIds()).not.toContain(id);

    // Flip to public.
    const patch = await patchWatch(id, { is_public: true }, owner.cookie);
    expect(patch.status).toBe(200);

    // Now ranked.
    expect(await getLeaderboardIds()).toContain(id);
  });

  it(
    "non-owner cannot flip is_public (403)",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const create = await createWatch(
        {
          name: "Hands off",
          movement_id: approvedMovementId,
          is_public: true,
        },
        owner.cookie,
      );
      const { id } = (await create.json()) as WatchBody;

      const res = await patchWatch(id, { is_public: false }, other.cookie);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");
    },
    TWO_USER_TIMEOUT,
  );
});
