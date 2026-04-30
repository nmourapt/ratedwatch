// Integration tests for the verified-reading two-step API.
//
// Slice #6 of PRD #99 (issue #105) split the synchronous
// `POST /api/v1/watches/:id/readings/verified` into:
//
//   1. `POST .../verified/draft`   — runs the VLM pipeline, returns
//      a signed reading_token + predicted MM:SS + photo URL. Does
//      NOT save a reading.
//   2. `POST .../verified/confirm` — accepts { reading_token,
//      final_mm_ss, is_baseline? }, validates token + adjustment
//      cap (±30s on the [0, 3600) MM:SS circle), saves the row,
//      moves the photo from drafts/ to verified/.
//
// Anti-cheat property: /draft never returns the deviation; the SPA
// confirmation page (slice #7) lets the user adjust ± seconds
// without seeing the deviation. The server enforces the same ±30s
// adjustment limit so a malicious client can't bypass the UI.
//
// We mock the VLM call via `__setTestReadDial` (slice #4 pattern):
// the dial-reader-vlm tests already cover model behaviour, and
// `vitest.config.ts` sets `remoteBindings: false` so env.AI in the
// pool can't reach the gateway anyway.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { __setTestReadDial } from "@/domain/dial-reader-vlm/reader";
import { __setTestExifReader } from "@/domain/reading-verifier/exif";
import { signReadingToken, type ReadingTokenPayload } from "@/domain/reading-token/token";
import type { DialReadResult, ReadDialInput } from "@/domain/dial-reader-vlm/types";

// ---- Test fixture setup --------------------------------------------

const movementId = "test-readings-verified-eta-2824";

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
  __setTestReadDial(null);
  __setTestExifReader(null);
  vi.useRealTimers();
});

// ---- Auth + watch helpers -----------------------------------------

function makeEmail(): string {
  return `verified-${crypto.randomUUID()}@ratedwatch.test`;
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

// ---- Fixture helpers -----------------------------------------------

interface TestEnv {
  readonly TEST_FIXTURES: Record<string, string>;
  readonly DB: D1Database;
  readonly WATCH_IMAGES: R2Bucket;
  readonly READING_TOKEN_SECRET: string;
}

function fixtureBytes(name: string): ArrayBuffer {
  const fixtures = (env as unknown as TestEnv).TEST_FIXTURES;
  const b64 = fixtures[name];
  if (!b64) throw new Error(`fixture not found: ${name}`);
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  const ab = new ArrayBuffer(arr.byteLength);
  new Uint8Array(ab).set(arr);
  return ab;
}

const SMOKE_TRUTH: Record<string, { hh: number; mm: number; ss: number }> = {
  "bambino_10_19_34.jpeg": { hh: 10, mm: 19, ss: 34 },
  "snk803_10_15_40.jpeg": { hh: 10, mm: 15, ss: 40 },
};

async function postDraft(
  watchId: string,
  fixtureName: string,
  cookie: string,
  options?: { clientCaptureMs?: number },
): Promise<Response> {
  const bytes = fixtureBytes(fixtureName);
  const form = new FormData();
  const file = new File([bytes], fixtureName, { type: "image/jpeg" });
  form.append("image", file);
  if (options?.clientCaptureMs !== undefined) {
    form.append("client_capture_ms", String(options.clientCaptureMs));
  }
  return exports.default.fetch(
    new Request(
      `https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified/draft`,
      {
        method: "POST",
        headers: { cookie },
        body: form,
      },
    ),
  );
}

async function postConfirm(
  watchId: string,
  body: {
    reading_token: string;
    final_hms: { h: number; m: number; s: number };
    is_baseline?: boolean;
  },
  cookie: string,
): Promise<Response> {
  return exports.default.fetch(
    new Request(
      `https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      },
    ),
  );
}

interface DraftResponse {
  reading_token: string;
  predicted_hms: { h: number; m: number; s: number };
  photo_url: string;
  reference_source: "exif" | "server" | "client";
  expires_at_unix: number;
}

interface ReadingResponseBody {
  id: string;
  watch_id: string;
  user_id: string;
  reference_timestamp: number;
  deviation_seconds: number;
  is_baseline: boolean;
  verified: boolean;
  notes: string | null;
  created_at: string;
}

interface PersistedRow {
  id: string;
  vlm_model: string;
  photo_r2_key: string | null;
  verified: number;
  reference_timestamp: number;
  deviation_seconds: number;
}

function installVlmMock(answer: { m: number; s: number }): void {
  __setTestReadDial(async (_input: ReadDialInput) => {
    // Slice #5 reader returns `raw_responses: string[]` (one per
    // parallel call). The mock builds three identical entries —
    // matches what the median-of-3 pipeline produces when the model
    // is stable.
    const raw = `10:${String(answer.m).padStart(2, "0")}:${String(answer.s).padStart(2, "0")}`;
    const result: DialReadResult = {
      kind: "success",
      mm_ss: answer,
      raw_responses: [raw, raw, raw],
      tokens_in_total: 300,
      tokens_out_total: 15,
    };
    return result;
  });
}

const VERIFIED_TIMEOUT = 30_000;

// ---- Tests ---------------------------------------------------------

describe("POST /api/v1/watches/:id/readings/verified/draft", () => {
  it.each([["bambino_10_19_34.jpeg"], ["snk803_10_15_40.jpeg"]])(
    "returns reading_token + predicted_hms for %s",
    async (fixtureName) => {
      const truth = SMOKE_TRUTH[fixtureName]!;
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: `Test ${fixtureName}`, movement_id: movementId },
        owner.cookie,
      );

      const res = await postDraft(watchId, fixtureName, owner.cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DraftResponse;

      // Token shape: <payload>.<sig>
      expect(body.reading_token).toContain(".");
      // Hour comes from the reference timestamp's UTC hour, converted
      // to 12-hour analog form (1..12). truth.hh is the watch's
      // displayed local hour (0..23 in the fixture manifest); for
      // these EXIF-present fixtures the worker's UTC interpretation
      // matches the camera's local hour by construction (Date()
      // parsing of naive EXIF strings under TZ=UTC).
      const expectedH12 = ((truth.hh + 11) % 12) + 1;
      expect(body.predicted_hms).toEqual({
        h: expectedH12,
        m: truth.mm,
        s: truth.ss,
      });
      expect(body.photo_url).toContain("/images/drafts/");
      expect(body.photo_url).toContain(owner.userId);
      expect(body.expires_at_unix).toBeGreaterThan(Math.floor(refMs / 1000));

      // Critically: NO deviation field on the response. The whole
      // anti-cheat point is that the user can adjust HH/MM/SS
      // without seeing the deviation those adjustments would
      // produce.
      expect(body).not.toHaveProperty("deviation_seconds");

      // No reading row should have been written yet.
      const db = (env as unknown as TestEnv).DB;
      const rows = await db
        .prepare("SELECT id FROM readings WHERE watch_id = ?")
        .bind(watchId)
        .all();
      expect(rows.results.length).toBe(0);
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "writes the photo to the drafts/ R2 prefix",
    async () => {
      const truth = SMOKE_TRUTH["bambino_10_19_34.jpeg"]!;
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Drafts prefix", movement_id: movementId },
        owner.cookie,
      );
      const res = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DraftResponse;

      // The photo_url ends with the R2 key — extract and verify.
      const r2Key = new URL(body.photo_url).pathname.replace(/^\/images\//, "");
      expect(r2Key.startsWith(`drafts/${owner.userId}/`)).toBe(true);
      const r2 = (env as unknown as TestEnv).WATCH_IMAGES;
      const stored = await r2.get(r2Key);
      expect(stored).not.toBeNull();
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "falls back to server-arrival timestamp when EXIF is missing",
    async () => {
      // Pin server time; return null EXIF.
      const refMs = Date.UTC(2026, 3, 29, 14, 30, 15, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => null);
      installVlmMock({ m: 30, s: 15 });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "No EXIF", movement_id: movementId },
        owner.cookie,
      );
      const res = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DraftResponse;
      expect(body.reference_source).toBe("server");
      // Server arrival 14:30:15 UTC → 12-hour h = ((14+11)%12)+1 = 2.
      expect(body.predicted_hms).toEqual({ h: 2, m: 30, s: 15 });
    },
    VERIFIED_TIMEOUT,
  );

  // ---- client_capture_ms (PR #124, fixes upload-latency bias) ----
  //
  // The SPA's canvas-resize step strips EXIF, so the byte-EXIF path
  // is structurally dead in production for the verified-reading flow.
  // The SPA now reads EXIF DateTimeOriginal from the ORIGINAL bytes
  // BEFORE the resize, falls back to `Date.now()` at file selection
  // when EXIF is missing (HEIC/screenshots), and sends the result as
  // a multipart `client_capture_ms` field. Server bounds it the same
  // way as byte-EXIF (±5min/+1min) — same anti-cheat ceiling, much
  // better accuracy.

  it(
    "uses client_capture_ms as the reference when present and in-bounds",
    async () => {
      const arrivalMs = Date.UTC(2026, 3, 29, 14, 30, 28, 0);
      const captureMs = arrivalMs - 8000; // 8 s before arrival (typical upload)
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(arrivalMs);
      __setTestExifReader(async () => null);
      installVlmMock({ m: 30, s: 22 }); // dial reads 30:22

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Client capture ms", movement_id: movementId },
        owner.cookie,
      );
      const res = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie, {
        clientCaptureMs: captureMs,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as DraftResponse;
      expect(body.reference_source).toBe("client");
      // captureMs at 14:30:20 UTC → 12-hour h = ((14+11)%12)+1 = 2,
      // m = 30 (verifier carries through the VLM mm:ss for predicted_hms).
      expect(body.predicted_hms).toEqual({ h: 2, m: 30, s: 22 });
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "client_capture_ms takes precedence over byte-EXIF when both present",
    async () => {
      const arrivalMs = Date.UTC(2026, 3, 29, 14, 30, 30, 0);
      const exifMs = arrivalMs - 4000;
      const clientMs = arrivalMs - 12000; // 12 s before arrival
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(arrivalMs);
      __setTestExifReader(async () => exifMs); // would otherwise win
      installVlmMock({ m: 30, s: 18 });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Client wins", movement_id: movementId },
        owner.cookie,
      );
      const res = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie, {
        clientCaptureMs: clientMs,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as DraftResponse;
      expect(body.reference_source).toBe("client");
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "returns 422 exif_clock_skew when client_capture_ms is more than 5 min in the past",
    async () => {
      const arrivalMs = Date.UTC(2026, 3, 29, 14, 30, 30, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(arrivalMs);
      __setTestExifReader(async () => null);
      installVlmMock({ m: 30, s: 0 });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Stale client capture", movement_id: movementId },
        owner.cookie,
      );
      const res = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie, {
        clientCaptureMs: arrivalMs - 6 * 60 * 1000,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("exif_clock_skew");
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "returns 400 invalid_input when client_capture_ms is not a finite number",
    async () => {
      __setTestExifReader(async () => null);
      installVlmMock({ m: 30, s: 0 });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Bad client capture", movement_id: movementId },
        owner.cookie,
      );
      const bytes = fixtureBytes("bambino_10_19_34.jpeg");
      const form = new FormData();
      form.append(
        "image",
        new File([bytes], "bambino_10_19_34.jpeg", { type: "image/jpeg" }),
      );
      form.append("client_capture_ms", "not-a-number");
      const res = await exports.default.fetch(
        new Request(
          `https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified/draft`,
          { method: "POST", headers: { cookie: owner.cookie }, body: form },
        ),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("invalid_input");
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "returns 422 with retake reason on VLM unparseable",
    async () => {
      __setTestExifReader(async () => Date.now());
      // Slice #5: 2-or-more unparseable reads collapse into a
      // `rejection: unparseable_majority`. The verifier maps that to
      // `ai_unparseable` for back-compat with the SPA.
      __setTestReadDial(async () => ({
        kind: "rejection",
        reason: "unparseable_majority",
      }));

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Unparseable", movement_id: movementId },
        owner.cookie,
      );
      const res = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        error_code?: string;
        retake?: boolean;
        reason?: string;
      };
      expect(body.error_code).toBe("ai_unparseable");
      expect(body.retake).toBe(true);
      expect(body.reason).toBe("unreadable_photo");
    },
    VERIFIED_TIMEOUT,
  );

  it("returns 401 when unauthenticated", async () => {
    const res = await exports.default.fetch(
      new Request(
        "https://ratedwatch.test/api/v1/watches/whatever/readings/verified/draft",
        { method: "POST", body: new FormData() },
      ),
    );
    expect(res.status).toBe(401);
  });

  it(
    "returns 400 image_required when the form has no image",
    async () => {
      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Empty form", movement_id: movementId },
        owner.cookie,
      );
      const form = new FormData();
      const res = await exports.default.fetch(
        new Request(
          `https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified/draft`,
          {
            method: "POST",
            headers: { cookie: owner.cookie },
            body: form,
          },
        ),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("image_required");
    },
    VERIFIED_TIMEOUT,
  );
});

describe("POST /api/v1/watches/:id/readings/verified/confirm", () => {
  it(
    "saves a verified reading with the user's final_hms",
    async () => {
      const truth = SMOKE_TRUTH["bambino_10_19_34.jpeg"]!;
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Confirm happy", movement_id: movementId },
        owner.cookie,
      );

      const draftRes = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      expect(draftRes.status).toBe(200);
      const draftBody = (await draftRes.json()) as DraftResponse;

      // User keeps the predicted hour + minute, nudges seconds +5.
      const finalHms = {
        h: draftBody.predicted_hms.h,
        m: truth.mm,
        s: truth.ss + 5,
      };
      const confirmRes = await postConfirm(
        watchId,
        { reading_token: draftBody.reading_token, final_hms: finalHms },
        owner.cookie,
      );
      expect(confirmRes.status).toBe(201);
      const reading = (await confirmRes.json()) as ReadingResponseBody;
      expect(reading.watch_id).toBe(watchId);
      expect(reading.user_id).toBe(owner.userId);
      expect(reading.verified).toBe(true);
      expect(reading.is_baseline).toBe(false);
      // Final user-submitted hms matches the anchor + 5s, so
      // deviation should be +5.
      expect(reading.deviation_seconds).toBe(5);

      // Persisted-row checks.
      const db = (env as unknown as TestEnv).DB;
      const row = (await db
        .prepare(
          "SELECT id, vlm_model, photo_r2_key, verified, reference_timestamp, deviation_seconds FROM readings WHERE id = ?",
        )
        .bind(reading.id)
        .first()) as PersistedRow | null;
      expect(row).not.toBeNull();
      expect(row!.vlm_model).toBe("openai/gpt-5.2");
      expect(row!.verified).toBe(1);
      expect(row!.photo_r2_key).toBe(`verified/${owner.userId}/${reading.id}.jpg`);
      // The token now carries reference_ms exactly, so the saved
      // reference_timestamp is the exact capture time (not a
      // reconstructed approximation).
      expect(row!.reference_timestamp).toBe(refMs);

      // Photo moved from drafts/ to verified/.
      const r2 = (env as unknown as TestEnv).WATCH_IMAGES;
      const verifiedPhoto = await r2.get(row!.photo_r2_key!);
      expect(verifiedPhoto).not.toBeNull();
      // Draft key should no longer exist.
      const draftKey = new URL(draftBody.photo_url).pathname.replace(/^\/images\//, "");
      const draftPhoto = await r2.get(draftKey);
      expect(draftPhoto).toBeNull();
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "forces deviation to 0 when is_baseline=true",
    async () => {
      const truth = SMOKE_TRUTH["bambino_10_19_34.jpeg"]!;
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Baseline", movement_id: movementId },
        owner.cookie,
      );
      const draftRes = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      const draftBody = (await draftRes.json()) as DraftResponse;
      const confirmRes = await postConfirm(
        watchId,
        {
          reading_token: draftBody.reading_token,
          // User adjusts +10s but baseline overrides → deviation 0.
          final_hms: {
            h: draftBody.predicted_hms.h,
            m: truth.mm,
            s: truth.ss + 10,
          },
          is_baseline: true,
        },
        owner.cookie,
      );
      expect(confirmRes.status).toBe(201);
      const reading = (await confirmRes.json()) as ReadingResponseBody;
      expect(reading.is_baseline).toBe(true);
      expect(reading.deviation_seconds).toBe(0);
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "accepts arbitrarily large adjustments (no ±30s cap any more)",
    async () => {
      // PR #122 removed the ±30s cap. The server now accepts any
      // well-shaped HH:MM:SS triple; the user is responsible for
      // entering what they see on the dial. This test guards
      // against accidental reintroduction of a server-side cap.
      const truth = SMOKE_TRUTH["bambino_10_19_34.jpeg"]!;
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "No cap", movement_id: movementId },
        owner.cookie,
      );
      const draftRes = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      const draftBody = (await draftRes.json()) as DraftResponse;

      // User claims their watch is 4 minutes ahead of the
      // prediction — would have been rejected by the old ±30s cap,
      // accepted now.
      const confirmRes = await postConfirm(
        watchId,
        {
          reading_token: draftBody.reading_token,
          final_hms: {
            h: draftBody.predicted_hms.h,
            m: (truth.mm + 4) % 60,
            s: truth.ss,
          },
        },
        owner.cookie,
      );
      expect(confirmRes.status).toBe(201);
      const reading = (await confirmRes.json()) as ReadingResponseBody;
      // 4 minutes = 240s. Same hour + same seconds + minutes +4.
      expect(reading.deviation_seconds).toBe(240);
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "computes deviation across hour adjustments via 12-hour wrap",
    async () => {
      // Reference is 10:19:34. User asserts their watch shows
      // 11:19:34 — meaning it's 1 hour fast. Deviation should be
      // +3600s (one hour).
      const truth = SMOKE_TRUTH["bambino_10_19_34.jpeg"]!;
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Hour adjust", movement_id: movementId },
        owner.cookie,
      );
      const draftRes = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      const draftBody = (await draftRes.json()) as DraftResponse;

      const confirmRes = await postConfirm(
        watchId,
        {
          reading_token: draftBody.reading_token,
          final_hms: {
            // Predicted h is 10 (12-hour); user nudges to 11.
            h: (draftBody.predicted_hms.h % 12) + 1 || 1,
            m: truth.mm,
            s: truth.ss,
          },
        },
        owner.cookie,
      );
      expect(confirmRes.status).toBe(201);
      const reading = (await confirmRes.json()) as ReadingResponseBody;
      expect(reading.deviation_seconds).toBe(3600);
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "rejects an expired token with 401",
    async () => {
      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Expired token", movement_id: movementId },
        owner.cookie,
      );
      // Mint an already-expired token directly. We use the same
      // secret the worker has via miniflare bindings.
      const secret = (env as unknown as TestEnv).READING_TOKEN_SECRET;
      const expiredPayload: ReadingTokenPayload = {
        photo_r2_key: `drafts/${owner.userId}/fake.jpg`,
        anchor_hms: "10:00:00",
        reference_ms: Date.now(),
        predicted_hms: { h: 10, m: 0, s: 30 },
        user_id: owner.userId,
        watch_id: watchId,
        expires_at_unix: Math.floor(Date.now() / 1000) - 1,
        vlm_model: "openai/gpt-5.2",
      };
      const expiredToken = await signReadingToken(expiredPayload, secret);
      const res = await postConfirm(
        watchId,
        { reading_token: expiredToken, final_hms: { h: 10, m: 0, s: 30 } },
        owner.cookie,
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_token");
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "rejects a token with a flipped signature byte as 401",
    async () => {
      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Bad sig", movement_id: movementId },
        owner.cookie,
      );
      const secret = (env as unknown as TestEnv).READING_TOKEN_SECRET;
      const validToken = await signReadingToken(
        {
          photo_r2_key: `drafts/${owner.userId}/fake.jpg`,
          anchor_hms: "10:00:00",
          reference_ms: Date.now(),
          predicted_hms: { h: 10, m: 0, s: 30 },
          user_id: owner.userId,
          watch_id: watchId,
          expires_at_unix: Math.floor(Date.now() / 1000) + 60,
          vlm_model: "openai/gpt-5.2",
        },
        secret,
      );
      const dot = validToken.indexOf(".");
      const tampered = `${validToken.slice(0, dot)}.${
        validToken[dot + 1] === "A"
          ? "B" + validToken.slice(dot + 2)
          : "A" + validToken.slice(dot + 2)
      }`;
      const res = await postConfirm(
        watchId,
        { reading_token: tampered, final_hms: { h: 10, m: 0, s: 30 } },
        owner.cookie,
      );
      expect(res.status).toBe(401);
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "rejects a token signed for a different watch with 403",
    async () => {
      const owner = await registerAndGetCookie();
      const { id: watchA } = await createWatch(
        { name: "Watch A", movement_id: movementId },
        owner.cookie,
      );
      const { id: watchB } = await createWatch(
        { name: "Watch B", movement_id: movementId },
        owner.cookie,
      );
      const secret = (env as unknown as TestEnv).READING_TOKEN_SECRET;
      // Token signed for watchA but submitted to watchB.
      const tokenForA = await signReadingToken(
        {
          photo_r2_key: `drafts/${owner.userId}/fake.jpg`,
          anchor_hms: "10:00:00",
          reference_ms: Date.now(),
          predicted_hms: { h: 10, m: 0, s: 30 },
          user_id: owner.userId,
          watch_id: watchA,
          expires_at_unix: Math.floor(Date.now() / 1000) + 60,
          vlm_model: "openai/gpt-5.2",
        },
        secret,
      );
      const res = await postConfirm(
        watchB,
        { reading_token: tokenForA, final_hms: { h: 10, m: 0, s: 30 } },
        owner.cookie,
      );
      expect(res.status).toBe(403);
    },
    VERIFIED_TIMEOUT,
  );

  it("returns 401 when unauthenticated", async () => {
    const res = await exports.default.fetch(
      new Request(
        "https://ratedwatch.test/api/v1/watches/whatever/readings/verified/confirm",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reading_token: "x.y",
            final_hms: { h: 1, m: 0, s: 0 },
          }),
        },
      ),
    );
    expect(res.status).toBe(401);
  });

  it(
    "returns 400 invalid_input on bad request body",
    async () => {
      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Bad body", movement_id: movementId },
        owner.cookie,
      );
      const res = await postConfirm(
        watchId,
        // @ts-expect-error — deliberately bad shape
        { reading_token: 42, final_hms: "nope" },
        owner.cookie,
      );
      expect(res.status).toBe(400);
    },
    VERIFIED_TIMEOUT,
  );
});
