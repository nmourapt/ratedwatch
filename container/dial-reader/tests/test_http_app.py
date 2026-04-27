"""HTTP-surface tests for the dial-reader service.

Slice #78 adds the hand-classifier stage: after the locator
finds a dial, the container runs `detect_hand_contours` +
`classify_hands` and returns `unsupported_dial` rejection if the
classifier returns `None` (≠ 3 hands found, indicating a
chronograph / GMT / 2-hand / partial detection). 3-hand
synthetic dials still flow into the slice-#74 hardcoded success
shape — real angle math + time translation lands in #79.

Four core 200 shapes the Worker-side adapter must handle:

  - `ok: true`  + `result: {...}` — image decoded, dial located,
    AND 3 hands successfully classified. `result.dial_detection`
    reflects the actual detected circle from the locator.

  - `ok: false` + `rejection: {reason: "unsupported_format"}` —
    decode rejected the bytes (slice #76).

  - `ok: false` + `rejection: {reason: "no_dial_found"}` — image
    decoded fine but no plausible dial circle was found
    (slice #77).

  - `ok: false` + `rejection: {reason: "unsupported_dial"}` —
    dial located but hand-classifier returned None
    (slice #78).

Plus 400 for malformed image bytes; that contract is unchanged.

Test assets used here are all produced inline from the synthetic
generator + small Pillow snippets so the diff stays text-only
and reviewable.
"""

from __future__ import annotations

import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from dial_reader.http_app import app
from dial_reader.synthetic import generate_dial

# Single shared TestClient — FastAPI handles isolation per call,
# the client itself is cheap to reuse and avoids spinning up the
# ASGI lifespan once per test.
client = TestClient(app)

VERSION = "v1.0.0"


def _synthetic_dial_jpeg(hh: int = 8, mm: int = 56, ss: int = 6) -> bytes:
    """Encode a synthetic dial as JPEG bytes for use as a request body."""
    rgb = generate_dial(hh, mm, ss)
    pil = Image.fromarray(rgb)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


# ---------------------------------------------------------------
# Successful decode + dial located → hardcoded reading echo +
# real detection geometry.
# ---------------------------------------------------------------


def test_read_dial_with_synthetic_dial_returns_success() -> None:
    """A clean synthetic dial decodes AND locates → ok:true. The
    `dial_detection` block must reflect the actual locator output
    (non-zero radius, center near the image midpoint)."""
    response = client.post(
        "/v1/read-dial",
        content=_synthetic_dial_jpeg(),
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == VERSION
    assert body["ok"] is True
    detection = body["result"]["dial_detection"]
    cx, cy = detection["center_xy"]
    assert detection["radius_px"] > 0
    # Synthetic dial is rendered at 800x800 with the dial centered.
    assert abs(cx - 400) < 80
    assert abs(cy - 400) < 80


def test_read_dial_with_heic_synthetic_dial_returns_success() -> None:
    """HEIC is the iPhone-camera default; the entire verified-reading
    flow is dead in the water if this path doesn't decode + locate."""
    rgb = generate_dial(8, 56, 6)
    pil = Image.fromarray(rgb)
    buf = io.BytesIO()
    pil.save(buf, format="HEIF")

    response = client.post(
        "/v1/read-dial",
        content=buf.getvalue(),
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["result"]["dial_detection"]["radius_px"] > 0


# ---------------------------------------------------------------
# Successful decode but no dial found → 200 with structured rejection.
# ---------------------------------------------------------------


def _solid_color_jpeg(rgb: tuple[int, int, int] = (255, 0, 0), size: int = 256) -> bytes:
    """Encode a flat solid-color image as JPEG. No dial → expect
    `no_dial_found`."""
    img = np.full((size, size, 3), rgb, dtype=np.uint8)
    pil = Image.fromarray(img)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG")
    return buf.getvalue()


def test_read_dial_with_solid_color_returns_no_dial_found() -> None:
    """A solid-color image decodes successfully but has no circle.
    The container must surface `no_dial_found` so the verifier can
    show the SPA's "we couldn't find a watch dial" message."""
    response = client.post(
        "/v1/read-dial",
        content=_solid_color_jpeg(),
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == VERSION
    assert body["ok"] is False
    assert body["rejection"]["reason"] == "no_dial_found"
    # Operator-facing details are required so logs say *what*
    # specifically rejected; details is a free-form string.
    assert "details" in body["rejection"]
    assert isinstance(body["rejection"]["details"], str)


# ---------------------------------------------------------------
# Decoded + located but classify_hands returns None → 200 with
# `unsupported_dial` rejection.
# ---------------------------------------------------------------


def _gmt_mock_jpeg() -> bytes:
    """Synthetic 3-hander + a 4th GMT-style hand → 4 contours →
    classify_hands returns None → http surfaces `unsupported_dial`."""
    import math

    rgb = generate_dial(8, 56, 6).copy()
    cx, cy = 400, 400
    r = 350
    angle = math.radians(110.0)
    end_x = int(round(cx + math.sin(angle) * r * 0.80))
    end_y = int(round(cy - math.cos(angle) * r * 0.80))
    import cv2

    cv2.line(rgb, (cx, cy), (end_x, end_y), (240, 240, 240), 12, lineType=cv2.LINE_AA)
    pil = Image.fromarray(rgb)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def test_read_dial_with_gmt_mock_returns_unsupported_dial() -> None:
    """A GMT-style 4-hand synthetic dial decodes + locates fine
    but classify_hands rejects → 200 + `unsupported_dial`. This is
    the headline acceptance test for slice #78: chronograph / GMT
    / sub-dial inputs surface as `unsupported_dial` rather than
    silently producing a wrong reading."""
    response = client.post(
        "/v1/read-dial",
        content=_gmt_mock_jpeg(),
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == VERSION
    assert body["ok"] is False
    assert body["rejection"]["reason"] == "unsupported_dial"
    # Operator-facing details must include the candidate count so
    # the Workers Logs row is self-explanatory.
    assert "details" in body["rejection"]
    assert isinstance(body["rejection"]["details"], str)
    assert "candidate" in body["rejection"]["details"].lower()


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
    assert body["version"] == VERSION


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
    assert response.json() == {"status": "ok", "version": VERSION}
