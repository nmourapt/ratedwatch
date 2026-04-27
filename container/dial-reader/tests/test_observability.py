"""Slice #83 observability tests.

The dial-reader container emits a single JSON log line per request
into stdout (Cloudflare's container observability integration
forwards stdout/stderr to Workers Logs). These tests assert the
shape of that line for each outcome (success / unsupported_format /
malformed_image) and assert that the Sentry init at module-load
does NOT raise when SENTRY_DSN is unset (the local-dev / pytest
default).
"""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient

from dial_reader.http_app import _request_logger, app

client = TestClient(app)

# A captured-record handler attached to the request logger inside the
# tests below so we can read what the formatter emitted without
# depending on stdout capture (which interacts oddly with pytest's
# capfd in async paths).


@pytest.fixture
def captured_log() -> Any:
    """Yield a list to which every log line emitted via
    `_request_logger` is appended as a parsed JSON dict."""
    captured: list[dict[str, Any]] = []

    class _CaptureHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            # The application's formatter on the production handler
            # turns a dict `record.msg` into a JSON string. Mirror
            # that here so the captured output matches what hits
            # stdout in production.
            if isinstance(record.msg, dict):
                captured.append(dict(record.msg))
            else:
                captured.append({"message": record.getMessage()})

    handler = _CaptureHandler()
    _request_logger.addHandler(handler)
    try:
        yield captured
    finally:
        _request_logger.removeHandler(handler)


def test_success_emits_json_log_line_with_expected_fields(
    jpeg_bytes: bytes, captured_log: list[dict[str, Any]]
) -> None:
    """Successful decode → outcome=success log line."""
    response = client.post(
        "/v1/read-dial",
        content=jpeg_bytes,
        headers={
            "content-type": "application/octet-stream",
            "x-reading-id": "rdg-test-success",
        },
    )

    assert response.status_code == 200
    assert len(captured_log) == 1
    line = captured_log[0]
    assert line["event"] == "read_dial"
    assert line["reading_id"] == "rdg-test-success"
    assert line["outcome"] == "success"
    assert line["dial_reader_version"] == "v0.1.0-decode"
    assert isinstance(line["processing_ms"], int)
    assert line["processing_ms"] >= 0
    assert line["image_bytes"] == len(jpeg_bytes)
    assert "confidence" in line


def test_unsupported_format_emits_rejection_log_line(
    gif_bytes: bytes, captured_log: list[dict[str, Any]]
) -> None:
    """GIF is recognised-but-rejected → outcome=rejection,
    rejection_reason=unsupported_format."""
    response = client.post(
        "/v1/read-dial",
        content=gif_bytes,
        headers={
            "content-type": "application/octet-stream",
            "x-reading-id": "rdg-test-gif",
        },
    )

    assert response.status_code == 200
    assert len(captured_log) == 1
    line = captured_log[0]
    assert line["event"] == "read_dial"
    assert line["reading_id"] == "rdg-test-gif"
    assert line["outcome"] == "rejection"
    assert line["rejection_reason"] == "unsupported_format"
    assert line["dial_reader_version"] == "v0.1.0-decode"


def test_malformed_image_emits_log_line(
    captured_log: list[dict[str, Any]],
) -> None:
    """Empty body → 400 + outcome=malformed_image log line."""
    response = client.post(
        "/v1/read-dial",
        content=b"",
        headers={
            "content-type": "application/octet-stream",
            "x-reading-id": "rdg-test-empty",
        },
    )

    assert response.status_code == 400
    assert len(captured_log) == 1
    line = captured_log[0]
    assert line["event"] == "read_dial"
    assert line["outcome"] == "malformed_image"
    assert line["reading_id"] == "rdg-test-empty"


def test_log_line_omits_reading_id_when_header_is_absent(
    jpeg_bytes: bytes, captured_log: list[dict[str, Any]]
) -> None:
    """Older Worker callers without x-reading-id still log cleanly —
    reading_id stays None rather than crashing the handler."""
    response = client.post(
        "/v1/read-dial",
        content=jpeg_bytes,
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 200
    assert len(captured_log) == 1
    line = captured_log[0]
    assert line["reading_id"] is None


def test_log_line_serialises_to_valid_json() -> None:
    """The production handler runs a JsonFormatter — make sure a
    representative payload round-trips through json.dumps cleanly."""
    from dial_reader.http_app import _JsonFormatter

    formatter = _JsonFormatter()
    record = logging.LogRecord(
        name="dial_reader.requests",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg={
            "event": "read_dial",
            "reading_id": "rdg-x",
            "dial_reader_version": "v0.1.0-decode",
            "processing_ms": 42,
            "outcome": "success",
        },
        args=(),
        exc_info=None,
    )
    rendered = formatter.format(record)
    parsed = json.loads(rendered)
    assert parsed["event"] == "read_dial"
    assert parsed["reading_id"] == "rdg-x"
    assert parsed["processing_ms"] == 42


def test_module_loads_without_sentry_dsn() -> None:
    """Importing http_app must not raise when SENTRY_DSN is unset.

    The CI environment does not set SENTRY_DSN; the import at the
    top of this file already exercises the bootstrap. This test is
    a redundant guard for the case where someone refactors the init
    to require the env var.
    """
    # The mere fact that this test ran proves the import succeeded.
    # Assert one observable side-effect to make the contract loud.
    from dial_reader import http_app

    assert hasattr(http_app, "app")
