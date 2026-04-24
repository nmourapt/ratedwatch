// Integration tests for the SEO plumbing routes (followup/robots-sitemap):
//
//   * GET /robots.txt   — static directives + Sitemap pointer
//   * GET /sitemap.xml  — dynamic enumeration of indexable URLs
//
// Both are owned by the Worker (see wrangler.jsonc run_worker_first).
// Sitemap rules:
//   * Always emits canonical https://rated.watch URLs regardless of
//     the host that hit the Worker.
//   * Public watches → included; private watches → excluded.
//   * Users with at least one public watch → included; users with no
//     public watches → excluded (avoids leaks + empty pages).
//   * Approved movements → included; pending → excluded (matches the
//     /m/:id 404 rule).
//
// Seeds run inside per-test-file storage isolation (vitest-pool-workers).
// Distinct ids namespace this file from public-pages.test.ts so the
// sitemap assertions stay deterministic even if both tests seed in
// the same miniflare instance.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const runId = crypto.randomUUID().slice(0, 8);
const id = (suffix: string) => `seo-${runId}-${suffix}`;

const SEED = {
  // Owner with at least one public watch — should appear in the sitemap.
  ownerWithPublic: {
    id: id("user-pub"),
    name: "Public Owner",
    username: id("pub-owner").toLowerCase(),
    email: `${id("pub")}@test`,
  },
  // Owner with only private watches — should NOT appear.
  ownerPrivateOnly: {
    id: id("user-priv"),
    name: "Private Owner",
    username: id("priv-owner").toLowerCase(),
    email: `${id("priv")}@test`,
  },
  movements: {
    approved: {
      id: id("mov-approved"),
      canonical_name: `ETA ${id("APPR")}`,
      manufacturer: "ETA",
      caliber: id("APPR"),
      type: "automatic" as const,
      status: "approved" as const,
    },
    pending: {
      id: id("mov-pending"),
      canonical_name: `Proto ${id("PEND")}`,
      manufacturer: "Proto",
      caliber: id("PEND"),
      type: "automatic" as const,
      status: "pending" as const,
    },
  },
  watches: {
    pub: {
      id: id("w-pub"),
      name: "Sitemap Public",
      brand: "Rolex",
      model: "Submariner",
      is_public: 1,
    },
    priv: {
      id: id("w-priv"),
      name: "Sitemap Private",
      brand: "Nomos",
      model: "Tangente",
      is_public: 0,
    },
    privOnlyOwner: {
      id: id("w-priv-only"),
      name: "Hidden",
      brand: "Hidden",
      model: "Hidden",
      is_public: 0,
    },
  },
};

async function seed() {
  const db = (env as unknown as { DB: D1Database }).DB;
  const iso = new Date().toISOString();

  // Users.
  for (const u of [SEED.ownerWithPublic, SEED.ownerPrivateOnly]) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO user (id, name, email, emailVerified, username, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)",
      )
      .bind(u.id, u.name, u.email, u.username, iso, iso)
      .run();
  }

  // Movements (approved + pending).
  for (const m of [SEED.movements.approved, SEED.movements.pending]) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(m.id, m.canonical_name, m.manufacturer, m.caliber, m.type, m.status, null)
      .run();
  }

  // Public watch owned by ownerWithPublic.
  await db
    .prepare(
      "INSERT OR IGNORE INTO watches (id, user_id, name, brand, model, movement_id, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      SEED.watches.pub.id,
      SEED.ownerWithPublic.id,
      SEED.watches.pub.name,
      SEED.watches.pub.brand,
      SEED.watches.pub.model,
      SEED.movements.approved.id,
      1,
    )
    .run();
  // Private watch owned by ownerWithPublic.
  await db
    .prepare(
      "INSERT OR IGNORE INTO watches (id, user_id, name, brand, model, movement_id, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      SEED.watches.priv.id,
      SEED.ownerWithPublic.id,
      SEED.watches.priv.name,
      SEED.watches.priv.brand,
      SEED.watches.priv.model,
      SEED.movements.approved.id,
      0,
    )
    .run();
  // Private watch owned by ownerPrivateOnly.
  await db
    .prepare(
      "INSERT OR IGNORE INTO watches (id, user_id, name, brand, model, movement_id, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      SEED.watches.privOnlyOwner.id,
      SEED.ownerPrivateOnly.id,
      SEED.watches.privOnlyOwner.name,
      SEED.watches.privOnlyOwner.brand,
      SEED.watches.privOnlyOwner.model,
      SEED.movements.approved.id,
      0,
    )
    .run();

  // One reading on the public watch so we can assert the lastmod
  // path uses readings.created_at when readings exist.
  await db
    .prepare(
      "INSERT OR IGNORE INTO readings (id, watch_id, user_id, reference_timestamp, deviation_seconds, is_baseline, verified) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id("r-pub-1"),
      SEED.watches.pub.id,
      SEED.ownerWithPublic.id,
      Date.now(),
      0,
      1,
      0,
    )
    .run();
}

beforeAll(async () => {
  await seed();
});

// ---- /robots.txt ---------------------------------------------------

describe("GET /robots.txt", () => {
  it("returns 200", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/robots.txt"),
    );
    expect(res.status).toBe(200);
  });

  it("sets Content-Type: text/plain; charset=utf-8", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/robots.txt"),
    );
    expect(res.headers.get("content-type") ?? "").toBe("text/plain; charset=utf-8");
  });

  it("sets Cache-Control: public, s-maxage=86400 (24h edge cache)", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/robots.txt"),
    );
    expect(res.headers.get("cache-control") ?? "").toBe("public, s-maxage=86400");
  });

  it("body contains the expected User-agent and Disallow directives", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/robots.txt"),
    );
    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /app/");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Disallow: /out/");
  });

  it("body declares the canonical Sitemap URL", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/robots.txt"),
    );
    const body = await res.text();
    expect(body).toContain("Sitemap: https://rated.watch/sitemap.xml");
  });
});

// ---- /sitemap.xml --------------------------------------------------

describe("GET /sitemap.xml", () => {
  it("returns 200", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    expect(res.status).toBe(200);
  });

  it("sets Content-Type: application/xml; charset=utf-8", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    expect(res.headers.get("content-type") ?? "").toBe("application/xml; charset=utf-8");
  });

  it("sets Cache-Control: public, s-maxage=3600 (hourly edge cache)", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    expect(res.headers.get("cache-control") ?? "").toBe("public, s-maxage=3600");
  });

  it("body is valid XML with the sitemap-0.9 schema preamble", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    // Closing tag — basic well-formed-ness sanity.
    expect(body.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("contains the home and global leaderboard locs (always canonical https://rated.watch)", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    const body = await res.text();
    expect(body).toContain("<loc>https://rated.watch/</loc>");
    expect(body).toContain("<loc>https://rated.watch/leaderboard</loc>");
  });

  it("contains a /m/<slug> loc for an approved seeded movement", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    const body = await res.text();
    expect(body).toContain(
      `<loc>https://rated.watch/m/${SEED.movements.approved.id}</loc>`,
    );
  });

  it("contains a /u/<username> loc for a user WITH a public watch", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    const body = await res.text();
    expect(body).toContain(
      `<loc>https://rated.watch/u/${SEED.ownerWithPublic.username}</loc>`,
    );
  });

  it("does NOT contain a /u/<username> loc for a user with NO public watches", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    const body = await res.text();
    expect(body).not.toContain(
      `<loc>https://rated.watch/u/${SEED.ownerPrivateOnly.username}</loc>`,
    );
  });

  it("contains a /w/<id> loc for a public watch", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    const body = await res.text();
    expect(body).toContain(`<loc>https://rated.watch/w/${SEED.watches.pub.id}</loc>`);
  });

  it("does NOT contain a /w/<id> loc for a private watch", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    const body = await res.text();
    expect(body).not.toContain(
      `<loc>https://rated.watch/w/${SEED.watches.priv.id}</loc>`,
    );
    expect(body).not.toContain(
      `<loc>https://rated.watch/w/${SEED.watches.privOnlyOwner.id}</loc>`,
    );
  });

  it("does NOT contain a /m/<slug> loc for a pending movement", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/sitemap.xml"),
    );
    const body = await res.text();
    expect(body).not.toContain(
      `<loc>https://rated.watch/m/${SEED.movements.pending.id}</loc>`,
    );
  });
});
