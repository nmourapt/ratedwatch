// Unit tests for the observability event emitter. The emitter wraps
// Analytics Engine's writeDataPoint in a fire-and-forget shape so that
// a broken AE binding can never crash a request path — every callsite
// in the Worker assumes this guarantee.

import { describe, expect, it, vi } from "vitest";
import { logEvent, type EventKind } from "./events";

// Minimal fake of the AnalyticsEngineDataset binding. Captures every
// writeDataPoint call so we can assert the shape of blobs + indexes
// that the emitter actually sent.
function createFakeDataset() {
  const calls: Array<{ blobs?: unknown[]; indexes?: unknown[]; doubles?: number[] }> = [];
  return {
    calls,
    binding: {
      writeDataPoint(dp?: {
        blobs?: unknown[];
        indexes?: unknown[];
        doubles?: number[];
      }) {
        calls.push({
          blobs: dp?.blobs,
          indexes: dp?.indexes,
          doubles: dp?.doubles,
        });
      },
    } as unknown as AnalyticsEngineDataset,
  };
}

describe("logEvent", () => {
  it("writes a data point whose blobs carry kind + payload JSON", async () => {
    const fake = createFakeDataset();
    const env = { ANALYTICS: fake.binding };
    const payload = { userId: "u-123", movementId: "eta-2824" };

    await logEvent("watch_added", payload, env);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.blobs).toEqual(["watch_added", JSON.stringify(payload)]);
    expect(call.indexes).toEqual(["watch_added"]);
  });

  it("accepts primitive payload values (string, number, boolean, null)", async () => {
    const fake = createFakeDataset();
    const env = { ANALYTICS: fake.binding };
    const payload = { s: "x", n: 42, b: true, nil: null };

    await logEvent("reading_submitted", payload, env);

    expect(fake.calls).toHaveLength(1);
    const raw = fake.calls[0]!.blobs![1] as string;
    expect(JSON.parse(raw)).toEqual(payload);
  });

  it("supports every documented EventKind", async () => {
    const kinds: EventKind[] = [
      "user_registered",
      "watch_added",
      "reading_submitted",
      "verified_reading_attempted",
      "verified_reading_succeeded",
      "verified_reading_failed",
      // Slice #71 EXIF-reference telemetry.
      "verified_reading_exif_ok",
      "verified_reading_exif_missing",
      "verified_reading_exif_clock_skew",
      // Slice #80 manual_with_photo fallback funnel.
      "manual_with_photo_submitted",
      // Slice #83 dial-reader telemetry quintet.
      "dial_reader_attempt",
      "dial_reader_success",
      "dial_reader_rejection",
      "dial_reader_error",
      "dial_reader_cold_start",
      "movement_suggested",
      "chrono24_click",
      "leaderboard_filter_changed",
      "page_view_home",
      "page_view_leaderboard",
    ];
    const fake = createFakeDataset();
    const env = { ANALYTICS: fake.binding };

    for (const kind of kinds) {
      await logEvent(kind, {}, env);
    }

    expect(fake.calls).toHaveLength(kinds.length);
    for (const [i, call] of fake.calls.entries()) {
      expect(call.indexes).toEqual([kinds[i]]);
    }
  });

  it("never throws when the binding throws — instead warns to console", async () => {
    const env = {
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error("AE is down");
        },
      } as unknown as AnalyticsEngineDataset,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(logEvent("page_view_home", {}, env)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never throws when the binding is undefined (unconfigured env)", async () => {
    // Simulate a local dev environment or a misconfigured preview with
    // no ANALYTICS binding. logEvent must still resolve cleanly.
    const env = { ANALYTICS: undefined as unknown as AnalyticsEngineDataset };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      logEvent("chrono24_click", { movementId: "eta-2824" }, env),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
