// Integration test for `GET /api/v1/_time` (PR #127).
//
// The endpoint is the server side of the SPA's NTP-style clock-
// skew estimator — see src/app/watches/ntpSync.ts for the math
// and src/server/routes/time.ts for the route. The contract under
// test:
//
//   * 200 with `{ now: <unix ms> }`
//   * `now` is a finite integer close to test's `Date.now()`
//   * No auth required (the SPA calls this BEFORE login on the
//     verified-reading flow's draft-step prefetch)
//   * No side effects: hitting it twice in a row works (idempotent)
//
// Time fakes (vi.useFakeTimers + vi.setSystemTime) are honored by
// miniflare/workerd, so we can assert exact equality of `now`
// rather than dealing with a tolerance window.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { exports } from "cloudflare:workers";

const TIME_ENDPOINT = "https://ratedwatch.test/api/v1/_time";

describe("GET /api/v1/_time", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 200 with the server's current Date.now() in unix ms", async () => {
    const fixedNow = Date.UTC(2026, 4, 5, 14, 23, 7, 250);
    vi.setSystemTime(fixedNow);
    const res = await exports.default.fetch(new Request(TIME_ENDPOINT));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { now: unknown };
    expect(body.now).toBe(fixedNow);
  });

  it("does not require authentication", async () => {
    // No cookie, no auth header. Public endpoint per PR #127's
    // design: the SPA might call it before sign-in flows complete
    // and we don't want to leak login state through 401s.
    const res = await exports.default.fetch(
      new Request(TIME_ENDPOINT, { method: "GET" }),
    );
    expect(res.status).toBe(200);
  });

  it("is idempotent — two consecutive calls return increasing now values", async () => {
    const t0 = Date.UTC(2026, 4, 5, 14, 23, 7, 0);
    vi.setSystemTime(t0);
    const r1 = await exports.default.fetch(new Request(TIME_ENDPOINT));
    const b1 = (await r1.json()) as { now: number };
    vi.setSystemTime(t0 + 1500);
    const r2 = await exports.default.fetch(new Request(TIME_ENDPOINT));
    const b2 = (await r2.json()) as { now: number };
    expect(b2.now).toBe(t0 + 1500);
    expect(b2.now).toBeGreaterThan(b1.now);
  });

  it("rejects non-GET methods (Hono default 405)", async () => {
    const res = await exports.default.fetch(
      new Request(TIME_ENDPOINT, { method: "POST" }),
    );
    expect([404, 405]).toContain(res.status);
  });
});
