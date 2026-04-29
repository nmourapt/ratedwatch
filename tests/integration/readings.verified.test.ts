// Integration tests for POST /api/v1/watches/:id/readings/verified.
//
// Slice #4 of PRD #99 (issue #103). The route was a 503 stub before
// this slice; this test exercises the new VLM-backed pipeline
// end-to-end:
//
//   * Better Auth signup + sign-in (real flow under miniflare)
//   * watch creation
//   * multipart upload of a real smoke fixture (from
//     scripts/vlm-bakeoff/fixtures/smoke/)
//   * route handler → reading-verifier → dial-cropper → dial-reader-vlm
//   * D1 INSERT of the resulting `readings` row with vlm_model + photo_r2_key
//   * R2 PUT for the photo at verified/{userId}/{readingId}.jpg
//
// The VLM call itself is intercepted via `__setTestReadDial` rather
// than hitting the real AI Gateway. Three reasons:
//
//   1. The vitest pool is configured with `remoteBindings: false`
//      (vitest.config.ts), so env.AI in tests cannot reach the
//      gateway from miniflare anyway.
//   2. CI cost — the bake-off proved the model behaviour; we don't
//      need to re-prove it on every PR. Slice #4's job is wiring,
//      not VLM accuracy.
//   3. Determinism — model variance ±0-5s is fine in production
//      (the deviation_seconds ends up correct within tolerance) but
//      flaky on the test boundary.
//
// The mock returns the bake-off-validated MM:SS for each fixture
// (drawn from scripts/vlm-bakeoff/fixtures/smoke/manifest.json),
// which matches what GPT-5.2 produced in the bake-off. The
// reading-verifier code path executed is identical to production
// — only the network egress is short-circuited.
//
// A separate, opt-in `.live.test.ts` file (added in a later slice
// alongside the rest of the live-tests suite) can re-enable the
// real-API path for canary runs against a deployed preview.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { __setTestReadDial } from "@/domain/dial-reader-vlm/reader";
import { __setTestExifReader } from "@/domain/reading-verifier/exif";
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

// ---- Auth + watch helpers (mirror tests/integration/readings.test.ts) ----

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

/**
 * Bake-off-validated truth for the smoke fixtures. Mirrors
 * `scripts/vlm-bakeoff/fixtures/smoke/manifest.json` (the `.mm` and
 * `.ss` columns) — the ±5s tolerance the test asserts against.
 */
const SMOKE_TRUTH: Record<string, { hh: number; mm: number; ss: number }> = {
  "bambino_10_19_34.jpeg": { hh: 10, mm: 19, ss: 34 },
  "snk803_10_15_40.jpeg": { hh: 10, mm: 15, ss: 40 },
};

async function postVerifiedReading(
  watchId: string,
  fixtureName: string,
  cookie: string,
  isBaseline = false,
): Promise<Response> {
  const bytes = fixtureBytes(fixtureName);
  const form = new FormData();
  const file = new File([bytes], fixtureName, { type: "image/jpeg" });
  form.append("image", file);
  form.append("is_baseline", isBaseline ? "true" : "false");
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified`, {
      method: "POST",
      headers: { cookie },
      body: form,
    }),
  );
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

/**
 * Install a deterministic VLM mock that returns the bake-off truth
 * for whichever fixture got cropped through the pipeline. The
 * matcher works on the cropped image's *byte length* against the
 * `expected` map — admittedly hacky, but the alternative (peeking
 * at the input bytes pre-crop) would force us to re-decode the
 * image inside the test. The cropped JPEG sizes are stable enough
 * across miniflare runs that an exact match is fine for two
 * fixtures; if this becomes flaky we'll switch to a single-fixture
 * test that does NOT need the matcher.
 *
 * Simpler alternative: drive each test through one fixture only,
 * setting the mock to return that fixture's truth unconditionally.
 * That's what we actually do below — no matcher, just a fresh mock
 * per test.
 */
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

// ---- Tests ---------------------------------------------------------

const VERIFIED_TIMEOUT = 30_000;

describe("POST /api/v1/watches/:id/readings/verified", () => {
  it.each([["bambino_10_19_34.jpeg"], ["snk803_10_15_40.jpeg"]])(
    "creates a verified reading from %s end-to-end",
    async (fixtureName) => {
      const truth = SMOKE_TRUTH[fixtureName]!;
      // Pin the reference timestamp so the deviation calc is
      // deterministic. We pick a moment whose UTC MM:SS match the
      // fixture truth — that way the dial-vs-reference deviation
      // is exactly 0s and the ±5s tolerance is on the model side
      // alone.
      //
      // Both the EXIF reader and the server clock have to align
      // (the verifier rejects EXIF with a > 5min delta vs server),
      // so we vi.setSystemTime + __setTestExifReader to the same
      // value. Better Auth's getSession does its own JWT verify on
      // a frozen clock, so we keep `shouldAdvanceTime: true` to
      // avoid stalling the cookie roundtrip.
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

      const res = await postVerifiedReading(watchId, fixtureName, owner.cookie);
      expect(res.status).toBe(201);
      const body = (await res.json()) as ReadingResponseBody;
      expect(body.watch_id).toBe(watchId);
      expect(body.user_id).toBe(owner.userId);
      expect(body.verified).toBe(true);
      expect(body.is_baseline).toBe(false);

      // Deviation should be within ±5s of zero (exact zero on this
      // mock; tolerance left for the real-API live tests). We
      // assert the wider window so a future tweak to either side
      // doesn't create a false negative.
      expect(body.deviation_seconds).toBeGreaterThanOrEqual(-5);
      expect(body.deviation_seconds).toBeLessThanOrEqual(5);

      // Persisted-row checks: vlm_model recorded, photo R2 key set.
      const db = (env as unknown as TestEnv).DB;
      const row = (await db
        .prepare(
          "SELECT id, vlm_model, photo_r2_key, verified, reference_timestamp, deviation_seconds FROM readings WHERE id = ?",
        )
        .bind(body.id)
        .first()) as PersistedRow | null;
      expect(row).not.toBeNull();
      expect(row!.vlm_model).toBe("openai/gpt-5.2");
      expect(row!.verified).toBe(1);
      expect(row!.reference_timestamp).toBe(refMs);
      expect(row!.photo_r2_key).toBe(`verified/${owner.userId}/${body.id}.jpg`);

      // R2 verification: the photo bytes round-tripped.
      const r2 = (env as unknown as TestEnv).WATCH_IMAGES;
      const stored = await r2.get(row!.photo_r2_key!);
      expect(stored).not.toBeNull();
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "forces deviation to 0 when is_baseline=true",
    async () => {
      const truth = SMOKE_TRUTH["bambino_10_19_34.jpeg"]!;
      // Pick a reference time 10s OFF the fixture so the verifier
      // would normally compute a non-zero deviation. With
      // is_baseline=true the route must override it to 0.
      const refMs = Date.UTC(2026, 3, 29, truth.hh, truth.mm, truth.ss + 10, 0);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(refMs);
      __setTestExifReader(async () => refMs);
      installVlmMock({ m: truth.mm, s: truth.ss });

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Baseline test", movement_id: movementId },
        owner.cookie,
      );

      const res = await postVerifiedReading(
        watchId,
        "bambino_10_19_34.jpeg",
        owner.cookie,
        /* isBaseline */ true,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as ReadingResponseBody;
      expect(body.is_baseline).toBe(true);
      expect(body.deviation_seconds).toBe(0);
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "returns 422 ai_unparseable when the VLM returns gibberish",
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
        { name: "Unparseable test", movement_id: movementId },
        owner.cookie,
      );
      const res = await postVerifiedReading(
        watchId,
        "bambino_10_19_34.jpeg",
        owner.cookie,
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error_code?: string; ux_hint?: string };
      expect(body.error_code).toBe("ai_unparseable");
    },
    VERIFIED_TIMEOUT,
  );

  it(
    "returns 502 dial_reader_transport_error on VLM transport failure",
    async () => {
      __setTestExifReader(async () => Date.now());
      __setTestReadDial(async () => ({
        kind: "transport_error",
        message: "AI Gateway timeout",
      }));

      const owner = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Transport test", movement_id: movementId },
        owner.cookie,
      );
      const res = await postVerifiedReading(
        watchId,
        "bambino_10_19_34.jpeg",
        owner.cookie,
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error_code?: string };
      expect(body.error_code).toBe("dial_reader_transport_error");
    },
    VERIFIED_TIMEOUT,
  );

  it("returns 401 when unauthenticated", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/watches/whatever/readings/verified", {
        method: "POST",
        body: new FormData(),
      }),
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
          `https://ratedwatch.test/api/v1/watches/${watchId}/readings/verified`,
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
