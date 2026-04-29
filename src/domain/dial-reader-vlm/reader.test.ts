// Reader-level tests for the single-VLM-call path.
//
// CI MUST NOT make real AI Gateway calls. All tests use a
// hand-rolled mock `AiClient` that returns canned responses.
// Real-API integration testing happens in slice #4 (the
// tracer bullet).

import { describe, expect, it } from "vitest";
import { readDial } from "./reader";
import type {
  AiClient,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "./ai-client";
import type { ReadDialInput } from "./types";

const FAKE_IMAGE = new ArrayBuffer(8); // 8 bytes is fine — the mock never reads it
const FAKE_INPUT: ReadDialInput = {
  croppedImage: FAKE_IMAGE,
  exifAnchor: { h: 10, m: 19, s: 24 },
  runId: "run-1",
};

interface MockState {
  /** Last request seen by the mock — for prompt assertions. */
  lastRequest: ChatCompletionRequest | null;
  /**
   * Function that produces the canned response. Tests can swap in
   * different behaviours (success, gibberish, throw) per case.
   */
  respond: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
}

function makeMockClient(): { client: AiClient; state: MockState } {
  const state: MockState = {
    lastRequest: null,
    respond: () => Promise.resolve(textResponse("10:19:34")),
  };
  const client: AiClient = {
    runChatCompletion(req) {
      state.lastRequest = req;
      return state.respond(req);
    },
  };
  return { client, state };
}

function textResponse(
  content: string,
  usage?: { in: number; out: number },
): ChatCompletionResponse {
  return {
    choices: [{ message: { role: "assistant", content } }],
    usage: usage ? { prompt_tokens: usage.in, completion_tokens: usage.out } : undefined,
  };
}

describe("readDial", () => {
  describe("happy path", () => {
    it("returns success with parsed MM:SS when the model emits HH:MM:SS", async () => {
      const { client } = makeMockClient();
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        // The hour (10) is dropped — the verifier owns the hour.
        expect(result.mm_ss).toEqual({ m: 19, s: 34 });
        expect(result.raw_response).toBe("10:19:34");
      }
    });

    it("propagates token usage when the model reports it", async () => {
      const { client, state } = makeMockClient();
      state.respond = () =>
        Promise.resolve(textResponse("10:19:34", { in: 1234, out: 56 }));
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.tokens_in).toBe(1234);
        expect(result.tokens_out).toBe(56);
      }
    });

    it("tolerates surrounding prose around the HH:MM:SS", async () => {
      const { client, state } = makeMockClient();
      state.respond = () =>
        Promise.resolve(textResponse("Final answer: 10:19:34. Confidence: high."));
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.mm_ss).toEqual({ m: 19, s: 34 });
      }
    });

    it("handles content returned as an array of parts (compat layer variation)", async () => {
      const { client, state } = makeMockClient();
      state.respond = () =>
        Promise.resolve({
          choices: [
            {
              message: {
                role: "assistant",
                content: [{ type: "text", text: "10:19:34" }],
              },
            },
          ],
        });
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.mm_ss).toEqual({ m: 19, s: 34 });
      }
    });

    it("treats a content-array with no text parts as unparseable", async () => {
      // Defensive — the OpenAI compat layer doesn't emit pure-image
      // assistant content in our flow, but be safe in case a future
      // model does. We expect `unparseable`, not a crash.
      const { client, state } = makeMockClient();
      state.respond = () =>
        Promise.resolve({
          choices: [
            {
              message: {
                role: "assistant",
                content: [{ type: "image_url", image_url: { url: "data:..." } }],
              },
            },
          ],
        });
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("unparseable");
    });
  });

  describe("unparseable", () => {
    it("returns unparseable when the model emits gibberish", async () => {
      const { client, state } = makeMockClient();
      state.respond = () => Promise.resolve(textResponse("I cannot read this dial"));
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("unparseable");
      if (result.kind === "unparseable") {
        expect(result.raw_response).toBe("I cannot read this dial");
      }
    });

    it("returns unparseable when the model emits an out-of-range time", async () => {
      const { client, state } = makeMockClient();
      state.respond = () => Promise.resolve(textResponse("25:99:99"));
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("unparseable");
    });

    it("returns unparseable when content is null/empty", async () => {
      const { client, state } = makeMockClient();
      state.respond = () =>
        Promise.resolve({
          choices: [{ message: { role: "assistant", content: null } }],
        });
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("unparseable");
    });

    it("returns unparseable when the response has no choices", async () => {
      const { client, state } = makeMockClient();
      state.respond = () => Promise.resolve({ choices: [] });
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("unparseable");
    });
  });

  describe("transport error", () => {
    it("returns transport_error when the AI client throws", async () => {
      const { client, state } = makeMockClient();
      state.respond = () => Promise.reject(new Error("AI Gateway 503"));
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("transport_error");
      if (result.kind === "transport_error") {
        expect(result.message).toContain("AI Gateway 503");
      }
    });

    it("captures non-Error throws as a string message", async () => {
      const { client, state } = makeMockClient();
      state.respond = () => Promise.reject("just a string");
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("transport_error");
      if (result.kind === "transport_error") {
        expect(result.message).toContain("just a string");
      }
    });

    it("JSON-stringifies non-Error non-string throws", async () => {
      const { client, state } = makeMockClient();
      state.respond = () => Promise.reject({ code: 503, msg: "gateway down" });
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("transport_error");
      if (result.kind === "transport_error") {
        expect(result.message).toContain("503");
        expect(result.message).toContain("gateway down");
      }
    });

    it("falls back to String() when JSON.stringify throws", async () => {
      // Build a circular object that JSON.stringify refuses.
      const circular: { self?: unknown } = {};
      circular.self = circular;
      const { client, state } = makeMockClient();
      state.respond = () => Promise.reject(circular);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("transport_error");
      if (result.kind === "transport_error") {
        // String({}) → "[object Object]" — we don't care about the
        // exact string, just that we got a non-empty fallback.
        expect(result.message.length).toBeGreaterThan(0);
      }
    });
  });

  describe("request shape", () => {
    it("sends the prompt that contains the anchor and chain-of-thought instructions", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client });
      expect(state.lastRequest).not.toBeNull();
      const req = state.lastRequest!;

      const userMsg = req.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      const textParts = userMsg!.content.filter(
        (p): p is { type: "text"; text: string } => p.type === "text",
      );
      expect(textParts.length).toBeGreaterThan(0);
      const promptText = textParts.map((p) => p.text).join("\n");

      // The anchor is included verbatim.
      expect(promptText).toContain("10:19:24");
      // Chain-of-thought hand-identification instructions are present.
      expect(promptText).toContain("IDENTIFY THE THREE HANDS");
      expect(promptText).toContain("DO NOT just echo");
    });

    it("attaches the cropped image as an OpenAI-compat data: URL", async () => {
      const { client, state } = makeMockClient();
      // Use a buffer with recognisable bytes so we can verify the
      // base64 round-trip didn't mangle the image.
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34]);
      const input: ReadDialInput = { ...FAKE_INPUT, croppedImage: bytes.buffer };
      await readDial(input, { ai: client });

      const req = state.lastRequest!;
      const userMsg = req.messages.find((m) => m.role === "user")!;
      const imagePart = userMsg.content.find(
        (p): p is { type: "image_url"; image_url: { url: string } } =>
          p.type === "image_url",
      );
      expect(imagePart).toBeDefined();
      expect(imagePart!.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
      // The base64 segment after the prefix must decode back to the
      // original bytes.
      const b64 = imagePart!.image_url.url.replace(/^data:image\/jpeg;base64,/, "");
      const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });

    it("requests model openai/gpt-5.2 with reasoning_effort=low and 4000 tokens", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client });
      const req = state.lastRequest!;
      expect(req.model).toBe("openai/gpt-5.2");
      expect(req.reasoning_effort).toBe("low");
      expect(req.max_completion_tokens).toBe(4000);
    });

    it("forwards the gateway id from deps", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client, gatewayId: "ratedwatch-vlm-test" });
      expect(state.lastRequest!.gateway_id).toBe("ratedwatch-vlm-test");
    });

    it("defaults the gateway id to dial-reader-bakeoff when deps don't override", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client });
      expect(state.lastRequest!.gateway_id).toBe("dial-reader-bakeoff");
    });
  });
});
