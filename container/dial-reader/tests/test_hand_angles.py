"""Tests for `hand_geometry.compute_hand_angles`.

Sub-pixel hand-tip refinement matters: the existing
`extreme_point_xy` is the contour pixel furthest from the dial
center, which is integer-quantised. For a thin second hand on a
700-px-radius dial that's already <0.1° of error, but for a thick
hour hand the centroid of the *tip region* (outer 30% of the
contour) gives a more stable angle than a single corner pixel
that happens to win the argmax.

The acceptance bar: per-hand angle error ≤ 1.5° on every clean
synthetic dial in the 720-case grid. That's tighter than the
locator-stage 30° tolerance because the time translator
(`time_translator.to_mmss`) is sensitive at 6°/tick.
"""

from __future__ import annotations

import math

import pytest

from dial_reader.dial_locator import locate
from dial_reader.hand_geometry import (
    HandAngles,
    classify_hands,
    compute_hand_angles,
    detect_hand_contours,
)
from dial_reader.synthetic import generate_dial


def _expected_angles(hh: int, mm: int, ss: int) -> tuple[float, float, float]:
    hour = ((hh % 12) * 30.0) + (mm / 60.0) * 30.0
    minute = (mm * 6.0) + (ss / 60.0) * 6.0
    second = ss * 6.0
    return (hour % 360.0, minute % 360.0, second % 360.0)


def _circular_diff_deg(a: float, b: float) -> float:
    """Signed shortest-distance angular difference (b - a) in degrees,
    folded into [-180, +180]."""
    d = (b - a + 540.0) % 360.0 - 180.0
    return d


def _abs_circular_diff_deg(a: float, b: float) -> float:
    return abs(_circular_diff_deg(a, b))


def test_compute_hand_angles_returns_dataclass() -> None:
    """The output is a `HandAngles` with three float fields in [0, 360)."""
    img = generate_dial(8, 56, 6)
    circle = locate(img)
    assert circle is not None
    hands = classify_hands(detect_hand_contours(img, circle))
    assert hands is not None

    angles = compute_hand_angles(hands, circle)
    assert isinstance(angles, HandAngles)
    for v in (angles.hour_deg, angles.minute_deg, angles.second_deg):
        assert isinstance(v, float)
        assert 0.0 <= v < 360.0


def test_compute_hand_angles_at_8_56_06_within_1_5_deg() -> None:
    """Reference case from the existing fixtures: 08:56:06 → angles
    268° / 336.6° / 36° clockwise from north. Each refined hand angle
    must land within 1.5° of the truth."""
    img = generate_dial(8, 56, 6)
    circle = locate(img)
    assert circle is not None
    hands = classify_hands(detect_hand_contours(img, circle))
    assert hands is not None
    angles = compute_hand_angles(hands, circle)

    eh, em, es = _expected_angles(8, 56, 6)
    assert _abs_circular_diff_deg(angles.hour_deg, eh) < 1.5
    assert _abs_circular_diff_deg(angles.minute_deg, em) < 1.5
    assert _abs_circular_diff_deg(angles.second_deg, es) < 1.5


@pytest.mark.parametrize(
    "hh,mm,ss",
    [
        (1, 35, 50),  # smoke-01 truth
        (8, 56, 6),  # smoke-02 truth
        (4, 25, 13),  # smoke-03 truth
        (11, 5, 30),  # smoke-04 truth
        (6, 42, 18),  # smoke-05 truth
        (2, 17, 44),  # arbitrary well-separated time
    ],
)
def test_compute_hand_angles_within_1_5_deg_on_canonical_times(hh: int, mm: int, ss: int) -> None:
    """Several manually-picked canonical times — verify the refined
    angles are within 1.5° of truth on every clean synthetic input.

    All cases chosen so the three hand angles stay well-separated
    (>12°), the minimum the existing classifier needs."""
    img = generate_dial(hh, mm, ss)
    circle = locate(img)
    assert circle is not None
    hands = classify_hands(detect_hand_contours(img, circle))
    assert hands is not None, f"classify failed at {hh:02d}:{mm:02d}:{ss:02d}"
    angles = compute_hand_angles(hands, circle)

    eh, em, es = _expected_angles(hh, mm, ss)
    err_h = _abs_circular_diff_deg(angles.hour_deg, eh)
    err_m = _abs_circular_diff_deg(angles.minute_deg, em)
    err_s = _abs_circular_diff_deg(angles.second_deg, es)
    assert err_h < 1.5, f"hour err {err_h:.2f}° at {hh:02d}:{mm:02d}:{ss:02d}"
    assert err_m < 1.5, f"min  err {err_m:.2f}° at {hh:02d}:{mm:02d}:{ss:02d}"
    assert err_s < 1.5, f"sec  err {err_s:.2f}° at {hh:02d}:{mm:02d}:{ss:02d}"


def test_compute_hand_angles_normalisation_into_0_360() -> None:
    """All output angles must be in [0, 360) — never negative,
    never ≥ 360. Use a well-separated time that exercises the
    near-360°/near-0° wrap region (sec=59 → 354°)."""
    img = generate_dial(2, 17, 59)
    circle = locate(img)
    assert circle is not None
    hands = classify_hands(detect_hand_contours(img, circle))
    assert hands is not None
    angles = compute_hand_angles(hands, circle)
    for v in (angles.hour_deg, angles.minute_deg, angles.second_deg):
        assert 0.0 <= v < 360.0
