// Unit tests for the beforeSend filter that drops known-noisy
// runtime errors (AbortError, WorkerTimeout) before they burn
// Sentry event budget. Everything else — TypeError, ReferenceError,
// custom app errors — must pass through unchanged.
//
// We test beforeSend as a pure function (exported from ./sentry) so
// these tests don't need the full Sentry SDK wiring.

import { describe, expect, it } from "vitest";
import { beforeSend } from "./sentry";
import type { ErrorEvent, EventHint } from "@sentry/cloudflare";

function makeEvent(exceptionType: string, message = "x"): ErrorEvent {
  return {
    type: undefined,
    exception: {
      values: [{ type: exceptionType, value: message }],
    },
  } as ErrorEvent;
}

describe("beforeSend — drops known-noisy runtime errors", () => {
  it("filters out AbortError (client disconnect mid-response)", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const evt = makeEvent("AbortError", "aborted");
    const hint: EventHint = { originalException: err };
    expect(beforeSend(evt, hint)).toBeNull();
  });

  it("filters out WorkerTimeout (CPU-time limit)", () => {
    const err = Object.assign(new Error("cpu exceeded"), {
      name: "WorkerTimeout",
    });
    const evt = makeEvent("WorkerTimeout", "cpu exceeded");
    const hint: EventHint = { originalException: err };
    expect(beforeSend(evt, hint)).toBeNull();
  });

  it("passes through a generic Error unchanged", () => {
    const err = new Error("boom");
    const evt = makeEvent("Error", "boom");
    const hint: EventHint = { originalException: err };
    expect(beforeSend(evt, hint)).toBe(evt);
  });

  it("passes through TypeError (real bug signal)", () => {
    const err = new TypeError("cannot read x of undefined");
    const evt = makeEvent("TypeError", "cannot read x of undefined");
    const hint: EventHint = { originalException: err };
    expect(beforeSend(evt, hint)).toBe(evt);
  });

  it("falls back to event.exception.values[0].type when hint.originalException is absent", () => {
    // Sentry doesn't always populate originalException (e.g. events
    // constructed from captureMessage paths). Ensure we still drop
    // the noisy type from the event payload itself.
    const evt = makeEvent("AbortError", "aborted");
    expect(beforeSend(evt, {})).toBeNull();
  });
});
