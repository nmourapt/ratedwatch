"""Tests for the dial locator (HoughCircles + filtering).

The locator is the first real CV stage. It finds the watch dial
circle within a decoded image, returning `DialCircle(center_xy,
radius_px)` or `None` when no plausible dial is found.

What the tests assert (external behaviour, not algorithm details):

  - **Synthetic dials at varying positions and sizes locate.**
    The synthetic generator is the foundation; if the locator
    can't find a clean synthetic dial, it has no chance against
    real photos.

  - **Negative cases return None.** Uniform color, gradient, pure
    noise, blurred frame — all of these must not falsely report
    a dial. False positives downstream produce hallucinated
    readings the user trusts; the verifier owes them silence
    rather than confidently-wrong output.

  - **Smoke corpus locates.** 5 placeholder photo-like fixtures
    committed under `tests/fixtures/smoke/`, generated from the
    synthetic dial + light noise/rotation. Operator replaces them
    with real-watch photos in a follow-up PR.

The synthetic generator and the locator are tested in the same
slice deliberately: the test loop only closes when both work.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from dial_reader.dial_locator import DialCircle, locate
from dial_reader.synthetic import generate_dial

SMOKE_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "smoke"
SMOKE_MANIFEST = SMOKE_FIXTURES_DIR / "manifest.json"


# ---------------------------------------------------------------
# Synthetic positives — 10+ dials at varying positions and sizes.
# ---------------------------------------------------------------


@pytest.mark.parametrize(
    "size,diameter",
    [
        (800, 700),
        (800, 600),
        (800, 500),  # ~62% — within 30-90% sweet spot
        (800, 400),  # 50%
        (600, 500),
        (1200, 1000),
        (1000, 700),
        (400, 350),
        (500, 450),
        (800, 720),  # ~90% — tight to the frame
    ],
)
def test_locate_centered_synthetic_dial(size: int, diameter: int) -> None:
    """Centered dials at varying sizes locate cleanly."""
    img = generate_dial(8, 56, 6, image_size_px=size, dial_diameter_px=diameter)
    circle = locate(img)
    assert circle is not None, f"locator missed a clean centered dial at size {size}/{diameter}"
    cx, cy = circle.center_xy
    # Center should be near image midpoint.
    assert abs(cx - size // 2) < size * 0.10, f"center_x off by {abs(cx - size // 2)} (size={size})"
    assert abs(cy - size // 2) < size * 0.10
    # Radius should match the rendered diameter within ±10%.
    expected_r = diameter // 2
    assert abs(circle.radius_px - expected_r) <= int(expected_r * 0.10), (
        f"radius {circle.radius_px} far from expected {expected_r}"
    )


def _shift_image(
    img: np.ndarray, dx: int, dy: int, background_color: tuple[int, int, int] = (200, 200, 200)
) -> np.ndarray:
    """Shift `img` by (dx, dy) on a fresh background canvas of the same size.

    Used to test off-center dials. We don't crop; we keep the same
    image dimensions and pad with the background color.
    """
    h, w = img.shape[:2]
    out = np.full_like(img, background_color)
    src_x0 = max(0, -dx)
    src_y0 = max(0, -dy)
    dst_x0 = max(0, dx)
    dst_y0 = max(0, dy)
    src_x1 = min(w, w - dx)
    src_y1 = min(h, h - dy)
    dst_x1 = dst_x0 + (src_x1 - src_x0)
    dst_y1 = dst_y0 + (src_y1 - src_y0)
    out[dst_y0:dst_y1, dst_x0:dst_x1] = img[src_y0:src_y1, src_x0:src_x1]
    return out


@pytest.mark.parametrize(
    "dx,dy",
    [
        (50, 0),  # right shift
        (-50, 0),  # left shift
        (0, 50),  # down shift
        (-30, -30),  # up-left shift
    ],
)
def test_locate_off_center_synthetic_dial(dx: int, dy: int) -> None:
    """Dials shifted off-center but still within the 30%-of-midpoint
    tolerance must locate."""
    base = generate_dial(8, 56, 6, image_size_px=800, dial_diameter_px=500)
    img = _shift_image(base, dx, dy)
    circle = locate(img)
    assert circle is not None, f"missed off-center dial shifted ({dx},{dy})"
    cx, cy = circle.center_xy
    assert abs(cx - (400 + dx)) < 50
    assert abs(cy - (400 + dy)) < 50


# ---------------------------------------------------------------
# Negative cases — these must NOT locate a dial.
# ---------------------------------------------------------------


def test_locate_uniform_color_returns_none() -> None:
    """A flat-color image has no circle. Locator must return None."""
    img = np.full((800, 800, 3), 128, dtype=np.uint8)
    assert locate(img) is None


def test_locate_pure_noise_returns_none() -> None:
    """Random RGB noise has no coherent circle structure."""
    rng = np.random.default_rng(seed=42)
    img = rng.integers(0, 256, size=(800, 800, 3), dtype=np.uint8)
    assert locate(img) is None


def test_locate_horizontal_gradient_returns_none() -> None:
    """A linear gradient has no circle."""
    img = np.zeros((800, 800, 3), dtype=np.uint8)
    for x in range(800):
        img[:, x] = (x // 4, x // 4, x // 4)
    assert locate(img) is None


def test_locate_completely_blurred_returns_none() -> None:
    """A heavily Gaussian-blurred dial has no detectable edges and
    must be honestly rejected rather than producing a noisy result."""
    base = generate_dial(8, 56, 6, image_size_px=800, dial_diameter_px=600)
    # Blur kernel large enough to wipe the dial circle's edge.
    blurred = cv2.GaussianBlur(base, (101, 101), sigmaX=40, sigmaY=40)
    assert locate(blurred) is None


def test_locate_off_center_too_far_returns_none() -> None:
    """A dial pushed all the way to the corner is too off-center to
    be a wrist-shot. Locator filters it out — protects against
    spurious detections of round objects in the photo background."""
    base = generate_dial(8, 56, 6, image_size_px=800, dial_diameter_px=300)
    # Shift the dial so its center is near the top-left corner.
    img = _shift_image(base, -300, -300)
    assert locate(img) is None


# ---------------------------------------------------------------
# Smoke corpus — 5 photo-like fixtures committed in git.
# ---------------------------------------------------------------


def test_smoke_manifest_exists_and_has_five_entries() -> None:
    """Operator replaces these placeholders with real-watch photos
    in a follow-up PR; the manifest contract stays the same."""
    assert SMOKE_MANIFEST.exists(), f"smoke manifest missing at {SMOKE_MANIFEST}"
    manifest = json.loads(SMOKE_MANIFEST.read_text())
    assert isinstance(manifest, dict)
    assert len(manifest) == 5, f"expected 5 smoke fixtures, got {len(manifest)}"
    for filename, meta in manifest.items():
        assert (SMOKE_FIXTURES_DIR / filename).exists()
        # Required keys per the PRD's smoke-corpus contract.
        for key in ("hh", "mm", "ss", "watch_make", "watch_model"):
            assert key in meta, f"manifest entry {filename} missing {key}"


def test_smoke_corpus_dials_locate() -> None:
    """All 5 smoke fixtures must contain a detectable dial — they
    are by construction realistic-looking dials. If this fails the
    locator regressed, not the fixtures."""
    manifest = json.loads(SMOKE_MANIFEST.read_text())
    failures: list[str] = []
    for filename in manifest:
        path = SMOKE_FIXTURES_DIR / filename
        bgr = cv2.imread(str(path))
        if bgr is None:
            failures.append(f"could not read {filename}")
            continue
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        circle = locate(rgb)
        if circle is None:
            failures.append(f"locator returned None for {filename}")
    assert not failures, "smoke corpus regressions:\n" + "\n".join(failures)


# ---------------------------------------------------------------
# Type-shape tests for the DialCircle dataclass.
# ---------------------------------------------------------------


def test_dial_circle_fields() -> None:
    c = DialCircle(center_xy=(100, 200), radius_px=300)
    assert c.center_xy == (100, 200)
    assert c.radius_px == 300
