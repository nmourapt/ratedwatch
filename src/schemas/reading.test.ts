// Unit tests for the readings Zod schemas. Covers the new tap-reading
// flow (slice: tap UX) where the client sends only `dial_position` +
// `is_baseline` + optional `notes` — reference time is server-side.

import { describe, expect, it } from "vitest";
import { createTapReadingSchema } from "./reading";

describe("createTapReadingSchema", () => {
  it("accepts each canonical dial position", () => {
    for (const pos of [0, 15, 30, 45] as const) {
      const parsed = createTapReadingSchema.safeParse({
        dial_position: pos,
        is_baseline: false,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.dial_position).toBe(pos);
      }
    }
  });

  it("rejects a dial_position that is not 0/15/30/45", () => {
    for (const bad of [1, 7, 14, 59, 60, -1, 22.5]) {
      const parsed = createTapReadingSchema.safeParse({ dial_position: bad });
      expect(parsed.success).toBe(false);
    }
  });

  it("defaults is_baseline to false when omitted", () => {
    const parsed = createTapReadingSchema.safeParse({ dial_position: 0 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.is_baseline).toBe(false);
    }
  });

  it("trims notes and enforces the 500-char max", () => {
    const ok = createTapReadingSchema.safeParse({
      dial_position: 15,
      notes: "   hello   ",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.notes).toBe("hello");

    const tooLong = createTapReadingSchema.safeParse({
      dial_position: 15,
      notes: "x".repeat(501),
    });
    expect(tooLong.success).toBe(false);
  });

  it("rejects a missing dial_position", () => {
    const parsed = createTapReadingSchema.safeParse({ is_baseline: true });
    expect(parsed.success).toBe(false);
  });
});
