// Integration tests for POST /api/v1/watches/:id/readings/manual_with_photo
// (slice #80, PRD #73 User Story #10).
//
// Covers the round-trip a user takes after the dial reader rejects a
// photo and they fall back to typing the time:
//
//   * Multipart upload with image + hh/mm/ss → 201, reading row
//     persisted with verified=0 and photo_r2_key populated, dial
//     reader columns NULL.
//   * Reference timestamp resolution mirrors the verified flow
//     (EXIF → server arrival fallback) — pinned via the
//     `__setTestExifReader` hook.
//   * Field validation: bogus hh/mm/ss → 422.
//   * Auth required (401), watch ownership enforced (403/404).

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { __setTestExifReader } from "@/domain/reading-verifier/exif";

// ---- Fixture ------------------------------------------------------

const movementId = "test-mwp-eta-2824";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      movementId,
      "Test ETA 2824 (manual_with_photo)",
      "ETA",
      "2824 (manual_with_photo)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

afterEach(() => {
  __setTestExifReader(null);
  vi.useRealTimers();
});

// ---- Auth + watch helpers -----------------------------------------

function makeEmail(prefix = "mwp"): string {
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

interface PostOptions {
  hh?: number | string;
  mm?: number | string;
  ss?: number | string;
  isBaseline?: boolean;
  notes?: string;
  image?: Uint8Array;
  // Allow omitting the image on purpose to test the validation branch.
  omitImage?: boolean;
}

async function postManualWithPhoto(
  watchId: string,
  cookie: string | undefined,
  opts: PostOptions = {},
): Promise<Response> {
  const body = new FormData();
  if (!opts.omitImage) {
    const imageBytes = opts.image ?? tinyJpegBytes();
    body.append("image", new Blob([imageBytes], { type: "image/jpeg" }), "dial.jpg");
  }
  if (opts.hh !== undefined) body.append("hh", String(opts.hh));
  if (opts.mm !== undefined) body.append("mm", String(opts.mm));
  if (opts.ss !== undefined) body.append("ss", String(opts.ss));
  if (opts.isBaseline !== undefined) {
    body.append("is_baseline", String(opts.isBaseline));
  }
  if (opts.notes !== undefined) {
    body.append("notes", opts.notes);
  }
  return exports.default.fetch(
    new Request(
      `https://ratedwatch.test/api/v1/watches/${watchId}/readings/manual_with_photo`,
      {
        method: "POST",
        headers: cookie ? { cookie } : {},
        body,
      },
    ),
  );
}

// ---- Tests --------------------------------------------------------

const TWO_USER_TIMEOUT = 30_000;

describe("POST /api/v1/watches/:id/readings/manual_with_photo", () => {
  it("persists a manual reading + photo + leaves dial-reader columns NULL", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "MWP1", movement_id: movementId },
      user.cookie,
    );

    // Freeze Date.now() so the reference clock is deterministic.
    // 14:32:05 UTC. User types 14:32:10 → +5s drift.
    const refTime = Date.UTC(2024, 0, 15, 14, 32, 5);
    vi.useFakeTimers();
    vi.setSystemTime(refTime);

    const probeBytes = new Uint8Array([0xff, 0xd8, 0xab, 0xcd, 0xff, 0xd9]);
    const res = await postManualWithPhoto(watchId, user.cookie, {
      hh: 14,
      mm: 32,
      ss: 10,
      image: probeBytes,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      verified: boolean;
      deviation_seconds: number;
      reference_timestamp: number;
      is_baseline: boolean;
    };
    // The route MUST NOT mark this verified — it's still a typed
    // reading, the photo is just evidence.
    expect(body.verified).toBe(false);
    expect(body.is_baseline).toBe(false);
    // Without EXIF the route falls back to server arrival.
    expect(body.reference_timestamp).toBe(refTime);
    expect(body.deviation_seconds).toBe(5);

    // Photo lands in R2 at the expected key.
    const IMAGES = (env as unknown as { IMAGES: R2Bucket }).IMAGES;
    const obj = await IMAGES.get(`readings/${body.id}/photo.jpg`);
    expect(obj).not.toBeNull();
    expect(Array.from(new Uint8Array(await obj!.arrayBuffer()))).toEqual(
      Array.from(probeBytes),
    );

    // Direct DB assertion: photo_r2_key is set, dial_reader_* are NULL,
    // and the row is verified=0. This is the contract that tells the
    // operator this is a manual_with_photo row vs a verified one.
    const DB = (env as unknown as { DB: D1Database }).DB;
    const row = await DB.prepare(
      "SELECT verified, photo_r2_key, dial_reader_confidence, dial_reader_version FROM readings WHERE id = ?",
    )
      .bind(body.id)
      .first<{
        verified: number;
        photo_r2_key: string | null;
        dial_reader_confidence: number | null;
        dial_reader_version: string | null;
      }>();
    expect(row).not.toBeNull();
    expect(row!.verified).toBe(0);
    expect(row!.photo_r2_key).toBe(`readings/${body.id}/photo.jpg`);
    expect(row!.dial_reader_confidence).toBeNull();
    expect(row!.dial_reader_version).toBeNull();
  });

  it("uses EXIF DateTimeOriginal as reference when present and in bounds", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "MWP2", movement_id: movementId },
      user.cookie,
    );

    const serverTime = Date.UTC(2024, 0, 15, 14, 32, 30);
    const exifTime = serverTime - 8000; // 14:32:22 — within bounds
    vi.useFakeTimers();
    vi.setSystemTime(serverTime);
    __setTestExifReader(async () => exifTime);

    // User types the dial as 14:32:22 — matches the EXIF reference
    // exactly, so deviation should be 0. This pins down that the
    // reference is the EXIF time, NOT the server arrival.
    const res = await postManualWithPhoto(watchId, user.cookie, {
      hh: 14,
      mm: 32,
      ss: 22,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      reference_timestamp: number;
      deviation_seconds: number;
    };
    expect(body.reference_timestamp).toBe(exifTime);
    expect(body.deviation_seconds).toBe(0);
  });

  it("rejects an EXIF that's too old as 422 exif_clock_skew", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "MWP3", movement_id: movementId },
      user.cookie,
    );
    const serverTime = Date.UTC(2024, 0, 15, 14, 32, 30);
    vi.useFakeTimers();
    vi.setSystemTime(serverTime);
    __setTestExifReader(async () => serverTime - 10 * 60 * 1000);

    const res = await postManualWithPhoto(watchId, user.cookie, {
      hh: 14,
      mm: 32,
      ss: 30,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("exif_clock_skew");
  });

  it("forces deviation to 0 when is_baseline=true", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "MWP4", movement_id: movementId },
      user.cookie,
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2024, 0, 15, 10, 0, 0));

    // User types 10:00:25 — but baseline=true, so we lock deviation
    // to 0 regardless (mirrors the verifier and the manual route).
    const res = await postManualWithPhoto(watchId, user.cookie, {
      hh: 10,
      mm: 0,
      ss: 25,
      isBaseline: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      is_baseline: boolean;
      deviation_seconds: number;
    };
    expect(body.is_baseline).toBe(true);
    expect(body.deviation_seconds).toBe(0);
  });

  it("rejects out-of-range hh/mm/ss with 422 invalid_input", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "MWP5", movement_id: movementId },
      user.cookie,
    );
    const res = await postManualWithPhoto(watchId, user.cookie, {
      hh: 99,
      mm: 0,
      ss: 0,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("invalid_input");
    expect(body.fieldErrors.hh).toMatch(/0–23/);
  });

  it("rejects non-integer mm with 422 invalid_input", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "MWP6", movement_id: movementId },
      user.cookie,
    );
    const res = await postManualWithPhoto(watchId, user.cookie, {
      hh: 12,
      mm: 30.5,
      ss: 0,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.mm).toMatch(/integer/);
  });

  it("rejects a missing image with 400 image_required", async () => {
    const user = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "MWP7", movement_id: movementId },
      user.cookie,
    );
    const res = await postManualWithPhoto(watchId, user.cookie, {
      hh: 12,
      mm: 0,
      ss: 0,
      omitImage: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("image_required");
  });

  it("requires authentication (401)", async () => {
    const res = await postManualWithPhoto("anything", undefined, {
      hh: 12,
      mm: 0,
      ss: 0,
    });
    expect(res.status).toBe(401);
  });

  it(
    "forbids posting to a watch you don't own (403)",
    async () => {
      const owner = await registerAndGetCookie();
      const intruder = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Theirs", movement_id: movementId },
        owner.cookie,
      );
      const res = await postManualWithPhoto(watchId, intruder.cookie, {
        hh: 12,
        mm: 0,
        ss: 0,
      });
      expect(res.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );
});
