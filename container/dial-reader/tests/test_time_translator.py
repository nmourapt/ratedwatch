"""Tests for `time_translator` — pure angle → (mm, ss) math.

The function is deliberately stateless and dependency-free so the
boundary cases below are exhaustive: at angles 0°/90°/180°/270°
(the cardinal positions) the output must be exactly the
corresponding 0/15/30/45 reading; near 360° we exercise the wrap
behaviour explicitly so a future change to floor-vs-round can't
silently flip the corpus accuracy.

Rationale for round-to-nearest with wrap-to-0
=============================================
A second hand visually at 359.5° is, to a human eye, "right at the
top of the dial" — i.e. effectively pointing at 12. Floor rounding
would surface that as 59 (one tick before the top); round-to-nearest
correctly surfaces it as 0 (the top itself). The tradeoff is that a
hand at 358.8° (which is 59.8 seconds, perceptually closer to 60
than to 59 by 0.2s) also surfaces as 0 — which is consistent with
the rounding rule and only ever introduces sub-second error at the
boundary. We document this explicitly via `test_to_mmss_just_below_360`.
"""

from __future__ import annotations

import pytest

from dial_reader.time_translator import to_mmss


def test_to_mmss_at_0_returns_0_0() -> None:
    """0° (12 o'clock, the top) → 0 minutes / 0 seconds."""
    assert to_mmss(0.0, 0.0) == (0, 0)


def test_to_mmss_at_90_returns_15_15() -> None:
    """90° (3 o'clock) → 15 minutes / 15 seconds. Each unit on the
    dial is 6°, so 90° = 15 ticks."""
    assert to_mmss(90.0, 90.0) == (15, 15)


def test_to_mmss_at_180_returns_30_30() -> None:
    """180° (6 o'clock) → 30 minutes / 30 seconds."""
    assert to_mmss(180.0, 180.0) == (30, 30)


def test_to_mmss_at_270_returns_45_45() -> None:
    """270° (9 o'clock) → 45 minutes / 45 seconds."""
    assert to_mmss(270.0, 270.0) == (45, 45)


def test_to_mmss_at_just_below_360_wraps_to_0() -> None:
    """358.8° is 59.8 ticks; round-to-nearest gives 60, which wraps
    via `% 60` to 0. This is the documented boundary behaviour
    (see module docstring) — round-to-nearest, not floor."""
    assert to_mmss(358.8, 358.8) == (0, 0)


def test_to_mmss_at_356_4_returns_59_59() -> None:
    """356.4° is exactly 59.4 ticks; round-to-nearest gives 59. This
    is the smallest integer-tick value that does NOT wrap to 0."""
    assert to_mmss(356.4, 356.4) == (59, 59)


def test_to_mmss_independent_axes() -> None:
    """The minute and second outputs are computed independently —
    the second hand at 12 o'clock and the minute hand at 6 o'clock
    must produce (30, 0)."""
    assert to_mmss(180.0, 0.0) == (30, 0)
    assert to_mmss(0.0, 180.0) == (0, 30)


def test_to_mmss_at_30_returns_5_5() -> None:
    """One hour position (30°) is 5 ticks → 5 minutes / 5 seconds."""
    assert to_mmss(30.0, 30.0) == (5, 5)


def test_to_mmss_at_6_returns_1_1() -> None:
    """One tick (6°) → 1 minute / 1 second. The smallest unit."""
    assert to_mmss(6.0, 6.0) == (1, 1)


def test_to_mmss_handles_negative_angle_via_mod() -> None:
    """Defensive: angles outside [0, 360) get normalised. -6° is the
    same as 354° → 59 ticks."""
    assert to_mmss(-6.0, -6.0) == (59, 59)


def test_to_mmss_handles_angle_above_360_via_mod() -> None:
    """Defensive: 366° is the same as 6° → 1 tick."""
    assert to_mmss(366.0, 366.0) == (1, 1)


@pytest.mark.parametrize("ss", list(range(60)))
def test_to_mmss_round_trip_for_every_integer_second(ss: int) -> None:
    """For every integer second in [0, 60), feeding `ss * 6.0` back
    through `to_mmss` returns ss for both axes. Exhaustive guard
    against accumulator drift in the rounding path."""
    angle = ss * 6.0
    assert to_mmss(angle, angle) == (ss, ss)
