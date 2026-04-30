// Unit tests for the verified-reading client-side capture-time
// extractor (PR #124 fix — see ./extractCaptureTime.ts comment for
// the full backstory).
//
// Contract:
//   * If the file's EXIF has DateTimeOriginal that exifr can parse,
//     return its unix-ms.
//   * Else fall back to the supplied `fallbackMs` (the SPA captures
//     this at file selection — `Date.now()` at the moment the user
//     picked the photo, before the canvas-resize step that would
//     otherwise destroy the EXIF).
//   * Never throw — corrupt EXIF, unsupported HEIC variant, exifr
//     internal blowup all collapse to fallback.
//
// Tests use fake EXIF JPEG bytes from the same fixture helpers the
// server-side EXIF parser uses (`src/domain/exif-parser/test-fixtures`)
// so we exercise the actual exifr code path rather than mocking it.

import { describe, expect, it } from "vitest";
import { extractCaptureTime } from "./extractCaptureTime";
import { buildJpegWithExif, formatExifDate } from "@/domain/exif-parser/test-fixtures";

const FALLBACK_MS = Date.UTC(2026, 4, 1, 12, 0, 0, 0);

function fileFromBytes(bytes: Uint8Array | ArrayBuffer, name = "photo.jpg"): File {
  // Cast keeps `File` happy with both Uint8Array and ArrayBuffer inputs.
  return new File([bytes as BlobPart], name, { type: "image/jpeg" });
}

/**
 * Build a JPEG whose EXIF DateTimeOriginal encodes the given Date in
 * the canonical "YYYY:MM:DD HH:MM:SS" wall-clock form. Returns the
 * Date AND the bytes so tests can assert against the exact ms exifr
 * will produce.
 */
function buildJpegAtDate(d: Date): { bytes: ArrayBuffer; expectedMs: number } {
  const bytes = buildJpegWithExif({ dateTimeOriginal: formatExifDate(d) });
  // exifr parses "YYYY:MM:DD HH:MM:SS" without a timezone, then the
  // JS runtime interprets it. Workers run with TZ=UTC, so the wall-
  // clock digits become UTC digits — i.e. exifr returns a Date whose
  // .getTime() equals Date.UTC(year, month, day, hh, mm, ss).
  const expectedMs = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  );
  return { bytes, expectedMs };
}

describe("extractCaptureTime", () => {
  it("returns EXIF DateTimeOriginal when the photo carries it", async () => {
    const captured = new Date(Date.UTC(2026, 3, 30, 13, 30, 5, 0));
    const { bytes, expectedMs } = buildJpegAtDate(captured);
    const file = fileFromBytes(bytes);
    const result = await extractCaptureTime(file, FALLBACK_MS);
    expect(result).toBe(expectedMs);
  });

  it("falls back to fallbackMs when the file has no EXIF date", async () => {
    // Bytes that exifr can sniff (non-empty, JPEG SOI marker) but
    // with no DateTimeOriginal — equivalent to a canvas-resized blob
    // or a screenshot.
    const noExif = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI
    const file = fileFromBytes(noExif);
    const result = await extractCaptureTime(file, FALLBACK_MS);
    expect(result).toBe(FALLBACK_MS);
  });

  it("falls back to fallbackMs on unparseable bytes (corrupt EXIF, HEIC the lite build can't decode)", async () => {
    const garbage = new Uint8Array(256).fill(0x42);
    const file = fileFromBytes(garbage, "broken.heic");
    const result = await extractCaptureTime(file, FALLBACK_MS);
    expect(result).toBe(FALLBACK_MS);
  });

  it("falls back to fallbackMs on a zero-length file", async () => {
    const empty = new Uint8Array(0);
    const file = fileFromBytes(empty);
    const result = await extractCaptureTime(file, FALLBACK_MS);
    expect(result).toBe(FALLBACK_MS);
  });

  it("returns the EXIF value even when the fallback would have been more recent", async () => {
    // The whole point of preferring EXIF: it pins the moment the
    // shutter fired, not the moment the user happened to upload.
    const captured = new Date(Date.UTC(2026, 4, 1, 11, 59, 50, 0)); // 10s before fallback
    const { bytes, expectedMs } = buildJpegAtDate(captured);
    const file = fileFromBytes(bytes);
    const result = await extractCaptureTime(file, FALLBACK_MS);
    expect(result).toBe(expectedMs);
    expect(result).not.toBe(FALLBACK_MS);
  });
});
