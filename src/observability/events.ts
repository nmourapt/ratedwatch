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
