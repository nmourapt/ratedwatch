// Unit tests for the verified-reading client-side photo resize
// helper (slice #80 of PRD #73).
//
// We can't run a real browser here, but the helper's contract is
// pure-data: given input dimensions, return a target-dimensioned
// JPEG (or fall back when decode fails). We exercise the real
// `resizeForUpload` by stubbing the global `Image`, `document`,
// and `URL.createObjectURL` it depends on. The test environment
// is workerd (vitest-pool-workers) which doesn't expose a DOM, so
// these globals don't pre-exist — we install them, run, restore.

import { afterEach, describe, expect, it } from "vitest";
import { resizeForUpload, MAX_LONG_EDGE } from "./resizePhoto";

interface FakeImage {
  width: number;
  height: number;
  src: string;
  onload: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

interface FakeCanvas {
  width: number;
  height: number;
  toBlob: (cb: (blob: Blob | null) => void, type: string, quality: number) => void;
  getContext: (type: string) => { drawImage: () => void } | null;
}

interface DocStub {
  createElement: (tag: string) => FakeCanvas;
}

// ---- Globals stubbing harness -----------------------------------

interface Stubs {
  imageDimensions: { w: number; h: number };
  decodeFails?: boolean;
  toBlobReturnsNull?: boolean;
  noCanvasContext?: boolean;
}

function installStubs(stubs: Stubs): () => void {
  const g = globalThis as unknown as {
    document?: DocStub;
    Image?: new () => FakeImage;
    URL?: { createObjectURL: (f: File) => string; revokeObjectURL: (u: string) => void };
  };

  const originalDocument = g.document;
  const originalImage = g.Image;
  const originalURL = g.URL;

  // Capture last-drawn canvas so toBlob can synthesize a Blob whose
  // size faithfully reflects the canvas dimensions (for assertions
  // about "≤1500px" we just need the dimensions; the bytes are
  // dummy).
  const drawnCanvases: FakeCanvas[] = [];

  g.document = {
    createElement: (tag: string): FakeCanvas => {
      if (tag !== "canvas") {
        throw new Error(`unexpected createElement(${tag}) in stub`);
      }
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        toBlob: (cb, type) => {
          if (stubs.toBlobReturnsNull) {
            queueMicrotask(() => cb(null));
            return;
          }
          // Encode dimensions into a tiny placeholder Blob. The
          // dimensions are still queryable via canvas.width/height
          // for assertions.
          const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
          queueMicrotask(() => cb(new Blob([payload], { type })));
        },
        getContext: (type) => {
          if (type !== "2d") return null;
          if (stubs.noCanvasContext) return null;
          return { drawImage: () => undefined };
        },
      };
      drawnCanvases.push(canvas);
      return canvas;
    },
  };

  g.Image = class FakeImg {
    width = 0;
    height = 0;
    src = "";
    onload: (() => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    constructor() {
      // Schedule the load/error callback after a microtask so the
      // Promise-based wrapper gets a chance to attach handlers.
      queueMicrotask(() => {
        if (stubs.decodeFails) {
          this.onerror?.(new Event("error"));
          return;
        }
        this.width = stubs.imageDimensions.w;
        this.height = stubs.imageDimensions.h;
        this.onload?.();
      });
    }
  } as unknown as new () => FakeImage;

  g.URL = {
    createObjectURL: (_f: File) => "blob:fake",
    revokeObjectURL: (_u: string) => undefined,
  };

  // expose drawn canvases on globalThis so test helpers can poke at them
  (globalThis as unknown as { __drawnCanvases?: FakeCanvas[] }).__drawnCanvases =
    drawnCanvases;

  return () => {
    g.document = originalDocument;
    g.Image = originalImage;
    g.URL = originalURL;
    delete (globalThis as unknown as { __drawnCanvases?: FakeCanvas[] }).__drawnCanvases;
  };
}

function makeFakeFile(name = "dial.jpg", type = "image/jpeg"): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], name, { type });
}

function getDrawnCanvases(): FakeCanvas[] {
  return (
    (globalThis as unknown as { __drawnCanvases?: FakeCanvas[] }).__drawnCanvases ?? []
  );
}

// ---- Tests ------------------------------------------------------

describe("resizeForUpload", () => {
  let teardown: (() => void) | null = null;

  afterEach(() => {
    if (teardown) {
      teardown();
      teardown = null;
    }
  });

  it("downscales a 4032x3024 photo to long-edge 1500", async () => {
    teardown = installStubs({ imageDimensions: { w: 4032, h: 3024 } });
    const result = await resizeForUpload(makeFakeFile());

    expect(result.resized).toBe(true);
    expect(result.file.type).toBe("image/jpeg");
    // The canvas was sized to MAX_LONG_EDGE on the long edge.
    const canvas = getDrawnCanvases()[0];
    expect(canvas).toBeDefined();
    expect(Math.max(canvas!.width, canvas!.height)).toBe(MAX_LONG_EDGE);
    // Aspect ratio preserved (within rounding).
    const srcRatio = 4032 / 3024;
    const dstRatio = canvas!.width / canvas!.height;
    expect(Math.abs(srcRatio - dstRatio)).toBeLessThan(0.01);
  });

  it("downscales a 3024x4032 (portrait) photo with the LONGER edge as the cap", async () => {
    teardown = installStubs({ imageDimensions: { w: 3024, h: 4032 } });
    const result = await resizeForUpload(makeFakeFile());
    expect(result.resized).toBe(true);
    const canvas = getDrawnCanvases()[0];
    expect(canvas).toBeDefined();
    // Long edge = 4032 (height). After resize, height should be 1500.
    expect(canvas!.height).toBe(MAX_LONG_EDGE);
    expect(canvas!.width).toBeLessThan(MAX_LONG_EDGE);
  });

  it("returns the original file unchanged when already smaller than the target", async () => {
    teardown = installStubs({ imageDimensions: { w: 800, h: 600 } });
    const original = makeFakeFile("small.jpg");
    const result = await resizeForUpload(original);
    expect(result.resized).toBe(false);
    expect(result.reason).toBe("smaller_than_target");
    // Same File reference — no re-encode happened.
    expect(result.file).toBe(original);
  });

  it("falls back to the original file when the browser can't decode the image", async () => {
    teardown = installStubs({
      imageDimensions: { w: 0, h: 0 },
      decodeFails: true,
    });
    const original = makeFakeFile("weird.heic", "image/heic");
    const result = await resizeForUpload(original);
    expect(result.resized).toBe(false);
    expect(result.reason).toBe("decode_failed");
    expect(result.file).toBe(original);
  });

  it("falls back when canvas.toBlob returns null", async () => {
    teardown = installStubs({
      imageDimensions: { w: 4000, h: 3000 },
      toBlobReturnsNull: true,
    });
    const original = makeFakeFile();
    const result = await resizeForUpload(original);
    expect(result.resized).toBe(false);
    expect(result.reason).toBe("encode_failed");
    expect(result.file).toBe(original);
  });

  it("falls back when canvas.getContext returns null (no 2D support)", async () => {
    teardown = installStubs({
      imageDimensions: { w: 4000, h: 3000 },
      noCanvasContext: true,
    });
    const original = makeFakeFile();
    const result = await resizeForUpload(original);
    expect(result.resized).toBe(false);
    expect(result.reason).toBe("no_canvas_support");
    expect(result.file).toBe(original);
  });
});
