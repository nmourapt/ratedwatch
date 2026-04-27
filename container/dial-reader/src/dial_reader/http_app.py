"""FastAPI HTTP surface for the dial-reader service.

Slice #74 is the tracer-bullet container: it stands up the runtime,
the routing layer, the deploy plumbing, and the typed Worker-side
adapter — but does NOT do any real CV work yet. The single endpoint
returns a fixed scaffolding response with `confidence: 0.0` so no
caller is tempted to surface it as a real verified reading.

Subsequent slices replace `read_dial` with real image decoding,
HoughCircles dial detection, hand-angle parsing, and a true
confidence score. The response schema here is the contract the real
implementation must conform to; pinning it in tests now means a
real-CV PR can't drift the shape without updating callers.

The Worker-side adapter (`src/domain/dial-reader/`) consumes this
endpoint as `getContainer(env.DIAL_READER, "global").fetch(req)`.
Both sides live in the same repo so contract drift is caught in a
single PR review rather than across a dependency boundary.
"""

from __future__ import annotations

from typing import Any, Final

from fastapi import FastAPI

# Bumped when the response shape changes in a meaningful way. The
# Worker-side adapter doesn't gate on this today (we deploy both
# sides together) but it's exposed in the body so operators reading
# Worker Logs can correlate which container build answered.
_VERSION: Final[str] = "v0.0.1-scaffolding"

# The complete scaffolding response. Defined at module level so it
# round-trips through json (Python dict -> FastAPI response -> client
# .json()) byte-for-byte equal to the contract test, and so the
# constant stays trivially auditable in a code review.
#
# Why these specific values:
#   - confidence: 0.0 — explicit "do not trust this read"
#   - displayed_time: 12:00:00 — neutral, doesn't echo any reference
#   - hand_angles_deg: all 0 — only meaningful when CV lands
#   - dial_detection: zero center + zero radius — same
#   - processing_ms: 0 — no work done, no time consumed
_SCAFFOLDING_RESPONSE: Final[dict[str, Any]] = {
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
def read_dial() -> dict[str, Any]:
    """Read the time displayed by a watch in the request body.

    Slice #74 (scaffolding): returns the fixed shape above regardless
    of input. Future slices will:
      1. Read the image bytes from the request body.
      2. Decode JPEG / PNG / HEIC into a numpy array.
      3. Run HoughCircles to find the dial.
      4. Parse hand angles from the dial-cropped image.
      5. Convert hand angles to displayed time + confidence.

    Until then this endpoint is suitable only for plumbing tests.
    """
    return _SCAFFOLDING_RESPONSE
