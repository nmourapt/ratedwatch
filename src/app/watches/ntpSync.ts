// SPA-side NTP-style clock-skew estimator (PR #127, fix for the
// iPhone-clock-vs-NTP-truth bias on verified readings).
//
// ## What it does
//
// One HTTP round-trip against `/api/v1/_time` plus a bit of math
// gives an estimate of how far the SPA's `Date.now()` is from the
// Worker's `Date.now()`. Workers run on Cloudflare's NTP-synced edge
// (atomic-time-anchored), so the server clock is reliably truth.
// The SPA can then subtract the estimated skew from
// `client_capture_ms` before submitting `/draft`, eliminating the
// iPhone-clock-skew source of bias from every verified reading.
//
// ## The math
//
//   T1 = client send time  (`Date.now()` immediately before fetch)
//   T2 = server receive time (`now` in the response body — assumed
//        ≈ T3 because the server returns immediately)
//   T4 = client receive time (`Date.now()` after fetch resolves)
//
//   skewMs       = T2 - (T1 + T4) / 2
//   roundTripMs  = T4 - T1
//
// `skewMs` interpretation: how much the SPA's clock is BEHIND the
// server's. Positive → SPA behind server (server thinks it's later).
// Negative → SPA ahead of server (iPhone is fast relative to NTP).
//
// To correct a `client_capture_ms` that came from the iPhone clock:
//
//   correctedMs = clientCaptureMs + skewMs
//
// (If iPhone is ahead by 7 s, skewMs = −7000, and we subtract 7s
// from the captured timestamp to bring it back to NTP truth.)
//
// ## Sanity bounds
//
// We reject the estimate when:
//
//   * round trip is > MAX_RTT_MS (5 s) — typical mobile networks
//     come in well under 1 s; 5 s suggests something is wrong (slow
//     uplink, server cold-start, captive portal). The skew estimate
//     becomes unreliable above this threshold because the asymmetric-
//     latency error bound grows with RTT/2.
//
//   * |skew| > MAX_SKEW_MS (60 s) — implausible for a well-tended
//     iPhone. If we're seeing this, either the server is misbehaving
//     or someone is actively spoofing. Better to fall back to the
//     existing reference path than to apply a wild correction.
//
// On rejection the verified-reading flow continues without
// correction — the existing server-side ±5min/+1min bound still
// applies, so we never accept a wildly off `client_capture_ms`.

/**
 * Maximum round trip time we'll accept for a clock-skew estimate.
 * Above this the asymmetric-latency error gets too large to give
 * a useful signal. Production p95 RTT to Cloudflare's nearest
 * colo is well under 200 ms; 5 s is a generous ceiling.
 */
export const MAX_RTT_MS = 5_000;

/**
 * Maximum |skew| we'll accept. Real iPhones typically drift sub-
 * second from NTP; even on long-untended cellular-only devices the
 * skew rarely exceeds tens of seconds. 60 s is a generous ceiling
 * that catches both runaway iPhones and broken server responses.
 */
export const MAX_SKEW_MS = 60_000;

export type ClockSkewResult =
  | {
      ok: true;
      /** How many ms the client clock is BEHIND the server. */
      skewMs: number;
      /** How many ms the round trip took. */
      roundTripMs: number;
    }
  | {
      ok: false;
      reason:
        | "rtt_too_high"
        | "skew_too_high"
        | "network_error"
        | "non_ok_status"
        | "malformed_response";
      /** Best-effort skew estimate when available, for logging. */
      skewMs?: number;
      roundTripMs?: number;
    };

/**
 * Hit `/api/v1/_time` and compute the SPA's clock skew vs the
 * Worker. `fetchImpl` is injectable so tests can avoid hitting a
 * real network.
 *
 * Never throws — every failure mode collapses to `ok: false`.
 */
export async function estimateClockSkew(
  endpoint: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ClockSkewResult> {
  const t1 = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      // The endpoint is unauthed and idempotent. Skip credentials
      // to avoid an unnecessary cookie round-trip.
      credentials: "omit",
      // No-cache: every call needs fresh server time. A cached
      // response would defeat the point.
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  const t4 = Date.now();
  if (!response.ok) {
    return { ok: false, reason: "non_ok_status" };
  }
  let body: { now?: unknown } | null = null;
  try {
    body = (await response.json()) as { now?: unknown };
  } catch {
    return { ok: false, reason: "malformed_response" };
  }
  const t2 = body?.now;
  if (typeof t2 !== "number" || !Number.isFinite(t2)) {
    return { ok: false, reason: "malformed_response" };
  }

  const roundTripMs = t4 - t1;
  const skewMs = t2 - (t1 + t4) / 2;

  if (roundTripMs > MAX_RTT_MS) {
    return { ok: false, reason: "rtt_too_high", roundTripMs, skewMs };
  }
  if (Math.abs(skewMs) > MAX_SKEW_MS) {
    return { ok: false, reason: "skew_too_high", roundTripMs, skewMs };
  }

  return { ok: true, skewMs, roundTripMs };
}
