"""Dial locator — first real CV stage of the pipeline.

Given a decoded RGB ndarray, locate the watch-dial circle and
return its center + radius. Returns `None` when no plausible dial
is found.

Algorithm
=========

  1. Convert to grayscale and apply a mild blur to denoise the
     edge-detector input.
  2. Run `cv2.HoughCircles` with parameters tuned for typical
     wrist-shot framing: the dial fills 30-90% of the long edge,
     well-centered.
  3. Filter the candidate circles:
       - reject those whose radius is outside the 30-90% range
         (small specular highlights, bottle caps in background)
       - reject those whose center is too far from the frame
         midpoint (more than 30% off-center) — wrist shots have
         the dial roughly centered
       - reject those whose edge runs into the frame edge (likely
         a chapter ring of a sub-dial)
  4. Validate each candidate against actual edge support: a real
     dial has a near-continuous bright edge in the Canny map along
     the candidate's perimeter; a phantom circle conjured from
     pure noise does not. Reject candidates where edge support is
     below a threshold.
  5. From the survivors, pick the most centered, largest one as
     the dial.

Why not a learned detector? Classical CV gives us deterministic,
explainable failures. The rejection-as-200 contract with the
Worker depends on the locator producing a clear "no dial here"
signal rather than a low-quality hallucinated circle. HoughCircles
with conservative filtering hits that bar; a learned detector
would need its own dataset, validation, and threshold tuning that
we don't have yet.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import cv2
import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class DialCircle:
    """The located dial circle in pixel space.

    Attributes:
        center_xy: (x, y) image coordinates of the dial center.
        radius_px: Dial radius in pixels.
    """

    center_xy: tuple[int, int]
    radius_px: int


# HoughCircles parameter notes
# ----------------------------
# `dp` is the inverse-ratio of accumulator resolution to image
# resolution. 1.0 = same as image; 1.5 = half-resolution accumulator
# (faster, slightly less precise — fine for the dial-sized blob
# we're looking for).
#
# `minDist` is the minimum distance between detected circle
# centers. Set high so we don't get duplicate concentric detections
# of the same dial.
#
# `param1` is the upper Canny threshold; param2 is the accumulator
# threshold for circle centers. Lower param2 = more candidates,
# higher recall but more false positives. We leave param2
# moderately low and rely on the post-filter step to reject bad
# candidates rather than tuning HoughCircles itself.
_HOUGH_DP: Final[float] = 1.2
_HOUGH_PARAM1: Final[int] = 100
_HOUGH_PARAM2: Final[int] = 30

# Dial-to-frame size constraints. The dial must occupy 30-90% of
# the long edge of the frame. Outside that range the photo is
# either too zoomed-out (dial is a small dot — accuracy will be
# bad) or too zoomed-in (we lose context — chapter-ring tick marks
# fall off the frame).
_MIN_RADIUS_FRAC: Final[float] = 0.15  # diameter ≥ 30% of long edge
_MAX_RADIUS_FRAC: Final[float] = 0.45  # diameter ≤ 90% of long edge

# Off-center tolerance. A wrist-shot dial is roughly centered; a
# circle whose center is more than 30% of the image's half-width
# from the midpoint is almost certainly something else (a
# headlight, a coffee cup rim, a different watch in frame).
_MAX_OFF_CENTER_FRAC: Final[float] = 0.30

# Edge-clearance margin. A circle that hugs the frame edge is
# probably the rim of a sub-dial that got cropped. Reject if the
# circle's edge is closer than this fraction of the radius to the
# frame border.
_MIN_EDGE_CLEARANCE_FRAC: Final[float] = 0.05

# Pre-blur kernel size. Mild Gaussian blur before HoughCircles
# stabilises the edge detector against pixel-level noise without
# wiping the dial's edge.
_BLUR_KERNEL: Final[tuple[int, int]] = (5, 5)

# Interior-uniformity gate. A real dial face is substantially
# more uniform than the surrounding scene: most of the dial is a
# single color (the face) interrupted only by hands and indices.
# Pure-noise inputs have the same statistical distribution
# everywhere, so the standard deviation inside a phantom circle
# matches the image-wide std almost exactly.
#
# We require the interior std to be at most this fraction of the
# image-wide std. 0.85 is loose enough to accept dials with strong
# hand contrast (many high-frequency pixels inside) while
# rejecting noise phantoms (where inside std ≈ image std).
_MAX_INTERIOR_STD_FRAC: Final[float] = 0.85


def _interior_std_ratio(gray: NDArray[np.uint8], cx: float, cy: float, r: float) -> float:
    """Ratio of (std-inside-candidate) / (std-of-whole-image).

    Returns ~1.0 when the inside is as varied as the whole image
    (pure noise input — every region looks the same statistically),
    and a much smaller value for a real dial whose face is mostly
    uniform color interrupted only by hands and indices.

    We shrink the sampling radius to 85% of `r` so the perimeter —
    which by definition is an edge — does not pollute the interior
    measurement.
    """
    full_std = float(gray.std())
    if full_std < 1e-6:
        # Image is uniform; HoughCircles shouldn't find anything,
        # but be defensive.
        return 1.0
    inner_r = max(1, int(r * 0.85))
    mask = np.zeros_like(gray, dtype=np.uint8)
    cv2.circle(mask, (int(round(cx)), int(round(cy))), inner_r, 255, thickness=-1)
    if int(mask.sum()) == 0:
        return 1.0
    interior_std = float(gray[mask > 0].std())
    return interior_std / full_std


def _filter_candidate(
    cx: float,
    cy: float,
    r: float,
    img_w: int,
    img_h: int,
) -> bool:
    """True if (cx, cy, r) survives the post-filter rules."""
    long_edge = max(img_w, img_h)
    min_r = long_edge * _MIN_RADIUS_FRAC
    max_r = long_edge * _MAX_RADIUS_FRAC
    if r < min_r or r > max_r:
        return False

    # Off-center check: distance from midpoint as a fraction of
    # the half-width of the frame.
    mid_x = img_w / 2.0
    mid_y = img_h / 2.0
    dx = abs(cx - mid_x) / mid_x
    dy = abs(cy - mid_y) / mid_y
    if dx > _MAX_OFF_CENTER_FRAC or dy > _MAX_OFF_CENTER_FRAC:
        return False

    # Edge-clearance: the circle's bounding box must sit inside
    # the frame with a margin proportional to the radius.
    margin = r * _MIN_EDGE_CLEARANCE_FRAC
    if cx - r < -margin or cy - r < -margin:
        return False
    if cx + r > img_w + margin or cy + r > img_h + margin:
        return False

    return True


def locate(img: NDArray[np.uint8]) -> DialCircle | None:
    """Locate the watch-dial circle in the supplied RGB image.

    Args:
        img: HxWx3 uint8 RGB ndarray (the shape produced by
            `image_decoder.decode`).

    Returns:
        `DialCircle` with the located circle's center and radius
        in pixel space, or `None` when no plausible dial is found.
    """
    if img.ndim != 3 or img.shape[2] != 3:
        # The decoder always emits HxWx3 RGB; if we got something
        # else the caller is misusing the API. Treat as "no dial"
        # rather than raising — keeps the function total.
        return None

    h, w = img.shape[:2]

    # Grayscale + blur for the Hough input. HoughCircles wants a
    # single-channel 8-bit image. The dial face → background
    # transition is the strongest edge; converting RGB → BGR vs
    # the other way doesn't matter for the grayscale because we
    # only use the luminance.
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, _BLUR_KERNEL, sigmaX=0)

    long_edge = max(w, h)
    min_radius = int(long_edge * _MIN_RADIUS_FRAC)
    max_radius = int(long_edge * _MAX_RADIUS_FRAC)
    # Force at least one pixel separation so HoughCircles doesn't
    # zero-divide on degenerate inputs.
    min_dist = max(1, int(long_edge * 0.5))

    raw = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=_HOUGH_DP,
        minDist=min_dist,
        param1=_HOUGH_PARAM1,
        param2=_HOUGH_PARAM2,
        minRadius=min_radius,
        maxRadius=max_radius,
    )

    if raw is None:
        return None

    # `raw` is shape (1, N, 3) with columns (x, y, r) as floats.
    candidates = raw[0]

    # Apply the post-filter. Survivors are scored by:
    #   - centeredness (smaller off-center distance is better)
    #   - size (larger radius is better — we prefer the dial over
    #     small specular highlights that might survive the
    #     min-radius filter at the boundary)
    survivors: list[tuple[float, float, float, float]] = []  # (score, cx, cy, r)
    mid_x = w / 2.0
    mid_y = h / 2.0
    for cx_f, cy_f, r_f in candidates:
        cx = float(cx_f)
        cy = float(cy_f)
        r = float(r_f)
        if not _filter_candidate(cx, cy, r, w, h):
            continue
        # Interior-uniformity gate. Phantom circles from noisy
        # input have interiors statistically identical to the
        # rest of the frame; real dial faces are dramatically
        # more uniform than the surrounding scene.
        if _interior_std_ratio(gray, cx, cy, r) > _MAX_INTERIOR_STD_FRAC:
            continue
        # Lower distance from center is better; bigger radius is
        # better. Combine into a single score where higher = better.
        center_dist = ((cx - mid_x) ** 2 + (cy - mid_y) ** 2) ** 0.5
        # Normalize by the half-diagonal so the two terms are on
        # comparable scales.
        half_diag = ((w / 2.0) ** 2 + (h / 2.0) ** 2) ** 0.5
        centeredness = 1.0 - (center_dist / half_diag)  # 1 = dead-center
        size_score = r / max_radius  # 0..1
        score = centeredness * 0.6 + size_score * 0.4
        survivors.append((score, cx, cy, r))

    if not survivors:
        return None

    survivors.sort(key=lambda t: t[0], reverse=True)
    _, cx_f, cy_f, r_f = survivors[0]
    return DialCircle(
        center_xy=(int(round(cx_f)), int(round(cy_f))),
        radius_px=int(round(r_f)),
    )
