import { describe, it, expect } from "vitest";
import { parseRuleJson } from "./parse";

// Validation happens at the edge (admin CLI, admin UI) *before* any
// KV write. These tests pin the contract so a future caller can trust
// `parseRuleJson` to reject bad input without having to reimplement
// the Zod schema surface.

describe("parseRuleJson — valid rules", () => {
  it("accepts an always rule", () => {
    const { rule, canonicalJson } = parseRuleJson('{"mode":"always"}');
    expect(rule).toEqual({ mode: "always" });
    expect(JSON.parse(canonicalJson)).toEqual({ mode: "always" });
  });

  it("accepts a never rule", () => {
    const { rule } = parseRuleJson('{"mode":"never"}');
    expect(rule).toEqual({ mode: "never" });
  });

  it("accepts a users rule", () => {
    const { rule } = parseRuleJson('{"mode":"users","users":["u-1","u-2"]}');
    expect(rule).toEqual({ mode: "users", users: ["u-1", "u-2"] });
  });

  it("accepts a rollout rule", () => {
    const { rule } = parseRuleJson('{"mode":"rollout","rolloutPct":25}');
    expect(rule).toEqual({ mode: "rollout", rolloutPct: 25 });
  });

  it("canonicalises whitespace / extra keys out of the stored JSON", () => {
    const { canonicalJson } = parseRuleJson('{\n  "mode":   "always"\n}');
    expect(canonicalJson).toBe('{"mode":"always"}');
  });
});

describe("parseRuleJson — invalid rules", () => {
  it("rejects malformed JSON", () => {
    expect(() => parseRuleJson("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects unknown mode", () => {
    expect(() => parseRuleJson('{"mode":"sometimes"}')).toThrow(/schema validation/);
  });

  it("rejects rolloutPct out of range", () => {
    expect(() => parseRuleJson('{"mode":"rollout","rolloutPct":150}')).toThrow(
      /schema validation/,
    );
    expect(() => parseRuleJson('{"mode":"rollout","rolloutPct":-1}')).toThrow(
      /schema validation/,
    );
  });

  it("rejects fractional rolloutPct", () => {
    expect(() => parseRuleJson('{"mode":"rollout","rolloutPct":25.5}')).toThrow(
      /schema validation/,
    );
  });

  it("rejects users rule missing users array", () => {
    expect(() => parseRuleJson('{"mode":"users"}')).toThrow(/schema validation/);
  });

  it("rejects users rule with empty id strings", () => {
    expect(() => parseRuleJson('{"mode":"users","users":[""]}')).toThrow(
      /schema validation/,
    );
  });
});
