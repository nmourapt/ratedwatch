// Integration tests for slice #10 — movement submission flow.
// Covers:
//   * POST /api/v1/movements happy path (authed → 201 pending row).
//   * POST anonymous → 401.
//   * POST validation (missing fields, bad enum) → 400.
//   * POST collision with an approved row → 409 + approved row in body.
//   * POST idempotent re-submit (same user, same slug) → 200.
//   * GET suggestions visibility:
//       - submitter sees own pending in `suggestions[]`.
//       - other users do NOT see it.
//       - anonymous callers do NOT see it.
//
// Kept in a separate file from movements.test.ts to minimize merge
// surface with parallel workers.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

interface MovementBody {
  id: string;
  canonical_name: string;
  manufacturer: string;
  caliber: string;
  type: "automatic" | "manual" | "quartz" | "spring-drive" | "other";
  status: "approved" | "pending";
  notes: string | null;
}

interface SubmitSuccess {
  movement: MovementBody;
}

interface SubmitCollision {
  error: string;
  id: string;
  canonical_name: string;
  movement: MovementBody;
}

interface SearchBody {
  approved: MovementBody[];
  suggestions: MovementBody[];
}

// --- helpers ---------------------------------------------------------

function makeEmail(prefix = "submovement"): string {
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

async function submitMovementHttp(body: unknown, cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/movements", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function searchMovements(q: string, cookie?: string): Promise<Response> {
  const qs = new URLSearchParams({ q }).toString();
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/movements?${qs}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
}

// Some tests register two users — miniflare + scrypt makes that
// expensive, so bump the timeout.
const TWO_USER_TIMEOUT = 30_000;

// --- tests -----------------------------------------------------------

describe("POST /api/v1/movements — submit", () => {
  it("creates a pending movement with the submitter attached", async () => {
    const user = await registerAndGetCookie();
    const unique = crypto.randomUUID().slice(0, 8);
    const res = await submitMovementHttp(
      {
        canonical_name: `Acme Cal. ${unique}`,
        manufacturer: "Acme",
        caliber: `cal-${unique}`,
        type: "automatic",
        notes: "User reports excellent timing",
      },
      user.cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as SubmitSuccess;
    expect(body.movement.status).toBe("pending");
    expect(body.movement.manufacturer).toBe("Acme");
    expect(body.movement.canonical_name).toBe(`Acme Cal. ${unique}`);
    expect(body.movement.id).toBe(`acme-cal-${unique}`);

    // Confirm the row landed with submitted_by_user_id = this user.
    const db = (env as unknown as { DB: D1Database }).DB;
    const row = await db
      .prepare("SELECT submitted_by_user_id, status FROM movements WHERE id = ?")
      .bind(body.movement.id)
      .first<{ submitted_by_user_id: string | null; status: string }>();
    expect(row?.submitted_by_user_id).toBe(user.userId);
    expect(row?.status).toBe("pending");
  });

  it("rejects an unauthenticated submission (401)", async () => {
    const unique = crypto.randomUUID().slice(0, 8);
    const res = await submitMovementHttp({
      canonical_name: `Anon ${unique}`,
      manufacturer: "Anon",
      caliber: `x-${unique}`,
      type: "quartz",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("rejects missing manufacturer (400) with a readable message", async () => {
    const user = await registerAndGetCookie();
    const res = await submitMovementHttp(
      {
        canonical_name: "No manufacturer",
        caliber: "whatever-1",
        type: "automatic",
      },
      user.cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("invalid_input");
    expect(body.fieldErrors.manufacturer).toBe("Manufacturer is required");
  });

  it("rejects a bogus type enum value (400)", async () => {
    const user = await registerAndGetCookie();
    const res = await submitMovementHttp(
      {
        canonical_name: "Bad type",
        manufacturer: "X",
        caliber: "y-1",
        type: "not-a-type",
      },
      user.cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("invalid_input");
    expect(body.fieldErrors.type).toBeTruthy();
  });

  it("collides with an approved row and returns 409 with the approved movement", async () => {
    // Seed an approved row with a slug we'll try to collide against.
    const unique = crypto.randomUUID().slice(0, 8);
    const collidingId = `collide-caliber-${unique}`;
    const db = (env as unknown as { DB: D1Database }).DB;
    await db
      .prepare(
        "INSERT INTO movements (id, canonical_name, manufacturer, caliber, type, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        collidingId,
        `Collide Caliber ${unique}`,
        "collide",
        `caliber-${unique}`,
        "automatic",
        "approved",
      )
      .run();

    const user = await registerAndGetCookie();
    const res = await submitMovementHttp(
      {
        canonical_name: "Collide again",
        manufacturer: "collide",
        caliber: `caliber-${unique}`,
        type: "automatic",
      },
      user.cookie,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as SubmitCollision;
    expect(body.error).toBe("movement_exists_approved");
    expect(body.id).toBe(collidingId);
    expect(body.movement.status).toBe("approved");
    expect(body.movement.canonical_name).toBe(`Collide Caliber ${unique}`);
  });

  it("is idempotent when the same user re-submits (200 with existing row)", async () => {
    const user = await registerAndGetCookie();
    const unique = crypto.randomUUID().slice(0, 8);
    const payload = {
      canonical_name: `Dupe Cal ${unique}`,
      manufacturer: "Dupe",
      caliber: `x-${unique}`,
      type: "manual" as const,
    };

    const first = await submitMovementHttp(payload, user.cookie);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as SubmitSuccess;

    const second = await submitMovementHttp(payload, user.cookie);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as SubmitSuccess;
    expect(secondBody.movement.id).toBe(firstBody.movement.id);
    expect(secondBody.movement.status).toBe("pending");
  });
});

describe("GET /api/v1/movements — suggestions visibility", () => {
  it("submitter sees their own pending movement in suggestions", async () => {
    const user = await registerAndGetCookie();
    const unique = crypto.randomUUID().slice(0, 8);
    const canonicalName = `SuggVisible ${unique}`;
    const submit = await submitMovementHttp(
      {
        canonical_name: canonicalName,
        manufacturer: "suggvisible",
        caliber: `c-${unique}`,
        type: "automatic",
      },
      user.cookie,
    );
    expect(submit.status).toBe(201);

    const search = await searchMovements("suggvisible", user.cookie);
    expect(search.status).toBe(200);
    const body = (await search.json()) as SearchBody;
    const suggestionIds = body.suggestions.map((m) => m.id);
    expect(suggestionIds).toContain(`suggvisible-c-${unique}`);
    // Never leaks into approved.
    expect(body.approved.map((m) => m.id)).not.toContain(`suggvisible-c-${unique}`);
  });

  it(
    "a different user does not see someone else's pending submission",
    async () => {
      const alice = await registerAndGetCookie();
      const bob = await registerAndGetCookie();
      const unique = crypto.randomUUID().slice(0, 8);
      const submit = await submitMovementHttp(
        {
          canonical_name: `Alice Only ${unique}`,
          manufacturer: "aliceonly",
          caliber: `c-${unique}`,
          type: "automatic",
        },
        alice.cookie,
      );
      expect(submit.status).toBe(201);

      const search = await searchMovements("aliceonly", bob.cookie);
      expect(search.status).toBe(200);
      const body = (await search.json()) as SearchBody;
      expect(body.suggestions.map((m) => m.id)).not.toContain(`aliceonly-c-${unique}`);
      expect(body.approved.map((m) => m.id)).not.toContain(`aliceonly-c-${unique}`);
    },
    TWO_USER_TIMEOUT,
  );

  it("anonymous callers never see pending submissions", async () => {
    const user = await registerAndGetCookie();
    const unique = crypto.randomUUID().slice(0, 8);
    const submit = await submitMovementHttp(
      {
        canonical_name: `Hidden From Anon ${unique}`,
        manufacturer: "hiddenanon",
        caliber: `c-${unique}`,
        type: "automatic",
      },
      user.cookie,
    );
    expect(submit.status).toBe(201);

    const search = await searchMovements("hiddenanon");
    expect(search.status).toBe(200);
    const body = (await search.json()) as SearchBody;
    expect(body.suggestions).toEqual([]);
    expect(body.approved.map((m) => m.id)).not.toContain(`hiddenanon-c-${unique}`);
  });
});
