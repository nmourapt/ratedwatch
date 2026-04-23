// Integration tests for Google OAuth via Better Auth's social-provider
// flow (slice 5, issue #6).
//
// Strategy: we exercise the `/api/v1/auth/sign-in/social` endpoint with
// the ID-token branch (`{ idToken: { token } }`). This keeps the test
// stay on-Worker — no Google OAuth redirect round-trip, no real HTTP
// call to Google — while still driving the full user creation / account
// linking code path end-to-end through Better Auth.
//
// Test-only trust model: we gate the production JWT-signature check on
// a miniflare-only binding (`OAUTH_TEST_SKIP_VERIFY`). In production
// Better Auth verifies the token against Google's JWKS; in tests we
// trust a locally-minted unsigned JWT. See src/server/auth.ts.
//
// We do NOT stub `fetch` here. The ID-token branch of Better Auth's
// social sign-in never needs to hit Google when `verifyIdToken` is
// overridden — verification is purely local, and `getUserInfo` on the
// Google provider uses `decodeJwt` (unsigned base64 decode) to read the
// claims back out of the ID token we just supplied.

import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

// Minimal unsigned-JWT encoder. Good enough because `decodeJwt` from
// `jose` — which the Google provider's getUserInfo calls — ignores the
// signature. Production never reaches this helper.
function base64url(input: string): string {
  // btoa outputs standard base64; convert to url-safe and strip padding.
  return btoa(input).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

function mintGoogleIdToken(claims: GoogleIdTokenClaims): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: "test" };
  const payload = {
    iss: "https://accounts.google.com",
    aud: "test-google-client-id",
    azp: "test-google-client-id",
    iat: now,
    exp: now + 3600,
    email_verified: true,
    ...claims,
  };
  // Signature is ignored (local verify override) but a non-empty
  // third segment keeps the value shaped like a real JWT.
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.sig`;
}

async function signInWithGoogleIdToken(idToken: string): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        idToken: { token: idToken },
      }),
    }),
  );
}

async function me(headers: HeadersInit = {}): Promise<Response> {
  return exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/me", { headers }),
  );
}

async function registerEmail(body: {
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

// Unique per call — vitest-pool-workers provides per-file storage
// isolation but being explicit keeps failures readable and lets us
// run several oauth tests in the same file without cross-contamination.
function makeGoogleUser(prefix = "g"): GoogleIdTokenClaims {
  const uuid = crypto.randomUUID();
  return {
    sub: `google-sub-${uuid}`,
    email: `${prefix}-${uuid}@ratedwatch.test`,
    email_verified: true,
    name: `Google User ${prefix}`,
    picture: "https://example.com/avatar.png",
  };
}

describe("POST /api/v1/auth/sign-in/social — new Google user", () => {
  it("creates a user with a generated slug username", async () => {
    const claims = makeGoogleUser("new");
    const response = await signInWithGoogleIdToken(mintGoogleIdToken(claims));

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      user: { id: string; email: string; username: string };
    };
    expect(data.user.id).toBeTruthy();
    expect(data.user.email).toBe(claims.email);
    // Same slug shape as the email/password signup — proof that the
    // database `user.create.before` hook fires for OAuth users too.
    expect(data.user.username).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });

  it("issues a session cookie so /me succeeds with it", async () => {
    const claims = makeGoogleUser("sess");
    const response = await signInWithGoogleIdToken(mintGoogleIdToken(claims));
    expect(response.status).toBe(200);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!.toLowerCase()).toContain("better-auth.session");
    const cookie = setCookie!.split(";")[0] ?? "";

    const meResponse = await me({ cookie });
    expect(meResponse.status).toBe(200);
    const body = (await meResponse.json()) as {
      id: string;
      email: string;
      username: string;
    };
    expect(body.email).toBe(claims.email);
    expect(body.username).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });
});

describe("POST /api/v1/auth/sign-in/social — returning Google user", () => {
  it("returns the same user (no second user row, same username)", async () => {
    const claims = makeGoogleUser("return");

    const first = await signInWithGoogleIdToken(mintGoogleIdToken(claims));
    expect(first.status).toBe(200);
    const firstData = (await first.json()) as {
      user: { id: string; username: string };
    };

    const second = await signInWithGoogleIdToken(mintGoogleIdToken(claims));
    expect(second.status).toBe(200);
    const secondData = (await second.json()) as {
      user: { id: string; username: string };
    };

    // Same stable user id + username — we didn't mistakenly re-register.
    expect(secondData.user.id).toBe(firstData.user.id);
    expect(secondData.user.username).toBe(firstData.user.username);
  });
});

describe("POST /api/v1/auth/sign-in/social — email collision", () => {
  it("rejects a Google sign-in whose email is already claimed by an email/password user", async () => {
    // Register an email/password user first.
    const uuid = crypto.randomUUID();
    const sharedEmail = `collide-${uuid}@ratedwatch.test`;
    const reg = await registerEmail({
      email: sharedEmail,
      password: "correct-horse-42",
    });
    expect(reg.status).toBe(200);

    // Now try to sign in with Google using the same email. Our auth
    // config disables implicit account linking, so Better Auth returns
    // 4xx JSON with an "account not linked" style error.
    const response = await signInWithGoogleIdToken(
      mintGoogleIdToken({
        sub: `google-sub-${uuid}`,
        email: sharedEmail,
        email_verified: true,
        name: "Google Collision",
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const body = (await response.json()) as { message?: string };
    const msg = body.message?.toLowerCase() ?? "";
    // Better Auth emits "account not linked" for this case. We assert
    // on the "link" keyword so the test doesn't couple to exact wording
    // if Better Auth tweaks the string in a minor release.
    expect(msg).toMatch(/account|link|exist/);
  });
});
