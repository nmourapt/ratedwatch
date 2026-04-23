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

describe("PATCH /api/v1/me — validation", () => {
  it("rejects an invalid character set (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const response = await patchMe({ username: "my name" }, { cookie });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("invalid_input");
    expect(body.fieldErrors.username).toBe("Only letters, numbers, `_`, `.`, `-`");
  });

  it("rejects an @-containing username (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const response = await patchMe({ username: "user@host" }, { cookie });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.username).toBe("Only letters, numbers, `_`, `.`, `-`");
  });

  it("rejects a too-short username (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const response = await patchMe({ username: "x" }, { cookie });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.username).toBe("Username must be 2–30 characters");
  });

  it("rejects a too-long username (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const tooLong = "a".repeat(31);
    const response = await patchMe({ username: tooLong }, { cookie });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.username).toBe("Username must be 2–30 characters");
  });

  it("rejects an empty username (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const response = await patchMe({ username: "" }, { cookie });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.username).toBe("Username must be 2–30 characters");
  });

  it("rejects a leading dot (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const response = await patchMe({ username: ".alice" }, { cookie });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.username).toBe("No leading/trailing dot or dash");
  });

  it("rejects a trailing dash (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const response = await patchMe({ username: "alice-" }, { cookie });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.username).toBe("No leading/trailing dot or dash");
  });

  it("rejects a missing username field (400)", async () => {
    const { cookie } = await registerAndGetCookie();
    const response = await patchMe({}, { cookie });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });
});

describe("PATCH /api/v1/me — auth", () => {
  it("rejects an unauthenticated request (401)", async () => {
    const response = await patchMe({ username: "anon" });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });
});

describe("PATCH /api/v1/me — uniqueness", () => {
  // These tests register two users in sequence, which is expensive
  // against the miniflare + Better Auth stack (~4-5s per register +
  // login round-trip). Give them headroom above the vitest default.
  const TWO_USER_TIMEOUT = 30_000;

  it(
    "rejects a username already taken by another user (409)",
    async () => {
      const first = await registerAndGetCookie();
      const second = await registerAndGetCookie();

      // Second user tries to grab first user's current username.
      const response = await patchMe(
        { username: first.username },
        { cookie: second.cookie },
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("username_taken");
    },
    TWO_USER_TIMEOUT,
  );

  it(
    "rejects a case-variant of another user's username (409)",
    async () => {
      const first = await registerAndGetCookie();
      // Claim a known username on the first account so we can test a
      // deterministic case variation against the second account.
      const claim = `Alice_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const claimRes = await patchMe({ username: claim }, { cookie: first.cookie });
      expect(claimRes.status).toBe(200);

      const second = await registerAndGetCookie();
      const response = await patchMe(
        { username: claim.toLowerCase() },
        { cookie: second.cookie },
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("username_taken");
    },
    TWO_USER_TIMEOUT,
  );

  it("allows a user to re-save their own username (case-only change)", async () => {
    const { cookie } = await registerAndGetCookie();
    const pick = `Bob_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const first = await patchMe({ username: pick }, { cookie });
    expect(first.status).toBe(200);

    // Uppercase their own — must not 409 against themselves.
    const second = await patchMe({ username: pick.toUpperCase() }, { cookie });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { username: string };
    expect(body.username).toBe(pick.toUpperCase());
  });
});

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
