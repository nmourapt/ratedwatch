"""FastAPI HTTP surface for the dial-reader service.

Slice #76 wires real image decoding into `POST /v1/read-dial`.
The endpoint now actually parses the request body, validates the
format, and rejects malformed or unsupported inputs — but on a
successful decode it still returns the same hardcoded "successful
reading" introduced by the slice #74 scaffolding. Real CV
(HoughCircles dial detection, hand-angle parsing, calibrated
confidence) lands in subsequent slices.

Three response shapes the Worker-side adapter has to handle:

  - 200 + ok:true + result:{...}     successful read
  - 200 + ok:false + rejection:{...} structured rejection
                                     (unsupported format today;
                                     low confidence, no dial,
                                     etc. in future slices)
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
from dial_reader.image_decoder import (
    MalformedImageError,
    UnsupportedFormatError,
    decode,
)

# Bumped when the response shape or behaviour changes in a way
# operators need to see. Slice #74 was `v0.0.1-scaffolding`; this
# slice flips real decode on while keeping the success shape.
_VERSION: Final[str] = "v0.1.0-decode"

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


# The complete success response. Defined at module level so it
# round-trips through json (Python dict -> FastAPI response -> client
# .json()) byte-for-byte equal to the contract test, and so the
# constant stays trivially auditable in a code review.
#
# The values are still the slice #74 scaffolding values: the CV
# pipeline isn't implemented yet, so confidence is 0.0 and the
# fields a verifier would consume are zeroed. Slice #77+ replaces
# these with real numbers without changing the keys.
_SCAFFOLDING_SUCCESS_RESPONSE: Final[dict[str, Any]] = {
    "version": _VERSION,
    "ok": True,
    "result": {
        "displayed_time": {"h": 12, "m": 0, "s": 0},
        "confidence": 0.0,
        "dial_detection": {"center_xy": [0, 0], "radius_px": 0},
        "hand_angles_deg": {"hour": 0, "minute": 0, "second": 0},
        "processing_ms": 0,
    },
}


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

    Slice #76 (decode): runs `image_decoder.decode()` over the body
    and translates its outcomes into the documented response shapes.
    On a successful decode the hardcoded scaffolding reading is
    still returned; real CV lands in slice #77+.

    Slice #83 (observability): every code path emits a single
    structured JSON log line via `_log_request` so Workers Logs
    sees one row per attempt with `event`, `processing_ms`, and
    the relevant outcome fields.
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
        decode(image_bytes)
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

    # On a successful decode the CV pipeline isn't implemented yet,
    # so we still return the scaffolding response. Returning the
    # decoded ndarray would burn bandwidth without producing any
    # meaningful caller-side behaviour.
    elapsed_ms = (time.perf_counter_ns() - start_ns) // 1_000_000
    _log_request(
        {
            "event": "read_dial",
            "reading_id": reading_id,
            "dial_reader_version": _VERSION,
            "processing_ms": elapsed_ms,
            "image_bytes": image_size,
            "outcome": "success",
            "confidence": _SCAFFOLDING_SUCCESS_RESPONSE["result"]["confidence"],
        }
    )
    return JSONResponse(status_code=200, content=_SCAFFOLDING_SUCCESS_RESPONSE)
