// Analytics Engine event emitter.
//
// Every domain event in the app flows through `logEvent`. Shape:
//
//   logEvent("watch_added", { userId, movementId }, env)
//
// The call lands in the Analytics Engine dataset `rw_events`
// (binding: ANALYTICS, see wrangler.jsonc). We pack:
//   * blobs[0]     = event kind (string)
//   * blobs[1]     = JSON-encoded payload (string)
//   * indexes[0]   = event kind (string) — AE uses this for
//                    filtering/grouping in SQL queries.
//
// Design invariant: `logEvent` is fire-and-forget from the caller's
// perspective. A misconfigured ANALYTICS binding, a broken AE
// endpoint, a malformed payload — none of these may crash the
// calling request. We catch + console.warn and carry on. Observability
// must never take the product offline.

export type EventKind =
  | "user_registered"
  | "watch_added"
  | "reading_submitted"
  | "verified_reading_attempted"
  | "verified_reading_succeeded"
  | "verified_reading_failed"
  // EXIF-reference telemetry. The verified-reading pipeline now uses
  // EXIF DateTimeOriginal as the reference timestamp (see
  // src/domain/reading-verifier/verifier.ts). These three events let
  // us monitor the rollout: how often EXIF is present (`_exif_ok`),
  // missing (`_exif_missing`), or out-of-bounds (`_exif_clock_skew`,
  // which causes a 422). Watching `_exif_clock_skew` is the early
  // signal for users with bad phone clocks vs spoof attempts.
  | "verified_reading_exif_ok"
  | "verified_reading_exif_missing"
  | "verified_reading_exif_clock_skew"
  | "movement_suggested"
  | "chrono24_click"
  | "leaderboard_filter_changed"
  | "page_view_home"
  | "page_view_leaderboard";

// Payload values are restricted to JSON-serialisable primitives. AE
// blobs accept arbitrary strings, but enforcing a narrow shape keeps
// accidental PII (full objects, request headers, etc.) from leaking
// into the dataset. Callsites that need richer structure should
// flatten at the edge.
export type EventPayload = Record<string, string | number | boolean | null>;

// Narrow env shape — callers pass whatever env object they have; we
// only require an ANALYTICS binding. Typed loosely so an unconfigured
// preview or unit test can pass `{}` and still get a no-op write.
export interface EventLoggerEnv {
  ANALYTICS?: AnalyticsEngineDataset;
}

export async function logEvent(
  kind: EventKind,
  payload: EventPayload,
  env: EventLoggerEnv,
): Promise<void> {
  try {
    const dataset = env.ANALYTICS;
    if (!dataset) {
      // Unconfigured env — common in local dev without a wrangler.jsonc
      // AE binding, and in early previews. Silently skip.
      return;
    }
    const body = JSON.stringify(payload);
    dataset.writeDataPoint({
      blobs: [kind, body],
      indexes: [kind],
    });
  } catch (err) {
    // Never throw into the caller. AE is best-effort; lost events are
    // preferable to a 500 on the user's request.
    console.warn("logEvent: failed to write data point", {
      kind,
      err,
    });
  }
}
