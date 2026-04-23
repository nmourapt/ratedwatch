import { describe, it, expect } from "vitest";
import { buildSeedSql, type SeedRow } from "./seed-sql";
import seed from "./seed.json" with { type: "json" };

// Unit tests for the pure SQL generator used by the seed script. We
// deliberately don't spawn wrangler here — those paths are exercised
// at merge-time by the operator (`npm run db:seed:movements -- --local`).

describe("buildSeedSql", () => {
  it("wraps the inserts in a BEGIN/COMMIT transaction", () => {
    const rows: SeedRow[] = [
      {
        id: "eta-2892-a2",
        canonical_name: "ETA 2892-A2",
        manufacturer: "ETA",
        caliber: "2892-A2",
        type: "automatic",
        status: "approved",
      },
    ];
    const sql = buildSeedSql(rows);
    expect(sql).toContain("BEGIN TRANSACTION;");
    expect(sql).toContain("COMMIT;");
  });

  it("uses INSERT OR IGNORE so re-running is idempotent", () => {
    const rows: SeedRow[] = [
      {
        id: "eta-2892-a2",
        canonical_name: "ETA 2892-A2",
        manufacturer: "ETA",
        caliber: "2892-A2",
        type: "automatic",
        status: "approved",
      },
    ];
    const sql = buildSeedSql(rows);
    expect(sql).toContain("INSERT OR IGNORE INTO movements");
    // And does NOT use plain INSERT INTO (which would error on re-run).
    expect(sql).not.toMatch(/\bINSERT INTO\b(?! OR)/);
  });

  it("escapes single quotes in text values", () => {
    const rows: SeedRow[] = [
      {
        id: "test-apostrophe",
        canonical_name: "Test's Movement",
        manufacturer: "Test",
        caliber: "X",
        type: "automatic",
        status: "approved",
        notes: "it's fine",
      },
    ];
    const sql = buildSeedSql(rows);
    // Two consecutive single quotes = escaped single quote in SQL.
    expect(sql).toContain("'Test''s Movement'");
    expect(sql).toContain("'it''s fine'");
  });

  it("writes NULL for omitted notes (not the string 'null')", () => {
    const rows: SeedRow[] = [
      {
        id: "eta-2892-a2",
        canonical_name: "ETA 2892-A2",
        manufacturer: "ETA",
        caliber: "2892-A2",
        type: "automatic",
        status: "approved",
      },
    ];
    const sql = buildSeedSql(rows);
    expect(sql).toMatch(/,\s*NULL\)/);
    expect(sql).not.toMatch(/,\s*'null'\)/);
  });

  it("rejects invalid type values", () => {
    expect(() =>
      buildSeedSql([
        {
          id: "bad",
          canonical_name: "Bad",
          manufacturer: "Bad",
          caliber: "Bad",
          type: "tuning-fork" as unknown as SeedRow["type"],
          status: "approved",
        },
      ]),
    ).toThrow(/invalid type/);
  });

  it("rejects duplicate slugs", () => {
    const row: SeedRow = {
      id: "dupe",
      canonical_name: "Dupe",
      manufacturer: "Dupe",
      caliber: "Dupe",
      type: "automatic",
      status: "approved",
    };
    expect(() => buildSeedSql([row, row])).toThrow(/duplicate slug/);
  });

  it("rejects slugs outside kebab-case", () => {
    expect(() =>
      buildSeedSql([
        {
          id: "Has Spaces",
          canonical_name: "X",
          manufacturer: "X",
          caliber: "X",
          type: "automatic",
          status: "approved",
        },
      ]),
    ).toThrow(/invalid slug/);
  });
});

describe("seed.json", () => {
  const rows = seed as SeedRow[];

  it("contains at least 100 rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(100);
  });

  it("includes every required caliber called out in issue #8", () => {
    const required = [
      "eta-2824-2",
      "eta-2892-a2",
      "eta-7750",
      "sellita-sw200",
      "seiko-nh35",
      "seiko-nh36",
      "seiko-6r35",
      "seiko-8l35",
      "grand-seiko-9s55",
      "miyota-9015",
      "miyota-8215",
      "rolex-3135",
      "rolex-3235",
      "omega-8800",
      "omega-8900",
      "tudor-mt5602",
      "la-joux-perret-g100",
      "soprod-a10",
      "ronda-715",
      "ronda-763",
    ];
    const ids = new Set(rows.map((r) => r.id));
    for (const id of required) {
      expect(ids.has(id), `missing required caliber: ${id}`).toBe(true);
    }
  });

  it("contains at least one spring-drive and multiple quartz rows", () => {
    const types = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.type] = (acc[row.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(types["spring-drive"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(types["quartz"] ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("has every row approved (no pending seed rows)", () => {
    for (const row of rows) {
      expect(row.status).toBe("approved");
    }
  });

  it("produces valid SQL end-to-end via buildSeedSql", () => {
    const sql = buildSeedSql(rows);
    expect(sql).toContain("BEGIN TRANSACTION;");
    expect(sql).toContain("COMMIT;");
    const inserts = sql.match(/INSERT OR IGNORE INTO movements/g) ?? [];
    expect(inserts.length).toBe(rows.length);
  });
});
