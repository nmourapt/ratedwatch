"""FastAPI HTTP surface for the dial-reader service.

Slice #77 plugs the dial locator (HoughCircles + filtering) into
the post-decode flow. After bytes successfully decode into an RGB
ndarray, the locator is run; if no plausible dial circle is found
the endpoint returns a structured `no_dial_found` rejection. When a
dial IS found, the success-shape is returned with the *real*
`dial_detection` block reflecting the located circle. The
`displayed_time`, `confidence`, and `hand_angles_deg` fields are
still hardcoded zero values — those land in slice #78 (hand
geometry) and slice #80 (confidence scoring).

Four response shapes the Worker-side adapter has to handle:

  - 200 + ok:true + result:{...}     decode + dial-locate succeeded
  - 200 + ok:false + rejection:{...} structured rejection
                                     (unsupported_format from #76;
                                     no_dial_found new in #77;
                                     low_confidence etc. in later
                                     slices)
  - 400 + error:"malformed_image"    bytes were unreadable —
                                     transport-style failure

The success vs rejection vs error split mirrors the
`DialReadResult` discriminated union in
`src/domain/dial-reader/adapter.ts`. Both sides live in the same
repo so contract drift is caught in a single PR review.

Slice #83 of PRD #73 layered observability on top:

  - Sentry SDK is initialised at module load via `sentry_init.init`,
    reading SENTRY_DSN from the env. Missing DSN is a no-op (local
    dev, pytest, freshly provisioned previews).
  - Each call to `/v1/read-dial` emits a single structured JSON log
    line on stdout. Cloudflare's container observability integration
    forwards stdout/stderr to Workers Logs, where the operator can
    query success rate / rejection breakdown / latency from the
    same place as the Worker's events.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from typing import Any, Final

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from dial_reader import sentry_init
from dial_reader.dial_locator import locate
from dial_reader.image_decoder import (
    MalformedImageError,
    UnsupportedFormatError,
    decode,
)

# Bumped when the response shape or behaviour changes in a way
# operators need to see. Slice #74 was `v0.0.1-scaffolding`,
# slice #76 was `v0.1.0-decode`; this slice plugs the dial locator
# into the post-decode flow.
_VERSION: Final[str] = "v0.2.0-dial-locator"

# Initialise Sentry once at module load. The init is idempotent and
# becomes a no-op when SENTRY_DSN is unset, so this is safe in tests
# and local docker runs.
sentry_init.init(os.environ.get("SENTRY_DSN"))


# ---- Structured request logging --------------------------------
#
# Cloudflare's container observability integration forwards
# stdout/stderr from the container into Workers Logs. We emit one
# JSON object per request rather than free-form text so the operator
# can SQL-query the lines (success rate / latency / rejection
# breakdown / version distribution) without parser pain.
#
# The schema is documented per-callsite of `_log_request` below;
# every call carries `event`, `dial_reader_version`, and
# `processing_ms`, plus the call-specific fields.


class _JsonFormatter(logging.Formatter):
    """A logging.Formatter that emits one JSON object per record.

    Used for the per-request access log on the dial-reader service.
    The fields the operator queries against are placed at the top
    level (event, reading_id, processing_ms, confidence, …); free-
    form context goes into the standard `message` slot only when no
    structured fields are present, which keeps line size predictable.
    """

    def format(self, record: logging.LogRecord) -> str:
        if isinstance(record.msg, dict):
            payload: dict[str, Any] = dict(record.msg)
        else:
            payload = {"message": record.getMessage()}
        payload.setdefault("level", record.levelname.lower())
        return json.dumps(payload, separators=(",", ":"))


# Wire the formatter onto a single logger we own. We deliberately do
# NOT touch the root logger configuration — uvicorn / FastAPI / any
# third-party noise should keep its existing format. Only our
# own per-request log line goes through `_request_logger`.
_request_logger = logging.getLogger("dial_reader.requests")
_request_logger.setLevel(logging.INFO)
# Avoid duplicate handlers when a hot-reload or pytest collection
# re-imports the module.
if not _request_logger.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(_JsonFormatter())
    _request_logger.addHandler(_handler)
# Don't propagate to root — that would re-emit the line through
# whatever default formatter the root logger has, doubling the
# log volume.
_request_logger.propagate = False


def _log_request(payload: dict[str, Any]) -> None:
    """Emit one per-request JSON log line.

    Keeping this in a helper means every callsite agrees on the
    shape and the JSON encoder is pinned in a single place.
    """
    _request_logger.info(payload)


# Hardcoded zeros for fields the CV pipeline hasn't implemented
# yet. Slice #78 fills `displayed_time`, `hand_angles_deg`, and
# `confidence` with real values. Keeping these as named constants
# at module scope makes them trivially auditable in a code review.
_HARDCODED_DISPLAYED_TIME: Final[dict[str, int]] = {"h": 12, "m": 0, "s": 0}
_HARDCODED_HAND_ANGLES_DEG: Final[dict[str, float]] = {
    "hour": 0.0,
    "minute": 0.0,
    "second": 0.0,
}
_HARDCODED_CONFIDENCE: Final[float] = 0.0
_HARDCODED_PROCESSING_MS: Final[int] = 0


app = FastAPI(
    title="rated.watch dial-reader",
    version=_VERSION,
    # /docs and /redoc are useful for operator probing during early
    # iterations and have no auth surface to leak (the container is
    # only reachable from inside the Worker over the DO binding, not
    # from the public internet). They're cheap; keep them on.
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe.

    Cloudflare Containers does its own readiness check via
    `pingEndpoint` on the Container class, but a plain liveness URL
    is useful for `docker run` smoke-testing during local dev and
    for any future operator-side probes.
    """
    return {"status": "ok", "version": _VERSION}


@app.post("/v1/read-dial")
async def read_dial(request: Request) -> JSONResponse:
    """Read the time displayed by a watch in the request body.

    The body is the raw image bytes (any of JPEG, PNG, WebP, HEIC).
    Format detection is done on the bytes themselves — we never
    trust the `Content-Type` header.

    Slice #77 (dial locator): after a successful decode, runs
    `dial_locator.locate()` to find the dial circle. If no plausible
    dial is found we return a structured `no_dial_found` rejection;
    if found, the success shape is returned with the real
    `dial_detection` geometry. Hand-geometry, real time, and real
    confidence land in subsequent slices.

    Slice #83 (observability): every code path emits a single
    structured JSON log line via `_log_request` so Workers Logs
    sees one row per attempt with `event`, `processing_ms`, and
    the relevant outcome fields (incl. `dial_radius_px` on the
    success path so the operator can spot-check locator output
    distribution without re-querying the response body).
    """
    # Caller correlation. The Worker stamps reading_id on the
    # request via the `x-reading-id` header (slice #83); when absent
    # we substitute None and the operator-side join skips the row.
    # We don't fail the request when the header is missing — the
    # container must stay tolerant of older Worker callers.
    reading_id: str | None = request.headers.get("x-reading-id")

    start_ns = time.perf_counter_ns()
    image_bytes = await request.body()
    image_size = len(image_bytes)

    try:
        img = decode(image_bytes)
    except UnsupportedFormatError as e:
        # Recognised-but-rejected format. The Worker-side adapter
        # turns this into a `DialReadResult` of kind `rejection`,
        # which the verifier surfaces as a polite "this format
        # isn't supported yet" message.
        elapsed_ms = (time.perf_counter_ns() - start_ns) // 1_000_000
        _log_request(
            {
                "event": "read_dial",
                "reading_id": reading_id,
                "dial_reader_version": _VERSION,
                "processing_ms": elapsed_ms,
                "image_bytes": image_size,
                "outcome": "rejection",
                "rejection_reason": "unsupported_format",
            }
        )
        return JSONResponse(
            status_code=200,
            content={
                "version": _VERSION,
                "ok": False,
                "rejection": {
                    "reason": "unsupported_format",
                    "details": str(e),
                },
            },
        )
    except MalformedImageError as e:
        # Bytes are corrupt or empty. A retry with the same bytes
        # cannot succeed, so we surface this as a 400 rather than
        # a structured rejection.
        elapsed_ms = (time.perf_counter_ns() - start_ns) // 1_000_000
        _log_request(
            {
                "event": "read_dial",
                "reading_id": reading_id,
                "dial_reader_version": _VERSION,
                "processing_ms": elapsed_ms,
                "image_bytes": image_size,
                "outcome": "malformed_image",
                "rejection_reason": "malformed_image",
            }
        )
        return JSONResponse(
            status_code=400,
            content={
                "version": _VERSION,
                "error": "malformed_image",
                "details": str(e),
            },
        )

    # Image decoded into an RGB ndarray. Run the dial locator.
    circle = locate(img)
    if circle is None:
        # No plausible dial circle. Surface as a structured
        # rejection so the SPA can show "we couldn't find a watch
        # dial in this photo — make sure the dial is centered and
        # well-lit" with only a "Retake" button (no manual
        # fallback — the user needs to retry).
        elapsed_ms = (time.perf_counter_ns() - start_ns) // 1_000_000
        _log_request(
            {
                "event": "read_dial",
                "reading_id": reading_id,
                "dial_reader_version": _VERSION,
                "processing_ms": elapsed_ms,
                "image_bytes": image_size,
                "outcome": "rejection",
                "rejection_reason": "no_dial_found",
            }
        )
        return JSONResponse(
            status_code=200,
            content={
                "version": _VERSION,
                "ok": False,
                "rejection": {
                    "reason": "no_dial_found",
                    "details": (
                        "No watch dial detected. Frame the dial centered "
                        "and well-lit, then try again."
                    ),
                },
            },
        )

    # Dial located. Return the success shape with the real
    # detection geometry; the rest of `result` stays zeroed
    # until later slices implement hand geometry + confidence.
    elapsed_ms = (time.perf_counter_ns() - start_ns) // 1_000_000
    _log_request(
        {
            "event": "read_dial",
            "reading_id": reading_id,
            "dial_reader_version": _VERSION,
            "processing_ms": elapsed_ms,
            "image_bytes": image_size,
            "outcome": "success",
            "confidence": _HARDCODED_CONFIDENCE,
            # Slice #77 added real geometry — surface the located
            # radius on the log line so the operator can spot-check
            # detection-size distribution from Workers Logs without
            # re-querying the response body.
            "dial_radius_px": circle.radius_px,
        }
    )
    success_body: dict[str, Any] = {
        "version": _VERSION,
        "ok": True,
        "result": {
            "displayed_time": _HARDCODED_DISPLAYED_TIME,
            "confidence": _HARDCODED_CONFIDENCE,
            "dial_detection": {
                "center_xy": [circle.center_xy[0], circle.center_xy[1]],
                "radius_px": circle.radius_px,
            },
            "hand_angles_deg": _HARDCODED_HAND_ANGLES_DEG,
            "processing_ms": _HARDCODED_PROCESSING_MS,
        },
    }
    return JSONResponse(status_code=200, content=success_body)
