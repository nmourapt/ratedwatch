"""HTTP-surface tests for the dial-reader service.

Slice #77 adds the dial-locator stage: after a successful decode,
the container runs `dial_locator.locate(img)` and returns
`no_dial_found` rejection if no plausible dial is detected.
Successful detections still flow into the slice-#74 hardcoded
"successful reading" — real CV (hand geometry, time translation,
confidence scoring) lands in subsequent slices.

Three core 200 shapes the Worker-side adapter must handle:

  - `ok: true`  + `result: {...}` — image decoded and a dial was
    located. `result.dial_detection` now reflects the actual
    detected circle from the locator (previous slices zeroed it).

  - `ok: false` + `rejection: {reason: "unsupported_format"}` —
    decode rejected the bytes (slice #76).

  - `ok: false` + `rejection: {reason: "no_dial_found"}` — image
    decoded fine but no plausible dial circle was found.

Plus 400 for malformed image bytes; that contract is unchanged.

The two test assets used here are produced inline:
  - a tiny solid-red JPEG decodes but contains no dial → expect
    `no_dial_found`.
  - a synthetic dial → expect `ok: true` with a non-zero detection.
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

VERSION = "v0.2.0-dial-locator"


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
