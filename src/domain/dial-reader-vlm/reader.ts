// Worker-side VLM dial reader — single-call entry point.
//
// Slice #3 of PRD #99 (issue #102). Takes a cropped 768×768 dial
// JPEG + an EXIF anchor, runs ONE chat-completion call against
// GPT-5.2 via Cloudflare AI Gateway, and returns a structured
// `DialReadResult`.
//
// Median-of-3 and the anchor-disagreement guard are NOT implemented
// here — they land in slice #5. This module is intentionally
// minimal so the tracer-bullet integration in slice #4 can wire it
// up without dragging in the median pipeline.
//
// Production wiring (slice #4) will:
//   1. Call the dial cropper from slice #2 to get a 768×768 JPEG.
//   2. Call `readDial({ croppedImage, exifAnchor, runId },
//                     { ai: createWorkersAiClient(env.AI),
//                       gatewayId: env.AI_GATEWAY_ID })`.
//   3. Branch on the result.kind to decide what to write to D1 /
//      surface to the user.

import { buildPrompt } from "./prompt";
import { parseHmsResponse } from "./parse";
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

/** Inputs the reader needs from the host environment. */
export interface ReadDialDeps {
  ai: AiClient;
  /**
   * AI Gateway slug (route through this gateway for caching, logs,
   * unified billing). Optional — defaults to the bake-off gateway.
   */
  gatewayId?: string;
}

/**
 * Run a single VLM dial-read.
 *
 * Always resolves; never throws. Transport / network failures
 * surface as `{ kind: "transport_error" }`.
 */
export async function readDial(
  input: ReadDialInput,
  deps: ReadDialDeps,
): Promise<DialReadResult> {
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

  let response: ChatCompletionResponse;
  try {
    response = await deps.ai.runChatCompletion(req);
  } catch (err) {
    return {
      kind: "transport_error",
      message: errorMessage(err),
    };
  }

  const rawContent = extractContent(response);
  if (rawContent === null) {
    // The model returned an empty / null content. Treat as
    // unparseable so the caller can surface a "please retake"
    // message rather than a generic transport error.
    return { kind: "unparseable", raw_response: "" };
  }

  const parsed = parseHmsResponse(rawContent);
  if (!parsed) {
    return { kind: "unparseable", raw_response: rawContent };
  }

  const usage = response.usage ?? {};
  const result: DialReadResult = {
    kind: "success",
    mm_ss: { m: parsed.m, s: parsed.s },
    raw_response: rawContent,
  };
  if (typeof usage.prompt_tokens === "number") {
    result.tokens_in = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    result.tokens_out = usage.completion_tokens;
  }
  return result;
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
