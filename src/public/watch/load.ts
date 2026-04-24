// Data loader for the public per-watch page (/w/:id).
//
// Responsibilities:
//   * Look up a watch by id. If the row is missing OR the watch is
//     private, return `not_found` — we deliberately don't distinguish
//     "private" from "missing" on the public surface because leaking
//     existence is a low-grade privacy bug.
//   * Join in the owner's username and the movement's canonical name
//     (only when the movement is approved — pending rows don't get a
//     leaderboard page yet, so we don't link to one).
//   * Load up to READINGS_CAP readings and compute the session stats
//     the page needs (same shape as the SPA's WatchDetailPage).

import type { Kysely } from "kysely";
import type { Database } from "@/db/schema";
import {
  computeSessionStats,
  type Reading,
  type SessionStats,
} from "@/domain/drift-calc";

export interface PublicWatch {
  watch_id: string;
  name: string;
  brand: string | null;
  model: string | null;
  reference: string | null;
  movement_id: string | null;
  movement_canonical_name: string | null;
  owner_username: string;
  has_image: boolean;
}

export interface PublicWatchPageData {
  watch: PublicWatch;
  /** Chronologically ascending readings — the chart draws left-to-right. */
  readings: Reading[];
  session_stats: SessionStats;
}

export type LoadWatchResult =
  | { status: "ok"; data: PublicWatchPageData }
  | { status: "not_found" };

const READINGS_CAP = 200;

export async function loadPublicWatch(
  db: Kysely<Database>,
  watchId: string,
): Promise<LoadWatchResult> {
  if (!watchId || watchId.trim().length === 0) return { status: "not_found" };

  const row = await db
    .selectFrom("watches")
    .innerJoin("user", "user.id", "watches.user_id")
    .leftJoin("movements", "movements.id", "watches.movement_id")
    .where("watches.id", "=", watchId)
    .where("watches.is_public", "=", 1)
    .select([
      "watches.id as watch_id",
      "watches.name as name",
      "watches.brand as brand",
      "watches.model as model",
      "watches.reference as reference",
      "watches.movement_id as movement_id",
      "watches.image_r2_key as image_r2_key",
      "movements.canonical_name as movement_canonical_name",
      "movements.status as movement_status",
      "user.username as owner_username",
    ])
    .executeTakeFirst();

  if (!row) return { status: "not_found" };

  // Readings ascending by time so the chart line draws left→right and
  // the history table can be reversed for the "most recent first"
  // render without a second DB round trip.
  const rows = await db
    .selectFrom("readings")
    .select(["id", "reference_timestamp", "deviation_seconds", "is_baseline", "verified"])
    .where("watch_id", "=", watchId)
    .orderBy("reference_timestamp", "asc")
    .limit(READINGS_CAP)
    .execute();

  const readings: Reading[] = rows.map((r) => ({
    id: r.id,
    reference_timestamp: r.reference_timestamp,
    deviation_seconds: r.deviation_seconds,
    is_baseline: r.is_baseline === 1,
    verified: r.verified === 1,
  }));

  return {
    status: "ok",
    data: {
      watch: {
        watch_id: row.watch_id,
        name: row.name,
        brand: row.brand,
        model: row.model,
        reference: row.reference,
        movement_id: row.movement_status === "approved" ? row.movement_id : null,
        movement_canonical_name:
          row.movement_status === "approved" ? row.movement_canonical_name : null,
        owner_username: row.owner_username.toLowerCase(),
        has_image: row.image_r2_key !== null,
      },
      readings,
      session_stats: computeSessionStats(readings),
    },
  };
}
