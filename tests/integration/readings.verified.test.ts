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
): Promise<Response> {
  const bytes = fixtureBytes(fixtureName);
  const form = new FormData();
  const file = new File([bytes], fixtureName, { type: "image/jpeg" });
  form.append("image", file);
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
    final_mm_ss: { m: number; s: number };
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
  predicted_mm_ss: { m: number; s: number };
  photo_url: string;
  hour_from_server_clock: number;
  reference_source: "exif" | "server";
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
    "returns reading_token + predicted_mm_ss for %s",
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
      expect(body.predicted_mm_ss).toEqual({ m: truth.mm, s: truth.ss });
      expect(body.hour_from_server_clock).toBe(truth.hh);
      expect(body.photo_url).toContain("/images/drafts/");
      expect(body.photo_url).toContain(owner.userId);
      expect(body.expires_at_unix).toBeGreaterThan(Math.floor(refMs / 1000));

      // Critically: NO deviation field on the response. The whole
      // anti-cheat point is that the user can adjust ± seconds
      // without seeing the deviation it would produce.
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
      expect(body.hour_from_server_clock).toBe(14);
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
    "saves a verified reading with the user's final_mm_ss",
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

      // User adjusts +5s from the prediction. That's well within
      // the ±30s cap, so confirm should accept.
      const finalMmSs = { m: truth.mm, s: truth.ss + 5 };
      const confirmRes = await postConfirm(
        watchId,
        { reading_token: draftBody.reading_token, final_mm_ss: finalMmSs },
        owner.cookie,
      );
      expect(confirmRes.status).toBe(201);
      const reading = (await confirmRes.json()) as ReadingResponseBody;
      expect(reading.watch_id).toBe(watchId);
      expect(reading.user_id).toBe(owner.userId);
      expect(reading.verified).toBe(true);
      expect(reading.is_baseline).toBe(false);
      // Final user-submitted mm:ss matches the anchor + 5s, so
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
          // User adjusts to +10s but baseline overrides → 0.
          final_mm_ss: { m: truth.mm, s: truth.ss + 10 },
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
    "accepts a final_mm_ss exactly 30s from predicted",
    async () => {
      const truth = SMOKE_TRUTH["bambino_10_19_34.jpeg"]!;
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "30s boundary", movement_id: movementId },
        owner.cookie,
      );
      const draftRes = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      const draftBody = (await draftRes.json()) as DraftResponse;
      // truth.ss = 34, +30 = 64 → wraps to m+1 / s=4
      const finalSs = (truth.ss + 30) % 60;
      const finalMm = truth.mm + Math.floor((truth.ss + 30) / 60);
      const confirmRes = await postConfirm(
        watchId,
        {
          reading_token: draftBody.reading_token,
          final_mm_ss: { m: finalMm, s: finalSs },
        },
        owner.cookie,
      );
      expect(confirmRes.status).toBe(201);
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "rejects a final_mm_ss 31s from predicted as adjustment_too_large",
    async () => {
      const truth = SMOKE_TRUTH["bambino_10_19_34.jpeg"]!;
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "31s exceed", movement_id: movementId },
        owner.cookie,
      );
      const draftRes = await postDraft(watchId, "bambino_10_19_34.jpeg", owner.cookie);
      const draftBody = (await draftRes.json()) as DraftResponse;
      const finalSs = (truth.ss + 31) % 60;
      const finalMm = truth.mm + Math.floor((truth.ss + 31) / 60);
      const confirmRes = await postConfirm(
        watchId,
        {
          reading_token: draftBody.reading_token,
          final_mm_ss: { m: finalMm, s: finalSs },
        },
        owner.cookie,
      );
      expect(confirmRes.status).toBe(422);
      const body = (await confirmRes.json()) as {
        error: string;
        max_seconds: number;
      };
      expect(body.error).toBe("adjustment_too_large");
      expect(body.max_seconds).toBe(30);
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
        predicted_mm_ss: { m: 0, s: 30 },
        user_id: owner.userId,
        watch_id: watchId,
        expires_at_unix: Math.floor(Date.now() / 1000) - 1,
        vlm_model: "openai/gpt-5.2",
      };
      const expiredToken = await signReadingToken(expiredPayload, secret);
      const res = await postConfirm(
        watchId,
        { reading_token: expiredToken, final_mm_ss: { m: 0, s: 30 } },
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
          predicted_mm_ss: { m: 0, s: 30 },
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
        { reading_token: tampered, final_mm_ss: { m: 0, s: 30 } },
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
          predicted_mm_ss: { m: 0, s: 30 },
          user_id: owner.userId,
          watch_id: watchA,
          expires_at_unix: Math.floor(Date.now() / 1000) + 60,
          vlm_model: "openai/gpt-5.2",
        },
        secret,
      );
      const res = await postConfirm(
        watchB,
        { reading_token: tokenForA, final_mm_ss: { m: 0, s: 30 } },
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
            final_mm_ss: { m: 0, s: 0 },
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
        { reading_token: 42, final_mm_ss: "nope" },
        owner.cookie,
      );
      expect(res.status).toBe(400);
    },
    VERIFIED_TIMEOUT,
  );
});
