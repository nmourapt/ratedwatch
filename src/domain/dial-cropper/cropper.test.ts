// End-to-end test for `cropToDial` running inside the Workers test
// pool. Exercises the real `env.IMAGES` binding (miniflare forwards
// transforms to Sharp via its Node loopback service) plus the JS
// HoughCircles + Kasa-refinement detector inside dial-cropper.
//
// Algorithmic accuracy is asserted in `hough.node.test.ts` — that
// file checks the detected (cx, cy, r) against the Python bake-off
// reference for all six smoke fixtures. THIS file's job is the
// orchestration: that the binding plumbing is wired correctly, the
// 1024-px-long-edge downsample → decode → Hough → original-image
// crop → 768×768 resize pipeline produces a valid JPEG, and the
// fallback path (no circle found) still returns a valid 768×768
// JPEG.
//
// We pick a single representative fixture (greenseiko — clean dial,
// sub-second test runtime) for the happy path. A synthetic solid-grey
// image exercises the v1 escape-hatch fallback.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { cropToDial } from "./cropper";

interface TestEnv {
  readonly IMAGES: ImagesBinding;
  readonly TEST_FIXTURES: Record<string, string>;
}

function fixtureBytes(name: string): ArrayBuffer {
  const fixtures = (env as unknown as TestEnv).TEST_FIXTURES;
  const b64 = fixtures[name];
  if (!b64) throw new Error(`fixture not found: ${name}`);
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  // Detach to a fresh ArrayBuffer so the binding's underlying buffer
  // isn't shared between calls.
  const ab = new ArrayBuffer(arr.byteLength);
  new Uint8Array(ab).set(arr);
  return ab;
}

/**
 * Validate JPEG by checking the SOI/EOI markers and reading the SOF
 * dimensions. We don't pull in jpeg-js inside the workers pool (it
 * pulls a Node Buffer dep that doesn't transpile cleanly) — these
 * three byte-level checks are enough to assert "this is a real JPEG
 * with the expected dimensions".
 */
function assertJpegDimensions(buf: ArrayBuffer, w: number, h: number): void {
  const bytes = new Uint8Array(buf);
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  // Walk the JPEG segments to find SOF0/SOF2 (baseline / progressive).
  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      throw new Error(`malformed JPEG segment at offset ${i}`);
    }
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xc0 || marker === 0xc2) {
      // SOF0 or SOF2: [FF Cn] [length:2] [precision:1] [height:2] [width:2] ...
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      expect(width).toBe(w);
      expect(height).toBe(h);
      // Scan backwards for the EOI to confirm the file is well-formed.
      expect(bytes[bytes.length - 2]).toBe(0xff);
      expect(bytes[bytes.length - 1]).toBe(0xd9);
      return;
    }
    if (marker === 0xd9) {
      throw new Error("JPEG ended before SOF marker");
    }
    // Standalone markers (RST/SOI/EOI) have no payload; everything
    // else is segment-prefixed by a 2-byte length.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  throw new Error("no SOF marker found in JPEG");
}

describe("cropToDial — orchestration with env.IMAGES", () => {
  it("crops a real watch fixture into a valid 768×768 JPEG", async () => {
    const input = fixtureBytes("greenseiko_07_56_06.jpeg");
    const { IMAGES } = env as unknown as TestEnv;
    const result = await cropToDial(input, { IMAGES });
    expect(result.found).toBe(true);
    // Centre + radius are reported in original-image coordinates.
    // Greenseiko fixture is 3072×4080 with the dial near (1336, 2048).
    // We use a loose ±20% bound on the long edge here because Sharp's
    // downsampler produces slightly different pixels than the
    // bilinear path used in `hough.node.test.ts` — the algorithmic
    // tolerance against the Python reference is asserted there.
    // This test's only job is to confirm the orchestration mapped
    // coordinates back to original resolution correctly (i.e. not
    // returning numbers in 1024-px detection space, which is the
    // most common bug for a binding-orchestration pipeline).
    expect(result.centerXY[0]).toBeGreaterThan(1100);
    expect(result.centerXY[0]).toBeLessThan(1700);
    expect(result.centerXY[1]).toBeGreaterThan(1700);
    expect(result.centerXY[1]).toBeLessThan(2400);
    expect(result.radius).toBeGreaterThan(300);
    expect(result.radius).toBeLessThan(800);
    assertJpegDimensions(result.cropped, 768, 768);
  }, 60_000);

  it("falls back to a centred-square crop when no circle is detected", async () => {
    // 800×600 solid-grey JPEG — no edges, no circular structure.
    // We synthesise it via env.IMAGES so the test doesn't depend on
    // a JPEG encoder of its own.
    const blank = await synthesiseSolidJpeg(800, 600);
    const { IMAGES } = env as unknown as TestEnv;
    const result = await cropToDial(blank, { IMAGES });
    expect(result.found).toBe(false);
    // Fallback: image-centre + half a 60%-of-min-dim square.
    expect(result.centerXY[0]).toBe(400);
    expect(result.centerXY[1]).toBe(300);
    expect(result.radius).toBe(180); // 600 * 0.6 / 2 = 180
    assertJpegDimensions(result.cropped, 768, 768);
  }, 60_000);
});

/**
 * Build a small solid-color JPEG via env.IMAGES. We start from a
 * single-pixel encoded JPEG of mid-grey (the smallest valid input
 * Sharp will accept) and resize it to the requested dimensions.
 */
async function synthesiseSolidJpeg(w: number, h: number): Promise<ArrayBuffer> {
  // Hand-rolled minimal valid 1×1 grey JPEG.
  // Bytes from a Pillow-encoded 1×1 (R=G=B=128) JPEG.
  const onePixelGrey = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06,
    0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d,
    0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d,
    0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28,
    0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02,
    0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10,
    0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00,
    0x01, 0x7d, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
    0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
    0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37,
    0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73,
    0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba,
    0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
    0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08,
    0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd0, 0xff, 0xd9,
  ]);
  const ab = new ArrayBuffer(onePixelGrey.byteLength);
  new Uint8Array(ab).set(onePixelGrey);
  const { IMAGES } = env as unknown as TestEnv;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(ab));
      controller.close();
    },
  });
  const result = await IMAGES.input(stream)
    .transform({ width: w, height: h, fit: "cover", background: "#808080" })
    .output({ format: "image/jpeg", quality: 90 });
  const reader = result.image().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  const outAb = new ArrayBuffer(out.byteLength);
  new Uint8Array(outAb).set(out);
  return outAb;
}
