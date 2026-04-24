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
// History: previously the runner targeted `@cf/moonshotai/kimi-k2.6`
// with an OpenAI-compat `image_url` content part. Production gateway
// logs showed the image was NOT being embedded (291 input tokens for
// a request that should have been 1000+). Despite Kimi K2.6 being
// labelled vision-capable and the binding accepting the schema, the
// upstream Workers AI inference path was processing text only.
// Diagnosis: K2.6 vision is not yet wired through the binding. We
// switched to `@cf/meta/llama-3.2-11b-vision-instruct` which has a
// proven, documented image-input shape: top-level `image: number[]`
// alongside plain-string-content messages. See INVESTIGATION.md /
// PR for the full trace.
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

  it("passes the image as a top-level number[] (Llama vision shape)", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({ response: "42" }));
    const runner = resolveAiRunner(env);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02]);
    await runner({ image: bytes, prompt: "read the second hand" });

    const [, inputs] = run.mock.calls[0]! as unknown as [
      string,
      {
        messages: Array<{ role: string; content: string }>;
        image: number[];
      },
      unknown,
    ];

    // The image is sent as a top-level number[] field — this is the
    // documented working shape for @cf/meta/llama-3.2-11b-vision-instruct
    // (see https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/).
    // It must NOT be a Uint8Array (the JSON-encoder used by the binding
    // would serialise that to {} and silently drop the image — the very
    // bug we're fixing).
    expect(Array.isArray(inputs.image)).toBe(true);
    expect(inputs.image).toEqual([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02]);
    expect(inputs.image.every((n) => typeof n === "number")).toBe(true);
  });

  it("sends the prompt as a plain-string user message alongside the image", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({ response: "42" }));
    const runner = resolveAiRunner(env);
    await runner({
      image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      prompt: "read the second hand",
    });

    const [, inputs] = run.mock.calls[0]! as unknown as [
      string,
      { messages: Array<{ role: string; content: string }> },
      unknown,
    ];

    expect(Array.isArray(inputs.messages)).toBe(true);
    expect(inputs.messages.length).toBeGreaterThanOrEqual(2);

    const system = inputs.messages[0]!;
    expect(system.role).toBe("system");
    expect(typeof system.content).toBe("string");

    const user = inputs.messages[inputs.messages.length - 1]!;
    expect(user.role).toBe("user");
    // Llama 3.2 vision does NOT use OpenAI multimodal `image_url`
    // content parts via the binding — content is a plain string and
    // the image is the top-level `image` field instead.
    expect(user.content).toBe("read the second hand");
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
