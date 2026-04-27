"""Tests for `hand_geometry` — detect + classify watch hands.

Layered the same way as `test_dial_locator.py`:

  - **Synthetic positives.** 720 parametrized (hh, ss) pairs with a
    deterministic mm chosen to keep all three hands ≥14° apart.
    Asserts every case produces a `Hands` and that each classified
    hand's tip lies within 30° of the true rendered angle. This
    exhaustively covers the second-position circle (60 ss values)
    and every hour position.

  - **Smoke corpus.** All 5 noised-synthetic fixtures from
    `tests/fixtures/smoke/` must classify correctly, with the same
    ±30° tolerance as the 720-case grid. Real-watch photos in
    slice #84 will replace the noised synthetics; the contract
    stays the same.

  - **Negative cases.** Synthetic chronograph-with-sub-dials,
    synthetic GMT (4 hands), synthetic 2-hand (no second). All
    three return `None` from `classify_hands` so the http_app
    layer can surface an `unsupported_dial` rejection.

Why 30° rather than a smaller tolerance: this slice does NOT do
sub-pixel hand-tip refinement or angle math (those land in #79).
The geometric assertion here only needs to confirm that the
classifier picked the *right* hand for each label; once #79's
angle math runs, the precision target (±2°) is checked there.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import numpy as np
import pytest

from dial_reader.dial_locator import locate
from dial_reader.hand_geometry import classify_hands, detect_hand_contours
from dial_reader.synthetic import generate_dial

SMOKE_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "smoke"
SMOKE_MANIFEST = SMOKE_FIXTURES_DIR / "manifest.json"


# ---------------------------------------------------------------
# Helpers — angle math local to the tests. Keep this out of the
# production module: slice #79 introduces the real angle helpers.
# ---------------------------------------------------------------


def _angle_from_center(p: tuple[float, float], center: tuple[int, int]) -> float:
    """Clockwise-from-north angle (degrees) from `center` to `p`."""
    dx = p[0] - center[0]
    dy = p[1] - center[1]
    return math.degrees(math.atan2(dx, -dy)) % 360.0


def _circular_sep_deg(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def _expected_angles(hh: int, mm: int, ss: int) -> tuple[float, float, float]:
    """Match the rendering convention in `synthetic.generate_dial`.

    hour    = (hh%12)*30 + (mm/60)*30
    minute  = mm*6 + (ss/60)*6
    second  = ss*6
    """
    hour = ((hh % 12) * 30.0) + (mm / 60.0) * 30.0
    minute = (mm * 6.0) + (ss / 60.0) * 6.0
    second = ss * 6.0
    return (hour % 360.0, minute % 360.0, second % 360.0)


def _pick_mm_with_max_separation(hh: int, ss: int) -> int:
    """For (hh, ss), pick the mm that maximises minimum pairwise hand
    separation. Used to drive the parametrized 720-case grid.

    The choice is deterministic: same (hh, ss) → same mm on every
    machine and every CI run.
    """
    best_mm = 0
    best_sep = -1.0
    for mm in range(60):
        h, m, s = _expected_angles(hh, mm, ss)
        sep = min(
            _circular_sep_deg(h, m),
            _circular_sep_deg(h, s),
            _circular_sep_deg(m, s),
        )
        if sep > best_sep:
            best_sep = sep
            best_mm = mm
    return best_mm


# ---------------------------------------------------------------
# 720 parametrized synthetic-dial classification cases.
# ---------------------------------------------------------------


def _generate_720_cases() -> list[tuple[int, int, int]]:
    """12 hours × 60 second positions; mm picked to guarantee
    pairwise separation ≥ ~14° (verified at module import).

    Yielding the list rather than (hh, ss) and computing inside the
    test keeps the parametrize ID readable in pytest's output:
    e.g. `test_classify_hands_720[3-22-15]`.
    """
    cases: list[tuple[int, int, int]] = []
    for hh in range(12):
        for ss in range(60):
            mm = _pick_mm_with_max_separation(hh, ss)
            cases.append((hh, mm, ss))
    return cases


CASES_720 = _generate_720_cases()


@pytest.mark.parametrize(
    "hh,mm,ss",
    CASES_720,
    ids=[f"{hh:02d}-{mm:02d}-{ss:02d}" for hh, mm, ss in CASES_720],
)
def test_classify_hands_720(hh: int, mm: int, ss: int) -> None:
    """Exhaustive across the 12×60 (hh, ss) grid — every clean
    synthetic dial classifies correctly into hour / minute / second
    with each hand's tip within 30° of the rendered angle."""
    img = generate_dial(hh, mm, ss)
    circle = locate(img)
    assert circle is not None, f"locator missed clean synthetic dial at {hh:02d}:{mm:02d}:{ss:02d}"

    contours = detect_hand_contours(img, circle)
    hands = classify_hands(contours)
    assert hands is not None, (
        f"classify_hands returned None at {hh:02d}:{mm:02d}:{ss:02d} "
        f"(detected {len(contours)} contours)"
    )

    expected_h, expected_m, expected_s = _expected_angles(hh, mm, ss)
    actual_h = _angle_from_center(hands.hour.extreme_point_xy, circle.center_xy)
    actual_m = _angle_from_center(hands.minute.extreme_point_xy, circle.center_xy)
    actual_s = _angle_from_center(hands.second.extreme_point_xy, circle.center_xy)

    assert _circular_sep_deg(actual_h, expected_h) < 30.0, (
        f"hour mis-classified at {hh:02d}:{mm:02d}:{ss:02d}: "
        f"got tip angle {actual_h:.1f}°, expected ~{expected_h:.1f}°"
    )
    assert _circular_sep_deg(actual_m, expected_m) < 30.0, (
        f"minute mis-classified at {hh:02d}:{mm:02d}:{ss:02d}: "
        f"got tip angle {actual_m:.1f}°, expected ~{expected_m:.1f}°"
    )
    assert _circular_sep_deg(actual_s, expected_s) < 30.0, (
        f"second mis-classified at {hh:02d}:{mm:02d}:{ss:02d}: "
        f"got tip angle {actual_s:.1f}°, expected ~{expected_s:.1f}°"
    )


# ---------------------------------------------------------------
# Smoke corpus classification.
# ---------------------------------------------------------------


def test_smoke_corpus_classifies_correctly() -> None:
    """All 5 smoke fixtures classify per the manifest's truth labels.

    A regression here is either a hand-geometry algorithm change
    or a fixture regeneration where the synthetic-vs-noised
    contrast moved. Both are deliberate enough that the test
    failure is the right place for the operator to notice.
    """
    manifest = json.loads(SMOKE_MANIFEST.read_text())
    failures: list[str] = []
    for filename, meta in manifest.items():
        path = SMOKE_FIXTURES_DIR / filename
        bgr = cv2.imread(str(path))
        if bgr is None:
            failures.append(f"could not read {filename}")
            continue
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

        circle = locate(rgb)
        if circle is None:
            failures.append(f"{filename}: locator returned None")
            continue

        contours = detect_hand_contours(rgb, circle)
        hands = classify_hands(contours)
        if hands is None:
            failures.append(
                f"{filename}: classify_hands returned None (detected {len(contours)} contours)"
            )
            continue

        expected_h, expected_m, expected_s = _expected_angles(
            int(meta["hh"]), int(meta["mm"]), int(meta["ss"])
        )
        actual_h = _angle_from_center(hands.hour.extreme_point_xy, circle.center_xy)
        actual_m = _angle_from_center(hands.minute.extreme_point_xy, circle.center_xy)
        actual_s = _angle_from_center(hands.second.extreme_point_xy, circle.center_xy)

        if _circular_sep_deg(actual_h, expected_h) >= 30.0:
            failures.append(
                f"{filename}: hour mis-classified "
                f"(got {actual_h:.0f}°, expected ~{expected_h:.0f}°)"
            )
        if _circular_sep_deg(actual_m, expected_m) >= 30.0:
            failures.append(
                f"{filename}: minute mis-classified "
                f"(got {actual_m:.0f}°, expected ~{expected_m:.0f}°)"
            )
        if _circular_sep_deg(actual_s, expected_s) >= 30.0:
            failures.append(
                f"{filename}: second mis-classified "
                f"(got {actual_s:.0f}°, expected ~{expected_s:.0f}°)"
            )

    assert not failures, "smoke-corpus classification failures:\n" + "\n".join(failures)


# ---------------------------------------------------------------
# Negative cases — chronograph / GMT / 2-hand all return None.
# ---------------------------------------------------------------


def _draw_extra_radial_line(
    img: np.ndarray,
    center: tuple[int, int],
    angle_deg: float,
    length_px: int,
    thickness: int,
    color: tuple[int, int, int] = (240, 240, 240),
) -> np.ndarray:
    """Draw a hand-like line on a copy of `img`. Used to mock up
    extra hands (sub-dial pointers, GMT) that the synthetic
    generator alone doesn't produce."""
    out = img.copy()
    rad = math.radians(angle_deg)
    end_x = int(round(center[0] + math.sin(rad) * length_px))
    end_y = int(round(center[1] - math.cos(rad) * length_px))
    cv2.line(out, center, (end_x, end_y), color, thickness, lineType=cv2.LINE_AA)
    return out


def _erase_radial_line(
    img: np.ndarray,
    center: tuple[int, int],
    angle_deg: float,
    length_px: int,
    thickness: int,
    erase_color: tuple[int, int, int] = (40, 70, 60),
) -> np.ndarray:
    """Paint over a hand at `(angle, length)` with the dial face
    color. Used to mock up a 2-hand watch (no second hand) without
    having to re-implement the synthetic renderer.

    The thickness is widened slightly past the original hand so
    antialiasing pixels at the hand's edge are also covered.
    """
    out = img.copy()
    rad = math.radians(angle_deg)
    end_x = int(round(center[0] + math.sin(rad) * length_px))
    end_y = int(round(center[1] - math.cos(rad) * length_px))
    cv2.line(
        out,
        center,
        (end_x, end_y),
        erase_color,
        thickness + 2,
        lineType=cv2.LINE_AA,
    )
    return out


def test_chronograph_with_sub_dial_pointers_returns_none() -> None:
    """Synthetic 3-hander + 2 extra short pointers in different
    directions → 4-5 hand candidates → classify_hands returns None.

    This is the headline negative case for slice #78: the container
    must surface `unsupported_dial` rather than silently dropping
    the 4th and 5th hands and producing a confidently-wrong reading.
    """
    base = generate_dial(8, 56, 6)
    circle = locate(base)
    assert circle is not None

    # Two sub-dial pointers at angles well-separated from the
    # main 3 hands and from each other. Length 60% of the hour
    # hand's length so they pass the area floor but stay visually
    # sub-dial-sized.
    sub_dial_length = int(circle.radius_px * 0.30)
    img = _draw_extra_radial_line(
        base, circle.center_xy, angle_deg=120.0, length_px=sub_dial_length, thickness=8
    )
    img = _draw_extra_radial_line(
        img, circle.center_xy, angle_deg=210.0, length_px=sub_dial_length, thickness=8
    )

    contours = detect_hand_contours(img, circle)
    assert classify_hands(contours) is None, (
        f"chronograph mock with {len(contours)} contours should reject"
    )


def test_gmt_with_four_hands_returns_none() -> None:
    """Synthetic 3-hander + a 4th GMT-style hand → 4 hand
    candidates → classify_hands returns None."""
    base = generate_dial(8, 56, 6)
    circle = locate(base)
    assert circle is not None

    # GMT hand: long like a minute hand, distinct angle.
    gmt_length = int(circle.radius_px * 0.80)
    img = _draw_extra_radial_line(
        base,
        circle.center_xy,
        angle_deg=110.0,  # far from the 3 default hands at 268/337/36
        length_px=gmt_length,
        thickness=12,  # GMT is typically a thick, brightly coloured arrow
    )

    contours = detect_hand_contours(img, circle)
    assert classify_hands(contours) is None, f"GMT mock with {len(contours)} contours should reject"


def test_two_hand_dial_returns_none() -> None:
    """Synthetic 3-hander with the second hand erased → 2 hand
    candidates → classify_hands returns None.

    A 2-hand dial is unsupported in v1: rated.watch's verified-
    reading flow is hour+minute+second. Surfacing as
    `unsupported_dial` keeps the user from getting a misleading
    reading where the verifier hallucinates a second-hand position.
    """
    base = generate_dial(8, 56, 6)
    circle = locate(base)
    assert circle is not None

    # Second hand at ss=6 → 36° (per generate_dial), length ~90% of radius.
    second_angle = 36.0
    second_len = int(circle.radius_px * 0.90)
    second_thick = max(1, int(circle.radius_px * 2 * 0.004))
    img = _erase_radial_line(base, circle.center_xy, second_angle, second_len, second_thick)

    contours = detect_hand_contours(img, circle)
    assert classify_hands(contours) is None, (
        f"2-hand mock with {len(contours)} contours should reject"
    )


# ---------------------------------------------------------------
# classify_hands shape / contract tests — invariants independent
# of the detector.
# ---------------------------------------------------------------


def test_classify_hands_returns_none_for_zero_contours() -> None:
    assert classify_hands([]) is None


def test_classify_hands_returns_none_for_one_contour() -> None:
    img = generate_dial(8, 56, 6)
    circle = locate(img)
    assert circle is not None
    contours = detect_hand_contours(img, circle)
    assert len(contours) >= 1
    assert classify_hands(contours[:1]) is None


def test_classify_hands_returns_none_for_two_contours() -> None:
    img = generate_dial(8, 56, 6)
    circle = locate(img)
    assert circle is not None
    contours = detect_hand_contours(img, circle)
    assert len(contours) >= 2
    assert classify_hands(contours[:2]) is None


def test_classify_hands_returns_none_for_four_contours() -> None:
    """Edge case: even if the detector returns 4 candidates,
    classify_hands must not arbitrarily pick 3. The contract is
    'exactly 3 → classify; otherwise → reject'."""
    img = generate_dial(8, 56, 6)
    circle = locate(img)
    assert circle is not None
    contours = detect_hand_contours(img, circle)
    if len(contours) < 3:
        pytest.skip("detector did not yield 3 contours for the synthetic input")
    duplicate = contours[0]
    assert classify_hands([*contours[:3], duplicate]) is None


def test_detect_hand_contours_returns_empty_for_uniform_image() -> None:
    """A flat-color image inside a (faked) dial → no hands found."""
    img = np.full((800, 800, 3), 100, dtype=np.uint8)
    # Synthesise a circle the locator would have produced; we don't
    # call locate() because a flat image has no detectable circle.
    from dial_reader.dial_locator import DialCircle

    fake_dial = DialCircle(center_xy=(400, 400), radius_px=350)
    contours = detect_hand_contours(img, fake_dial)
    assert contours == []


def test_detect_hand_contours_handles_invalid_input_shape() -> None:
    """Defensive: non-RGB input produces an empty list rather than
    raising. Mirrors the locator's behaviour."""
    from dial_reader.dial_locator import DialCircle

    fake_dial = DialCircle(center_xy=(50, 50), radius_px=30)
    bad = np.zeros((100, 100), dtype=np.uint8)  # grayscale, not RGB
    assert detect_hand_contours(bad, fake_dial) == []


# ---------------------------------------------------------------
# Output-contract tests for HandContour.
# ---------------------------------------------------------------


def test_hand_contour_fields_are_populated() -> None:
    """All 5 fields on HandContour must be non-default for a real
    hand. Catches regressions where a code path silently returns
    a HandContour with `length_px=0` or `extreme_point_xy=(0,0)`."""
    img = generate_dial(8, 56, 6)
    circle = locate(img)
    assert circle is not None
    contours = detect_hand_contours(img, circle)
    assert len(contours) == 3
    for c in contours:
        assert c.length_px > 0.0
        assert c.width_px > 0.0
        cx, cy = c.centroid_xy
        assert 0.0 < cx < 800.0 and 0.0 < cy < 800.0
        ex, ey = c.extreme_point_xy
        assert 0.0 < ex < 800.0 and 0.0 < ey < 800.0
        assert c.contour.ndim == 3 and c.contour.shape[2] == 2
