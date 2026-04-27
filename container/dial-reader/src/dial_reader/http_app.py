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
"""

from __future__ import annotations

from typing import Any, Final

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

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
    """
    image_bytes = await request.body()

    try:
        img = decode(image_bytes)
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

    # Image decoded into an RGB ndarray. Run the dial locator.
    circle = locate(img)
    if circle is None:
        # No plausible dial circle. Surface as a structured
        # rejection so the SPA can show "we couldn't find a watch
        # dial in this photo — make sure the dial is centered and
        # well-lit" with only a "Retake" button (no manual
        # fallback — the user needs to retry).
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
