"""rated.watch dial-reader service.

This package runs inside a Cloudflare Container, fronted by FastAPI,
and is called from the Worker via a Durable Object container binding
(`env.DIAL_READER`). At slice #74 (this scaffolding step) the only
endpoint is `POST /v1/read-dial`, which returns a hardcoded
non-meaningful response. Real CV work lands in subsequent slices.

The package is deliberately tiny so the import graph stays trivially
auditable. The HTTP surface lives in `dial_reader.http_app`; future
modules (image-decoding, dial detection, hand parsing) will be added
as siblings under `dial_reader/`.
"""
