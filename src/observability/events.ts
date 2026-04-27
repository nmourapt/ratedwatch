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
  // Slice #82 (PRD #73 user story #25): rate-limit telemetry. Fired
  // when the verified-reading or manual_with_photo route blocked a
  // user because they hit either the per-minute burst gate or the
  // 50-attempts-per-24h product cap. Tracked separately from
  // `_failed` so an operator can answer "how often does the cap
  // matter in practice?" with one Analytics Engine query.
  // Fields: userId, watchId, reason ("burst" | "daily_cap").
  | "verified_reading_rate_limited"
  | "manual_with_photo_rate_limited"
  // Slice #80 (PRD #73 User Story #10): manual_with_photo flow —
  // the user typed HH:MM:SS after the dial reader rejected their
  // capture. Tracked separately from `reading_submitted` so we can
  // measure the rate at which CV rejections funnel into manual
  // entry vs an outright session-abandon.
  | "manual_with_photo_submitted"
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
  // Dial-reader (CV container) telemetry. Slice #83 of PRD #73.
  // These five events trace every call into the CV container:
  //
  //   * `dial_reader_attempt`   — fired before each call, regardless
  //                                of outcome. Used as the
  //                                attempt-rate denominator.
  //                                Fields: reading_id, image_format,
  //                                image_bytes.
  //   * `dial_reader_success`   — fired on a structured 2xx success.
  //                                Carries the calibrated confidence
  //                                + processing time so we can build
  //                                histograms / latency percentiles
  //                                over Analytics Engine.
  //                                Fields: reading_id, confidence,
  //                                processing_ms, dial_reader_version.
  //   * `dial_reader_rejection` — fired on a structured non-success
  //                                the container produced deliberately
  //                                (unsupported format, low confidence,
  //                                no dial found, malformed image).
  //                                Distinct from `_error` because
  //                                retrying won't help.
  //                                Fields: reading_id, reason,
  //                                confidence (when known).
  //   * `dial_reader_error`     — fired on a transport-level failure
  //                                (5xx, network exception). The
  //                                container did NOT make a CV
  //                                decision; the user should retry
  //                                or fall back to manual entry.
  //                                Fields: reading_id, error_type,
  //                                error_message.
  //   * `dial_reader_cold_start`— fired when the Worker observes the
  //                                container fetch took >1s. Logged
  //                                only when the threshold is crossed
  //                                so the rate of this event is
  //                                directly the cold-start rate.
  //                                Fields: reading_id, wait_ms.
  | "dial_reader_attempt"
  | "dial_reader_success"
  | "dial_reader_rejection"
  | "dial_reader_error"
  | "dial_reader_cold_start"
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
