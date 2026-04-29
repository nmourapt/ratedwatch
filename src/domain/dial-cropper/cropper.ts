// `cropToDial` — Worker-side dial cropping pipeline.
//
// Public entry point for slice 2 of PRD #99. The function takes raw
// image bytes (JPEG, HEIC, PNG, …) plus an `IMAGES` binding handle
// and returns a 768×768 JPEG focused on the watch dial. The
// detection runs in pure JS via the modules in this directory; the
// resize + crop steps run on Cloudflare's Workers Images binding
// (Sharp at the edge in C++, ~10 ms/transform on a phone-shot
// 4080×3072 photo).
//
// Pipeline:
//
//   1. Normalise the input to a 1024-px-long-edge JPEG via
//      `env.IMAGES.input(...).transform({ resize, format: "jpeg" })`.
//      This handles HEIC decode, EXIF auto-rotation, and large-image
//      downsampling all in one binding call.
//   2. Decode the small JPEG with `jpeg-js` to a Uint8 RGBA buffer.
//   3. Convert to grayscale + 5×5 Gaussian blur (`image-ops.ts`).
//   4. Run `houghCircles` (`hough.ts`) with bake-off parameters.
//   5. `selectBestCircle` picks the candidate closest to the image
//      centre with a plausible radius. If it returns null (or Hough
//      itself returned []), we fall back to a centred 60 % square
//      crop — the v1 escape hatch documented in the bake-off.
//   6. Map the detected (cx, cy, r) back to the **original**-resolution
//      coordinates and crop the original image at 1.30× the radius
//      via a second `env.IMAGES.transform({ crop, resize: 768×768 })`
//      call. Cropping the original keeps the dial pixels crisp; the
//      1.30× pad factor is empirically tuned (see the comment in
//      `scripts/vlm-bakeoff/bakeoff.py::_crop_to_dial`).
//
// Returns `{ cropped, found, centerXY, radius }`. `found = false`
// when the fallback was used; callers (slice 4) may want to flag
// these for review or annotate the VLM prompt.
//
// Production callers will land in slice #4 (issue #103) — this slice
// only ships the module; the verified-reading endpoint stays 503.

import { decode as decodeJpeg } from "jpeg-js";
import { houghCircles } from "./hough";
import { gaussianBlur5, rgbaToGrayscale } from "./image-ops";
import { selectBestCircle } from "./select-circle";

/** Long edge (in px) we downsample to before running HoughCircles. */
const DETECT_LONG_EDGE = 1024;

/** Output square edge — matches the bake-off VLM input size. */
const OUTPUT_EDGE = 768;

/** Padding factor on the detected radius before cropping. */
const PAD_FACTOR = 1.3;

/**
 * Fallback square crop covers 60 % of the smaller image dimension —
 * keeps the dial in frame on most centred wrist shots even when
 * Hough finds nothing.
 */
const FALLBACK_FRACTION = 0.6;

/** JPEG quality for the final 768×768 output. */
const OUTPUT_QUALITY = 85;

/**
 * Minimum binding shape we depend on — `IMAGES` typed against
 * Workers' `ImagesBinding` interface (defined in
 * worker-configuration.d.ts after `npm run types:gen`).
 *
 * We accept a plain object rather than the whole `Env` so the
 * function is trivially mockable for unit tests.
 */
export interface CropToDialEnv {
  readonly IMAGES: ImagesBinding;
}

export interface CropToDialResult {
  /** The 768×768 JPEG bytes. */
  readonly cropped: ArrayBuffer;
  /** True when HoughCircles produced a usable candidate; false when the centred-square fallback was used. */
  readonly found: boolean;
  /**
   * Centre point of the chosen circle in **original-image** pixel
   * coordinates. When `found = false`, this is the image centre.
   */
  readonly centerXY: readonly [number, number];
  /**
   * Radius in **original-image** pixels. When `found = false`, this
   * is half the fallback square's side.
   */
  readonly radius: number;
}

/**
 * Crop the image to the watch dial. See module docstring for the
 * full pipeline.
 *
 * @param input  raw photo bytes (JPEG/HEIC/PNG/WebP — anything
 *               `env.IMAGES` can decode).
 * @param env    a context exposing the IMAGES binding.
 */
export async function cropToDial(
  input: ArrayBuffer,
  env: CropToDialEnv,
): Promise<CropToDialResult> {
  // Step 1 + 2: produce a 1024-px JPEG and decode it.
  const small = await downsampleToJpeg(input, env);
  const decoded = decodeJpeg(small.bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 100,
    maxMemoryUsageInMB: 1024,
  });
  const w = decoded.width;
  const h = decoded.height;
  if (w === 0 || h === 0) {
    // Pathological input — fall back to a centred square at zero
    // size on the original (which is itself pathological). The
    // env.IMAGES path will refuse and throw a sensible error; we
    // surface that to the caller rather than try to silently fix it.
    throw new Error("dial-cropper: decoded image has zero dimensions");
  }
  const gray = rgbaToGrayscale(decoded.data, w, h);
  const blurred = gaussianBlur5(gray, w, h);

  // Step 3 + 4: Hough.
  const longEdge = Math.max(w, h);
  const minRadius = Math.floor(longEdge * 0.1);
  const maxRadius = Math.floor(longEdge * 0.5);
  const candidates = houghCircles(blurred, w, h, {
    dp: 1.2,
    minDist: Math.floor(longEdge / 2),
    param1: 100,
    param2: 30,
    minRadius,
    maxRadius,
  });
  const best = selectBestCircle(candidates, { width: w, height: h });

  // Step 5: pick coordinates in the original-image frame.
  const origW = small.originalWidth;
  const origH = small.originalHeight;
  const sx = origW / w;
  const sy = origH / h;
  let centerX: number;
  let centerY: number;
  let radiusOrig: number;
  let found: boolean;
  if (best === null) {
    found = false;
    centerX = origW / 2;
    centerY = origH / 2;
    radiusOrig = (Math.min(origW, origH) * FALLBACK_FRACTION) / 2;
  } else {
    found = true;
    centerX = best.cx * sx;
    centerY = best.cy * sy;
    // Average sx, sy is fine — env.IMAGES preserves aspect ratio
    // through its scale-down resize, so sx ≈ sy. If they ever
    // diverge (non-square pixels) we preserve the smaller scale to
    // avoid clipping the dial.
    radiusOrig = best.r * Math.min(sx, sy);
  }

  // Step 6: crop the original image and resize to OUTPUT_EDGE.
  const cropped = await cropAndResizeOriginal(input, env, {
    centerX,
    centerY,
    radiusOrig,
    origW,
    origH,
  });

  return {
    cropped,
    found,
    centerXY: [Math.round(centerX), Math.round(centerY)],
    radius: Math.round(radiusOrig),
  };
}

interface DownsampledImage {
  readonly bytes: Uint8Array;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

/**
 * Run the input through `env.IMAGES` once to get a 1024-px-long-edge
 * JPEG. We also need the original image's dimensions so we can map
 * Hough centres back to original-resolution coordinates for the
 * final crop.
 */
async function downsampleToJpeg(
  input: ArrayBuffer,
  env: CropToDialEnv,
): Promise<DownsampledImage> {
  // Read the original dimensions via `env.IMAGES.info`. This is a
  // separate transform call; alternatives (peeking at JPEG headers
  // ourselves, or running `info` after the resize) are either
  // unsafe (HEIC has no width header in the obvious place) or
  // strictly worse (the post-resize info would lose the original
  // dimensions we need for coordinate mapping).
  const infoStream = streamFromArrayBuffer(input);
  const info = await env.IMAGES.info(infoStream);
  if (!isInfoWithDims(info)) {
    throw new Error("dial-cropper: env.IMAGES.info did not return image dimensions");
  }
  const result = await env.IMAGES.input(streamFromArrayBuffer(input))
    .transform({
      width: DETECT_LONG_EDGE,
      height: DETECT_LONG_EDGE,
      fit: "scale-down",
    })
    .output({ format: "image/jpeg", quality: 90 });
  const bytes = await streamToUint8Array(result.image());
  return {
    bytes,
    originalWidth: info.width,
    originalHeight: info.height,
  };
}

interface CropParams {
  readonly centerX: number;
  readonly centerY: number;
  readonly radiusOrig: number;
  readonly origW: number;
  readonly origH: number;
}

/**
 * Crop the **original** image at 1.30 × radius around (centerX,
 * centerY), then resize the crop to `OUTPUT_EDGE × OUTPUT_EDGE` with
 * `fit: "pad"` so non-square crops (when the bounding box is clipped
 * at an image edge) don't get squashed.
 */
async function cropAndResizeOriginal(
  input: ArrayBuffer,
  env: CropToDialEnv,
  params: CropParams,
): Promise<ArrayBuffer> {
  const half = Math.round(params.radiusOrig * PAD_FACTOR);
  const x0 = Math.max(0, Math.round(params.centerX - half));
  const y0 = Math.max(0, Math.round(params.centerY - half));
  const x1 = Math.min(params.origW, Math.round(params.centerX + half));
  const y1 = Math.min(params.origH, Math.round(params.centerY + half));
  const cropW = Math.max(1, x1 - x0);
  const cropH = Math.max(1, y1 - y0);
  // Cropping in Workers Images is expressed via `trim`: explicit
  // top/left/width/height to keep, with `border: false` to disable
  // the automatic-trim heuristic. Followed by a `pad` resize to
  // OUTPUT_EDGE × OUTPUT_EDGE so a non-square crop (when the
  // bounding box was clipped at an image edge) doesn't get squashed.
  const result = await env.IMAGES.input(streamFromArrayBuffer(input))
    .transform({
      trim: { left: x0, top: y0, width: cropW, height: cropH, border: false },
    })
    .transform({
      width: OUTPUT_EDGE,
      height: OUTPUT_EDGE,
      fit: "pad",
    })
    .output({ format: "image/jpeg", quality: OUTPUT_QUALITY });
  const bytes = await streamToUint8Array(result.image());
  // Copy into a tightly-sized ArrayBuffer to detach it from any
  // pooled buffer the runtime may have handed us. Callers may
  // store/forward the result; we don't want them to hold a slice of
  // a larger buffer that GC can't reclaim.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

// ---------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------

function streamFromArrayBuffer(ab: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(ab));
      controller.close();
    },
  });
}

async function streamToUint8Array(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
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
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function isInfoWithDims(
  info: ImageInfoResponse,
): info is Extract<ImageInfoResponse, { width: number; height: number }> {
  return (
    typeof (info as { width?: unknown }).width === "number" &&
    typeof (info as { height?: unknown }).height === "number"
  );
}
