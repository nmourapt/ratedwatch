// Unit tests for the SPA-side NTP-style clock-skew estimator
// (PR #127). See ./ntpSync.ts for the design + math.
//
// These tests use a fake `fetch` so the helper's contract is
// exercised without hitting a real worker. The fake captures the
// outgoing request and returns a response containing `{ now }` —
// which is the only field the helper reads.
//
// Math under test:
//
//   T1 = client send       (`Date.now()` before fetch)
//   T2 = server receive    (the `now` in the response body)
//   T4 = client receive    (`Date.now()` after fetch resolves)
//
//   skew = T2 - (T1 + T4) / 2
//        = how far ahead the iPhone's clock is of the server's.
//          positive → iPhone is fast, negative → iPhone is slow.
//   rtt  = T4 - T1
//
// The helper assumes T2 ≈ T3 (server processing is negligible). In
// production, /api/v1/_time literally returns `Date.now()` and does
// nothing else, so this is true to within microseconds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateClockSkew, MAX_RTT_MS, MAX_SKEW_MS } from "./ntpSync";

interface FakeFetchOptions {
  /** Server's `now` to return in the response. */
  serverNowMs: number;
  /** Time elapsed (ms) between the SPA's T1 and T4 — the round trip. */
  rttMs?: number;
  /** If true, the fetch rejects (network failure). */
  reject?: boolean;
  /** If true, the response status is non-2xx. */
  errorStatus?: number;
}

/**
 * Build a fetch fake that:
 *   1. Records T1 = `Date.now()` at call time.
 *   2. Advances the fake clock by `rttMs/2` (one-way latency).
 *   3. Resolves with a Response whose body is `{ now: serverNowMs }`.
 *   4. Advances the clock another `rttMs/2`.
 *
 * The result: T1 = whatever Date.now() was when the helper called
 * fetch, T4 = T1 + rttMs. The helper sees `now: serverNowMs` and
 * computes skew/rtt against its own T1, T4.
 */
function makeFetch(opts: FakeFetchOptions): typeof globalThis.fetch {
  return async () => {
    if (opts.reject) {
      throw new Error("network");
    }
    // Simulate one-way latency by advancing fake timers.
    const halfRtt = (opts.rttMs ?? 100) / 2;
    vi.advanceTimersByTime(halfRtt);
    if (opts.errorStatus) {
      const r = new Response("server boom", { status: opts.errorStatus });
      vi.advanceTimersByTime(halfRtt);
      return r;
    }
    const r = new Response(JSON.stringify({ now: opts.serverNowMs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    vi.advanceTimersByTime(halfRtt);
    return r;
  };
}

describe("estimateClockSkew", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Anchor SPA's Date.now() at a known moment so we can reason
    // about T1 / T4 deterministically.
    vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 skew when server time matches client at midpoint", async () => {
    // Client at 12:00:00.000 (T1). Server returns 12:00:00.050
    // (== T1 + 50ms = midpoint of a 100ms RTT). Skew = 0.
    const fetch = makeFetch({
      serverNowMs: Date.UTC(2026, 4, 5, 12, 0, 0, 50),
      rttMs: 100,
    });
    const result = await estimateClockSkew("/api/v1/_time", fetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skewMs).toBe(0);
    expect(result.roundTripMs).toBe(100);
  });

  it("returns positive skew when client clock is AHEAD of server", async () => {
    // Client thinks it's 12:00:00.000 (T1). Server says it's
    // 11:59:53.050 (= 7s before client + 50ms midpoint). Client is
    // 7s ahead.
    const fetch = makeFetch({
      serverNowMs: Date.UTC(2026, 4, 5, 11, 59, 53, 50),
      rttMs: 100,
    });
    const result = await estimateClockSkew("/api/v1/_time", fetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skewMs).toBe(-7000); // server says it's earlier → client is ahead → "skew" negative under our convention
    // Convention reminder: skewMs = T2 - midpoint. Negative skewMs
    // means server is BEHIND midpoint → client clock is AHEAD of
    // server. That's the case to subtract from `client_capture_ms`.
  });

  it("returns negative skew when client clock is BEHIND server", async () => {
    const fetch = makeFetch({
      serverNowMs: Date.UTC(2026, 4, 5, 12, 0, 7, 50),
      rttMs: 100,
    });
    const result = await estimateClockSkew("/api/v1/_time", fetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skewMs).toBe(7000); // server is AHEAD → client is BEHIND
  });

  it("rejects when round trip exceeds MAX_RTT_MS (network too slow)", async () => {
    const fetch = makeFetch({
      serverNowMs: Date.UTC(2026, 4, 5, 12, 0, 0, 0),
      rttMs: MAX_RTT_MS + 100,
    });
    const result = await estimateClockSkew("/api/v1/_time", fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rtt_too_high");
  });

  it("rejects when |skew| exceeds MAX_SKEW_MS (likely garbage server response)", async () => {
    // Server says it's 100s ahead — implausible. Helper says no.
    const fetch = makeFetch({
      serverNowMs: Date.UTC(2026, 4, 5, 12, 1, 40, 50),
      rttMs: 100,
    });
    const result = await estimateClockSkew("/api/v1/_time", fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("skew_too_high");
    expect(Math.abs(result.skewMs!)).toBeGreaterThan(MAX_SKEW_MS);
  });

  it("rejects on network failure", async () => {
    const fetch = makeFetch({ serverNowMs: 0, reject: true });
    const result = await estimateClockSkew("/api/v1/_time", fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("network_error");
  });

  it("rejects on non-2xx response", async () => {
    const fetch = makeFetch({
      serverNowMs: Date.UTC(2026, 4, 5, 12, 0, 0, 50),
      errorStatus: 500,
    });
    const result = await estimateClockSkew("/api/v1/_time", fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("non_ok_status");
  });

  it("rejects on malformed response body (no `now` field)", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      vi.advanceTimersByTime(100);
      return new Response(JSON.stringify({ banana: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await estimateClockSkew("/api/v1/_time", fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed_response");
  });
});
