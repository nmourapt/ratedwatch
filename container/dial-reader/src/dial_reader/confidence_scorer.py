"""Composite confidence score from CV sub-signals.

The verifier (`src/domain/reading-verifier/verifier.ts`) gates a
verified-reading attempt on `confidence >= 0.7`. The scorer here
collapses 5 sub-signals from the pipeline into that single value:

  - `circle_quality`            HoughCircles fit quality, 0-1 from
                                the locator stage.
  - `hand_count`                ideally 3; anything else is an
                                upstream rejection signal but
                                we encode it here so the scorer
                                is also internally consistent.
  - `classification_consistency`  0-1, comes from `hand_geometry`
                                heuristic — agreement of length
                                + width ratios with canonical
                                3-hand geometry.
  - `line_residuals`            (h, m, s) RMS perpendicular
                                distances from each hand's PCA
                                line fit. Smaller = the hand
                                was line-shaped (good); a noisy
                                detection produces a fat blob
                                with large residual.
  - `time_consistency`          0-1, agreement of hour-hand
                                position with minute-hand
                                position. At minute=56 the hour
                                hand should be at h+0.93. A
                                mismatch > 0.15 hour-step triggers
                                a multiplicative penalty (× 0.3
                                on the final score) — this is the
                                strongest CV-readability sanity
                                check, since it catches dials
                                where the hand classifier
                                mislabelled hour vs minute.

Weights
=======
Picked so the dominant signal is time_consistency (the readability
sanity check) but the other 4 cumulatively provide enough lift
that a clean detection always lands above the 0.7 threshold:

    circle_quality:           0.15
    hand_count == 3:          0.15
    classification_consistency: 0.20
    line_residuals (averaged):  0.20
    time_consistency:         0.30
                              ----
                              1.00

The weights are tunable via the public dataclass constants below;
do NOT change them in tests via monkeypatch — the test grid
parameter values assume the published weights.

Penalty
=======
When `time_consistency < 0.4` (i.e. the hour/minute mismatch is
> 0.15 hour-step), multiply the final score by 0.3. This is more
aggressive than a continuous gradient because the failure mode
is binary: either the hour-hand is plausibly placed for the
minute reading (the pipeline read the dial correctly) or it
isn't (something is off, and we should refuse to publish the
reading rather than report it with a moderate confidence).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

# Public, immutable weights. Operators reading the code can
# verify exactly what each component contributes to the final
# score by reading these constants. Sum to 1.0 by construction
# so a perfect-signal input produces a 1.0 score.
_W_CIRCLE_QUALITY: Final[float] = 0.15
_W_HAND_COUNT: Final[float] = 0.15
_W_CLASSIFICATION: Final[float] = 0.20
_W_LINE_RESIDUAL: Final[float] = 0.20
_W_TIME_CONSISTENCY: Final[float] = 0.30

# Time-consistency penalty. When the time_consistency signal
# falls below this threshold, multiply the final score by
# `_TIME_CONSISTENCY_PENALTY`. 0.4 maps to a 0.15 hour-step
# error using the linear `1 - error/0.25` mapping in
# `dial_reader.compute_time_consistency`.
_TIME_CONSISTENCY_PENALTY_THRESHOLD: Final[float] = 0.4
_TIME_CONSISTENCY_PENALTY: Final[float] = 0.3

# Pixel scale for the line-residual normalisation. A perfect
# straight line gives residual 0; we map residual `r` to signal
# `1 - clamp(r / _RESIDUAL_FULL_SCALE_PX, 0, 1)`. 10 pixels of
# RMS deviation effectively zeroes out the signal — that's a
# very fat blob, well past anything the synthetic generator
# produces (residuals on synthetic dials are < 1 px).
_RESIDUAL_FULL_SCALE_PX: Final[float] = 10.0


@dataclass(frozen=True)
class ConfidenceSignals:
    """The 5 sub-signals fed into `score`.

    Attributes:
        circle_quality: 0-1. From the locator. Today derived from
            `interior_std_ratio` in `dial_locator`; clamped at the
            scorer boundary.
        hand_count: integer count of hands the detector returned.
            3 is the ideal; anything else gets a heavy penalty.
        classification_consistency: 0-1. Agreement of the hour /
            minute / second contour geometry with canonical
            ratios (thinnest = second, widest = hour, etc.).
        line_residuals: (hour, minute, second) RMS perpendicular
            pixel distances from the per-hand PCA line fit. The
            scorer takes the mean of the three.
        time_consistency: 0-1. Cross-check between the hour-hand
            position and the minute-hand position; see the
            module docstring.
    """

    circle_quality: float
    hand_count: int
    classification_consistency: float
    line_residuals: tuple[float, float, float]
    time_consistency: float


def _clamp01(x: float) -> float:
    """Clamp `x` into [0, 1]. Defensive against caller signals that
    happen to fall outside the contract; the scorer should NEVER
    produce a final value outside [0, 1] regardless of inputs."""
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


def _residual_signal(residuals: tuple[float, float, float]) -> float:
    """Map per-hand RMS residuals → a single 0-1 signal.

    For each residual, signal = 1 - clamp(r / FULL_SCALE, 0, 1).
    Take the unweighted average across the 3 hands. Negative
    residuals are clamped to 0 (residual is by definition
    non-negative; defensive).
    """
    parts = []
    for r in residuals:
        if r < 0.0:
            r = 0.0
        # `r / scale` clamped at 1, inverted to give "1 = no error".
        contribution = 1.0 - min(1.0, r / _RESIDUAL_FULL_SCALE_PX)
        parts.append(contribution)
    if not parts:
        return 0.0
    return sum(parts) / len(parts)


def score(signals: ConfidenceSignals) -> float:
    """Composite 0-1 confidence score from the 5 sub-signals.

    See module docstring for the weighting + penalty rationale.
    Output is always in [0, 1]; defensive clamping is applied on
    every sub-signal.
    """
    circle = _clamp01(signals.circle_quality)
    classification = _clamp01(signals.classification_consistency)
    time_ok = _clamp01(signals.time_consistency)
    residual = _residual_signal(signals.line_residuals)
    hand = 1.0 if signals.hand_count == 3 else 0.0

    raw = (
        _W_CIRCLE_QUALITY * circle
        + _W_HAND_COUNT * hand
        + _W_CLASSIFICATION * classification
        + _W_LINE_RESIDUAL * residual
        + _W_TIME_CONSISTENCY * time_ok
    )

    if signals.time_consistency < _TIME_CONSISTENCY_PENALTY_THRESHOLD:
        raw *= _TIME_CONSISTENCY_PENALTY

    return _clamp01(raw)
