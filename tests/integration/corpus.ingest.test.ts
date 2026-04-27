// Integration tests for corpus collection — slice #81 of PRD #73.
//
// Drives the full Worker pipeline end-to-end via the existing
// readings.verified.test.ts patterns: real D1, real R2 (miniflare-
// hosted), real Better Auth registration, and a faked dial reader.
// We exercise the consent gate, the confidence gate, and the
// rejection branch via canned dial-reader responses, then assert on
// the contents of the rated-watch-corpus R2 bucket.
//
// The retroactive-deletion path (PATCH /api/v1/me with
// consent_corpus 1->0) gets its own describe block because it
// touches a different route.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { __setTestDialReader, type DialReader } from "@/domain/dial-reader/adapter";
import { __setTestExifReader } from "@/domain/reading-verifier/exif";

const movementId = "test-corpus-eta-2824";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      movementId,
      "Test ETA 2824 (corpus)",
      "ETA",
      "2824 (corpus)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

afterEach(async () => {
  __setTestDialReader(null);
  __setTestExifReader(null);
  vi.useRealTimers();
  await unsetVerifiedFlag();
  // Drain the corpus bucket between tests so each test asserts in
  // isolation. We don't worry about parallel-test interference
  // because vitest-pool-workers sandboxes per file.
  await drainCorpus();
});

// ---- Auth helpers (mirror tests/integration/readings.verified) ----

function makeEmail(prefix = "corpus"): string {
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

async function setConsentCorpus(userId: string, value: 0 | 1): Promise<void> {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare("UPDATE user SET consent_corpus = ? WHERE id = ?")
    .bind(value, userId)
    .run();
}

async function setVerifiedFlagForUser(userId: string): Promise<void> {
  const FLAGS = (env as unknown as { FLAGS: KVNamespace }).FLAGS;
  await FLAGS.put("ai_reading_v2", JSON.stringify({ mode: "users", users: [userId] }));
}

async function unsetVerifiedFlag(): Promise<void> {
  const FLAGS = (env as unknown as { FLAGS: KVNamespace }).FLAGS;
  await FLAGS.delete("ai_reading_v2");
}

async function drainCorpus(): Promise<void> {
  const R2 = (env as unknown as { R2_CORPUS?: R2Bucket }).R2_CORPUS;
  if (!R2) return;
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const list = await R2.list({ prefix: "corpus/", cursor, limit: 1000 });
    if (list.objects.length > 0) {
      await R2.delete(list.objects.map((o) => o.key));
    }
    if (!list.truncated) return;
    cursor = list.truncated ? list.cursor : undefined;
    if (!cursor) return;
  }
}

async function listCorpus(): Promise<string[]> {
  const R2 = (env as unknown as { R2_CORPUS?: R2Bucket }).R2_CORPUS;
  if (!R2) return [];
  const list = await R2.list({ prefix: "corpus/", limit: 1000 });
  return list.objects.map((o) => o.key);
}

function tinyJpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xab, 0xcd, 0xff, 0xd9]);
}

async function postVerifiedReading(
  watchId: string,
  cookie: string,
  imageBytes: Uint8Array,
): Promise<Response> {
  const body = new FormData();
  body.append("image", new Blob([imageBytes], { type: "image/jpeg" }), "dial.jpg");
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified`, {
      method: "POST",
      headers: { cookie },
      body,
    }),
  );
}

function installFakeDialReaderSuccess(opts: {
  m: number;
  s: number;
  confidence: number;
  version?: string;
}): void {
  const reader: DialReader = async () => ({
    kind: "success",
    body: {
      version: opts.version ?? "v0.0.1-corpus",
      ok: true,
      result: {
        displayed_time: { h: 12, m: opts.m, s: opts.s },
        confidence: opts.confidence,
        dial_detection: { center_xy: [0, 0], radius_px: 0 },
        hand_angles_deg: { hour: 0, minute: 0, second: 0 },
        processing_ms: 0,
      },
    },
  });
  __setTestDialReader(reader);
}

function installFakeDialReaderRejection(reason: string): void {
  const reader: DialReader = async () => ({ kind: "rejection", reason });
  __setTestDialReader(reader);
}

/**
 * Wait for the executionCtx.waitUntil promise queued by the
 * verified-reading route to settle. miniflare runs waitUntil
 * tasks on the same loop as the test, but they're scheduled
 * AFTER the response resolves. A microtask + small macrotask
 * yield is enough to let the corpus write land.
 */
async function flushWaitUntil(): Promise<void> {
  // Two animation-frame-ish yields. The R2 put is otherwise
  // synchronous within miniflare, so this is more than enough.
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 50));
}

const TWO_USER_TIMEOUT = 30_000;

// ---- Tests --------------------------------------------------------

describe("corpus collection — consent gate", () => {
  it("does NOT write when consent_corpus = 0 (rejection)", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    // consent_corpus default is 0 — explicit for clarity.
    await setConsentCorpus(user.userId, 0);
    const { id: watchId } = await createWatch(
      { name: "C1", movement_id: movementId },
      user.cookie,
    );
    installFakeDialReaderRejection("no_dial_found");

    const res = await postVerifiedReading(watchId, user.cookie, tinyJpegBytes());
    expect(res.status).toBe(422);
    await flushWaitUntil();

    const keys = await listCorpus();
    expect(keys).toHaveLength(0);
  });

  it("does NOT write when consent_corpus = 0 (low-confidence success)", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    await setConsentCorpus(user.userId, 0);
    const { id: watchId } = await createWatch(
      { name: "C2", movement_id: movementId },
      user.cookie,
    );
    // Use real timers + a stubbed EXIF reader for deterministic
    // reference timestamp (the corpus gate doesn't depend on
    // deviation math so we can use real Date.now()). Mocking the
    // EXIF reader keeps the verifier's bounds check deterministic
    // even though it never fires here (the read succeeds inside
    // the bounds window).
    __setTestExifReader(async () => null);
    installFakeDialReaderSuccess({ m: 32, s: 10, confidence: 0.72 });

    const res = await postVerifiedReading(watchId, user.cookie, tinyJpegBytes());
    expect(res.status).toBe(201);
    await flushWaitUntil();

    expect(await listCorpus()).toHaveLength(0);
  });
});

describe("corpus collection — confidence gate", () => {
  it("does NOT write on a high-confidence success (>= 0.85)", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    await setConsentCorpus(user.userId, 1);
    const { id: watchId } = await createWatch(
      { name: "C3", movement_id: movementId },
      user.cookie,
    );
    __setTestExifReader(async () => null);
    installFakeDialReaderSuccess({ m: 32, s: 10, confidence: 0.93 });

    const res = await postVerifiedReading(watchId, user.cookie, tinyJpegBytes());
    expect(res.status).toBe(201);
    await flushWaitUntil();

    expect(await listCorpus()).toHaveLength(0);
  });

  it("DOES write on a low-margin success (0.7 <= confidence < 0.85)", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    await setConsentCorpus(user.userId, 1);
    const { id: watchId } = await createWatch(
      { name: "C4", movement_id: movementId },
      user.cookie,
    );
    __setTestExifReader(async () => null);
    installFakeDialReaderSuccess({ m: 32, s: 10, confidence: 0.78 });

    const res = await postVerifiedReading(watchId, user.cookie, tinyJpegBytes());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    await flushWaitUntil();

    const keys = await listCorpus();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const photoKey = keys.find((k) => k.endsWith(`/${body.id}/photo.jpg`));
    const sidecarKey = keys.find((k) => k.endsWith(`/${body.id}/sidecar.json`));
    expect(photoKey).toBeDefined();
    expect(sidecarKey).toBeDefined();
  });
});

describe("corpus collection — rejection branch", () => {
  it("writes photo + sidecar on a rejected reading", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    await setConsentCorpus(user.userId, 1);
    const { id: watchId } = await createWatch(
      { name: "C5", movement_id: movementId },
      user.cookie,
    );
    installFakeDialReaderRejection("no_dial_found");

    const res = await postVerifiedReading(watchId, user.cookie, tinyJpegBytes());
    expect(res.status).toBe(422);
    await flushWaitUntil();

    const keys = await listCorpus();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const photo = keys.find((k) => k.endsWith("/photo.jpg"));
    const sidecar = keys.find((k) => k.endsWith("/sidecar.json"));
    expect(photo).toBeDefined();
    expect(sidecar).toBeDefined();
  });
});

describe("corpus collection — sidecar shape", () => {
  it("emits an anonymized sidecar with no user-identifying fields", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    await setConsentCorpus(user.userId, 1);
    const { id: watchId } = await createWatch(
      { name: "C6", movement_id: movementId },
      user.cookie,
    );
    installFakeDialReaderRejection("low_confidence");

    const res = await postVerifiedReading(watchId, user.cookie, tinyJpegBytes());
    expect(res.status).toBe(422);
    await flushWaitUntil();

    const keys = await listCorpus();
    const sidecarKey = keys.find((k) => k.endsWith("/sidecar.json"));
    expect(sidecarKey).toBeDefined();
    const R2 = (env as unknown as { R2_CORPUS: R2Bucket }).R2_CORPUS;
    const obj = await R2.get(sidecarKey!);
    expect(obj).not.toBeNull();
    const sidecar = (await obj!.json()) as Record<string, unknown>;

    // Required positive fields present.
    expect(typeof sidecar.reading_id).toBe("string");
    expect(typeof sidecar.created_at).toBe("string");
    expect(typeof sidecar.image_format).toBe("string");
    expect(typeof sidecar.image_bytes).toBe("number");
    expect("verified" in sidecar).toBe(true);
    expect("rejection_reason" in sidecar).toBe(true);

    // Required negative fields absent.
    const banned = [
      "user_id",
      "userId",
      "watch_id",
      "watchId",
      "email",
      "username",
      "watch_name",
    ];
    for (const k of banned) {
      expect(sidecar[k]).toBeUndefined();
    }
    // The sidecar should not echo the user's id even by accident.
    const sidecarString = JSON.stringify(sidecar);
    expect(sidecarString).not.toContain(user.userId);
  });
});

describe("corpus collection — retroactive deletion on consent_corpus 1->0", () => {
  it(
    "removes the user's corpus objects when they toggle consent off",
    async () => {
      const user = await registerAndGetCookie();
      await setVerifiedFlagForUser(user.userId);
      await setConsentCorpus(user.userId, 1);
      const { id: watchId } = await createWatch(
        { name: "C7", movement_id: movementId },
        user.cookie,
      );
      installFakeDialReaderRejection("no_dial_found");

      // Submit two rejected readings so we have something to clean up.
      const res1 = await postVerifiedReading(watchId, user.cookie, tinyJpegBytes());
      expect(res1.status).toBe(422);
      await flushWaitUntil();
      const res2 = await postVerifiedReading(watchId, user.cookie, tinyJpegBytes());
      expect(res2.status).toBe(422);
      await flushWaitUntil();

      const before = await listCorpus();
      expect(before.length).toBeGreaterThanOrEqual(4); // 2 readings * (photo + sidecar)

      // Patch the consent toggle to off.
      const patchRes = await exports.default.fetch(
        new Request("https://ratedwatch.test/api/v1/me", {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie: user.cookie },
          body: JSON.stringify({ consent_corpus: false }),
        }),
      );
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as { consent_corpus: boolean };
      expect(patchBody.consent_corpus).toBe(false);

      await flushWaitUntil();
      // The retroactive deletion runs in waitUntil — give it a couple
      // of macrotask yields to walk the bucket and complete.
      await new Promise((r) => setTimeout(r, 200));

      const after = await listCorpus();
      // All of the user's objects should be gone. We don't care
      // about the exact total count (other tests in this file may
      // have left residue if drain didn't fully complete) — the
      // assertion that matters is that NONE of the user's reading
      // IDs remain in the bucket.
      const db = (env as unknown as { DB: D1Database }).DB;
      const userReadings = await db
        .prepare("SELECT id FROM readings WHERE user_id = ? AND photo_r2_key IS NOT NULL")
        .bind(user.userId)
        .all<{ id: string }>();
      const userIds = new Set(userReadings.results.map((r) => r.id));
      const remaining = after.filter((k) => {
        const parts = k.split("/");
        return parts.length >= 4 && userIds.has(parts[2]!);
      });
      expect(remaining).toHaveLength(0);
    },
    TWO_USER_TIMEOUT,
  );
});
