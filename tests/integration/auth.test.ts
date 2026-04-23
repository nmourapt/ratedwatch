import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

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
