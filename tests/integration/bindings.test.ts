import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

// The Worker's data-layer bindings declared in wrangler.jsonc are exercised
// here against miniflare's local implementations of D1, R2, and KV. The test
// is indifferent to the real Cloudflare resource IDs — it only verifies that
// each binding is (a) present at runtime and (b) of the right shape to
// round-trip a value.
//
// See issue #3: "One trivial integration test asserting that the Worker can
// round-trip a value through each binding."

describe("data layer bindings", () => {
  it("D1.DB executes SELECT 1 and returns the expected row", async () => {
    const result = await env.DB.prepare("SELECT 1 as one").first<{ one: number }>();
    expect(result).toEqual({ one: 1 });
  });

  it("R2.WATCH_IMAGES round-trips a small object", async () => {
    const key = `test/${crypto.randomUUID()}`;
    await env.WATCH_IMAGES.put(key, "hello images");
    const body = await env.WATCH_IMAGES.get(key);
    expect(body).not.toBeNull();
    expect(await body!.text()).toBe("hello images");
    await env.WATCH_IMAGES.delete(key);
  });

  it("IMAGES (Workers Images binding) exposes input/info", () => {
    // Slice #2 of PRD #99 introduces the Cloudflare Images binding.
    // We don't run a real transform here (Sharp at the edge isn't
    // exercised by miniflare's loopback in every CI environment) —
    // just verify the binding shape so the dial-cropper module can
    // depend on it.
    expect(typeof env.IMAGES.input).toBe("function");
    expect(typeof env.IMAGES.info).toBe("function");
  });

  it("R2.LOGS round-trips a small object", async () => {
    const key = `test/${crypto.randomUUID()}`;
    await env.LOGS.put(key, "hello logs");
    const body = await env.LOGS.get(key);
    expect(body).not.toBeNull();
    expect(await body!.text()).toBe("hello logs");
    await env.LOGS.delete(key);
  });

  it("ANALYTICS.writeDataPoint is callable and non-throwing", () => {
    // Analytics Engine writes are fire-and-forget — the binding is
    // present, `writeDataPoint` is a function, and calling it doesn't
    // throw. Verifying the dataset actually received a row is out of
    // scope for miniflare (AE data is only queryable post-deploy).
    const analytics = (env as unknown as { ANALYTICS?: AnalyticsEngineDataset })
      .ANALYTICS;
    expect(analytics).toBeDefined();
    expect(typeof analytics!.writeDataPoint).toBe("function");
    expect(() =>
      analytics!.writeDataPoint({
        blobs: ["smoke", "{}"],
        indexes: ["smoke"],
      }),
    ).not.toThrow();
  });

  it("KV.FLAGS round-trips a key/value pair", async () => {
    const key = `test:${crypto.randomUUID()}`;
    await env.FLAGS.put(key, "on");
    expect(await env.FLAGS.get(key)).toBe("on");
    await env.FLAGS.delete(key);
    expect(await env.FLAGS.get(key)).toBeNull();
  });
});
