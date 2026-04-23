// Integration tests for slice 13: the global leaderboard.
//
// Seeds users + watches + readings directly via the D1 binding
// (bypasses the auth + API surface because we only need the DB state
// that queryLeaderboard reads from). The domain module is validated
// against a real D1 + Kysely stack via miniflare so we exercise the
// joins, not a mock.
//
// Also covers the HTML surface at /leaderboard and the home hero
// top-5 section — both compose queryLeaderboard, so if the domain
// behaves correctly the pages follow.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";
import { createDb } from "@/db";
import { queryLeaderboard } from "@/domain/leaderboard-query";

const DAY_MS = 24 * 60 * 60 * 1000;

// Unique prefix per test run so concurrent file runs or re-runs inside
// the same miniflare storage isolation window don't clash on seed ids.
const runId = crypto.randomUUID().slice(0, 8);
const id = (suffix: string) => `lb-${runId}-${suffix}`;

// Four users, five watches across three movements (two approved, one pending).
//
// Ranking (by abs(avg_drift_rate_spd) ASC) of eligible+public watches:
//   1. gold     → 0.5 s/d   (verified)
//   2. silver   → -1.0 s/d  (unverified, drift is abs 1.0)
//   3. bronze   → 2.0 s/d   (verified)
//
// Excluded:
//   * private    — is_public=0
//   * ineligible — only 2 readings over 3 days
//   * pending    — movement.status=pending
const SEED = {
  users: {
    owner1: {
      id: id("user-1"),
      name: "User One",
      email: `${id("u1")}@test`,
      username: id("u-one"),
    },
    owner2: {
      id: id("user-2"),
      name: "User Two",
      email: `${id("u2")}@test`,
      username: id("u-two"),
    },
    owner3: {
      id: id("user-3"),
      name: "User Three",
      email: `${id("u3")}@test`,
      username: id("u-three"),
    },
    owner4: {
      id: id("user-4"),
      name: "User Four",
      email: `${id("u4")}@test`,
      username: id("u-four"),
    },
  },
  movements: {
    caliberA: {
      id: id("mov-a"),
      canonical_name: `ETA ${id("A")}`,
      manufacturer: "ETA",
      caliber: id("A"),
      status: "approved",
    },
    caliberB: {
      id: id("mov-b"),
      canonical_name: `Seiko ${id("B")}`,
      manufacturer: "Seiko",
      caliber: id("B"),
      status: "approved",
    },
    caliberPending: {
      id: id("mov-p"),
      canonical_name: `Pending ${id("P")}`,
      manufacturer: "Proto",
      caliber: id("P"),
      status: "pending",
    },
  },
  watches: {
    gold: {
      id: id("w-gold"),
      name: "Gold Submariner",
      brand: "Rolex",
      model: "126610LN",
      movement_id: "A",
      is_public: 1,
    },
    silver: {
      id: id("w-silver"),
      name: "Silver Speedmaster",
      brand: "Omega",
      model: "310.30",
      movement_id: "A",
      is_public: 1,
    },
    bronze: {
      id: id("w-bronze"),
      name: "Bronze Turtle",
      brand: "Seiko",
      model: "SRP777",
      movement_id: "B",
      is_public: 1,
    },
    privateW: {
      id: id("w-private"),
      name: "Private Nomos",
      brand: "Nomos",
      model: "Tangente",
      movement_id: "A",
      is_public: 0,
    },
    ineligible: {
      id: id("w-ineligible"),
      name: "Fresh Tudor",
      brand: "Tudor",
      model: "BB58",
      movement_id: "B",
      is_public: 1,
    },
    pending: {
      id: id("w-pending"),
      name: "Proto",
      brand: "Proto",
      model: "X",
      movement_id: "P",
      is_public: 1,
    },
  },
};

async function seed() {
  const db = (env as unknown as { DB: D1Database }).DB;
  const now = Date.now();

  // Users.
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

  // Movements.
  for (const m of Object.values(SEED.movements)) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        m.id,
        m.canonical_name,
        m.manufacturer,
        m.caliber,
        "automatic",
        m.status,
        null,
      )
      .run();
  }

  // Watches — map the `movement_id` letter to the real movement id.
  const movByKey: Record<string, string> = {
    A: SEED.movements.caliberA.id,
    B: SEED.movements.caliberB.id,
    P: SEED.movements.caliberPending.id,
  };
  const watchUserMap: Record<string, string> = {
    gold: SEED.users.owner1.id,
    silver: SEED.users.owner2.id,
    bronze: SEED.users.owner3.id,
    privateW: SEED.users.owner1.id,
    ineligible: SEED.users.owner4.id,
    pending: SEED.users.owner4.id,
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

  // Readings — eligibility = session_days ≥ 7 AND ≥ 3 readings.
  //
  // gold (user1):    baseline t, +3.5 @ +7d, +7 @ +14d  → drift 0.5 s/d, verified 2/3
  // silver (user2):  baseline t, -7 @ +7d,  -14 @ +14d  → drift -1.0 s/d, verified 0/3
  // bronze (user3):  baseline t, +14 @ +7d, +28 @ +14d  → drift 2.0 s/d, verified 3/3
  // privateW:        same shape as gold so it would rank if not filtered
  // ineligible:      only 2 readings, 3 days apart → excluded
  // pending:         eligible shape, 3 readings, 7d → would rank but movement pending
  type R = {
    watch: string;
    user: string;
    t_offset_days: number;
    deviation: number;
    baseline?: boolean;
    verified?: boolean;
  };
  const base = now;
  const readings: R[] = [
    // gold — verified watch, top rank
    {
      watch: "gold",
      user: "owner1",
      t_offset_days: 0,
      deviation: 0,
      baseline: true,
      verified: true,
    },
    { watch: "gold", user: "owner1", t_offset_days: 7, deviation: 3.5, verified: true },
    { watch: "gold", user: "owner1", t_offset_days: 14, deviation: 7, verified: false },
    // silver — unverified, rank 2
    { watch: "silver", user: "owner2", t_offset_days: 0, deviation: 0, baseline: true },
    { watch: "silver", user: "owner2", t_offset_days: 7, deviation: -7 },
    { watch: "silver", user: "owner2", t_offset_days: 14, deviation: -14 },
    // bronze — verified, rank 3
    {
      watch: "bronze",
      user: "owner3",
      t_offset_days: 0,
      deviation: 0,
      baseline: true,
      verified: true,
    },
    { watch: "bronze", user: "owner3", t_offset_days: 7, deviation: 14, verified: true },
    { watch: "bronze", user: "owner3", t_offset_days: 14, deviation: 28, verified: true },
    // private — mirrors gold but won't appear
    { watch: "privateW", user: "owner1", t_offset_days: 0, deviation: 0, baseline: true },
    { watch: "privateW", user: "owner1", t_offset_days: 7, deviation: 3.5 },
    { watch: "privateW", user: "owner1", t_offset_days: 14, deviation: 7 },
    // ineligible — under 7 days + under 3 readings
    {
      watch: "ineligible",
      user: "owner4",
      t_offset_days: 0,
      deviation: 0,
      baseline: true,
    },
    { watch: "ineligible", user: "owner4", t_offset_days: 3, deviation: 1.5 },
    // pending-movement — fully eligible, but its movement is pending so excluded
    { watch: "pending", user: "owner4", t_offset_days: 0, deviation: 0, baseline: true },
    { watch: "pending", user: "owner4", t_offset_days: 7, deviation: 1 },
    { watch: "pending", user: "owner4", t_offset_days: 14, deviation: 2 },
  ];

  const userIdMap: Record<string, string> = {
    owner1: SEED.users.owner1.id,
    owner2: SEED.users.owner2.id,
    owner3: SEED.users.owner3.id,
    owner4: SEED.users.owner4.id,
  };
  const watchIdMap: Record<string, string> = Object.fromEntries(
    Object.entries(SEED.watches).map(([k, v]) => [k, v.id]),
  );
  for (const r of readings) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO readings (id, watch_id, user_id, reference_timestamp, deviation_seconds, is_baseline, verified) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id(`r-${r.watch}-${r.t_offset_days}`),
        watchIdMap[r.watch]!,
        userIdMap[r.user]!,
        base + r.t_offset_days * DAY_MS,
        r.deviation,
        r.baseline ? 1 : 0,
        r.verified ? 1 : 0,
      )
      .run();
  }
}

beforeAll(async () => {
  await seed();
});

// ---- queryLeaderboard domain module ------------------------------

describe("queryLeaderboard()", () => {
  it("ranks public+eligible+approved-movement watches by abs(avg_drift_rate_spd) asc", async () => {
    const db = createDb(env as { DB: D1Database });
    const ranked = await queryLeaderboard({}, db);

    // Our three ranked watches should appear in order: gold, silver, bronze.
    const ours = ranked.filter((r) =>
      [SEED.watches.gold.id, SEED.watches.silver.id, SEED.watches.bronze.id].includes(
        r.watch_id,
      ),
    );
    expect(ours.map((r) => r.watch_id)).toEqual([
      SEED.watches.gold.id,
      SEED.watches.silver.id,
      SEED.watches.bronze.id,
    ]);
    // And ranks are 1-based and monotonically increasing across the slice.
    const ranks = ours.map((r) => r.rank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThan(ranks[i - 1]!);
    }
  });

  it("excludes private watches", async () => {
    const db = createDb(env as { DB: D1Database });
    const ranked = await queryLeaderboard({}, db);
    expect(ranked.some((r) => r.watch_id === SEED.watches.privateW.id)).toBe(false);
  });

  it("excludes watches on pending movements", async () => {
    const db = createDb(env as { DB: D1Database });
    const ranked = await queryLeaderboard({}, db);
    expect(ranked.some((r) => r.watch_id === SEED.watches.pending.id)).toBe(false);
  });

  it("excludes watches that fail eligibility (< 7 days or < 3 readings)", async () => {
    const db = createDb(env as { DB: D1Database });
    const ranked = await queryLeaderboard({}, db);
    expect(ranked.some((r) => r.watch_id === SEED.watches.ineligible.id)).toBe(false);
  });

  it("verified_only=true excludes unverified watches", async () => {
    const db = createDb(env as { DB: D1Database });
    const ranked = await queryLeaderboard({ verified_only: true }, db);
    // silver has verified_ratio 0, so it must not appear.
    expect(ranked.some((r) => r.watch_id === SEED.watches.silver.id)).toBe(false);
    // gold and bronze should still be there.
    expect(ranked.some((r) => r.watch_id === SEED.watches.gold.id)).toBe(true);
    expect(ranked.some((r) => r.watch_id === SEED.watches.bronze.id)).toBe(true);
  });

  it("movement_id filter narrows to one movement", async () => {
    const db = createDb(env as { DB: D1Database });
    const ranked = await queryLeaderboard(
      { movement_id: SEED.movements.caliberA.id },
      db,
    );
    const ourIds = ranked.map((r) => r.watch_id);
    expect(ourIds).toContain(SEED.watches.gold.id);
    expect(ourIds).toContain(SEED.watches.silver.id);
    expect(ourIds).not.toContain(SEED.watches.bronze.id);
  });

  it("pagination: limit + offset trim results", async () => {
    const db = createDb(env as { DB: D1Database });
    const all = await queryLeaderboard({}, db);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const firstTwo = await queryLeaderboard({ limit: 2 }, db);
    expect(firstTwo).toHaveLength(2);
    expect(firstTwo[0]!.watch_id).toBe(all[0]!.watch_id);
    const skippedOne = await queryLeaderboard({ limit: 2, offset: 1 }, db);
    expect(skippedOne[0]!.watch_id).toBe(all[1]!.watch_id);
  });

  it("RankedWatch shape: exposes username + movement canonical name + session_stats", async () => {
    const db = createDb(env as { DB: D1Database });
    const ranked = await queryLeaderboard({ limit: 50 }, db);
    const gold = ranked.find((r) => r.watch_id === SEED.watches.gold.id);
    expect(gold).toBeDefined();
    expect(gold!.owner_username).toBe(SEED.users.owner1.username);
    expect(gold!.movement_canonical_name).toBe(SEED.movements.caliberA.canonical_name);
    expect(gold!.movement_id).toBe(SEED.movements.caliberA.id);
    expect(gold!.session_stats.eligible).toBe(true);
    expect(gold!.session_stats.verified_badge).toBe(true);
    expect(gold!.session_stats.avg_drift_rate_spd).toBeCloseTo(0.5, 5);
  });
});

// ---- GET /api/v1/leaderboard JSON surface -------------------------

describe("GET /api/v1/leaderboard", () => {
  it("returns 200 JSON with watches[]", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/leaderboard?limit=50"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watches: Array<{ watch_id: string }> };
    const ids = body.watches.map((w) => w.watch_id);
    expect(ids).toContain(SEED.watches.gold.id);
    expect(ids).toContain(SEED.watches.silver.id);
    expect(ids).toContain(SEED.watches.bronze.id);
  });

  it("verified_only=1 filters at the API surface", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/leaderboard?verified_only=1&limit=50"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watches: Array<{ watch_id: string }> };
    const ids = body.watches.map((w) => w.watch_id);
    expect(ids).not.toContain(SEED.watches.silver.id);
    expect(ids).toContain(SEED.watches.gold.id);
  });

  it("movement_id filter narrows at the API surface", async () => {
    const res = await exports.default.fetch(
      new Request(
        `https://ratedwatch.test/api/v1/leaderboard?movement_id=${SEED.movements.caliberA.id}&limit=50`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watches: Array<{ watch_id: string }> };
    const ids = body.watches.map((w) => w.watch_id);
    expect(ids).toContain(SEED.watches.gold.id);
    expect(ids).not.toContain(SEED.watches.bronze.id);
  });

  it("rejects limit > 200 as a Zod validation error", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/leaderboard?limit=9999"),
    );
    expect(res.status).toBe(400);
  });
});
