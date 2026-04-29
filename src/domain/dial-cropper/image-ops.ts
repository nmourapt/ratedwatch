// Pure pixel operations used by the dial cropper.
//
// These are intentionally bare-metal: typed-array in, typed-array
// out, no dependencies. They are the JS port of the equivalent
// PIL / OpenCV calls in `scripts/vlm-bakeoff/bakeoff.py::_crop_to_dial`.
//
// Functions exported here are tiny enough to be exercised directly
// by hough.test.ts via the fixture decode path (jpeg-js → bilinear
// resize → grayscale → Gaussian blur → HoughCircles). Production
// callers go through `cropper.ts` which dispatches the resize +
// crop work onto `env.IMAGES` (Sharp, runs in C++ at the edge); the
// pure-JS implementations here are reserved for the test harness so
// it does not depend on Sharp or miniflare's images loopback.

/**
 * Convert RGBA pixel data (output of jpeg-js with `formatAsRGBA: true`)
 * to a single-channel grayscale buffer using Rec. 601 luminance
 * coefficients — the same conversion `cv2.cvtColor(..., COLOR_RGB2GRAY)`
 * uses internally (Y' = 0.299 R + 0.587 G + 0.114 B, rounded).
 */
export function rgbaToGrayscale(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    // OpenCV's exact integer formula is:
    //   y = (4899*R + 9617*G + 1868*B + 8192) >> 14
    // which matches Rec. 601 to <0.5 LSB. We use it verbatim so the
    // grayscale we feed Hough matches what the bake-off produced.
    out[j] = (4899 * r + 9617 * g + 1868 * b + 8192) >> 14;
  }
  return out;
}

/**
 * Convert a 3-channel RGB packed buffer (R,G,B,R,G,B,…) to grayscale
 * with the same coefficients as `rgbaToGrayscale`. Provided so callers
 * that decoded RGB-only data don't have to insert a fake alpha channel
 * just to pass through the RGBA path.
 */
export function rgbToGrayscale(
  rgb: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 1) {
    const r = rgb[i] ?? 0;
    const g = rgb[i + 1] ?? 0;
    const b = rgb[i + 2] ?? 0;
    out[j] = (4899 * r + 9617 * g + 1868 * b + 8192) >> 14;
  }
  return out;
}

/**
 * Apply a separable 5×5 Gaussian blur with σ ≈ 1.0, matching the
 * default `cv2.GaussianBlur(img, (5,5), 0)` call. The kernel below
 * is the same one OpenCV emits for `getGaussianKernel(5, -1)` —
 * normalised to sum to 1, fixed-point scaled to 256 so we can stay
 * in integer arithmetic.
 *
 * We implement separable convolution (horizontal pass then vertical
 * pass) which is O(W*H*K) instead of the O(W*H*K²) naive 2D form.
 * Edge handling: clamp-to-edge (OpenCV's `BORDER_DEFAULT` is mirror
 * reflection but at 5×5 the visual difference is sub-pixel and clamp
 * is meaningfully simpler to reason about).
 */
export function gaussianBlur5(
  src: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  // Coefficients from cv2.getGaussianKernel(5, -1):
  // [0.0625, 0.25, 0.375, 0.25, 0.0625]
  // ≈ [16, 64, 96, 64, 16] / 256
  const k0 = 16;
  const k1 = 64;
  const k2 = 96;
  const k3 = 64;
  const k4 = 16;
  const denom = 256;

  const tmp = new Uint8Array(width * height);
  // Horizontal pass: for each row, convolve along x.
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const x0 = x - 2 < 0 ? 0 : x - 2;
      const x1 = x - 1 < 0 ? 0 : x - 1;
      const x2 = x;
      const x3 = x + 1 >= width ? width - 1 : x + 1;
      const x4 = x + 2 >= width ? width - 1 : x + 2;
      const v =
        (src[row + x0] ?? 0) * k0 +
        (src[row + x1] ?? 0) * k1 +
        (src[row + x2] ?? 0) * k2 +
        (src[row + x3] ?? 0) * k3 +
        (src[row + x4] ?? 0) * k4;
      tmp[row + x] = (v + denom / 2) / denom;
    }
  }
  const out = new Uint8Array(width * height);
  // Vertical pass: convolve tmp along y.
  for (let y = 0; y < height; y += 1) {
    const y0 = (y - 2 < 0 ? 0 : y - 2) * width;
    const y1 = (y - 1 < 0 ? 0 : y - 1) * width;
    const y2 = y * width;
    const y3 = (y + 1 >= height ? height - 1 : y + 1) * width;
    const y4 = (y + 2 >= height ? height - 1 : y + 2) * width;
    for (let x = 0; x < width; x += 1) {
      const v =
        (tmp[y0 + x] ?? 0) * k0 +
        (tmp[y1 + x] ?? 0) * k1 +
        (tmp[y2 + x] ?? 0) * k2 +
        (tmp[y3 + x] ?? 0) * k3 +
        (tmp[y4 + x] ?? 0) * k4;
      out[y2 + x] = (v + denom / 2) / denom;
    }
  }
  return out;
}

/**
 * Bilinear-resize a single-channel buffer to `(dstW, dstH)`.
 *
 * Used ONLY by the test harness (jpeg-js → grayscale → bilinear
 * downsample to 1024px long-edge) so that hough.test.ts can run
 * without depending on `env.IMAGES`. Production cropping uses
 * `env.IMAGES.input(bytes).transform({ resize: ..., format: "jpeg" })`
 * (Sharp/Lanczos at the edge) which is faster and higher-quality.
 */
export function bilinearResizeGray(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  if (dstW === srcW && dstH === srcH) {
    return new Uint8Array(src);
  }
  const out = new Uint8Array(dstW * dstH);
  // Shift-add edge correction: subtract 0.5 from both ends so we
  // sample pixel centres rather than edges. This matches PIL /
  // OpenCV's INTER_LINEAR behaviour and is what the bake-off used
  // (PIL.Image.resize with Resampling.LANCZOS — lanczos differs
  // from bilinear at high frequencies but for a 4080→1024 downsample
  // of a watch dial photo the difference at the dial-circle scale
  // is sub-pixel).
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let yd = 0; yd < dstH; yd += 1) {
    const fy = (yd + 0.5) * sy - 0.5;
    let y0 = Math.floor(fy);
    if (y0 < 0) y0 = 0;
    let y1 = y0 + 1;
    if (y1 >= srcH) y1 = srcH - 1;
    const wy = fy - Math.floor(fy);
    const wy1 = wy < 0 ? 0 : wy > 1 ? 1 : wy;
    const wy0 = 1 - wy1;
    const r0 = y0 * srcW;
    const r1 = y1 * srcW;
    for (let xd = 0; xd < dstW; xd += 1) {
      const fx = (xd + 0.5) * sx - 0.5;
      let x0 = Math.floor(fx);
      if (x0 < 0) x0 = 0;
      let x1 = x0 + 1;
      if (x1 >= srcW) x1 = srcW - 1;
      const wx = fx - Math.floor(fx);
      const wx1 = wx < 0 ? 0 : wx > 1 ? 1 : wx;
      const wx0 = 1 - wx1;
      const v00 = src[r0 + x0] ?? 0;
      const v01 = src[r0 + x1] ?? 0;
      const v10 = src[r1 + x0] ?? 0;
      const v11 = src[r1 + x1] ?? 0;
      const v = v00 * wx0 * wy0 + v01 * wx1 * wy0 + v10 * wx0 * wy1 + v11 * wx1 * wy1;
      out[yd * dstW + xd] = v + 0.5;
    }
  }
  return out;
}
