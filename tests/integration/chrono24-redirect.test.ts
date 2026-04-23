// Integration tests for GET /out/chrono24/:movementId.
//
// The redirect surface exists so we can count clicks on the Chrono24
// CTA even from no-JS public pages — the Worker logs a chrono24_click
// event and 302s to buildChrono24UrlForMovement(movement).
//
// Unknown / pending movements surface 404 so the URL shape doesn't
// leak pending submissions (mirrors /m/:id behaviour).

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const approvedId = "test-out-eta-2892";
const approvedCanonical = "Test ETA 2892 (out)";

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, submitted_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      approvedId,
      approvedCanonical,
      "ETA",
      "2892 (out)",
      "automatic",
      "approved",
      null,
    )
    .run();
});

async function hit(url: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://ratedwatch.test${url}`, {
      redirect: "manual",
    }),
  );
}

describe("GET /out/chrono24/:movementId", () => {
  it("302s to the Chrono24 search URL for an approved movement", async () => {
    const res = await hit(`/out/chrono24/${approvedId}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.hostname).toBe("www.chrono24.com");
    expect(url.pathname).toBe("/search/index.htm");
    expect(url.searchParams.get("query")).toBe(approvedCanonical);
  });

  it("404s for unknown movements (no redirect leak)", async () => {
    const res = await hit("/out/chrono24/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("does not cache the redirect (Cache-Control: no-store)", async () => {
    const res = await hit(`/out/chrono24/${approvedId}`);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc.toLowerCase()).toContain("no-store");
  });
});
