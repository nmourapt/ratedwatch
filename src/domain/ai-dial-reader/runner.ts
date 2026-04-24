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
   * JPEG bytes. Sent to the model as a top-level `image: number[]`
   * field — the documented shape for Llama 3.2 vision via the
   * Workers AI binding.
   */
  image: Uint8Array;
  /**
   * The prompt text. The runner wraps this in a chat-messages
   * envelope (system + user with plain-string content). The reader
   * builds a single prompt string and leaves the conversational
   * structure to the runner.
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
// Llama 3.2 vision via the Workers AI binding accepts:
//
//   {
//     messages: [{ role, content: string }, ...],
//     image: number[]         // raw JPEG bytes as plain numbers
//   }
//
// The image MUST be a `number[]` (not a Uint8Array). The binding's
// JSON encoder serialises Uint8Array as `{}` and silently drops the
// payload — that path is what produced the original NO_DIAL bug
// when we tried `image_url` content parts on Kimi K2.6.

interface LlamaVisionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LlamaVisionRequest {
  messages: LlamaVisionMessage[];
  image: number[];
}

interface LlamaVisionResponse {
  response?: string;
}

const SYSTEM_PROMPT =
  "You are a watch-dial reader. You answer with a single token and nothing else.";

/**
 * Build the Llama vision request for a dial read. The image is sent
 * as a top-level `number[]` of raw JPEG bytes — that's the shape the
 * Workers AI binding expects for `@cf/meta/llama-3.2-11b-vision-instruct`.
 */
function buildLlamaRequest(inputs: AiRunInputs): LlamaVisionRequest {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: inputs.prompt },
    ],
    // `Array.from(Uint8Array)` produces a plain `number[]`. Don't
    // be tempted to use `[...inputs.image]` — that's also `number[]`
    // but it's marginally slower and harder to grep for.
    image: Array.from(inputs.image),
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
    // `{ messages, image }` and returns `{ response }`.
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
