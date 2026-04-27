"""Tests for the synthetic dial generator.

The generator produces deterministic 3-hand analog dial images
used as fixtures throughout the CV test suite. Two contracts:

  1. **Determinism.** Same inputs → bit-identical pixels.  Tests
     downstream (e.g. dial_locator integration) hash these to
     detect regressions in geometry primitives.

  2. **Locatability.** The output is a valid input to the dial
     locator — the locator must find a circle in it. This closes
     the test loop: the generator produces fixtures the rest of
     the pipeline can consume, so a regression in either side
     surfaces here.

The generator lives at `src/` rather than `tests/` so a future
diagnostic endpoint (e.g. `/v1/synthetic-dial?h=8&m=56&s=6`) can
import it without taking a test-package dependency.
"""

from __future__ import annotations

import hashlib

import numpy as np

from dial_reader.synthetic import generate_dial


def _hash_array(arr: np.ndarray) -> str:
    """SHA-256 hex of the ndarray bytes — stable across platforms."""
    return hashlib.sha256(arr.tobytes()).hexdigest()


def test_generate_dial_returns_rgb_uint8_ndarray() -> None:
    """Contract: HxWx3 uint8 RGB."""
    img = generate_dial(8, 56, 6)
    assert img.dtype == np.uint8
    assert img.ndim == 3
    assert img.shape[2] == 3


def test_generate_dial_default_size_is_800() -> None:
    """Default image_size_px is 800."""
    img = generate_dial(12, 0, 0)
    assert img.shape == (800, 800, 3)


def test_generate_dial_respects_custom_size() -> None:
    img = generate_dial(3, 15, 30, image_size_px=400)
    assert img.shape == (400, 400, 3)


def test_generate_dial_is_deterministic() -> None:
    """Same inputs → bit-identical bytes."""
    a = generate_dial(8, 56, 6)
    b = generate_dial(8, 56, 6)
    assert _hash_array(a) == _hash_array(b)


def test_generate_dial_different_times_produce_different_images() -> None:
    """Smoke check: the function actually depends on its inputs."""
    a = generate_dial(12, 0, 0)
    b = generate_dial(6, 30, 15)
    assert _hash_array(a) != _hash_array(b)


def test_generate_dial_uses_dial_color() -> None:
    """The dial face contains the requested fill color (BGR vs RGB
    safe — we just check the requested color appears at the center)."""
    color = (40, 70, 60)
    img = generate_dial(12, 0, 0, dial_color=color, image_size_px=400)
    # Sample a pixel just beside the center (avoid the hand pivot).
    # In an 800x800 frame with default geometry the very center is
    # covered by the hands; check a ring 100px out where it should
    # be clean dial paint.
    sample_y, sample_x = 200, 100  # left-of-center, well inside dial
    px = img[sample_y, sample_x]
    # Tolerate a tiny amount of antialiasing rounding.
    assert all(abs(int(px[i]) - color[i]) <= 2 for i in range(3)), (
        f"expected ~{color} at ({sample_y},{sample_x}), got {tuple(px)}"
    )


def test_generate_dial_uses_background_color() -> None:
    """Corners of the frame are the background color (dial circle
    doesn't reach the corners)."""
    bg = (200, 200, 200)
    img = generate_dial(12, 0, 0, background_color=bg, image_size_px=400)
    corner = img[0, 0]
    assert tuple(corner) == bg


def test_generate_dial_minute_changes_visible_pixels() -> None:
    """Minute hand position is a function of mm + ss; different
    minutes must produce different pixel arrays."""
    a = generate_dial(12, 0, 0)
    b = generate_dial(12, 30, 0)
    assert _hash_array(a) != _hash_array(b)


def test_generate_dial_seconds_changes_visible_pixels() -> None:
    a = generate_dial(12, 0, 0)
    b = generate_dial(12, 0, 30)
    assert _hash_array(a) != _hash_array(b)


def test_generate_dial_locatable_by_dial_locator() -> None:
    """Closes the loop: the locator finds a dial in the synthetic image.

    Imported here rather than at module level so the test ordering
    inside the file remains generator-then-integration.
    """
    from dial_reader.dial_locator import locate

    img = generate_dial(8, 56, 6)
    circle = locate(img)
    assert circle is not None, "dial_locator should find the synthetic dial"
    # Center should be near the image midpoint within a generous tolerance.
    cx, cy = circle.center_xy
    assert abs(cx - 400) < 50
    assert abs(cy - 400) < 50
    # Radius should be close to dial_diameter_px / 2 = 350.
    assert 320 < circle.radius_px < 380
