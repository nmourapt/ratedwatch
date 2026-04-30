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
  // The slice-#5 reader returns `raw_responses: string[]` (one entry
  // per parallel call) plus aggregated token totals. The verifier
  // collapses this into a single `raw_response` for the route layer.
  const raw = `10:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return {
    kind: "success",
    mm_ss: { m, s },
    raw_responses: [raw, raw, raw],
    tokens_in_total: 300,
    tokens_out_total: 15,
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

  // ---- clientCaptureMs (PR #124, fix for verified-reading upload-latency bias) ----
  //
  // Background: the SPA's canvas-resize step strips EXIF from every
  // photo (canvas re-encoding produces a clean JPEG). So the byte-EXIF
  // path almost always falls through to server-arrival, which lags
  // photo-capture time by upload latency (typically 5-15s on
  // cellular/weak WiFi). On a watch with +6s/day drift, a 13s upload
  // delay produces a deviation of -7s — exactly the bug a real user
  // hit on 2026-04-30.
  //
  // The fix: SPA reads EXIF DateTimeOriginal client-side BEFORE the
  // canvas-resize destroys it, and falls back to Date.now() at file-
  // selection moment. Either way it sends a `client_capture_ms`
  // multipart field. Server bounds it (same ±5 min / +1 min window
  // as byte-EXIF) and uses it as the reference. Anti-cheat: since the
  // bound is exactly the EXIF bound, a malicious client can't claim
  // a wildly different time than they could already claim by forging
  // EXIF bytes.

  it("uses clientCaptureMs as the reference when present and in-bounds", async () => {
    const clientMs = SERVER_ARRIVAL_MS - 8000; // 8s before arrival
    const deps = makeDeps({
      // Dial reads 19:25 → vs ref 19:22 (= clientMs minute/second) = +3s
      readDial: async () => vlmSuccess(19, 25),
    });
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "watch-1",
        userId: "user-1",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
        clientCaptureMs: clientMs,
      },
      deps,
    );
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.reference_timestamp_ms).toBe(clientMs);
    expect(result.reference_source).toBe("client");
    expect(result.deviation_seconds).toBe(3);
  });

  it("clientCaptureMs takes precedence over byte-extracted EXIF", async () => {
    // Both signals available, both in-bounds. Client wins because
    // post-canvas-resize byte-EXIF is structurally unreliable (almost
    // always missing) and the SPA already extracted EXIF from the
    // ORIGINAL bytes before resize. Trusting client here is more
    // accurate, with the same anti-cheat ceiling.
    const exifMs = SERVER_ARRIVAL_MS - 4000;
    const clientMs = SERVER_ARRIVAL_MS - 12000;
    __setTestExifReader(async () => exifMs);
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
        clientCaptureMs: clientMs,
      },
      makeDeps(),
    );
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.reference_timestamp_ms).toBe(clientMs);
    expect(result.reference_source).toBe("client");
  });

  it("rejects clientCaptureMs more than 5 minutes in the past as exif_clock_skew", async () => {
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
        clientCaptureMs: SERVER_ARRIVAL_MS - 6 * 60 * 1000,
      },
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("exif_clock_skew");
  });

  it("rejects clientCaptureMs more than 1 minute in the future as exif_clock_skew", async () => {
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
        clientCaptureMs: SERVER_ARRIVAL_MS + 90 * 1000,
      },
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("exif_clock_skew");
  });

  it("falls back to server arrival when clientCaptureMs is undefined and no EXIF", async () => {
    const result = await verifyVlmReading(
      {
        photoBytes: FAKE_IMAGE,
        watchId: "w",
        userId: "u",
        serverArrivalAtMs: SERVER_ARRIVAL_MS,
        // No clientCaptureMs
      },
      makeDeps(),
    );
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.reference_timestamp_ms).toBe(SERVER_ARRIVAL_MS);
    expect(result.reference_source).toBe("server");
  });

  it("maps VLM rejection (unparseable_majority) to error: ai_unparseable", async () => {
    const deps = makeDeps({
      readDial: async () => ({ kind: "rejection", reason: "unparseable_majority" }),
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
  });

  it("maps VLM rejection (all_runs_failed) to error: ai_refused", async () => {
    const deps = makeDeps({
      readDial: async () => ({ kind: "rejection", reason: "all_runs_failed" }),
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
    expect(result.error).toBe("ai_refused");
  });

  it("maps VLM rejection (anchor_disagreement) to error: dial_reader_anchor_disagreement", async () => {
    const deps = makeDeps({
      readDial: async () => ({
        kind: "rejection",
        reason: "anchor_disagreement",
        details: { delta_seconds: 90 },
      }),
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
    expect(result.error).toBe("dial_reader_anchor_disagreement");
  });

  it("maps VLM rejection (anchor_echo_suspicious) to error: dial_reader_anchor_echo_flagged", async () => {
    const deps = makeDeps({
      readDial: async () => ({
        kind: "rejection",
        reason: "anchor_echo_suspicious",
      }),
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
    expect(result.error).toBe("dial_reader_anchor_echo_flagged");
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
