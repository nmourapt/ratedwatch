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
// assistant text from Kimi's chat-completion envelope?
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
    expect(DIAL_MODEL).toBe("@cf/moonshotai/kimi-k2.6");
    expect(AI_GATEWAY_ID).toBe("ratedwatch");
  });

  it("dispatches to env.AI.run with the dial model and gateway option", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({
      choices: [{ message: { content: "42" } }],
    }));
    const runner = resolveAiRunner(env);
    await runner({
      image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      prompt: "Report the second hand as 0-59.",
    });

    expect(run).toHaveBeenCalledTimes(1);
    const [model, , options] = run.mock.calls[0]!;
    expect(model).toBe("@cf/moonshotai/kimi-k2.6");
    expect(options).toEqual({ gateway: { id: "ratedwatch" } });
  });

  it("wraps the image as a base64 data URL in a user message", async () => {
    const { env, run } = makeFakeAiEnv(async () => ({
      choices: [{ message: { content: "42" } }],
    }));
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
    expect(inputs.messages).toBeInstanceOf(Array);
    expect(inputs.messages.length).toBeGreaterThanOrEqual(2);

    const system = inputs.messages[0]!;
    expect(system.role).toBe("system");

    const user = inputs.messages[inputs.messages.length - 1]!;
    expect(user.role).toBe("user");
    expect(Array.isArray(user.content)).toBe(true);

    const parts = user.content as Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    >;
    const textPart = parts.find(
      (p): p is { type: "text"; text: string } => p.type === "text",
    );
    const imagePart = parts.find(
      (p): p is { type: "image_url"; image_url: { url: string } } =>
        p.type === "image_url",
    );
    expect(textPart?.text).toBe("read the second hand");
    expect(imagePart?.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    // The known bytes 0xFF 0xD8 0xFF 0xD9 base64-encode to "/9j/2Q==".
    expect(imagePart?.image_url.url).toContain("/9j/2Q==");
  });

  it("extracts choices[0].message.content into response", async () => {
    const { env } = makeFakeAiEnv(async () => ({
      choices: [{ message: { content: "  42  " } }, { message: { content: "99" } }],
    }));
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
      choices: [{ message: { content: "should not be called" } }],
    }));
    __setTestAiRunner(async () => ({ response: "stub" }));
    const runner = resolveAiRunner(env);
    const out = await runner({ image: new Uint8Array([0xff]), prompt: "x" });
    expect(out).toEqual({ response: "stub" });
    expect(run).not.toHaveBeenCalled();
  });
});
