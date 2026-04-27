// Worker-side adapter for the CV dial-reader container service.
//
// This is the typed bridge between the Worker and the Cloudflare
// Container that runs OpenCV / image decoding / hand-angle parsing.
// Slice #74 (this scaffolding step) lands the adapter and the
// container plumbing but does NOT wire the adapter into any
// production code path: the verified-reading flow (verifier.ts +
// routes/readings.ts) still calls the legacy AI runner. Slice #75
// flips the verifier behind the `ai_reading_v2` flag.
//
// Why a thin indirection (mirror of `__setTestAiRunner` in
// src/domain/ai-dial-reader/runner.ts):
//
//   - Container Durable Objects always resolve remotely in
//     production. miniflare in `vitest-pool-workers` cannot host
//     a real container instance, so integration tests need a
//     module-level fake the way the AI binding does. This file
//     installs the same shape of escape hatch.
//
//   - The contract (`DialReadResult`) is a discriminated union over
//     the three outcomes the verifier needs to handle differently:
//     a structured success, a structured rejection (e.g. "no dial
//     detected"), and a transport-level failure (5xx, network
//     error). Keeping these typed at the adapter boundary means
//     the verifier branches on `result.kind` rather than on string
//     parsing of HTTP responses.
//
// The contract corresponds to the FastAPI shape in
// `container/dial-reader/src/dial_reader/http_app.py`. Both sides
// live in the same repo, so contract drift is caught in a single
// PR review.

import { getContainer } from "@cloudflare/containers";
import type { DialReaderContainer } from "@/worker/index";
import { logEvent, type EventLoggerEnv } from "@/observability/events";

/**
 * The successful body shape returned by the container's
 * `POST /v1/read-dial`. Slice #74 fills in zeroed values; later
 * slices populate the real CV outputs without changing the shape.
 *
 * The `result` block is the part the verifier ultimately consumes;
 * the top-level `version` + `ok` exist for operator-side log
 * correlation across container builds.
 */
export interface DialReadSuccessBody {
  version: string;
  ok: true;
  result: {
    displayed_time: { h: number; m: number; s: number };
    confidence: number;
    dial_detection: { center_xy: [number, number]; radius_px: number };
    hand_angles_deg: { hour: number; minute: number; second: number };
    processing_ms: number;
  };
}

/**
 * Known rejection reasons. The list grows as later slices add real
 * CV outcomes (`no_dial_detected`, `low_confidence`, etc.). The
 * `(string & {})` tail keeps the type assignable from arbitrary
 * strings (so a forward-compatible reason from the container
 * doesn't break callers) while preserving IDE autocompletion for
 * the known set.
 *
 * Slice #76 introduces `unsupported_format`, returned when the
 * container's image_decoder rejects bytes whose format isn't on
 * the rated.watch supported list (GIF, BMP, TIFF, AVIF, …).
 */
export type DialReadRejectionReason = "unsupported_format" | (string & {});

/**
 * Discriminated union returned by `readDial`. The verifier branches
 * on `kind`:
 *
 *   - `success`: structured CV output. The verifier still applies
 *     its own confidence threshold + plausibility checks before
 *     trusting the read.
 *
 *   - `rejection`: the container ran but cannot produce a meaningful
 *     read (e.g. unsupported format today; no dial visible / image
 *     too blurry in later slices). The verifier treats this the same
 *     as the AI runner's "refused" outcome.
 *
 *   - `malformed_image`: the request bytes were corrupt, truncated,
 *     or empty — the container surfaced a 400. Distinct from
 *     `transport_error` because retrying with the same bytes can't
 *     help; the SPA should ask the user for a fresh capture.
 *
 *   - `transport_error`: HTTP 5xx, network failure, or any other
 *     condition where the container did NOT have a chance to make
 *     a CV decision. The verifier treats this as retryable / falls
 *     back to manual entry.
 */
export type DialReadResult =
  | { kind: "success"; body: DialReadSuccessBody }
  | { kind: "rejection"; reason: DialReadRejectionReason; details?: string }
  | { kind: "malformed_image"; message: string }
  | { kind: "transport_error"; message: string };

/**
 * Test-injectable runner type. Mirrors the production `readDial`
 * signature at the post-binding layer: it returns the same typed
 * result the production path returns, lets tests skip the binding
 * entirely.
 */
export type DialReader = (image: Uint8Array) => Promise<DialReadResult>;

/**
 * Subset of the Worker's `Env` that the adapter needs. Kept narrow
 * so unit tests can construct a minimal fake without rebuilding
 * every binding.
 *
 * The `EventLoggerEnv` intersection lets the adapter emit the slice
 * #83 dial-reader telemetry events when a `ReadDialContext` is
 * supplied. The ANALYTICS binding remains optional — when it's
 * absent the events are silently dropped (per `logEvent`'s contract)
 * and the dial read still proceeds.
 */
export interface DialReaderEnv extends EventLoggerEnv {
  DIAL_READER: DurableObjectNamespace<DialReaderContainer>;
}

/**
 * Optional context the verifier (and any other caller that wants
 * end-to-end correlation) supplies on each call. When present, the
 * adapter emits the five `dial_reader_*` events with `reading_id`
 * stamped on every payload so an operator can SQL-join across
 * Analytics Engine using a single key per attempt.
 *
 * Why optional: the legacy two-arg form (no context) is preserved
 * for tests that exercise the production binding path without
 * caring about telemetry, and as a defensive option for any
 * future internal caller that doesn't have a reading_id to share.
 */
export interface ReadDialContext {
  /** Stable correlation id, usually the readings.id UUID. */
  readingId: string;
}

/**
 * Cold-start threshold. We call the container fetch a "cold start"
 * when it took more than this many milliseconds. The number is
 * deliberately a bit-too-generous-for-warm-traffic so the rate of
 * `dial_reader_cold_start` events matches the operator's intuition
 * of "we waited for the box to come up", not "this request was a
 * little slow".
 */
const COLD_START_THRESHOLD_MS = 1000;

// Test-only module-level override. `null` ⇒ use the real binding.
//
// Like `__setTestAiRunner`, this lives below the index re-export so
// production code cannot reach for it accidentally — only test files
// that import the adapter module directly can install fakes.
let testReader: DialReader | null = null;

/**
 * TEST-ONLY. Install a fake dial reader that subsequent calls to
 * `readDial` will route to until cleared. Pass `null` in a teardown
 * hook to restore the production binding path.
 *
 * Deliberately not re-exported from `index.ts` — the only callers
 * are test files that import this module directly.
 */
export function __setTestDialReader(fn: DialReader | null): void {
  testReader = fn;
}

// The container endpoint path. The host is opaque (the Worker reaches
// the container via the DO binding, not the public internet) so any
// hostname is fine; using `localhost` makes the URL readable in logs
// and avoids stamping a fake-but-resolvable apex on the request.
const READ_DIAL_URL = "http://dial-reader.internal/v1/read-dial";

/**
 * Best-effort image-format sniffer. Looks at the first few bytes
 * (the only bytes any of the supported formats use to declare their
 * type) and returns a short lower-case label. We never trust the
 * Content-Type header — clients lie, particularly Safari which
 * sometimes labels HEIC as `image/jpeg` for cross-app sharing.
 *
 * Returning `"unknown"` is fine; the format string is for telemetry
 * only and the container itself runs its own (more thorough) sniff
 * in `image_decoder.py`. We're optimising here for "tell the operator
 * what the user uploaded", not "make a decode decision".
 */
function sniffImageFormat(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  // ISO BMFF heuristic. HEIC/HEIF and AVIF share the same overall
  // layout (`....ftyp....`), so we look at bytes 4..7 for the `ftyp`
  // ASCII and bytes 8..11 for the brand.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && // 'f'
    bytes[5] === 0x74 && // 't'
    bytes[6] === 0x79 && // 'y'
    bytes[7] === 0x70 // 'p'
  ) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1") {
      return "heic";
    }
    if (brand === "avif" || brand === "avis") {
      return "avif";
    }
    return "isobmff";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "gif";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "bmp";
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return "tiff";
  }
  return "unknown";
}

/**
 * Read the time displayed by a watch in the supplied image bytes.
 *
 * Production path: forwards the bytes as the body of
 * `POST /v1/read-dial` to the container instance bound to
 * `env.DIAL_READER` (named "global" — a single instance for now;
 * scale-out happens by raising `max_instances` in wrangler.jsonc
 * and switching the name to a per-image hash if locality matters).
 *
 * Test path: when `__setTestDialReader` has installed a fake, it is
 * called instead and the binding is never touched. The fake never
 * sees the telemetry events (those wrap the binding call below); a
 * caller that wants end-to-end event coverage in tests should drive
 * `readDial` against a fake-fetch DurableObjectStub instead.
 *
 * When `ctx` is supplied the adapter emits five `dial_reader_*`
 * events into Analytics Engine: `attempt` always, plus exactly one
 * of `success` / `rejection` / `error`, plus `cold_start` whenever
 * the binding fetch took >1s. See `EventKind` in
 * src/observability/events.ts for the per-event payload shape.
 */
export async function readDial(
  image: Uint8Array,
  env: DialReaderEnv,
  ctx?: ReadDialContext,
): Promise<DialReadResult> {
  if (testReader) {
    return testReader(image);
  }

  // Telemetry: emit the attempt event before any work. Even if every
  // downstream step fails, the operator gets a denominator for the
  // success-rate query.
  if (ctx) {
    await logEvent(
      "dial_reader_attempt",
      {
        reading_id: ctx.readingId,
        image_format: sniffImageFormat(image),
        image_bytes: image.byteLength,
      },
      env,
    );
  }

  const stub = getContainer(env.DIAL_READER, "global");

  // Build the inner request. The adapter copies the bytes into the
  // request body; the container reads them as a raw stream. Using
  // a fresh ArrayBuffer (not the Uint8Array directly) keeps the
  // body type unambiguous across the Workers runtime / undici
  // shims used in tests.
  //
  // Slice #75 will likely add a content-type hint here so the
  // container can route HEIC vs JPEG decoders without sniffing.
  // Until then `application/octet-stream` is the safest default.
  const body = image.slice().buffer;
  const req = new Request(READ_DIAL_URL, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });

  // Cold-start measurement — we time the binding fetch wall-clock
  // and emit `dial_reader_cold_start` if it crossed the threshold.
  // Captured in a local so a thrown fetch (transport error path)
  // still gets the cold-start emit if applicable.
  const waitStart = Date.now();
  let res: Response;
  try {
    res = await stub.fetch(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ctx) {
      const waitMs = Date.now() - waitStart;
      if (waitMs > COLD_START_THRESHOLD_MS) {
        await logEvent(
          "dial_reader_cold_start",
          { reading_id: ctx.readingId, wait_ms: waitMs },
          env,
        );
      }
      await logEvent(
        "dial_reader_error",
        {
          reading_id: ctx.readingId,
          error_type: "transport_exception",
          error_message: message,
        },
        env,
      );
    }
    return { kind: "transport_error", message };
  }
  const waitMs = Date.now() - waitStart;
  if (ctx && waitMs > COLD_START_THRESHOLD_MS) {
    await logEvent(
      "dial_reader_cold_start",
      { reading_id: ctx.readingId, wait_ms: waitMs },
      env,
    );
  }

  if (!res.ok) {
    // 400 from the container is a structured malformed-image
    // signal: the bytes were unreadable. We surface it as its own
    // result kind so the verifier can show "the photo couldn't be
    // decoded — please retake" rather than a generic retry message.
    if (res.status === 400) {
      const errBody = (await res.json().catch(() => null)) as {
        error?: string;
        details?: string;
      } | null;
      const message = errBody?.details ?? "image bytes could not be decoded";
      // A 400 is a structured client-side rejection from the
      // container's POV — the bytes were the problem. We surface
      // it on the rejection-style telemetry channel because that's
      // the operator's mental model ("the container deliberately
      // rejected this input") even though the result kind is
      // `malformed_image` rather than `rejection`.
      if (ctx) {
        await logEvent(
          "dial_reader_rejection",
          {
            reading_id: ctx.readingId,
            reason: "malformed_image",
          },
          env,
        );
      }
      return { kind: "malformed_image", message };
    }

    // Anything else (5xx, gateway error, etc.) is a transport
    // error: the container ran but did not return a CV decision.
    // Distinguishing it from a structured rejection lets the
    // verifier retry / fall back to manual entry without
    // contaminating the success path.
    const message = `dial-reader container returned HTTP ${res.status}`;
    if (ctx) {
      await logEvent(
        "dial_reader_error",
        {
          reading_id: ctx.readingId,
          error_type: "http_5xx",
          error_message: message,
        },
        env,
      );
    }
    return { kind: "transport_error", message };
  }

  // Structured 200 response. The container returns either a success
  // body (`ok: true`) or a rejection body
  // (`ok: false, rejection: { reason, details? }`).
  //
  // Slice #76's container ships the rejection branch for
  // `unsupported_format`; subsequent slices add `no_dial_detected`,
  // `low_confidence`, etc. without a contract change.
  const json = (await res.json()) as
    | DialReadSuccessBody
    | {
        ok: false;
        // New shape (slice #76): structured `rejection` block.
        rejection?: { reason?: string; details?: string };
        // Legacy flat `reason` kept defensively in case an older
        // container build is in flight; the field has never been
        // emitted in production.
        reason?: string;
      };

  if (json.ok === false) {
    const reason =
      (typeof json.rejection?.reason === "string" && json.rejection.reason) ||
      (typeof json.reason === "string" && json.reason) ||
      "unspecified";
    const details =
      typeof json.rejection?.details === "string" ? json.rejection.details : undefined;
    if (ctx) {
      await logEvent("dial_reader_rejection", { reading_id: ctx.readingId, reason }, env);
    }
    return {
      kind: "rejection",
      reason,
      ...(details !== undefined ? { details } : {}),
    };
  }

  if (ctx) {
    await logEvent(
      "dial_reader_success",
      {
        reading_id: ctx.readingId,
        confidence: json.result.confidence,
        processing_ms: json.result.processing_ms,
        dial_reader_version: json.version,
      },
      env,
    );
  }

  return { kind: "success", body: json };
}
