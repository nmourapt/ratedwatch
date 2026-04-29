// Tests for the production AI binding adapter.
//
// `createWorkersAiClient` is a thin shim around `env.AI.run`. We
// don't make a real AI call — we drive it with a hand-rolled stub
// that records the arguments it was called with, then assert the
// shape we forward to the binding.

import { describe, expect, it } from "vitest";
import { createWorkersAiClient } from "./ai-client";
import type { ChatCompletionRequest, WorkersAiBinding } from "./ai-client";

function makeBinding(): {
  binding: WorkersAiBinding;
  calls: Array<{
    model: string;
    inputs: Record<string, unknown>;
    options: { gateway: { id: string } };
  }>;
} {
  const calls: Array<{
    model: string;
    inputs: Record<string, unknown>;
    options: { gateway: { id: string } };
  }> = [];
  const binding: WorkersAiBinding = {
    async run(model, inputs, options) {
      calls.push({ model, inputs, options });
      return {
        choices: [{ message: { role: "assistant", content: "10:19:34" } }],
      };
    },
  };
  return { binding, calls };
}

const REQ: ChatCompletionRequest = {
  model: "openai/gpt-5.2",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ],
  max_completion_tokens: 4000,
  reasoning_effort: "low",
  gateway_id: "ratedwatch-vlm-test",
};

describe("createWorkersAiClient", () => {
  it("forwards model + body + gateway id to env.AI.run", async () => {
    const { binding, calls } = makeBinding();
    const client = createWorkersAiClient(binding);
    await client.runChatCompletion(REQ);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("openai/gpt-5.2");
    expect(calls[0]!.options).toEqual({ gateway: { id: "ratedwatch-vlm-test" } });
    expect(calls[0]!.inputs).toMatchObject({
      model: "openai/gpt-5.2",
      max_completion_tokens: 4000,
      reasoning_effort: "low",
    });
    expect(Array.isArray(calls[0]!.inputs.messages)).toBe(true);
  });

  it("returns the binding's response unchanged (typed)", async () => {
    const { binding } = makeBinding();
    const client = createWorkersAiClient(binding);
    const resp = await client.runChatCompletion(REQ);
    expect(resp.choices?.[0]?.message?.content).toBe("10:19:34");
  });
});
