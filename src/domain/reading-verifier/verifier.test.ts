// Unit tests for the slice-#4 (PRD #99 / issue #103) `verifyVlmReading`
// orchestrator. The orchestrator wires together:
//
//   1. EXIF reference-timestamp resolution (existing logic in
//      `./reference-timestamp.ts`).
//   2. The dial cropper (`@/domain/dial-cropper`).
//   3. The single-call VLM dial reader (`@/domain/dial-reader-vlm`).
//   4. Deviation calculation (MM:SS-modulo-60min, matching the old
//      verifier's contract).
//
// Tests inject deterministic fakes for the cropper, the reader, and
// the EXIF reader — no Worker bindings required, no real AI calls.
// The integration tests in `tests/integration/readings.verified.test.ts`
// drive the full pipeline against the real AI Gateway.
//
// The deviation contract:
//
//   * The reference timestamp gives us the "true MM:SS" (UTC).
//   * The VLM gives us the dial's observed MM:SS.
//   * Deviation = signed delta in seconds, wrapped into
//     [-1800, +1800] so a capture straddling the minute boundary
//     (dial=59:58, ref=00:02) shows as -4 s rather than +3596 s.
//   * Drift > ±30 minutes wraps and under-reports — accepted limit
//     for a v1 verifier per the original (slice #16) contract.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  computeMmSsDeviation,
  verifyVlmReading,
  type VerifyVlmReadingDeps,
} from "./verifier";
import { __setTestExifReader } from "./exif";
import type { CropToDialResult } from "@/domain/dial-cropper/cropper";
import type { DialReadResult } from "@/domain/dial-reader-vlm/types";

// ---- Fake builders --------------------------------------------------

function fakeCropResult(): CropToDialResult {
  return {
    cropped: new ArrayBuffer(16),
    found: true,
    centerXY: [100, 100],
    radius: 50,
  };
}

function vlmSuccess(m: number, s: number, model = "openai/gpt-5.2"): DialReadResult {
  return {
    kind: "success",
    mm_ss: { m, s },
    raw_response: `10:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`,
    tokens_in: 100,
    tokens_out: 5,
  };
  // (model is captured by the deps below, not the result — kept here
  // for prose clarity.)
  void model;
}

function makeDeps(overrides?: Partial<VerifyVlmReadingDeps>): VerifyVlmReadingDeps {
  return {
    cropToDial: async () => fakeCropResult(),
    readDial: async () => vlmSuccess(19, 34),
    model: "openai/gpt-5.2",
    ...overrides,
  };
}

// Reference moment: 2026-04-29T10:19:30 UTC. UTC minute=19, second=30.
const SERVER_ARRIVAL_MS = Date.UTC(2026, 3, 29, 10, 19, 30, 0);

// Helper image bytes — never read by the fakes.
const FAKE_IMAGE = (() => {
  const ab = new ArrayBuffer(8);
  return ab;
})();

// ---- pure helper: computeMmSsDeviation -----------------------------

describe("computeMmSsDeviation", () => {
  it("returns 0 when dial and reference match exactly", () => {
    expect(computeMmSsDeviation({ m: 19, s: 30 }, { m: 19, s: 30 })).toBe(0);
  });

  it("returns positive when dial is ahead of reference", () => {
    // dial 19:34, ref 19:30 → +4s
    expect(computeMmSsDeviation({ m: 19, s: 34 }, { m: 19, s: 30 })).toBe(4);
  });

  it("returns negative when dial is behind reference", () => {
    // dial 19:25, ref 19:30 → -5s
    expect(computeMmSsDeviation({ m: 19, s: 25 }, { m: 19, s: 30 })).toBe(-5);
  });

  it("wraps minute boundaries (dial 59:58, ref 00:02 → -4)", () => {
    expect(computeMmSsDeviation({ m: 59, s: 58 }, { m: 0, s: 2 })).toBe(-4);
  });

  it("wraps the other minute boundary (dial 00:02, ref 59:58 → +4)", () => {
    expect(computeMmSsDeviation({ m: 0, s: 2 }, { m: 59, s: 58 })).toBe(4);
  });

  it("clamps drift > ±30 min to the wrap (40 min ahead → 20 min behind)", () => {
    // dial 40:00, ref 0:00 → raw +2400, wraps to -1200
    expect(computeMmSsDeviation({ m: 40, s: 0 }, { m: 0, s: 0 })).toBe(-1200);
  });
});

// ---- verifyVlmReading -----------------------------------------------

describe("verifyVlmReading", () => {
  beforeEach(() => {
    // Default: no EXIF — verifier falls back to server arrival time.
    __setTestExifReader(async () => null);
  });
  afterEach(() => {
    __setTestExifReader(null);
  });

  it("returns ok with deviation seconds and the model slug on success", async () => {
    const deps = makeDeps({
      // Dial reads 19:34 against a 19:30 reference → +4s deviation.
      readDial: async () => vlmSuccess(19, 34),
    });
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "watch-1",
        userId: "user-1",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
      },
      deps,
    );
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.vlm_model).toBe("openai/gpt-5.2");
    expect(result.mm_ss).toEqual({ m: 19, s: 34 });
    expect(result.reference_timestamp_ms).toBe(SERVER_ARRIVAL_MS);
    expect(result.deviation_seconds).toBe(4);
  });

  it("uses EXIF DateTimeOriginal as the reference when present and in-bounds", async () => {
    // EXIF says 10:19:25 UTC (5 s before server arrival of :30).
    const exifMs = Date.UTC(2026, 3, 29, 10, 19, 25, 0);
    __setTestExifReader(async () => exifMs);
    const deps = makeDeps({
      // Dial reads 19:30 → vs ref 19:25 = +5s
      readDial: async () => vlmSuccess(19, 30),
    });
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "watch-1",
        userId: "user-1",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
      },
      deps,
    );
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.reference_timestamp_ms).toBe(exifMs);
    expect(result.deviation_seconds).toBe(5);
  });

  it("returns exif_clock_skew when EXIF is more than 5 minutes in the past", async () => {
    const exifMs = SERVER_ARRIVAL_MS - 6 * 60 * 1000;
    __setTestExifReader(async () => exifMs);
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
      },
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("exif_clock_skew");
  });

  it("maps VLM unparseable to error: ai_unparseable with raw_response", async () => {
    const deps = makeDeps({
      readDial: async () => ({ kind: "unparseable", raw_response: "huh?" }),
    });
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("ai_unparseable");
    expect(result.raw_response).toBe("huh?");
  });

  it("maps VLM transport_error to error: dial_reader_transport_error", async () => {
    const deps = makeDeps({
      readDial: async () => ({ kind: "transport_error", message: "timeout" }),
    });
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("dial_reader_transport_error");
  });

  it("passes the reference timestamp's MM:SS as the EXIF anchor to the reader", async () => {
    let captured: { h: number; m: number; s: number } | null = null;
    const deps = makeDeps({
      readDial: async (input) => {
        captured = input.exifAnchor;
        return vlmSuccess(19, 30);
      },
    });
    await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
      },
      deps,
    );
    // 10:19:30 UTC → 12-hour clock components h=10, m=19, s=30
    expect(captured).toEqual({ h: 10, m: 19, s: 30 });
  });

  it("converts hour 0 (midnight UTC) to 12 on the 12-hour clock anchor", async () => {
    const midnightMs = Date.UTC(2026, 3, 29, 0, 5, 12, 0);
    let captured: { h: number; m: number; s: number } | null = null;
    const deps = makeDeps({
      readDial: async (input) => {
        captured = input.exifAnchor;
        return vlmSuccess(5, 12);
      },
    });
    await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: midnightMs,
      },
      deps,
    );
    expect(captured).toEqual({ h: 12, m: 5, s: 12 });
  });

  it("converts hour 13 (1 PM UTC) to 1 on the 12-hour clock anchor", async () => {
    const onepmMs = Date.UTC(2026, 3, 29, 13, 7, 20, 0);
    let captured: { h: number; m: number; s: number } | null = null;
    const deps = makeDeps({
      readDial: async (input) => {
        captured = input.exifAnchor;
        return vlmSuccess(7, 20);
      },
    });
    await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: onepmMs,
      },
      deps,
    );
    expect(captured).toEqual({ h: 1, m: 7, s: 20 });
  });
});
