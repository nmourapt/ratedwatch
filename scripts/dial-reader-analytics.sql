-- Dial-reader operator analytics queries.
--
-- Slice #83 of PRD #73. The dial-reader pipeline emits five
-- domain events into the Analytics Engine `rw_events` dataset
-- (binding: ANALYTICS, see wrangler.jsonc):
--
--   * dial_reader_attempt    fired before each call. Fields:
--                            reading_id, image_format, image_bytes
--   * dial_reader_success    on a structured 2xx success. Fields:
--                            reading_id, confidence, processing_ms,
--                            dial_reader_version
--   * dial_reader_rejection  on a deliberate non-success outcome
--                            (low_confidence, no_dial_found,
--                            unsupported_format, malformed_image).
--                            Fields: reading_id, reason
--   * dial_reader_error      on transport-level failure. Fields:
--                            reading_id, error_type, error_message
--   * dial_reader_cold_start when the binding fetch took >1s.
--                            Fields: reading_id, wait_ms
--
-- Schema reminder for AE:
--   - blob1   = event kind (string)
--   - blob2   = JSON payload (string)
--   - index1  = event kind (string, used as the sample key)
--   - The dataset is `rw_events` per wrangler.jsonc.
--
-- Run these via the SQL API:
--
--   curl "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql" \
--     -H "Authorization: Bearer ${API_TOKEN}" \
--     --data "$(<scripts/dial-reader-analytics.sql)"
--
-- Each query is independent — pick the one you want, copy-paste,
-- and fire. They are deliberately not rolled into a single SELECT
-- because AE doesn't support stored procedures and the operator
-- usually wants one answer at a time.

-- ------------------------------------------------------------------
-- 1. Daily success rate.
--
-- Counts attempts vs successes across the last 7 days, broken down
-- by day. `_sample_interval` is multiplied in so the count is
-- stable under AE sampling.
-- ------------------------------------------------------------------

SELECT
  toDate(timestamp) AS day,
  SUM(IF(index1 = 'dial_reader_attempt', _sample_interval, 0)) AS attempts,
  SUM(IF(index1 = 'dial_reader_success', _sample_interval, 0)) AS successes,
  SUM(IF(index1 = 'dial_reader_rejection', _sample_interval, 0)) AS rejections,
  SUM(IF(index1 = 'dial_reader_error', _sample_interval, 0)) AS errors,
  -- Success rate is computed as successes / attempts. The IF guard
  -- handles the edge case of zero attempts cleanly (returns 0
  -- rather than NaN).
  IF(
    SUM(IF(index1 = 'dial_reader_attempt', _sample_interval, 0)) > 0,
    SUM(IF(index1 = 'dial_reader_success', _sample_interval, 0))
      / SUM(IF(index1 = 'dial_reader_attempt', _sample_interval, 0)),
    0
  ) AS success_rate
FROM rw_events
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND index1 IN (
    'dial_reader_attempt',
    'dial_reader_success',
    'dial_reader_rejection',
    'dial_reader_error'
  )
GROUP BY day
ORDER BY day DESC;

-- ------------------------------------------------------------------
-- 2. Rejection breakdown by reason (last 7 days).
--
-- Slice #76 ships `unsupported_format`. Subsequent slices add
-- `low_confidence`, `no_dial_found`, `malformed_image`. This
-- query lets the operator see which class is dominant — the
-- threshold tuning signal for slice #80.
-- ------------------------------------------------------------------

SELECT
  JSONExtractString(blob2, 'reason') AS reason,
  SUM(_sample_interval) AS count
FROM rw_events
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND index1 = 'dial_reader_rejection'
GROUP BY reason
ORDER BY count DESC;

-- ------------------------------------------------------------------
-- 3. Confidence histogram (last 7 days, 0.05-wide buckets).
--
-- floor(confidence * 20) / 20 puts each value in a 0.05 bucket.
-- Useful for seeing where the population sits relative to the
-- 0.7 verifier-side trust threshold (DIAL_READER_CONFIDENCE_THRESHOLD
-- in src/domain/reading-verifier/verifier.ts) — the operator can
-- check whether a threshold change would buy meaningful pass-rate
-- without overshooting into low-quality territory.
-- ------------------------------------------------------------------

SELECT
  floor(JSONExtractFloat(blob2, 'confidence') * 20) / 20 AS confidence_bucket,
  SUM(_sample_interval) AS count
FROM rw_events
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND index1 = 'dial_reader_success'
GROUP BY confidence_bucket
ORDER BY confidence_bucket ASC;

-- ------------------------------------------------------------------
-- 4. Latency percentiles for processing_ms (container-side).
--
-- p50 / p95 / p99 over the last 24 hours. quantileExactWeighted
-- accepts the sample interval as the third argument to keep the
-- answer accurate under sampling. The container reports
-- processing_ms as a JSON number in the success-event payload.
-- ------------------------------------------------------------------

SELECT
  quantileExactWeighted(0.5)(
    JSONExtractFloat(blob2, 'processing_ms'),
    _sample_interval
  ) AS p50_ms,
  quantileExactWeighted(0.95)(
    JSONExtractFloat(blob2, 'processing_ms'),
    _sample_interval
  ) AS p95_ms,
  quantileExactWeighted(0.99)(
    JSONExtractFloat(blob2, 'processing_ms'),
    _sample_interval
  ) AS p99_ms,
  SUM(_sample_interval) AS sample_count
FROM rw_events
WHERE timestamp >= NOW() - INTERVAL '1' DAY
  AND index1 = 'dial_reader_success';

-- ------------------------------------------------------------------
-- 5. Cold-start frequency.
--
-- Cold-start events fire only when the binding fetch took >1s, so
-- the rate of this event divided by the rate of attempt is the
-- cold-start fraction. Useful for tuning the Container class's
-- sleepAfter (currently 15m in src/worker/index.tsx) — if the
-- fraction is high the operator can either lengthen sleepAfter or
-- raise max_instances for warm capacity.
-- ------------------------------------------------------------------

SELECT
  toDate(timestamp) AS day,
  SUM(IF(index1 = 'dial_reader_cold_start', _sample_interval, 0)) AS cold_starts,
  SUM(IF(index1 = 'dial_reader_attempt', _sample_interval, 0)) AS attempts,
  IF(
    SUM(IF(index1 = 'dial_reader_attempt', _sample_interval, 0)) > 0,
    SUM(IF(index1 = 'dial_reader_cold_start', _sample_interval, 0))
      / SUM(IF(index1 = 'dial_reader_attempt', _sample_interval, 0)),
    0
  ) AS cold_start_rate,
  -- p95 of the wait-time on cold-start hits — when this trends up,
  -- the container is starting slower (image-pull / dependency-load
  -- regression) rather than just being cold more often.
  quantileExactWeighted(0.95)(
    JSONExtractFloat(blob2, 'wait_ms'),
    _sample_interval
  ) AS cold_start_wait_p95_ms
FROM rw_events
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND index1 IN ('dial_reader_attempt', 'dial_reader_cold_start')
GROUP BY day
ORDER BY day DESC;

-- ------------------------------------------------------------------
-- 6. Image-format distribution (last 7 days).
--
-- Sanity-check what users are actually uploading. Disproportionate
-- HEIC traffic = iOS-heavy week. Disproportionate "unknown" = a
-- new client / scraping / a bug in the format sniffer.
-- ------------------------------------------------------------------

SELECT
  JSONExtractString(blob2, 'image_format') AS format,
  SUM(_sample_interval) AS attempts
FROM rw_events
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND index1 = 'dial_reader_attempt'
GROUP BY format
ORDER BY attempts DESC;
