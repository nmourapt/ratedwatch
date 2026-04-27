"""HTTP-surface tests for the dial-reader service.

Slice #74 is intentionally scaffolding-only: the endpoint returns a
fixed non-meaningful response so callers can wire up plumbing without
risking that anyone trusts the result. The shape under test here is
the same shape the real CV implementation must conform to (later
slices) — pinning it now means a real-CV PR can't drift the contract
without updating these assertions.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from dial_reader.http_app import app

# Single shared TestClient — FastAPI handles isolation per call,
# the client itself is cheap to reuse and avoids spinning up the
# ASGI lifespan once per test.
client = TestClient(app)


def test_read_dial_returns_hardcoded_scaffolding_response() -> None:
    """`POST /v1/read-dial` returns the exact PRD-prescribed scaffolding response.

    The 0.0 confidence is deliberate: it ensures no caller is tempted
    to use this output for any real verified-reading flow. When real
    CV lands, this test is rewritten against fixture images.
    """
    response = client.post("/v1/read-dial")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "version": "v0.0.1-scaffolding",
        "ok": True,
        "result": {
            "displayed_time": {"h": 12, "m": 0, "s": 0},
            "confidence": 0.0,
            "dial_detection": {"center_xy": [0, 0], "radius_px": 0},
            "hand_angles_deg": {"hour": 0, "minute": 0, "second": 0},
            "processing_ms": 0,
        },
    }


def test_read_dial_returns_json_content_type() -> None:
    """Adapter on the Worker side parses JSON; assert the header is set."""
    response = client.post("/v1/read-dial")
    assert response.headers["content-type"].startswith("application/json")
