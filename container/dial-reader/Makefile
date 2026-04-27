.PHONY: install test lint typecheck format build run clean

# uv handles virtualenv creation, dependency resolution, and the
# lockfile. `uv sync` materialises a venv in .venv from pyproject.toml
# + uv.lock. All other targets shell through `uv run` so contributors
# don't have to remember to activate anything.

install:
	uv sync

test:
	uv run pytest

lint:
	uv run ruff check .

format:
	uv run ruff format .

typecheck:
	uv run mypy src/

# Build the production image. Tagged `dial-reader:dev` for local
# `docker run` smoke tests; CI builds via wrangler in the Worker
# deploy step (see wrangler.jsonc → containers.image).
build:
	docker build -t dial-reader:dev .

# Run the container locally on :8080. Mirrors the Cloudflare runtime
# port so adapter integration tests can be pointed here when needed.
run:
	docker run --rm -p 8080:8080 dial-reader:dev

clean:
	rm -rf .venv .pytest_cache .mypy_cache .ruff_cache __pycache__ \
	       src/dial_reader/__pycache__ tests/__pycache__
