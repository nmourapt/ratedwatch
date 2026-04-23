// Sentry stub — placeholder until `@sentry/cloudflare` is wired up and
// the operator provisions `SENTRY_DSN`. The production interface must
// stay shaped the same way (async captureException(err, ctx)) so the
// swap is a one-file change.

import { describe, expect, it, vi } from "vitest";
import { captureException } from "./sentry-stub";

describe("captureException (stub)", () => {
  it("logs the error to console.error with optional context", () => {
    const err = new Error("boom");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    captureException(err, { route: "/api/v1/watches" });
    expect(spy).toHaveBeenCalled();
    const firstArg = spy.mock.calls[0]![0];
    expect(String(firstArg)).toContain("sentry-stub");
    spy.mockRestore();
  });

  it("never throws — even when ctx is omitted", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => captureException(new Error("oops"))).not.toThrow();
    spy.mockRestore();
  });
});
