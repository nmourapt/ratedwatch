// EXIF parser for JPEG uploads.
//
// Slice 16 (issue #17): the verified-reading pipeline reads EXIF for
// informational purposes ONLY. The acceptance criteria explicitly
// call this out: "The endpoint never reads EXIF for the reference
// time (EXIF is captured in notes for informational purposes only)".
// Client-supplied timestamps can't be trusted; the server receipt
// time is the source of truth.
//
// Contract:
//
//   parseExifDate(buffer) → Date | null
//
// Returns the JPEG's DateTimeOriginal (tag 0x9003) when present,
// else DateTimeDigitized (tag 0x9004). Any parse failure, unknown
// format, non-JPEG input, missing tag, or unparseable date string
// yields null. The function never throws — call sites can rely on
// the binary "got a timestamp" / "didn't" check.

import exifr from "exifr";

// We only need these two date fields. Pass the strict tag allowlist
// to exifr so it doesn't do more work (and doesn't pull in segments
// we don't care about — GPS, IPTC, ICC, …).
//
// EXIF tag 0x9004 is `DateTimeDigitized` per the official spec, but
// exifr renames it to `CreateDate` in its output dictionary. We pick
// both names so a future major-version rename in either direction
// doesn't silently break the fallback.
const PICK_TAGS = ["DateTimeOriginal", "DateTimeDigitized", "CreateDate"] as const;

type ExifDateShape = {
  DateTimeOriginal?: Date | string | null;
  DateTimeDigitized?: Date | string | null;
  CreateDate?: Date | string | null;
};

/**
 * Extract the best-available capture timestamp from a JPEG's EXIF
 * block. Returns null on any failure.
 */
export async function parseExifDate(buffer: ArrayBuffer): Promise<Date | null> {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    return null;
  }

  let parsed: ExifDateShape | undefined;
  try {
    // `pick` limits output to the tags we care about; `translateValues`
    // leaves exifr's default Date translation in place so string dates
    // come back already coerced.
    parsed = (await exifr.parse(buffer, { pick: [...PICK_TAGS] })) as
      | ExifDateShape
      | undefined;
  } catch {
    // Any error path (non-JPEG, truncated, malformed EXIF, …) is a
    // "no date" signal, not a fatal server error.
    return null;
  }

  if (!parsed) return null;

  const original = coerceDate(parsed.DateTimeOriginal);
  if (original) return original;

  const digitized = coerceDate(parsed.DateTimeDigitized ?? parsed.CreateDate);
  if (digitized) return digitized;

  return null;
}

function coerceDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
