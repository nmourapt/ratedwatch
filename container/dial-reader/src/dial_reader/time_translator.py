"""Pure angle → (mm, ss) translation.

Given the minute-hand and second-hand angles measured clockwise
from north (12 o'clock), produce the displayed minute and second
on the dial face. Each unit (1 minute, 1 second) corresponds to
exactly 6° of rotation, so the math is dead simple — the only
thing this module pins down is the rounding rule and the wrap
behaviour at the 360° boundary.

Rounding rule
=============
Round-to-nearest, then `% 60`. A second hand visually at 359.5°
is one tick short of the top; humans naturally read that as "0",
not "59". Round-to-nearest captures that intuition. The tradeoff
is that 358.8° (= 59.8 ticks) also rounds up to 60 and wraps to
0; this only ever introduces sub-second error at the boundary,
which is well within the slice's ±2s tolerance.

Floor would have been the cheap alternative but produces a
±1s error every time the hand sits between integer ticks, which
is most of the time on a smooth-sweep movement. Round-to-nearest
keeps the error symmetric.

This module has zero external dependencies on purpose: the unit
tests in `tests/test_time_translator.py` exhaustively cover the
60 second-tick positions plus the cardinal boundaries, and we
want this function to be the cheapest possible thing to verify.
"""

from __future__ import annotations


def to_mmss(minute_deg: float, second_deg: float) -> tuple[int, int]:
    """Translate hand angles in [0, 360) to (minute, second) in [0, 59].

    Args:
        minute_deg: Minute-hand angle clockwise from north (12 o'clock).
            Values outside [0, 360) are normalised via `% 360.0`.
        second_deg: Second-hand angle clockwise from north (12 o'clock).
            Values outside [0, 360) are normalised via `% 360.0`.

    Returns:
        A `(minute, second)` tuple where each component is an integer
        in [0, 59]. Angles near 360° round up to 60 and then wrap to 0
        via the trailing `% 60`.

    The function is total — every float input produces a valid output.
    NaN handling is not specified because the upstream pipeline
    (`hand_geometry.compute_hand_angles`) cannot produce NaN: the
    hand-tip is by construction at finite pixel coordinates relative
    to the dial center, so `atan2(dx, -dy)` is always finite.
    """
    minute_norm = minute_deg % 360.0
    second_norm = second_deg % 360.0
    minute = int(round(minute_norm / 6.0)) % 60
    second = int(round(second_norm / 6.0)) % 60
    return (minute, second)
