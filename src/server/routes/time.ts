// GET /api/v1/_time — server-clock probe for SPA-side NTP-style
// clock-skew estimation (PR #127).
//
// ## Why this exists
//
// PR #124 made the verified-reading reference timestamp accurate to
// the moment of shutter via EXIF DateTimeOriginal. PR #126 fixed the
// TZ-offset bias on top of that. Both treat the iPhone's clock as
// authoritative for "when the photo was captured."
//
// In practice iPhones — especially on cellular-only or after
// airplane-mode toggles — can drift several seconds from NTP truth.
// A user in Lisbon reported a saved deviation of −7 s on a watch
// that was almost certainly running closer to 0 s/day; the math
// works if their iPhone clock was ~7 s ahead of NTP. Without an
// independent server-side clock check, that bias is invisible to the
// system and gets baked into every reading.
//
// This endpoint exposes the Worker's `Date.now()` so the SPA can do
// a 4-timestamp NTP-style round-trip (T1=client send, T2≈T3=server,
// T4=client receive) and estimate its own clock skew before sending
// `client_capture_ms`. Cloudflare's edge nodes are atomic-time-synced
// so `Date.now()` here is reliably truth.
//
// ## What it returns
//
//   200 { now: <unix ms at handler entry> }
//
// That's it. No auth, no rate limit, no body parsing. The whole
// request is sub-millisecond on the worker side; the only latency the
// SPA sees is network round-trip — which is exactly what we want
// (the SPA averages the latency assuming symmetric one-way).
//
// ## Anti-cheat
//
// This endpoint changes nothing about the verified-reading server's
// trust model. The SPA can use the returned `now` to apply a
// correction to `client_capture_ms` before submitting, but the
// existing ±5 min / +1 min bound check still applies on /draft. A
// malicious client claiming a wildly off skew ends up out-of-bounds
// and gets 422 — same envelope as before.

import { Hono } from "hono";

// This route doesn't read any bindings — it just returns the
// runtime's `Date.now()`. Typing the env as `object` keeps tsc
// quiet without dragging in the full Bindings union from
// worker-configuration.d.ts.
export const timeRoute = new Hono<{ Bindings: object }>();

timeRoute.get("/", (c) => {
  // Read once. The SPA assumes T2 ≈ T3 (server processing time is
  // negligible compared to network RTT). Returning a single value
  // simplifies that assumption: it's both the receive and send
  // moment. If we ever add even tiny processing here (logging, KV
  // reads, etc.) we'll need to return separate T2/T3.
  return c.json({ now: Date.now() });
});
