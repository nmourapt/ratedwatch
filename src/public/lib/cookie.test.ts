// Unit tests for the tiny cookie helper used by public pages.
//
// Keep pure so it's reusable from any Hono handler: no Request / Env
// imports here, just strings in and strings out.

import { describe, it, expect } from "vitest";
import { buildSetCookie, parseCookie } from "./cookie";

describe("parseCookie()", () => {
  it("returns an empty object when the header is null / undefined / empty", () => {
    expect(parseCookie(null)).toEqual({});
    expect(parseCookie(undefined)).toEqual({});
    expect(parseCookie("")).toEqual({});
  });

  it("parses a single name=value pair", () => {
    expect(parseCookie("foo=bar")).toEqual({ foo: "bar" });
  });

  it("parses multiple pairs separated by semicolons", () => {
    expect(parseCookie("foo=bar; baz=qux; rw_verified_filter=1")).toEqual({
      foo: "bar",
      baz: "qux",
      rw_verified_filter: "1",
    });
  });

  it("tolerates surrounding whitespace on names and values", () => {
    expect(parseCookie("  foo=bar ;  baz=qux  ")).toEqual({ foo: "bar", baz: "qux" });
  });

  it("ignores malformed pairs without an equals sign", () => {
    expect(parseCookie("foo=bar; invalid; baz=qux")).toEqual({ foo: "bar", baz: "qux" });
  });

  it("handles empty values", () => {
    expect(parseCookie("foo=; baz=qux")).toEqual({ foo: "", baz: "qux" });
  });

  it("URL-decodes percent-encoded values", () => {
    expect(parseCookie("path=%2Fleaderboard%3Fx%3D1")).toEqual({
      path: "/leaderboard?x=1",
    });
  });
});

describe("buildSetCookie()", () => {
  it("emits name=value with Path, Max-Age, and SameSite=Lax by default", () => {
    const cookie = buildSetCookie({
      name: "rw_verified_filter",
      value: "1",
      maxAge: 60,
    });
    expect(cookie).toContain("rw_verified_filter=1");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=60");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("sets Max-Age=0 when clearing", () => {
    const cookie = buildSetCookie({
      name: "rw_verified_filter",
      value: "",
      maxAge: 0,
    });
    expect(cookie).toContain("Max-Age=0");
  });

  it("URL-encodes the value", () => {
    const cookie = buildSetCookie({
      name: "next",
      value: "/leaderboard?x=1",
      maxAge: 60,
    });
    expect(cookie).toContain("next=%2Fleaderboard%3Fx%3D1");
  });
});
