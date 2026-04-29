// Pick the most plausible "watch dial" circle from a HoughCircles
// candidate list. Mirrors the heuristic in the bake-off reference:
//   - Reject candidates whose centre is too far from image centre
//     (> 0.35 × max(w, h) on either axis).
//   - Reject implausibly small radii (< 0.10 × max(w, h)).
//   - Among the survivors, pick the one closest to the image centre.
//
// See `scripts/vlm-bakeoff/bakeoff.py::_crop_to_dial` lines 318-335.
//
// Returning `null` tells the caller (cropper.ts) to fall back to a
// centred 60% square — the bake-off escape hatch.

import type { HoughCircle } from "./hough";

export interface SelectCircleParams {
  readonly width: number;
  readonly height: number;
}

export function selectBestCircle(
  candidates: ReadonlyArray<HoughCircle>,
  { width, height }: SelectCircleParams,
): HoughCircle | null {
  const cx0 = width / 2;
  const cy0 = height / 2;
  const longEdge = Math.max(width, height);
  const minRadius = longEdge * 0.1;
  const distLimit = longEdge * 0.35;
  let best: HoughCircle | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dx = c.cx - cx0;
    const dy = c.cy - cy0;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > distLimit) continue;
    if (c.r < minRadius) continue;
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}
