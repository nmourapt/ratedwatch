import { describe, it, expect } from "vitest";
import { parseExifDate } from "./index";
import { buildJpegWithExif, buildJpegWithoutExif, formatExifDate } from "./test-fixtures";

// `parseExifDate` is the verified-reading pipeline's informational
// EXIF probe. Acceptance: never throws; returns a real Date when the
// JPEG has DateTimeOriginal or DateTimeDigitized, else null.
//
// Fixtures are synthesised in-test by test-fixtures.ts — no binary
// files in the repo. See the module docstring for the byte layout.

describe("parseExifDate", () => {
  it("returns a Date matching DateTimeOriginal when present", async () => {
    // EXIF DateTime is timezone-less clock-wall time; the local-time
    // Date constructor matches what exifr returns after parsing.
    const captured = new Date(2024, 0, 15, 10, 30, 45);
    const buf = buildJpegWithExif({
      dateTimeOriginal: formatExifDate(captured),
    });
    const result = await parseExifDate(buf);
    expect(result).toBeInstanceOf(Date);
    expect(formatExifDate(result!)).toBe(formatExifDate(captured));
  });

  it("falls back to DateTimeDigitized when Original is missing", async () => {
    const digitized = new Date(2023, 6, 4, 9, 15, 0);
    const buf = buildJpegWithExif({
      dateTimeDigitized: formatExifDate(digitized),
    });
    const result = await parseExifDate(buf);
    expect(result).toBeInstanceOf(Date);
    expect(formatExifDate(result!)).toBe(formatExifDate(digitized));
  });

  it("prefers DateTimeOriginal over DateTimeDigitized when both are present", async () => {
    const original = new Date(2025, 2, 10, 12, 0, 0);
    const digitized = new Date(2025, 2, 10, 18, 0, 0);
    const buf = buildJpegWithExif({
      dateTimeOriginal: formatExifDate(original),
      dateTimeDigitized: formatExifDate(digitized),
    });
    const result = await parseExifDate(buf);
    expect(result).toBeInstanceOf(Date);
    expect(formatExifDate(result!)).toBe(formatExifDate(original));
  });

  it("returns null for a JPEG with no EXIF data", async () => {
    const buf = buildJpegWithoutExif();
    const result = await parseExifDate(buf);
    expect(result).toBeNull();
  });

  it("returns null for non-JPEG bytes", async () => {
    // "PNG" header (\x89PNG\r\n\x1a\n) — valid PNG magic, not a JPEG.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await parseExifDate(png.buffer);
    expect(result).toBeNull();
  });

  it("returns null for an empty buffer", async () => {
    const empty = new ArrayBuffer(0);
    const result = await parseExifDate(empty);
    expect(result).toBeNull();
  });

  it("returns null for a truncated JPEG that crashes the parser", async () => {
    // Starts like a JPEG but cuts off mid-APP1-segment.
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0xff, 0x45]);
    const result = await parseExifDate(truncated.buffer);
    expect(result).toBeNull();
  });

  it("returns null when the DateTimeOriginal value is unparseable garbage", async () => {
    // Write non-date ASCII into the DateTime slot. exifr will return
    // something (either a garbled string or an Invalid Date); our
    // wrapper must surface that as null.
    const buf = buildJpegWithExif({ dateTimeOriginal: "not-a-date-at-all" });
    const result = await parseExifDate(buf);
    expect(result).toBeNull();
  });
});
