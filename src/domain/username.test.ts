import { describe, it, expect, vi } from "vitest";
import { generateSlugUsername } from "./username";

// Collision-resistant slug generator. Format is `adjective-noun-NNN`
// where NNN is three digits (000-999). The function takes an abstract
// `exists(username)` check so it stays a pure domain function — the
// Better Auth `createUser` hook plugs in a real Kysely call.

describe("generateSlugUsername — format + curated words", () => {
  it("returns a string shaped like adjective-noun-NNN", async () => {
    const username = await generateSlugUsername({
      exists: async () => false,
    });

    // Three lowercase hyphen-separated parts, last is exactly 3 digits.
    expect(username).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });

  it("picks adjective + noun from the curated word lists", async () => {
    // Run many times and collect unique first/second segments. Each
    // list has ~100 entries — over 200 draws we should see at least
    // a handful of distinct adjectives and nouns. This fires if the
    // lists ever get truncated to a single word.
    const adjectives = new Set<string>();
    const nouns = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const u = await generateSlugUsername({ exists: async () => false });
      const parts = u.split("-");
      expect(parts).toHaveLength(3);
      adjectives.add(parts[0]!);
      nouns.add(parts[1]!);
    }
    expect(adjectives.size).toBeGreaterThan(5);
    expect(nouns.size).toBeGreaterThan(5);
  });
});

describe("generateSlugUsername — retry + fallback", () => {
  it("retries when the first candidate collides, then returns a unique one", async () => {
    let call = 0;
    // First call says the slug exists (collision), second call says it
    // doesn't. The returned username should therefore come from the
    // second candidate.
    const exists = vi.fn(async () => {
      call += 1;
      return call === 1;
    });

    const username = await generateSlugUsername({ exists });

    expect(exists).toHaveBeenCalledTimes(2);
    expect(username).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });

  it("falls back to user-<timestamp> after 5 failed retries", async () => {
    const exists = vi.fn(async () => true); // always collides

    const username = await generateSlugUsername({ exists });

    expect(exists).toHaveBeenCalledTimes(5);
    expect(username).toMatch(/^user-\d+$/);
  });
});
