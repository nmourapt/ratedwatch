# VLM bake-off — verified-reading dial reader

This directory contains the methodology and artefacts that justified the
hybrid HoughCircles + GPT-5.2 pipeline we ship in PRD #99 (see GitHub).

## Files

- `bakeoff.py` — the harness. Sends the 6 real-watch smoke fixtures
  through Cloudflare AI Gateway (unified billing) to a panel of
  vision-capable LLMs, scores against truth, runs an anchor-shift
  cheat-detection round, and emits a markdown report.
- `fixtures/smoke/` — the 6 real-watch JPEGs + a `manifest.json` mapping
  each filename to the truth time and watch metadata.
- `report.md` — the most recent run's human-readable summary.
- `results.json` — the most recent run's raw per-call records.

## How to run

```bash
uv run scripts/vlm-bakeoff/bakeoff.py
```

Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `.env` at
the repo root. Token needs AI Gateway: Read+Edit. Cost per run: ~$0.10
of unified-billing credits in the Cloudflare account.

The script reads the AI Gateway slug from `GATEWAY_ID` constant near the
top — `dial-reader-bakeoff`. The gateway must have
`authentication = true` and `wholesale = true` (unified billing).

## Why this exists

The PRD #73 dial reader (classical CV in a Python container) shipped on
synthetic-corpus tests that passed because the synthetic generator and
the CV algorithm shared assumptions by construction — we were grading
our work against a copy of itself. When real-watch photos went in, all
6 failed, each in a different way.

This bake-off is the methodological response: validate against real
photos, with anchor-shift cheat-detection (Claude Opus 4.5 silently
echoed the EXIF anchor 17/18 times and would have shipped a system that
rubber-stamped every reading as "verified" — caught here).

The bake-off remains in the repo as a regression harness: when we
evaluate model upgrades (GPT-5.5+, GPT-6, etc.), re-run this and
require ≥ 5/6 within ±5 s on the median plus passing the cheat-check.
