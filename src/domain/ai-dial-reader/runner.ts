// Thin indirection between the AI dial reader and the actual Workers
// AI binding. Lets integration tests override the "AI runner" with a
// canned fake without having to plumb an alternate binding through
// miniflare (AI bindings always resolve remotely, which the pool
// treats specially).
//
// Semantics:
//
//   * Production path: `resolveAiRunner(env)` returns a function that
//     delegates to `env.AI.run(DIAL_MODEL, { messages }, { gateway })`
//     and extracts the assistant's text reply from the chat-completion
//     response. Every call is routed through the AI Gateway named by
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
// model-specific response shapes; if we ever swap Kimi for another
// chat model, only this file changes.

/**
 * Dial-reader model. Kimi K2.6 is a frontier-scale vision + reasoning
 * chat model on Workers AI (Day-0 release 2026-04-20). Chosen over
 * the previous llama-3.2-11b-vision-instruct for its much stronger
 * visual reasoning, which matters for reading a watch's thin second
 * hand against a busy dial background.
 *
 * Pricing: $0.95 / M input tokens. A dial read is ~1 image + ~200
 * prompt tokens ≈ well under $0.001 per reading.
 */
export const DIAL_MODEL = "@cf/moonshotai/kimi-k2.6";

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
   * JPEG bytes. Encoded as a base64 data URL and embedded in the
   * user message's `image_url` field before dispatching to Kimi.
   * A `Uint8Array` is the canonical shape at the reader boundary;
   * the runner converts.
   */
  image: Uint8Array;
  /**
   * The prompt text. The runner wraps this in a Kimi chat-messages
   * envelope (system + user with image attached). The reader builds
   * a single prompt string and leaves the conversational structure
   * to the runner.
   */
  prompt: string;
}

export interface AiRunResponse {
  /**
   * The assistant's text reply, extracted from Kimi's
   * `choices[0].message.content`. `undefined` if the upstream
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

// --- Kimi chat-completion shape ------------------------------------

// We model only the bits we read. Kimi accepts the OpenAI-compatible
// chat-completion schema: `{ messages: [{ role, content }] }` where
// a user message's `content` can be a string OR an array of parts
// (text + image_url). We always use the parts form so the image is
// attached to the user turn.

interface KimiTextPart {
  type: "text";
  text: string;
}

interface KimiImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

type KimiContentPart = KimiTextPart | KimiImageUrlPart;

interface KimiMessage {
  role: "system" | "user" | "assistant";
  content: string | KimiContentPart[];
}

interface KimiRequest {
  messages: KimiMessage[];
}

interface KimiChoice {
  message?: { content?: string };
}

interface KimiResponse {
  choices?: KimiChoice[];
}

/** Base64-encode a byte array. `btoa` expects a binary string. */
function toBase64(bytes: Uint8Array): string {
  // Build the binary string in chunks to avoid stack-size errors on
  // very large images (btoa over `String.fromCharCode(...bytes)` can
  // blow up for >100kB inputs). 8kB chunks are safely within the
  // arg-list limit on every runtime we care about.
  const CHUNK = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

const SYSTEM_PROMPT =
  "You are a watch-dial reader. You answer with a single token and nothing else.";

/**
 * Build the Kimi chat request for a dial read. The image is encoded
 * as a `data:image/jpeg;base64,...` URL on the `image_url` part —
 * that's the format Kimi accepts via the Workers AI binding.
 */
function buildKimiRequest(inputs: AiRunInputs): KimiRequest {
  const b64 = toBase64(inputs.image);
  const imageUrl = `data:image/jpeg;base64,${b64}`;
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: inputs.prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
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
    const req = buildKimiRequest(inputs);
    // The Ai binding's type signature is a cross-product over every
    // model's input/output shape — TypeScript can't narrow without
    // knowing the model key. Cast here; Kimi K2.6 accepts a
    // chat-completion request and returns an OpenAI-shaped response.
    const raw = (await (
      env.AI as unknown as {
        run: (
          model: string,
          inputs: KimiRequest,
          options: { gateway: { id: string } },
        ) => Promise<KimiResponse>;
      }
    ).run(DIAL_MODEL, req, { gateway: { id: AI_GATEWAY_ID } })) as KimiResponse;

    const content = raw.choices?.[0]?.message?.content;
    return typeof content === "string" ? { response: content } : {};
  };
}
