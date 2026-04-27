// EXIF capture-timestamp extractor.
//
// We use the `exifr` lite ESM build (no GPS/XMP/IPTC/ICC/HEIC parsers)
// because all we need is `DateTimeOriginal` (or, as a fallback,
// `CreateDate`). The lite bundle is ~45 KB minified vs ~75 KB for the
// full build — measurable savings on the Worker upload size budget.
// Both fields live in the `exif` IFD which the lite build covers.
//
// Trust contract (see AGENTS.md): EXIF DateTimeOriginal is the
// reference timestamp for verified readings, bounded against server
// arrival time in the verifier. Reading the bytes server-side is
// fine; the client never sends a literal timestamp claim. When EXIF
// is missing the verifier falls back to server arrival time
// (captured at handler entry, before body upload, to minimize
// upload-latency phantom drift).
//
// Failure mode: this function MUST NOT throw. Corrupt EXIF, an image
// format that exifr can't parse, an internal exifr blowup — all of
// these are functionally identical to "no EXIF" from the verifier's
// perspective: fall back to server arrival time. We log nothing on
// failure because successful screenshots / privacy-stripped photos
// are a normal user flow, not an error condition.

import { parse as exifrParse } from "exifr/dist/lite.esm.mjs";

/**
 * Extract the camera-capture timestamp from a JPEG/PNG/HEIC byte
 * buffer. Returns the EXIF DateTimeOriginal (or CreateDate fallback)
 * as a millisecond unix timestamp, or null when the image carries no
 * EXIF date metadata (screenshots, privacy-stripped photos).
 *
 * Never throws — corrupt EXIF, unsupported formats, or any parse
 * error returns null and the caller falls back to server arrival
 * time. We deliberately avoid leaking parser errors to the user;
 * "couldn't read EXIF" is functionally identical to "no EXIF".
 */
export async function extractCaptureTimestampMs(
  buffer: ArrayBuffer,
): Promise<number | null> {
  if (testReader) {
    return testReader(buffer);
  }
  return defaultReader(buffer);
}

async function defaultReader(buffer: ArrayBuffer): Promise<number | null> {
  // exifr accepts an empty buffer by returning undefined, but a
  // non-empty buffer that isn't a recognized image throws. We catch
  // both shapes so callers always see a clean null on failure.
  if (buffer.byteLength === 0) {
    return null;
  }
  let parsed: { DateTimeOriginal?: unknown; CreateDate?: unknown } | undefined;
  try {
    parsed = (await exifrParse(buffer, {
      // Only ask for the two fields we use. Cuts work — exifr can
      // skip whole IFDs / segments when we explicitly pick.
      pick: ["DateTimeOriginal", "CreateDate"],
    })) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed) {
    return null;
  }
  // Prefer DateTimeOriginal — the moment the shutter fired. CreateDate
  // is a fallback because some pipelines (HEIC, certain Android
  // cameras) only populate one or the other.
  const candidate = parsed.DateTimeOriginal ?? parsed.CreateDate;
  return toMs(candidate);
}

// `exifr` returns a JS Date for revivable date fields when
// `reviveValues: true` (the default). Defensive: we also tolerate a
// numeric ms timestamp or an ISO string in case a future exifr
// upgrade changes the surface.
function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

// --- Test override hook -------------------------------------------------
//
// Mirrors the `__setTestDialReader` pattern in src/domain/dial-reader/
// adapter.ts. The verifier's integration tests need a way to inject a
// known timestamp without juggling real EXIF-bearing fixtures. The
// override is module-level (fine — vitest-pool-workers gives us a
// fresh worker per test file) and a `null` clears it. Keep this in
// the same module as the function it overrides so a grep for
// `__setTestExifReader` lands in one place.

type ExifReader = (buffer: ArrayBuffer) => Promise<number | null>;

let testReader: ExifReader | null = null;

/**
 * TEST-ONLY. Install a fake EXIF reader. Subsequent calls to
 * `extractCaptureTimestampMs` route through `fn` until cleared.
 * Pass `null` in a teardown hook to restore the real parser.
 */
export function __setTestExifReader(fn: ExifReader | null): void {
  testReader = fn;
}
