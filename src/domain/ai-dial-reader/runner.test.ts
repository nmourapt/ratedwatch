import { afterEach, describe, it, expect, vi } from "vitest";
import {
  AI_GATEWAY_ID,
  DIAL_MODEL,
  __setTestAiRunner,
  resolveAiRunner,
  type AiRunnerEnv,
} from "./runner";

// Tests that focus on the runner's production path: does it dispatch
// to the right model, with the right gateway option, and extract the
// assistant text from the model's response envelope?
//
// History (chronological):
//   1. Initial implementation: Kimi K2.6 with OpenAI-compat
//      `image_url` content parts. Production gateway logs showed 291
//      input tokens for a request that should have been 1000+ — Kimi
//      K2.6's vision input wasn't being wired through the binding.
//   2. Swap to `@cf/meta/llama-3.2-11b-vision-instruct` with the
//      legacy top-level `image: number[]` field. Worked end-to-end on
//      tiny test images (1×1 PNG). On real cellular-uploaded photos
//      (~2 MB) the deprecated number-array path took ~3x longer than
//      the prescribed data-URL path (empirical: 3.1s vs 1.0s on a
//      1.5 MB synthetic payload), and on real production photos it
//      crossed enough thresholds that users saw the verifier "stall".
//   3. Current shape (this file): OpenAPI-prescribed multimodal
//      content parts with `image_url: { url: "data:image/jpeg;base64,..." }`
//      on the user message. Smaller wire payload, faster binding
//      round-trip, and explicitly the documented current path
//      (top-level `image` is marked deprecated in the schema).
//
// The reader.test.ts suite installs test runners via
// `__setTestAiRunner` — those tests exercise parsing, not dispatch.
// This file instead builds a fake `env.AI` whose `.run` is a spy,
// installs no test runner, and calls `resolveAiRunner(env)` directly.

afterEach(() => {
  __setTestAiRunner(null);
});

function makeFakeAiEnv(
  runImpl: (model: string, inputs: unknown, options: unknown) => Promise<unknown>,
): { env: AiRunnerEnv; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(runImpl);
  const env: AiRunnerEnv = {
    AI: {
      run,
    } as unknown as Ai,
  };
  return { env, run };
}

describe("resolveAiRunner (production path)", () => {
  it("exports the expected model and gateway constants", () => {
    expect(DIAL_MODEL).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
    expect(AI_GATEWAY_ID).toBe("ratedwatch");
  });

  it("dispatches to env.AI.run with the dial model and gateway option", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({ response: "42" }));
    const runner = resolveAiRunner(env);
    await runner({
      image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      prompt: "Report the second hand as 0-59.",
    });

    expect(run).toHaveBeenCalledTimes(1);
    const [model, , options] = run.mock.calls[0]!;
    expect(model).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
    expect(options).toEqual({ gateway: { id: "ratedwatch" } });
  });

  it("attaches the image as a base64 data URL on a user image_url content part", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({ response: "42" }));
    const runner = resolveAiRunner(env);
    // The known bytes 0xFF 0xD8 0xFF 0xD9 base64-encode to "/9j/2Q==".
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await runner({ image: bytes, prompt: "read the second hand" });

    const [, inputs] = run.mock.calls[0]! as unknown as [
      string,
      {
        messages: Array<{
          role: string;
          content:
            | string
            | Array<
                | { type: "text"; text: string }
                | { type: "image_url"; image_url: { url: string } }
              >;
        }>;
      },
      unknown,
    ];

    // The user message's content is a multimodal array, NOT a plain
    // string. The legacy top-level `image: number[]` path is
    // deprecated and ~3x slower at multi-MB photo sizes (see the
    // production stall that motivated this contract).
    const user = inputs.messages[inputs.messages.length - 1]!;
    expect(user.role).toBe("user");
    expect(Array.isArray(user.content)).toBe(true);

    const parts = user.content as Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    >;
    const imagePart = parts.find(
      (p): p is { type: "image_url"; image_url: { url: string } } =>
        p.type === "image_url",
    );
    expect(imagePart).toBeDefined();
    // The url MUST start with the `data:image/jpeg;base64,` prefix —
    // the OpenAPI schema's `^data:*` pattern requires it (HTTP URLs
    // are explicitly rejected). Document this so a future refactor
    // doesn't accidentally relax it back to a plain http URL.
    expect(imagePart!.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(imagePart!.image_url.url).toContain("/9j/2Q==");
  });

  it("does NOT include the deprecated top-level `image` field", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({ response: "42" }));
    const runner = resolveAiRunner(env);
    await runner({
      image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      prompt: "x",
    });

    const [, inputs] = run.mock.calls[0]! as unknown as [
      string,
      Record<string, unknown>,
      unknown,
    ];

    // Regression guard: ensure we never re-introduce the deprecated
    // top-level `image` field. The schema marks it deprecated, and
    // it serializes a 2 MB photo to ~8 MB of JSON-array text,
    // ~3x slower than the data-URL path.
    expect(inputs).not.toHaveProperty("image");
  });

  it("sends the prompt as the text content part on the user message", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({ response: "42" }));
    const runner = resolveAiRunner(env);
    await runner({
      image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      prompt: "read the second hand",
    });

    const [, inputs] = run.mock.calls[0]! as unknown as [
      string,
      {
        messages: Array<{
          role: string;
          content:
            | string
            | Array<
                | { type: "text"; text: string }
                | { type: "image_url"; image_url: { url: string } }
              >;
        }>;
      },
      unknown,
    ];

    expect(Array.isArray(inputs.messages)).toBe(true);
    expect(inputs.messages.length).toBeGreaterThanOrEqual(2);

    const system = inputs.messages[0]!;
    expect(system.role).toBe("system");
    expect(typeof system.content).toBe("string");

    const user = inputs.messages[inputs.messages.length - 1]!;
    const parts = user.content as Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    >;
    const textPart = parts.find(
      (p): p is { type: "text"; text: string } => p.type === "text",
    );
    expect(textPart).toBeDefined();
    expect(textPart!.text).toBe("read the second hand");
  });

  it("bounds output via max_tokens and pins low temperature for determinism", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({ response: "42" }));
    const runner = resolveAiRunner(env);
    await runner({
      image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      prompt: "x",
    });

    const [, inputs] = run.mock.calls[0]! as unknown as [
      string,
      { max_tokens?: number; temperature?: number },
      unknown,
    ];

    // Valid replies are at most ~10 chars. Bounding generation
    // protects against degenerate "model rambles past the system
    // prompt" cases that would inflate latency on real photos.
    expect(inputs.max_tokens).toBeGreaterThan(0);
    expect(inputs.max_tokens).toBeLessThanOrEqual(64);
    // Dial reading is a deterministic perception task — pin
    // temperature low so we don't pay for sampling variance.
    expect(inputs.temperature).toBeLessThanOrEqual(0.3);
  });

  it("extracts the top-level response field", async () => {
    const { env } = makeFakeAiEnv(async () => ({ response: "  42  " }));
    const runner = resolveAiRunner(env);
    const out = await runner({
      image: new Uint8Array([0xff, 0xd8]),
      prompt: "x",
    });
    // Runner returns raw content; trimming is the reader's job.
    expect(out.response).toBe("  42  ");
  });

  it("returns an empty response object when the upstream shape is malformed", async () => {
    const { env } = makeFakeAiEnv(async () => ({ nothing: "useful" }));
    const runner = resolveAiRunner(env);
    const out = await runner({ image: new Uint8Array([0xff]), prompt: "x" });
    expect(out.response).toBeUndefined();
  });

  it("propagates upstream errors to the caller", async () => {
    const { env } = makeFakeAiEnv(async () => {
      throw new Error("binding exploded");
    });
    const runner = resolveAiRunner(env);
    await expect(runner({ image: new Uint8Array([0xff]), prompt: "x" })).rejects.toThrow(
      "binding exploded",
    );
  });

  it("test runner overrides the production path", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({
      response: "should not be called",
    }));
    __setTestAiRunner(async () => ({ response: "stub" }));
    const runner = resolveAiRunner(env);
    const out = await runner({ image: new Uint8Array([0xff]), prompt: "x" });
    expect(out).toEqual({ response: "stub" });
    expect(run).not.toHaveBeenCalled();
  });
});
