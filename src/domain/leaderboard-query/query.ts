// Leaderboard query. The domain module that the public leaderboard
// page (/leaderboard), per-movement pages (/m/:id, slice #14), and
// the /api/v1/leaderboard JSON endpoint all compose onto.
//
// Conceptually:
//   1. SELECT candidate watches = public + approved-movement.
//   2. For each candidate, LOAD its readings (cap 200 most-recent to
//      protect the Worker) and COMPUTE session stats via drift-calc.
//   3. KEEP only eligible watches (drift-calc.eligible === true). If
//      verified_only, also require session_stats.verified_badge.
//   4. SORT by abs(avg_drift_rate_spd) ASC. Zero drift = best.
//   5. Assign 1-based ranks, apply limit + offset, return.
//
// This does more work in the Worker than in SQL deliberately — the
// ranking rule depends on drift-calc's `eligible` + `verified_badge`
// logic, which is the single source of truth for "does this watch
// qualify?". Duplicating that logic as SQL would be a correctness
// liability. The up-front `candidate` query keeps the result set
// small (public, approved) so the in-memory pass stays fast until
// the dataset outgrows the single-Worker approach.
//
// TODO(perf): when candidate_count * avg_readings_per_watch trends
// past ~O(10k), push more work into SQL — e.g. pre-filter by "has
// ≥3 readings spanning ≥7 days" via a window query to drop the
// ineligible tail before drift-calc runs.

import type { Kysely } from "kysely";
import type { Database } from "@/db/schema";
import {
  computeSessionStats,
  type Reading,
  type SessionStats,
} from "@/domain/drift-calc";

/**
 * A watch that's qualified for the leaderboard, enriched with the
 * rendering data the public pages need (owner username, movement
 * canonical name, session stats) and a 1-based rank.
 */
export interface RankedWatch {
  watch_id: string;
  watch_name: string;
  watch_brand: string | null;
  watch_model: string | null;
  owner_username: string;
  /** Never null — pending-movement watches are filtered out upstream. */
  movement_id: string;
  movement_canonical_name: string;
  session_stats: SessionStats;
  /** 1-based rank across the full eligible set (before limit/offset). */
  rank: number;
}

export interface LeaderboardOpts {
  /** Filter to watches on one movement (for /m/:id). */
  movement_id?: string;
  /** If true, require session_stats.verified_badge === true. */
  verified_only?: boolean;
  /** Default 50, capped at 200 to protect the Worker. */
  limit?: number;
  /** Default 0. Combined with limit for pagination. */
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const READINGS_CAP_PER_WATCH = 200;

interface CandidateRow {
  watch_id: string;
  watch_name: string;
  watch_brand: string | null;
  watch_model: string | null;
  owner_username: string;
  movement_id: string;
  movement_canonical_name: string;
}

/**
 * Rank public, eligible watches on approved movements by abs(avg drift
 * rate) ascending. See module comment for the full algorithm. Pure-
 * ish — reads from the passed-in Kysely client and nothing else.
 */
export async function queryLeaderboard(
  opts: LeaderboardOpts,
  db: Kysely<Database>,
): Promise<RankedWatch[]> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const verifiedOnly = opts.verified_only === true;

  // Step 1 — candidate watches. Join watches → user → movements so the
  // HTML page can render everything without a second round trip.
  let candidateQuery = db
    .selectFrom("watches")
    .innerJoin("user", "user.id", "watches.user_id")
    .innerJoin("movements", "movements.id", "watches.movement_id")
    .where("watches.is_public", "=", 1)
    .where("movements.status", "=", "approved")
    .select([
      "watches.id as watch_id",
      "watches.name as watch_name",
      "watches.brand as watch_brand",
      "watches.model as watch_model",
      "user.username as owner_username",
      "movements.id as movement_id",
      "movements.canonical_name as movement_canonical_name",
    ]);

  if (opts.movement_id) {
    candidateQuery = candidateQuery.where("watches.movement_id", "=", opts.movement_id);
  }

  const candidates = (await candidateQuery.execute()) as CandidateRow[];
  if (candidates.length === 0) return [];

  // Step 2 — load readings + compute session stats per candidate.
  // Parallelised via Promise.all so worker I/O is overlapped; D1 has
  // no per-request concurrency limit that matters at these sizes.
  const withStats = await Promise.all(
    candidates.map(async (c) => {
      const rows = await db
        .selectFrom("readings")
        .select([
          "id",
          "reference_timestamp",
          "deviation_seconds",
          "is_baseline",
          "verified",
        ])
        .where("watch_id", "=", c.watch_id)
        .orderBy("reference_timestamp", "desc")
        .limit(READINGS_CAP_PER_WATCH)
        .execute();
      const readings: Reading[] = rows.map((r) => ({
        id: r.id,
        reference_timestamp: r.reference_timestamp,
        deviation_seconds: r.deviation_seconds,
        is_baseline: r.is_baseline === 1,
        verified: r.verified === 1,
      }));
      const stats = computeSessionStats(readings);
      return { candidate: c, stats };
    }),
  );

  // Step 3 — eligibility + verified filter. Also drop any row whose
  // avg_drift_rate_spd is null (shouldn't happen for eligible rows
  // since eligibility implies ≥2 readings, but the type says it could).
  const qualified = withStats.filter(({ stats }) => {
    if (!stats.eligible) return false;
    if (stats.avg_drift_rate_spd === null) return false;
    if (verifiedOnly && !stats.verified_badge) return false;
    return true;
  });

  // Step 4 — sort by abs(drift) ASC. Stable tiebreaker by watch_id so
  // identical-drift rows don't jump around between requests.
  qualified.sort((a, b) => {
    const diff =
      Math.abs(a.stats.avg_drift_rate_spd!) - Math.abs(b.stats.avg_drift_rate_spd!);
    if (diff !== 0) return diff;
    return a.candidate.watch_id.localeCompare(b.candidate.watch_id);
  });

  // Step 5 — assign 1-based ranks to the full qualified set, then slice.
  const ranked: RankedWatch[] = qualified.map((row, idx) => ({
    watch_id: row.candidate.watch_id,
    watch_name: row.candidate.watch_name,
    watch_brand: row.candidate.watch_brand,
    watch_model: row.candidate.watch_model,
    owner_username: row.candidate.owner_username,
    movement_id: row.candidate.movement_id,
    movement_canonical_name: row.candidate.movement_canonical_name,
    session_stats: row.stats,
    rank: idx + 1,
  }));

  return ranked.slice(offset, offset + limit);
}
