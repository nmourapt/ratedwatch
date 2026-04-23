// Movement-taxonomy search module.
//
// Takes a typed Kysely `Database` and exposes two read methods:
//   * `search(query, opts)` — powers the add-watch typeahead + public
//     browse. Case-insensitive, normalizes dashes/whitespace, matches
//     on canonical name, manufacturer+caliber, and the normalized
//     variant described in issue #8.
//   * `getBySlug(id)` — point lookup used by later slices (e.g. the
//     per-movement leaderboard page).
//
// The shape is a factory that closes over the DB reference so callers
// pass one object around rather than re-creating Kysely bound queries
// at every call site. Kept DB-agnostic so the same code works against
// miniflare D1 in tests and the real D1 in production.

import { sql, type Kysely } from "kysely";
import type { Database, MovementsTable } from "@/db/schema";

export type Movement = {
  id: string;
  canonical_name: string;
  manufacturer: string;
  caliber: string;
  type: MovementsTable["type"];
  status: MovementsTable["status"];
  notes: string | null;
};

export interface MovementSearchOptions {
  /** Max rows returned in `approved`. Defaults to 20, capped at 50 at the API boundary. */
  limit?: number;
  /** When true, pending rows are included in `approved`. Defaults to false. */
  includePending?: boolean;
}

export interface MovementSearchResult {
  approved: Movement[];
  /**
   * Reserved for the submission flow in slice #10 — surfaced in the
   * response shape from day one so the SPA consumer doesn't need a
   * subsequent breaking change when suggestions start landing. Always
   * an empty array for now.
   */
  suggestions: Movement[];
}

const DEFAULT_LIMIT = 20;

/**
 * Normalize a user-supplied query for search. Lower-cases, trims, and
 * strips dashes + whitespace so "ETA 2892-A2", "eta 28922", and
 * "eta2892a2" all match the same row via the normalized LIKE clause.
 */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[-\s]+/g, "");
}

const MOVEMENT_COLUMNS = [
  "id",
  "canonical_name",
  "manufacturer",
  "caliber",
  "type",
  "status",
  "notes",
] as const;

export function createMovementTaxonomy(db: Kysely<Database>) {
  return {
    /**
     * Search movements by free-text query.
     *
     * Returns an empty `approved` list when `query` is blank — we
     * explicitly don't treat an empty query as "dump everything",
     * because the typeahead mounts before the user types.
     */
    async search(
      query: string,
      opts: MovementSearchOptions = {},
    ): Promise<MovementSearchResult> {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return { approved: [], suggestions: [] };
      }

      const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
      const needle = trimmed.toLowerCase();
      const normalizedNeedle = normalize(trimmed);
      const likeNeedle = `%${needle}%`;
      const likeNormalized = `%${normalizedNeedle}%`;

      // Three-axis match (canonical name, manufacturer + caliber, and
      // the dash-stripped canonical name). SQL `OR` across the axes is
      // fine for our ~100-row dataset — full-text search is explicitly
      // out of scope (see issue #8).
      let q = db
        .selectFrom("movements")
        .select([...MOVEMENT_COLUMNS])
        .where((eb) =>
          eb.or([
            sql<boolean>`LOWER(canonical_name) LIKE ${likeNeedle}`,
            sql<boolean>`LOWER(manufacturer || ' ' || caliber) LIKE ${likeNeedle}`,
            sql<boolean>`LOWER(REPLACE(REPLACE(canonical_name, '-', ''), ' ', '')) LIKE ${likeNormalized}`,
          ]),
        );

      if (!opts.includePending) {
        q = q.where("status", "=", "approved");
      }

      // Order: exact slug match first (so typing "eta-2892-a2" lands
      // that row at the top), then manufacturer + canonical name. No
      // SQL score function — the dataset is small enough that a
      // stable alphabetical fallback is fine.
      const rows = await q
        .orderBy(sql`CASE WHEN LOWER(id) = ${needle} THEN 0 ELSE 1 END`)
        .orderBy("manufacturer")
        .orderBy("canonical_name")
        .limit(limit)
        .execute();

      return {
        approved: rows.map(toMovement),
        suggestions: [],
      };
    },

    /**
     * Point lookup by slug. Returns null when no row matches. Used by
     * future slices (public per-movement page, add-watch submit).
     */
    async getBySlug(id: string): Promise<Movement | null> {
      const row = await db
        .selectFrom("movements")
        .select([...MOVEMENT_COLUMNS])
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toMovement(row) : null;
    },
  };
}

function toMovement(
  row: Pick<MovementsTable, (typeof MOVEMENT_COLUMNS)[number]>,
): Movement {
  return {
    id: row.id,
    canonical_name: row.canonical_name,
    manufacturer: row.manufacturer,
    caliber: row.caliber,
    type: row.type,
    status: row.status,
    notes: row.notes,
  };
}
