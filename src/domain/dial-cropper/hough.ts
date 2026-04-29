// Hough Circle Transform — JS port of cv2.HoughCircles(HOUGH_GRADIENT).
//
// We need this on the Worker because (a) opencv-js is ~9 MB and would
// blow the bundle budget many times over, and (b) Sharp / env.IMAGES
// does not implement HoughCircles. The bake-off tuned the parameter
// space to a narrow band (`scripts/vlm-bakeoff/bakeoff.py::_crop_to_dial`)
// and we only ever need the single best circle near the image centre,
// so a focused ~250-line implementation suffices.
//
// The algorithm (matching the OpenCV reference, in order):
//
//   1. Gaussian blur — done by the caller, see image-ops.ts.
//   2. Sobel gradients Gx, Gy → gradient magnitude.
//   3. Canny edges (NMS along gradient + hysteresis with the two
//      thresholds param1 and param1/2).
//   4. 2D centre accumulator. For each edge pixel (x,y) with
//      normalised gradient (gx,gy), vote along the inward AND
//      outward normal at radii [minR, maxR]:
//           a += 1 at  (x - r*gx, y - r*gy)
//           a += 1 at  (x + r*gx, y + r*gy)
//      Either polarity is needed because we don't know whether the
//      dial is brighter or darker than the surrounding case/strap.
//   5. Find peaks in the centre accumulator (>= param2 votes).
//   6. For each peak, find the best radius by histogramming
//      distances from the peak to every edge pixel.
//   7. Suppress peaks within minDist of an already-accepted one.
//
// The result is a list of (cx, cy, r) candidates ranked by accumulator
// score, matching cv2.HoughCircles's output ordering. Caller picks
// the one closest to the image centre — see selectBestCircle in
// `cropper.ts`.

export interface HoughCircle {
  /** Centre x in pixel coordinates of the input grayscale image. */
  readonly cx: number;
  /** Centre y. */
  readonly cy: number;
  /** Radius in pixels. */
  readonly r: number;
  /** Accumulator vote count for (cx, cy) — used for ranking. */
  readonly score: number;
}

export interface HoughCirclesParams {
  /**
   * Inverse ratio of the accumulator resolution to the image
   * resolution. dp=1 means accumulator has the same resolution; dp=2
   * means accumulator is half the resolution. cv2's HoughCircles
   * default for our use case is 1.2 — i.e. accumulator cells span
   * 1.2×1.2 image pixels, smoothing out tiny gradient-direction
   * inaccuracies.
   */
  readonly dp: number;
  /**
   * Minimum distance between detected circle centres. Set to half
   * the long edge so we only ever return one circle per dial-sized
   * region.
   */
  readonly minDist: number;
  /** Canny upper threshold (lower = param1 / 2). */
  readonly param1: number;
  /**
   * Centre-accumulator vote threshold. Lower → more candidates,
   * more false positives. The bake-off used 30.
   */
  readonly param2: number;
  readonly minRadius: number;
  readonly maxRadius: number;
}

/**
 * Run a HoughCircles pass on a grayscale, Gaussian-blurred image.
 *
 * Returns candidates sorted by descending score (most-voted first).
 * Returns empty array when no peak meets `param2`.
 */
export function houghCircles(
  gray: Uint8Array,
  width: number,
  height: number,
  params: HoughCirclesParams,
): HoughCircle[] {
  const sobel = sobelGradients(gray, width, height);
  const edges = cannyEdges(sobel, width, height, params.param1);
  const accum = voteCentres(
    sobel,
    edges,
    width,
    height,
    params.minRadius,
    params.maxRadius,
    params.dp,
  );
  const peaks = findPeaks(accum, params.dp, width, height, params.param2);
  if (peaks.length === 0) {
    return [];
  }
  // For each peak, recover the best radius by histogramming edge-
  // pixel distances. We use only edge pixels (NOT all pixels) — the
  // votes were cast by edges so the radius signature is in edges.
  const edgePixels = collectEdgePixels(edges, width, height);
  const candidates: HoughCircle[] = [];
  for (const peak of peaks) {
    const r = bestRadius(
      peak.cx,
      peak.cy,
      edgePixels,
      params.minRadius,
      params.maxRadius,
    );
    if (r === null) continue;
    // Refine the (cx, cy, r) tuple by fitting a circle to the
    // edge pixels that fall in a thin band around r. This pulls
    // the centre toward the geometric centre of the dominant
    // circular edge — which on small images (e.g. waterbury,
    // 1067×980) corrects for the few-pixel bias inherited from
    // accumulator quantisation and Sobel/Canny discretisation.
    const refined = refineCircle(peak.cx, peak.cy, r, edgePixels);
    candidates.push({
      cx: refined.cx,
      cy: refined.cy,
      r: refined.r,
      score: peak.score,
    });
  }
  // Suppress peaks within minDist of an already-accepted one — same
  // suppression policy cv2's HoughCircles applies after peak-finding.
  candidates.sort((a, b) => b.score - a.score);
  const accepted: HoughCircle[] = [];
  for (const c of candidates) {
    let tooClose = false;
    for (const a of accepted) {
      const dx = c.cx - a.cx;
      const dy = c.cy - a.cy;
      if (Math.hypot(dx, dy) < params.minDist) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) accepted.push(c);
  }
  return accepted;
}

// ---------------------------------------------------------------------
// Internals — exported only for unit testing of intermediate stages.
// ---------------------------------------------------------------------

interface SobelResult {
  /** Gx values (signed int16-range), same dimensions as the input. */
  readonly gx: Int16Array;
  /** Gy values. */
  readonly gy: Int16Array;
  /** Magnitude (Float32 to keep range above 255). */
  readonly mag: Float32Array;
}

/**
 * 3×3 Sobel gradient operator. Edge handling: clamp-to-edge.
 *
 * Kernels:
 *   Gx =  [-1 0 1; -2 0 2; -1 0 1]
 *   Gy =  [-1 -2 -1; 0 0 0; 1 2 1]
 */
export function sobelGradients(
  src: Uint8Array,
  width: number,
  height: number,
): SobelResult {
  const gx = new Int16Array(width * height);
  const gy = new Int16Array(width * height);
  const mag = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const ym = (y - 1 < 0 ? 0 : y - 1) * width;
    const yc = y * width;
    const yp = (y + 1 >= height ? height - 1 : y + 1) * width;
    for (let x = 0; x < width; x += 1) {
      const xm = x - 1 < 0 ? 0 : x - 1;
      const xp = x + 1 >= width ? width - 1 : x + 1;
      const a = src[ym + xm] ?? 0;
      const b = src[ym + x] ?? 0;
      const c = src[ym + xp] ?? 0;
      const d = src[yc + xm] ?? 0;
      const f = src[yc + xp] ?? 0;
      const g = src[yp + xm] ?? 0;
      const h = src[yp + x] ?? 0;
      const i = src[yp + xp] ?? 0;
      const dx = -a + c - 2 * d + 2 * f - g + i;
      const dy = -a - 2 * b - c + g + 2 * h + i;
      gx[yc + x] = dx;
      gy[yc + x] = dy;
      mag[yc + x] = Math.sqrt(dx * dx + dy * dy);
    }
  }
  return { gx, gy, mag };
}

/**
 * Canny edge detector. Inputs the Sobel result; outputs a binary
 * edge map (255 = edge, 0 = non-edge).
 *
 * - Non-maximum suppression along the local gradient direction.
 * - Double-threshold hysteresis with high = `cannyHigh`, low = high/2
 *   (matching OpenCV's HoughCircles policy).
 */
export function cannyEdges(
  sobel: SobelResult,
  width: number,
  height: number,
  cannyHigh: number,
): Uint8Array {
  const { gx, gy, mag } = sobel;
  const cannyLow = cannyHigh / 2;
  // 1) Non-max suppression. For each pixel, compare its magnitude to
  //    the two neighbours along the gradient direction; if not the
  //    local max, zero it out.
  const nms = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const m = mag[idx] ?? 0;
      if (m === 0) {
        nms[idx] = 0;
        continue;
      }
      // Discretise the gradient direction into 4 buckets:
      // 0° (E-W), 45° (NE-SW), 90° (N-S), 135° (NW-SE).
      const dx = gx[idx] ?? 0;
      const dy = gy[idx] ?? 0;
      const adx = dx < 0 ? -dx : dx;
      const ady = dy < 0 ? -dy : dy;
      let n1: number;
      let n2: number;
      // tan(22.5°) ≈ 0.4142; tan(67.5°) ≈ 2.4142.
      // Use integer-friendly comparisons.
      if (adx * 5 >= ady * 12) {
        // Near-horizontal gradient → compare with E/W neighbours.
        n1 = mag[idx - 1] ?? 0;
        n2 = mag[idx + 1] ?? 0;
      } else if (ady * 5 >= adx * 12) {
        // Near-vertical gradient → N/S neighbours.
        n1 = mag[idx - width] ?? 0;
        n2 = mag[idx + width] ?? 0;
      } else if (dx > 0 === dy > 0) {
        // 45° / NE-SW.
        n1 = mag[idx - width - 1] ?? 0;
        n2 = mag[idx + width + 1] ?? 0;
      } else {
        // 135° / NW-SE.
        n1 = mag[idx - width + 1] ?? 0;
        n2 = mag[idx + width - 1] ?? 0;
      }
      nms[idx] = m >= n1 && m >= n2 ? m : 0;
    }
  }
  // 2) Hysteresis. Strong = above cannyHigh; weak = above cannyLow.
  //    A weak pixel is promoted to edge iff connected (8-neighbour)
  //    to a strong pixel.
  const out = new Uint8Array(width * height);
  // Pass 1: mark strong pixels = 255, weak pixels = 1, rest = 0.
  for (let i = 0; i < nms.length; i += 1) {
    const v = nms[i] ?? 0;
    out[i] = v >= cannyHigh ? 255 : v >= cannyLow ? 1 : 0;
  }
  // Pass 2: BFS from strong pixels promoting weak neighbours.
  // Use a typed-array queue to avoid GC pressure.
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === 255) {
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const idx = queue[head++] ?? 0;
    const x = idx % width;
    const y = (idx - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nidx = ny * width + nx;
        if (out[nidx] === 1) {
          out[nidx] = 255;
          queue[tail++] = nidx;
        }
      }
    }
  }
  // Demote remaining weak pixels.
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === 1) out[i] = 0;
  }
  return out;
}

interface CentrePeak {
  readonly cx: number;
  readonly cy: number;
  readonly score: number;
}

/**
 * Vote into the 2D centre accumulator. For every edge pixel walk along
 * the gradient normal at radii minR..maxR (inclusive, step 1) and
 * increment the accumulator at the projected centre — both polarities
 * (the dial may be lighter or darker than its surround).
 */
function voteCentres(
  sobel: SobelResult,
  edges: Uint8Array,
  width: number,
  height: number,
  minR: number,
  maxR: number,
  dp: number,
): Float32Array {
  const aw = Math.max(1, Math.floor(width / dp));
  const ah = Math.max(1, Math.floor(height / dp));
  const accum = new Float32Array(aw * ah);
  const { gx, gy, mag } = sobel;
  // Sub-pixel bilinear vote distribution: when a vote lands at
  // accumulator coordinates (cx, cy), spread it over the 2×2 cells
  // surrounding (cx, cy) weighted by distance. This gives meaningfully
  // better centre precision than simple integer truncation, especially
  // on small images where each pixel matters (e.g. waterbury at
  // ~1067×980 — without sub-pixel votes the centre walks several
  // pixels off-axis because the accumulator quantises away the
  // gradient-direction signal).
  const splatBilinear = (fx: number, fy: number, weight: number) => {
    if (fx < 0 || fx >= aw - 1 || fy < 0 || fy >= ah - 1) return;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const wx = fx - ix;
    const wy = fy - iy;
    const w00 = (1 - wx) * (1 - wy) * weight;
    const w01 = wx * (1 - wy) * weight;
    const w10 = (1 - wx) * wy * weight;
    const w11 = wx * wy * weight;
    const r0 = iy * aw + ix;
    const r1 = r0 + aw;
    accum[r0] = (accum[r0] ?? 0) + w00;
    accum[r0 + 1] = (accum[r0 + 1] ?? 0) + w01;
    accum[r1] = (accum[r1] ?? 0) + w10;
    accum[r1 + 1] = (accum[r1 + 1] ?? 0) + w11;
  };
  // Compute the median edge magnitude so we can normalise the weight
  // and not let a single super-strong gradient dominate the
  // accumulator. We approximate the median with the mean over edge
  // pixels (cheap and good enough — Canny has already filtered out
  // the long tail of weak gradients).
  let edgeMagSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (edges[row + x] !== 255) continue;
      edgeMagSum += mag[row + x] ?? 0;
      edgeCount += 1;
    }
  }
  const meanEdgeMag = edgeCount > 0 ? edgeMagSum / edgeCount : 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (edges[row + x] !== 255) continue;
      const m = mag[row + x] ?? 0;
      if (m === 0) continue;
      const ux = (gx[row + x] ?? 0) / m;
      const uy = (gy[row + x] ?? 0) / m;
      // Weight each vote by the gradient strength (clamped at 2× the
      // mean so a single very strong edge doesn't drown out a real
      // ring made of many medium-strength pixels). Without this
      // weighting, a uniformly-textured outer bezel made of many
      // medium-strength pixels can lose to an inner dial bordered
      // by a few very-bright marks.
      const w = Math.min(m / meanEdgeMag, 2);
      // Step from minR to maxR; at each r vote in both directions
      // (the dial may be brighter or darker than its surround).
      for (let r = minR; r <= maxR; r += 1) {
        const cx1 = (x - r * ux) / dp;
        const cy1 = (y - r * uy) / dp;
        const cx2 = (x + r * ux) / dp;
        const cy2 = (y + r * uy) / dp;
        splatBilinear(cx1, cy1, w);
        splatBilinear(cx2, cy2, w);
      }
    }
  }
  return accum;
}

/**
 * Find local maxima in the centre accumulator above `threshold`.
 * Uses a 3×3 max-of-neighbours test (matching OpenCV's peak finder),
 * then refines each peak's location with a parabolic fit over the
 * adjacent cells along each axis. Sub-pixel refinement tightens the
 * detected centre by ~0.5 cells on average — important on small
 * images where each accumulator cell maps back to ~dp image pixels.
 */
function findPeaks(
  accum: Float32Array,
  dp: number,
  imageW: number,
  imageH: number,
  threshold: number,
): CentrePeak[] {
  const aw = Math.max(1, Math.floor(imageW / dp));
  const ah = Math.max(1, Math.floor(imageH / dp));
  const peaks: CentrePeak[] = [];
  for (let y = 1; y < ah - 1; y += 1) {
    for (let x = 1; x < aw - 1; x += 1) {
      const v = accum[y * aw + x] ?? 0;
      if (v < threshold) continue;
      // 3×3 max test.
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy += 1) {
        for (let dx = -1; dx <= 1 && isMax; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const n = accum[(y + dy) * aw + (x + dx)] ?? 0;
          if (n > v) isMax = false;
        }
      }
      if (!isMax) continue;
      // Parabolic sub-pixel refinement along each axis. For samples
      // a (left), b (centre, the peak), c (right), the parabola
      // through (-1, a) (0, b) (1, c) peaks at:
      //   x* = (a - c) / (2 (a - 2b + c))
      // clamped to [-1, 1] so a noisy ridge doesn't fly off.
      const aL = accum[y * aw + (x - 1)] ?? 0;
      const aR = accum[y * aw + (x + 1)] ?? 0;
      const aU = accum[(y - 1) * aw + x] ?? 0;
      const aD = accum[(y + 1) * aw + x] ?? 0;
      const denX = aL - 2 * v + aR;
      const denY = aU - 2 * v + aD;
      const dx = denX !== 0 ? (aL - aR) / (2 * denX) : 0;
      const dy = denY !== 0 ? (aU - aD) / (2 * denY) : 0;
      // Clamp to ±0.5 so the parabolic estimate can't claim the
      // peak is in a different cell — that would mean the 3×3 max
      // test was wrong. ±0.5 is the maximum honest sub-cell shift.
      const dxClamped = dx < -0.5 ? -0.5 : dx > 0.5 ? 0.5 : dx;
      const dyClamped = dy < -0.5 ? -0.5 : dy > 0.5 ? 0.5 : dy;
      // Map accumulator coordinates back to image-pixel space.
      // Centre on the cell (add 0.5) before scaling.
      peaks.push({
        cx: (x + 0.5 + dxClamped) * dp,
        cy: (y + 0.5 + dyClamped) * dp,
        score: v,
      });
    }
  }
  return peaks;
}

interface EdgePixel {
  readonly x: number;
  readonly y: number;
}

function collectEdgePixels(
  edges: Uint8Array,
  width: number,
  height: number,
): EdgePixel[] {
  const out: EdgePixel[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (edges[row + x] === 255) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Pick the radius value at which edge pixels accumulate the highest
 * count of distance-from-centre matches. Bins are 1-pixel wide; we
 * also count adjacent bins (r±1) to soften the peak.
 */
function bestRadius(
  cx: number,
  cy: number,
  edgePixels: ReadonlyArray<EdgePixel>,
  minR: number,
  maxR: number,
): number | null {
  if (maxR < minR) return null;
  const bins = new Int32Array(maxR - minR + 1);
  for (const p of edgePixels) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const r = Math.round(d);
    if (r < minR || r > maxR) continue;
    bins[r - minR] = (bins[r - minR] ?? 0) + 1;
  }
  // Smooth with a 3-bin window so a circle whose radius doesn't fall
  // exactly on an integer still produces a clean peak. Pick the
  // largest absolute count — bins for larger r have more potential
  // contributors (longer circumference) and that's accepted; on the
  // smoke corpus we want the dominant ring, not a normalised
  // completeness ratio.
  let bestIdx = -1;
  let bestVal = -1;
  for (let i = 0; i < bins.length; i += 1) {
    const a = bins[i - 1] ?? 0;
    const b = bins[i] ?? 0;
    const c = bins[i + 1] ?? 0;
    const v = a + b + c;
    if (v > bestVal) {
      bestVal = v;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestVal === 0) return null;
  return minR + bestIdx;
}

/**
 * Algebraic circle fit (Kasa's method) on the edge pixels that fall
 * in a thin annulus around the seed circle. Returns the refined
 * (cx, cy, r). On small images this typically pulls the centre 5-15
 * pixels toward the actual circle's geometric centre, fixing a
 * systematic bias that survives Sobel + accumulator-vote quantisation.
 *
 * Kasa's method minimises Σ (d² - r²)², which has a closed-form
 * linear-system solution in O(N) — no iteration, no convergence
 * worries. It biases slightly toward smaller radii under noise but
 * for our use case (dial photos) the bias is sub-pixel.
 */
function refineCircle(
  seedCx: number,
  seedCy: number,
  seedR: number,
  edgePixels: ReadonlyArray<EdgePixel>,
): { cx: number; cy: number; r: number } {
  // Collect edge pixels within ±15% of the seed radius. Tighter
  // would discard real points on a slightly off-radius dial; looser
  // would pull in chapter-ring marks and hands which deflect the
  // fit.
  const rMin = seedR * 0.85;
  const rMax = seedR * 1.15;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of edgePixels) {
    const dx = p.x - seedCx;
    const dy = p.y - seedCy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < rMin || d > rMax) continue;
    xs.push(p.x);
    ys.push(p.y);
  }
  // Need >= 3 non-collinear points for a fit; fall back to seed if
  // we don't have enough.
  if (xs.length < 6) {
    return { cx: seedCx, cy: seedCy, r: seedR };
  }
  // Kasa's algebraic fit, mean-centred for numerical stability.
  // Let uᵢ = xᵢ - mx, vᵢ = yᵢ - my. The fit reduces to:
  //   [Σu²   Σuv ] [uc]   ½ [Σu(u²+v²)]
  //   [Σuv   Σv² ] [vc] =   [Σv(u²+v²)]
  // where (uc, vc) is the centre relative to (mx, my).
  let mx = 0,
    my = 0;
  for (let i = 0; i < xs.length; i += 1) {
    mx += xs[i] ?? 0;
    my += ys[i] ?? 0;
  }
  const n = xs.length;
  mx /= n;
  my /= n;
  let Suu = 0,
    Suv = 0,
    Svv = 0;
  let Suuu_Suvv = 0,
    Svvv_Suuv = 0;
  for (let i = 0; i < n; i += 1) {
    const u = (xs[i] ?? 0) - mx;
    const v = (ys[i] ?? 0) - my;
    const uu = u * u;
    const vv = v * v;
    Suu += uu;
    Suv += u * v;
    Svv += vv;
    Suuu_Suvv += u * (uu + vv);
    Svvv_Suuv += v * (uu + vv);
  }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-6) {
    return { cx: seedCx, cy: seedCy, r: seedR };
  }
  const rhs1 = Suuu_Suvv / 2;
  const rhs2 = Svvv_Suuv / 2;
  const uc = (rhs1 * Svv - rhs2 * Suv) / det;
  const vc = (Suu * rhs2 - Suv * rhs1) / det;
  const cx = uc + mx;
  const cy = vc + my;
  // Re-derive radius as RMS distance from refined centre to the
  // selected points (more robust than (uc² + vc² + (sx²+sy²)/n)
  // for noisy edge sets).
  let sd2 = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = (xs[i] ?? 0) - cx;
    const dy = (ys[i] ?? 0) - cy;
    sd2 += dx * dx + dy * dy;
  }
  const r = Math.sqrt(sd2 / n);
  return { cx, cy, r };
}
