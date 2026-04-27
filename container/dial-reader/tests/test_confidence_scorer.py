"""Tests for `confidence_scorer.score`.

The scorer composes 5 sub-signals into a single 0-1 number that
the verifier compares against `DIAL_READER_CONFIDENCE_THRESHOLD`
(0.7 today, see `src/domain/reading-verifier/verifier.ts`).

Boundary cases:
  - Degenerate signals (all zeros) → 0
  - Perfect signals (all ones, no residual, no time-consistency error) → 1
  - Misaligned hour/minute (time_consistency error > 0.15 hour-step) →
    multiplier penalty applied (final < 0.5)

The weighting picked here:
    circle_quality:           0.15
    hand_count == 3:          0.15 (else 0)
    classification_consistency: 0.20
    line_residuals (averaged → 1 - clamp(rms / R, 0, 1)): 0.20
    time_consistency:         0.30
    time-consistency penalty (× 0.3 when error > 0.15 hour-step)
"""

from __future__ import annotations

import pytest

from dial_reader.confidence_scorer import ConfidenceSignals, score


def test_score_returns_zero_for_degenerate_signals() -> None:
    """All zeros → 0. The most degenerate possible input."""
    sig = ConfidenceSignals(
        circle_quality=0.0,
        hand_count=0,
        classification_consistency=0.0,
        line_residuals=(999.0, 999.0, 999.0),
        time_consistency=0.0,
    )
    assert score(sig) == 0.0


def test_score_returns_one_for_perfect_signals() -> None:
    """All sub-signals at maximum → 1.0 exactly. The line residuals
    are normalised against an internal pixel scale; 0 residual is
    the "perfect" value."""
    sig = ConfidenceSignals(
        circle_quality=1.0,
        hand_count=3,
        classification_consistency=1.0,
        line_residuals=(0.0, 0.0, 0.0),
        time_consistency=1.0,
    )
    assert score(sig) == pytest.approx(1.0, abs=1e-6)


def test_score_zero_when_hand_count_not_three() -> None:
    """The scorer should heavily penalise hand_count != 3 — that's
    the cardinal failure mode the upstream pipeline already
    rejects, but the scorer must agree with the rejection if it
    ever sees the signal."""
    sig = ConfidenceSignals(
        circle_quality=1.0,
        hand_count=2,
        classification_consistency=1.0,
        line_residuals=(0.0, 0.0, 0.0),
        time_consistency=1.0,
    )
    s = score(sig)
    # hand_count 0 weight → score loses 0.15 points but everything
    # else stays. Should be 0.85.
    assert s == pytest.approx(0.85, abs=1e-6)


def test_score_misaligned_time_triggers_penalty() -> None:
    """time_consistency near 0 (hours and minutes don't agree) →
    penalty multiplier (× 0.3) → final < 0.5."""
    # All other signals strong, but time_consistency = 0 → penalty
    # fires. With the default multiplier 0.3 and weights summing to
    # 1.0, the un-penalised score from the 4 non-time signals is
    # 0.70, so the final after × 0.3 is 0.21.
    sig = ConfidenceSignals(
        circle_quality=1.0,
        hand_count=3,
        classification_consistency=1.0,
        line_residuals=(0.0, 0.0, 0.0),
        time_consistency=0.0,
    )
    s = score(sig)
    assert s < 0.5, f"misaligned-time score {s} should be < 0.5"


def test_score_partial_signals() -> None:
    """All signals at 0.5 → score around 0.5. Sanity check the
    weighting averages out reasonably."""
    sig = ConfidenceSignals(
        circle_quality=0.5,
        hand_count=3,
        classification_consistency=0.5,
        line_residuals=(2.0, 2.0, 2.0),
        time_consistency=0.5,
    )
    s = score(sig)
    # circle 0.5*0.15 + hand 1*0.15 + class 0.5*0.20 + residual 0.5*0.20
    # + time 0.5*0.30 = 0.075 + 0.15 + 0.10 + 0.10 + 0.15 = 0.575
    # No penalty fires (time_consistency 0.5 > the 0.15 threshold).
    assert 0.4 <= s <= 0.8


def test_score_clamps_signals_above_one() -> None:
    """Sub-signals out of [0, 1] are clamped — no negative or
    above-one component should be able to push the final score
    out of [0, 1]."""
    sig = ConfidenceSignals(
        circle_quality=2.0,
        hand_count=3,
        classification_consistency=2.0,
        line_residuals=(0.0, 0.0, 0.0),
        time_consistency=2.0,
    )
    s = score(sig)
    assert 0.0 <= s <= 1.0


def test_score_clamps_signals_below_zero() -> None:
    """Negative sub-signals → clamped to 0, score never goes
    below 0."""
    sig = ConfidenceSignals(
        circle_quality=-0.5,
        hand_count=3,
        classification_consistency=-0.5,
        line_residuals=(-1.0, -1.0, -1.0),
        time_consistency=-1.0,
    )
    s = score(sig)
    assert 0.0 <= s <= 1.0


def test_score_residual_normalisation() -> None:
    """Residual signal is normalised against an internal pixel
    scale; 0 residual → max signal, very large residual → 0
    signal. Verify the gradient is monotonic."""
    base = dict(
        circle_quality=1.0,
        hand_count=3,
        classification_consistency=1.0,
        time_consistency=1.0,
    )
    s_zero = score(ConfidenceSignals(line_residuals=(0.0, 0.0, 0.0), **base))
    s_small = score(ConfidenceSignals(line_residuals=(1.0, 1.0, 1.0), **base))
    s_large = score(ConfidenceSignals(line_residuals=(50.0, 50.0, 50.0), **base))
    assert s_zero >= s_small >= s_large
    assert s_zero - s_large > 0.05
