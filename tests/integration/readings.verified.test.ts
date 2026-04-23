// Integration tests for POST /api/v1/watches/:id/readings/verified.
//
// Strategy: we drive the real Hono pipeline end-to-end but swap the
// AI dial reader out for a canned fake via `__setTestAiRunner` (see
// src/domain/ai-dial-reader/runner.ts). That module-level override is
// shared by the test and Worker because vitest-pool-workers runs both
// inside the same workerd process per test file.
//
// We also control `Date.now()` inside each test so the drift math is
// hermetic — otherwise the dial time returned by the fake and the
// reference timestamp captured by the verifier would race.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { __setTestAiRunner, type AiRunner } from "@/domain/ai-dial-reader/runner";

// ---- Fixture ------------------------------------------------------

const movementId = "test-verified-eta-2824";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      movementId,
      "Test ETA 2824 (verified)",
      "ETA",
      "2824 (verified)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

afterEach(() => {
  __setTestAiRunner(null);
  vi.useRealTimers();
});

// ---- Auth helpers (mirror readings.test.ts) -----------------------

function makeEmail(prefix = "verified"): string {
  return `${prefix}-${crypto.randomUUID()}@ratedwatch.test`;
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
}

async function registerAndGetCookie(): Promise<TestUser> {
  const email = makeEmail();
  const password = "correct-horse-42";
  const reg = await signUp(email, password);
  expect(reg.status).toBe(200);
  const regBody = (await reg.json()) as { user: { id: string } };
  const loginRes = await signIn(email, password);
  expect(loginRes.status).toBe(200);
  const rawCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(";")[0] ?? "";
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

// ---- Feature-flag + request helpers -------------------------------

async function setVerifiedFlagForUser(userId: string): Promise<void> {
  const FLAGS = (env as unknown as { FLAGS: KVNamespace }).FLAGS;
  await FLAGS.put("ai_reading_v2", JSON.stringify({ mode: "users", users: [userId] }));
}

async function unsetVerifiedFlag(): Promise<void> {
  const FLAGS = (env as unknown as { FLAGS: KVNamespace }).FLAGS;
  await FLAGS.delete("ai_reading_v2");
}

/** Minimal JPEG bytes — SOI + EOI. Enough for the route; the AI
 * runner is faked so it never actually parses the image. */
function tinyJpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}

async function postVerifiedReading(
  watchId: string,
  cookie: string | undefined,
  opts: { isBaseline?: boolean; image?: Uint8Array } = {},
): Promise<Response> {
  const body = new FormData();
  // `Blob` in workerd accepts a Uint8Array directly, but the DOM
  // lib's BlobPart type varies across TS / Workers / Node typings —
  // pass the bytes through as an array of `Uint8Array` so every
  // typing choice sees a valid signature.
  const imageBytes = opts.image ?? tinyJpegBytes();
  body.append("image", new Blob([imageBytes], { type: "image/jpeg" }), "dial.jpg");
  if (opts.isBaseline !== undefined) {
    body.append("is_baseline", String(opts.isBaseline));
  }
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified`, {
      method: "POST",
      headers: cookie ? { cookie } : {},
      body,
    }),
  );
}

function installFakeAi(response: string): void {
  const runner: AiRunner = async () => ({ response });
  __setTestAiRunner(runner);
}

// ---- Tests --------------------------------------------------------

const TWO_USER_TIMEOUT = 30_000;

describe("POST /api/v1/watches/:id/readings/verified", () => {
  it("503s when the ai_reading_v2 flag is off", async () => {
    await unsetVerifiedFlag();
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "V1", movement_id: movementId },
      user.cookie,
    );
    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("verified_readings_disabled");
  });

  it("computes deviation from AI dial time vs server reference clock", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "V2", movement_id: movementId },
      user.cookie,
    );

    // Freeze Date.now() at 14:32:05 UTC so the reference clock is
    // deterministic. Fake AI returns 14:32:07 → +2s drift.
    const refTime = Date.UTC(2024, 0, 15, 14, 32, 5);
    vi.useFakeTimers();
    vi.setSystemTime(refTime);
    installFakeAi("14:32:07");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      deviation_seconds: number;
      verified: boolean;
      is_baseline: boolean;
      reference_timestamp: number;
      id: string;
    };
    expect(body.verified).toBe(true);
    expect(body.is_baseline).toBe(false);
    expect(body.deviation_seconds).toBeCloseTo(2, 5);
    expect(body.reference_timestamp).toBe(refTime);
  });

  it("422s on AI refusal (NO_DIAL)", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "V3", movement_id: movementId },
      user.cookie,
    );
    installFakeAi("NO_DIAL");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; raw_response?: string };
    expect(body.error).toBe("ai_refused");
    expect(body.raw_response).toBe("NO_DIAL");
  });

  it("422s on unparseable AI output", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "V4", movement_id: movementId },
      user.cookie,
    );
    installFakeAi("banana");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; raw_response?: string };
    expect(body.error).toBe("ai_unparseable");
    expect(body.raw_response).toBe("banana");
  });

  it("forces deviation to 0 when is_baseline=true", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "V5", movement_id: movementId },
      user.cookie,
    );

    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2024, 0, 15, 10, 0, 0));
    // AI "sees" a 5-minute-off dial; baseline should still pin
    // deviation to 0 because the user is declaring "the watch is
    // set to the exact time now".
    installFakeAi("10:05:00");

    const res = await postVerifiedReading(watchId, user.cookie, {
      isBaseline: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      deviation_seconds: number;
      is_baseline: boolean;
    };
    expect(body.is_baseline).toBe(true);
    expect(body.deviation_seconds).toBe(0);
  });

  it(
    "forbids a non-owner from posting to someone else's watch (403)",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      await setVerifiedFlagForUser(other.userId);
      const { id: watchId } = await createWatch(
        { name: "Theirs", movement_id: movementId },
        owner.cookie,
      );
      installFakeAi("12:00:00");

      const res = await postVerifiedReading(watchId, other.cookie);
      expect(res.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );

  it("stores the photo at readings/{id}/photo.jpg in R2", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "V6", movement_id: movementId },
      user.cookie,
    );
    installFakeAi("08:15:30");
    const probeBytes = new Uint8Array([0xff, 0xd8, 0xab, 0xcd, 0xff, 0xd9]);

    const res = await postVerifiedReading(watchId, user.cookie, {
      image: probeBytes,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    const IMAGES = (env as unknown as { IMAGES: R2Bucket }).IMAGES;
    const obj = await IMAGES.get(`readings/${body.id}/photo.jpg`);
    expect(obj).not.toBeNull();
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(Array.from(stored)).toEqual(Array.from(probeBytes));
  });

  it("rejects a missing image field (400)", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "V7", movement_id: movementId },
      user.cookie,
    );
    // Post an empty multipart — no image field.
    const body = new FormData();
    body.append("is_baseline", "false");
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified`, {
        method: "POST",
        headers: { cookie: user.cookie },
        body,
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("image_required");
  });

  it("requires authentication (401)", async () => {
    // We don't even need the flag set to verify the 401 — requireAuth
    // short-circuits before the handler runs.
    const res = await postVerifiedReading("whatever", undefined);
    expect(res.status).toBe(401);
  });
});
