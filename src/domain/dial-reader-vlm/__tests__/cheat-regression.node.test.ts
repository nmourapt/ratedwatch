// CI cheat-detection regression — slice 8 of PRD #99 (issue #107).
//
// Calls the REAL `dial-reader-bakeoff` AI Gateway with deliberately-shifted
// EXIF anchors (±90s offset from truth) on 2 smoke fixtures and asserts the
// model's output is NOT byte-identical to the (false) anchor. This catches
// the anchor-echo cheat that disqualified Claude Opus 4.5 in the bake-off
// (it echoed the EXIF anchor verbatim 17/18 times instead of reading
// pixels).
//
// We chose `openai/gpt-5.2` specifically because it passes this test today;
// this file makes that property a CI-enforced invariant. If a future model
// upgrade or prompt edit weakens the anti-echo behaviour, this test fails
// LOUDLY and blocks the merge.
//
// Methodology mirrors the bake-off's "Round 2: anchor robustness" exactly:
//   - same fixtures: bambino_10_19_34.jpeg, snk803_10_15_40.jpeg
//   - same offsets: ±90s
//   - same model + same prompt + same gateway as production
//   - UNCROPPED images, matching the bake-off methodology — the cheat is
//     about the model echoing the anchor regardless of pixel content, so
//     we measure on the raw input shape (matches `bakeoff.py` Round 2,
//     where `_image_data_url(...)` is called WITHOUT crop=True).
//
// We deliberately skip the dial-cropper here for two reasons:
//   1. Methodological: the bake-off's cheat-detection round used uncropped
//      images. Reproducing those exact conditions keeps this test honest as
//      a regression against the bake-off's findings.
//   2. Practical: `cropToDial` requires the Workers `IMAGES` binding which
//      is unavailable in the Node test pool. This test uses pure
//      Node + REST against the AI Gateway compat endpoint, which keeps it
//      runnable from CI (and locally) without miniflare overhead.
//
// Cost: 4 real calls × ~$0.005/call = ~$0.02 per CI run. Combined with
// the weekly schedule + path-filtered PR runs, we expect ~$1/month
// against the Babybites unified-billing pool.
//
// Skipping: in local dev / CI without `CHEAT_REGRESSION_AI_GATEWAY` set,
// the entire describe block is skipped — pure-functional TDD churn never
// burns gateway credits.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { readDial } from "../reader";
import type {
  AiClient,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../ai-client";
import type { DialReadResult, ExifAnchor } from "../types";

// ---------------------------------------------------------------------
// Test gating
// ---------------------------------------------------------------------
//
// Three env vars must be set for the test to actually fire:
//   - CHEAT_REGRESSION_AI_GATEWAY  — gateway slug (typically "dial-reader-bakeoff")
//   - CLOUDFLARE_API_TOKEN         — token with AI Gateway access
//   - CLOUDFLARE_ACCOUNT_ID        — the Babybites account
// Missing any one → the whole describe block is skipped. CI sets all
// three; local devs leave them unset and pay nothing.

const GATEWAY_ID = process.env.CHEAT_REGRESSION_AI_GATEWAY;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const SHOULD_RUN = !!(GATEWAY_ID && CF_TOKEN && CF_ACCOUNT);

const __dirname = dirname(fileURLToPath(import.meta.url));
// Path: src/domain/dial-reader-vlm/__tests__ → repo root + scripts/vlm-bakeoff/fixtures/smoke
const FIXTURE_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "vlm-bakeoff",
  "fixtures",
  "smoke",
);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface FixtureTruth {
  readonly h: number; // 12-hour clock, 1-12
  readonly m: number;
  readonly s: number;
}

const FIXTURES: ReadonlyArray<readonly [string, FixtureTruth]> = [
  ["bambino_10_19_34.jpeg", { h: 10, m: 19, s: 34 }],
  ["snk803_10_15_40.jpeg", { h: 10, m: 15, s: 40 }],
] as const;

const ANCHOR_OFFSETS: readonly number[] = [-90, +90];

/** Convert a 12-hour HMS triple to seconds-since-12:00 in [0, 43200). */
function hmsToSeconds(t: FixtureTruth): number {
  const h12 = t.h % 12;
  return h12 * 3600 + t.m * 60 + t.s;
}

/**
 * Shift `truth` by `offsetSeconds` (signed) and wrap on the 12-hour
 * dial. Returns the resulting `{h: 1-12, m, s}` triple. This mirrors
 * `_anchor_with_offset` from `scripts/vlm-bakeoff/bakeoff.py` so the
 * offsets are reproducible against the bake-off.
 */
export function applyAnchorOffset(
  truth: FixtureTruth,
  offsetSeconds: number,
): ExifAnchor {
  const base = hmsToSeconds(truth);
  // Modulo with negative inputs needs the +43200 trick — JS `%` is sign-preserving.
  const shifted = (((base + offsetSeconds) % 43200) + 43200) % 43200;
  const h0 = Math.floor(shifted / 3600);
  const h: number = h0 === 0 ? 12 : h0;
  const m: number = Math.floor((shifted % 3600) / 60);
  const s: number = shifted % 60;
  return { h, m, s };
}

/**
 * Smallest signed delta in seconds (modulo 30 minutes) between two
 * MM:SS triples. We compare on the 60-minute circle (1800s) so that
 * +1799 → -1; values stay in [-1800, +1800]. This matches the
 * production-relevant error metric used in the bake-off's
 * `mmss_error_seconds`.
 */
export function mmssDeltaSeconds(
  a: { m: number; s: number },
  b: { m: number; s: number },
): number {
  const aSec = a.m * 60 + a.s;
  const bSec = b.m * 60 + b.s;
  let d = (aSec - bSec) % 3600;
  if (d > 1800) d -= 3600;
  if (d < -1800) d += 3600;
  return d;
}

/**
 * REST-based `AiClient` that calls the AI Gateway compat endpoint
 * directly via fetch. Mirrors the bake-off harness's request shape
 * (`scripts/vlm-bakeoff/bakeoff.py::_call_model`). Production uses
 * `env.AI.run(...)` instead, but the WIRE PROTOCOL — model id, body,
 * gateway slug, prompt, image — is identical.
 */
function createRestAiClient(opts: { accountId: string; cfToken: string }): AiClient {
  return {
    async runChatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const url = `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${req.gateway_id}/compat/chat/completions`;
      const body = {
        model: req.model,
        messages: req.messages,
        max_completion_tokens: req.max_completion_tokens,
        reasoning_effort: req.reasoning_effort,
      };
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          // AI Gateway authentication header — same one the bake-off uses.
          "cf-aig-authorization": `Bearer ${opts.cfToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        // The production reader has no client timeout; gateway's internal
        // timeouts apply. We add a generous 120s here as a safety net so a
        // hung connection fails the test rather than the whole CI run.
        signal: AbortSignal.timeout(120_000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "<no body>");
        throw new Error(`AI Gateway HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }
      return (await resp.json()) as ChatCompletionResponse;
    },
  };
}

/** Read a smoke fixture from disk into an ArrayBuffer. */
function loadFixture(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURE_DIR, name));
  // Detach to a fresh ArrayBuffer (Node's Buffer-backed slice can be
  // surprising if downstream code reuses the underlying allocation).
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

// ---------------------------------------------------------------------
// The actual test
// ---------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("VLM dial-reader: cheat-detection regression", () => {
  // Each call is ~10-20s end-to-end (GPT-5.2 with reasoning_effort=low,
  // ~5-10s of latency + JSON parsing + transit). 60s per test is roomy.
  const PER_TEST_TIMEOUT_MS = 60_000;

  for (const [fixture, truth] of FIXTURES) {
    for (const offset of ANCHOR_OFFSETS) {
      const offsetLabel = offset >= 0 ? `+${offset}` : `${offset}`;

      it(
        `fixture ${fixture}, anchor offset ${offsetLabel}s — model does NOT echo anchor`,
        async () => {
          const ai = createRestAiClient({ accountId: CF_ACCOUNT!, cfToken: CF_TOKEN! });
          const anchor = applyAnchorOffset(truth, offset);
          const croppedImage = loadFixture(fixture);
          const runId = `cheat-regression-${fixture}-${offsetLabel}s`;

          const result: DialReadResult = await readDial(
            { croppedImage, exifAnchor: anchor, runId },
            { ai, gatewayId: GATEWAY_ID! },
          );

          // We accept "success" or "unparseable" as non-pathological
          // outcomes for this test. We do NOT accept "transport_error" —
          // that would mask a real cheat-echo by hiding behind a network
          // failure. CI must surface transport errors visibly.
          if (result.kind === "transport_error") {
            throw new Error(
              `Transport error reaching AI Gateway: ${result.message}. ` +
                `Cheat-detection cannot be evaluated. Investigate gateway ` +
                `availability and CF_TOKEN scope before re-running.`,
            );
          }

          if (result.kind === "unparseable") {
            // The model returned something but we couldn't extract HH:MM:SS.
            // This is not an anchor-echo (it's a different failure mode), so
            // we don't fail the regression test. Log for visibility — the
            // weekly run will pick up persistent unparseables across the
            // pair (which would suggest model degradation).
            // eslint-disable-next-line no-console
            console.warn(
              `[cheat-regression] ${fixture} offset ${offsetLabel}s: ` +
                `model returned unparseable response (no HH:MM:SS). ` +
                `Raw: ${result.raw_response.slice(0, 200)}`,
            );
            return;
          }

          // ---- THE HARD ASSERTION ----
          //
          // If the model echoed the (false) anchor's MM:SS verbatim, fail
          // the test with a loud, unambiguous message. Allow ±5s wiggle
          // room — a coincidental match within 5s of the lying anchor on
          // a single fixture is plausible noise (the truth is 90s away,
          // so a "real" pixel-read should land near the truth, not the
          // anchor). A tight match (≤5s) to the anchor is the cheat
          // signature.
          const anchorMmSs = { m: anchor.m, s: anchor.s };
          const echoDistance = Math.abs(mmssDeltaSeconds(result.mm_ss, anchorMmSs));

          // Compute the truth-distance for the failure message context.
          const truthMmSs = { m: truth.m, s: truth.s };
          const truthDistance = Math.abs(mmssDeltaSeconds(result.mm_ss, truthMmSs));

          if (echoDistance <= 5) {
            const predicted = `${pad(result.mm_ss.m)}:${pad(result.mm_ss.s)}`;
            const anchorStr = `${pad(anchor.m)}:${pad(anchor.s)}`;
            const truthStr = `${pad(truth.m)}:${pad(truth.s)}`;
            throw new Error(
              [
                "",
                "ANCHOR-ECHO REGRESSION DETECTED: model 'openai/gpt-5.2' returned MM:SS = anchor's",
                `MM:SS exactly on fixture ${fixture} with anchor offset ${offsetLabel}s.`,
                "This is the same cheat that disqualified Claude Opus 4.5 in PRD #99's bake-off.",
                "Either the model has degraded OR the prompt has been weakened. DO NOT MERGE.",
                "Investigate before flipping the verified_reading_cv flag back on.",
                "",
                `  Anchor (false):  ${anchorStr}  (truth ${offsetLabel}s)`,
                `  Truth:           ${truthStr}`,
                `  Model returned:  ${predicted}`,
                `  Distance to anchor: ${echoDistance}s   (≤ 5s = anchor-echo)`,
                `  Distance to truth:  ${truthDistance}s`,
                "",
              ].join("\n"),
            );
          }

          // ---- SOFT ASSERTION (warn-only) ----
          //
          // The model SHOULD also be reasonably close to truth — within
          // ±5min is a generous band that lets occasional mis-reads pass
          // without failing the regression. Wide misses are logged so the
          // weekly run flags drift even when the anti-echo property holds.
          if (truthDistance > 300) {
            const predicted = `${pad(result.mm_ss.m)}:${pad(result.mm_ss.s)}`;
            const truthStr = `${pad(truth.m)}:${pad(truth.s)}`;
            // eslint-disable-next-line no-console
            console.warn(
              `[cheat-regression] ${fixture} offset ${offsetLabel}s: ` +
                `model is far from truth (>5min). predicted=${predicted}, ` +
                `truth=${truthStr}, distance=${truthDistance}s. Anti-echo ` +
                `still passed — investigate model accuracy in the weekly run.`,
            );
          }

          // Pass-through assertion to give vitest a counter to tick. The
          // real failure mode is the throw above; this just makes the test
          // explicit about what success looks like.
          expect(echoDistance).toBeGreaterThan(5);
        },
        PER_TEST_TIMEOUT_MS,
      );
    }
  }
});

// ---------------------------------------------------------------------
// Pure helpers — also exercised when the gateway test is skipped, so
// `applyAnchorOffset` and `mmssDeltaSeconds` are guarded against drift
// even on local dev runs.
// ---------------------------------------------------------------------

describe("cheat-regression helpers (pure functions)", () => {
  it("applyAnchorOffset shifts forwards within the same minute", () => {
    expect(applyAnchorOffset({ h: 10, m: 19, s: 34 }, +30)).toEqual({
      h: 10,
      m: 20,
      s: 4,
    });
  });

  it("applyAnchorOffset shifts backwards across minute boundaries", () => {
    expect(applyAnchorOffset({ h: 10, m: 19, s: 34 }, -90)).toEqual({
      h: 10,
      m: 18,
      s: 4,
    });
  });

  it("applyAnchorOffset wraps across the 12-hour boundary going forward", () => {
    // 11:59:50 + 30s = 00:00:20 → renders as 12:00:20 in 12-hour form.
    expect(applyAnchorOffset({ h: 11, m: 59, s: 50 }, +30)).toEqual({
      h: 12,
      m: 0,
      s: 20,
    });
  });

  it("applyAnchorOffset wraps across the 12-hour boundary going backward", () => {
    // 12:00:10 (= 0s on the 12h axis) - 20s = -20 ≡ 11:59:40.
    expect(applyAnchorOffset({ h: 12, m: 0, s: 10 }, -20)).toEqual({
      h: 11,
      m: 59,
      s: 50,
    });
  });

  it("mmssDeltaSeconds returns 0 on identical MM:SS", () => {
    expect(mmssDeltaSeconds({ m: 19, s: 34 }, { m: 19, s: 34 })).toBe(0);
  });

  it("mmssDeltaSeconds is signed: predicted ahead of reference is positive", () => {
    expect(mmssDeltaSeconds({ m: 19, s: 40 }, { m: 19, s: 34 })).toBe(6);
  });

  it("mmssDeltaSeconds wraps shortest-path on the 60-minute circle", () => {
    // 0:01 vs 59:59 → +2s, not -3598s.
    expect(mmssDeltaSeconds({ m: 0, s: 1 }, { m: 59, s: 59 })).toBe(2);
  });

  it("mmssDeltaSeconds returns -90 for an anchor 90s ahead of truth", () => {
    // Truth = 19:34, anchor = 21:04 (truth + 90s). Predicted-as-truth
    // vs anchor → -90s.
    expect(mmssDeltaSeconds({ m: 19, s: 34 }, { m: 21, s: 4 })).toBe(-90);
  });
});

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
