// Direct unit tests for the inactive-path behaviour of
// captureException — when Sentry hasn't been initialised via
// withSentry() (no SENTRY_DSN, no wrapper invocation), the function
// still needs to be safe to call at any point and must swallow its
// own errors. Integration coverage of the real Sentry path is
// deliberately OUT of scope (requires a live DSN + network, which no
// CI should need).

import { describe, expect, it, vi } from "vitest";
import { captureException } from "./sentry";

describe("captureException (Sentry inactive — stub-mode fallback)", () => {
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
