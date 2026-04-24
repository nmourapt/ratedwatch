// Origin-allowlist tests for Better Auth (issue: mobile users hit
// "invalid origin" on /api/v1/auth/sign-in/email).
//
// Better Auth's `formCsrfMiddleware` runs on /sign-up/email and
// /sign-in/email. When the request includes a `Cookie` header, the
// middleware calls `validateOrigin`, which:
//
//  1. Reads `Origin` (or `Referer` as fallback). If both are missing
//     or the value is the literal string `"null"`, it throws 403
//     MISSING_OR_NULL_ORIGIN.
//  2. Otherwise, matches the origin against `trustedOrigins`. On a
//     miss, throws 403 INVALID_ORIGIN.
//
// We send a junk cookie (its value doesn't matter — the gate is
// `headers.has("cookie")`) and use a deployed-style URL so the
// inferred-from-request fallback can't accidentally accept origins
// other than the requested host.
//
// Expected behaviour after fix (src/server/auth.ts adds explicit
// baseURL + trustedOrigins):
//
//   • Origin: https://rated.watch                                → 200
//   • Origin: https://ratedwatch.nmoura.workers.dev              → 200
//   • Origin: https://pr-99-ratedwatch.nmoura.workers.dev        → 200 (wildcard)
//   • Origin: https://evil.example.com                            → 403 INVALID_ORIGIN
//   • No Origin header (Cookie present)                           → 403 MISSING_OR_NULL_ORIGIN
//
// The deny tests double as regression guards: they already pass in
// the broken state (because today the inferred trusted origin is
// whatever the request URL host is, i.e. rated.watch — so anything
// else is rejected). The two wildcard / workers.dev tests are what
// actually fails before the fix.

import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

const SIGN_UP_URL = "https://rated.watch/api/v1/auth/sign-up/email";

function makeEmail(prefix = "origin"): string {
  return `${prefix}-${crypto.randomUUID()}@ratedwatch.test`;
}

async function signUpWithOrigin(origin: string | null, email: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // The presence of a Cookie header is what triggers Better Auth's
    // origin validation in formCsrfMiddleware (see
    // node_modules/better-auth/dist/api/middlewares/origin-check.mjs:
    // validateFormCsrf → validateOrigin). The value itself is never
    // verified — it's just a gate.
    cookie: "rw_dummy=1",
  };
  if (origin !== null) headers.origin = origin;

  return exports.default.fetch(
    new Request(SIGN_UP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: email.split("@")[0]!,
        email,
        password: "correct-horse-42",
      }),
    }),
  );
}

describe("Better Auth origin validation — accepted origins", () => {
  it("accepts the canonical https://rated.watch origin", async () => {
    const response = await signUpWithOrigin("https://rated.watch", makeEmail("rw"));
    expect(response.status).toBe(200);
  });

  it("accepts the workers.dev fallback origin", async () => {
    const response = await signUpWithOrigin(
      "https://ratedwatch.nmoura.workers.dev",
      makeEmail("wd"),
    );
    expect(response.status).toBe(200);
  });

  it("accepts a preview-alias origin via the wildcard pattern", async () => {
    // pr-99 is arbitrary — the wildcard
    // https://*-ratedwatch.nmoura.workers.dev must match any
    // pr-<N>-ratedwatch.nmoura.workers.dev preview deploy. We pick
    // pr-99 specifically to leave space for the cache-vary-cookie
    // preview at pr-65 in case a future test wants to assert on a
    // real preview number too.
    const response = await signUpWithOrigin(
      "https://pr-99-ratedwatch.nmoura.workers.dev",
      makeEmail("preview"),
    );
    expect(response.status).toBe(200);
  });
});

describe("Better Auth origin validation — rejected origins", () => {
  it("rejects an untrusted origin with 403 INVALID_ORIGIN", async () => {
    const response = await signUpWithOrigin(
      "https://evil.example.com",
      makeEmail("evil"),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe("INVALID_ORIGIN");
  });

  it("rejects a request with a Cookie but no Origin (or Referer) header", async () => {
    const response = await signUpWithOrigin(null, makeEmail("noorigin"));
    expect(response.status).toBe(403);
    // Better Auth raises MISSING_OR_NULL_ORIGIN for this case.
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe("MISSING_OR_NULL_ORIGIN");
  });
});
