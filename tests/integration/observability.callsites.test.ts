// Integration tests asserting that every route instrumented by the
// observability spec emits the expected Analytics Engine event via
// `logEvent`. We intercept `env.ANALYTICS.writeDataPoint` (the
// binding exposed to the Worker) and record each call, then drive the
// routes through the full Hono handler to confirm the event fires in
// the real request path — not just in a unit-test harness.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// ---- Binding interception -----------------------------------------

type DataPoint = AnalyticsEngineDataPoint;

// Pull the ANALYTICS binding off env. In miniflare the binding object
// owns the `writeDataPoint` method — we swap it out in each test so
// we can observe every call.
const analytics = (env as unknown as { ANALYTICS: AnalyticsEngineDataset }).ANALYTICS;
const originalWriteDataPoint = analytics.writeDataPoint.bind(analytics);

let captured: DataPoint[] = [];

beforeEach(() => {
  captured = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (analytics as any).writeDataPoint = (dp?: DataPoint) => {
    if (dp) {
      captured.push({
        blobs: dp.blobs,
        indexes: dp.indexes,
        doubles: dp.doubles,
      });
    }
    // Call through so AE's real behaviour (no-op in miniflare) is preserved.
    originalWriteDataPoint(dp);
  };
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (analytics as any).writeDataPoint = originalWriteDataPoint;
});

function eventsOfKind(kind: string): DataPoint[] {
  return captured.filter((dp) => Array.isArray(dp.indexes) && dp.indexes[0] === kind);
}

// ---- Fixtures ------------------------------------------------------

const movementId = "test-obs-eta-2824";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      movementId,
      "Test Obs ETA 2824",
      "ETA",
      "2824 (obs)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

function makeEmail(prefix = "obs"): string {
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

async function register(): Promise<{ cookie: string; userId: string }> {
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

// ---- Tests ---------------------------------------------------------

describe("observability callsites", () => {
  it("emits page_view_home when GET / is hit", async () => {
    const res = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    expect(res.status).toBe(200);
    expect(eventsOfKind("page_view_home")).toHaveLength(1);
  });

  it("emits page_view_leaderboard with verifiedOnly flag when GET /leaderboard is hit", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/leaderboard?verified=1"),
    );
    expect(res.status).toBe(200);
    const hits = eventsOfKind("page_view_leaderboard");
    expect(hits).toHaveLength(1);
    const payloadJson = hits[0]!.blobs![1] as string;
    const payload = JSON.parse(payloadJson) as { verifiedOnly: boolean };
    expect(payload.verifiedOnly).toBe(true);
  });

  it("emits chrono24_click when GET /out/chrono24/:id is hit", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/out/chrono24/${movementId}`, {
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    const hits = eventsOfKind("chrono24_click");
    expect(hits).toHaveLength(1);
    const payload = JSON.parse(hits[0]!.blobs![1] as string) as {
      movementId: string;
    };
    expect(payload.movementId).toBe(movementId);
  });

  it("emits user_registered when a new user signs up", async () => {
    const before = eventsOfKind("user_registered").length;
    await register();
    const after = eventsOfKind("user_registered").length;
    expect(after - before).toBe(1);
  });

  it("emits watch_added when POST /api/v1/watches succeeds", async () => {
    const { cookie } = await register();
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/watches", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          name: "Test watch",
          movement_id: movementId,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const hits = eventsOfKind("watch_added");
    expect(hits.length).toBeGreaterThan(0);
    const payload = JSON.parse(hits[hits.length - 1]!.blobs![1] as string) as {
      movementId: string;
    };
    expect(payload.movementId).toBe(movementId);
  });

  it("emits reading_submitted when POST /api/v1/watches/:id/readings succeeds", async () => {
    const { cookie } = await register();
    const w = await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/watches", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "R Watch", movement_id: movementId }),
      }),
    );
    const watch = (await w.json()) as { id: string };
    captured = []; // reset so we don't count the watch_added above.

    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/api/v1/watches/${watch.id}/readings`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          reference_timestamp: Date.now(),
          deviation_seconds: 0,
          is_baseline: true,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const hits = eventsOfKind("reading_submitted");
    expect(hits).toHaveLength(1);
    const payload = JSON.parse(hits[0]!.blobs![1] as string) as {
      watchId: string;
      is_baseline: boolean;
    };
    expect(payload.watchId).toBe(watch.id);
    expect(payload.is_baseline).toBe(true);
  });

  it("emits movement_suggested when POST /api/v1/movements succeeds", async () => {
    const { cookie } = await register();
    const suffix = crypto.randomUUID().slice(0, 8);
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/movements", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          canonical_name: `Obs Caliber ${suffix}`,
          manufacturer: "ObsTest",
          caliber: `${suffix}`,
          type: "automatic",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const hits = eventsOfKind("movement_suggested");
    expect(hits.length).toBeGreaterThan(0);
  });
});
