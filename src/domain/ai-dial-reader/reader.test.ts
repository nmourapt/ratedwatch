import { afterEach, describe, it, expect } from "vitest";
import { buildPrompt, readDialTime } from "./reader";
import { __setTestAiRunner, type AiRunner, type AiRunnerEnv } from "./runner";

// These tests drive the reader through a fake AiRunner. No real AI
// binding is ever invoked — the module-level `testRunner` override
// (see runner.ts) redirects every call to the fake we install here.

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
  it("parses HH:MM:SS into {hours, minutes, seconds}", async () => {
    installFake("14:32:07");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({
      hours: 14,
      minutes: 32,
      seconds: 7,
      raw_response: "14:32:07",
    });
  });

  it("trims surrounding whitespace before parsing", async () => {
    installFake("   09:05:00  \n");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect(result).toEqual({
      hours: 9,
      minutes: 5,
      seconds: 0,
      raw_response: "09:05:00",
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
    installFake("The time appears to be 2:32 PM");
    const result = await readDialTime(fakeImage, fakeEnv);
    expect("error" in result ? result.error : null).toBe("unparseable");
    if ("error" in result) {
      expect(result.raw_response).toBe("The time appears to be 2:32 PM");
    }
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

  it("rejects 25:00:00 as unparseable (out-of-range hour)", async () => {
    installFake("25:00:00");
    const result = await readDialTime(fakeImage, fakeEnv);
    // The strict regex makes this an unparseable rather than implausible;
    // defence-in-depth's range check only kicks in if the regex ever
    // loosens. Either classification is acceptable from an API-surface
    // perspective (both are non-success errors), so assert on the
    // broader "this is an error" contract.
    expect("error" in result).toBe(true);
  });

  it("passes the image array and prompt to the AI runner", async () => {
    let captured: { image: number[]; prompt: string } | null = null;
    __setTestAiRunner(async (inputs) => {
      captured = { image: inputs.image, prompt: inputs.prompt };
      return { response: "10:00:00" };
    });
    await readDialTime(fakeImage, fakeEnv);
    expect(captured).not.toBeNull();
    expect(captured!.image).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(captured!.prompt).toContain("HH:MM:SS");
    expect(captured!.prompt).toContain("NO_DIAL");
  });

  it("hint time flows into the prompt as a disambiguation aid (not as the answer)", async () => {
    let captured: string | null = null;
    __setTestAiRunner(async (inputs) => {
      captured = inputs.prompt;
      return { response: "15:00:00" };
    });
    const hint = new Date(Date.UTC(2024, 0, 1, 14, 32, 0));
    await readDialTime(fakeImage, fakeEnv, hint);
    expect(captured).toContain("14:32");
    // Explicit defence against the archived-prototype sin.
    expect(captured).toContain("Do not copy this value");
    expect(captured).toContain("disambiguate AM/PM");
  });
});

describe("buildPrompt", () => {
  it("does not leak a hint when none is given", () => {
    const prompt = buildPrompt();
    expect(prompt).not.toContain("The approximate time is");
    expect(prompt).toContain("HH:MM:SS");
  });

  it("embeds the hint zero-padded to HH:MM", () => {
    const prompt = buildPrompt(new Date(Date.UTC(2024, 0, 1, 3, 5, 0)));
    expect(prompt).toContain("03:05");
  });

  it("never instructs the model to return the hint directly", () => {
    const prompt = buildPrompt(new Date(Date.UTC(2024, 0, 1, 9, 15, 0)));
    // Regression guard: the archived watchdrift prompt literally said
    // "return this time". We must never do that.
    expect(prompt).not.toMatch(/return this time/i);
    expect(prompt).not.toMatch(/reply with this time/i);
    expect(prompt).toContain("Do not copy this value");
  });
});
