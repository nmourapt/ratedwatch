// Client-side photo capture-time extractor for the verified-reading
// flow (PR #124, fix for the upload-latency bias bug).
//
// ## Background — the bug
//
// The verified-reading flow's reference timestamp is supposed to be
// the moment the photo was captured. AGENTS.md (and the original
// design) accept EXIF DateTimeOriginal as that reference, bounded
// against server arrival.
//
// In practice, the SPA's `resizePhoto.ts` runs every photo through
// a `<canvas>` re-encode (`canvas.drawImage` → `canvas.toBlob`). That
// re-encode produces a clean JPEG with no EXIF whatsoever — the
// browser strips it. So by the time the bytes hit the Worker, the
// `extractCaptureTimestampMs` byte-EXIF path always returns null
// and the verifier falls back to `Date.now()` at handler entry.
//
// Handler entry happens AFTER the upload has been received, which
// means the reference is biased forward by 5-15 s of upload latency
// (typical mobile/cellular). On a watch with +6 s/day drift, that
// 13-second delay produces a deviation of −7 s — exactly the bug a
// real user hit on 2026-04-30 (see verifier.test.ts comment).
//
// ## The fix
//
// Read EXIF DateTimeOriginal from the ORIGINAL bytes BEFORE the
// canvas-resize destroys it. The SPA then sends it as a multipart
// `client_capture_ms` field. The server bounds it against arrival
// (±5 min / +1 min — same envelope as byte-EXIF) and uses it as the
// reference. Anti-cheat: bounded server-side, so a malicious client
// can't claim a wildly different time than they could already claim
// by forging EXIF bytes.
//
// When EXIF is absent (HEIC variants exifr-lite can't decode,
// privacy-stripped photos, screenshots), we fall back to a
// `fallbackMs` the caller captured at file-selection time
// (`Date.now()` when the user picked the photo). That's still much
// closer to the actual capture moment than server-arrival-after-
// upload would be.
//
// ## Failure mode
//
// `extractCaptureTime` MUST NOT throw. Corrupt EXIF, an image format
// exifr can't parse, an internal exifr blowup — all of these are
// functionally identical to "no EXIF" from the caller's perspective:
// fall back to `fallbackMs`. We log nothing on failure because
// non-EXIF photos are a normal user flow, not an error condition.

// PR #129: switched from `exifr/dist/lite.esm.mjs` to the full
// build because lite's HEIC EXIF extractor has gaps that leave
// DateTimeOriginal undefined for the HEIC variants iPhone Camera
// produces by default. The full build (~75 KB minified vs lite's
// ~45 KB) has complete HEIC support. The Worker side stays on lite
// (the byte-EXIF path there is structurally dead since the SPA's
// canvas-resize strips EXIF anyway — keeping Worker bundle small).
import { parse as exifrParse } from "exifr/dist/full.esm.mjs";

/**
 * Source of the returned capture-time. Useful for debug panels:
 *
 *   * `exif` — DateTimeOriginal (or CreateDate) from the photo's
 *     EXIF segment was usable.
 *   * `fallback` — no parseable EXIF found (HEIC variants exifr-lite
 *     can't decode, screenshots, privacy-stripped photos). The
 *     caller's `fallbackMs` was used.
 */
export type ExtractedCaptureSource = "exif" | "fallback";

export interface ExtractedCaptureTime {
  /** Unix ms used as the moment-of-capture. */
  ms: number;
  /** Where it came from. */
  source: ExtractedCaptureSource;
  /**
   * The raw EXIF Date as an ISO string (UTC), present only when
   * `source === "exif"`. Surfaced so the debug panel can show the
   * exact value the iPhone wrote into the file.
   */
  exifIso?: string;
}

/**
 * Extract a capture-time timestamp (unix ms) for the given photo
 * file. Prefers EXIF DateTimeOriginal (or `CreateDate` as a
 * fallback for cameras that only set one); falls back to
 * `fallbackMs` otherwise.
 *
 * Always resolves to a finite number — never null, never throws.
 * Backward-compatible wrapper kept so callers that only need the
 * ms can read it directly via `.ms`.
 *
 * @param file        The photo as picked from the camera or gallery.
 *                    Read directly; do NOT pass the canvas-resized
 *                    version (resize destroys EXIF).
 * @param fallbackMs  Used when the file has no parseable EXIF date.
 *                    The SPA captures this at file-selection time
 *                    via `Date.now()` so it tracks the user's intent
 *                    moment-to-moment.
 */
export async function extractCaptureTime(
  file: File,
  fallbackMs: number,
): Promise<number> {
  const result = await extractCaptureTimeRich(file, fallbackMs);
  return result.ms;
}

/**
 * Same as {@link extractCaptureTime} but returns rich info about
 * the source — exposes the EXIF ISO string when present so the
 * SPA's debug panel can show the iPhone's wall-clock vs the
 * server's NTP-corrected reference.
 */
export async function extractCaptureTimeRich(
  file: File,
  fallbackMs: number,
): Promise<ExtractedCaptureTime> {
  // Read the file into an ArrayBuffer first. exifr's lite build can
  // accept a Blob in browsers (Workers tests run in workerd which is
  // not quite a browser), but ArrayBuffer is the universally-supported
  // input shape so we always go through it. This is one extra copy
  // up-front, but on the SPA side the file is typically <2 MB and
  // ArrayBuffer reads are essentially free.
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return { ms: fallbackMs, source: "fallback" };
  }
  if (buffer.byteLength === 0) return { ms: fallbackMs, source: "fallback" };

  // We disable IFD0 / GPS / IFD1 / interop and parse only the EXIF
  // segment (where DateTimeOriginal and CreateDate live). The shorter
  // `{ pick: [...] }` form is BROKEN in this exifr lite build
  // (`undefined is not iterable` at setupGlobalFilters) — see the
  // discovery in PR #124. The segment-on form is the workaround that
  // lets the parser skip the expensive segments while still finding
  // the two tags we want.
  let parsed: { DateTimeOriginal?: unknown; CreateDate?: unknown } | undefined;
  try {
    parsed = (await exifrParse(buffer, {
      ifd0: false,
      exif: true,
      gps: false,
      interop: false,
      ifd1: false,
    })) as typeof parsed;
  } catch {
    return { ms: fallbackMs, source: "fallback" };
  }
  if (!parsed) return { ms: fallbackMs, source: "fallback" };
  // Prefer DateTimeOriginal (the moment the shutter fired); fall back
  // to CreateDate (some pipelines — HEIC, certain Android cameras —
  // populate only one of the two).
  const dto = parsed.DateTimeOriginal ?? parsed.CreateDate;
  const ms = toMs(dto);
  if (ms === null) return { ms: fallbackMs, source: "fallback" };
  return {
    ms,
    source: "exif",
    exifIso: dto instanceof Date ? dto.toISOString() : String(dto),
  };
}

// Defensive: exifr usually returns a JS Date for revivable date
// fields (the lib's default is `reviveValues: true`), but we tolerate
// numeric ms timestamps and ISO strings in case a future exifr
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
