// Integration tests for slice 14: per-movement leaderboard (/m/:id)
// and GET /api/v1/movements/:id/leaderboard.
//
// Seeds two approved movements + one pending movement, a few watches
// per movement, and enough readings to make each watch eligible. Then
// asserts:
//   * The public HTML page only shows watches on THIS movement.
//   * The JSON API shape matches /api/v1/leaderboard.
//   * Pending / unknown movement ids return 404.
//   * The page surfaces a Chrono24 link pointing at chrono24.com with
//     the movement's canonical name as the query.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";

const DAY_MS = 24 * 60 * 60 * 1000;
const runId = crypto.randomUUID().slice(0, 8);
const id = (suffix: string) => `mlb-${runId}-${suffix}`;

const SEED = {
  users: {
    owner1: {
      id: id("user-1"),
      name: "Mlb One",
      email: `${id("u1")}@test`,
      username: id("u-one"),
    },
    owner2: {
      id: id("user-2"),
      name: "Mlb Two",
      email: `${id("u2")}@test`,
      username: id("u-two"),
    },
  },
  movements: {
    alpha: {
      id: id("mov-alpha"),
      canonical_name: `ETA ${id("ALPHA").toUpperCase()}`,
      manufacturer: "ETA",
      caliber: id("ALPHA"),
      status: "approved",
      type: "automatic",
    },
    beta: {
      id: id("mov-beta"),
      canonical_name: `Seiko ${id("BETA").toUpperCase()}`,
      manufacturer: "Seiko",
      caliber: id("BETA"),
      status: "approved",
      type: "automatic",
    },
    pending: {
      id: id("mov-pending"),
      canonical_name: `Proto ${id("PEND").toUpperCase()}`,
      manufacturer: "Proto",
      caliber: id("PEND"),
      status: "pending",
      type: "automatic",
    },
  },
  watches: {
    alphaFast: {
      id: id("w-alpha-fast"),
      name: "Alpha Fast",
      brand: "Rolex",
      model: "ALPHAFAST",
      movement_id: "alpha",
      is_public: 1,
    },
    alphaSlow: {
      id: id("w-alpha-slow"),
      name: "Alpha Slow",
      brand: "Omega",
      model: "ALPHASLOW",
      movement_id: "alpha",
      is_public: 1,
    },
    betaOnly: {
      id: id("w-beta"),
      name: "Beta Only",
      brand: "Seiko",
      model: "BETAONLY",
      movement_id: "beta",
      is_public: 1,
    },
  },
};

async function seed() {
  const db = (env as unknown as { DB: D1Database }).DB;
  const now = Date.now();

  for (const u of Object.values(SEED.users)) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO user (id, name, email, emailVerified, username, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)",
      )
      .bind(
        u.id,
        u.name,
        u.email,
        u.username,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      )
      .run();
  }

  for (const m of Object.values(SEED.movements)) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(m.id, m.canonical_name, m.manufacturer, m.caliber, m.type, m.status, null)
      .run();
  }

  const movByKey: Record<string, string> = {
    alpha: SEED.movements.alpha.id,
    beta: SEED.movements.beta.id,
  };
  const watchUserMap: Record<string, string> = {
    alphaFast: SEED.users.owner1.id,
    alphaSlow: SEED.users.owner2.id,
    betaOnly: SEED.users.owner1.id,
  };
  for (const [key, w] of Object.entries(SEED.watches)) {
    const userId = watchUserMap[key]!;
    await db
      .prepare(
        "INSERT OR IGNORE INTO watches (id, user_id, name, brand, model, movement_id, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(w.id, userId, w.name, w.brand, w.model, movByKey[w.movement_id]!, w.is_public)
      .run();
  }

  // Readings — each watch gets baseline + 2 readings over 14 days so
  // all three qualify for the leaderboard (≥7 days, ≥3 readings).
  // alphaFast: drift 0.5 s/d (rank 1 on alpha)
  // alphaSlow: drift -2.0 s/d (rank 2 on alpha)
  // betaOnly:  drift 1.0 s/d (only watch on beta)
  const base = now;
  type R = {
    watch: keyof typeof SEED.watches;
    user: keyof typeof SEED.users;
    t_offset_days: number;
    deviation: number;
    baseline?: boolean;
  };
  const readings: R[] = [
    {
      watch: "alphaFast",
      user: "owner1",
      t_offset_days: 0,
      deviation: 0,
      baseline: true,
    },
    { watch: "alphaFast", user: "owner1", t_offset_days: 7, deviation: 3.5 },
    { watch: "alphaFast", user: "owner1", t_offset_days: 14, deviation: 7 },
    {
      watch: "alphaSlow",
      user: "owner2",
      t_offset_days: 0,
      deviation: 0,
      baseline: true,
    },
    { watch: "alphaSlow", user: "owner2", t_offset_days: 7, deviation: -14 },
    { watch: "alphaSlow", user: "owner2", t_offset_days: 14, deviation: -28 },
    { watch: "betaOnly", user: "owner1", t_offset_days: 0, deviation: 0, baseline: true },
    { watch: "betaOnly", user: "owner1", t_offset_days: 7, deviation: 7 },
    { watch: "betaOnly", user: "owner1", t_offset_days: 14, deviation: 14 },
  ];

  for (const r of readings) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO readings (id, watch_id, user_id, reference_timestamp, deviation_seconds, is_baseline, verified) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id(`r-${r.watch}-${r.t_offset_days}`),
        SEED.watches[r.watch].id,
        SEED.users[r.user].id,
        base + r.t_offset_days * DAY_MS,
        r.deviation,
        r.baseline ? 1 : 0,
        0,
      )
      .run();
  }
}

beforeAll(async () => {
  await seed();
});

// ---- JSON API /api/v1/movements/:id/leaderboard -------------------

describe("GET /api/v1/movements/:id/leaderboard", () => {
  it("returns 200 JSON with only watches on the requested movement", async () => {
    const res = await exports.default.fetch(
      new Request(
        `https://ratedwatch.test/api/v1/movements/${SEED.movements.alpha.id}/leaderboard`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watches: Array<{ watch_id: string }> };
    const ids = body.watches.map((w) => w.watch_id);
    expect(ids).toContain(SEED.watches.alphaFast.id);
    expect(ids).toContain(SEED.watches.alphaSlow.id);
    expect(ids).not.toContain(SEED.watches.betaOnly.id);
  });

  it("returns the same envelope shape as the global leaderboard", async () => {
    const res = await exports.default.fetch(
      new Request(
        `https://ratedwatch.test/api/v1/movements/${SEED.movements.beta.id}/leaderboard`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      watches: Array<{
        watch_id: string;
        movement_id: string;
        session_stats: { eligible: boolean };
      }>;
    };
    expect(Array.isArray(body.watches)).toBe(true);
    expect(body.watches.length).toBeGreaterThan(0);
    // Every row is on the requested movement.
    for (const w of body.watches) {
      expect(w.movement_id).toBe(SEED.movements.beta.id);
    }
  });

  it("returns 404 for a pending movement", async () => {
    const res = await exports.default.fetch(
      new Request(
        `https://ratedwatch.test/api/v1/movements/${SEED.movements.pending.id}/leaderboard`,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown movement id", async () => {
    const res = await exports.default.fetch(
      new Request(
        "https://ratedwatch.test/api/v1/movements/does-not-exist-slug/leaderboard",
      ),
    );
    expect(res.status).toBe(404);
  });
});

// ---- Public HTML page /m/:id --------------------------------------

describe("GET /m/:movementId — public HTML", () => {
  it("returns 200 text/html with the movement canonical name in the page", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/m/${SEED.movements.alpha.id}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain(SEED.movements.alpha.canonical_name);
  });

  it("only lists watches on the requested movement", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/m/${SEED.movements.alpha.id}`),
    );
    const body = await res.text();
    // alpha watches present
    expect(body).toContain(SEED.watches.alphaFast.model);
    expect(body).toContain(SEED.watches.alphaSlow.model);
    // beta watch NOT present
    expect(body).not.toContain(SEED.watches.betaOnly.model);
  });

  it("emits a Chrono24 CTA that routes through the click-tracked /out redirect", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/m/${SEED.movements.alpha.id}`),
    );
    const body = await res.text();
    // The CTA routes through /out/chrono24/:movementId so each click
    // emits a `chrono24_click` Analytics Engine event before the 302
    // to Chrono24 itself. See src/server/routes/out.ts.
    expect(body).toContain(`/out/chrono24/${SEED.movements.alpha.id}`);
    // Security hardening on the anchor: noopener + new tab.
    expect(body).toMatch(/target="_blank"/);
    expect(body).toMatch(/rel="[^"]*noopener[^"]*"/);
    // And the raw Chrono24 URL is no longer embedded on the page —
    // users always go through the tracked redirect.
    expect(body).not.toMatch(/https:\/\/www\.chrono24\.com\/search\/index\.htm\?query=/);
  });

  it("includes the movement-specific OG title and description", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/m/${SEED.movements.alpha.id}`),
    );
    const body = await res.text();
    expect(body).toContain(
      `Most accurate ${SEED.movements.alpha.canonical_name} watches — rated.watch`,
    );
    expect(body).toContain(
      `Drift rate leaderboard for the ${SEED.movements.alpha.canonical_name} ${SEED.movements.alpha.type} movement.`,
    );
  });

  it("emits the aggressive Cache-Control header", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/m/${SEED.movements.alpha.id}`),
    );
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toMatch(/s-maxage=300/);
    expect(cacheControl).toMatch(/stale-while-revalidate=86400/);
  });

  it("returns 404 HTML for a pending movement", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/m/${SEED.movements.pending.id}`),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
  });

  it("returns 404 HTML for an unknown movement id", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/m/no-such-movement-slug"),
    );
    expect(res.status).toBe(404);
  });

  it("emits zero client-side JavaScript", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/m/${SEED.movements.alpha.id}`),
    );
    const body = await res.text();
    expect(body).not.toMatch(/<script\b/i);
  });

  it("links back to the global leaderboard", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/m/${SEED.movements.alpha.id}`),
    );
    const body = await res.text();
    expect(body).toMatch(/href="\/leaderboard"/);
  });
});
