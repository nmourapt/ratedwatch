"""Generate the smoke-corpus fixtures from synthetic dials.

Produces 5 photo-like JPEGs under
`tests/fixtures/smoke/` along with `manifest.json` mapping
`filename → {hh, mm, ss, watch_make, watch_model}`.

The fixtures are deliberately *placeholders*: synthetic-but-noised
3-hand dials at known times. The operator will replace them with
real-watch photos in a follow-up PR (they have access to a real
collection; the worker building this slice does not).

Run from `container/dial-reader/`:

    uv run python scripts/build_smoke_fixtures.py

The script is idempotent: re-running overwrites the JPEGs and the
manifest with bit-identical bytes given the same generator output
and a fixed RNG seed.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from dial_reader.synthetic import generate_dial

# Output directory relative to the repo root. The script always
# resolves it from this file's location so it doesn't depend on
# the caller's CWD.
_OUT_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "smoke"


# Fixed seed → deterministic noise. Same seed across runs means
# `git diff` on the JPEGs stays empty unless someone deliberately
# changes the generator parameters.
_NOISE_SEED = 0x5A9C0FFE


def _noisy_photo(
    hh: int,
    mm: int,
    ss: int,
    *,
    image_size_px: int,
    dial_diameter_px: int,
    rotation_deg: float,
    noise_sigma: float,
    blur_kernel: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Render a synthetic dial and dirty it up to look photo-like."""
    img = generate_dial(
        hh,
        mm,
        ss,
        image_size_px=image_size_px,
        dial_diameter_px=dial_diameter_px,
    )

    # Mild rotation about the center to mimic hand-held framing.
    if abs(rotation_deg) > 1e-6:
        m = cv2.getRotationMatrix2D((image_size_px / 2.0, image_size_px / 2.0), rotation_deg, 1.0)
        img = cv2.warpAffine(
            img,
            m,
            (image_size_px, image_size_px),
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(200, 200, 200),
        )

    # Light Gaussian blur to soften pixel-perfect edges.
    if blur_kernel > 1:
        k = blur_kernel | 1  # ensure odd
        img = cv2.GaussianBlur(img, (k, k), sigmaX=0)

    # Add Gaussian noise, clipped to uint8 range.
    if noise_sigma > 0:
        noise = rng.normal(0.0, noise_sigma, img.shape)
        img = np.clip(img.astype(np.int16) + noise.astype(np.int16), 0, 255).astype(np.uint8)

    return img


def main() -> None:
    _OUT_DIR.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(_NOISE_SEED)

    # 5 placeholders at varying times, rotations, sizes, and noise.
    # Reasonable wrist-shot framing across all of them: dial fills
    # a healthy fraction of the frame, slight rotation, mild noise.
    specs = [
        # (hh, mm, ss, size, diameter, rotation_deg, noise_sigma, blur)
        (3, 14, 22, 800, 660, 1.5, 4.0, 3),
        (8, 56, 6, 800, 700, -2.0, 3.0, 3),
        (10, 30, 45, 800, 620, 3.0, 5.0, 5),
        (12, 0, 0, 800, 680, -1.0, 2.5, 3),
        (6, 42, 18, 800, 640, 2.5, 4.5, 5),
    ]

    manifest: dict[str, dict[str, object]] = {}
    for i, (hh, mm, ss, size, diameter, rot, noise, blur) in enumerate(specs, start=1):
        rgb = _noisy_photo(
            hh,
            mm,
            ss,
            image_size_px=size,
            dial_diameter_px=diameter,
            rotation_deg=rot,
            noise_sigma=noise,
            blur_kernel=blur,
            rng=rng,
        )
        # OpenCV writes BGR; convert from our RGB ndarray.
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        filename = f"smoke-{i:02d}.jpg"
        out_path = _OUT_DIR / filename
        # JPEG quality 85 — small files, indistinguishable from
        # phone-camera output at this resolution. Ensures each
        # file fits comfortably under the 200 KB cap mentioned
        # in #77's body.
        cv2.imwrite(
            str(out_path),
            bgr,
            [int(cv2.IMWRITE_JPEG_QUALITY), 85],
        )
        manifest[filename] = {
            "hh": hh,
            "mm": mm,
            "ss": ss,
            "watch_make": "synthetic",
            "watch_model": f"smoke-{i:02d}",
        }

    manifest_path = _OUT_DIR / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    # Sanity: print sizes so the operator can verify the cap.
    for filename in sorted(manifest):
        size = (_OUT_DIR / filename).stat().st_size
        print(f"  {filename}  {size / 1024:.1f} KiB")
    print(f"Wrote {len(manifest)} fixtures + manifest to {_OUT_DIR}")


if __name__ == "__main__":
    main()
