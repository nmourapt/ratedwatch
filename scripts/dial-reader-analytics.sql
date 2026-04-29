-- ⚠ DEPRECATED — kept for reference only.
--
-- The five `dial_reader_*` Analytics Engine events these queries
-- depend on (`dial_reader_attempt`, `_success`, `_rejection`,
-- `_error`, `_cold_start`) were retired in slice #1 of PRD #99 (issue
-- #100) when the Python dial-reader container was decommissioned.
-- Running any of the queries below against `rw_events` today will
-- return zero rows.
--
-- The replacement Worker-side VLM dial reader (slice #4 of PRD #99,
-- issue #103) will introduce its own observability event names. When
-- that lands, this file will either be replaced with the new query
-- pack or removed outright. Until then the queries are wrapped in a
-- block-comment so they cannot be accidentally pasted into the
-- Analytics Engine SQL API.
--
-- Schema reminder for AE (still applies to whatever events replace
-- these):
--   - blob1   = event kind (string)
--   - blob2   = JSON payload (string)
--   - index1  = event kind (string, used as the sample key)
--   - dataset = `rw_events` per wrangler.jsonc.

/*
-- Dial-reader operator analytics queries (DEPRECATED — see header).
--
-- Slice #83 of PRD #73 introduced these. The dial-reader pipeline
-- emitted five domain events into the Analytics Engine `rw_events`
-- dataset (binding: ANALYTICS, see wrangler.jsonc):
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

-- ------------------------------------------------------------------
-- 1. Daily success rate.
-- ------------------------------------------------------------------

SELECT
  toDate(timestamp) AS day,
  SUM(IF(index1 = 'dial_reader_attempt', _sample_interval, 0)) AS attempts,
  SUM(IF(index1 = 'dial_reader_success', _sample_interval, 0)) AS successes,
  SUM(IF(index1 = 'dial_reader_rejection', _sample_interval, 0)) AS rejections,
  SUM(IF(index1 = 'dial_reader_error', _sample_interval, 0)) AS errors,
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
-- 2. Rejection breakdown by reason.
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
-- 3. Confidence histogram (0.05-wide buckets).
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
-- 6. Image-format distribution.
-- ------------------------------------------------------------------

SELECT
  JSONExtractString(blob2, 'image_format') AS format,
  SUM(_sample_interval) AS attempts
FROM rw_events
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND index1 = 'dial_reader_attempt'
GROUP BY format
ORDER BY attempts DESC;

*/
