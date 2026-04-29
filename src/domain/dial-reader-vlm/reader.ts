// Worker-side VLM dial reader — median-of-3 + anchor-guard pipeline.
//
// Slice #5 of PRD #99 (issue #104) replaces the slice-#3 single-call
// reader with three parallel chat-completion calls, a median MM:SS
// computation, and the anchor-disagreement guard from
// `./anchor-guard.ts`.
//
// Pipeline:
//
//   1. Build a single prompt + image once.
//   2. Fan out THREE concurrent `runChatCompletion` calls with the
//      same request body. Same image, same prompt, same anchor — the
//      diversity comes from the model's stochastic decoding.
//   3. For each result: parse via `./parse.ts`. Successes go into a
//      pool of `{ m, s }` reads; failures (transport throws, empty
//      content, gibberish) are tracked separately.
//   4. Compute the median over the parsed reads:
//        * 3 of 3 parsed → sort by seconds-within-the-hour and take
//          index [1].
//        * 2 of 3 parsed → average them (rounded). Two values are
//          their own median.
//        * 1 of 3 parsed → return rejection: unparseable_majority.
//        * 0 of 3 parsed → if all 3 threw → transport_error;
//                          otherwise → rejection: all_runs_failed.
//   5. Pass the median + anchor + individual reads through
//      `checkAnchor`. The guard's outcome maps 1-to-1 onto the
//      reader's result variants:
//        * accept                       → success
//        * reject_anchor_disagreement   → rejection (anchor_disagreement)
//        * flag_suspicious_anchor_echo  → rejection (anchor_echo_suspicious)
//
// Production wiring (the route handler in `src/server/routes/readings.ts`)
// calls this once per verified-reading attempt. Three parallel calls
// roughly triples the upstream cost per attempt — accepted; the bake-off
// data shows median-of-3 closes the gap from "78 % of individual reads
// within ±5 s" to "5/6 fixture medians within ±5 s".

import { buildPrompt } from "./prompt";
import { parseHmsResponse, type ParsedHms } from "./parse";
import { checkAnchor } from "./anchor-guard";
import type {
  AiClient,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatContentPart,
  ChatMessage,
} from "./ai-client";
import type { DialReadResult, ReadDialInput } from "./types";

/**
 * Default AI Gateway slug. Production overrides this via the
 * `AI_GATEWAY_ID` env var (the production gateway `ratedwatch-vlm`
 * is created in slice #9). We default to the existing bake-off
 * gateway so dev/test environments work without configuration.
 */
const DEFAULT_GATEWAY_ID = "dial-reader-bakeoff";

/** Production candidate model — validated in the bake-off. */
const MODEL = "openai/gpt-5.2";

/**
 * Bake-off-validated reasoning budget. With `reasoning_effort: "low"`
 * GPT-5.2 still chains-of-thought internally but stops far earlier;
 * 4000 tokens is the headroom needed for the visible HH:MM:SS line
 * to land. Lower values risk the model exhausting its budget on
 * hidden reasoning before emitting any visible output.
 */
const MAX_COMPLETION_TOKENS = 4000;

/** How many parallel calls to fan out per dial read. */
const PARALLEL_CALLS = 3;

/** Inputs the reader needs from the host environment. */
export interface ReadDialDeps {
  ai: AiClient;
  /**
   * AI Gateway slug (route through this gateway for caching, logs,
   * unified billing). Optional — defaults to the bake-off gateway.
   */
  gatewayId?: string;
}

// ---------------------------------------------------------------------
// Test override hook
// ---------------------------------------------------------------------
//
// Mirrors the `__setTestExifReader` / `__setTestRateLimiter` pattern
// already in the codebase. The slice-#4 integration tests (issue
// #103) need a way to drive `readDial` deterministically without
// making real AI Gateway calls — `vitest.config.ts` sets
// `remoteBindings: false`, so the production env.AI path can't reach
// the gateway from miniflare anyway.
//
// Pass `null` in a teardown hook to clear.

type ReadDialFn = (input: ReadDialInput, deps: ReadDialDeps) => Promise<DialReadResult>;

let testReadDial: ReadDialFn | null = null;

/**
 * TEST-ONLY. Install a fake `readDial`. Subsequent calls route
 * through `fn` until cleared. Used by integration tests in
 * `tests/integration/readings.verified.test.ts` to drive the route
 * deterministically with the bake-off-validated answers.
 */
export function __setTestReadDial(fn: ReadDialFn | null): void {
  testReadDial = fn;
}

/**
 * Per-call outcome inside the median-of-3 fan-out. We retain the
 * full failure context so the orchestrator can decide between
 * `unparseable_majority`, `all_runs_failed`, and `transport_error`.
 */
type ParallelOutcome =
  | {
      ok: true;
      parsed: ParsedHms;
      rawContent: string;
      tokensIn?: number;
      tokensOut?: number;
    }
  | { ok: false; reason: "transport"; message: string }
  | { ok: false; reason: "unparseable"; rawContent: string };

/**
 * Run a single VLM chat-completion call and lift the outcome into a
 * `ParallelOutcome`. Pure helper; never throws.
 */
async function runOne(
  ai: AiClient,
  req: ChatCompletionRequest,
): Promise<ParallelOutcome> {
  let response: ChatCompletionResponse;
  try {
    response = await ai.runChatCompletion(req);
  } catch (err) {
    return { ok: false, reason: "transport", message: errorMessage(err) };
  }

  const rawContent = extractContent(response);
  if (rawContent === null) {
    return { ok: false, reason: "unparseable", rawContent: "" };
  }

  const parsed = parseHmsResponse(rawContent);
  if (!parsed) {
    return { ok: false, reason: "unparseable", rawContent };
  }

  const usage = response.usage ?? {};
  const out: ParallelOutcome = { ok: true, parsed, rawContent };
  if (typeof usage.prompt_tokens === "number") {
    out.tokensIn = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    out.tokensOut = usage.completion_tokens;
  }
  return out;
}

/**
 * Compute the median MM:SS across 1-3 parsed reads. Returns `null`
 * for an empty input — the caller has already decided that's a
 * rejection by the time it reaches this helper.
 *
 * For 3 reads: convert each to seconds-within-the-hour, sort, take
 * the middle. For 2 reads: average them (rounded). For 1 read:
 * the call-site never invokes this helper with a single read — the
 * orchestrator routes straight to `unparseable_majority` instead —
 * so this branch is only here for completeness.
 */
function medianMmSs(reads: ParsedHms[]): { m: number; s: number } | null {
  if (reads.length === 0) {
    return null;
  }
  const totals = reads.map((r) => r.m * 60 + r.s);
  totals.sort((a, b) => a - b);
  let median: number;
  if (totals.length === 3) {
    median = totals[1]!;
  } else if (totals.length === 2) {
    // `(a + b) / 2` rounded. With integer inputs in [0, 3599] this
    // is safe — no overflow.
    median = Math.round((totals[0]! + totals[1]!) / 2);
  } else {
    // length === 1
    median = totals[0]!;
  }
  return { m: Math.floor(median / 60), s: median % 60 };
}

/**
 * Run a verified dial-read.
 *
 * Always resolves; never throws. Transport / network failures (when
 * ALL parallel calls fail at the network layer) surface as
 * `{ kind: "transport_error" }`. Mixed failures (some transport, some
 * unparseable) collapse into `unparseable_majority` or
 * `all_runs_failed` per the median rules above.
 */
export async function readDial(
  input: ReadDialInput,
  deps: ReadDialDeps,
): Promise<DialReadResult> {
  if (testReadDial) {
    return testReadDial(input, deps);
  }
  const prompt = buildPrompt(input.exifAnchor);
  const dataUrl = encodeAsJpegDataUrl(input.croppedImage);

  const message: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: dataUrl } },
    ],
  };

  const req: ChatCompletionRequest = {
    model: MODEL,
    messages: [message],
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    reasoning_effort: "low",
    gateway_id: deps.gatewayId ?? DEFAULT_GATEWAY_ID,
  };

  // Fan out PARALLEL_CALLS concurrent calls. We use Promise.all
  // (not Promise.allSettled) because `runOne` already lifts every
  // failure into a structured `ParallelOutcome` — there are no
  // unhandled rejections to worry about.
  const calls: Array<Promise<ParallelOutcome>> = [];
  for (let i = 0; i < PARALLEL_CALLS; i++) {
    calls.push(runOne(deps.ai, req));
  }
  const outcomes = await Promise.all(calls);

  // Tally the outcome buckets.
  const successes = outcomes.filter(
    (o): o is Extract<ParallelOutcome, { ok: true }> => o.ok,
  );
  const transportFailures = outcomes.filter(
    (o): o is Extract<ParallelOutcome, { ok: false; reason: "transport" }> =>
      !o.ok && o.reason === "transport",
  );
  const unparseableFailures = outcomes.filter(
    (o): o is Extract<ParallelOutcome, { ok: false; reason: "unparseable" }> =>
      !o.ok && o.reason === "unparseable",
  );

  // 0 successes — pick between transport_error and all_runs_failed.
  if (successes.length === 0) {
    if (transportFailures.length === outcomes.length) {
      // All three threw at the network layer. Surface the first
      // message — they're typically the same anyway, and the caller
      // doesn't get to retry per-call.
      return {
        kind: "transport_error",
        message: transportFailures[0]!.message,
      };
    }
    // Mixed (or all unparseable). Treat as a model-side refusal.
    return {
      kind: "rejection",
      reason: "all_runs_failed",
    };
  }

  // 1 of 3 successes — not enough signal for a median.
  if (successes.length === 1) {
    return {
      kind: "rejection",
      reason: "unparseable_majority",
    };
  }

  // 2-or-3 successes — compute the median.
  const parsedReads = successes.map((s) => s.parsed);
  const median = medianMmSs(parsedReads);
  if (!median) {
    // Defensive: medianMmSs only returns null for an empty input,
    // and we're in the ≥ 2 success branch. If we ever land here it
    // means the helper changed shape — fail closed.
    return {
      kind: "rejection",
      reason: "unparseable_majority",
    };
  }

  // Apply the anchor guard. The anchor's hour is irrelevant on the
  // MM:SS axis — we only pass the m/s components.
  const anchorMmSs = { m: input.exifAnchor.m, s: input.exifAnchor.s };
  const guardResult = checkAnchor({
    medianMmSs: median,
    anchorMmSs,
    individualReads: parsedReads.map((r) => ({ m: r.m, s: r.s })),
  });

  if (guardResult.kind === "reject_anchor_disagreement") {
    return {
      kind: "rejection",
      reason: "anchor_disagreement",
      details: { delta_seconds: guardResult.delta_seconds },
    };
  }
  if (guardResult.kind === "flag_suspicious_anchor_echo") {
    return {
      kind: "rejection",
      reason: "anchor_echo_suspicious",
    };
  }

  // accept — build the success result.
  const rawResponses = successes.map((s) => s.rawContent);
  const tokensInTotal = sumDefined(successes.map((s) => s.tokensIn));
  const tokensOutTotal = sumDefined(successes.map((s) => s.tokensOut));

  const result: DialReadResult = {
    kind: "success",
    mm_ss: median,
    raw_responses: rawResponses,
  };
  if (tokensInTotal !== undefined) {
    result.tokens_in_total = tokensInTotal;
  }
  if (tokensOutTotal !== undefined) {
    result.tokens_out_total = tokensOutTotal;
  }
  return result;
}

/** Sum the defined numbers in an array; returns `undefined` if all are undefined. */
function sumDefined(xs: Array<number | undefined>): number | undefined {
  let total = 0;
  let any = false;
  for (const x of xs) {
    if (typeof x === "number") {
      total += x;
      any = true;
    }
  }
  return any ? total : undefined;
}

/**
 * Encode an `ArrayBuffer` of JPEG bytes as a `data:image/jpeg;base64,…`
 * URL suitable for the OpenAI-compat `image_url` content part.
 *
 * Workers' global `btoa` operates on Latin-1 strings; we go through
 * a per-byte string to stay binary-clean. For images larger than ~a
 * few hundred KB this is non-trivial work; the dial-cropper from
 * slice #2 produces 768×768 JPEGs ~50–100 KB, so the synchronous
 * cost is negligible.
 */
function encodeAsJpegDataUrl(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Build the binary string in CHUNK-sized pieces — `String.fromCharCode`
  // with a giant spread can blow the call-stack on multi-MB images.
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    parts.push(String.fromCharCode(...slice));
  }
  const binary = parts.join("");
  const b64 = btoa(binary);
  return `data:image/jpeg;base64,${b64}`;
}

/**
 * Pull the assistant's text content out of a chat-completion
 * response. Returns `null` when the response has no choices, the
 * content is null, or it's an array of parts with no text.
 */
function extractContent(resp: ChatCompletionResponse): string | null {
  const choice = resp.choices[0];
  if (!choice) {
    return null;
  }
  const content = choice.message.content;
  if (content === null || content === undefined) {
    return null;
  }
  if (typeof content === "string") {
    return content;
  }
  // Some compat layer translations return content as an array of
  // structured parts. Concatenate text parts; ignore image parts
  // (the model never emits images in our flow but be defensive).
  const texts = content
    .filter(
      (p: ChatContentPart): p is { type: "text"; text: string } => p.type === "text",
    )
    .map((p) => p.text);
  if (texts.length === 0) {
    return null;
  }
  return texts.join("\n");
}

/** Coerce any thrown value into a string for the transport_error message. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
