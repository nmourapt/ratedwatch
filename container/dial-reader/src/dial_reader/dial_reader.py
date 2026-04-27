"""Top-level dial-reader orchestrator.

Stitches together the CV pipeline:

  1. `image_decoder.decode`  — bytes → RGB ndarray
  2. `dial_locator.locate`   — locate the dial circle
  3. `hand_geometry.detect_hand_contours` + `classify_hands`
                              — detect + classify the 3 hands
  4. `hand_geometry.compute_hand_angles` — sub-pixel-refined
                              clockwise-from-north angles
  5. `time_translator.to_mmss`  — angles → (minute, second)
  6. Hour computation        — (minute, hour-hand-angle) → hour
                              0-11 with cross-hand correction
  7. `confidence_scorer.score`  — composite 0-1 confidence

The orchestrator is the single source of truth for the success
shape returned to the HTTP layer. Each call returns a
`DialReadResult` discriminated union over the three outcomes the
HTTP handler needs to handle:

  - kind=="success"          → 200, ok:true, populated result
  - kind=="rejection"        → 200, ok:false, structured rejection
                              (no_dial_found, unsupported_dial,
                              low_confidence)
  - kind=="malformed_image"  → 400, error:"malformed_image"
  - kind=="unsupported_format" → 200, ok:false, structured
                              rejection (unsupported_format)

This is the layer that hosts the cross-hand corrections. The two
non-trivial ones:

Minute correction
=================
A smooth-sweep minute hand at minute=N rotates an extra
(seconds/60)*6° beyond N*6°. Naively translating the minute-hand
angle via `to_mmss` rounds up at the boundary: e.g. minute=35
seconds=50 puts the minute hand at 215° (= 35*6 + 50/60*6 = 215),
which `to_mmss(215, _)` reports as 36 not 35. We correct by
subtracting `seconds/60` from the minute-hand-derived minute
estimate before rounding. The seconds value comes from the
already-translated second-hand reading.

Hour computation
================
The hour-hand position carries (hours + minutes/60) of rotation
information. Given the minute reading, we can solve back for the
integer hour:
    hour = round((hour_deg / 30 - minute / 60)) % 12
with a tie-break that, if the implied real-valued hour is e.g.
11.95 and the minute is 5 (a 360° wrap), we pick 0 not 11.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from dial_reader.confidence_scorer import ConfidenceSignals, score
from dial_reader.dial_locator import DialCircle, locate
from dial_reader.hand_geometry import (
    HandAngles,
    classify_hands,
    compute_hand_angles,
    detect_hand_contours,
    fit_hand_lines,
)
from dial_reader.image_decoder import (
    MalformedImageError,
    UnsupportedFormatError,
    decode,
)
from dial_reader.time_translator import to_mmss

# ---------------------------------------------------------------
# Result types.
# ---------------------------------------------------------------


@dataclass(frozen=True)
class DisplayedTime:
    """The (h, m, s) the dial is showing. h is in [0, 11]."""

    h: int
    m: int
    s: int


@dataclass(frozen=True)
class DialReadResult:
    """Discriminated union over the orchestrator's outcomes.

    Inspect `kind` first; each kind populates a different subset
    of the optional fields. The HTTP layer consumes this directly
    to produce the JSON response.
    """

    kind: Literal[
        "success",
        "rejection",
        "malformed_image",
        "unsupported_format",
    ]
    displayed_time: DisplayedTime | None = None
    confidence: float = 0.0
    rejection_reason: str | None = None
    rejection_details: str | None = None
    dial_detection: DialCircle | None = None
    hand_angles: HandAngles | None = None
    # Internal sub-signals for observability — surfaced on the
    # log line so the operator can investigate borderline-confident
    # rejections without re-running the pipeline.
    confidence_signals: ConfidenceSignals | None = None


# ---------------------------------------------------------------
# Public threshold + helpers.
# ---------------------------------------------------------------

# Confidence below which the orchestrator rejects with
# `low_confidence` rather than emitting a success. This MUST stay
# in sync with `DIAL_READER_CONFIDENCE_THRESHOLD` in
# `src/domain/reading-verifier/verifier.ts` — but the verifier
# does its own check after parsing the success body, so the
# value below is the container's internal-rejection threshold,
# kept slightly *under* the verifier's value so a borderline
# success isn't double-rejected with two different reasons.
LOW_CONFIDENCE_THRESHOLD: float = 0.7


def _circle_quality_signal(_dial: DialCircle) -> float:
    """Heuristic circle-quality signal in [0, 1].

    The HoughCircles accumulator score isn't surfaced through the
    locator's public API — `dial_locator.locate` returns just the
    `DialCircle`. For now we treat a present `DialCircle` as
    high-quality (1.0); when the locator surfaces accumulator
    scores in a later slice we'll plumb it through here.

    Returning a constant doesn't undermine the scorer because the
    other 4 signals carry enough information to discriminate
    pass/fail; it's effectively a "we got past the locator"
    floor.
    """
    return 1.0


def _classification_consistency_signal(
    hands_thicknesses: tuple[float, float, float],
    hands_lengths: tuple[float, float, float],
) -> float:
    """How well the (hour, minute, second) thickness + length
    ordering matches the canonical 3-hander pattern.

    Canonical:
        hour:   thickest, shortest
        minute: medium-thick, longest (or close to it)
        second: thinnest

    Encoded as a 0-1 score that's 1.0 when the orderings hold
    perfectly and decays as they break.
    """
    h_thick, m_thick, s_thick = hands_thicknesses
    h_len, m_len, s_len = hands_lengths

    score_v = 1.0
    # second hand should be thinnest
    if s_thick > m_thick:
        score_v *= 0.5
    if s_thick > h_thick:
        score_v *= 0.5
    # hour hand should be at least as thick as minute
    if h_thick < m_thick:
        score_v *= 0.5
    # hour hand should be the shortest of the three
    if h_len > m_len:
        score_v *= 0.7
    if h_len > s_len:
        score_v *= 0.7
    return score_v


def _compute_hour_and_consistency(
    hour_deg: float,
    minute: int,
    second: int,
) -> tuple[int, float]:
    """Given the hour-hand angle and the (already corrected) minute
    + second, derive the integer hour 0-11 and a 0-1 consistency
    signal.

    Real-valued hour position implied by the hour hand:
        hour_real = hour_deg / 30  ∈ [0, 12)

    Real-valued hour position implied by the minute reading:
        hour_implied = (minute + second/60) / 60 ∈ [0, 1)

    The hour hand should sit at `H + hour_implied` for integer H.
    We solve:
        H_continuous = hour_real - hour_implied   (mod 12)
        H_int = round(H_continuous) % 12
        error = |H_continuous - H_int|            (mod 12, take min wrap)

    consistency = max(0, 1 - error / 0.25):
        - error 0  → 1.0
        - error 0.25 hour-step → 0
        - linearly between

    The 0.25 ceiling is loose enough to absorb real-watch wear
    (hour hands drift up to ~5 minutes off true position over
    months) while still firing on the obviously-misclassified
    cases (hour and minute swapped, etc.).
    """
    hour_real = hour_deg / 30.0  # in [0, 12)
    hour_implied = (minute + second / 60.0) / 60.0  # in [0, 1)
    h_continuous = (hour_real - hour_implied) % 12.0
    h_int = int(round(h_continuous)) % 12

    # Wrap-aware error: smaller of |delta| and 12 - |delta|.
    raw_error = abs(h_continuous - h_int)
    error = min(raw_error, 12.0 - raw_error)
    consistency = max(0.0, 1.0 - error / 0.25)
    return h_int, consistency


def _compute_minute_with_correction(minute_deg: float, second: int) -> int:
    """Smooth-sweep correction: subtract the partial-minute the
    second hand contributes to the minute-hand position before
    rounding.

    Naive `to_mmss(minute_deg, _)[0]` rounds the minute up when
    the seconds are large enough to push the minute hand past
    the integer-tick boundary. By backing out `second/60` of a
    minute-step from the angle before rounding, we recover the
    true integer minute.
    """
    # Each minute corresponds to 6° of rotation; subtract the
    # partial-minute contribution attributable to the second
    # hand. The (now corrected) angle / 6 is the integer minute.
    corrected_deg = (minute_deg - (second / 60.0) * 6.0) % 360.0
    minute = int(round(corrected_deg / 6.0)) % 60
    return minute


# ---------------------------------------------------------------
# The orchestrator.
# ---------------------------------------------------------------


def read_dial(image_bytes: bytes) -> DialReadResult:
    """Run the full CV pipeline against `image_bytes`.

    Returns a `DialReadResult` whose `kind` field identifies the
    outcome. The HTTP layer consumes the result directly and
    translates it into the appropriate JSON response.
    """
    # ---- Stage 1: decode ---------------------------------------
    try:
        img = decode(image_bytes)
    except UnsupportedFormatError as e:
        return DialReadResult(
            kind="unsupported_format",
            rejection_reason="unsupported_format",
            rejection_details=str(e),
        )
    except MalformedImageError as e:
        return DialReadResult(
            kind="malformed_image",
            rejection_reason="malformed_image",
            rejection_details=str(e),
        )

    # ---- Stage 2: locate dial ----------------------------------
    circle = locate(img)
    if circle is None:
        return DialReadResult(
            kind="rejection",
            rejection_reason="no_dial_found",
            rejection_details=(
                "No watch dial detected. Frame the dial centered and well-lit, then try again."
            ),
        )

    # ---- Stage 3: detect + classify hands ----------------------
    contours = detect_hand_contours(img, circle)
    hands = classify_hands(contours)
    if hands is None:
        return DialReadResult(
            kind="rejection",
            rejection_reason="unsupported_dial",
            rejection_details=(
                f"Detected {len(contours)} hand candidates; expected 3. "
                "This watch type isn't supported by verified-reading yet."
            ),
            dial_detection=circle,
        )

    # ---- Stage 4: compute angles -------------------------------
    angles = compute_hand_angles(hands, circle)
    line_fits = fit_hand_lines(hands, circle)
    line_residuals = (
        line_fits[0].residual_px,
        line_fits[1].residual_px,
        line_fits[2].residual_px,
    )

    # ---- Stage 5: angles → (minute, second) -------------------
    # Compute second first; minute computation needs it for the
    # smooth-sweep correction.
    _, second = to_mmss(0.0, angles.second_deg)
    minute = _compute_minute_with_correction(angles.minute_deg, second)

    # ---- Stage 6: hour ----------------------------------------
    hour, time_consistency = _compute_hour_and_consistency(angles.hour_deg, minute, second)

    # ---- Stage 7: confidence ----------------------------------
    classification = _classification_consistency_signal(
        hands_thicknesses=(hands.hour.width_px, hands.minute.width_px, hands.second.width_px),
        hands_lengths=(hands.hour.length_px, hands.minute.length_px, hands.second.length_px),
    )
    signals = ConfidenceSignals(
        circle_quality=_circle_quality_signal(circle),
        hand_count=3,
        classification_consistency=classification,
        line_residuals=line_residuals,
        time_consistency=time_consistency,
    )
    confidence = score(signals)

    # ---- Stage 8: low-confidence gate -------------------------
    if confidence < LOW_CONFIDENCE_THRESHOLD:
        return DialReadResult(
            kind="rejection",
            rejection_reason="low_confidence",
            rejection_details=(
                f"Dial reading confidence {confidence:.2f} below threshold "
                f"{LOW_CONFIDENCE_THRESHOLD:.2f}. The dial may be obscured, "
                "blurry, or the hands misaligned with the time markers."
            ),
            dial_detection=circle,
            hand_angles=angles,
            confidence=confidence,
            confidence_signals=signals,
        )

    return DialReadResult(
        kind="success",
        displayed_time=DisplayedTime(h=hour, m=minute, s=second),
        confidence=confidence,
        dial_detection=circle,
        hand_angles=angles,
        confidence_signals=signals,
    )
