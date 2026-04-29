// Reader-level tests for the median-of-3 + anchor-guard pipeline
// (slice #5 of PRD #99 — issue #104).
//
// CI MUST NOT make real AI Gateway calls. All tests use a
// hand-rolled mock `AiClient` that returns canned responses.
// Real-API integration testing happens in the slice-#4 tracer
// bullet (`tests/integration/readings.verified.test.ts`) — that
// file uses `__setTestReadDial` to short-circuit the reader entirely
// and is unaffected by this slice.

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
  // Anchor at 19:24 — close to "10:19:34" so the dial reads land
  // within the 60s anchor-guard threshold by default.
  exifAnchor: { h: 10, m: 19, s: 24 },
  runId: "run-1",
};

interface MockState {
  /** Every request the mock has seen, in call order. */
  requests: ChatCompletionRequest[];
  /**
   * Function that produces the canned response. Called once per
   * parallel call. Tests can swap in a counter-based or
   * always-the-same responder.
   */
  respond: (
    req: ChatCompletionRequest,
    callIndex: number,
  ) => Promise<ChatCompletionResponse>;
}

/**
 * Build a mock AI client. The default responder returns the same
 * response for every call. Tests override `state.respond` to model
 * per-call divergence (mixed parsing failures, transport throws,
 * etc.).
 */
function makeMockClient(): { client: AiClient; state: MockState } {
  const state: MockState = {
    requests: [],
    respond: () => Promise.resolve(textResponse("10:19:34")),
  };
  const client: AiClient = {
    runChatCompletion(req) {
      const idx = state.requests.length;
      state.requests.push(req);
      return state.respond(req, idx);
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

/**
 * Build a responder that returns one canned content string per call,
 * cycling at the end of the list. Tests pass a list shorter than the
 * fan-out only when they intentionally want the wrap.
 */
function fixedResponder(contents: string[]): MockState["respond"] {
  return (_req, idx) => Promise.resolve(textResponse(contents[idx % contents.length]!));
}

describe("readDial — median-of-3", () => {
  describe("happy path (3 of 3 successes within anchor)", () => {
    it("returns success with the median MM:SS when all 3 reads succeed", async () => {
      const { client, state } = makeMockClient();
      // Three reads at 19:32, 19:34, 19:36 → median = 19:34.
      state.respond = fixedResponder(["10:19:32", "10:19:34", "10:19:36"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.mm_ss).toEqual({ m: 19, s: 34 });
        expect(result.raw_responses).toEqual(["10:19:32", "10:19:34", "10:19:36"]);
      }
      expect(state.requests).toHaveLength(3);
    });

    it("computes the median by sorting (unsorted reads still produce the middle value)", async () => {
      const { client, state } = makeMockClient();
      // 19:36, 19:32, 19:34 unsorted → sorted = 32, 34, 36 → median 19:34
      state.respond = fixedResponder(["10:19:36", "10:19:32", "10:19:34"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.mm_ss).toEqual({ m: 19, s: 34 });
      }
    });

    it("sums token usage across all 3 successful calls", async () => {
      const { client, state } = makeMockClient();
      let i = 0;
      state.respond = () => {
        const tokens = [
          { in: 100, out: 5 },
          { in: 110, out: 6 },
          { in: 120, out: 7 },
        ];
        const t = tokens[i++]!;
        return Promise.resolve(textResponse("10:19:34", t));
      };
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.tokens_in_total).toBe(330);
        expect(result.tokens_out_total).toBe(18);
      }
    });

    it("omits token totals when the model never reports usage", async () => {
      const { client, state } = makeMockClient();
      state.respond = fixedResponder(["10:19:34", "10:19:34", "10:19:34"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.tokens_in_total).toBeUndefined();
        expect(result.tokens_out_total).toBeUndefined();
      }
    });
  });

  describe("median-of-2 fallback (2 of 3 successes)", () => {
    it("averages the 2 parsed reads when 1 returns gibberish", async () => {
      const { client, state } = makeMockClient();
      // 19:30 + 19:36 → average 19:33; third call gibberish.
      state.respond = fixedResponder(["10:19:30", "I cannot read this", "10:19:36"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.mm_ss).toEqual({ m: 19, s: 33 });
      }
    });

    it("rounds the 2-read average (19:30 + 19:33 → 19:32)", async () => {
      const { client, state } = makeMockClient();
      // 19:30 (1770s) + 19:33 (1773s) → avg 1771.5 → round 1772 → 19:32
      state.respond = fixedResponder(["10:19:30", "huh?", "10:19:33"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.mm_ss).toEqual({ m: 19, s: 32 });
      }
    });
  });

  describe("rejection — unparseable_majority (≤ 1 of 3 successes)", () => {
    it("returns rejection: unparseable_majority when 2 of 3 are gibberish", async () => {
      const { client, state } = makeMockClient();
      state.respond = fixedResponder(["10:19:34", "I cannot read", "still cannot"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("rejection");
      if (result.kind === "rejection") {
        expect(result.reason).toBe("unparseable_majority");
      }
    });
  });

  describe("rejection — all_runs_failed (0 of 3 successes, mixed)", () => {
    it("returns rejection: all_runs_failed when all 3 reads are gibberish", async () => {
      const { client, state } = makeMockClient();
      state.respond = fixedResponder(["nope", "no idea", "I refuse"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("rejection");
      if (result.kind === "rejection") {
        expect(result.reason).toBe("all_runs_failed");
      }
    });

    it("treats null/empty content as a parse failure and reaches all_runs_failed", async () => {
      const { client, state } = makeMockClient();
      state.respond = () =>
        Promise.resolve({
          choices: [{ message: { role: "assistant", content: null } }],
        });
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("rejection");
      if (result.kind === "rejection") {
        expect(result.reason).toBe("all_runs_failed");
      }
    });

    it("returns all_runs_failed when 1 call throws but 2 are unparseable (mixed)", async () => {
      const { client, state } = makeMockClient();
      let i = 0;
      state.respond = () => {
        const idx = i++;
        if (idx === 0) {
          return Promise.reject(new Error("AI Gateway 503"));
        }
        return Promise.resolve(textResponse("nope"));
      };
      const result = await readDial(FAKE_INPUT, { ai: client });
      // 0 successes, but not ALL transport failures → all_runs_failed.
      expect(result.kind).toBe("rejection");
      if (result.kind === "rejection") {
        expect(result.reason).toBe("all_runs_failed");
      }
    });
  });

  describe("transport_error (3 of 3 throw)", () => {
    it("returns transport_error when all 3 calls throw", async () => {
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
  });

  describe("rejection — anchor_disagreement", () => {
    it("rejects when median MM:SS diverges > 60s from anchor", async () => {
      const { client, state } = makeMockClient();
      // Anchor is 19:24. Median of 21:00, 21:00, 21:00 = 21:00 →
      // 21:00 - 19:24 = +96s, > 60s → reject.
      state.respond = fixedResponder(["10:21:00", "10:21:00", "10:21:00"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("rejection");
      if (result.kind === "rejection") {
        expect(result.reason).toBe("anchor_disagreement");
        expect(result.details?.delta_seconds).toBe(96);
      }
    });

    it("rejects 90s ahead even when reads are tight", async () => {
      const { client, state } = makeMockClient();
      // Median 20:54 vs anchor 19:24 → +90s
      state.respond = fixedResponder(["10:20:53", "10:20:54", "10:20:55"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("rejection");
      if (result.kind === "rejection") {
        expect(result.reason).toBe("anchor_disagreement");
      }
    });
  });

  describe("rejection — anchor_echo_suspicious", () => {
    it("flags when ALL THREE reads are byte-identical to the anchor MM:SS", async () => {
      const { client, state } = makeMockClient();
      // Anchor is 19:24. Three reads echo it back exactly.
      state.respond = fixedResponder(["10:19:24", "10:19:24", "10:19:24"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("rejection");
      if (result.kind === "rejection") {
        expect(result.reason).toBe("anchor_echo_suspicious");
      }
    });

    it("does NOT flag when only 2 of 3 reads echo the anchor (third diverges)", async () => {
      const { client, state } = makeMockClient();
      // Two echo the anchor, one diverges by a few seconds. The
      // median still lands close to the anchor → success.
      state.respond = fixedResponder(["10:19:24", "10:19:24", "10:19:30"]);
      const result = await readDial(FAKE_INPUT, { ai: client });
      expect(result.kind).toBe("success");
    });
  });

  describe("request shape", () => {
    it("sends the prompt that contains the anchor and chain-of-thought instructions to all 3 calls", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client });
      expect(state.requests).toHaveLength(3);
      for (const req of state.requests) {
        const userMsg = req.messages.find((m) => m.role === "user");
        expect(userMsg).toBeDefined();
        const textParts = userMsg!.content.filter(
          (p): p is { type: "text"; text: string } => p.type === "text",
        );
        const promptText = textParts.map((p) => p.text).join("\n");
        expect(promptText).toContain("10:19:24");
        expect(promptText).toContain("IDENTIFY THE THREE HANDS");
        expect(promptText).toContain("DO NOT just echo");
      }
    });

    it("attaches the same cropped image as an OpenAI-compat data: URL on every call", async () => {
      const { client, state } = makeMockClient();
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34]);
      const input: ReadDialInput = { ...FAKE_INPUT, croppedImage: bytes.buffer };
      await readDial(input, { ai: client });
      expect(state.requests).toHaveLength(3);
      for (const req of state.requests) {
        const userMsg = req.messages.find((m) => m.role === "user")!;
        const imagePart = userMsg.content.find(
          (p): p is { type: "image_url"; image_url: { url: string } } =>
            p.type === "image_url",
        );
        expect(imagePart).toBeDefined();
        expect(imagePart!.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
        const b64 = imagePart!.image_url.url.replace(/^data:image\/jpeg;base64,/, "");
        const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
      }
    });

    it("requests model openai/gpt-5.2 with reasoning_effort=low and 4000 tokens (all calls)", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client });
      for (const req of state.requests) {
        expect(req.model).toBe("openai/gpt-5.2");
        expect(req.reasoning_effort).toBe("low");
        expect(req.max_completion_tokens).toBe(4000);
      }
    });

    it("forwards the gateway id from deps to all 3 calls", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client, gatewayId: "ratedwatch-vlm-test" });
      for (const req of state.requests) {
        expect(req.gateway_id).toBe("ratedwatch-vlm-test");
      }
    });

    it("defaults the gateway id to dial-reader-bakeoff when deps don't override", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client });
      for (const req of state.requests) {
        expect(req.gateway_id).toBe("dial-reader-bakeoff");
      }
    });

    it("fans out exactly 3 parallel calls", async () => {
      const { client, state } = makeMockClient();
      await readDial(FAKE_INPUT, { ai: client });
      expect(state.requests).toHaveLength(3);
    });
  });
});
