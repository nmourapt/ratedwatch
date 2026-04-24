// Integration tests for slice 15: public user profile (/u/:username)
// and public per-watch page (/w/:id).
//
// Seeds users, movements, watches, and readings directly via the D1
// binding — the HTML pages compose queryLeaderboard / computeSessionStats
// over the real Kysely stack through miniflare so the assertions hit
// the actual join output, not a fixture.
//
// Scope (see issue #16):
//   * /u/:username case-insensitive lookup + 301 to canonical lowercased form
//   * /u/unknown → 404
//   * /u/alice shows public watches but not private ones
//   * /w/:id → 200 for a public watch, 404 for private or unknown (same body)
//   * /w/:id renders an inline SVG chart with one data point per reading
//   * /w/:id contains the Chrono24 CTA link
//
// Follows the same seed-id pattern as leaderboard.test.ts so concurrent
// runs and repeats inside the same miniflare storage isolation window
// don't collide.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DAY_MS = 24 * 60 * 60 * 1000;
const runId = crypto.randomUUID().slice(0, 8);
const id = (suffix: string) => `pp-${runId}-${suffix}`;

const SEED = {
  user: {
    id: id("user-alice"),
    name: "Alice Tester",
    // Username uniqueness is case-insensitive (see src/server/auth.ts); we
    // store the canonical lowercased form so the redirect assertion is a
    // real case-fold rather than a pretend one.
    username: id("alice").toLowerCase(),
    email: `${id("alice")}@test`,
  },
  movement: {
    id: id("mov-a"),
    canonical_name: `ETA ${id("A")}`,
    manufacturer: "ETA",
    caliber: id("A"),
  },
  publicWatch: {
    id: id("w-public"),
    name: "Gold Submariner",
    brand: "Rolex",
    model: "126610LN",
    // Slice (issue #57): reference surfaces on the public page in
    // the subtitle row ("Rolex · 126610LN · Ref 126610LN-0001").
    reference: "126610LN-0001",
    is_public: 1,
  },
  privateWatch: {
    id: id("w-private"),
    name: "Private Nomos",
    brand: "Nomos",
    model: "Tangente",
    is_public: 0,
  },
  // Slice (issue #57): a watch with no reference set to prove the
  // SSR output doesn't emit a dangling " · " separator when the
  // slot is empty. Brand/model chosen to be distinct from the other
  // fixtures so the "private watch doesn't leak" assertion elsewhere
  // in this file keeps a unique needle to look for.
  publicNoRef: {
    id: id("w-public-noref"),
    name: "Plain Worker",
    brand: "Tissot",
    model: "PRX",
    reference: null,
    is_public: 1,
  },
};

async function seed() {
  const db = (env as unknown as { DB: D1Database }).DB;
  const now = Date.now();
  const iso = new Date(now).toISOString();

  await db
    .prepare(
      "INSERT OR IGNORE INTO user (id, name, email, emailVerified, username, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)",
    )
    .bind(SEED.user.id, SEED.user.name, SEED.user.email, SEED.user.username, iso, iso)
    .run();

  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      SEED.movement.id,
      SEED.movement.canonical_name,
      SEED.movement.manufacturer,
      SEED.movement.caliber,
      "automatic",
      "approved",
      null,
    )
    .run();

  const watchesToSeed: Array<{
    id: string;
    name: string;
    brand: string;
    model: string;
    reference: string | null;
    is_public: number;
  }> = [
    { ...SEED.publicWatch },
    { ...SEED.privateWatch, reference: null },
    { ...SEED.publicNoRef },
  ];
  for (const w of watchesToSeed) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO watches (id, user_id, name, brand, model, reference, movement_id, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        w.id,
        SEED.user.id,
        w.name,
        w.brand,
        w.model,
        w.reference,
        SEED.movement.id,
        w.is_public,
      )
      .run();
  }

  // Public watch: baseline + 2 follow-up readings → eligible session.
  const readings = [
    { t: 0, d: 0, baseline: true, verified: true, watch: SEED.publicWatch.id },
    { t: 7, d: 3.5, baseline: false, verified: true, watch: SEED.publicWatch.id },
    { t: 14, d: 7, baseline: false, verified: false, watch: SEED.publicWatch.id },
    // Private watch has one reading so the chart test can assert the
    // page simply refuses to render it.
    { t: 0, d: 0, baseline: true, verified: false, watch: SEED.privateWatch.id },
  ];
  for (const r of readings) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO readings (id, watch_id, user_id, reference_timestamp, deviation_seconds, is_baseline, verified) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id(`r-${r.watch}-${r.t}`),
        r.watch,
        SEED.user.id,
        now + r.t * DAY_MS,
        r.d,
        r.baseline ? 1 : 0,
        r.verified ? 1 : 0,
      )
      .run();
  }
}

beforeAll(async () => {
  await seed();
});

// ---- GET /u/:username ---------------------------------------------

describe("GET /u/:username — public user profile", () => {
  it("renders 200 HTML with the username and the public watch", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/u/${SEED.user.username}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const body = await res.text();
    // Username header rendered.
    expect(body).toContain(`@${SEED.user.username}`);
    // Public watch brand/model appears.
    expect(body).toContain(SEED.publicWatch.brand);
    expect(body).toContain(SEED.publicWatch.model);
  });

  it("does NOT surface private watches on the public profile", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/u/${SEED.user.username}`),
    );
    const body = await res.text();
    expect(body).not.toContain(SEED.privateWatch.brand);
    expect(body).not.toContain(SEED.privateWatch.model);
  });

  it("301-redirects a mixed-case username to the canonical lowercased URL", async () => {
    const mixedCase = SEED.user.username.toUpperCase();
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/u/${mixedCase}`, { redirect: "manual" }),
    );
    expect(res.status).toBe(301);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`/u/${SEED.user.username}`);
  });

  it("returns 404 for an unknown username", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/u/nobody-exists-here"),
    );
    expect(res.status).toBe(404);
  });

  // Followup (cache-vary-cookie): Vary: Cookie on both the 200
  // and 404 anon branches. Browser caches need it so signed-out
  // users don't serve the personalised authed variant back.
  it("emits Vary: Cookie on the 200 anon profile path", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/u/${SEED.user.username}`),
    );
    expect(res.headers.get("vary") ?? "").toMatch(/Cookie/i);
  });

  it("emits Vary: Cookie on the 404 anon profile path", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/u/nobody-exists-here"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("vary") ?? "").toMatch(/Cookie/i);
  });

  it("emits zero client-side JavaScript", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/u/${SEED.user.username}`),
    );
    const body = await res.text();
    expect(body).not.toMatch(/<script\b/i);
  });

  it("links each watch card to its /w/:id public page", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/u/${SEED.user.username}`),
    );
    const body = await res.text();
    expect(body).toContain(`/w/${SEED.publicWatch.id}`);
  });

  it("renders the verified badge with data-verified-badge on verified watches", async () => {
    // publicWatch has 2/3 verified readings (seed) so verified_badge = true.
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/u/${SEED.user.username}`),
    );
    const body = await res.text();
    expect(body).toMatch(/data-verified-badge="true"/);
  });
});

// ---- GET /w/:watchId ----------------------------------------------

describe("GET /w/:watchId — public watch page", () => {
  it("returns 200 HTML for a public watch with brand, model, and owner link", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.publicWatch.id}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain(SEED.publicWatch.brand);
    expect(body).toContain(SEED.publicWatch.model);
    // Owner profile link is the canonical lowercased form.
    expect(body).toContain(`/u/${SEED.user.username}`);
    // Movement link is back to the per-movement leaderboard.
    expect(body).toContain(`/m/${SEED.movement.id}`);
  });

  it("renders an inline SVG chart with one <circle> per reading", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.publicWatch.id}`),
    );
    const body = await res.text();
    // SVG element with the expected viewBox.
    expect(body).toMatch(/<svg\b[^>]*viewBox="0 0 600 200"/);
    // One data point per reading — the public watch has 3 readings.
    const circleCount = (body.match(/<circle\b[^>]*data-reading-point="true"/g) ?? [])
      .length;
    expect(circleCount).toBe(3);
  });

  it("contains a Chrono24 CTA that routes through the click-tracked /out redirect", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.publicWatch.id}`),
    );
    const body = await res.text();
    // Watches with a movement route the CTA through
    // /out/chrono24/:movementId so the Worker can emit a
    // `chrono24_click` Analytics Engine event before the 302. The
    // direct Chrono24 URL is only used as a fallback when the watch
    // has no movement id.
    expect(body).toContain(`/out/chrono24/${SEED.movement.id}`);
    expect(body).not.toContain("https://www.chrono24.com/search/index.htm");
  });

  it("returns 404 for a private watch (even shape-indistinguishable from unknown)", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.privateWatch.id}`),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-existent watch id", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/w/does-not-exist-anywhere"),
    );
    expect(res.status).toBe(404);
  });

  // Followup (cache-vary-cookie): Vary: Cookie on both the 200
  // and 404 anon branches.
  it("emits Vary: Cookie on the 200 anon watch path", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.publicWatch.id}`),
    );
    expect(res.headers.get("vary") ?? "").toMatch(/Cookie/i);
  });

  it("emits Vary: Cookie on the 404 anon watch path", async () => {
    const res = await exports.default.fetch(
      new Request("https://ratedwatch.test/w/does-not-exist-anywhere"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("vary") ?? "").toMatch(/Cookie/i);
  });

  it("emits zero client-side JavaScript", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.publicWatch.id}`),
    );
    const body = await res.text();
    expect(body).not.toMatch(/<script\b/i);
  });

  it("renders the verified badge with data-verified-badge when the watch qualifies", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.publicWatch.id}`),
    );
    const body = await res.text();
    expect(body).toMatch(/data-verified-badge="true"/);
  });

  // Slice (issue #57): reference shows up in the subtitle when set,
  // and leaves no dangling separator when absent.
  it("renders the reference in the subtitle when the watch has one", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.publicWatch.id}`),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`Ref ${SEED.publicWatch.reference}`);
  });

  it("omits the reference slot (no dangling separator) when the watch has none", async () => {
    const res = await exports.default.fetch(
      new Request(`https://ratedwatch.test/w/${SEED.publicNoRef.id}`),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Subtitle still renders brand + model but the "Ref …" slot is absent.
    expect(body).toContain(SEED.publicNoRef.brand);
    expect(body).toContain(SEED.publicNoRef.model);
    expect(body).not.toContain("Ref ");
    // No " · · " double-separator and no trailing separator right
    // before the closing </p> of the subtitle.
    expect(body).not.toMatch(/·\s*·/);
    expect(body).not.toMatch(/·\s*<\/p>/);
  });
});
