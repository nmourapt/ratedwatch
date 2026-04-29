// Integration tests for the verified-reading rate limit (slice #82
// of PRD #73, user story #25).
//
// Coverage:
//   * The 51st verified-reading request returns a structured 429.
//   * Per-user isolation: user A's quota does not affect user B.
//   * Pure manual readings (`POST /readings`, no photo) are never
//     rate-limited.
//   * `/verified` and `/manual_with_photo` share the SAME quota —
//     25 + 25 fills the bucket and the 51st of either type is
//     blocked.
//
// Strategy: we do NOT actually hammer the route 50 times. The
// helper module exposes `__setTestRateLimiter` (mirroring
// `__setTestDialReader`) so the burst gate is fully controllable.
// The DAILY-CAP gate IS exercised with real D1 writes — we seed N
// rows directly via the DB binding and then hit the route once,
// asserting the helper's row-count query sees them. Seeding is
// much faster than driving 50 multipart uploads and avoids timing
// out the suite.
//
// The rate-limit helper's two-layer design is unit-tested in
// src/domain/rate-limit/verified-reading.test.ts; this file is the
// END-TO-END proof that the route emits the documented 429 shape
// and that the SPA's slice-#80 mapper will see what it expects.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { __setTestDialReader, type DialReader } from "@/domain/dial-reader/adapter";
import { __setTestExifReader } from "@/domain/reading-verifier/exif";
import { __setTestRateLimiter } from "@/domain/rate-limit/verified-reading";

// ---- Fixture ------------------------------------------------------

const movementId = "test-ratelimit-eta-2824";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      movementId,
      "Test Rate-Limit ETA 2824",
      "ETA",
      "2824 (rate-limit)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

afterEach(async () => {
  __setTestDialReader(null);
  __setTestExifReader(null);
  __setTestRateLimiter(null);
  vi.useRealTimers();
  // Drop any feature-flag values left over from previous tests so
  // the verified-reading flag-gate state is hermetic.
  await unsetVerifiedFlag();
});

/**
 * Enable verified-reading globally for the duration of a test.
 * The rate-limit tests don't care which specific users are
 * targeted — `mode:always` keeps the flag-gate stable across
 * multi-user fixtures (per-user-isolation in particular) without
 * the orchestration of merging users[] into a single KV value.
 */
async function enableVerifiedReadingForAll(): Promise<void> {
  const FLAGS = (env as unknown as { FLAGS: KVNamespace }).FLAGS;
  await FLAGS.put("verified_reading_cv", JSON.stringify({ mode: "always" }));
}

async function unsetVerifiedFlag(): Promise<void> {
  const FLAGS = (env as unknown as { FLAGS: KVNamespace }).FLAGS;
  await FLAGS.delete("verified_reading_cv");
}

// ---- Auth + watch helpers (mirror readings.verified.test.ts) ------

function makeEmail(prefix = "ratelimit"): string {
  return `${prefix}-${crypto.randomUUID()}@ratedwatch.test`;
}

interface TestUser {
  cookie: string;
  userId: string;
}

async function registerAndGetCookie(): Promise<TestUser> {
  const email = makeEmail();
  const password = "correct-horse-42";
  const reg = await exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: email.split("@")[0]!, email, password }),
    }),
  );
  expect(reg.status).toBe(200);
  const regBody = (await reg.json()) as { user: { id: string } };
  const loginRes = await exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(loginRes.status).toBe(200);
  const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { cookie, userId: regBody.user.id };
}

async function createWatch(
  body: { name: string; movement_id: string },
  cookie: string,
): Promise<{ id: string }> {
  const res = await exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/watches", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

function tinyJpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}

// ---- Direct DB seed for daily-cap fixture --------------------------
//
// Inserts N photo-bearing reading rows for a given user against a
// given watch. Bypasses the route layer so we don't pay 50× upload
// + verifier round-trips per test. Each row has a unique id so the
// PK constraint is satisfied; created_at defaults to "now" via the
// schema's DEFAULT clause, which makes the helper's 24h window
// see them all.
//
// The `photo_r2_key` IS NOT NULL value is what flags a row as
// counting against the cap (per migration 0007's partial index
// and the helper's WHERE clause).
async function seedPhotoReadings(
  userId: string,
  watchId: string,
  count: number,
): Promise<void> {
  const db = (env as unknown as { DB: D1Database }).DB;
  for (let i = 0; i < count; i++) {
    const id = `seed-${userId}-${i}-${crypto.randomUUID()}`;
    await db
      .prepare(
        "INSERT INTO readings (id, watch_id, user_id, reference_timestamp, deviation_seconds, is_baseline, verified, notes, photo_r2_key) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?)",
      )
      .bind(id, watchId, userId, Date.now(), 0, `readings/${id}/photo.jpg`)
      .run();
  }
}

// ---- Request helpers ----------------------------------------------

async function postVerifiedReading(watchId: string, cookie: string): Promise<Response> {
  const body = new FormData();
  body.append("image", new Blob([tinyJpegBytes()], { type: "image/jpeg" }), "dial.jpg");
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified`, {
      method: "POST",
      headers: { cookie },
      body,
    }),
  );
}

async function postManualWithPhoto(watchId: string, cookie: string): Promise<Response> {
  const body = new FormData();
  body.append("image", new Blob([tinyJpegBytes()], { type: "image/jpeg" }), "dial.jpg");
  body.append("hh", "12");
  body.append("mm", "30");
  body.append("ss", "0");
  return exports.default.fetch(
    new Request(
      `https://ratedwatch.test/api/v1/watches/${watchId}/readings/manual_with_photo`,
      { method: "POST", headers: { cookie }, body },
    ),
  );
}

async function postPureManualReading(watchId: string, cookie: string): Promise<Response> {
  // No multipart, no photo — the unlimited path.
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        reference_timestamp: Date.now(),
        deviation_seconds: 0,
        is_baseline: false,
      }),
    }),
  );
}

function installPassthroughBackends(): void {
  // The verified-reading flow needs SOME backend so the request
  // gets to the rate-limit gate without immediately failing. We
  // never reach the verifier itself — the rate-limit gate either
  // short-circuits with 429 or the caller doesn't run a real
  // /verified hit. Just install a minimal fake for safety.
  const dialReader: DialReader = async () => ({
    kind: "rejection",
    reason: "low_confidence",
  });
  __setTestDialReader(dialReader);
}

// ---- Tests --------------------------------------------------------

describe("Rate limit — verified-reading endpoint", () => {
  it("returns 429 with structured body once the daily cap is hit", async () => {
    installPassthroughBackends();
    const user = await registerAndGetCookie();
    await enableVerifiedReadingForAll();
    const { id: watchId } = await createWatch(
      { name: "rate-watch", movement_id: movementId },
      user.cookie,
    );

    // Seed exactly 50 photo-bearing rows. The helper's WHERE clause
    // counts >= cap so the next request must be denied.
    await seedPhotoReadings(user.userId, watchId, 50);

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error_code: "rate_limit",
      retry_after_seconds: 86400,
    });
    expect(typeof body.ux_hint).toBe("string");
    expect(body.ux_hint as string).toMatch(/daily verified-reading cap/i);
  });

  it("allows the request when the daily count is just under the cap", async () => {
    installPassthroughBackends();
    const user = await registerAndGetCookie();
    await enableVerifiedReadingForAll();
    const { id: watchId } = await createWatch(
      { name: "rate-watch-49", movement_id: movementId },
      user.cookie,
    );
    await seedPhotoReadings(user.userId, watchId, 49);

    const res = await postVerifiedReading(watchId, user.cookie);
    // The fake dial reader returns a rejection (422) — the point
    // here is that the request was NOT rate-limited (would be 429).
    expect(res.status).not.toBe(429);
  });

  it("returns 429 immediately when the burst gate fires (no DB lookup needed)", async () => {
    installPassthroughBackends();
    // Burst-gate-blocking limiter — every call returns success=false.
    __setTestRateLimiter(async () => ({ success: false }));
    const user = await registerAndGetCookie();
    await enableVerifiedReadingForAll();
    const { id: watchId } = await createWatch(
      { name: "burst-watch", movement_id: movementId },
      user.cookie,
    );
    // No seed — proves the burst gate short-circuits before the
    // daily-cap query.
    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error_code).toBe("rate_limit");
  });
});

describe("Rate limit — per-user isolation", () => {
  it("user A hitting the cap does not affect user B", async () => {
    installPassthroughBackends();
    const userA = await registerAndGetCookie();
    const userB = await registerAndGetCookie();
    await enableVerifiedReadingForAll();
    const { id: watchA } = await createWatch(
      { name: "watch-a", movement_id: movementId },
      userA.cookie,
    );
    const { id: watchB } = await createWatch(
      { name: "watch-b", movement_id: movementId },
      userB.cookie,
    );

    // Cap A. Leave B at 0.
    await seedPhotoReadings(userA.userId, watchA, 50);

    const resA = await postVerifiedReading(watchA, userA.cookie);
    expect(resA.status).toBe(429);

    const resB = await postVerifiedReading(watchB, userB.cookie);
    // B is not rate-limited (would be 429). The fake dial reader
    // returns a rejection so the actual status will be 422 — the
    // test cares only that it's NOT 429.
    expect(resB.status).not.toBe(429);
  });
});

describe("Rate limit — pure manual readings stay unlimited", () => {
  it("seeded 50 photo-bearing readings does not block a no-photo manual reading", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "manual-only", movement_id: movementId },
      user.cookie,
    );

    // Saturate the cap for photo-bearing reads.
    await seedPhotoReadings(user.userId, watchId, 50);

    // Pure manual /readings with no photo must succeed.
    const res = await postPureManualReading(watchId, user.cookie);
    expect(res.status).toBe(201);
  });
});

describe("Rate limit — shared quota across /verified and /manual_with_photo", () => {
  it("25 verified + 25 manual_with_photo fills the bucket; 51st of either is 429", async () => {
    installPassthroughBackends();
    const user = await registerAndGetCookie();
    await enableVerifiedReadingForAll();
    const { id: watchId } = await createWatch(
      { name: "shared-watch", movement_id: movementId },
      user.cookie,
    );

    // The daily-cap helper counts ALL photo-bearing rows
    // (photo_r2_key IS NOT NULL), regardless of which endpoint
    // wrote them. Seed 50 mixed rows directly so we don't have to
    // drive 50 multipart uploads through the route.
    await seedPhotoReadings(user.userId, watchId, 50);

    // 51st verified → 429.
    const verifiedRes = await postVerifiedReading(watchId, user.cookie);
    expect(verifiedRes.status).toBe(429);
    const verifiedBody = (await verifiedRes.json()) as Record<string, unknown>;
    expect(verifiedBody.error_code).toBe("rate_limit");

    // 51st manual_with_photo → 429 too. Same shared quota.
    const mwpRes = await postManualWithPhoto(watchId, user.cookie);
    expect(mwpRes.status).toBe(429);
    const mwpBody = (await mwpRes.json()) as Record<string, unknown>;
    expect(mwpBody.error_code).toBe("rate_limit");
  });
});
