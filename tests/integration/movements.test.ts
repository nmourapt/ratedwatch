import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";

// Integration tests for the movements taxonomy — migration 0002 + the
// GET /api/v1/movements search endpoint. We seed a small deterministic
// fixture in beforeAll rather than loading the real ~100-row seed JSON
// so tests stay focused on the search contract and are cheap to run.
//
// Uses the shared miniflare D1 binding (same instance the Worker sees
// via `env.DB`) so INSERTs visible here are also visible to the
// fetch()-level tests that go through the Hono app.

interface MovementRow {
  id: string;
  canonical_name: string;
  manufacturer: string;
  caliber: string;
  type: "automatic" | "manual" | "quartz" | "spring-drive" | "other";
  status: "approved" | "pending";
  notes?: string;
}

const fixture: MovementRow[] = [
  {
    id: "eta-2824-2",
    canonical_name: "ETA 2824-2",
    manufacturer: "ETA",
    caliber: "2824-2",
    type: "automatic",
    status: "approved",
  },
  {
    id: "eta-2892-a2",
    canonical_name: "ETA 2892-A2",
    manufacturer: "ETA",
    caliber: "2892-A2",
    type: "automatic",
    status: "approved",
  },
  {
    id: "sellita-sw200",
    canonical_name: "Sellita SW200",
    manufacturer: "Sellita",
    caliber: "SW200",
    type: "automatic",
    status: "approved",
  },
  {
    id: "seiko-nh35",
    canonical_name: "Seiko NH35",
    manufacturer: "Seiko",
    caliber: "NH35",
    type: "automatic",
    status: "approved",
  },
  {
    id: "seiko-6r35",
    canonical_name: "Seiko 6R35",
    manufacturer: "Seiko",
    caliber: "6R35",
    type: "automatic",
    status: "approved",
  },
  {
    id: "ronda-715",
    canonical_name: "Ronda 715",
    manufacturer: "Ronda",
    caliber: "715",
    type: "quartz",
    status: "approved",
  },
  {
    id: "pending-proto-001",
    canonical_name: "Prototype ABC-001",
    manufacturer: "Prototype",
    caliber: "ABC-001",
    type: "automatic",
    status: "pending",
  },
];

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO movements (id, canonical_name, manufacturer, caliber, type, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of fixture) {
    await stmt
      .bind(
        row.id,
        row.canonical_name,
        row.manufacturer,
        row.caliber,
        row.type,
        row.status,
        row.notes ?? null,
      )
      .run();
  }
});

async function search(params: Record<string, string | number>): Promise<Response> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return exports.default.fetch(
    new Request(`https://ratedwatch.test/api/v1/movements${qs ? `?${qs}` : ""}`),
  );
}

interface SearchBody {
  approved: Array<{
    id: string;
    canonical_name: string;
    manufacturer: string;
    caliber: string;
    type: string;
    status: string;
  }>;
  suggestions: unknown[];
}

describe("GET /api/v1/movements", () => {
  it("matches by caliber substring (2892 -> ETA 2892-A2)", async () => {
    const res = await search({ q: "2892" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.approved.map((m) => m.id)).toContain("eta-2892-a2");
    expect(body.suggestions).toEqual([]);
  });

  it("is case-insensitive (ETA and eta return the same ids)", async () => {
    const upper = (await (await search({ q: "ETA" })).json()) as SearchBody;
    const lower = (await (await search({ q: "eta" })).json()) as SearchBody;
    const upperIds = upper.approved.map((m) => m.id).sort();
    const lowerIds = lower.approved.map((m) => m.id).sort();
    expect(upperIds).toEqual(lowerIds);
    expect(upperIds.length).toBeGreaterThan(0);
  });

  it("matches manufacturer as a partial prefix (seiko)", async () => {
    const body = (await (await search({ q: "seiko" })).json()) as SearchBody;
    const ids = body.approved.map((m) => m.id);
    expect(ids).toContain("seiko-nh35");
    expect(ids).toContain("seiko-6r35");
  });

  it("returns empty approved + empty suggestions for no match", async () => {
    const res = await search({ q: "absolutely-nothing-xyz" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.approved).toEqual([]);
    expect(body.suggestions).toEqual([]);
  });

  it("excludes pending rows by default", async () => {
    const body = (await (await search({ q: "prototype" })).json()) as SearchBody;
    expect(body.approved.map((m) => m.id)).not.toContain("pending-proto-001");
  });

  it("normalized search matches when user omits the dash (2892a2 matches 2892-A2)", async () => {
    // Canonical name "ETA 2892-A2" stripped of dashes and whitespace is
    // "eta2892a2". A user typing "2892a2" (no dash) should still land
    // the row via the normalized LIKE clause.
    const body = (await (await search({ q: "2892a2" })).json()) as SearchBody;
    expect(body.approved.map((m) => m.id)).toContain("eta-2892-a2");
  });

  it("respects the limit param", async () => {
    const body = (await (await search({ q: "eta", limit: 1 })).json()) as SearchBody;
    expect(body.approved.length).toBeLessThanOrEqual(1);
  });

  it("returns an empty list when q is omitted (no blanket dump)", async () => {
    const res = await search({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.approved).toEqual([]);
    expect(body.suggestions).toEqual([]);
  });
});
