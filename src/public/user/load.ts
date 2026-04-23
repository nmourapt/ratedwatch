// Data loader for the public user profile (/u/:username).
//
// Responsibilities:
//   * Case-insensitive username → user row lookup. Returns both the
//     matched row (when found) and the canonical lowercased username
//     so the route handler can decide whether to 301-redirect to the
//     canonical URL.
//   * For a matched user, load their PUBLIC watches and the most-
//     recent readings per watch (cap 200) so computeSessionStats can
//     derive the per-card drift + verified badge + reading count.
//
// Kept as a thin DB function so the HTML view is trivially testable
// via the integration harness (real D1 + Kysely through miniflare).

import { sql, type Kysely } from "kysely";
import type { Database } from "@/db/schema";
import {
  computeSessionStats,
  type Reading,
  type SessionStats,
} from "@/domain/drift-calc";

/** The shape the <UserPage> component needs for each card. */
export interface ProfileWatchCard {
  watch_id: string;
  name: string;
  brand: string | null;
  model: string | null;
  movement_id: string | null;
  movement_canonical_name: string | null;
  session_stats: SessionStats;
}

export interface ProfileData {
  /** Canonical lowercased username — the URL the profile lives at. */
  canonical_username: string;
  member_since: string; // ISO 8601, taken from user.createdAt
  watches: ProfileWatchCard[];
}

export type LoadProfileResult =
  | { status: "ok"; profile: ProfileData }
  | { status: "redirect"; canonical_username: string }
  | { status: "not_found" };

const READINGS_CAP_PER_WATCH = 200;

/**
 * Look up a user by username, case-insensitively, and gather the data
 * the public profile page needs.
 *
 * Returns:
 *   * `ok` with the full payload when the URL already uses the
 *     canonical lowercased form.
 *   * `redirect` with the canonical username when the URL matched
 *     case-insensitively but differed in case.
 *   * `not_found` when no user has that username.
 */
export async function loadPublicProfile(
  db: Kysely<Database>,
  rawUsername: string,
): Promise<LoadProfileResult> {
  const input = rawUsername.trim();
  if (input.length === 0) return { status: "not_found" };

  const needle = input.toLowerCase();

  // Case-insensitive lookup. The auth layer (see src/server/auth.ts)
  // keeps LOWER(username) unique so at most one row matches.
  const user = await db
    .selectFrom("user")
    .select(["id", "username", "createdAt"])
    .where(sql<boolean>`LOWER(username) = ${needle}`)
    .executeTakeFirst();

  if (!user) return { status: "not_found" };

  // Stored username IS the canonical form at sign-up (slug generator
  // emits lowercase), but defend against any historical uppercase
  // rows by lowercasing here.
  const canonical = user.username.toLowerCase();
  if (input !== canonical) {
    return { status: "redirect", canonical_username: canonical };
  }

  // Load this user's public watches + their movement canonical name
  // in a single round trip.
  const watchRows = await db
    .selectFrom("watches")
    .leftJoin("movements", "movements.id", "watches.movement_id")
    .where("watches.user_id", "=", user.id)
    .where("watches.is_public", "=", 1)
    .select([
      "watches.id as watch_id",
      "watches.name as name",
      "watches.brand as brand",
      "watches.model as model",
      "watches.movement_id as movement_id",
      "movements.canonical_name as movement_canonical_name",
      "movements.status as movement_status",
      "watches.created_at as watch_created_at",
    ])
    .orderBy("watches.created_at", "desc")
    .execute();

  // For each watch, load its most-recent readings and compute session
  // stats. We parallelise with Promise.all — D1 is async and has no
  // per-request concurrency ceiling that matters here.
  const watches: ProfileWatchCard[] = await Promise.all(
    watchRows.map(async (w) => {
      const rows = await db
        .selectFrom("readings")
        .select([
          "id",
          "reference_timestamp",
          "deviation_seconds",
          "is_baseline",
          "verified",
        ])
        .where("watch_id", "=", w.watch_id)
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
      return {
        watch_id: w.watch_id,
        name: w.name,
        brand: w.brand,
        model: w.model,
        // Don't leak pending-movement ids on the public page — a user
        // can submit a caliber that's still awaiting approval, and
        // we only link through to /m/:id for approved rows.
        movement_id: w.movement_status === "approved" ? w.movement_id : null,
        movement_canonical_name:
          w.movement_status === "approved" ? w.movement_canonical_name : null,
        session_stats: stats,
      };
    }),
  );

  return {
    status: "ok",
    profile: {
      canonical_username: canonical,
      member_since: user.createdAt,
      watches,
    },
  };
}
