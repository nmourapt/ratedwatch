// Integration tests for POST /api/v1/watches/:id/readings/verified.
//
// Strategy: we drive the real Hono pipeline end-to-end but swap the
// dial reader (legacy AI runner OR new CV container, depending on
// the `ai_reading_v2` flag) for a canned fake. That module-level
// override is shared by the test and Worker because
// vitest-pool-workers runs both inside the same workerd process per
// test file.
//
// Backend selection (post-slice #75 of PRD #73):
//   * Flag OFF → legacy AI runner via `__setTestAiRunner`. Existing
//     "AI path" tests live here unchanged in spirit but unset the
//     flag (rather than set it on) so the route routes through AI.
//   * Flag ON  → CV container via `__setTestDialReader`. New tests
//     pin the photo + confidence + version persistence and the
//     mapped HTTP responses for each rejection class.
//
// We also control `Date.now()` inside each test so the drift math
// is hermetic — otherwise the dial time returned by the fake and
// the reference timestamp captured by the verifier would race.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { __setTestAiRunner, type AiRunner } from "@/domain/ai-dial-reader/runner";
import { __setTestDialReader, type DialReader } from "@/domain/dial-reader/adapter";
import { __setTestExifReader } from "@/domain/reading-verifier/exif";

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

afterEach(async () => {
  __setTestAiRunner(null);
  __setTestDialReader(null);
  __setTestExifReader(null);
  vi.useRealTimers();
  // Ensure no stale flag value bleeds across tests. Using delete is
  // idempotent — KV silently no-ops when the key is missing.
  await unsetVerifiedFlag();
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

// Helpers for the CV path. Slice #75 wires `__setTestDialReader`
// the same way `__setTestAiRunner` works: a canned response means
// the verifier never reaches into the real DO binding (which can't
// be hosted under miniflare anyway).
function installFakeDialReaderSuccess(opts: {
  m: number;
  s: number;
  confidence?: number;
  version?: string;
}): void {
  const reader: DialReader = async () => ({
    kind: "success",
    body: {
      version: opts.version ?? "v0.0.1-scaffolding",
      ok: true,
      result: {
        displayed_time: { h: 12, m: opts.m, s: opts.s },
        confidence: opts.confidence ?? 0.9,
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

function installFakeDialReaderTransportError(message: string): void {
  const reader: DialReader = async () => ({ kind: "transport_error", message });
  __setTestDialReader(reader);
}

describe("POST /api/v1/watches/:id/readings/verified — legacy AI backend (flag OFF)", () => {
  // Flag-off branch (preserved by slice #75 of PRD #73 — the AI
  // path is deleted in slice #11 once CV has proven itself).
  // Tests here deliberately do NOT call `setVerifiedFlagForUser` —
  // the verified-reading service defaults to off without a KV value
  // present, so leaving the flag unset routes through the AI runner.
  it("computes deviation from AI dial MM:SS vs server reference clock", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "V2", movement_id: movementId },
      user.cookie,
    );

    // Freeze Date.now() at 14:32:05 UTC so the reference clock is
    // deterministic. Fake AI returns "32:07" (MM:SS) → +2s drift
    // (same minute as reference, 2s ahead).
    const refTime = Date.UTC(2024, 0, 15, 14, 32, 5);
    vi.useFakeTimers();
    vi.setSystemTime(refTime);
    installFakeAi("32:07");

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

  it("captures drift larger than a minute (dial 33:10 vs ref 32:05 → +65s)", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "V2b", movement_id: movementId },
      user.cookie,
    );

    // This is the case the seconds-only contract lost: +65s drift
    // would have wrapped to -5s under the old math. MM:SS reads it
    // correctly.
    const refTime = Date.UTC(2024, 0, 15, 14, 32, 5);
    vi.useFakeTimers();
    vi.setSystemTime(refTime);
    installFakeAi("33:10");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { deviation_seconds: number };
    expect(body.deviation_seconds).toBe(65);
  });

  it("422s on AI refusal (NO_DIAL)", async () => {
    const user = await registerAndGetCookie();
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
    const { id: watchId } = await createWatch(
      { name: "V5", movement_id: movementId },
      user.cookie,
    );

    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2024, 0, 15, 10, 0, 0));
    // AI "sees" 0:25 (25 s off the reference's 0:00); baseline
    // should still pin deviation to 0 because the user is declaring
    // "the watch is set to the exact time now".
    installFakeAi("0:25");

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
      const { id: watchId } = await createWatch(
        { name: "Theirs", movement_id: movementId },
        owner.cookie,
      );
      installFakeAi("0:0");

      const res = await postVerifiedReading(watchId, other.cookie);
      expect(res.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );

  it("stores the photo at readings/{id}/photo.jpg in R2", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "V6", movement_id: movementId },
      user.cookie,
    );
    installFakeAi("0:30");
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

  it("rejects EXIF outside the bounds window with 422 exif_clock_skew", async () => {
    // End-to-end check that the EXIF clock-skew gate fires through
    // the HTTP layer. We freeze the server clock so the bound
    // calculation is deterministic, then install an EXIF reader that
    // returns a timestamp 10 minutes in the past — well outside the
    // 5-minute past tolerance.
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "EXIFOOB", movement_id: movementId },
      user.cookie,
    );

    const refTime = Date.UTC(2024, 0, 15, 14, 32, 5);
    vi.useFakeTimers();
    vi.setSystemTime(refTime);
    __setTestExifReader(async () => refTime - 10 * 60 * 1000);
    // AI fake is irrelevant — the EXIF gate fires before the AI call.
    installFakeAi("0:0");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; raw_response?: string };
    expect(body.error).toBe("exif_clock_skew");
    expect(body.raw_response).toMatch(/too old/i);
  });
});

describe("POST /api/v1/watches/:id/readings/verified — CV dial-reader backend (flag ON)", () => {
  // Slice #75 of PRD #73. With the flag set ON for the user, the
  // verifier routes through the CV container instead of the AI
  // runner. The container is faked here via __setTestDialReader.
  it("persists photo_r2_key + dial_reader_confidence + dial_reader_version on success", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "CV1", movement_id: movementId },
      user.cookie,
    );

    const refTime = Date.UTC(2024, 0, 15, 14, 32, 5);
    vi.useFakeTimers();
    vi.setSystemTime(refTime);
    // CV reader returns 32:10 → +5s drift vs the 14:32:05 ref clock.
    installFakeDialReaderSuccess({
      m: 32,
      s: 10,
      confidence: 0.92,
      version: "v0.1.0-test",
    });
    const probeBytes = new Uint8Array([0xff, 0xd8, 0xab, 0xcd, 0xff, 0xd9]);

    const res = await postVerifiedReading(watchId, user.cookie, {
      image: probeBytes,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      verified: boolean;
      deviation_seconds: number;
      reference_timestamp: number;
    };
    expect(body.verified).toBe(true);
    expect(body.deviation_seconds).toBe(5);
    expect(body.reference_timestamp).toBe(refTime);

    // Photo lands in R2 at the documented key.
    const IMAGES = (env as unknown as { IMAGES: R2Bucket }).IMAGES;
    const obj = await IMAGES.get(`readings/${body.id}/photo.jpg`);
    expect(obj).not.toBeNull();
    expect(Array.from(new Uint8Array(await obj!.arrayBuffer()))).toEqual(
      Array.from(probeBytes),
    );

    // The CV columns end up populated on the row. We read directly
    // since the wire format doesn't (yet) surface them — the SPA
    // doesn't render confidence in v1 per PRD design notes.
    const DB = (env as unknown as { DB: D1Database }).DB;
    const row = await DB.prepare(
      "SELECT photo_r2_key, dial_reader_confidence, dial_reader_version FROM readings WHERE id = ?",
    )
      .bind(body.id)
      .first<{
        photo_r2_key: string | null;
        dial_reader_confidence: number | null;
        dial_reader_version: string | null;
      }>();
    expect(row).not.toBeNull();
    expect(row!.photo_r2_key).toBe(`readings/${body.id}/photo.jpg`);
    expect(row!.dial_reader_confidence).toBeCloseTo(0.92, 5);
    expect(row!.dial_reader_version).toBe("v0.1.0-test");
  });

  it("rejects unsupported_dial with 422 + structured error_code + ux_hint", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "CVUns", movement_id: movementId },
      user.cookie,
    );
    installFakeDialReaderRejection("sub_dial_detected");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error_code: string; ux_hint: string };
    expect(body.error_code).toBe("dial_reader_unsupported_dial");
    expect(body.ux_hint).toMatch(/log manually/i);
  });

  it("rejects low_confidence with 422 + structured body", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "CVLow", movement_id: movementId },
      user.cookie,
    );
    installFakeDialReaderRejection("low_confidence");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error_code: string; ux_hint: string };
    expect(body.error_code).toBe("dial_reader_low_confidence");
    expect(body.ux_hint).toMatch(/sharper photo/i);
  });

  it("rejects no_dial_found with 422 + structured body", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "CVNo", movement_id: movementId },
      user.cookie,
    );
    installFakeDialReaderRejection("no_dial_found");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error_code: string; ux_hint: string };
    expect(body.error_code).toBe("dial_reader_no_dial_found");
    expect(body.ux_hint).toMatch(/centered and well-lit/i);
  });

  it("converts a sub-confidence successful read into low_confidence rejection", async () => {
    // The container can return ok=true with a confidence below 0.7;
    // the verifier is the gate. Pin the contract here so a future
    // change to DIAL_READER_CONFIDENCE_THRESHOLD (or a switch to
    // letting the container do the gating) is a deliberate edit
    // rather than an accident.
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "CVThresh", movement_id: movementId },
      user.cookie,
    );
    installFakeDialReaderSuccess({ m: 0, s: 30, confidence: 0.5 });

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("dial_reader_low_confidence");
  });

  it("surfaces a dial-reader transport error as HTTP 502", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "CVTrans", movement_id: movementId },
      user.cookie,
    );
    installFakeDialReaderTransportError("dial-reader container returned HTTP 500");

    const res = await postVerifiedReading(watchId, user.cookie);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error_code: string; ux_hint: string };
    expect(body.error_code).toBe("dial_reader_transport_error");
    expect(body.ux_hint).toMatch(/temporarily unavailable/i);
  });

  it("forces deviation to 0 on a baseline reading even when CV reads non-zero", async () => {
    const user = await registerAndGetCookie();
    await setVerifiedFlagForUser(user.userId);
    const { id: watchId } = await createWatch(
      { name: "CVBase", movement_id: movementId },
      user.cookie,
    );

    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2024, 0, 15, 10, 0, 0));
    installFakeDialReaderSuccess({ m: 0, s: 25, confidence: 0.95 });

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
});
