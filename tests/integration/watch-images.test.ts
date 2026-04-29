// Integration tests for the /api/v1/watches/:id/image surface plus
// the public /images/watches/:id serving route (slice #10, issue #11).
//
// We reuse the same Better Auth sign-up/sign-in helpers as
// tests/integration/watches.test.ts. Each two-user test gets an
// extended timeout to cover the slow scrypt path under miniflare.
//
// The R2 binding is the real miniflare R2 bucket (in-memory per worker
// pool) so we can assert on `env.WATCH_IMAGES.get(key)` directly.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";

const approvedMovementId = "test-eta-2824-watch-images";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      approvedMovementId,
      "Test ETA 2824 (watch-images)",
      "ETA",
      "2824 (watch-images)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

// ---- Test helpers (auth, fetch wrappers) ---------------------------

function makeEmail(prefix = "watch-images"): string {
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

async function createWatch(
  body: { name: string; is_public?: boolean; movement_id?: string },
  cookie: string,
): Promise<string> {
  const res = await exports.default.fetch(
    new Request("https://ratedwatch.test/api/v1/watches", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        movement_id: approvedMovementId,
        ...body,
      }),
    }),
  );
  expect(res.status).toBe(201);
  const parsed = (await res.json()) as { id: string };
  return parsed.id;
}

// --- multipart helper ------------------------------------------------

async function uploadImage(
  watchId: string,
  body: BodyInit,
  cookie?: string,
  init: Partial<RequestInit> = {},
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/image`, {
      method: "PUT",
      body,
      ...init,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
  );
}

/** Build a multipart/form-data body with a single `image` file part. */
function makeImageFormData(
  bytes: Uint8Array,
  contentType: string,
  filename = "photo.bin",
): FormData {
  const form = new FormData();
  form.append("image", new File([bytes], filename, { type: contentType }));
  return form;
}

/** Minimal valid JPEG header bytes (enough that content-type detection + R2 store pass). */
function jpegBytes(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size);
  // JPEG magic: FF D8 FF E0
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  return bytes;
}

const TWO_USER_TIMEOUT = 30_000;

// ---- PUT /api/v1/watches/:id/image ---------------------------------

describe("PUT /api/v1/watches/:id/image", () => {
  it("owner uploads a JPEG and R2 + DB are updated (200)", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch({ name: "With photo" }, owner.cookie);

    const form = makeImageFormData(jpegBytes(4096), "image/jpeg", "front.jpg");
    const res = await uploadImage(watchId, form, owner.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.key).toBe(`watches/${watchId}/image`);

    // R2 object exists with the stored content-type.
    const stored = await (env as unknown as { WATCH_IMAGES: R2Bucket }).WATCH_IMAGES.get(
      body.key,
    );
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe("image/jpeg");

    // DB row now records the key.
    const db = (env as unknown as { DB: D1Database }).DB;
    const row = await db
      .prepare("SELECT image_r2_key FROM watches WHERE id = ?")
      .bind(watchId)
      .first<{ image_r2_key: string | null }>();
    expect(row?.image_r2_key).toBe(body.key);
  });

  it("rejects files over the 5 MB limit (413)", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch({ name: "Too big" }, owner.cookie);

    // 5 MB + 1 byte
    const big = jpegBytes(5 * 1024 * 1024 + 1);
    const form = makeImageFormData(big, "image/jpeg");
    const res = await uploadImage(watchId, form, owner.cookie);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("payload_too_large");
  });

  it("rejects unsupported content types (415)", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch({ name: "Wrong type" }, owner.cookie);

    const form = makeImageFormData(
      new TextEncoder().encode("not an image"),
      "text/plain",
      "not-an-image.txt",
    );
    const res = await uploadImage(watchId, form, owner.cookie);
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_media_type");
  });

  it("rejects anonymous uploads (401)", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch({ name: "Anon block" }, owner.cookie);

    const form = makeImageFormData(jpegBytes(), "image/jpeg");
    const res = await uploadImage(watchId, form);
    expect(res.status).toBe(401);
  });

  it(
    "rejects non-owner uploads (403)",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const watchId = await createWatch({ name: "Mine only" }, owner.cookie);

      const form = makeImageFormData(jpegBytes(), "image/jpeg");
      const res = await uploadImage(watchId, form, other.cookie);
      expect(res.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );

  it("returns 404 for an unknown watch id", async () => {
    const owner = await registerAndGetCookie();
    const form = makeImageFormData(jpegBytes(), "image/jpeg");
    const res = await uploadImage("does-not-exist", form, owner.cookie);
    expect(res.status).toBe(404);
  });
});

// ---- DELETE /api/v1/watches/:id/image ------------------------------

describe("DELETE /api/v1/watches/:id/image", () => {
  it("owner deletes the image (204), R2 key gone, column NULL", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch({ name: "Will clear" }, owner.cookie);

    const form = makeImageFormData(jpegBytes(), "image/jpeg");
    const up = await uploadImage(watchId, form, owner.cookie);
    expect(up.status).toBe(200);

    const del = await exports.default.fetch(
      new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/image`, {
        method: "DELETE",
        headers: { cookie: owner.cookie },
      }),
    );
    expect(del.status).toBe(204);

    const stored = await (env as unknown as { WATCH_IMAGES: R2Bucket }).WATCH_IMAGES.get(
      `watches/${watchId}/image`,
    );
    expect(stored).toBeNull();

    const db = (env as unknown as { DB: D1Database }).DB;
    const row = await db
      .prepare("SELECT image_r2_key FROM watches WHERE id = ?")
      .bind(watchId)
      .first<{ image_r2_key: string | null }>();
    expect(row?.image_r2_key).toBeNull();
  });

  it(
    "non-owner gets 403",
    async () => {
      const owner = await registerAndGetCookie();
      const other = await registerAndGetCookie();
      const watchId = await createWatch({ name: "Safe" }, owner.cookie);

      const form = makeImageFormData(jpegBytes(), "image/jpeg");
      await uploadImage(watchId, form, owner.cookie);

      const del = await exports.default.fetch(
        new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/image`, {
          method: "DELETE",
          headers: { cookie: other.cookie },
        }),
      );
      expect(del.status).toBe(403);
    },
    TWO_USER_TIMEOUT,
  );

  it("anonymous DELETE is 401", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch({ name: "Anon del" }, owner.cookie);
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/api/v1/watches/${watchId}/image`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(401);
  });
});

// ---- GET /images/watches/:id (public serving) ----------------------

describe("GET /images/watches/:id", () => {
  it("anonymous sees public watch image (200) with public cache headers", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch(
      { name: "Public photo", is_public: true },
      owner.cookie,
    );
    const form = makeImageFormData(jpegBytes(), "image/jpeg");
    const up = await uploadImage(watchId, form, owner.cookie);
    expect(up.status).toBe(200);

    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/images/watches/${watchId}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const cache = res.headers.get("cache-control") ?? "";
    expect(cache).toContain("public");
    expect(cache).toContain("max-age=3600");
    expect(cache).toContain("s-maxage=86400");
    expect(cache).toContain("stale-while-revalidate=604800");
    // Body should match the uploaded size.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(1024);
  });

  it(
    "anonymous gets 404 for a private watch image (does not leak existence)",
    async () => {
      const owner = await registerAndGetCookie();
      const watchId = await createWatch(
        { name: "Private photo", is_public: false },
        owner.cookie,
      );
      const form = makeImageFormData(jpegBytes(), "image/jpeg");
      await uploadImage(watchId, form, owner.cookie);

      const res = await exports.default.fetch(
        new Request(`https://ratedwatch.test/images/watches/${watchId}`),
      );
      expect(res.status).toBe(404);
    },
    TWO_USER_TIMEOUT,
  );

  it("owner sees their own private watch image (200) with private cache headers", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch(
      { name: "Owner-only photo", is_public: false },
      owner.cookie,
    );
    const form = makeImageFormData(jpegBytes(), "image/jpeg");
    await uploadImage(watchId, form, owner.cookie);

    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/images/watches/${watchId}`, {
        headers: { cookie: owner.cookie },
      }),
    );
    expect(res.status).toBe(200);
    const cache = res.headers.get("cache-control") ?? "";
    expect(cache).toContain("private");
    expect(cache).toContain("max-age=300");
  });

  it("returns 404 when the watch has no image set", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch(
      { name: "No image yet", is_public: true },
      owner.cookie,
    );
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/images/watches/${watchId}`),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown watch id", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/images/watches/definitely-nope"),
    );
    expect(res.status).toBe(404);
  });
});

// ---- Watch delete cascades the R2 image ----------------------------

describe("DELETE /api/v1/watches/:id cascades the image", () => {
  it("removes the R2 object when the watch is deleted", async () => {
    const owner = await registerAndGetCookie();
    const watchId = await createWatch({ name: "Will cascade" }, owner.cookie);

    const form = makeImageFormData(jpegBytes(), "image/jpeg");
    const up = await uploadImage(watchId, form, owner.cookie);
    expect(up.status).toBe(200);

    const key = `watches/${watchId}/image`;
    const before = await (env as unknown as { WATCH_IMAGES: R2Bucket }).WATCH_IMAGES.get(
      key,
    );
    expect(before).not.toBeNull();

    const del = await exports.default.fetch(
      new Request(`https://ratedwatch.test/api/v1/watches/${watchId}`, {
        method: "DELETE",
        headers: { cookie: owner.cookie },
      }),
    );
    expect(del.status).toBe(204);

    const after = await (env as unknown as { WATCH_IMAGES: R2Bucket }).WATCH_IMAGES.get(
      key,
    );
    expect(after).toBeNull();
  });
});
