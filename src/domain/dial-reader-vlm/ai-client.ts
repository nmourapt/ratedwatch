// Thin abstraction over the Cloudflare Workers AI binding.
//
// The reader module depends on this interface, NOT directly on
// `env.AI`, so unit tests can inject a deterministic mock and CI
// never makes real AI Gateway calls.
//
// Production wiring lands in slice #4 (issue #103, the tracer
// bullet). For this slice we provide:
//   * the `AiClient` interface
//   * the request/response shape (mirrors OpenAI's
//     chat-completions schema)
//   * `createWorkersAiClient` — the production adapter that wraps
//     `env.AI.run("openai/gpt-5.2", body, { gateway: { id } })`
//
// The OpenAI-compat content-part shape is:
//   [
//     { type: "text", text: "<prompt>" },
//     { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
//   ]
// AI Gateway's compat layer translates this to the native provider
// format on the way out.

/** Single text/image content part in a chat message. */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * One chat message. The dial reader only ever sends a single user
 * message with a text-then-image content pair, but the type is the
 * full chat-message shape so future extensions (system prompt,
 * multi-turn) are non-breaking.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContentPart[];
}

/** Reasoning effort dial — only `low` is exercised in this slice. */
export type ReasoningEffort = "low" | "medium" | "high";

/** Inputs to a single chat-completion call. */
export interface ChatCompletionRequest {
  /** Provider-prefixed model slug, e.g. `"openai/gpt-5.2"`. */
  model: string;
  messages: ChatMessage[];
  /**
   * Hard cap on the response (including hidden reasoning tokens).
   * The bake-off settled on 4000 — enough for `reasoning_effort: "low"`
   * to chain-of-thought internally and still emit the visible
   * HH:MM:SS line.
   */
  max_completion_tokens: number;
  reasoning_effort: ReasoningEffort;
  /**
   * AI Gateway slug. Routes the request through a specific gateway
   * for caching, logging, and unified-billing accounting. Set per
   * environment via `AI_GATEWAY_ID`.
   */
  gateway_id: string;
}

/**
 * Slim subset of OpenAI's chat-completions response that the reader
 * actually consumes. Tests construct this directly; production
 * receives it from `env.AI.run`.
 */
export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | ChatContentPart[] | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/** What the reader module depends on. */
export interface AiClient {
  runChatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

/**
 * Cloudflare Workers AI binding shape this adapter consumes. Matches
 * the "Unknown model (gateway fallback)" overload from the runtime
 * `Ai` class — that's the overload the OpenAI-compat path lands on
 * because `"openai/gpt-5.2"` is not in the typed `AiModels` map.
 *
 * We accept both the full `Ai` runtime type and any minimal stand-in
 * with a matching `run` method. The interface is exported so test
 * harnesses outside this module can build a typed fake without
 * dragging in the global `Ai` type.
 */
export interface WorkersAiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: { gateway: { id: string } },
  ): Promise<Record<string, unknown>>;
}

/**
 * Build an {@link AiClient} that calls `env.AI.run("openai/gpt-5.2", …)`
 * with the supplied gateway id. Used by the production wiring (slice
 * #4 onwards). Tests use a hand-rolled mock and do NOT call this.
 *
 * Defensive about the response: `env.AI.run` returns `Record<string,
 * unknown>` for the gateway-fallback overload, because the compat
 * layer's response shape is provider-dependent. We narrow it to
 * {@link ChatCompletionResponse} via a runtime cast — the shape is
 * stable per the OpenAI compat contract.
 */
export function createWorkersAiClient(ai: WorkersAiBinding): AiClient {
  return {
    async runChatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        max_completion_tokens: req.max_completion_tokens,
        reasoning_effort: req.reasoning_effort,
      };
      const result = await ai.run(req.model, body, {
        gateway: { id: req.gateway_id },
      });
      return result as unknown as ChatCompletionResponse;
    },
  };
}
