# syntax=docker/dockerfile:1.7
#
# rated.watch dial-reader container.
#
# Two-stage build: the first stage uses the official `astral-sh/uv`
# image to materialise a frozen virtualenv from `uv.lock`. The second
# stage copies that venv onto a slim Python 3.12 base. Keeping uv
# itself out of the final image trims ~50 MB and keeps the runtime
# surface auditable.
#
# Why opencv-python-headless: the standard `opencv-python` package
# pulls in GUI toolkits (Qt, GTK) we'd never use — this is HTTP-in /
# JSON-out only.
#
# `linux/amd64` is required by the Cloudflare Containers runtime
# (see https://developers.cloudflare.com/containers/get-started/).
# `--platform=linux/amd64` is set on the FROM lines so an Apple-Silicon
# `docker build` produces an amd64 image rather than silently
# cross-compiling to arm64.

ARG PYTHON_VERSION=3.12-slim-bookworm

# ---- Stage 1: install dependencies into a venv via uv ------------
FROM --platform=linux/amd64 ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_INSTALLER_METADATA=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /app

# Copy dependency manifests first so this layer is cached when only
# source changes (a rebuild after a docs edit doesn't reinstall
# OpenCV from scratch).
COPY pyproject.toml uv.lock README.md ./

# Sync runtime deps only (no dev/test). `--frozen` requires uv.lock
# to be present and forbids resolution drift — the same versions
# that pass tests are the ones in the image.
#
# We split sync into "deps only" then "with project source" so the
# heavy wheel install (numpy, opencv, pillow) is cached separately
# from the project package itself.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Now copy the project source and install the package itself into
# the venv. Without this step `dial_reader` would import from the
# project root rather than the installed wheel.
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev


# ---- Stage 2: minimal runtime image ------------------------------
FROM --platform=linux/amd64 python:${PYTHON_VERSION} AS runtime

# OpenCV-headless still depends on a few system shared libraries
# even without the GUI toolkits — libglib for image I/O and the
# rendering backend. libgl1 is needed by some opencv operations on
# Debian. Keep the list minimal; every package adds attack surface.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. Cloudflare Containers' platform documentation does
# not require it, but it's free defense-in-depth and standard hygiene.
RUN groupadd --system app && useradd --system --gid app --no-create-home app

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Copy the materialised venv from the builder.
COPY --from=builder --chown=app:app /opt/venv /opt/venv

# Copy the source. The package is installed into the venv as a wheel,
# so this is technically redundant — but having the source on disk
# makes stack traces and `python -m` invocations more useful when
# debugging in a running container.
COPY --chown=app:app src/ ./src/

USER app

EXPOSE 8080

# uvicorn entry. `--host 0.0.0.0` so the Worker can reach it via the
# Container DO binding; `--port 8080` matches `defaultPort` on the
# `DialReaderContainer` Worker class.
CMD ["uvicorn", "dial_reader.http_app:app", "--host", "0.0.0.0", "--port", "8080"]
