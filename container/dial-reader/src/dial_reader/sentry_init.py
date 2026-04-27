"""Sentry SDK bootstrap for the dial-reader container.

Slice #83 of PRD #73. The Worker side already auto-captures
unhandled exceptions via `withSentry` (see
src/observability/sentry.ts); the container needed its own SDK init
so Python-side errors land in the same Sentry project tagged
`runtime=python` rather than disappearing into stderr.

Design notes:

  * `init` is intentionally a no-op when the DSN is missing. Local
    `docker run` smoke tests, the pytest suite, and freshly
    provisioned previews should all boot cleanly without a Sentry
    project — observability must never gate the product.

  * `traces_sample_rate=0.1` keeps the cost predictable while still
    giving us latency profiles on a useful fraction of traffic. The
    unit-rate alpha traffic doesn't justify a higher sample.

  * `FastApiIntegration` is enabled by default by `sentry-sdk[fastapi]`
    when FastAPI is importable, but we register it explicitly so the
    intent is reviewable in code rather than implicit in the
    extras-marker.

  * `runtime` and `service` tags are always set so the operator can
    SQL-filter Worker errors vs container errors in a single Sentry
    dashboard. The Worker-side `service` tag (in sentry.ts's
    `withSentry` wrapper) is `ratedwatch`; here it's
    `dial-reader-container`.
"""

from __future__ import annotations

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration


def init(dsn: str | None) -> None:
    """Initialise Sentry if a DSN is provided.

    Safe to call multiple times — `sentry_sdk.init` is idempotent.
    Safe to call with `None` or `""` — both short-circuit the init,
    leaving the SDK in its inactive state where every capture call
    is a no-op.

    Returns nothing because callers should not branch on success;
    if Sentry can't initialise (bad DSN, network problem at boot),
    `sentry_sdk.init` raises and we let it propagate so the operator
    sees the misconfiguration on container start rather than weeks
    later when an error fails to capture.
    """
    if not dsn:
        return
    sentry_sdk.init(
        dsn=dsn,
        traces_sample_rate=0.1,
        integrations=[FastApiIntegration()],
    )
    sentry_sdk.set_tag("runtime", "python")
    sentry_sdk.set_tag("service", "dial-reader-container")
