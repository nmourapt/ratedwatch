// Test-only helpers to synthesise minimal JPEG bytes with an EXIF
// APP1 segment. Lets the exif-parser tests be self-contained (no
// binary fixtures checked into the repo) and parametric — we can
// generate a fixture with any DateTimeOriginal / DateTimeDigitized
// value a test wants.
//
// Structure of the generated image (all big-endian / "Motorola" byte
// order, which simplifies the encoder):
//
//   SOI        0xFFD8
//   APP1       0xFFE1 <len> "Exif\0\0" <TIFF header + IFD0 + ExifIFD>
//   (a bare-minimum valid JFIF body follows — exifr only cares about
//    the APP1 segment, it doesn't need real image data)
//   EOI        0xFFD9
//
// The smallest body that keeps exifr happy is the APP1 block alone
// followed by EOI — no SOS / DQT / DHT / SOF. exifr.parse() walks
// markers from SOI until it hits APP1; everything after APP1 is only
// read if the caller asks for other segments.

const MARKER_SOI = 0xffd8;
const MARKER_APP1 = 0xffe1;
const MARKER_EOI = 0xffd9;

// EXIF tags (big-endian tag IDs).
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;

// EXIF field types.
const TYPE_ASCII = 2;
const TYPE_LONG = 4;

interface FixtureOptions {
  dateTimeOriginal?: string | null;
  dateTimeDigitized?: string | null;
}

/**
 * Format a Date as an EXIF "DateTime" string ("YYYY:MM:DD HH:MM:SS").
 *
 * EXIF stores clock-wall time with no timezone. exifr parses it back
 * as a Date in the runner's local TZ, so when the round-trip happens
 * we compare using the SAME getters on both sides. We use local-time
 * getters here; the caller of buildJpegWithExif supplies a Date that
 * the fixture will encode as "this many hours after local midnight".
 */
export function formatExifDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Build a minimal JPEG with an EXIF APP1 segment containing the given
 * timestamps. Either can be null/undefined to omit the tag. Returns an
 * ArrayBuffer.
 */
export function buildJpegWithExif(opts: FixtureOptions = {}): ArrayBuffer {
  const entries: Array<{ tag: number; value: string }> = [];
  if (opts.dateTimeOriginal != null) {
    entries.push({ tag: TAG_DATE_TIME_ORIGINAL, value: opts.dateTimeOriginal });
  }
  if (opts.dateTimeDigitized != null) {
    entries.push({ tag: TAG_DATE_TIME_DIGITIZED, value: opts.dateTimeDigitized });
  }

  // --- Build the Exif IFD (where DateTimeOriginal / Digitized live) ---
  // IFD layout: uint16 count, then N x 12-byte entries, then uint32 next-IFD offset, then external data area.
  const exifIfdCount = entries.length;
  // 12 bytes per entry + 2 (count) + 4 (next-IFD offset) = exifIfdHeaderSize
  const exifIfdHeaderSize = 2 + 12 * exifIfdCount + 4;

  // Each DateTime value is 20 bytes of ASCII ("YYYY:MM:DD HH:MM:SS" + \0)
  // — too big to fit in the 4-byte inline value slot, so every value is
  // stored in the external data area.
  const EXIF_DATE_LEN = 20;

  // Positions, relative to the start of the Exif IFD:
  const dataAreaOffset = exifIfdHeaderSize;

  // --- Build the TIFF header + IFD0 + Exif IFD, all in one buffer ---
  // TIFF header: "MM\0*" + IFD0 offset (= 8).
  // IFD0: 1 entry (ExifIFDPointer) + next-IFD offset 0.
  // IFD0 size: 2 + 12 + 4 = 18 bytes. So Exif IFD starts at TIFF-offset
  // 8 + 18 = 26.
  const TIFF_HEADER_LEN = 8;
  const IFD0_LEN = 2 + 12 + 4; // 18
  const exifIfdTiffOffset = TIFF_HEADER_LEN + IFD0_LEN; // 26
  const exifIfdDataTiffOffset = exifIfdTiffOffset + dataAreaOffset;

  // Total TIFF body length:
  const tiffLen =
    TIFF_HEADER_LEN + IFD0_LEN + exifIfdHeaderSize + EXIF_DATE_LEN * exifIfdCount;

  const tiff = new Uint8Array(tiffLen);
  const tiffView = new DataView(tiff.buffer);

  // TIFF header: "MM" (big-endian), 0x002A magic, IFD0 offset 8.
  tiff[0] = 0x4d;
  tiff[1] = 0x4d;
  tiffView.setUint16(2, 0x002a, false);
  tiffView.setUint32(4, 8, false);

  // IFD0: one entry pointing to the Exif IFD.
  tiffView.setUint16(8, 1, false); // count = 1
  // Entry 0: tag=ExifIFDPointer, type=LONG, count=1, value=exifIfdTiffOffset.
  tiffView.setUint16(10, TAG_EXIF_IFD_POINTER, false);
  tiffView.setUint16(12, TYPE_LONG, false);
  tiffView.setUint32(14, 1, false);
  tiffView.setUint32(18, exifIfdTiffOffset, false);
  // Next IFD offset (= 0 means no more IFDs).
  tiffView.setUint32(22, 0, false);

  // Exif IFD: N entries, each a DateTime ASCII field whose value lives
  // in the external data area.
  let cursor = exifIfdTiffOffset;
  tiffView.setUint16(cursor, exifIfdCount, false);
  cursor += 2;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const valueTiffOffset = exifIfdDataTiffOffset + i * EXIF_DATE_LEN;

    tiffView.setUint16(cursor, entry.tag, false);
    tiffView.setUint16(cursor + 2, TYPE_ASCII, false);
    tiffView.setUint32(cursor + 4, EXIF_DATE_LEN, false); // count (bytes, incl. NUL)
    tiffView.setUint32(cursor + 8, valueTiffOffset, false);
    cursor += 12;
  }
  // Next-IFD offset (= 0).
  tiffView.setUint32(cursor, 0, false);
  cursor += 4;

  // External data area: encode each date as 19 ASCII chars + NUL.
  for (let i = 0; i < entries.length; i++) {
    const value = entries[i]!.value;
    // EXIF DateTime format is strict 19-char ASCII. If the caller
    // gave us a different-length string we still pad/truncate to 20
    // bytes with a trailing NUL, so a malformed date can be asserted
    // against by the tests.
    const bytes = stringToFixedAscii(value, EXIF_DATE_LEN);
    tiff.set(bytes, cursor);
    cursor += EXIF_DATE_LEN;
  }

  // --- Wrap in an APP1 segment ---
  // APP1 payload: "Exif\0\0" (6 bytes) + TIFF body.
  const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  const app1Payload = new Uint8Array(exifHeader.length + tiff.length);
  app1Payload.set(exifHeader, 0);
  app1Payload.set(tiff, exifHeader.length);

  // APP1 segment length field is payload length + 2 (includes itself).
  const app1SegLen = app1Payload.length + 2;

  // --- Assemble SOI + APP1 + EOI ---
  const total = 2 + 2 + 2 + app1Payload.length + 2;
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);

  let o = 0;
  outView.setUint16(o, MARKER_SOI, false);
  o += 2;
  outView.setUint16(o, MARKER_APP1, false);
  o += 2;
  outView.setUint16(o, app1SegLen, false);
  o += 2;
  out.set(app1Payload, o);
  o += app1Payload.length;
  outView.setUint16(o, MARKER_EOI, false);

  return out.buffer;
}

/**
 * Build a minimal JPEG with NO EXIF data at all — just SOI + EOI.
 * exifr should accept it as a valid JPEG but find no date fields.
 */
export function buildJpegWithoutExif(): ArrayBuffer {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint16(0, MARKER_SOI, false);
  new DataView(out.buffer).setUint16(2, MARKER_EOI, false);
  return out.buffer;
}

function stringToFixedAscii(s: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length - 1; i++) {
    const c = s.charCodeAt(i);
    bytes[i] = i < s.length && c < 0x80 ? c : 0;
  }
  bytes[length - 1] = 0; // NUL terminator
  return bytes;
}
