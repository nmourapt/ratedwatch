// Reading verifier — orchestrates the new VLM-backed verified-reading
// pipeline introduced in slice #4 of PRD #99 (issue #103).
//
// The previous Python-container-backed verifier was decommissioned in
// slice #1 of PRD #99 (issue #100). This file is the rebuilt
// orchestrator wired to the slice-#2 dial cropper
// (`@/domain/dial-cropper`) and the slice-#3 single-VLM-call dial
// reader (`@/domain/dial-reader-vlm`).
//
// Pipeline:
//
//   1. Resolve the reference timestamp from EXIF DateTimeOriginal,
//      bounded against `serverArrivalAtMs` via the existing
//      `resolveReferenceTimestamp` helper. EXIF outside the bounds
//      window is rejected as `exif_clock_skew`. EXIF missing falls
//      back to server arrival (the documented trust contract — see
//      AGENTS.md "EXIF DateTimeOriginal is accepted as the reference
//      timestamp").
//
//   2. Crop the photo via `cropToDial(photoBytes, env)`. A
//      `found: false` result (the centred-square fallback) is NOT a
//      hard rejection in this slice — the bake-off showed the VLM
//      reads cropped-but-imperfect photos within tolerance often
//      enough that we let the read continue. Future slices may
//      tighten this once we have telemetry on fallback-quality
//      reads.
//
//   3. Build a 12-hour-clock EXIF anchor from the reference
//      timestamp's UTC components (h ∈ [1, 12], m ∈ [0, 59],
//      s ∈ [0, 59]). This matches the bake-off prompt's `HH:MM:SS`
//      contract — see `scripts/vlm-bakeoff/bakeoff.py::_anchor_with_offset`
//      and the prompt's "12-hour clock" output instruction.
//
//   4. Call `readDial(...)` once. Result-mapping:
//      * `kind: "success"` → compute the MM:SS-modulo-60min deviation
//        and return `ok: true`.
//      * `kind: "unparseable"` → `ok: false, error: "ai_unparseable"`.
//      * `kind: "transport_error"` → `ok: false,
//        error: "dial_reader_transport_error"`.
//
// Median-of-3 + the anchor-disagreement guard land in slice #5. For
// this tracer-bullet slice the verifier is deliberately a single-call
// pipeline so we can prove end-to-end wiring without dragging in the
// sample/agreement plumbing.
//
// Deviation contract (MM:SS modulo 60 minutes):
//
//   The dial reader returns MM:SS only — the hour is dropped because
//   the 12-hour wrap on a watch dial means hour readings are
//   ambiguous. The verifier owns the hour via the reference
//   timestamp. Deviation = signed delta between dial MM:SS and
//   reference MM:SS, wrapped into [-1800, +1800] so a capture
//   straddling the minute boundary doesn't show as a ~1-minute
//   offset. Drift > ±30 minutes wraps and under-reports — accepted
//   v1 limit (a watch off by 30+ minutes has stopped, not drifted).
//
// The orchestrator does NOT persist anything. The route handler owns
// the DB INSERT — keeping the verifier pure-ish makes it testable
// without binding fakes for D1/R2.

import { resolveReferenceTimestamp } from "./reference-timestamp";
import type { CropToDialEnv, CropToDialResult } from "@/domain/dial-cropper/cropper";
import type {
  DialReadResult,
  ExifAnchor,
  ReadDialInput,
} from "@/domain/dial-reader-vlm/types";
import type { ReadDialDeps } from "@/domain/dial-reader-vlm/reader";

/**
 * Wrap-window for the MM:SS deviation. 30 minutes either side of
 * the minute boundary, expressed in seconds.
 */
const HALF_HOUR_SECONDS = 1800;
const SECONDS_PER_HOUR = 3600;

/**
 * Inputs to the verifier — what the route handler passes in.
 *
 * `serverArrivalAtMs` MUST be captured at handler entry, BEFORE
 * awaiting the multipart body. Otherwise upload latency leaks into
 * the reference and creates phantom drift on the resulting reading.
 */
export interface VerifyVlmReadingInput {
  photoBytes: ArrayBuffer;
  watchId: string;
  userId: string;
  serverArrivalAtMs: number;
}

export type VerifyReadingErrorCode =
  | "exif_clock_skew"
  | "ai_unparseable"
  | "dial_reader_transport_error";

export type VerifyVlmReadingResult =
  | {
      ok: true;
      vlm_model: string;
      mm_ss: { m: number; s: number };
      reference_timestamp_ms: number;
      reference_source: "exif" | "server";
      deviation_seconds: number;
      crop_found: boolean;
      raw_response: string;
    }
  | {
      ok: false;
      error: VerifyReadingErrorCode;
      raw_response?: string;
    };

/**
 * Dependencies the verifier consumes. Designed so unit tests can
 * inject fakes for the cropper and the reader without touching the
 * Worker runtime (no `env.IMAGES`, no `env.AI`). Production callers
 * (the route handler) wire the real bindings — see
 * `verifyVlmReadingFromEnv` further down.
 *
 * `model` is the VLM slug stamped onto the resulting reading row
 * (e.g. `"openai/gpt-5.2"`). It's a dep rather than a constant so
 * a future slice can override it for canary models without
 * rebuilding this module.
 */
export interface VerifyVlmReadingDeps {
  cropToDial: (photoBytes: ArrayBuffer) => Promise<CropToDialResult>;
  readDial: (input: ReadDialInput) => Promise<DialReadResult>;
  model: string;
}

/**
 * Pure helper: signed deviation in seconds between a dial MM:SS and
 * a reference MM:SS, wrapped into [-1800, +1800]. Exported for unit
 * tests; production callers go through {@link verifyVlmReading}.
 */
export function computeMmSsDeviation(
  dial: { m: number; s: number },
  ref: { m: number; s: number },
): number {
  const dialTotal = dial.m * 60 + dial.s;
  const refTotal = ref.m * 60 + ref.s;
  const raw = dialTotal - refTotal;
  // ((x + 1800) mod 3600) - 1800, with a true-modulo helper so
  // negative `raw` values wrap correctly.
  return (
    ((((raw + HALF_HOUR_SECONDS) % SECONDS_PER_HOUR) + SECONDS_PER_HOUR) %
      SECONDS_PER_HOUR) -
    HALF_HOUR_SECONDS
  );
}

/**
 * Run the verifier. Never throws — every failure mode collapses
 * into a structured `ok: false` result so the route layer can pick
 * the right HTTP status without try/catch.
 */
export async function verifyVlmReading(
  input: VerifyVlmReadingInput,
  deps: VerifyVlmReadingDeps,
): Promise<VerifyVlmReadingResult> {
  // Step 1: reference timestamp.
  const ref = await resolveReferenceTimestamp(input.photoBytes, input.serverArrivalAtMs);
  if (!ref.ok) {
    return {
      ok: false,
      error: "exif_clock_skew",
      raw_response: `EXIF skew: ${ref.deltaMs}ms`,
    };
  }

  // Step 2: crop. A throw here is unexpected (the cropper is meant
  // to swallow non-fatal issues internally) but if env.IMAGES blows
  // up we surface it as a transport error rather than crash.
  let crop: CropToDialResult;
  try {
    crop = await deps.cropToDial(input.photoBytes);
  } catch (err) {
    return {
      ok: false,
      error: "dial_reader_transport_error",
      raw_response: errorMessage(err),
    };
  }

  // Step 3: anchor from the reference timestamp's UTC clock
  // components, on the 12-hour clock.
  const anchor = toExifAnchor(ref.referenceTimestamp);

  // Step 4: VLM read.
  const dialResult = await deps.readDial({
    croppedImage: crop.cropped,
    exifAnchor: anchor,
    runId: crypto.randomUUID(),
  });

  if (dialResult.kind === "transport_error") {
    return {
      ok: false,
      error: "dial_reader_transport_error",
      raw_response: dialResult.message,
    };
  }
  if (dialResult.kind === "unparseable") {
    return {
      ok: false,
      error: "ai_unparseable",
      raw_response: dialResult.raw_response,
    };
  }

  // Success — compute deviation against the reference's MM:SS.
  const refDate = new Date(ref.referenceTimestamp);
  const refMmSs = {
    m: refDate.getUTCMinutes(),
    s: refDate.getUTCSeconds(),
  };
  const deviation = computeMmSsDeviation(dialResult.mm_ss, refMmSs);

  return {
    ok: true,
    vlm_model: deps.model,
    mm_ss: dialResult.mm_ss,
    reference_timestamp_ms: ref.referenceTimestamp,
    reference_source: ref.source,
    deviation_seconds: deviation,
    crop_found: crop.found,
    raw_response: dialResult.raw_response,
  };
}

/**
 * Compose a production-wired verifier helper. The route handler
 * calls this once per request after building its `env`-bound
 * cropToDial + readDial closures.
 *
 * Kept as a separate convenience export so the route handler does
 * not have to know the deps shape; unit tests still call
 * `verifyVlmReading` directly with fake deps.
 */
export interface VerifyVlmReadingProdEnv extends CropToDialEnv {
  // env.AI is supplied via the readDialDeps closure — kept off this
  // type so we don't import the Workers AI runtime type into a
  // domain module.
}

export interface VerifyVlmReadingProdDeps {
  env: VerifyVlmReadingProdEnv;
  readDialDeps: ReadDialDeps;
  /** VLM model slug. Stamped onto the resulting reading row. */
  model?: string;
  /** Cropper override — production wires the real `cropToDial`. */
  cropper: (bytes: ArrayBuffer, env: CropToDialEnv) => Promise<CropToDialResult>;
  /** Reader override — production wires the real `readDial`. */
  reader: (input: ReadDialInput, deps: ReadDialDeps) => Promise<DialReadResult>;
}

/**
 * Production wrapper that binds the cropper and reader to their
 * runtime dependencies (env.IMAGES via `cropToDialEnv`, the VLM
 * client + gateway via `readDialDeps`). Tests use the fake-deps
 * `verifyVlmReading` directly and skip this wrapper.
 */
export async function verifyVlmReadingFromEnv(
  input: VerifyVlmReadingInput,
  prod: VerifyVlmReadingProdDeps,
): Promise<VerifyVlmReadingResult> {
  return verifyVlmReading(input, {
    cropToDial: (bytes) => prod.cropper(bytes, prod.env),
    readDial: (req) => prod.reader(req, prod.readDialDeps),
    model: prod.model ?? DEFAULT_VLM_MODEL,
  });
}

/** Default VLM slug — the bake-off-validated production candidate. */
export const DEFAULT_VLM_MODEL = "openai/gpt-5.2";

// ---- helpers --------------------------------------------------------

/**
 * Convert a unix-ms timestamp to a 12-hour-clock EXIF anchor. The
 * VLM prompt expects `h ∈ [1, 12]` (no AM/PM marker), so we map
 * 0 → 12 and 13–23 → 1–11.
 */
function toExifAnchor(ms: number): ExifAnchor {
  const d = new Date(ms);
  const utcHour24 = d.getUTCHours();
  const h12 = ((utcHour24 + 11) % 12) + 1; // 0→12, 13→1, 23→11, 12→12
  return {
    h: h12,
    m: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
