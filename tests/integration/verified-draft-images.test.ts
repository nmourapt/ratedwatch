// Integration tests for the GET /images/drafts/:userId/:filename
// route added in this PR. The route serves the draft photos that
// `POST /verified/draft` (slice #6 of PRD #99) writes to R2 at
// `drafts/{user_id}/{uuid}.jpg`. The SPA's confirmation page renders
// the URL in an `<img>` so the user can verify the captured dial
// before tapping Confirm.
//
// The handler is owner-only — callerId === userIdSegment in the URL.
// Non-owners and anonymous callers get 404 (NOT 401/403) so a probe
// can't distinguish "this draft exists but isn't yours" from "no
// draft here at all". Filename is validated against a strict
// `^[a-f0-9-]{36}\.jpg$` pattern so the URL can't be twisted into
// path-traversal or arbitrary R2 key reads.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

function makeEmail(prefix = "draft-images"): string {
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

/** Plant a fake draft photo in R2 at the canonical key. */
async function plantDraft(userId: string, filename: string): Promise<string> {
  const key = `drafts/${userId}/${filename}`;
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
  ]);
  const r2 = (env as unknown as { WATCH_IMAGES: R2Bucket }).WATCH_IMAGES;
  await r2.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  return key;
}

async function fetchDraftImage(
  userId: string,
  filename: string,
  cookie?: string,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/images/drafts/${userId}/${filename}`, {
      method: "GET",
      headers: cookie ? { cookie } : undefined,
    }),
  );
}

const TIMEOUT = 30_000;

describe("GET /images/drafts/:userId/:filename", () => {
  it(
    "owner gets the JPEG with private/no-store cache headers",
    async () => {
      const owner = await registerAndGetCookie();
      const filename = `${crypto.randomUUID()}.jpg`;
      await plantDraft(owner.userId, filename);

      const res = await fetchDraftImage(owner.userId, filename, owner.cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      // Drafts are short-lived + owner-specific — no caching anywhere.
      expect(res.headers.get("cache-control")).toBe("private, no-store");

      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8); // JPEG magic preserved
    },
    TIMEOUT,
  );

  it(
    "anonymous caller gets 404 (does not leak existence)",
    async () => {
      const owner = await registerAndGetCookie();
      const filename = `${crypto.randomUUID()}.jpg`;
      await plantDraft(owner.userId, filename);

      const res = await fetchDraftImage(owner.userId, filename, undefined);
      expect(res.status).toBe(404);
    },
    TIMEOUT,
  );

  it(
    "non-owner authed caller gets 404 even when the draft exists",
    async () => {
      const owner = await registerAndGetCookie();
      const intruder = await registerAndGetCookie();
      const filename = `${crypto.randomUUID()}.jpg`;
      await plantDraft(owner.userId, filename);

      const res = await fetchDraftImage(owner.userId, filename, intruder.cookie);
      expect(res.status).toBe(404);
    },
    TIMEOUT,
  );

  it(
    "404 when the R2 object is missing (e.g. confirmed and moved, or expired)",
    async () => {
      const owner = await registerAndGetCookie();
      const filename = `${crypto.randomUUID()}.jpg`;
      // Note: NOT planting the object — this exercises the missing-object branch.

      const res = await fetchDraftImage(owner.userId, filename, owner.cookie);
      expect(res.status).toBe(404);
    },
    TIMEOUT,
  );

  it(
    "rejects non-UUID filenames (path-traversal probe) with 404",
    async () => {
      const owner = await registerAndGetCookie();

      // Each of these MUST 404 without ever touching R2.
      const malformed = [
        "..%2F..%2Fwatches%2Fsome-id%2Fimage", // escaped path traversal
        "image.png", // wrong extension
        "deadbeef.jpg", // too short to be a UUID
        "%2e%2e%2fblob.jpg", // escaped ../
      ];
      for (const filename of malformed) {
        const res = await fetchDraftImage(owner.userId, filename, owner.cookie);
        expect(res.status, `filename=${filename}`).toBe(404);
      }
    },
    TIMEOUT,
  );

  it(
    "rejects when the userId segment doesn't look like a session user",
    async () => {
      const owner = await registerAndGetCookie();
      const filename = `${crypto.randomUUID()}.jpg`;
      await plantDraft(owner.userId, filename);

      // Right filename, but the userId segment is some other arbitrary
      // string that's not the caller's session userId. Must 404.
      const fakeUserId = "not-the-caller";
      const res = await fetchDraftImage(fakeUserId, filename, owner.cookie);
      expect(res.status).toBe(404);
    },
    TIMEOUT,
  );
});
