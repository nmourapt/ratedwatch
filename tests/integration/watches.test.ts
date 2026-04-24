// Integration tests for the /api/v1/watches surface. Covers:
//
//   * POST — happy, schema validation, auth gate, movement validation.
//   * GET /  — returns only the caller's own watches.
//   * GET /:id — owner / other-authed / anonymous, public vs private.
//   * PATCH — owner updates, non-owner 403.
//   * DELETE — owner deletes, non-owner 403.
//
// The auth parts reuse the same Better Auth sign-up / sign-in path as
// tests/integration/me.rename.test.ts, so each registerAndGetCookie()
// call is expensive (miniflare + scrypt). Tests that register two
// users therefore get an extended timeout.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";

// ---- Test fixture: one approved + one pending movement --------------

const approvedMovementId = "test-eta-2824-watches";
const pendingMovementId = "test-prototype-watches";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  // INSERT OR IGNORE is idempotent against re-runs inside the same
  // miniflare storage isolation window.
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await stmt
    .bind(
      approvedMovementId,
      "Test ETA 2824 (watches)",
      "ETA",
      "2824 (watches)",
      "automatic",
      "approved",
      null,
    )
    .run();
  await stmt
    .bind(
      pendingMovementId,
      "Test Prototype (watches)",
      "Prototype",
      "X-0001",
      "automatic",
      "pending",
      // submitted_by is attached per-test later if needed; default null.
      null,
    )
    .run();
});

// ---- Test helpers (auth, fetch wrappers) ---------------------------

function makeEmail(prefix = "watches"): string {
  return `${prefix}-${crypto.randomUUID()}@ratedwatch.test`;
}

async function signUp(email: string, password: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: email.split("@")[0]!,
        email,
        password,
      }),
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
  email: string;
  username: string;
}

async function registerAndGetCookie(): Promise<TestUser> {
  const email = makeEmail();
  const password = "correct-horse-42";
  const reg = await signUp(email, password);
  expect(reg.status).toBe(200);
  const regBody = (await reg.json()) as {
    user: { id: string; email: string; username: string };
  };
  const loginRes = await signIn(email, password);
  expect(loginRes.status).toBe(200);
  const rawCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(";")[0] ?? "";
  return {
    cookie,
    userId: regBody.user.id,
    email,
    username: regBody.user.username,
  };
}

async function listWatches(cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/watches", {
      headers: cookie ? { cookie } : {},
    }),
  );
}

async function createWatch(body: unknown, cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/watches", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function getWatch(id: string, cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${id}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
}

async function patchWatch(id: string, body: unknown, cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function deleteWatch(id: string, cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${id}`, {
      method: "DELETE",
      headers: cookie ? { cookie } : {},
    }),
  );
}

interface WatchBody {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  model: string | null;
  reference: string | null;
  movement_id: string | null;
  movement_canonical_name: string | null;
  custom_movement_name: string | null;
  notes: string | null;
  is_public: boolean;
  created_at: string;
}

// Two-user tests need a generous timeout: each registration takes a
// few seconds under the miniflare Better Auth scrypt path.
const TWO_USER_TIMEOUT = 30_000;

// ---- POST /api/v1/watches ------------------------------------------

describe("POST /api/v1/watches", () => {
  it("creates a watch and returns the full shape", async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const res = await createWatch(
      {
        name: "My Submariner",
        brand: "Rolex",
        model: "Submariner 126610LN",
        movement_id: approvedMovementId,
        notes: "Daily wearer",
        is_public: true,
      },
      cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as WatchBody;
    expect(body.user_id).toBe(userId);
    expect(body.name).toBe("My Submariner");
    expect(body.brand).toBe("Rolex");
    expect(body.model).toBe("Submariner 126610LN");
    expect(body.movement_id).toBe(approvedMovementId);
    expect(body.movement_canonical_name).toBe("Test ETA 2824 (watches)");
    expect(body.is_public).toBe(true);
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(10); // uuid-ish
    expect(typeof body.created_at).toBe("string");
  });

  it("defaults is_public to true when omitted", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await createWatch(
      { name: "Quiet watch", movement_id: approvedMovementId },
      cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as WatchBody;
    expect(body.is_public).toBe(true);
  });

  it("rejects a missing name (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await createWatch({ movement_id: approvedMovementId }, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("invalid_input");
    expect(body.fieldErrors.name).toBe("Name is required");
  });

  it("rejects an unknown movement_id (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await createWatch(
      { name: "Phantom", movement_id: "does-not-exist-xyz" },
      cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_movement");
  });

  it("rejects a pending movement submitted by a different user (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    // Default fixture: submitted_by_user_id is null, so this user did
    // not submit it → not allowed.
    const res = await createWatch(
      { name: "Pending block", movement_id: pendingMovementId },
      cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_movement");
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = await createWatch({
      name: "Anon",
      movement_id: approvedMovementId,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  // Slice (issue #57): reference field round-trips through create +
  // get + patch. Covers three shapes: populated, omitted-at-create
  // (→ null), and cleared-via-patch (empty string → null).
  it("persists `reference` through POST + GET + PATCH", async () => {
    const { cookie } = await registerAndGetCookie();
    const create = await createWatch(
      {
        name: "Speedy",
        brand: "Omega",
        model: "Speedmaster Pro",
        reference: "3570.50",
        movement_id: approvedMovementId,
      },
      cookie,
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as WatchBody;
    expect(created.reference).toBe("3570.50");

    const read = await getWatch(created.id, cookie);
    const readBody = (await read.json()) as WatchBody;
    expect(readBody.reference).toBe("3570.50");

    const patched = await patchWatch(created.id, { reference: "ST105.012" }, cookie);
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as WatchBody;
    expect(after.reference).toBe("ST105.012");

    // Empty string clears the field (null round-trip).
    const cleared = await patchWatch(created.id, { reference: "" }, cookie);
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as WatchBody;
    expect(clearedBody.reference).toBeNull();
  });

  it("omitted `reference` stores as null", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await createWatch(
      { name: "Refless", movement_id: approvedMovementId },
      cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as WatchBody;
    expect(body.reference).toBeNull();
  });

  it("rejects a reference longer than 50 chars (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await createWatch(
      {
        name: "Too long",
        reference: "X".repeat(51),
        movement_id: approvedMovementId,
      },
      cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("invalid_input");
    expect(body.fieldErrors.reference).toMatch(/50/);
  });
});

// ---- GET /api/v1/watches -------------------------------------------

describe("GET /api/v1/watches", () => {
  it(
    "returns only the caller's own watches",
    async () => {
      const userA = await registerAndGetCookie();
      const userB = await registerAndGetCookie();

      const createA = await createWatch(
        { name: "A watch", movement_id: approvedMovementId },
        userA.cookie,
      );
      expect(createA.status).toBe(201);
      const watchA = (await createA.json()) as WatchBody;

      const createB = await createWatch(
        { name: "B watch", movement_id: approvedMovementId },
        userB.cookie,
      );
      expect(createB.status).toBe(201);

      const listA = await listWatches(userA.cookie);
      expect(listA.status).toBe(200);
      const bodyA = (await listA.json()) as { watches: WatchBody[] };
      const aIds = bodyA.watches.map((w) => w.id);
      expect(aIds).toContain(watchA.id);
      // User A never sees user B's watches.
      for (const w of bodyA.watches) {
        expect(w.user_id).toBe(userA.userId);
      }
    },
    TWO_USER_TIMEOUT,
  );

  it("rejects an unauthenticated request (401)", async () => {
    const res = await listWatches();
    expect(res.status).toBe(401);
  });

  // Slice 18: GET /watches embeds session_stats on each row so the
  // dashboard can render the verified progress ring per-card without
  // a second round-trip per watch.
  it(
    "embeds session_stats with reading_count + verified_ratio on each watch row",
    async () => {
      const user = await registerAndGetCookie();
      const create = await createWatch(
        { name: "Ring-owner", movement_id: approvedMovementId },
        user.cookie,
      );
      expect(create.status).toBe(201);
      const res = await listWatches(user.cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        watches: Array<{
          id: string;
          session_stats: {
            reading_count: number;
            verified_ratio: number;
            verified_badge: boolean;
            eligible: boolean;
          };
        }>;
      };
      expect(body.watches.length).toBeGreaterThan(0);
      for (const w of body.watches) {
        expect(w.session_stats).toBeDefined();
        expect(typeof w.session_stats.reading_count).toBe("number");
        expect(typeof w.session_stats.verified_ratio).toBe("number");
        expect(typeof w.session_stats.verified_badge).toBe("boolean");
        expect(typeof w.session_stats.eligible).toBe("boolean");
      }
    },
    TWO_USER_TIMEOUT,
  );
});

// ---- GET /api/v1/watches/:id ---------------------------------------

describe("GET /api/v1/watches/:id", () => {
  it("owner reads their own watch (200)", async () => {
    const user = await registerAndGetCookie();
    const create = await createWatch(
      { name: "Mine", movement_id: approvedMovementId },
      user.cookie,
    );
    const { id } = (await create.json()) as WatchBody;

    const res = await getWatch(id, user.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WatchBody;
    expect(body.id).toBe(id);
    expect(body.user_id).toBe(user.userId);
  });

  it(
    "another authed user reads a public watch (200)",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const create = await createWatch(
        { name: "Public one", movement_id: approvedMovementId, is_public: true },
        owner.cookie,
      );
      const { id } = (await create.json()) as WatchBody;

      const res = await getWatch(id, other.cookie);
      expect(res.status).toBe(200);
    },
    TWO_USER_TIMEOUT,
  );

  it(
    "another authed user gets 404 for a private watch",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const create = await createWatch(
        { name: "Private one", movement_id: approvedMovementId, is_public: false },
        owner.cookie,
      );
      const { id } = (await create.json()) as WatchBody;

      const res = await getWatch(id, other.cookie);
      expect(res.status).toBe(404);
    },
    TWO_USER_TIMEOUT,
  );

  it("anonymous reads a public watch (200)", async () => {
    const owner = await registerAndGetCookie();
    const create = await createWatch(
      { name: "Public anon", movement_id: approvedMovementId, is_public: true },
      owner.cookie,
    );
    const { id } = (await create.json()) as WatchBody;

    const res = await getWatch(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WatchBody;
    expect(body.is_public).toBe(true);
  });

  it("anonymous gets 404 for a private watch", async () => {
    const owner = await registerAndGetCookie();
    const create = await createWatch(
      { name: "Private anon", movement_id: approvedMovementId, is_public: false },
      owner.cookie,
    );
    const { id } = (await create.json()) as WatchBody;

    const res = await getWatch(id);
    expect(res.status).toBe(404);
  });

  it("unknown id returns 404", async () => {
    const res = await getWatch("definitely-not-an-id");
    expect(res.status).toBe(404);
  });
});

// ---- PATCH /api/v1/watches/:id -------------------------------------

describe("PATCH /api/v1/watches/:id", () => {
  it("owner can update name + is_public", async () => {
    const owner = await registerAndGetCookie();
    const create = await createWatch(
      { name: "Before", movement_id: approvedMovementId, is_public: true },
      owner.cookie,
    );
    const { id } = (await create.json()) as WatchBody;

    const res = await patchWatch(id, { name: "After", is_public: false }, owner.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WatchBody;
    expect(body.name).toBe("After");
    expect(body.is_public).toBe(false);
  });

  it(
    "non-owner gets 403",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const create = await createWatch(
        { name: "Mine", movement_id: approvedMovementId, is_public: true },
        owner.cookie,
      );
      const { id } = (await create.json()) as WatchBody;

      const res = await patchWatch(id, { name: "Hijack" }, other.cookie);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");
    },
    TWO_USER_TIMEOUT,
  );

  it("unknown id returns 404", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await patchWatch("nope", { name: "whatever" }, cookie);
    expect(res.status).toBe(404);
  });

  it("unauthenticated PATCH is 401", async () => {
    const res = await patchWatch("anything", { name: "whatever" });
    expect(res.status).toBe(401);
  });
});

// ---- DELETE /api/v1/watches/:id ------------------------------------

describe("DELETE /api/v1/watches/:id", () => {
  it("owner deletes a watch (204) and subsequent GET returns 404", async () => {
    const owner = await registerAndGetCookie();
    const create = await createWatch(
      { name: "Doomed", movement_id: approvedMovementId },
      owner.cookie,
    );
    const { id } = (await create.json()) as WatchBody;

    const del = await deleteWatch(id, owner.cookie);
    expect(del.status).toBe(204);

    const follow = await getWatch(id, owner.cookie);
    expect(follow.status).toBe(404);
  });

  it(
    "non-owner gets 403",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const create = await createWatch(
        { name: "Safe", movement_id: approvedMovementId },
        owner.cookie,
      );
      const { id } = (await create.json()) as WatchBody;

      const del = await deleteWatch(id, other.cookie);
      expect(del.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );

  it("unknown id returns 404", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await deleteWatch("nothing-here", cookie);
    expect(res.status).toBe(404);
  });

  it("unauthenticated DELETE is 401", async () => {
    const res = await deleteWatch("anything");
    expect(res.status).toBe(401);
  });
});
