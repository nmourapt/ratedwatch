// Server-rendered SVG deviation-over-time chart.
//
// Design rules:
//   * Pure markup — zero JS. The public-pages contract forbids script
//     tags on SSR surfaces (asserted by integration tests).
//   * Responsive via preserveAspectRatio + CSS `width:100%; height:auto`.
//   * Robust against degenerate inputs: zero readings, one reading,
//     all-same-timestamp, and all-same-deviation must all render
//     something sensible without dividing by zero.
//
// X axis = `reference_timestamp` (monotonically increasing, normalised
// to the chart width). Y axis = `deviation_seconds`, flipped so that
// "running fast" (positive deviation) renders above the baseline.

import type { Reading } from "@/domain/drift-calc";

export interface ChartProps {
  readings: readonly Reading[];
  /** Viewport width. Default 600 matches the CSS in page.tsx. */
  width?: number;
  /** Viewport height. Default 200 matches the CSS in page.tsx. */
  height?: number;
}

const PAD_X = 32; // leave room for y-axis labels
const PAD_Y = 16;

export const DeviationChart = ({ readings, width = 600, height = 200 }: ChartProps) => {
  // Degenerate cases: 0 or 1 reading — draw the axes + a single
  // centered dot if we have one point. No crash, no NaN.
  if (readings.length === 0) {
    return (
      <svg
        class="cf-deviation-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Deviation chart — no readings yet"
        xmlns="http://www.w3.org/2000/svg"
      >
        <Axes width={width} height={height} />
      </svg>
    );
  }

  const sorted = [...readings].sort(
    (a, b) => a.reference_timestamp - b.reference_timestamp,
  );

  const minT = sorted[0]!.reference_timestamp;
  const maxT = sorted[sorted.length - 1]!.reference_timestamp;
  const tSpan = maxT - minT;

  const minDev = Math.min(...sorted.map((r) => r.deviation_seconds));
  const maxDev = Math.max(...sorted.map((r) => r.deviation_seconds));
  // If all readings have the same deviation, expand the span by ±1 so
  // the point lands mid-chart rather than on the top axis.
  const devSpan = maxDev - minDev || 1;

  const chartW = width - PAD_X * 2;
  const chartH = height - PAD_Y * 2;

  const points = sorted.map((r) => {
    const x =
      tSpan === 0
        ? PAD_X + chartW / 2
        : PAD_X + ((r.reference_timestamp - minT) / tSpan) * chartW;
    const y = PAD_Y + chartH - ((r.deviation_seconds - minDev) / devSpan) * chartH;
    return { x, y, reading: r };
  });

  const polyline = points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");

  return (
    <svg
      class="cf-deviation-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Deviation chart with ${readings.length} readings`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <Axes width={width} height={height} />
      <polyline class="cf-deviation-chart__line" fill="none" points={polyline} />
      {points.map((p) => (
        <circle
          class={
            p.reading.verified
              ? "cf-deviation-chart__dot cf-deviation-chart__dot--verified"
              : "cf-deviation-chart__dot"
          }
          cx={p.x.toFixed(2)}
          cy={p.y.toFixed(2)}
          r="4"
          data-reading-point="true"
        >
          <title>
            {new Date(p.reading.reference_timestamp).toISOString()}:{" "}
            {p.reading.deviation_seconds.toFixed(1)}s
            {p.reading.verified ? " (verified)" : ""}
          </title>
        </circle>
      ))}
    </svg>
  );
};

function Axes({ width, height }: { width: number; height: number }) {
  return (
    <g class="cf-deviation-chart__axes" aria-hidden="true">
      {/* Bottom axis */}
      <line x1={PAD_X} y1={height - PAD_Y} x2={width - PAD_X} y2={height - PAD_Y} />
      {/* Left axis */}
      <line x1={PAD_X} y1={PAD_Y} x2={PAD_X} y2={height - PAD_Y} />
    </g>
  );
}
