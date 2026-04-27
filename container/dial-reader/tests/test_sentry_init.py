"""Tests for the Sentry bootstrap.

The bootstrap is a small, dependency-injected wrapper around
`sentry_sdk.init`. We pin three guarantees:

  1. With no DSN (None or ""), `init` does nothing and does not
     raise. This is the local-dev / pytest / fresh-preview path
     and must stay frictionless.

  2. With a DSN, `init` calls into `sentry_sdk.init` with our
     standard parameters and tags `runtime=python` +
     `service=dial-reader-container`. We monkeypatch the SDK
     surface rather than spinning up a real Sentry transport.

  3. Calling `init` multiple times is safe (idempotent) — the
     production container's `http_app.py` calls it at module load,
     and any test harness that imports the same module triggers
     the call again.
"""

from __future__ import annotations

from typing import Any

import pytest


def test_init_with_no_dsn_is_a_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    """No DSN → no SDK init, no exceptions."""
    from dial_reader import sentry_init

    calls: list[dict[str, Any]] = []

    def fake_init(**kwargs: Any) -> None:  # noqa: ANN401 — passthrough
        calls.append(kwargs)

    monkeypatch.setattr(sentry_init.sentry_sdk, "init", fake_init)
    monkeypatch.setattr(sentry_init.sentry_sdk, "set_tag", lambda *_a, **_kw: None)

    sentry_init.init(None)
    sentry_init.init("")

    assert calls == []


def test_init_with_dsn_calls_sentry_sdk_with_expected_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With a DSN, init dispatches into sentry_sdk.init with our
    parameters, then stamps the runtime + service tags."""
    from dial_reader import sentry_init

    init_calls: list[dict[str, Any]] = []
    tag_calls: list[tuple[str, str]] = []

    def fake_init(**kwargs: Any) -> None:  # noqa: ANN401
        init_calls.append(kwargs)

    def fake_set_tag(name: str, value: str) -> None:
        tag_calls.append((name, value))

    monkeypatch.setattr(sentry_init.sentry_sdk, "init", fake_init)
    monkeypatch.setattr(sentry_init.sentry_sdk, "set_tag", fake_set_tag)

    sentry_init.init("https://example@sentry.io/12345")

    assert len(init_calls) == 1
    kwargs = init_calls[0]
    assert kwargs["dsn"] == "https://example@sentry.io/12345"
    assert kwargs["traces_sample_rate"] == 0.1
    assert "integrations" in kwargs
    # We don't pin the exact integration class identity (sentry-sdk
    # ships its own internals) — just that exactly one integration
    # is registered and it carries the FastApiIntegration name.
    integrations = kwargs["integrations"]
    assert len(integrations) == 1
    assert type(integrations[0]).__name__ == "FastApiIntegration"

    assert ("runtime", "python") in tag_calls
    assert ("service", "dial-reader-container") in tag_calls


def test_init_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Calling init twice with the same DSN is harmless.

    `sentry_sdk.init` itself is documented as idempotent (multiple
    calls re-initialise the client), so we only need to verify our
    wrapper doesn't add a second source of breakage.
    """
    from dial_reader import sentry_init

    init_count = 0

    def fake_init(**_kwargs: Any) -> None:  # noqa: ANN401
        nonlocal init_count
        init_count += 1

    monkeypatch.setattr(sentry_init.sentry_sdk, "init", fake_init)
    monkeypatch.setattr(sentry_init.sentry_sdk, "set_tag", lambda *_a, **_kw: None)

    sentry_init.init("https://x@sentry.io/1")
    sentry_init.init("https://x@sentry.io/1")

    assert init_count == 2
