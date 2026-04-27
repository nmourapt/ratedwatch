"""Synthetic 3-hand analog dial generator.

Used as the foundation of the CV test suite. Generates a clean,
deterministic image of an analog dial showing a known time. Tests
in `tests/test_dial_locator.py` and `tests/test_synthetic.py` use
the output to assert geometry primitives behave correctly without
needing real-watch photographs.

The generator lives in `src/` rather than `tests/` so a future
diagnostic endpoint (e.g. `GET /v1/synthetic-dial?h=8&m=56&s=6`)
can reuse it without taking a test-package dependency.

Geometry conventions
====================

  - Image is a square HxWx3 RGB ndarray of dtype uint8.
  - The dial circle is centered at (image_size_px/2, image_size_px/2).
  - All hand angles are measured clockwise from north (12 o'clock).
  - Hour hand is the shortest + thickest, second hand longest + thinnest.

The numbers are tuned for visibility in tests; they are NOT meant
to reproduce a particular real watch's aesthetic. The point is a
clean, locator-friendly fixture.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

import cv2
import numpy as np
from numpy.typing import NDArray

# Hand-length fractions of the dial radius. Tuned so that:
#   - hour hand is clearly the shortest at ~50% radius
#   - minute hand reaches near the chapter ring at ~85%
#   - second hand reaches into the chapter ring at ~90%
# Picking different lengths makes downstream classification by
# length unambiguous (slice #78's job) and gives the locator a
# clean dial-vs-hands separation.
_HOUR_HAND_LENGTH_FRAC: Final[float] = 0.50
_MIN_HAND_LENGTH_FRAC: Final[float] = 0.85
_SEC_HAND_LENGTH_FRAC: Final[float] = 0.90

# Hand thicknesses scale with the dial diameter so that small dials
# are still legible. The fractions are chosen to give a visible
# contrast between the three hands at the default 700px diameter
# (≈14, 7, 3 px wide respectively).
_HOUR_HAND_THICK_FRAC: Final[float] = 0.020
_MIN_HAND_THICK_FRAC: Final[float] = 0.010
_SEC_HAND_THICK_FRAC: Final[float] = 0.004

# Hour-index marker geometry (the 12 dashes around the chapter ring).
_INDEX_INNER_FRAC: Final[float] = 0.88  # inner end of each tick
_INDEX_OUTER_FRAC: Final[float] = 0.97  # outer end (just inside dial edge)
_INDEX_THICK_FRAC: Final[float] = 0.012

# Hour marker color. White on dark dial, dark on light dial — pick
# a fixed near-white that contrasts well with the default green
# dial color and is still visible on light dials. The tests don't
# care about this value; it just needs to differ from dial_color
# enough that the chapter ring is visible to a human reviewing the
# fixtures.
_INDEX_COLOR: Final[tuple[int, int, int]] = (240, 240, 240)

# Hand color. Same near-white for visibility against the dial.
_HAND_COLOR: Final[tuple[int, int, int]] = (240, 240, 240)


@dataclass(frozen=True)
class _Geometry:
    """Cached pixel-space geometry for one render."""

    center_x: int
    center_y: int
    radius: int
    hour_len: int
    min_len: int
    sec_len: int
    hour_thick: int
    min_thick: int
    sec_thick: int


def _compute_geometry(image_size_px: int, dial_diameter_px: int) -> _Geometry:
    """Pre-compute integer pixel positions for the render."""
    cx = image_size_px // 2
    cy = image_size_px // 2
    r = dial_diameter_px // 2
    return _Geometry(
        center_x=cx,
        center_y=cy,
        radius=r,
        hour_len=int(r * _HOUR_HAND_LENGTH_FRAC),
        min_len=int(r * _MIN_HAND_LENGTH_FRAC),
        sec_len=int(r * _SEC_HAND_LENGTH_FRAC),
        # Thicknesses are minimum 1; cv2 rejects 0.
        hour_thick=max(1, int(dial_diameter_px * _HOUR_HAND_THICK_FRAC)),
        min_thick=max(1, int(dial_diameter_px * _MIN_HAND_THICK_FRAC)),
        sec_thick=max(1, int(dial_diameter_px * _SEC_HAND_THICK_FRAC)),
    )


def _angle_to_endpoint(
    cx: int, cy: int, length: int, angle_deg_from_north: float
) -> tuple[int, int]:
    """Convert a clockwise-from-north angle to a pixel endpoint.

    Image coordinates: x grows right, y grows DOWN. So a 0° angle
    (12 o'clock) lands at (cx, cy - length); 90° (3 o'clock) at
    (cx + length, cy); 180° (6 o'clock) at (cx, cy + length).
    """
    rad = math.radians(angle_deg_from_north)
    dx = math.sin(rad) * length
    dy = -math.cos(rad) * length
    return (int(round(cx + dx)), int(round(cy + dy)))


def _draw_chapter_ring(img: NDArray[np.uint8], g: _Geometry) -> None:
    """Draw 12 hour-index ticks around the dial."""
    inner = int(g.radius * _INDEX_INNER_FRAC)
    outer = int(g.radius * _INDEX_OUTER_FRAC)
    thick = max(1, int(g.radius * 2 * _INDEX_THICK_FRAC))
    # OpenCV uses BGR by convention but we're working in an RGB
    # ndarray. We pass colors as-is (RGB tuples) and the resulting
    # tuples become the literal pixel values, since cv2 doesn't
    # care about the semantic meaning of channels — it just writes
    # 3-byte values.
    color = _INDEX_COLOR
    for i in range(12):
        angle_deg = i * 30.0  # 0, 30, 60, …, 330
        p_inner = _angle_to_endpoint(g.center_x, g.center_y, inner, angle_deg)
        p_outer = _angle_to_endpoint(g.center_x, g.center_y, outer, angle_deg)
        cv2.line(img, p_inner, p_outer, color, thick, lineType=cv2.LINE_AA)


def _draw_hand(
    img: NDArray[np.uint8],
    g: _Geometry,
    angle_deg: float,
    length: int,
    thickness: int,
) -> None:
    """Draw one hand from the dial center outward at the given angle."""
    end = _angle_to_endpoint(g.center_x, g.center_y, length, angle_deg)
    cv2.line(
        img,
        (g.center_x, g.center_y),
        end,
        _HAND_COLOR,
        thickness,
        lineType=cv2.LINE_AA,
    )


# Default dial-to-frame ratio. 700/800 = 87.5%. A custom
# `image_size_px` without an explicit `dial_diameter_px` keeps this
# ratio so the dial still fills the frame nicely at smaller sizes.
_DEFAULT_DIAL_FRAME_FRAC: Final[float] = 700.0 / 800.0


def generate_dial(
    hh: int,
    mm: int,
    ss: int,
    *,
    image_size_px: int = 800,
    dial_diameter_px: int | None = None,
    dial_color: tuple[int, int, int] = (40, 70, 60),
    background_color: tuple[int, int, int] = (200, 200, 200),
) -> NDArray[np.uint8]:
    """Render a 3-hand analog dial showing hh:mm:ss.

    Args:
        hh: Hour, 0-23 (only hh % 12 affects the hour hand position).
        mm: Minute, 0-59.
        ss: Second, 0-59.
        image_size_px: Side length of the square output image.
        dial_diameter_px: Diameter of the dial circle in pixels. When
            None (the default), it is set to ~87.5% of `image_size_px`
            so the dial fills the frame the same way at every size.
        dial_color: RGB fill color for the dial face.
        background_color: RGB fill color outside the dial.

    Returns:
        HxWx3 uint8 RGB ndarray.

    The output is fully deterministic: identical inputs produce
    bit-identical pixel arrays. This is asserted in
    `tests/test_synthetic.py::test_generate_dial_is_deterministic`
    via SHA-256 hash equality.
    """
    if image_size_px <= 0:
        raise ValueError(f"image_size_px must be positive, got {image_size_px}")
    if dial_diameter_px is None:
        dial_diameter_px = int(image_size_px * _DEFAULT_DIAL_FRAME_FRAC)
    if dial_diameter_px <= 0 or dial_diameter_px > image_size_px:
        raise ValueError(f"dial_diameter_px must be in (0, image_size_px]; got {dial_diameter_px}")

    g = _compute_geometry(image_size_px, dial_diameter_px)

    # Background fill.
    img = np.full((image_size_px, image_size_px, 3), background_color, dtype=np.uint8)

    # Dial face. cv2.circle with negative thickness fills the circle.
    cv2.circle(
        img,
        (g.center_x, g.center_y),
        g.radius,
        dial_color,
        thickness=-1,
        lineType=cv2.LINE_AA,
    )

    # Chapter ring.
    _draw_chapter_ring(img, g)

    # Hand angles (degrees clockwise from north / 12 o'clock):
    #   hour:    (hh % 12) * 30 + (mm / 60) * 30  — smooth-sweep hour
    #   minute:  mm * 6 + (ss / 60) * 6          — smooth-sweep minute
    #   second:  ss * 6                          — tick-tick second
    hour_angle = ((hh % 12) * 30.0) + (mm / 60.0) * 30.0
    min_angle = (mm * 6.0) + (ss / 60.0) * 6.0
    sec_angle = ss * 6.0

    _draw_hand(img, g, hour_angle, g.hour_len, g.hour_thick)
    _draw_hand(img, g, min_angle, g.min_len, g.min_thick)
    _draw_hand(img, g, sec_angle, g.sec_len, g.sec_thick)

    return img
