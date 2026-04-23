// CSS-only progress ring for the "verified readings" ratio.
//
// Used by:
//   - The dashboard watch cards (small, 48 px), so owners can glance
//     at each watch's verification progress.
//   - The watch detail page (larger, 72 px) beside the session stats
//     panel.
//
// Renders as an SVG with two concentric circles — a track and a
// progress arc drawn via stroke-dasharray. Zero client-side JS
// animation: the ratio is baked into the dash offset at render
// time.
//
// Caption below the ring comes from readingsToBadge:
//   - earned       → "Verified watch"
//   - not earned   → "X of Y verified — needs Z more to earn the badge"
//
// Pass an explicit `size` to get a larger ring; default is dashboard
// card size.

import { readingsToBadge } from "@/domain/drift-calc";

interface Props {
  verifiedCount: number;
  totalCount: number;
  /** Outer diameter in pixels. Default 48 (dashboard card). */
  size?: number;
  /** Optional extra className wrapper for positioning context. */
  className?: string;
  /** Hide the caption — ring-only mode. Default false. */
  hideCaption?: boolean;
}

export function VerifiedProgressRing({
  verifiedCount,
  totalCount,
  size = 48,
  className,
  hideCaption = false,
}: Props) {
  const { earned, needed, ratio } = readingsToBadge(verifiedCount, totalCount);
  const displayPct = Math.round(ratio * 100);

  // Ring geometry: stroke width scales with size so the ring never
  // looks heavy on small variants.
  const strokeWidth = Math.max(3, Math.round(size / 12));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // Clamp progress to the badge threshold so the ring fills in the
  // first quarter and then gracefully tops out at 100 % when the
  // badge is earned (which means 25 %+ — past that, UI says "done").
  const ringProgress = earned ? 1 : Math.min(1, ratio / 0.25);
  const dashLength = circumference * ringProgress;
  const dashGap = circumference - dashLength;

  // Caption copy:
  //  - Badge earned → positive, short.
  //  - Not earned → precise "X of Y — needs Z more".
  //  - No readings → calm "No readings yet" (keeps the layout).
  const caption =
    totalCount === 0
      ? "No readings yet"
      : earned
        ? "Verified watch"
        : `${verifiedCount} of ${totalCount} verified — needs ${needed} more to earn the badge`;

  return (
    <div
      className={"flex items-center gap-3" + (className ? ` ${className}` : "")}
      data-verified-progress-ring="true"
      data-verified-earned={earned ? "true" : "false"}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Verified ${displayPct} percent`}
        className="shrink-0"
      >
        <title>{caption}</title>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          className="stroke-cf-border"
          strokeWidth={strokeWidth}
        />
        {/* Progress — rotated -90° so the arc starts at 12 o'clock. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          className={earned ? "stroke-cf-orange" : "stroke-cf-orange/80"}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${dashLength} ${dashGap}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        {/* Center label — the percent in the middle of the ring, only
            when size is large enough to fit readably. */}
        {size >= 64 ? (
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-cf-text font-mono text-sm"
          >
            {displayPct}%
          </text>
        ) : null}
      </svg>
      {hideCaption ? null : <p className="text-xs text-cf-text-muted">{caption}</p>}
    </div>
  );
}
