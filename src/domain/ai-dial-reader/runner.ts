// Thin indirection between the AI dial reader and the actual Workers
// AI binding. Lets integration tests override the "AI runner" with a
// canned fake without having to plumb an alternate binding through
// miniflare (AI bindings always resolve remotely, which the pool
// treats specially).
//
// Semantics:
//
//   * Production path: `resolveAiRunner(env)` returns a function that
//     delegates to `env.AI.run(DIAL_MODEL, { messages, image }, { gateway })`
//     and extracts the assistant's text reply from the model's response.
//     Every call is routed through the AI Gateway named by
//     `AI_GATEWAY_ID` — that's the single pane for request logs, rate
//     limiting, and (future) cache / fallback policies.
//
//   * Test path: the integration-test file imports `__setTestAiRunner`
//     and installs a stub that returns a canned response. Because
//     vitest-pool-workers runs the Worker and the tests in the same
//     workerd process per test file, module-level state is shared —
//     this works without any miniflare binding override.
//
// The production code never touches `__setTestAiRunner` and never
// reads the module-level `testRunner` ref directly. The only place
// that matters is `resolveAiRunner`, which routes to the fake when
// one is installed.
//
// The `AiRunner` contract returns a `{ response: string }` — the
// extracted assistant text — regardless of which underlying model
// the runner chose. That keeps the reader layer (reader.ts) free of
// model-specific response shapes; if we ever swap models, only this
// file changes.

/**
 * Dial-reader model. Llama 3.2 11B Vision Instruct is Meta's
 * vision-capable instruction-tuned model on Workers AI, with a
 * documented and proven `image: number[]` input shape.
 *
 * History: we previously used `@cf/moonshotai/kimi-k2.6` with an
 * OpenAI-compat `image_url` content part. Despite Kimi K2.6 being
 * advertised as vision-capable and the binding accepting that schema,
 * production AI Gateway logs showed the image was NOT being embedded
 * (291 input tokens for a request that should have been 1000+) and
 * the model replied NO_DIAL because it was processing text only. The
 * upstream Workers AI inference path for K2.6 is not (yet) wiring
 * vision through. We swap to Llama 3.2 vision which has a working
 * documented vision pipeline.
 *
 * Pricing: $0.049 / M input tokens, $0.68 / M output tokens. Cheaper
 * than Kimi K2.6 ($0.95 / M input). Slightly weaker reasoning, but
 * the dial-reading prompt is concrete enough that this is a worthy
 * trade for a working pipeline.
 *
 * Operator note: first call to this model on a fresh account requires
 * sending `{ prompt: "agree" }` once to accept the Meta license. See
 * https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/.
 */
export const DIAL_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/**
 * AI Gateway slug. Every `env.AI.run(...)` in this codebase routes
 * through this gateway, provisioned by
 * infra/terraform/ai-gateway.tf. Keep the two literals in sync.
 *
 * Exported so future AI callers (e.g. a different model for
 * movement-name normalisation) can import the same constant instead
 * of hardcoding the slug.
 */
export const AI_GATEWAY_ID = "ratedwatch";

export interface AiRunInputs {
  /**
   * JPEG bytes. The runner base64-encodes them into a `data:image/
   * jpeg;base64,...` URL and attaches the result as an `image_url`
   * content part on the user message — the OpenAPI-prescribed
   * multimodal shape for `@cf/meta/llama-3.2-11b-vision-instruct`
   * (the legacy top-level `image: number[]` field is deprecated and
   * ~3x slower at multi-MB photo sizes).
   */
  image: Uint8Array;
  /**
   * The prompt text. The runner wraps this in a chat-messages
   * envelope (system + user) with the image attached as a sibling
   * content part. The reader builds a single prompt string and
   * leaves the multimodal envelope to the runner.
   */
  prompt: string;
}

export interface AiRunResponse {
  /**
   * The assistant's text reply, extracted from Llama vision's
   * top-level `response` field. `undefined` if the upstream
   * response is malformed — the reader defensively treats that as
   * an unparseable read.
   */
  response?: string;
}

export type AiRunner = (inputs: AiRunInputs) => Promise<AiRunResponse>;

export interface AiRunnerEnv {
  AI: Ai;
}

// Test-only module-level override. `null` ⇒ use the real env.AI.
let testRunner: AiRunner | null = null;

/**
 * TEST-ONLY. Install a fake AI runner that every call to
 * `resolveAiRunner` returns until cleared. Call with `null` in a
 * test teardown hook to restore the default.
 *
 * Deliberately not exported from index.ts — this lives under the
 * runner module and must be imported directly by the test file that
 * uses it. That keeps accidental production calls close to impossible.
 */
export function __setTestAiRunner(fn: AiRunner | null): void {
  testRunner = fn;
}

// --- Llama 3.2 vision request shape --------------------------------
//
// Llama 3.2 vision via the Workers AI binding accepts the OpenAI-
// compatible chat-completion shape with multimodal content parts:
//
//   {
//     messages: [
//       { role: "system", content: "<text>" },
//       {
//         role: "user",
//         content: [
//           { type: "text", text: "<prompt>" },
//           { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } },
//         ],
//       },
//     ],
//     max_tokens: <int>,
//     temperature: <float>,
//   }
//
// Why this shape over the legacy top-level `image: number[]` field:
//
//   1. The OpenAPI schema for this model marks the top-level `image`
//      field DEPRECATED ("Deprecated, use image as a part of messages
//      now."). The binding still accepts it, but it's a slow path that
//      serializes a 2 MB JPEG into ~8 MB of JSON-array text. Empirical
//      probing (Apr 2026) showed ~3x latency vs the data-URL form on a
//      1.5 MB payload — and on real cellular-uploaded photos the slow
//      path was visibly stalling the verified-reading flow long enough
//      that users perceived it as a hang.
//
//   2. Base64 of the bytes is ~1.33x the original size; JSON-array of
//      bytes is ~4x. Smaller wire payload → faster binding round-trip.
//
//   3. This is the shape the Workers AI docs prescribe for new code.
//
// History footnote: we tried this shape with @cf/moonshotai/kimi-k2.6
// in #67's predecessor and the binding silently dropped the image_url
// part (Kimi K2.6's vision input wasn't wired through). For
// @cf/meta/llama-3.2-11b-vision-instruct the binding does honor the
// content-parts form — verified by direct cf-api probing returning
// HTTP 200 + a real assistant reply on real images.

interface LlamaTextPart {
  type: "text";
  text: string;
}

interface LlamaImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

type LlamaContentPart = LlamaTextPart | LlamaImageUrlPart;

interface LlamaVisionMessage {
  role: "system" | "user" | "assistant";
  content: string | LlamaContentPart[];
}

interface LlamaVisionRequest {
  messages: LlamaVisionMessage[];
  max_tokens: number;
  temperature: number;
}

interface LlamaVisionResponse {
  response?: string;
}

const SYSTEM_PROMPT =
  "You are a watch-dial reader. You answer with a single token and nothing else.";

/**
 * Cap on tokens generated by the model. The valid replies are at
 * most ~6 characters ("UNREADABLE" is 10 chars / ~3-4 tokens,
 * "MM:SS" is 3-5 tokens). 32 gives plenty of headroom while bounding
 * pathological cases where the model decides to ramble despite the
 * system prompt.
 */
const MAX_TOKENS = 32;

/**
 * Low temperature pulls the model toward its most confident output.
 * Dial reading is a deterministic perception task — we don't want
 * creative variance. 0 is "argmax"; 0.1 leaves a sliver of room in
 * case the model's argmax path is a degenerate token.
 */
const TEMPERATURE = 0.1;

/**
 * Encode raw JPEG bytes as a `data:image/jpeg;base64,...` URL. Built
 * in 8 KB chunks to stay safely under the variadic-args limit on
 * `String.fromCharCode(...arr)` for >100 KB inputs.
 */
function toDataUrl(bytes: Uint8Array): string {
  const CHUNK = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

/**
 * Build the Llama vision request for a dial read. The image is sent
 * as a multimodal `image_url` content part on the user message — the
 * documented current path for `@cf/meta/llama-3.2-11b-vision-instruct`.
 */
function buildLlamaRequest(inputs: AiRunInputs): LlamaVisionRequest {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: inputs.prompt },
          { type: "image_url", image_url: { url: toDataUrl(inputs.image) } },
        ],
      },
    ],
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
  };
}

/**
 * Resolve the effective AI runner for this request. When a test has
 * installed a fake via `__setTestAiRunner`, return that; otherwise
 * delegate to `env.AI.run` with the dial-reader model, routed
 * through the AI Gateway.
 */
export function resolveAiRunner(env: AiRunnerEnv): AiRunner {
  if (testRunner) return testRunner;
  return async (inputs) => {
    const req = buildLlamaRequest(inputs);
    // The Ai binding's type signature is a cross-product over every
    // model's input/output shape — TypeScript can't narrow without
    // knowing the model key. Cast here; Llama 3.2 vision accepts
    // the OpenAI-compat chat-completion request and returns
    // `{ response }`.
    const raw = (await (
      env.AI as unknown as {
        run: (
          model: string,
          inputs: LlamaVisionRequest,
          options: { gateway: { id: string } },
        ) => Promise<LlamaVisionResponse>;
      }
    ).run(DIAL_MODEL, req, {
      gateway: { id: AI_GATEWAY_ID },
    })) as LlamaVisionResponse;

    return typeof raw.response === "string" ? { response: raw.response } : {};
  };
}
