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
 * Discriminated union returned by `readDial`. The verifier branches
 * on `kind`:
 *
 *   - `success`: structured CV output. The verifier still applies
 *     its own confidence threshold + plausibility checks before
 *     trusting the read.
 *
 *   - `rejection`: the container ran but cannot produce a meaningful
 *     read (e.g. no dial visible, image too blurry). The verifier
 *     treats this the same as the AI runner's "refused" outcome.
 *
 *   - `transport_error`: HTTP 5xx, network failure, or any other
 *     condition where the container did NOT have a chance to make
 *     a CV decision. The verifier treats this as retryable / falls
 *     back to manual entry.
 */
export type DialReadResult =
  | { kind: "success"; body: DialReadSuccessBody }
  | { kind: "rejection"; reason: string }
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
 */
export interface DialReaderEnv {
  DIAL_READER: DurableObjectNamespace<DialReaderContainer>;
}

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
 * Read the time displayed by a watch in the supplied image bytes.
 *
 * Production path: forwards the bytes as the body of
 * `POST /v1/read-dial` to the container instance bound to
 * `env.DIAL_READER` (named "global" — a single instance for now;
 * scale-out happens by raising `max_instances` in wrangler.jsonc
 * and switching the name to a per-image hash if locality matters).
 *
 * Test path: when `__setTestDialReader` has installed a fake, it is
 * called instead and the binding is never touched.
 */
export async function readDial(
  image: Uint8Array,
  env: DialReaderEnv,
): Promise<DialReadResult> {
  if (testReader) {
    return testReader(image);
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

  let res: Response;
  try {
    res = await stub.fetch(req);
  } catch (err) {
    return {
      kind: "transport_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok) {
    // 5xx (or any non-2xx) is a transport error: the container ran
    // but did not return a CV decision. Distinguishing it from a
    // structured rejection lets the verifier retry / fall back to
    // manual entry without contaminating the success path.
    return {
      kind: "transport_error",
      message: `dial-reader container returned HTTP ${res.status}`,
    };
  }

  // Structured response. The container returns either a success
  // body (`ok: true`) or a rejection body (`ok: false, reason: "..."`).
  // Slice #74's container only returns the success shape; the
  // rejection branch is here so slice #75 can light it up without a
  // contract change.
  const json = (await res.json()) as DialReadSuccessBody | { ok: false; reason?: string };

  if (json.ok === false) {
    return {
      kind: "rejection",
      reason: typeof json.reason === "string" ? json.reason : "unspecified",
    };
  }

  return { kind: "success", body: json };
}
