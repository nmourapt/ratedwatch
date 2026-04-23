// Unit tests for the deviation chart's SSR output.
//
// hono/jsx components are callable as plain functions that return a
// serialisable VNode — we render via `toString()` and assert on the
// resulting HTML. Fast, no Worker required.

import { describe, expect, it } from "vitest";
import type { Reading } from "@/domain/drift-calc";
import { DeviationChart } from "./chart";

const DAY = 86_400_000;

function render(node: unknown): string {
  // hono/jsx nodes are serialisable via String() / toString() for SSR.
  return String(node);
}

const R = (
  id: string,
  ms: number,
  dev: number,
  overrides: Partial<Reading> = {},
): Reading => ({
  id,
  reference_timestamp: ms,
  deviation_seconds: dev,
  is_baseline: false,
  verified: false,
  ...overrides,
});

describe("DeviationChart", () => {
  it("renders an empty chart for zero readings (axes only, no <circle>)", () => {
    const html = render(<DeviationChart readings={[]} />);
    expect(html).toMatch(/<svg\b/);
    expect(html).toMatch(/viewBox="0 0 600 200"/);
    expect(html).not.toMatch(/<circle\b/);
  });

  it("renders one <circle data-reading-point> per reading", () => {
    const html = render(
      <DeviationChart
        readings={[
          R("r1", 0, 0, { is_baseline: true }),
          R("r2", 7 * DAY, 3.5),
          R("r3", 14 * DAY, 7, { verified: true }),
        ]}
      />,
    );
    const circleMatches = html.match(/<circle\b[^>]*data-reading-point="true"/g) ?? [];
    expect(circleMatches).toHaveLength(3);
  });

  it("includes a polyline connecting the points", () => {
    const html = render(
      <DeviationChart
        readings={[
          R("r1", 0, 0, { is_baseline: true }),
          R("r2", 7 * DAY, 3.5),
          R("r3", 14 * DAY, 7),
        ]}
      />,
    );
    expect(html).toMatch(/<polyline\b/);
    // The points attribute should carry three comma-separated x,y pairs.
    const polylineMatch = html.match(/points="([^"]+)"/);
    expect(polylineMatch).not.toBeNull();
    const pointCount = polylineMatch![1]!.trim().split(/\s+/).length;
    expect(pointCount).toBe(3);
  });

  it("handles a single reading without NaN", () => {
    const html = render(
      <DeviationChart readings={[R("r1", 12345, -2.5, { is_baseline: true })]} />,
    );
    expect(html).not.toContain("NaN");
    // And still emits exactly one circle.
    const circleMatches = html.match(/<circle\b[^>]*data-reading-point="true"/g) ?? [];
    expect(circleMatches).toHaveLength(1);
  });

  it("handles all-same-timestamp readings without NaN", () => {
    const t = 1_700_000_000_000;
    const html = render(
      <DeviationChart readings={[R("r1", t, 0, { is_baseline: true }), R("r2", t, 5)]} />,
    );
    expect(html).not.toContain("NaN");
  });

  it("handles all-same-deviation readings without NaN", () => {
    const html = render(
      <DeviationChart
        readings={[
          R("r1", 0, 0, { is_baseline: true }),
          R("r2", DAY, 0),
          R("r3", 2 * DAY, 0),
        ]}
      />,
    );
    expect(html).not.toContain("NaN");
  });

  it("is responsive: preserveAspectRatio lets it scale to viewport", () => {
    const html = render(<DeviationChart readings={[]} />);
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it("emits zero <script> tags (no client JS)", () => {
    const html = render(
      <DeviationChart
        readings={[R("r1", 0, 0, { is_baseline: true }), R("r2", DAY, 1)]}
      />,
    );
    expect(html).not.toMatch(/<script\b/i);
  });
});
