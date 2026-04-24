// Integration tests for POST /api/v1/watches/:watchId/readings/tap.
//
// The "tap" flow: client sends only `dial_position` (0/15/30/45) +
// `is_baseline` + optional `notes`. The server uses its own
// Date.now() as the reference. Deviation is computed as the signed
// distance (in [-30, +30]) between the tapped position and the
// server's current second-of-minute.
//
// Fake timers are pinned per-test so the math is deterministic. The
// handler reads Date.now() directly, so vi.setSystemTime() is enough
// — no module-level stubbing required.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const movementId = "test-readings-tap-eta-2824";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      movementId,
      "Test ETA 2824 (tap readings)",
      "ETA",
      "2824 (tap readings)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

afterEach(() => {
  // Every test pins its own system time — clean up after each to
  // avoid leaking fake time into sibling suites (particularly the
  // verified-readings tests which also use fake timers).
  vi.useRealTimers();
});

// ---- Auth + watch helpers (mirror readings.test.ts) ----------------

function makeEmail(prefix = "tapread"): string {
  return `${prefix}-${crypto.randomUUID()}@ratedwatch.test`;
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
  body: { name: string; movement_id: string; is_public?: boolean },
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

interface TapBody {
  dial_position?: number;
  is_baseline?: boolean;
  notes?: string;
}

async function postTap(
  watchId: string,
  body: TapBody,
  cookie?: string,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings/tap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

interface ReadingBody {
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

const TWO_USER_TIMEOUT = 30_000;

/**
 * Build a millisecond unix timestamp where the minute is fixed and
 * the second-of-minute is exactly `sec`. Handy for pinning
 * Date.now() to a known second boundary.
 */
function msAtSecond(sec: number): number {
  // 2026-01-15T10:00:sec.000Z — arbitrary stable wall-clock value.
  return Date.UTC(2026, 0, 15, 10, 0, sec, 0);
}

// ---- POST /api/v1/watches/:id/readings/tap -------------------------

describe("POST /api/v1/watches/:id/readings/tap", () => {
  it("records deviation 0 when the tapped position matches the server second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(msAtSecond(30));

    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Tap exact", movement_id: movementId },
      owner.cookie,
    );
    const res = await postTap(
      watchId,
      { dial_position: 30, is_baseline: false },
      owner.cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReadingBody;
    expect(body.watch_id).toBe(watchId);
    expect(body.user_id).toBe(owner.userId);
    expect(body.deviation_seconds).toBe(0);
    expect(body.is_baseline).toBe(false);
    expect(body.verified).toBe(false);
    // Server-supplied reference timestamp. Matches Date.now()
    // at handler entry (may differ by a few ms from the pinned
    // value because Better Auth etc. advance fake time — but it
    // must be in the same second window).
    expect(Math.floor(body.reference_timestamp / 1000)).toBe(
      Math.floor(msAtSecond(30) / 1000),
    );
  });

  it("computes a small negative deviation when the watch is behind", async () => {
    // Server second = 5, user taps 0 → watch reads 0 when real time
    // is 5 → the watch is 5 s BEHIND → deviation -5.
    vi.useFakeTimers();
    vi.setSystemTime(msAtSecond(5));

    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Tap behind", movement_id: movementId },
      owner.cookie,
    );
    const res = await postTap(watchId, { dial_position: 0 }, owner.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReadingBody;
    expect(body.deviation_seconds).toBe(-5);
  });

  it("wraps the tap-0-when-ref-is-45 case to +15 (watch is ahead)", async () => {
    // Server second = 45, user taps 0 → treated as the NEXT minute's
    // zero mark arrived 15 s early → watch is 15 s AHEAD.
    // Arithmetic: delta = 0 - 45 = -45. Wrap: (-45 + 30 + 60) % 60 - 30 = 15.
    vi.useFakeTimers();
    vi.setSystemTime(msAtSecond(45));

    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Tap wrap", movement_id: movementId },
      owner.cookie,
    );
    const res = await postTap(watchId, { dial_position: 0 }, owner.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReadingBody;
    expect(body.deviation_seconds).toBe(15);
  });

  it("handles tap-45-when-ref-is-0 as -15 (ambiguous, conventional)", async () => {
    // delta = 45 - 0 = 45. Wrap: (45 + 30 + 60) % 60 - 30 = -15.
    vi.useFakeTimers();
    vi.setSystemTime(msAtSecond(0));

    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Tap 45/0", movement_id: movementId },
      owner.cookie,
    );
    const res = await postTap(watchId, { dial_position: 45 }, owner.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReadingBody;
    expect(body.deviation_seconds).toBe(-15);
  });

  it("handles tap-45-when-ref-is-55 as -10 (same direction, no wrap)", async () => {
    // delta = 45 - 55 = -10. Wrap: (-10 + 30 + 60) % 60 - 30 = -10.
    vi.useFakeTimers();
    vi.setSystemTime(msAtSecond(55));

    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Tap 45/55", movement_id: movementId },
      owner.cookie,
    );
    const res = await postTap(watchId, { dial_position: 45 }, owner.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReadingBody;
    expect(body.deviation_seconds).toBe(-10);
  });

  it("forces deviation to 0 when is_baseline=true, regardless of clock skew", async () => {
    // Ref-second 20, tap 0 would normally give +20 (wrap) or -20
    // depending on convention — but baseline always wins and stores 0.
    vi.useFakeTimers();
    vi.setSystemTime(msAtSecond(20));

    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Tap baseline", movement_id: movementId },
      owner.cookie,
    );
    const res = await postTap(
      watchId,
      { dial_position: 0, is_baseline: true },
      owner.cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReadingBody;
    expect(body.is_baseline).toBe(true);
    expect(body.deviation_seconds).toBe(0);
  });

  it("rejects unauthenticated tap requests (401)", async () => {
    const res = await postTap("whatever", { dial_position: 0 });
    expect(res.status).toBe(401);
  });

  it(
    "rejects a non-owner tap (403)",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Theirs-tap", movement_id: movementId },
        owner.cookie,
      );
      const res = await postTap(watchId, { dial_position: 15 }, other.cookie);
      expect(res.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );

  it("rejects invalid dial_position (400)", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Bad-tap", movement_id: movementId },
      owner.cookie,
    );
    for (const bad of [7, 60, -1, 22.5]) {
      const res = await postTap(watchId, { dial_position: bad } as TapBody, owner.cookie);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_input");
    }
  });

  it("rejects missing dial_position (400)", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Missing-tap", movement_id: movementId },
      owner.cookie,
    );
    const res = await postTap(watchId, { is_baseline: false } as TapBody, owner.cookie);
    expect(res.status).toBe(400);
  });
});
