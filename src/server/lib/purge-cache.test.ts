// Unit-ish test for the cache-purge helper. We only exercise the URL
// shaping (no need to mock the Cache API) — the helper's failure mode
// is "swallow and log nothing" by design, so assertions against the
// returned URL list are what matter.

import { describe, it, expect } from "vitest";
import { purgeLeaderboardUrls } from "./purge-cache";

describe("purgeLeaderboardUrls", () => {
  it("emits /leaderboard + ?verified=1 + / on every call", async () => {
    const urls = await purgeLeaderboardUrls({
      requestUrl: new URL("https://rated.watch/api/v1/watches/w1/readings"),
      movementId: null,
      username: null,
      watchId: null,
    });
    expect(urls).toContain("https://rated.watch/leaderboard");
    expect(urls).toContain("https://rated.watch/leaderboard?verified=1");
    expect(urls).toContain("https://rated.watch/");
  });

  it("adds /m/:movementId when provided", async () => {
    const urls = await purgeLeaderboardUrls({
      requestUrl: new URL("https://rated.watch/"),
      movementId: "mov-xyz",
      username: null,
      watchId: null,
    });
    expect(urls).toContain("https://rated.watch/m/mov-xyz");
  });

  it("adds /u/:username when provided", async () => {
    const urls = await purgeLeaderboardUrls({
      requestUrl: new URL("https://rated.watch/"),
      movementId: null,
      username: "alice",
      watchId: null,
    });
    expect(urls).toContain("https://rated.watch/u/alice");
  });

  it("adds /w/:watchId when provided", async () => {
    const urls = await purgeLeaderboardUrls({
      requestUrl: new URL("https://rated.watch/"),
      movementId: null,
      username: null,
      watchId: "watch-123",
    });
    expect(urls).toContain("https://rated.watch/w/watch-123");
  });

  it("omits per-target URLs when the target is null/undefined", async () => {
    const urls = await purgeLeaderboardUrls({
      requestUrl: new URL("https://rated.watch/"),
      movementId: undefined,
      username: undefined,
      watchId: undefined,
    });
    expect(urls.some((u) => u.includes("/m/"))).toBe(false);
    expect(urls.some((u) => u.includes("/u/"))).toBe(false);
    expect(urls.some((u) => u.includes("/w/"))).toBe(false);
  });

  it("uses the host from the request URL (works on preview domains)", async () => {
    const urls = await purgeLeaderboardUrls({
      requestUrl: new URL(
        "https://pr-42-ratedwatch.nmoura.workers.dev/api/v1/readings/r1",
      ),
      movementId: "m1",
      username: "bob",
      watchId: "w1",
    });
    for (const u of urls) {
      expect(u).toMatch(/^https:\/\/pr-42-ratedwatch\.nmoura\.workers\.dev/);
    }
  });
});
