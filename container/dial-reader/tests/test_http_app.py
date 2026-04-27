"""HTTP-surface tests for the dial-reader service.

Slice #76 wires real image decoding into `POST /v1/read-dial`:

  - A valid image (JPEG/PNG/WebP/HEIC) decodes successfully and
    the endpoint returns the same hardcoded "successful" reading
    that slice #74 introduced. Real CV lives in subsequent slices
    so we keep the success-payload contract pinned.

  - An unsupported-but-recognised format (GIF, BMP, TIFF, AVIF…)
    surfaces as a 200 with `ok: false, rejection.reason:
    "unsupported_format"`. Rejection-as-200 mirrors how the legacy
    AI runner reported "I ran but couldn't read this": the Worker
    treats it as a structured outcome rather than a transport
    failure.

  - A malformed body (empty, truncated, corrupt) surfaces as a
    400 because the request itself is the problem; retrying with
    the same bytes will keep failing.

The hardcoded success body is the same contract the TS adapter
asserts on; both sides update together when the real CV lands.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from dial_reader.http_app import app

# Single shared TestClient — FastAPI handles isolation per call,
# the client itself is cheap to reuse and avoids spinning up the
# ASGI lifespan once per test.
client = TestClient(app)

# The hardcoded success body. Centralised here so a slice that
# changes the contract has exactly one failing assertion to update.
EXPECTED_SUCCESS_BODY = {
    "version": "v0.1.0-decode",
    "ok": True,
    "result": {
        "displayed_time": {"h": 12, "m": 0, "s": 0},
        "confidence": 0.0,
        "dial_detection": {"center_xy": [0, 0], "radius_px": 0},
        "hand_angles_deg": {"hour": 0, "minute": 0, "second": 0},
        "processing_ms": 0,
    },
}


# ---------------------------------------------------------------
# Successful decode → hardcoded reading.
# ---------------------------------------------------------------


def test_read_dial_with_jpeg_returns_hardcoded_reading(jpeg_bytes: bytes) -> None:
    response = client.post(
        "/v1/read-dial",
        content=jpeg_bytes,
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == EXPECTED_SUCCESS_BODY


def test_read_dial_with_heic_returns_hardcoded_reading(heic_bytes: bytes) -> None:
    """HEIC is the iPhone-camera default; the entire verified-reading
    flow is dead in the water if this path doesn't decode."""
    response = client.post(
        "/v1/read-dial",
        content=heic_bytes,
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == EXPECTED_SUCCESS_BODY


# ---------------------------------------------------------------
# Unsupported format → 200 with structured rejection.
# ---------------------------------------------------------------


def test_read_dial_with_gif_returns_unsupported_rejection(gif_bytes: bytes) -> None:
    """Rejection-as-200 mirrors the legacy AI runner's "ran but
    couldn't read" outcome. The Worker treats this as a
    structured rejection on the success transport."""
    response = client.post(
        "/v1/read-dial",
        content=gif_bytes,
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert body["rejection"]["reason"] == "unsupported_format"
    # The version is exposed on every response so operators can
    # correlate Worker logs with container builds.
    assert body["version"] == "v0.1.0-decode"


# ---------------------------------------------------------------
# Malformed body → 400.
# ---------------------------------------------------------------


def test_read_dial_with_empty_body_returns_400() -> None:
    response = client.post(
        "/v1/read-dial",
        content=b"",
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 400, response.text
    body = response.json()
    assert body["error"] == "malformed_image"


def test_read_dial_with_truncated_jpeg_returns_400(truncated_jpeg_bytes: bytes) -> None:
    """First 100 bytes still sniff as JPEG, so the decoder
    dispatches into Pillow and Pillow then fails on the missing
    data — surfaces as a 400."""
    response = client.post(
        "/v1/read-dial",
        content=truncated_jpeg_bytes,
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 400, response.text
    body = response.json()
    assert body["error"] == "malformed_image"


# ---------------------------------------------------------------
# Standing contract from slice #74 that doesn't change here.
# ---------------------------------------------------------------


def test_read_dial_returns_json_content_type(jpeg_bytes: bytes) -> None:
    """Adapter on the Worker side parses JSON; assert the header is set."""
    response = client.post(
        "/v1/read-dial",
        content=jpeg_bytes,
        headers={"content-type": "application/octet-stream"},
    )
    assert response.headers["content-type"].startswith("application/json")


def test_healthz_reports_new_version() -> None:
    """Health probe surfaces the version constant; bumping it
    here is the cheap signal operators see when a new container
    build rolls out."""
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "v0.1.0-decode"}
