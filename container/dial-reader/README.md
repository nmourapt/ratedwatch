# dial-reader

CV-based watch dial reader for [rated.watch](https://rated.watch). Runs as
a Cloudflare Container behind a Worker-side adapter
(`src/domain/dial-reader/`).

## Status

**Slice #74 — scaffolding only.** The single endpoint
`POST /v1/read-dial` returns a fixed non-meaningful response with
`confidence: 0.0`. Real CV (image decode → HoughCircles → hand-angle
parse → displayed time) lands in subsequent slices of the parent
PRD ([#73](../../../../issues/73)).

## Toolchain

- Python 3.12
- [uv](https://docs.astral.sh/uv/) for venv + dependency resolution +
  lockfile (commit `uv.lock` to the repo).
- FastAPI + uvicorn for the HTTP surface.
- pytest + ruff + mypy for tests, lint, and type checking.
- OpenCV-headless + numpy + Pillow + pillow-heif for CV (used by
  later slices, pre-installed in the base image so we don't pay the
  cold-start cost on first use).
- Sentry SDK for error reporting (DSN passed in via container env vars
  in production, unset in local dev).

## Local development

Install dependencies and run the test suite:

```bash
cd container/dial-reader
make install      # uv sync
make test         # uv run pytest
make lint         # uv run ruff check .
make typecheck    # uv run mypy src/
```

Run the service locally with uvicorn (without Docker):

```bash
uv run uvicorn dial_reader.http_app:app --host 0.0.0.0 --port 8080 --reload
curl -X POST http://localhost:8080/v1/read-dial
```

Build and run the production image:

```bash
make build  # docker build -t dial-reader:dev .
make run    # docker run --rm -p 8080:8080 dial-reader:dev
```

## Deploying

The container is built and pushed by `wrangler deploy` in the Worker
toolchain — there is no separate `docker push` step. The image
reference lives in [`wrangler.jsonc`](../../wrangler.jsonc) under
`containers[].image = "./container/dial-reader/Dockerfile"`. CI runs
`wrangler deploy --dry-run` on every PR to validate the config; merge
to `main` triggers a real production deploy.

## API contract

`POST /v1/read-dial` — image bytes in the request body (later slices),
returns:

```json
{
  "version": "v0.0.1-scaffolding",
  "ok": true,
  "result": {
    "displayed_time": { "h": 12, "m": 0, "s": 0 },
    "confidence": 0.0,
    "dial_detection": { "center_xy": [0, 0], "radius_px": 0 },
    "hand_angles_deg": { "hour": 0, "minute": 0, "second": 0 },
    "processing_ms": 0
  }
}
```

`GET /healthz` — liveness probe used by `docker run` smoke tests
and future operator probes. Cloudflare Containers' own readiness
check is configured separately on the `Container` class in the Worker.

## Why a separate container

Workers AI (the previous dial-reader) was fundamentally cheating —
the model echoed the reference time anchor instead of reading the
dial. CV gives us a deterministic, auditable read. OpenCV needs more
memory and a real filesystem than Workers can provide, hence the
container. See PRD [#73](../../../../issues/73) for the full
rationale.
