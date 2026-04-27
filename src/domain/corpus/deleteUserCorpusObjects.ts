// Retroactive corpus cleanup — slice #81 of PRD #73.
//
// When a user toggles `consent_corpus` from 1 → 0 (via PATCH
// /api/v1/me) we delete every corpus object that was previously
// derived from one of their readings. This is what makes the consent
// toggle meaningful: opting out is not just "no further uploads"
// but "remove what's already there".
//
// The corpus bucket itself contains NO user identifiers — that's the
// whole point of `maybeIngest`'s anonymization. So how do we find a
// user's objects? Via D1: the `readings` table is the only place
// where reading_id → user_id is recorded. We enumerate the user's
// readings that have a `photo_r2_key` (i.e. were eligible for corpus
// ingestion in the first place; the partial index
// `idx_readings_corpus_eligible` from migration 0007 makes this
// cheap), then attempt deletion of:
//
//   corpus/*/{readingId}/photo.{any-ext}
//   corpus/*/{readingId}/sidecar.json
//
// The wildcard date prefix is handled via R2 list with a per-reading
// prefix-list scan. We don't know the YYYY-MM-DD ahead of time
// (that's the ingest moment, which may differ from the reading's
// own created_at), so list+delete is the only option.
//
// All operations are best-effort and the caller wraps the whole
// thing in `executionCtx.waitUntil(...)` — the user's PATCH /me
// response should not wait on this.

import type { DB } from "@/db";

export interface DeleteUserCorpusObjectsInput {
  userId: string;
  db: DB;
  env: { R2_CORPUS: R2Bucket };
}

/**
 * Delete every corpus object derived from the given user's readings.
 * Best-effort; never throws.
 *
 * Implementation notes:
 *
 * - We query D1 for the user's reading IDs (only those with a
 *   `photo_r2_key` — readings without a stored photo were never
 *   eligible for corpus ingestion).
 * - For each reading_id we list the corpus bucket on the
 *   `corpus/` prefix and filter by `/{readingId}/` substring. This
 *   is the simplest correct approach: R2 list is paginated by
 *   `cursor` and we walk the whole bucket once per call. For alpha
 *   scale (a few thousand objects) the round-trip cost is
 *   acceptable; once corpus grows we can switch to
 *   reading_id-derived prefix lookups by also storing the ingest
 *   date alongside the reading row.
 * - Deletion uses `R2Bucket.delete(keys[])` for batched calls.
 * - All errors are swallowed and warn-logged.
 */
export async function deleteUserCorpusObjects(
  input: DeleteUserCorpusObjectsInput,
): Promise<void> {
  const { userId, db, env } = input;
  try {
    // 1. Enumerate the user's reading IDs that ever had a photo.
    const rows = await db
      .selectFrom("readings")
      .select("id")
      .where("user_id", "=", userId)
      .where("photo_r2_key", "is not", null)
      .execute();
    if (rows.length === 0) {
      return;
    }
    const readingIdSet = new Set(rows.map((r) => r.id));

    // 2. List the corpus bucket and collect keys whose path
    //    contains `/{readingId}/` for any of the user's readings.
    const matchedKeys: string[] = [];
    let cursor: string | undefined;
    // Cap the loop iterations defensively. Each page is up to
    // 1000 objects; 50 pages = 50,000 objects, well above the
    // alpha-scale ceiling. If we ever cross this we'll know
    // because the user's deletion will silently truncate, and
    // we can revisit the design.
    const MAX_PAGES = 50;
    for (let i = 0; i < MAX_PAGES; i++) {
      const list = await env.R2_CORPUS.list({
        prefix: "corpus/",
        cursor,
        limit: 1000,
      });
      for (const obj of list.objects) {
        // Key shape is `corpus/YYYY-MM-DD/{readingId}/...`. We split
        // on `/` and check the third segment against the user's
        // reading-id set.
        const parts = obj.key.split("/");
        if (parts.length >= 4 && readingIdSet.has(parts[2]!)) {
          matchedKeys.push(obj.key);
        }
      }
      if (!list.truncated) {
        break;
      }
      cursor = list.truncated ? list.cursor : undefined;
      if (!cursor) break;
    }

    if (matchedKeys.length === 0) {
      return;
    }

    // 3. Batch-delete. R2's `delete` accepts an array; chunk to
    //    1000 per call to stay within the documented per-call
    //    limit.
    const CHUNK = 1000;
    for (let i = 0; i < matchedKeys.length; i += CHUNK) {
      const chunk = matchedKeys.slice(i, i + CHUNK);
      await env.R2_CORPUS.delete(chunk);
    }
  } catch (err) {
    console.warn(
      `corpus.deleteUserCorpusObjects: failed for user ${userId}, swallowing:`,
      err,
    );
  }
}
