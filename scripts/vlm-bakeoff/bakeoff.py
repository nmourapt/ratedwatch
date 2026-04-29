#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "httpx>=0.27",
#   "python-dotenv>=1.0",
#   "truststore>=0.10",
#   "pillow>=10.0",
#   "opencv-python-headless>=4.10",
#   "numpy>=2.0",
# ]
# ///
"""VLM bake-off for the dial-reader smoke corpus.

Sends each smoke fixture through AI Gateway's unified-billing
chat-completions endpoint to a panel of frontier vision-capable
models, scores the responses against the manifest truth, and
emits a markdown report.

Usage:
    uv run scripts/vlm-bakeoff/bakeoff.py

Environment (read from .env at repo root):
    CLOUDFLARE_ACCOUNT_ID
    CLOUDFLARE_API_TOKEN  (must have AI Gateway: Read+Edit; gateway must
                           be authenticated for unified billing)

Output:
    scripts/vlm-bakeoff/results.json  — raw per-call records
    scripts/vlm-bakeoff/report.md     — human-readable summary
"""

from __future__ import annotations

import base64
import json
import os
import random
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import ssl
import httpx
import truststore
from dotenv import load_dotenv

# Use the OS trust store (Keychain on macOS). This is more lenient about
# certificates that lack the "Key Usage" extension — which is exactly the
# state of the Cloudflare WARP / corporate root CA on this machine.
_SSL_CONTEXT = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Smoke fixtures live alongside the bake-off so the harness survives the
# Python container's decommission (PRD #99). Slice #2 of #99 also pulls
# from this directory for the dial-cropper unit tests.
SMOKE_DIR = Path(__file__).resolve().parent / "fixtures/smoke"
OUT_DIR = Path(__file__).resolve().parent
RESULTS_PATH = OUT_DIR / "results.json"
REPORT_PATH = OUT_DIR / "report.md"
GATEWAY_ID = "dial-reader-bakeoff"

# Models to test. Mix of frontier and mid-tier so we get a sense of
# where the price/quality break is.
MODELS: list[str] = [
    "openai/gpt-5.2",  # the production candidate
    # Excluded after earlier cheat-check / accuracy findings:
    #   anthropic/claude-opus-4-5         — echoes the EXIF anchor (17/18 reads
    #                                       byte-identical to the anchor).
    #   google-ai-studio/gemini-2.5-pro   — high failure rate (8/18 returned
    #                                       empty content), low accuracy when
    #                                       it does respond.
    #   google-ai-studio/gemini-2.5-flash — low accuracy + occasional anchor echo.
]

# Toggle for the hybrid (HoughCircles dial crop → 768×768 JPEG → VLM).
# When True, every image sent in round 1 is cropped via _crop_to_dial.
# Round 2 (robustness) still uses uncropped images so we measure the
# anchor-cheat behaviour on the raw input shape.
ROUND_1_USE_CROP = True

# Production-realistic prompt: chain-of-thought instructions for hand
# identification + EXIF anchor as a sanity check (NOT to be echoed).
#
# Anchor design rationale:
#   - In production, EXIF DateTimeOriginal is the timestamp the camera
#     captured when the photo was taken. The phone's clock is NTP-synced,
#     so the EXIF time is accurate to ~milliseconds.
#   - The watch may be drifting (the whole point of rated.watch). Drift
#     across a single session is bounded — for a fresh-baseline reading
#     on day 0 it's 0; for a typical 7-day session it's ±a few minutes.
#   - For the bake-off we simulate a "recent baseline" scenario: anchor =
#     truth ± random offset in [-10, +10] seconds. Production-realistic.
#   - The robustness round shifts the anchor by ±60-120s to simulate a
#     watch that has drifted significantly. We need the model to read
#     pixels and not just echo the anchor.

NO_ANCHOR_PROMPT_BASE = (
    "This is a photograph of an analog wristwatch. Read the EXACT time "
    "shown on the dial as precisely as possible.\n\n"
    "{anchor_block}"
    "REQUIRED PROCESS — work through these steps before answering:\n\n"
    "1. IDENTIFY THE THREE HANDS. The watch has three centre-mounted hands. "
    "For each visible hand, observe:\n"
    "   - LENGTH (how far the hand reaches toward the dial edge)\n"
    "   - THICKNESS (thin needle vs. broad)\n"
    "   - COLOR / contrast against the dial\n\n"
    "2. CLASSIFY each hand:\n"
    "   - SECOND HAND: thinnest needle. Often the longest. Often a different "
    "colour from the others (red, orange, blue, lume). Reads the seconds "
    "scale (the outer ring of 60 tick marks).\n"
    "   - MINUTE HAND: medium length, thicker than the second hand, similar "
    "in length to (or slightly shorter than) the second hand. Reads the "
    "minutes on the same outer 60-tick ring. THIS IS THE MOST IMPORTANT "
    "HAND FOR YOUR ANSWER.\n"
    "   - HOUR HAND: SHORTEST. Reaches only about half-way to the dial edge. "
    "Often thicker than the minute hand. Less critical for precision.\n\n"
    "3. READ EACH HAND'S POSITION:\n"
    "   - Second hand → reads 0-59 directly off the outer minute scale.\n"
    "   - Minute hand → reads 0-59 directly off the same scale.\n"
    "   - Hour hand → falls between two hour numerals (e.g. between 10 and "
    "11 means the hour is 10).\n\n"
    "4. SANITY-CHECK against the anchor (if provided):\n"
    "   - The anchor is the camera's EXIF capture time. The watch may be "
    "off by seconds or even minutes due to drift, but it should NOT be off "
    "by hours.\n"
    "   - If your minute reading differs from the anchor's minute by more "
    "than ~10 minutes, you've probably misclassified the hands. Look again: "
    "did you confuse the minute and second hand? Are you reading the wrong "
    "end of a hand (the tail vs the tip)?\n"
    "   - DO NOT just echo the anchor. Read the actual pixels.\n\n"
    "5. ROLLOVER AMBIGUITY: when the minute hand is near :00 (between :58 "
    "and :02), the hour hand visually points right at a numeral and could "
    "be the previous or next hour. Use the anchor's hour to disambiguate.\n\n"
    "OUTPUT — respond with ONLY a single line in the EXACT format HH:MM:SS "
    "using a 12-hour clock (no AM/PM, no extra text, no explanation, no "
    "Markdown). Two digits for each component. Example output: 04:37:21"
)


def _build_prompt(anchor_hms: str | None) -> str:
    """Compose the full prompt with or without an EXIF anchor block."""
    if anchor_hms is None:
        anchor_block = "No anchor available. Read the dial purely from the image.\n\n"
    else:
        anchor_block = (
            f"EXIF ANCHOR: this photograph's EXIF DateTimeOriginal is "
            f"{anchor_hms}. The user's phone captured this timestamp at the "
            f"moment of the photo. The watch should read CLOSE to this time "
            f"but may be drifting by seconds. Treat the anchor as a "
            f"sanity-check, NOT as your answer.\n\n"
        )
    return NO_ANCHOR_PROMPT_BASE.replace("{anchor_block}", anchor_block)


def _anchor_with_offset(truth_hms: str, offset_seconds: int) -> str:
    """Return truth_hms shifted by `offset_seconds` (signed), as HH:MM:SS.

    Wraps around the 12-hour cycle defensively. Production EXIF anchors are
    a few seconds off; bake-off robustness round uses larger offsets.
    """
    base = _hms_to_seconds(truth_hms)
    shifted = (base + offset_seconds) % 43200
    h = (shifted // 3600) or 12
    m = (shifted % 3600) // 60
    s = shifted % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


@dataclass
class Result:
    fixture: str
    model: str
    run: int  # 1, 2, 3, … (per-fixture replicate index for variance analysis)
    anchor_mode: str  # "anchor" | "no_anchor" | "robustness_anchor"
    anchor_hms: str | None  # the EXIF anchor we passed (if any)
    anchor_offset_seconds: int | None  # signed offset of anchor from truth
    truth_hms: str
    raw_response: str
    parsed_hms: str | None
    error_seconds: int | None  # signed (predicted - truth) in seconds, full clock
    mmss_error_seconds: int | None  # signed MM:SS-only error (production-relevant)
    latency_ms: int
    tokens_in: int | None
    tokens_out: int | None
    cost_usd: float | None
    success: bool
    http_status: int
    error_message: str | None
    full_response_json: dict | None = None  # for debugging when content is empty


def _hms_to_seconds(hms: str) -> int:
    h, m, s = (int(x) for x in hms.split(":"))
    h12 = h % 12
    return h12 * 3600 + m * 60 + s


def _parse_response_hms(raw: str) -> str | None:
    """Pull HH:MM:SS out of the model's response.

    The prompt asks for "ONLY HH:MM:SS" but models do whatever they
    want; tolerate surrounding text and grab the first HH:MM:SS-looking
    token. Returns None if no plausible time string is found.
    """
    # Match H:MM:SS or HH:MM:SS, with optional surrounding whitespace.
    m = re.search(r"\b(\d{1,2}):(\d{2}):(\d{2})\b", raw)
    if not m:
        return None
    h, mm, ss = (int(x) for x in m.groups())
    if not (1 <= h <= 12 and 0 <= mm < 60 and 0 <= ss < 60):
        # Reject obviously-wrong times like 23:99:99
        return None
    return f"{h:02d}:{mm:02d}:{ss:02d}"


def _signed_error_seconds(predicted: str, truth: str) -> int:
    """Smallest signed delta in [-21600, +21600] seconds.

    Both inputs are HH:MM:SS in 12-hour form. We map both onto a
    [0, 43200) second axis (12 hours = 43200 s) and pick the shorter
    of the two ways around the clock. Sign is +ve when predicted is
    AHEAD of truth.
    """
    p = _hms_to_seconds(predicted)
    t = _hms_to_seconds(truth)
    diff = (p - t) % 43200
    if diff > 21600:
        diff -= 43200
    return diff


def _load_manifest() -> dict[str, dict]:
    with (SMOKE_DIR / "manifest.json").open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _real_fixture_filenames() -> list[str]:
    """Return only the real-watch fixtures (skip the synthetic placeholders)."""
    manifest = _load_manifest()
    return [
        name
        for name, meta in manifest.items()
        if meta.get("watch_make") not in (None, "synthetic")
    ]


def _truth_hms(meta: dict) -> str:
    return f"{meta['hh']:02d}:{meta['mm']:02d}:{meta['ss']:02d}"


def _image_data_url(path: Path, *, crop: bool = False) -> str:
    """Encode an image as a data URL for the OpenAI-compat endpoint.

    When `crop=True`, attempts a HoughCircles-based dial crop, with a
    centred-square fallback when no plausible dial circle is detected.
    The cropped image is normalised to 768×768 JPEG before encoding.
    """
    if not crop:
        raw = path.read_bytes()
        b64 = base64.b64encode(raw).decode("ascii")
        return f"data:image/jpeg;base64,{b64}"

    cropped_bytes = _crop_to_dial(path)
    b64 = base64.b64encode(cropped_bytes).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _crop_to_dial(path: Path) -> bytes:
    """Return JPEG bytes of the image cropped to the watch dial.

    Uses cv2.HoughCircles tuned for typical wrist-shot framing — same
    parameters as the production dial_locator module. Falls back to a
    centred 60%-of-min-dim square when Hough finds no plausible dial.
    Output is always 768×768 JPEG quality 85 — small enough to keep
    VLM image-token cost down, large enough that hand-tip pixels stay
    crisp.
    """
    import io
    import cv2  # type: ignore[import-not-found]
    import numpy as np
    from PIL import Image

    pil = Image.open(path).convert("RGB")
    w, h = pil.size

    # HoughCircles is O(image_size × accumulator), which is unacceptably
    # slow on full-res phone photos (4032×3024 takes minutes per image).
    # Downsample to 1024px long-edge for the detection, then map the
    # detected circle back to original coordinates for the crop. The
    # cropped output is from the high-res original, so we don't lose
    # detail at the dial.
    DETECT_LONG_EDGE = 1024
    scale = DETECT_LONG_EDGE / max(w, h) if max(w, h) > DETECT_LONG_EDGE else 1.0
    if scale < 1.0:
        small = pil.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    else:
        small = pil
    sw, sh = small.size

    arr_small = np.array(small)
    gray = cv2.cvtColor(arr_small, cv2.COLOR_RGB2GRAY)
    gray_blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    circles = cv2.HoughCircles(
        gray_blurred,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(sw, sh) // 2,
        param1=100,
        param2=30,
        minRadius=int(max(sw, sh) * 0.10),  # looser than the prod locator
        maxRadius=int(max(sw, sh) * 0.50),
    )

    cx, cy, r = w // 2, h // 2, int(min(w, h) * 0.30)
    if circles is not None:
        # Pick the candidate closest to image centre with a plausible radius.
        best = None
        best_dist = float("inf")
        for cx_s, cy_s, r_s in circles[0]:
            d = ((cx_s - sw / 2.0) ** 2 + (cy_s - sh / 2.0) ** 2) ** 0.5
            if d > sw * 0.35 and d > sh * 0.35:
                continue
            if r_s < max(sw, sh) * 0.10:
                continue
            if d < best_dist:
                # Map back to original-resolution coords
                best = (
                    int(cx_s / scale),
                    int(cy_s / scale),
                    int(r_s / scale),
                )
                best_dist = d
        if best is not None:
            cx, cy, r = best

    # Pad the bounding box by 1.30× the radius. We tested three settings
    # on the smoke corpus and 1.30× is the clear winner:
    #
    #   1.30× crop, GPT-5.2 + median-of-3:
    #     bambino    -1s ✅   sinn     -1s ✅   snk803_10:15  +0s ✅
    #     greenseiko +5s ✅   snk803_01 +1s ✅  waterbury    +29s ❌
    #     5/6 within ±5s.
    #
    #   1.15× crop, GPT-5.2 + median-of-3:
    #     bambino +120s ❌   snk803_01 +30s ❌   3/6 within ±5s.
    #
    #   1.08× crop, GPT-5.2 + median-of-3:
    #     bambino +59s ❌   snk803_01 +60s ❌   3/6 within ±5s.
    #
    # The wider context (full watch case + bezel + dial) is what GPT-5.2
    # needs to read the dial accurately on most photos. Tightening to
    # eliminate strap clutter (which fixes waterbury) regresses the
    # other fixtures because chapter-ring marks and inner numerals fall
    # off the frame, confusing the model.
    #
    # Waterbury's +29s misread at 1.30× is a documented v1 limitation:
    # the read is consistent (deterministic +29s across all 3 runs) and
    # would either pass the anchor-disagreement guard (<60s threshold)
    # or trigger a retake-prompt.
    half = int(r * 1.30)
    x0 = max(0, cx - half)
    y0 = max(0, cy - half)
    x1 = min(w, cx + half)
    y1 = min(h, cy + half)
    cropped = pil.crop((x0, y0, x1, y1))

    # Normalise to a square 768×768 by padding (don't squash a
    # rectangle — that distorts hand angles).
    cw, ch = cropped.size
    side = max(cw, ch)
    canvas = Image.new("RGB", (side, side), (0, 0, 0))
    canvas.paste(cropped, ((side - cw) // 2, (side - ch) // 2))
    canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _call_model(
    client: httpx.Client,
    *,
    base_url: str,
    cf_token: str,
    model: str,
    image_url: str,
    prompt: str,
) -> tuple[dict | None, int, str | None, int]:
    """Send one chat-completion request and return (json, http_status, err, latency_ms)."""
    # Newer OpenAI reasoning models (gpt-5.x, o1, o3) reject `max_tokens` and
    # require `max_completion_tokens`. Branch on the model namespace.
    is_openai_reasoning = model.startswith("openai/gpt-5") or model.startswith(
        "openai/o"
    )
    body: dict = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ],
    }
    if is_openai_reasoning:
        # GPT-5 reasoning models burn budget on hidden reasoning. With
        # `reasoning_effort: "low"` the model still chains-of-thought
        # internally but stops far earlier — empirically gives the same
        # correct answer in ~8s vs ~25s+, and avoids the 50s "burn the
        # whole budget on reasoning" failure mode we saw on GPT-5.5
        # with effort=medium (default).
        body["max_completion_tokens"] = 4000
        body["reasoning_effort"] = "low"
    else:
        # Gemini 2.5 burns hidden "thinking" tokens before emitting visible
        # output. Anthropic doesn't, but headroom is cheap.
        body["max_tokens"] = 1000
    started = time.monotonic()
    try:
        resp = client.post(
            base_url,
            headers={
                "cf-aig-authorization": f"Bearer {cf_token}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=120.0,
        )
        latency_ms = int((time.monotonic() - started) * 1000)
        try:
            data = resp.json()
        except Exception:
            data = None
        if resp.status_code >= 400:
            # AI Gateway sometimes wraps errors in a top-level list; sometimes
            # the upstream provider returns a raw dict. Be tolerant.
            err: str | None = None
            if isinstance(data, list) and data:
                first = data[0] if isinstance(data[0], dict) else None
                if first:
                    err = (first.get("error") or {}).get("message") or first.get(
                        "message"
                    )
            elif isinstance(data, dict):
                err = (data.get("error") or {}).get("message") or data.get("message")
            if not err:
                err = resp.text[:200]
            return data, resp.status_code, str(err)[:300], latency_ms
        return data, resp.status_code, None, latency_ms
    except httpx.HTTPError as e:
        latency_ms = int((time.monotonic() - started) * 1000)
        return None, 0, f"{type(e).__name__}: {e}"[:300], latency_ms


def _extract_tokens_and_cost(
    data: object,
) -> tuple[int | None, int | None, float | None]:
    if not isinstance(data, dict):
        return None, None, None
    usage = data.get("usage") or {}
    return usage.get("prompt_tokens"), usage.get("completion_tokens"), None


def _content_text(data: object) -> str:
    if not isinstance(data, dict):
        return ""
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    # Some providers return content as a list of parts
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                out.append(part.get("text", ""))
        return "\n".join(out)
    return ""


def _normalise_log_model(provider: str, model: str) -> str:
    """Map an AI Gateway log entry to the request-side model namespace.

    Logs return e.g. (provider="openai", model="gpt-5.2-2025-12-11"); we
    sent model="openai/gpt-5.2". Strip the trailing date suffix
    (`-YYYYMMDD` or `-YYYY-MM-DD`) and re-prepend the provider namespace.
    """
    # Strip ISO-style date suffixes
    stripped = re.sub(r"-\d{4}-?\d{2}-?\d{2}$", "", model)
    return f"{provider}/{stripped}"


def _enrich_cost_from_logs(
    client: httpx.Client,
    *,
    account_id: str,
    cf_token: str,
    results: list[Result],
) -> None:
    """AI Gateway records cost server-side. Pull the most recent logs and
    backfill the `cost_usd` + tokens_in/out fields for matching results.

    Matching strategy: for each in-flight model, we collect all log entries
    in chronological order; results are also processed in chronological
    order; we pair them up by index. Best-effort — a mis-pairing produces
    a slightly-wrong cost on one row but never crashes.
    """
    try:
        url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai-gateway/gateways/{GATEWAY_ID}/logs"
        # Request a generous window. The API caps per_page; loop if needed.
        all_logs: list[dict] = []
        for page_offset in range(5):  # up to 5 pages
            resp = client.get(
                url,
                headers={"Authorization": f"Bearer {cf_token}"},
                params={
                    "per_page": 50,
                    "order_by": "created_at",
                    "order_by_direction": "desc",
                    "page": page_offset + 1,
                },
                timeout=30.0,
            )
            if resp.status_code != 200:
                break
            page = resp.json().get("result", [])
            if not page:
                break
            all_logs.extend(page)
            if len(page) < 50:
                break
    except Exception:
        return

    # Group logs by normalised model name. Skip failed log entries (cost=0,
    # status >= 400) — those are stale earlier-run rejections that would
    # poison the matching against this run's successful results.
    log_by_model: dict[str, list[dict]] = {}
    for log in all_logs:
        if log.get("status_code", 0) != 200:
            continue
        norm = _normalise_log_model(log.get("provider") or "", log.get("model") or "")
        log_by_model.setdefault(norm, []).append(log)

    # Each provider's logs come back newest-first; reverse to chronological
    # to match the order we made the requests.
    for k in log_by_model:
        log_by_model[k] = list(reversed(log_by_model[k]))

    for r in results:
        candidates = log_by_model.get(r.model, [])
        if not candidates:
            continue
        # Pop the oldest unconsumed log for this model
        log = candidates.pop(0)
        r.cost_usd = float(log.get("cost") or 0.0)
        # Backfill tokens too (some compat translations don't expose usage
        # in the response body, but AI Gateway sees the upstream usage).
        if r.tokens_in is None:
            r.tokens_in = log.get("tokens_in")
        if r.tokens_out is None:
            r.tokens_out = log.get("tokens_out")


def main() -> int:
    load_dotenv(REPO_ROOT / ".env")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    cf_token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account_id or not cf_token:
        print(
            "ERROR: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env",
            file=sys.stderr,
        )
        return 2

    base_url = f"https://gateway.ai.cloudflare.com/v1/{account_id}/{GATEWAY_ID}/compat/chat/completions"
    print(f"Gateway: {base_url}")
    print(f"Models:  {len(MODELS)} -> {', '.join(MODELS)}")

    fixtures = _real_fixture_filenames()
    manifest = _load_manifest()
    print(f"Fixtures: {len(fixtures)} real-watch photos -> {', '.join(fixtures)}")
    print()

    results: list[Result] = []

    # Number of replicate runs per (fixture, model) for the production round.
    # 3 gives us a sense of variance without burning too much budget. Each
    # run uses a freshly-randomised EXIF anchor offset, so we also see how
    # robust the model is to small anchor perturbations.
    RUNS_PER_CELL = 3

    # Anchor robustness round — one run per fixture, anchor offset much
    # larger than the production-realistic ±10s window. Tests whether the
    # model echoes the anchor when its read disagrees materially. We only
    # run this against the leading model from round 1 (decided post-hoc
    # in a follow-up; for this script run we always include it for the
    # frontier models).
    ROBUSTNESS_OFFSETS = [-90, +90]
    ROBUSTNESS_FIXTURES = ["bambino_10_19_34.jpeg", "snk803_10_15_40.jpeg"]
    ROBUSTNESS_MODELS = ["openai/gpt-5.2"]

    # Use a fixed seed per (fixture, run) so the anchor offsets are
    # reproducible across re-runs of the script. Different models on the
    # same (fixture, run) see the same anchor — so any cross-model
    # comparison is fair.
    rng = random.Random(0xDEADBEEF)

    def _do_call(
        *,
        fixture: str,
        model: str,
        run_idx: int,
        anchor_mode: str,
        anchor_hms: str | None,
        anchor_offset: int | None,
        truth: str,
        image_url: str,
        prompt: str,
    ) -> Result:
        data, status, err, latency_ms = _call_model(
            client,
            base_url=base_url,
            cf_token=cf_token,
            model=model,
            image_url=image_url,
            prompt=prompt,
        )
        raw = _content_text(data)
        parsed = _parse_response_hms(raw) if raw else None
        full_err = _signed_error_seconds(parsed, truth) if parsed else None
        # MM:SS-only error (production-relevant)
        if parsed:
            p_mmss = _hms_to_seconds(parsed) % 3600
            t_mmss = _hms_to_seconds(truth) % 3600
            d = (p_mmss - t_mmss) % 3600
            if d > 1800:
                d -= 3600
            mmss_err = d
        else:
            mmss_err = None
        tin, tout, _ = _extract_tokens_and_cost(data)
        return Result(
            fixture=fixture,
            model=model,
            run=run_idx,
            anchor_mode=anchor_mode,
            anchor_hms=anchor_hms,
            anchor_offset_seconds=anchor_offset,
            truth_hms=truth,
            raw_response=raw,
            parsed_hms=parsed,
            error_seconds=full_err,
            mmss_error_seconds=mmss_err,
            latency_ms=latency_ms,
            tokens_in=tin,
            tokens_out=tout,
            cost_usd=None,
            success=err is None,
            http_status=status,
            error_message=err,
            full_response_json=data,
        )

    with httpx.Client(verify=_SSL_CONTEXT) as client:
        # ---- Round 1: production-realistic. EXIF anchor at truth ± 10s,
        #               3 replicate runs per (fixture, model). ----
        total = len(fixtures) * len(MODELS) * RUNS_PER_CELL
        i = 0
        print(
            f"=== Round 1: production-realistic ({len(fixtures)}f × {len(MODELS)}m × {RUNS_PER_CELL}r = {total} calls) ==="
        )
        for fixture in fixtures:
            meta = manifest[fixture]
            truth = _truth_hms(meta)
            image_url = _image_data_url(SMOKE_DIR / fixture, crop=ROUND_1_USE_CROP)
            crop_tag = " [cropped]" if ROUND_1_USE_CROP else ""
            print(f"\n[fixture] {fixture} (truth={truth}){crop_tag}")

            for run_idx in range(1, RUNS_PER_CELL + 1):
                # Same anchor offset for all models on the same (fixture, run)
                # so cross-model comparison sees identical inputs.
                offset = rng.randint(-10, 10)
                anchor = _anchor_with_offset(truth, offset)
                prompt = _build_prompt(anchor)
                print(f"  -- run {run_idx}: anchor={anchor} (offset={offset:+d}s)")

                for model in MODELS:
                    i += 1
                    r = _do_call(
                        fixture=fixture,
                        model=model,
                        run_idx=run_idx,
                        anchor_mode="anchor",
                        anchor_hms=anchor,
                        anchor_offset=offset,
                        truth=truth,
                        image_url=image_url,
                        prompt=prompt,
                    )
                    results.append(r)
                    tag = (
                        f"OK parsed={r.parsed_hms}  MM:SS err={r.mmss_error_seconds:+d}s"
                        if r.parsed_hms and r.mmss_error_seconds is not None
                        else f"FAIL http={r.http_status} raw={(r.raw_response or r.error_message or '')[:50]!r}"
                    )
                    print(
                        f"    [{i:>3}/{total}] {model:<48s} ({r.latency_ms:>5d}ms) {tag}"
                    )

        # ---- Round 2: robustness — large anchor offset, 1 run per cell. ----
        rounds_2_total = (
            len(ROBUSTNESS_FIXTURES) * len(ROBUSTNESS_MODELS) * len(ROBUSTNESS_OFFSETS)
        )
        print(
            f"\n=== Round 2: anchor robustness (large offset; {rounds_2_total} calls) ==="
        )
        for fixture in ROBUSTNESS_FIXTURES:
            if fixture not in manifest:
                continue
            meta = manifest[fixture]
            truth = _truth_hms(meta)
            image_url = _image_data_url(SMOKE_DIR / fixture)
            for offset in ROBUSTNESS_OFFSETS:
                anchor = _anchor_with_offset(truth, offset)
                prompt = _build_prompt(anchor)
                for model in ROBUSTNESS_MODELS:
                    r = _do_call(
                        fixture=fixture,
                        model=model,
                        run_idx=1,
                        anchor_mode="robustness_anchor",
                        anchor_hms=anchor,
                        anchor_offset=offset,
                        truth=truth,
                        image_url=image_url,
                        prompt=prompt,
                    )
                    results.append(r)
                    tag = (
                        f"parsed={r.parsed_hms} MM:SS err={r.mmss_error_seconds:+d}s"
                        if r.parsed_hms and r.mmss_error_seconds is not None
                        else f"FAIL http={r.http_status}"
                    )
                    print(f"  {fixture:<28s} offset={offset:+d}s  {model:<48s}  {tag}")

        # Backfill cost_usd from AI Gateway logs.
        time.sleep(2)
        _enrich_cost_from_logs(
            client, account_id=account_id, cf_token=cf_token, results=results
        )

    RESULTS_PATH.write_text(json.dumps([asdict(r) for r in results], indent=2))
    print(f"\nWrote {len(results)} results to {RESULTS_PATH.relative_to(REPO_ROOT)}")

    _write_report(results)
    print(f"Wrote report to {REPORT_PATH.relative_to(REPO_ROOT)}")
    return 0


def _write_report(results: list[Result]) -> None:
    """Render a markdown summary tailored to the anchored-prompt + 3-runs flow."""
    lines: list[str] = ["# VLM bake-off — dial-reader smoke corpus", ""]
    anchored = [r for r in results if r.anchor_mode == "anchor"]
    robustness = [r for r in results if r.anchor_mode == "robustness_anchor"]

    lines += [
        "Each (fixture, model) is run 3× with EXIF anchor = truth ± a fresh "
        "random offset in [-10, +10]s — production-realistic. The model sees "
        "a chain-of-thought prompt that walks it through hand identification "
        "(thinnest = second; shortest = hour; minute hand is the priority) "
        "and explicitly tells it NOT to echo the anchor. ",
        "",
        "**Production target: MM:SS error ≤ 5 s on every run, every fixture.** "
        "Only the minute+second components matter for verification (the hour "
        "comes from the server clock).",
        "",
    ]

    # ---- Per-model summary, aggregated over all runs and fixtures ----
    lines += ["## Per-model summary (production-realistic round)", ""]
    by_model: dict[str, list[Result]] = {}
    for r in anchored:
        by_model.setdefault(r.model, []).append(r)

    lines.append(
        "| Model | Parsed | MM:SS ≤ 5 s | ≤ 60 s | ≤ 5 min | median \\|err\\| | p90 \\|err\\| | mean latency | total cost |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for model, rs in by_model.items():
        n = len(rs)
        parsed_ok = sum(1 for r in rs if r.parsed_hms is not None)
        mmss_errs = [
            abs(r.mmss_error_seconds) for r in rs if r.mmss_error_seconds is not None
        ]
        within_5 = sum(1 for e in mmss_errs if e <= 5)
        within_60 = sum(1 for e in mmss_errs if e <= 60)
        within_5min = sum(1 for e in mmss_errs if e <= 300)
        median_str = f"{sorted(mmss_errs)[len(mmss_errs) // 2]}s" if mmss_errs else "—"
        p90_str = (
            f"{sorted(mmss_errs)[min(len(mmss_errs) - 1, int(len(mmss_errs) * 0.9))]}s"
            if mmss_errs
            else "—"
        )
        mean_latency = int(sum(r.latency_ms for r in rs) / n) if n else 0
        total_cost = sum(r.cost_usd or 0 for r in rs)
        lines.append(
            f"| `{model}` | {parsed_ok}/{n} | {within_5}/{n} | {within_60}/{n} | {within_5min}/{n} | {median_str} | {p90_str} | {mean_latency} ms | ${total_cost:.4f} |"
        )

    # ---- Per-fixture-per-model: 3 runs side by side ----
    lines += ["", "## Per-fixture × per-model (3 runs each)", ""]
    fixtures_in_order = sorted({r.fixture for r in anchored})
    for fixture in fixtures_in_order:
        truth = next(r.truth_hms for r in anchored if r.fixture == fixture)
        truth_mmss = truth[3:]
        rows = [r for r in anchored if r.fixture == fixture]
        lines.append(f"### `{fixture}` — truth `{truth}` (MM:SS = `{truth_mmss}`)")
        lines.append("")
        # Per (fixture, run) the anchor is identical across models — show it
        # once per run header.
        runs = sorted({r.run for r in rows})
        run_anchors = {r.run: (r.anchor_hms, r.anchor_offset_seconds) for r in rows}
        for run_idx in runs:
            anchor, offset = run_anchors[run_idx]
            lines.append(
                f"**Run {run_idx}** — anchor `{anchor}` (offset `{offset:+d}s`)"
            )
            lines.append("")
            lines.append("| Model | Predicted | MM:SS err | latency |")
            lines.append("|---|---|---|---|")
            for r in [rr for rr in rows if rr.run == run_idx]:
                pred = r.parsed_hms or "—"
                err = (
                    f"**{r.mmss_error_seconds:+d}s**"
                    if r.mmss_error_seconds is not None
                    and abs(r.mmss_error_seconds) <= 5
                    else f"{r.mmss_error_seconds:+d}s"
                    if r.mmss_error_seconds is not None
                    else "—"
                )
                if not r.success:
                    pred = "❌"
                    err = (r.error_message or "error")[:40]
                lines.append(f"| `{r.model}` | `{pred}` | {err} | {r.latency_ms} ms |")
            lines.append("")

    # ---- Robustness round ----
    if robustness:
        lines += [
            "## Robustness — anchor with large offset",
            "",
            "Anchor = truth ± 90s. The model should still read pixels and "
            "ignore the misleading anchor. If a model produces an answer "
            "≈ anchor in this round but ≈ truth in the production-realistic "
            "round, it's anchoring rather than reading.",
            "",
        ]
        lines.append(
            "| Fixture | Anchor | Model | Predicted | err vs truth | err vs anchor |"
        )
        lines.append("|---|---|---|---|---|---|")
        for r in robustness:
            pred = r.parsed_hms or "❌"
            err_truth = (
                f"{r.mmss_error_seconds:+d}s"
                if r.mmss_error_seconds is not None
                else "—"
            )
            # MM:SS error vs anchor (the lie)
            if r.parsed_hms and r.anchor_hms:
                p_mmss = _hms_to_seconds(r.parsed_hms) % 3600
                a_mmss = _hms_to_seconds(r.anchor_hms) % 3600
                d = (p_mmss - a_mmss) % 3600
                if d > 1800:
                    d -= 3600
                err_anchor = f"{d:+d}s"
            else:
                err_anchor = "—"
            lines.append(
                f"| `{r.fixture}` | `{r.anchor_hms}` ({r.anchor_offset_seconds:+d}s) | `{r.model}` | `{pred}` | {err_truth} | {err_anchor} |"
            )
        lines.append("")

    # ---- Footer ----
    lines += [
        "## Notes",
        "",
        "- All calls go through AI Gateway gateway `dial-reader-bakeoff`, "
        "billed via unified-billing credits.",
        "- MM:SS error wraps on the 60-min circle: a `+1799s` error means "
        "the read was 30 minutes off in the worse direction. Wrap-aware "
        "shortest-path is used so we never report `+3500s`.",
        "- Bold MM:SS errors (e.g. **`-2s`**) hit the production target.",
        "",
        f"_Generated by `scripts/vlm-bakeoff/bakeoff.py` at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}._",
        "",
    ]
    REPORT_PATH.write_text("\n".join(lines))


if __name__ == "__main__":
    raise SystemExit(main())
