// Best-effort Cache API purge helpers. Called from mutation handlers
// (readings POST/DELETE today, more mutation surfaces later) so fresh
// writes don't sit behind a stale `s-maxage=300` public page for five
// minutes.
//
// Philosophy:
//   * Purging is advisory — if it fails (no Cache API in dev, transient
//     error, whatever), the natural s-maxage expiry still cleans it up
//     within 5 minutes. We never let a purge failure propagate as a
//     handler error. Readings mutations are authoritative; the edge
//     cache is a convenience.
//   * We purge by full URL, not by path, because Cache API is keyed on
//     the request URL. The helpers take a `requestUrl` so the caller
//     can derive the correct origin — inside a Worker handler this is
//     `new URL(c.req.url)` which gives us the live host + scheme.

export interface PurgeLeaderboardUrlsInput {
  /** The URL of the mutating request. Used as a base for scheme+host
   *  so the purged URLs match what the edge actually cached. */
  requestUrl: URL;
  /** movement_id of the affected watch (for /m/:id purge). Null when
   *  the watch has no movement attached. */
  movementId: string | null | undefined;
  /** Owner's username (for /u/:username purge). */
  username: string | null | undefined;
  /** Watch id (for /w/:id purge, slice #15). */
  watchId: string | null | undefined;
}

/**
 * Purge the public-page URLs that depend on reading state for a given
 * watch. Safe to call from any mutation handler. Returns the list of
 * URLs attempted (for logging), not a success/failure — individual
 * deletions are fire-and-forget.
 */
export async function purgeLeaderboardUrls(
  input: PurgeLeaderboardUrlsInput,
): Promise<string[]> {
  const origin = `${input.requestUrl.protocol}//${input.requestUrl.host}`;
  const urls: string[] = [];
  urls.push(`${origin}/leaderboard`);
  urls.push(`${origin}/leaderboard?verified=1`);
  // Home hero shows top-5 verified watches, so it also depends on
  // reading state.
  urls.push(`${origin}/`);
  if (input.movementId) urls.push(`${origin}/m/${input.movementId}`);
  if (input.username) urls.push(`${origin}/u/${input.username}`);
  if (input.watchId) urls.push(`${origin}/w/${input.watchId}`);

  // The default Cache API is only exposed inside the Worker runtime;
  // in local vitest / miniflare it exists but calls are a no-op against
  // the in-memory cache. We guard all of this against `typeof caches`
  // because the `caches` global is otherwise a fresh Worker-runtime
  // reference that some environments don't populate.
  try {
    // Workers `caches.default` is the standard CDN cache.
    const cache =
      typeof caches !== "undefined" && "default" in caches
        ? (caches as unknown as { default: Cache }).default
        : null;
    if (!cache) return urls;
    // Delete each URL in parallel; failures are silent by design.
    await Promise.allSettled(
      urls.map((u) => cache.delete(new Request(u, { method: "GET" }))),
    );
  } catch {
    // Swallow. The s-maxage expiry is the fallback.
  }
  return urls;
}
