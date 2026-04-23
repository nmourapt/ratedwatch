// Integration tests for /api/v1/watches/:id/readings and
// /api/v1/readings/:id. Follows the same fixture + helper pattern as
// tests/integration/watches.test.ts so the expensive Better Auth
// sign-up path is reused across tests.
//
// Covers:
//   * POST happy path + baseline-forces-deviation-0 rule
//   * POST non-owner → 403
//   * GET with session stats + anonymous public / private distinctions
//   * DELETE owner / non-owner
//   * FK cascade when the parent watch is deleted

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";
import type { SessionStats } from "@/domain/drift-calc";

// ---- Test fixture ---------------------------------------------------

const movementId = "test-readings-eta-2824";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      movementId,
      "Test ETA 2824 (readings)",
      "ETA",
      "2824 (readings)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

// ---- Auth helpers (mirror watches.test.ts) -------------------------

function makeEmail(prefix = "readings"): string {
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

// ---- Request helpers -----------------------------------------------

async function createWatch(
  body: {
    name: string;
    movement_id: string;
    is_public?: boolean;
  },
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

async function deleteWatch(id: string, cookie: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
}

interface CreateReadingBody {
  reference_timestamp: number;
  deviation_seconds: number;
  is_baseline?: boolean;
  notes?: string;
}

async function postReading(
  watchId: string,
  body: CreateReadingBody,
  cookie?: string,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function getReadings(watchId: string, cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/readings`, {
      headers: cookie ? { cookie } : {},
    }),
  );
}

async function deleteReading(id: string, cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/readings/${id}`, {
      method: "DELETE",
      headers: cookie ? { cookie } : {},
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

interface GetReadingsBody {
  readings: ReadingBody[];
  session_stats: SessionStats | null;
}

const TWO_USER_TIMEOUT = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- POST /api/v1/watches/:id/readings -----------------------------

describe("POST /api/v1/watches/:id/readings", () => {
  it("creates a reading and returns the full shape (201)", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Test", movement_id: movementId },
      owner.cookie,
    );
    const now = Date.now();
    const res = await postReading(
      watchId,
      {
        reference_timestamp: now,
        deviation_seconds: 2.5,
        is_baseline: false,
        notes: "first log",
      },
      owner.cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReadingBody;
    expect(body.watch_id).toBe(watchId);
    expect(body.user_id).toBe(owner.userId);
    expect(body.reference_timestamp).toBe(now);
    expect(body.deviation_seconds).toBe(2.5);
    expect(body.is_baseline).toBe(false);
    expect(body.verified).toBe(false);
    expect(body.notes).toBe("first log");
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(10);
  });

  it("forces deviation_seconds to 0 when is_baseline=true, even if client sent 42", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Baseline watch", movement_id: movementId },
      owner.cookie,
    );
    const res = await postReading(
      watchId,
      {
        reference_timestamp: Date.now(),
        deviation_seconds: 42,
        is_baseline: true,
      },
      owner.cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReadingBody;
    expect(body.is_baseline).toBe(true);
    expect(body.deviation_seconds).toBe(0);
  });

  it(
    "rejects a non-owner (403)",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Theirs", movement_id: movementId },
        owner.cookie,
      );
      const res = await postReading(
        watchId,
        { reference_timestamp: Date.now(), deviation_seconds: 1 },
        other.cookie,
      );
      expect(res.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );

  it("rejects an unauthenticated request (401)", async () => {
    // Use an obviously fake id — requireAuth triggers before we even
    // look up the watch, so the 401 comes out before any DB access.
    const res = await postReading("whatever", {
      reference_timestamp: Date.now(),
      deviation_seconds: 1,
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid input (400)", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "x", movement_id: movementId },
      owner.cookie,
    );
    const res = await postReading(
      watchId,
      // missing deviation_seconds, negative timestamp
      { reference_timestamp: -1 } as unknown as CreateReadingBody,
      owner.cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });
});

// ---- GET /api/v1/watches/:id/readings ------------------------------

describe("GET /api/v1/watches/:id/readings", () => {
  it("returns readings + computed session_stats for the owner", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Drift test", movement_id: movementId },
      owner.cookie,
    );
    const t = Date.now();
    // Post three readings across 7 days with drift = 1 s/d.
    await postReading(
      watchId,
      {
        reference_timestamp: t,
        deviation_seconds: 999, // forced to 0 because baseline
        is_baseline: true,
      },
      owner.cookie,
    );
    await postReading(
      watchId,
      {
        reference_timestamp: t + 3 * DAY_MS,
        deviation_seconds: 3,
      },
      owner.cookie,
    );
    await postReading(
      watchId,
      {
        reference_timestamp: t + 7 * DAY_MS,
        deviation_seconds: 7,
      },
      owner.cookie,
    );

    const res = await getReadings(watchId, owner.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetReadingsBody;
    expect(body.readings).toHaveLength(3);
    expect(body.session_stats).not.toBeNull();
    expect(body.session_stats!.reading_count).toBe(3);
    expect(body.session_stats!.session_days).toBeCloseTo(7, 5);
    expect(body.session_stats!.avg_drift_rate_spd).toBeCloseTo(1, 5);
    expect(body.session_stats!.eligible).toBe(true);
  });

  it("empty watch returns session_stats=null", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Empty", movement_id: movementId },
      owner.cookie,
    );
    const res = await getReadings(watchId, owner.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetReadingsBody;
    expect(body.readings).toEqual([]);
    expect(body.session_stats).toBeNull();
  });

  it("anonymous can read readings on a public watch (200)", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Public watch", movement_id: movementId, is_public: true },
      owner.cookie,
    );
    await postReading(
      watchId,
      { reference_timestamp: Date.now(), deviation_seconds: 0, is_baseline: true },
      owner.cookie,
    );
    const res = await getReadings(watchId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetReadingsBody;
    expect(body.readings).toHaveLength(1);
  });

  it("anonymous gets 404 for a private watch", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Private watch", movement_id: movementId, is_public: false },
      owner.cookie,
    );
    const res = await getReadings(watchId);
    expect(res.status).toBe(404);
  });

  it("unknown watch id returns 404", async () => {
    const res = await getReadings("no-such-watch");
    expect(res.status).toBe(404);
  });
});

// ---- DELETE /api/v1/readings/:id -----------------------------------

describe("DELETE /api/v1/readings/:id", () => {
  it("owner deletes a reading (204) and subsequent GET omits it", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Delete test", movement_id: movementId },
      owner.cookie,
    );
    const post = await postReading(
      watchId,
      {
        reference_timestamp: Date.now(),
        deviation_seconds: 0,
        is_baseline: true,
      },
      owner.cookie,
    );
    const reading = (await post.json()) as ReadingBody;

    const del = await deleteReading(reading.id, owner.cookie);
    expect(del.status).toBe(204);

    const list = await getReadings(watchId, owner.cookie);
    const body = (await list.json()) as GetReadingsBody;
    expect(body.readings.find((r) => r.id === reading.id)).toBeUndefined();
  });

  it(
    "non-owner gets 403",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const { id: watchId } = await createWatch(
        { name: "Not yours", movement_id: movementId, is_public: true },
        owner.cookie,
      );
      const post = await postReading(
        watchId,
        {
          reference_timestamp: Date.now(),
          deviation_seconds: 0,
          is_baseline: true,
        },
        owner.cookie,
      );
      const reading = (await post.json()) as ReadingBody;

      const del = await deleteReading(reading.id, other.cookie);
      expect(del.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );

  it("unknown reading id returns 404 for authed caller", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await deleteReading("not-a-real-reading", cookie);
    expect(res.status).toBe(404);
  });

  it("unauthenticated DELETE is 401", async () => {
    const res = await deleteReading("anything");
    expect(res.status).toBe(401);
  });
});

// ---- FK cascade ----------------------------------------------------

describe("cascade: deleting a watch deletes its readings", () => {
  it("GET on a deleted watch returns 404; row count is 0", async () => {
    const owner = await registerAndGetCookie();
    const { id: watchId } = await createWatch(
      { name: "Cascade", movement_id: movementId },
      owner.cookie,
    );
    await postReading(
      watchId,
      {
        reference_timestamp: Date.now(),
        deviation_seconds: 0,
        is_baseline: true,
      },
      owner.cookie,
    );

    const del = await deleteWatch(watchId, owner.cookie);
    expect(del.status).toBe(204);

    // After the parent watch is gone, GET readings returns 404
    // (because the watch lookup fails first).
    const list = await getReadings(watchId, owner.cookie);
    expect(list.status).toBe(404);

    // Also verify at the SQL layer that the readings row is gone.
    const db = (env as unknown as { DB: D1Database }).DB;
    const row = await db
      .prepare("SELECT COUNT(*) as n FROM readings WHERE watch_id = ?")
      .bind(watchId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
