// Unit tests for the EXIF capture-timestamp extractor.
//
// The extractor wraps `exifr` with a "never throws" contract: any
// failure mode (corrupt EXIF, unsupported format, parser blowup) must
// resolve to `null` so the verifier can cleanly fall back to server
// arrival time. Tests here drive both the happy path and the
// pathological inputs.
//
// The test override hook (`__setTestExifReader`) is exercised in its
// own block to lock down the shape that the verifier tests rely on —
// install a stub, see it called instead of the real parser, then
// clear with `null` to restore the default.

import { afterEach, describe, expect, it, vi } from "vitest";
import { extractCaptureTimestampMs, __setTestExifReader } from "./exif";

afterEach(() => {
  __setTestExifReader(null);
});

describe("extractCaptureTimestampMs", () => {
  it("returns null for an empty buffer", async () => {
    const result = await extractCaptureTimestampMs(new ArrayBuffer(0));
    expect(result).toBeNull();
  });

  it("returns null for non-image bytes", async () => {
    // `TextEncoder().encode(...).buffer` is typed as `ArrayBufferLike`
    // (could be a SharedArrayBuffer in theory). Copy into a fresh
    // ArrayBuffer so the test contract matches what HTTP body
    // handlers actually deliver to the verifier.
    const bytes = new TextEncoder().encode("definitely not a jpeg");
    const garbage = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(garbage).set(bytes);
    const result = await extractCaptureTimestampMs(garbage);
    expect(result).toBeNull();
  });

  it("returns null for a tiny JPEG without EXIF (SOI + EOI only)", async () => {
    // Two-byte SOI + two-byte EOI — a "valid" JPEG header with no
    // metadata segments at all. Real photos straight from a phone
    // always carry EXIF; screenshots and stripped uploads land here.
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    const result = await extractCaptureTimestampMs(buf);
    expect(result).toBeNull();
  });

  it("never throws — corrupt headers resolve to null", async () => {
    // 0xFF 0xD8 sets the JPEG SOI marker but then we lie about
    // segment lengths. exifr historically has handled this via
    // silentErrors; we rely on that and double-belt with a top-level
    // catch. We assert via `.resolves` so the test fails on rejection
    // (which is what the contract forbids) rather than swallowing it.
    const corrupt = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00, 0x00])
      .buffer;
    await expect(extractCaptureTimestampMs(corrupt)).resolves.toBeNull();
  });
});

describe("__setTestExifReader", () => {
  it("routes calls through the installed stub when set", async () => {
    const stub = vi.fn(async () => 1_700_000_000_000);
    __setTestExifReader(stub);
    const result = await extractCaptureTimestampMs(new ArrayBuffer(0));
    expect(stub).toHaveBeenCalledTimes(1);
    expect(result).toBe(1_700_000_000_000);
  });

  it("restores the real parser when cleared with null", async () => {
    const stub = vi.fn(async () => 42);
    __setTestExifReader(stub);
    expect(await extractCaptureTimestampMs(new ArrayBuffer(0))).toBe(42);

    __setTestExifReader(null);
    // Same input as the "tiny JPEG, no EXIF" case — the real parser
    // must take over and yield null.
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    expect(await extractCaptureTimestampMs(buf)).toBeNull();
  });
});
