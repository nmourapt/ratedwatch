"""FastAPI HTTP surface for the dial-reader service.

Slice #77 plugs the dial locator (HoughCircles + filtering) into
the post-decode flow. After bytes successfully decode into an RGB
ndarray, the locator is run; if no plausible dial circle is found
the endpoint returns a structured `no_dial_found` rejection.

Slice #78 plugs in `hand_geometry.detect_hand_contours` +
`classify_hands` after the locator. When the classifier returns
`None` (≠ 3 hands detected, indicating a chronograph / GMT /
2-hand / partial detection) the endpoint returns a structured
`unsupported_dial` rejection so the SPA can show "this watch
type isn't supported by verified-reading yet — please log
manually" with the appropriate fallback button. Slice #79 layers
real angle math + time translation on top; until then the
success branch keeps emitting the hardcoded `displayed_time` and
`confidence` so the contract stays stable.

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
from dial_reader.dial_reader import read_dial

# Bumped when the response shape or behaviour changes in a way
# operators need to see. Slice #74 was `v0.0.1-scaffolding`,
# slice #76 was `v0.1.0-decode`, slice #77 was `v0.2.0-dial-locator`,
# slice #78 was `v0.3.0-hand-classification`; this slice (`#79`)
# plugs in real angle math, time translation, and composite
# confidence scoring → first end-to-end CV-correct dial reader.
_VERSION: Final[str] = "v1.0.0"

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
async def read_dial_endpoint(request: Request) -> JSONResponse:
    """Read the time displayed by a watch in the request body.

    The body is the raw image bytes (any of JPEG, PNG, WebP, HEIC).
    Format detection is done on the bytes themselves — we never
    trust the `Content-Type` header.

    Slice #79 (this slice) plugs in the full CV pipeline via
    `dial_reader.read_dial`: decode → locate → segment → classify
    → angles → translate → score. The handler is now a thin
    translation layer between `DialReadResult` and the JSON wire
    format; all CV decisions live in `dial_reader.read_dial`.

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

    result = read_dial(image_bytes)
    elapsed_ms = (time.perf_counter_ns() - start_ns) // 1_000_000

    # ---- Branch on the discriminated union --------------------
    if result.kind == "unsupported_format":
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
                    "details": result.rejection_details or "",
                },
            },
        )

    if result.kind == "malformed_image":
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
                "details": result.rejection_details or "",
            },
        )

    if result.kind == "rejection":
        log_payload: dict[str, Any] = {
            "event": "read_dial",
            "reading_id": reading_id,
            "dial_reader_version": _VERSION,
            "processing_ms": elapsed_ms,
            "image_bytes": image_size,
            "outcome": "rejection",
            "rejection_reason": result.rejection_reason,
        }
        if result.dial_detection is not None:
            log_payload["dial_radius_px"] = result.dial_detection.radius_px
        if result.confidence:
            log_payload["confidence"] = result.confidence
        _log_request(log_payload)
        return JSONResponse(
            status_code=200,
            content={
                "version": _VERSION,
                "ok": False,
                "rejection": {
                    "reason": result.rejection_reason or "rejection",
                    "details": result.rejection_details or "",
                },
            },
        )

    # ---- Success ------------------------------------------------
    assert result.kind == "success", f"unexpected kind {result.kind}"
    assert result.displayed_time is not None
    assert result.dial_detection is not None
    assert result.hand_angles is not None

    _log_request(
        {
            "event": "read_dial",
            "reading_id": reading_id,
            "dial_reader_version": _VERSION,
            "processing_ms": elapsed_ms,
            "image_bytes": image_size,
            "outcome": "success",
            "confidence": result.confidence,
            "dial_radius_px": result.dial_detection.radius_px,
        }
    )
    success_body: dict[str, Any] = {
        "version": _VERSION,
        "ok": True,
        "result": {
            "displayed_time": {
                "h": result.displayed_time.h,
                "m": result.displayed_time.m,
                "s": result.displayed_time.s,
            },
            "confidence": result.confidence,
            "dial_detection": {
                "center_xy": [
                    result.dial_detection.center_xy[0],
                    result.dial_detection.center_xy[1],
                ],
                "radius_px": result.dial_detection.radius_px,
            },
            "hand_angles_deg": {
                "hour": result.hand_angles.hour_deg,
                "minute": result.hand_angles.minute_deg,
                "second": result.hand_angles.second_deg,
            },
            "processing_ms": elapsed_ms,
        },
    }
    return JSONResponse(status_code=200, content=success_body)
