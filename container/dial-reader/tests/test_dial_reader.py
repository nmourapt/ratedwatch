"""End-to-end tests for `dial_reader.read_dial`.

This is the slice's headline test surface. Three layers:

  1. Smoke corpus — 5 noised-synthetic fixtures from
     `tests/fixtures/smoke/`. Truth comes from `manifest.json`.
     Acceptance: every fixture reads with confidence ≥ 0.7 AND
     |actual_seconds - truth_seconds| ≤ 2 (mod 3600, wrapped into
     [-1800, +1800]).

  2. 720 synthetic dial parametrized — 12 hours × 60 second
     positions. The minute is picked deterministically per (hh, ss)
     to keep the three hand angles at least ~14° apart so the
     classifier can separate them. Tighter tolerance: ±1s.

  3. Negative corpus — 5 fixtures generated inline (chronograph,
     blurry, misaligned, non-watch, digital-clock mockup). All must
     produce `result.kind == "rejection"` with a reason in
     {no_dial_found, unsupported_dial, low_confidence}.
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image

from dial_reader.dial_reader import DialReadResult, read_dial
from dial_reader.synthetic import generate_dial

SMOKE_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "smoke"
SMOKE_MANIFEST = SMOKE_FIXTURES_DIR / "manifest.json"
NEGATIVE_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "negative"


def _img_to_bytes(rgb: np.ndarray, format: str = "JPEG") -> bytes:
    """Encode an RGB ndarray as image bytes for `read_dial`."""
    pil = Image.fromarray(rgb)
    buf = io.BytesIO()
    pil.save(buf, format=format, quality=92 if format == "JPEG" else None)
    return buf.getvalue()


def _seconds_diff(actual_m: int, actual_s: int, truth_m: int, truth_s: int) -> int:
    """Signed second-position diff in [-1800, +1800] (mod 3600)."""
    actual = actual_m * 60 + actual_s
    truth = truth_m * 60 + truth_s
    diff = (actual - truth) % 3600
    if diff > 1800:
        diff -= 3600
    return diff


# ---------------------------------------------------------------
# Smoke corpus.
# ---------------------------------------------------------------


def _load_smoke_manifest() -> list[tuple[str, dict]]:
    manifest = json.loads(SMOKE_MANIFEST.read_text())
    return [(filename, meta) for filename, meta in manifest.items()]


@pytest.mark.parametrize(
    "filename,meta",
    _load_smoke_manifest(),
    ids=[item[0] for item in _load_smoke_manifest()],
)
def test_smoke_corpus_reads_within_2s_at_high_confidence(filename: str, meta: dict) -> None:
    """Every smoke fixture reads MM:SS within ±2s of manifest truth
    AND surfaces confidence ≥ 0.7. This is the slice's primary
    acceptance criterion."""
    image_bytes = (SMOKE_FIXTURES_DIR / filename).read_bytes()
    result = read_dial(image_bytes)
    assert result.kind == "success", (
        f"{filename}: expected success, got {result.kind} "
        f"({result.rejection_reason}: {result.rejection_details})"
    )
    assert result.displayed_time is not None
    assert result.confidence >= 0.7, f"{filename}: confidence {result.confidence:.3f} below 0.7"
    diff = _seconds_diff(
        result.displayed_time.m,
        result.displayed_time.s,
        int(meta["mm"]),
        int(meta["ss"]),
    )
    assert abs(diff) <= 2, (
        f"{filename}: read {result.displayed_time.m:02d}:{result.displayed_time.s:02d}, "
        f"truth {int(meta['mm']):02d}:{int(meta['ss']):02d}, deviation {diff:+d}s "
        f"exceeds ±2s tolerance"
    )


# ---------------------------------------------------------------
# 720 synthetic dials.
# ---------------------------------------------------------------


def _expected_angles(hh: int, mm: int, ss: int) -> tuple[float, float, float]:
    hour = ((hh % 12) * 30.0) + (mm / 60.0) * 30.0
    minute = (mm * 6.0) + (ss / 60.0) * 6.0
    second = ss * 6.0
    return (hour % 360.0, minute % 360.0, second % 360.0)


def _circular_sep_deg(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def _pick_mm_with_max_separation(hh: int, ss: int) -> int:
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


def _generate_720_cases() -> list[tuple[int, int, int]]:
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
def test_synthetic_dial_reads_within_1s(hh: int, mm: int, ss: int) -> None:
    """720 parametrized clean synthetic dials read MM:SS within ±1s
    of truth. Tighter than the smoke corpus because synthetic input
    has zero noise."""
    rgb = generate_dial(hh, mm, ss)
    image_bytes = _img_to_bytes(rgb)
    result = read_dial(image_bytes)
    assert result.kind == "success", (
        f"{hh:02d}:{mm:02d}:{ss:02d}: expected success, got {result.kind}"
    )
    assert result.displayed_time is not None
    diff = _seconds_diff(result.displayed_time.m, result.displayed_time.s, mm, ss)
    assert abs(diff) <= 1, (
        f"{hh:02d}:{mm:02d}:{ss:02d}: read "
        f"{result.displayed_time.m:02d}:{result.displayed_time.s:02d}, "
        f"deviation {diff:+d}s exceeds ±1s tolerance"
    )
    # Hour readout should also match — modulo 12 because the
    # synthetic generator uses (hh % 12).
    assert result.displayed_time.h == hh % 12, (
        f"{hh:02d}:{mm:02d}:{ss:02d}: read hour {result.displayed_time.h}, expected {hh % 12}"
    )


# ---------------------------------------------------------------
# Negative corpus — every case must produce a rejection.
# ---------------------------------------------------------------


_ACCEPTABLE_NEG_REASONS = frozenset({"no_dial_found", "unsupported_dial", "low_confidence"})


def _negative_chronograph_bytes() -> bytes:
    """Synthetic 3-hander + 2 sub-dial pointers in different
    positions → 5 hand candidates → unsupported_dial."""
    base = generate_dial(8, 56, 6).copy()
    cx, cy = 400, 400
    for angle_deg, length_frac, thickness in [
        (120.0, 0.30, 8),
        (210.0, 0.30, 8),
    ]:
        rad = math.radians(angle_deg)
        end_x = int(round(cx + math.sin(rad) * 350 * length_frac))
        end_y = int(round(cy - math.cos(rad) * 350 * length_frac))
        cv2.line(base, (cx, cy), (end_x, end_y), (240, 240, 240), thickness, cv2.LINE_AA)
    return _img_to_bytes(base)


def _negative_blurry_bytes() -> bytes:
    """Heavy-blur synthetic dial. The blur smears the chapter ring
    + hands enough that the locator may pass but the hand classifier
    or the confidence threshold will fire."""
    rgb = generate_dial(8, 56, 6)
    blurred = cv2.GaussianBlur(rgb, (51, 51), sigmaX=15)
    return _img_to_bytes(blurred)


def _negative_misaligned_bytes() -> bytes:
    """Hour and minute hands deliberately disagree. We render the
    minute hand at minute=56 (336°) but the hour hand at 4.5 (135°
    rather than the synthetic-generator's natural 8.93*30 = 268°
    that would be consistent with 56 minutes). This trips the
    time-consistency check → confidence < 0.5 → low_confidence
    rejection by the orchestrator's threshold."""
    # Build it from scratch instead of monkey-patching synthetic;
    # synthetic enforces consistency by construction.
    img = np.full((800, 800, 3), (200, 200, 200), dtype=np.uint8)
    cx, cy = 400, 400
    r = 350
    cv2.circle(img, (cx, cy), r, (40, 70, 60), -1, cv2.LINE_AA)
    # 12 hour ticks
    for i in range(12):
        rad = math.radians(i * 30.0)
        ix = int(round(cx + math.sin(rad) * r * 0.88))
        iy = int(round(cy - math.cos(rad) * r * 0.88))
        ox = int(round(cx + math.sin(rad) * r * 0.97))
        oy = int(round(cy - math.cos(rad) * r * 0.97))
        cv2.line(img, (ix, iy), (ox, oy), (240, 240, 240), 8, cv2.LINE_AA)

    def _draw(angle_deg: float, length: int, thickness: int) -> None:
        rad = math.radians(angle_deg)
        end_x = int(round(cx + math.sin(rad) * length))
        end_y = int(round(cy - math.cos(rad) * length))
        cv2.line(img, (cx, cy), (end_x, end_y), (240, 240, 240), thickness, cv2.LINE_AA)

    # Minute at 336° (= minute=56), second at 36° (= second=6),
    # but hour deliberately at 135° (4.5 hours, very inconsistent
    # with minute=56 which expects ~9*30+28°=298°). ~163° error.
    _draw(135.0, int(r * 0.50), max(1, int(2 * r * 0.020)))  # hour
    _draw(336.0, int(r * 0.85), max(1, int(2 * r * 0.010)))  # minute
    _draw(36.0, int(r * 0.90), max(1, int(2 * r * 0.004)))  # second
    return _img_to_bytes(img)


def _negative_nonwatch_bytes() -> bytes:
    """Random noise — definitely not a watch."""
    rng = np.random.default_rng(42)
    rgb = rng.integers(0, 255, size=(800, 800, 3), dtype=np.uint8)
    return _img_to_bytes(rgb)


def _negative_digital_clock_bytes() -> bytes:
    """Rectangular block of digits (mock digital display). No round
    dial → no_dial_found from the locator."""
    rgb = np.full((600, 800, 3), (20, 20, 20), dtype=np.uint8)
    # Big white text in a rectangle
    cv2.rectangle(rgb, (200, 200), (600, 400), (240, 240, 240), -1)
    cv2.putText(
        rgb,
        "12:34",
        (220, 360),
        cv2.FONT_HERSHEY_SIMPLEX,
        4.0,
        (20, 20, 20),
        10,
        cv2.LINE_AA,
    )
    return _img_to_bytes(rgb)


_NEGATIVE_CASES = [
    ("chronograph", _negative_chronograph_bytes),
    ("blurry", _negative_blurry_bytes),
    ("misaligned", _negative_misaligned_bytes),
    ("nonwatch", _negative_nonwatch_bytes),
    ("digital_clock", _negative_digital_clock_bytes),
]


@pytest.mark.parametrize(
    "label,bytes_factory",
    _NEGATIVE_CASES,
    ids=[label for label, _ in _NEGATIVE_CASES],
)
def test_negative_corpus_rejected(label: str, bytes_factory) -> None:
    """Every negative-corpus fixture produces a rejection — never a
    falsely-confident success."""
    image_bytes = bytes_factory()
    result: DialReadResult = read_dial(image_bytes)
    assert result.kind == "rejection", (
        f"{label}: expected rejection, got kind={result.kind}; "
        f"reason={result.rejection_reason}; details={result.rejection_details}"
    )
    assert result.rejection_reason in _ACCEPTABLE_NEG_REASONS, (
        f"{label}: rejection reason {result.rejection_reason!r} not in "
        f"{sorted(_ACCEPTABLE_NEG_REASONS)}"
    )


def test_negative_misaligned_specifically_triggers_low_confidence() -> None:
    """The misaligned-hands negative case is engineered to test the
    time_consistency penalty. Specifically assert that branch
    fires (rather than a different upstream rejection) so a
    regression in the scorer doesn't silently move detection up
    the pipeline."""
    result = read_dial(_negative_misaligned_bytes())
    assert result.kind == "rejection"
    assert result.rejection_reason == "low_confidence", (
        f"misaligned-hands fixture rejected with {result.rejection_reason!r} "
        f"rather than low_confidence; the time-consistency check may have "
        f"regressed."
    )


# ---------------------------------------------------------------
# Discriminated-union shape contract.
# ---------------------------------------------------------------


def test_read_dial_with_empty_bytes_returns_malformed_image() -> None:
    """0 bytes → kind=malformed_image so the HTTP layer surfaces 400."""
    result = read_dial(b"")
    assert result.kind == "malformed_image"


def test_read_dial_with_solid_color_returns_no_dial_found() -> None:
    """Flat color decodes fine but locator finds no circle."""
    rgb = np.full((400, 400, 3), 200, dtype=np.uint8)
    result = read_dial(_img_to_bytes(rgb))
    assert result.kind == "rejection"
    assert result.rejection_reason == "no_dial_found"
