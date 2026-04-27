// Integration tests for PATCH /api/v1/me — slice #80 (PRD #73 User
// Stories #13-#16) added the `consent_corpus` boolean field. The
// existing username path is covered by tests/integration/me.rename.test.ts;
// this file pins the new field's round-trip through the route, the
// schema, and the D1 column added in migrations/0007_verified_reading_cv.sql.
//
// We also lock down the GET /me response so the SPA's settings page
// can read consent_corpus without a separate fetch — and so a
// freshly-registered user always sees the privacy-preserving default
// of `false`.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface RegisteredUser {
  cookie: string;
  email: string;
  userId: string;
}

function makeEmail(prefix = "patch"): string {
  return `${prefix}-${crypto.randomUUID()}@ratedwatch.test`;
}

async function registerAndGetCookie(): Promise<RegisteredUser> {
  const email = makeEmail();
  const password = "correct-horse-42";
  const reg = await exports.default.fetch(
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
  expect(reg.status).toBe(200);
  const regBody = (await reg.json()) as { user: { id: string } };
  const loginRes = await exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(loginRes.status).toBe(200);
  const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { cookie, email, userId: regBody.user.id };
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

async function getMe(cookie: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/me", { headers: { cookie } }),
  );
}

describe("PATCH /api/v1/me — consent_corpus toggle", () => {
  it("defaults consent_corpus to false for newly-registered users on GET /me", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await getMe(cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consent_corpus: boolean };
    // Migration 0007 sets DEFAULT 0 + CHECK on the column. Privacy
    // is preserved by default (PRD User Story #13).
    expect(body.consent_corpus).toBe(false);
  });

  it("flips consent_corpus to true and persists across GET /me", async () => {
    const { cookie } = await registerAndGetCookie();
    const patch = await patchMe({ consent_corpus: true }, { cookie });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as { consent_corpus: boolean };
    expect(patchBody.consent_corpus).toBe(true);

    // Re-fetch /me and confirm the value survives a round-trip.
    const refetch = await getMe(cookie);
    const refetchBody = (await refetch.json()) as { consent_corpus: boolean };
    expect(refetchBody.consent_corpus).toBe(true);
  });

  it("flips consent_corpus back to false on a subsequent PATCH", async () => {
    const { cookie } = await registerAndGetCookie();
    // Turn on, then turn off — full toggle round-trip per PRD User Story #14.
    await patchMe({ consent_corpus: true }, { cookie });
    const off = await patchMe({ consent_corpus: false }, { cookie });
    expect(off.status).toBe(200);
    const body = (await off.json()) as { consent_corpus: boolean };
    expect(body.consent_corpus).toBe(false);
  });

  it("rejects a non-boolean consent_corpus with 400 invalid_input", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await patchMe({ consent_corpus: "yes" }, { cookie });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("invalid_input");
    expect(body.fieldErrors.consent_corpus).toBe("consent_corpus must be a boolean");
  });

  it("accepts consent_corpus alone (no username field required)", async () => {
    const { cookie } = await registerAndGetCookie();
    // The settings UI sends just consent_corpus when the user only
    // toggles the corpus consent. The route must NOT 400 because
    // username is missing.
    const res = await patchMe({ consent_corpus: true }, { cookie });
    expect(res.status).toBe(200);
  });

  it("rejects an empty PATCH body with 400 invalid_input (client bug)", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await patchMe({}, { cookie });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });

  it("requires authentication (401)", async () => {
    const res = await patchMe({ consent_corpus: true });
    expect(res.status).toBe(401);
  });

  it("updates consent_corpus and username together in one PATCH", async () => {
    const { cookie } = await registerAndGetCookie();
    const newName = `dual_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const res = await patchMe({ username: newName, consent_corpus: true }, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      username: string;
      consent_corpus: boolean;
    };
    expect(body.username).toBe(newName);
    expect(body.consent_corpus).toBe(true);
  });

  it("writes the underlying user.consent_corpus column as 0/1", async () => {
    // Direct DB assertion to pin the storage shape — a future
    // refactor that switches to a real BOOLEAN column would need a
    // deliberate edit here, not a silent migration.
    const { cookie, userId } = await registerAndGetCookie();
    await patchMe({ consent_corpus: true }, { cookie });
    const DB = (env as unknown as { DB: D1Database }).DB;
    const row = await DB.prepare("SELECT consent_corpus FROM user WHERE id = ?")
      .bind(userId)
      .first<{ consent_corpus: number }>();
    expect(row).not.toBeNull();
    expect(row!.consent_corpus).toBe(1);
  });
});
