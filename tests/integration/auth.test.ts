import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

async function login(body: { email: string; password: string }): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function me(headers: HeadersInit = {}): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/me", { headers }),
  );
}

// Auth integration tests. These run against the real Better Auth
// instance mounted at /api/v1/auth/*, with a real D1 backing store
// (miniflare's local SQLite) populated by migrations/0001_init.sql
// via the setup in tests/integration/setup/apply-migrations.ts.

// Unique email per call so tests can run isolated even when the D1
// store isn't reset between them (vitest-pool-workers provides per-test
// storage isolation, but being explicit makes failures easier to read).
function makeEmail(prefix = "test"): string {
  return `${prefix}-${crypto.randomUUID()}@ratedwatch.test`;
}

async function register(body: {
  email: string;
  password: string;
  name?: string;
}): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: body.name ?? body.email.split("@")[0]!,
        email: body.email,
        password: body.password,
      }),
    }),
  );
}

describe("POST /api/v1/auth/sign-up/email — happy path", () => {
  it("creates a user with a generated slug username", async () => {
    const email = makeEmail();
    const response = await register({ email, password: "correct-horse-42" });

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      user: { id: string; email: string; username: string };
    };

    expect(data.user.email).toBe(email);
    expect(data.user.id).toBeTruthy();
    // Generated slug shape: adjective-noun-NNN.
    expect(data.user.username).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });

  it("assigns different usernames to different users", async () => {
    const a = await register({
      email: makeEmail("a"),
      password: "correct-horse-42",
    });
    const b = await register({
      email: makeEmail("b"),
      password: "correct-horse-42",
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const aData = (await a.json()) as { user: { username: string } };
    const bData = (await b.json()) as { user: { username: string } };

    expect(aData.user.username).not.toBe(bData.user.username);
  });
});

describe("POST /api/v1/auth/sign-up/email — duplicate email", () => {
  it("rejects a second registration with the same email", async () => {
    const email = makeEmail("dup");
    const first = await register({ email, password: "correct-horse-42" });
    expect(first.status).toBe(200);

    const second = await register({ email, password: "correct-horse-42" });
    // Better Auth's default behaviour (autoSignIn + no
    // requireEmailVerification) returns a 4xx with a friendly error
    // code. The exact status is 422, but we assert the "not a 2xx"
    // shape so we don't couple the test to an implementation detail
    // that Better Auth could tweak in a minor release.
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
    const body = (await second.json()) as { message?: string };
    expect(body.message?.toLowerCase() ?? "").toMatch(/already|exist|use/);
  });
});

describe("POST /api/v1/auth/sign-in/email", () => {
  it("issues a session cookie on valid credentials", async () => {
    const email = makeEmail("login");
    const password = "correct-horse-42";
    await register({ email, password });

    const response = await login({ email, password });
    expect(response.status).toBe(200);
    // Better Auth sets its session cookie via Set-Cookie on 200.
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    // The cookie name is prefixed with "better-auth." by default.
    expect(setCookie!.toLowerCase()).toContain("better-auth.session");
  });

  it("returns 401 on wrong password", async () => {
    const email = makeEmail("badpw");
    await register({ email, password: "correct-horse-42" });

    const response = await login({ email, password: "wrong-password-00" });
    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/me", () => {
  it("returns 401 JSON when unauthenticated", async () => {
    const response = await me();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns { id, email, username } when authenticated", async () => {
    const email = makeEmail("me");
    const password = "correct-horse-42";
    const reg = await register({ email, password });
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as {
      user: { id: string; email: string; username: string };
    };

    // Sign in to get a fresh session cookie — register typically also
    // returns one (autoSignIn), but replaying /me via the sign-in
    // cookie matches what the real SPA does.
    const loginRes = await login({ email, password });
    expect(loginRes.status).toBe(200);
    const rawCookie = loginRes.headers.get("set-cookie") ?? "";
    const cookie = rawCookie.split(";")[0] ?? "";

    const response = await me({ cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      email: string;
      username: string;
    };
    expect(body.id).toBe(regBody.user.id);
    expect(body.email).toBe(email);
    expect(body.username).toBe(regBody.user.username);
  });
});
