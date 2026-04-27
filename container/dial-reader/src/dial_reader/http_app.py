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
"""

from __future__ import annotations

from typing import Any, Final

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from dial_reader.image_decoder import (
    MalformedImageError,
    UnsupportedFormatError,
    decode,
)

# Bumped when the response shape or behaviour changes in a way
# operators need to see. Slice #74 was `v0.0.1-scaffolding`; this
# slice flips real decode on while keeping the success shape.
_VERSION: Final[str] = "v0.1.0-decode"

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
    """
    image_bytes = await request.body()

    try:
        decode(image_bytes)
    except UnsupportedFormatError as e:
        # Recognised-but-rejected format. The Worker-side adapter
        # turns this into a `DialReadResult` of kind `rejection`,
        # which the verifier surfaces as a polite "this format
        # isn't supported yet" message.
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
    return JSONResponse(status_code=200, content=_SCAFFOLDING_SUCCESS_RESPONSE)
