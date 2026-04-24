import { afterEach, describe, it, expect } from "vitest";
import { buildPrompt, readDialTime } from "./reader";
import { __setTestAiRunner, type AiRunner, type AiRunnerEnv } from "./runner";

// These tests drive the reader through a fake AiRunner. No real AI
// binding is ever invoked — the module-level `testRunner` override
// (see runner.ts) redirects every call to the fake we install here.
//
// NOTE on the contract: the runner exposes `{ response: string }`
// as its output, extracted from the underlying chat-completion.
// These tests install fakes that return that flat shape directly,
// so they exercise the reader's *parsing* logic independent of
// whichever model the production runner is wired to.

afterEach(() => {
  __setTestAiRunner(null);
});

// Minimal env the reader accepts. Its `AI` field is never touched
// when a test runner is installed, so `{} as Ai` is safe.
const fakeEnv: AiRunnerEnv = { AI: {} as unknown as Ai };
const fakeImage = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // tiny "JPEG"

function installFake(
  response: string,
  inspect?: (inputs: Parameters<AiRunner>[0]) => void,
): void {
  __setTestAiRunner(async (inputs) => {
    if (inspect) inspect(inputs);
    return { response };
  });
}

describe("readDialTime", () => {
  it("parses a two-digit MM:SS response", async () => {
    installFake("32:17");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ minutes: 32, seconds: 17, raw_response: "32:17" });
  });

  it("parses single-digit components on either side", async () => {
    installFake("3:7");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ minutes: 3, seconds: 7, raw_response: "3:7" });
  });

  it("parses zero-padded components", async () => {
    installFake("03:07");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ minutes: 3, seconds: 7, raw_response: "03:07" });
  });

  it("parses the top of the minute", async () => {
    installFake("0:0");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ minutes: 0, seconds: 0, raw_response: "0:0" });
  });

  it("parses the end of the hour", async () => {
    installFake("59:59");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({
      minutes: 59,
      seconds: 59,
      raw_response: "59:59",
    });
  });

  it("trims surrounding whitespace before parsing", async () => {
    installFake("   15:42  \n");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({
      minutes: 15,
      seconds: 42,
      raw_response: "15:42",
    });
  });

  it("returns refused for NO_DIAL", async () => {
    installFake("NO_DIAL");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ error: "refused", raw_response: "NO_DIAL" });
  });

  it("returns refused for UNREADABLE", async () => {
    installFake("UNREADABLE");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ error: "refused", raw_response: "UNREADABLE" });
  });

  it("returns unparseable for prose responses", async () => {
    installFake("The time shown is 32:17 approximately");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect("error" in result ? result.error : null).toBe("unparseable");
    if ("error" in result) {
      expect(result.raw_response).toBe("The time shown is 32:17 approximately");
    }
  });

  it("returns unparseable for non-numeric tokens", async () => {
    installFake("banana");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect("error" in result ? result.error : null).toBe("unparseable");
    if ("error" in result) {
      expect(result.raw_response).toBe("banana");
    }
  });

  it("returns implausible when minutes are out of range", async () => {
    installFake("99:17");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ error: "implausible", raw_response: "99:17" });
  });

  it("returns implausible when seconds are out of range", async () => {
    installFake("32:99");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ error: "implausible", raw_response: "32:99" });
  });

  it("returns implausible when seconds hit 60 (off-by-one from 59 max)", async () => {
    installFake("32:60");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ error: "implausible", raw_response: "32:60" });
  });

  it("returns unparseable for HH:MM:SS (legacy model output)", async () => {
    // Regression guard: an earlier model was prompted for HH:MM:SS.
    // If a model ever returns that again, we want the reader to
    // reject it cleanly rather than try to salvage a number from it.
    installFake("14:32:07");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect("error" in result ? result.error : null).toBe("unparseable");
  });

  it("returns unparseable for seconds-only (pre-MM:SS contract)", async () => {
    // Regression guard: the previous seconds-only contract would
    // have accepted "42". The new contract requires MM:SS; a bare
    // integer must be rejected so we don't silently treat it as
    // minutes=42, seconds=0 (or similar).
    installFake("42");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect("error" in result ? result.error : null).toBe("unparseable");
  });

  it("returns unparseable for a signed number", async () => {
    installFake("-5:10");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect("error" in result ? result.error : null).toBe("unparseable");
  });

  it("returns unparseable for an empty response", async () => {
    installFake("");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect("error" in result ? result.error : null).toBe("unparseable");
  });

  it("returns unparseable when the upstream call throws", async () => {
    __setTestAiRunner(async () => {
      throw new Error("boom");
    });
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({ error: "unparseable" });
  });

  it("passes the image bytes and prompt to the AI runner", async () => {
    let captured: { image: Uint8Array; prompt: string } | null = null;
    __setTestAiRunner(async (inputs) => {
      captured = { image: inputs.image, prompt: inputs.prompt };
      return { response: "10:42" };
    });
    await readDialTime(fakeImage, fakeEnv);
    expect(captured).not.toBeNull();
    expect(Array.from(captured!.image)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    // The new prompt asks for MM:SS. It should mention both hands.
    expect(captured!.prompt).toContain("minute and second hand");
    expect(captured!.prompt).toContain("MM:SS");
    expect(captured!.prompt).toContain("NO_DIAL");
    expect(captured!.prompt).toContain("UNREADABLE");
    // And it no longer asks for seconds-only or HH:MM:SS.
    expect(captured!.prompt).not.toContain("HH:MM:SS");
  });

  it("hint time flows into the prompt as the reference-clock anchor", async () => {
    let captured: string | null = null;
    __setTestAiRunner(async (inputs) => {
      captured = inputs.prompt;
      return { response: "32:17" };
    });
    const hint = new Date(Date.UTC(2024, 0, 1, 14, 32, 5));
    await readDialTime(fakeImage, fakeEnv, hint);
    expect(captured).toContain("14:32:05");
    expect(captured).toContain("reference clock");
  });
});

describe("buildPrompt", () => {
  it("produces a prompt that asks for MM:SS", () => {
    const prompt = buildPrompt();
    expect(prompt).toContain("minute and second hand");
    expect(prompt).toContain("MM:SS");
    expect(prompt).toContain("NO_DIAL");
    expect(prompt).toContain("UNREADABLE");
    expect(prompt).not.toContain("HH:MM:SS");
  });

  it("embeds the reference timestamp as HH:MM:SS (UTC)", () => {
    const prompt = buildPrompt(new Date(Date.UTC(2024, 0, 1, 3, 5, 9)));
    expect(prompt).toContain("03:05:09");
  });

  it("never instructs the model to copy the reference time", () => {
    const prompt = buildPrompt(new Date(Date.UTC(2024, 0, 1, 9, 15, 30)));
    // Regression guard: the archived watchdrift prompt literally said
    // "return this time". We must never do that.
    expect(prompt).not.toMatch(/return this time/i);
    expect(prompt).not.toMatch(/reply with this time/i);
    // The prompt names the reference anchor, but the output surface
    // is MM:SS only — the model cannot honestly "copy" the reference
    // without reading the dial.
    expect(prompt).toContain("reference clock");
  });
});
