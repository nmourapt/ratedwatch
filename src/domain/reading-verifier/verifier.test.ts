import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, it, expect } from "vitest";
import { __setTestAiRunner, type AiRunner } from "@/domain/ai-dial-reader/runner";
import type { DialReaderEnv } from "@/domain/dial-reader";
import { __setTestExifReader } from "./exif";
import { computeVerifiedDeviation, verifyReading } from "./verifier";

// ---- Unit tests for the MM:SS drift-computation helper ------------
//
// The broader verifier pipeline is also exercised below (now that
// EXIF parsing has joined the pipeline and is hard to cover purely
// in integration tests) — but the math helper deserves its own block
// because it's a pure function and the boundary cases are dense.
//
// Contract: the dial reader returns `{ minutes, seconds }` (0-59
// each). The verifier wraps (dialMin*60 + dialSec) - (refMin*60 +
// refSec) into [-1800, +1800] seconds — a ±30 minute window. Any
// drift > 30 minutes in absolute value wraps (documented constraint;
// realistic mechanical drift never approaches that).

function tsFromHms(hh: number, mm: number, ss: number): number {
  // Anchor to an arbitrary UTC day so the math is hermetic to the
  // runner's local TZ. `computeVerifiedDeviation` derives MM:SS
  // from the ms timestamp via UTC getters, which is TZ-independent.
  return Date.UTC(2024, 0, 15, hh, mm, ss);
}

describe("computeVerifiedDeviation", () => {
  it("dial ahead of reference by 2s → +2", () => {
    expect(
      computeVerifiedDeviation({ minutes: 32, seconds: 7 }, tsFromHms(14, 32, 5)),
    ).toBe(2);
  });

  it("dial behind reference by 3s → -3", () => {
    expect(
      computeVerifiedDeviation({ minutes: 15, seconds: 0 }, tsFromHms(9, 15, 3)),
    ).toBe(-3);
  });

  it("dial ahead by a full minute + 5s → +65s", () => {
    // Dial shows 33:10 while reference reads 32:05 — watch is 65s
    // ahead. Seconds-only contract would have lost the minute.
    expect(
      computeVerifiedDeviation({ minutes: 33, seconds: 10 }, tsFromHms(14, 32, 5)),
    ).toBe(65);
  });

  it("dial behind by a full minute + 5s → -65s", () => {
    // Dial 31:00, reference 32:05 — watch is 65s behind.
    expect(
      computeVerifiedDeviation({ minutes: 31, seconds: 0 }, tsFromHms(14, 32, 5)),
    ).toBe(-65);
  });

  it("dial exactly matches → 0", () => {
    expect(computeVerifiedDeviation({ minutes: 0, seconds: 0 }, tsFromHms(0, 0, 0))).toBe(
      0,
    );
    expect(
      computeVerifiedDeviation({ minutes: 34, seconds: 30 }, tsFromHms(12, 34, 30)),
    ).toBe(0);
    expect(
      computeVerifiedDeviation({ minutes: 8, seconds: 59 }, tsFromHms(8, 8, 59)),
    ).toBe(0);
  });

  it("minute boundary: dial=0:02, ref=59:58 → +4s (not -3596s)", () => {
    // Dial has just rolled over the hour-boundary ahead of the
    // reference clock; raw diff is -3596; wrap yields +4.
    expect(
      computeVerifiedDeviation({ minutes: 0, seconds: 2 }, tsFromHms(23, 59, 58)),
    ).toBe(4);
  });

  it("minute boundary: dial=59:58, ref=0:02 → -4s", () => {
    // Reference has rolled over; dial is 4s behind.
    expect(
      computeVerifiedDeviation({ minutes: 59, seconds: 58 }, tsFromHms(0, 0, 2)),
    ).toBe(-4);
  });

  it("wraps true drifts > +30 minutes into the negative half", () => {
    // Dial 45:00, ref 0:00 → raw +2700s → wrap to -900s (-15 min).
    expect(
      computeVerifiedDeviation({ minutes: 45, seconds: 0 }, tsFromHms(14, 0, 0)),
    ).toBe(-900);
  });

  it("wraps true drifts < -30 minutes into the positive half", () => {
    // Dial 0:00, ref 45:00 → raw -2700s → wrap to +900s (+15 min).
    expect(
      computeVerifiedDeviation({ minutes: 0, seconds: 0 }, tsFromHms(14, 45, 0)),
    ).toBe(900);
  });

  it("handles drifts right at ±30 minutes deterministically", () => {
    // The wrap interval puts the half-period on a single side — we
    // don't care which, as long as it's deterministic.
    const result = computeVerifiedDeviation(
      { minutes: 30, seconds: 0 },
      tsFromHms(14, 0, 0),
    );
    expect(Math.abs(result)).toBe(1800);
  });

  it("never returns NaN, even with weird inputs", () => {
    const result = computeVerifiedDeviation(
      { minutes: 0, seconds: 0 },
      tsFromHms(12, 0, 0),
    );
    expect(Number.isFinite(result)).toBe(true);
  });

  it("tolerates out-of-range dial minutes/seconds without exploding", () => {
    // The reader shouldn't emit these (it validates 0-59 on each
    // field), but the helper shouldn't NaN/Infinity if it ever sees
    // one. The exact value isn't the contract — "finite, in
    // [-1800, +1800]" is.
    for (const mm of [-1, 0, 61]) {
      for (const ss of [-1, 0, 61]) {
        const result = computeVerifiedDeviation(
          { minutes: mm, seconds: ss },
          tsFromHms(0, 0, 0),
        );
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(-1800);
        expect(result).toBeLessThanOrEqual(1800);
      }
    }
  });
});

// ---- Pipeline tests for the EXIF-bound reference-timestamp logic --
//
// The verified-reading pipeline used to capture `Date.now()` *after*
// awaiting `c.req.formData()` — on cellular with a 2 MB photo that's
// 2-8 s of phantom drift baked into every reading. We now route the
// reference timestamp through EXIF DateTimeOriginal (the moment the
// shutter fired) bounded against server arrival time. EXIF outside
// the bounds is rejected; missing EXIF falls back to server arrival.
//
// These tests stub both the AI runner (so we don't need a real model)
// and the EXIF reader (so we don't need real EXIF-bearing fixtures)
// and drive `verifyReading` directly. They use the real D1 / R2 from
// vitest-pool-workers, but those are incidental — the contract under
// test is "what reference timestamp ends up in the row, and which
// telemetry events fire?".

// The verifier's input env now intersects DialReaderEnv so the CV
// branch (slice #75 of PRD #73) can reach `env.DIAL_READER`. The
// AI-only tests in this file never trigger the CV branch
// (`useDialReader` is undefined → falls through to the AI runner)
// so the binding doesn't need to exist at runtime; but TypeScript
// needs to see the field on the env object the tests pass in.
const VerifierEnv = env as unknown as {
  DB: D1Database;
  AI: Ai;
  IMAGES: R2Bucket;
  ANALYTICS: AnalyticsEngineDataset;
} & DialReaderEnv;

type DataPoint = AnalyticsEngineDataPoint;
let captured: DataPoint[] = [];
const originalWriteDataPoint = VerifierEnv.ANALYTICS.writeDataPoint.bind(
  VerifierEnv.ANALYTICS,
);

function eventsOfKind(kind: string): DataPoint[] {
  return captured.filter((dp) => Array.isArray(dp.indexes) && dp.indexes[0] === kind);
}

function payloadOf(dp: DataPoint): Record<string, unknown> {
  return JSON.parse(dp.blobs![1] as string) as Record<string, unknown>;
}

beforeAll(async () => {
  // Seed a movement + watch row so the verifier's DB INSERT has a
  // valid foreign key. Test rows live in a dedicated movement so we
  // don't collide with the integration suite.
  await VerifierEnv.DB.prepare(
    "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "verifier-unit-mvt",
      "Verifier Unit Mvt",
      "ETA",
      "U-1",
      "automatic",
      "approved",
      null,
    )
    .run();
});

afterEach(() => {
  __setTestAiRunner(null);
  __setTestExifReader(null);
  captured = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (VerifierEnv.ANALYTICS as any).writeDataPoint = originalWriteDataPoint;
});

function startCapture(): void {
  captured = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (VerifierEnv.ANALYTICS as any).writeDataPoint = (dp?: DataPoint) => {
    if (dp) {
      captured.push({ blobs: dp.blobs, indexes: dp.indexes, doubles: dp.doubles });
    }
    originalWriteDataPoint(dp);
  };
}

async function ensureUser(prefix = "verifier"): Promise<string> {
  const id = `${prefix}-${crypto.randomUUID()}`;
  // The user table is required because watches.user_id has a FK.
  // Better Auth normally creates the row; for these unit-style tests
  // we insert directly. Using INSERT OR IGNORE keeps the test idempotent.
  await VerifierEnv.DB.prepare(
    "INSERT OR IGNORE INTO user (id, name, username, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      "Verifier Unit",
      `verifier-${crypto.randomUUID().slice(0, 8)}`,
      `${id}@ratedwatch.test`,
      0,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  return id;
}

async function ensureWatch(userId: string): Promise<string> {
  const id = `wch-${crypto.randomUUID()}`;
  await VerifierEnv.DB.prepare(
    "INSERT INTO watches (id, user_id, name, movement_id, is_public) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, userId, "Verifier Unit Watch", "verifier-unit-mvt", 1)
    .run();
  return id;
}

function installFakeAi(response: string): void {
  const runner: AiRunner = async () => ({ response });
  __setTestAiRunner(runner);
}

function tinyJpegBuffer(): ArrayBuffer {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
}

const SERVER_ARRIVAL = Date.UTC(2024, 0, 15, 14, 32, 5);

describe("verifyReading — EXIF reference timestamp", () => {
  it("uses EXIF DateTimeOriginal as the reference when within bounds", async () => {
    // Case A: EXIF is 30 s old (well within the 5-minute window).
    // Reference must be the EXIF value, not the server-arrival time
    // we passed in.
    const userId = await ensureUser();
    const watchId = await ensureWatch(userId);
    const exifMs = SERVER_ARRIVAL - 30_000;
    __setTestExifReader(async () => exifMs);
    // AI returns "32:07" (matches the EXIF clock's MM:SS = 31:35).
    // But the deviation only depends on the dial vs the reference,
    // so feed the AI a value 2s ahead of the EXIF MM:SS.
    const exifMmSs = new Date(exifMs);
    installFakeAi(`${exifMmSs.getUTCMinutes()}:${exifMmSs.getUTCSeconds() + 2}`);
    startCapture();

    const result = await verifyReading({
      watchId,
      userId,
      imageBuffer: tinyJpegBuffer(),
      isBaseline: false,
      serverArrivalMs: SERVER_ARRIVAL,
      env: VerifierEnv,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.reference_timestamp).toBe(exifMs);
    expect(result.reading.deviation_seconds).toBe(2);

    const okEvents = eventsOfKind("verified_reading_exif_ok");
    expect(okEvents).toHaveLength(1);
    expect(payloadOf(okEvents[0]!)).toMatchObject({
      userId,
      watchId,
      delta_ms: -30_000,
    });
  });

  it("accepts EXIF exactly at the lower bound (-5 min)", async () => {
    // Case B: boundary is inclusive on accept side.
    const userId = await ensureUser();
    const watchId = await ensureWatch(userId);
    const exifMs = SERVER_ARRIVAL - 5 * 60 * 1000;
    __setTestExifReader(async () => exifMs);
    installFakeAi("0:0");
    startCapture();

    const result = await verifyReading({
      watchId,
      userId,
      imageBuffer: tinyJpegBuffer(),
      isBaseline: false,
      serverArrivalMs: SERVER_ARRIVAL,
      env: VerifierEnv,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.reference_timestamp).toBe(exifMs);
    expect(eventsOfKind("verified_reading_exif_ok")).toHaveLength(1);
  });

  it("rejects EXIF older than the lower bound (>5 min in the past)", async () => {
    // Case C: 5 min + 1 ms older — out.
    const userId = await ensureUser();
    const watchId = await ensureWatch(userId);
    const exifMs = SERVER_ARRIVAL - 5 * 60 * 1000 - 1;
    __setTestExifReader(async () => exifMs);
    installFakeAi("0:0");
    startCapture();

    const result = await verifyReading({
      watchId,
      userId,
      imageBuffer: tinyJpegBuffer(),
      isBaseline: false,
      serverArrivalMs: SERVER_ARRIVAL,
      env: VerifierEnv,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("exif_clock_skew");
    // raw_response should describe the direction of the skew —
    // "too old" is the user-actionable hint that the phone clock is
    // behind the server.
    expect(result.raw_response).toMatch(/too old/i);

    const skewEvents = eventsOfKind("verified_reading_exif_clock_skew");
    expect(skewEvents).toHaveLength(1);
    expect(payloadOf(skewEvents[0]!)).toMatchObject({
      userId,
      watchId,
      delta_ms: -(5 * 60 * 1000 + 1),
    });
  });

  it("rejects EXIF in the future beyond bounds (>1 min ahead)", async () => {
    // Case D: 1 min + 1 ms ahead — out.
    const userId = await ensureUser();
    const watchId = await ensureWatch(userId);
    const exifMs = SERVER_ARRIVAL + 1 * 60 * 1000 + 1;
    __setTestExifReader(async () => exifMs);
    installFakeAi("0:0");
    startCapture();

    const result = await verifyReading({
      watchId,
      userId,
      imageBuffer: tinyJpegBuffer(),
      isBaseline: false,
      serverArrivalMs: SERVER_ARRIVAL,
      env: VerifierEnv,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("exif_clock_skew");
    expect(result.raw_response).toMatch(/future/i);
  });

  it("accepts EXIF in the future within bounds (+30 s)", async () => {
    // Case E: 30 s ahead is fine — small clock drift is normal.
    const userId = await ensureUser();
    const watchId = await ensureWatch(userId);
    const exifMs = SERVER_ARRIVAL + 30_000;
    __setTestExifReader(async () => exifMs);
    installFakeAi("0:0");
    startCapture();

    const result = await verifyReading({
      watchId,
      userId,
      imageBuffer: tinyJpegBuffer(),
      isBaseline: false,
      serverArrivalMs: SERVER_ARRIVAL,
      env: VerifierEnv,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.reference_timestamp).toBe(exifMs);
    const okEvents = eventsOfKind("verified_reading_exif_ok");
    expect(okEvents).toHaveLength(1);
    expect(payloadOf(okEvents[0]!)).toMatchObject({ delta_ms: 30_000 });
  });

  it("falls back to server arrival when EXIF is missing", async () => {
    // Case F: no EXIF (screenshots, privacy-stripped photos). The
    // verifier creates the reading using server arrival — never
    // rejects.
    const userId = await ensureUser();
    const watchId = await ensureWatch(userId);
    __setTestExifReader(async () => null);
    installFakeAi("0:0");
    startCapture();

    const result = await verifyReading({
      watchId,
      userId,
      imageBuffer: tinyJpegBuffer(),
      isBaseline: false,
      serverArrivalMs: SERVER_ARRIVAL,
      env: VerifierEnv,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.reference_timestamp).toBe(SERVER_ARRIVAL);

    const missingEvents = eventsOfKind("verified_reading_exif_missing");
    expect(missingEvents).toHaveLength(1);
    expect(payloadOf(missingEvents[0]!)).toMatchObject({ userId, watchId });
    // No exif_ok event in this case.
    expect(eventsOfKind("verified_reading_exif_ok")).toHaveLength(0);
  });
});
