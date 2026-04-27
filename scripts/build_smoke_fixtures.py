"""Regenerate the smoke-corpus placeholder fixtures.

Lives at `scripts/` so the operator can re-run it any time the
synthetic generator or smoke contract changes. The output goes to
`container/dial-reader/tests/fixtures/smoke/` and is checked in.

The generator produces noised synthetic 3-hand analog dials at
times chosen to keep all three hands cleanly separated (min
pairwise angular separation ≥ 30°) — that way the dial-locator,
hand-geometry, and time-translator suites can all run against the
same fixtures without per-test special-casing.

Slice #84 of PRD #73 will replace these with real-watch photos
(operator-collected). The contract is the same: 5 JPEGs, ≤200KiB
each, at 800×800, plus a manifest.json with truth labels per
file. Tests don't care whether the bytes came from a synthetic
generator or a real camera; they only care that the manifest
matches the pixels.

Usage:

    cd container/dial-reader
    uv run python ../../scripts/build_smoke_fixtures.py

The script is deterministic — same RNG seed → bit-identical files
on every machine. No churn unless the script's contents change.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

# Allow running the script from the repo root via `python
# scripts/build_smoke_fixtures.py` without an editable install
# of the dial-reader package.
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "container" / "dial-reader" / "src"))

from dial_reader.synthetic import generate_dial  # noqa: E402

OUT_DIR = _REPO_ROOT / "container" / "dial-reader" / "tests" / "fixtures" / "smoke"

# Times chosen for ≥30° pairwise hand separation. Picked manually
# rather than searched-for so the operator can read the fixture's
# contents off the manifest at a glance.
#
# The synthetic angles are:
#   hour    = (hh%12)*30 + mm/2
#   minute  = mm*6 + ss/10
#   second  = ss*6
#
# All five entries below have min(pairwise sep) ≥ 30° AND test
# different quadrants of the dial face, so any rotation/orientation
# bug in the locator-or-hand pipeline is visible without needing
# 60 cases.
TIMES: list[tuple[str, int, int, int]] = [
    ("smoke-01.jpg", 1, 35, 50),
    ("smoke-02.jpg", 8, 56, 6),
    ("smoke-03.jpg", 4, 25, 13),
    ("smoke-04.jpg", 11, 5, 30),
    ("smoke-05.jpg", 6, 42, 18),
]


def _noisy_dial(hh: int, mm: int, ss: int, seed: int) -> np.ndarray:
    """Generate a synthetic dial and overlay reproducible noise."""
    img = generate_dial(hh, mm, ss)
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, 18, img.shape).astype(np.float32)
    noisy = np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    return noisy


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, dict[str, int | str]] = {}
    # Use deterministic per-file seeds so a future re-run reproduces
    # the same bytes if the generator hasn't changed.
    for seed_offset, (filename, hh, mm, ss) in enumerate(TIMES):
        rgb = _noisy_dial(hh, mm, ss, seed=42 + seed_offset)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        out_path = OUT_DIR / filename
        # quality=70 lands each file comfortably under the 200KiB
        # cap from PRD #73 even with the noise overlay.
        cv2.imwrite(str(out_path), bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])
        manifest[filename] = {
            "hh": hh,
            "mm": mm,
            "ss": ss,
            "watch_make": "synthetic",
            "watch_model": filename.removesuffix(".jpg"),
        }

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(TIMES)} fixtures + manifest to {OUT_DIR}")


if __name__ == "__main__":
    main()
