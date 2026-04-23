// Integration tests for PATCH /api/v1/me — the username-rename
// endpoint. Shares the Better Auth setup used by auth.test.ts but
// lives in its own file so Wave 4 workers don't collide on a single
// test module.

import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

function makeEmail(prefix = "rename"): string {
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

async function login(body: { email: string; password: string }): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Registers a user, logs them in, and returns the Cookie header needed
 * to call protected endpoints.
 */
async function registerAndGetCookie(): Promise<{
  cookie: string;
  email: string;
  userId: string;
  username: string;
}> {
  const email = makeEmail();
  const password = "correct-horse-42";
  const reg = await register({ email, password });
  expect(reg.status).toBe(200);
  const regBody = (await reg.json()) as {
    user: { id: string; email: string; username: string };
  };
  const loginRes = await login({ email, password });
  expect(loginRes.status).toBe(200);
  const rawCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(";")[0] ?? "";
  return {
    cookie,
    email,
    userId: regBody.user.id,
    username: regBody.user.username,
  };
}

async function patchMe(body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH /api/v1/me — happy path", () => {
  it("updates the username and returns the updated profile", async () => {
    const { cookie, email, userId } = await registerAndGetCookie();
    const newUsername = `new_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const response = await patchMe({ username: newUsername }, { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      email: string;
      username: string;
    };
    expect(body.id).toBe(userId);
    expect(body.email).toBe(email);
    expect(body.username).toBe(newUsername);
  });

  it("trims surrounding whitespace before storing", async () => {
    const { cookie } = await registerAndGetCookie();
    const raw = `trim_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const response = await patchMe({ username: `  ${raw}  ` }, { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { username: string };
    expect(body.username).toBe(raw);
  });
});
