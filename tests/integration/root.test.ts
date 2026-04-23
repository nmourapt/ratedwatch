import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

describe("GET /", () => {
  it("returns 200 with a body that mentions rated.watch", async () => {
    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/"),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("rated.watch");
  });
});
