// Small formatting helpers for the leaderboard surface. Split out of
// page.tsx so the pure functions can be unit-tested without standing
// up a Worker.

/**
 * Format a signed seconds-per-day drift rate into "+0.5 s/d" / "-1.2 s/d".
 * Null (not enough data) renders as "—" so the page doesn't leak the
 * special value into the UI.
 */
export function formatDriftRate(spd: number | null): string {
  if (spd === null || !Number.isFinite(spd)) return "—";
  // 0.0 renders as "0.0 s/d" — no leading sign.
  if (spd === 0) return "0.0 s/d";
  const sign = spd > 0 ? "+" : "";
  return `${sign}${spd.toFixed(1)} s/d`;
}

/**
 * Render the full watch name for the leaderboard row — prefers
 * "Brand Model" when both are present, falls back to `name` otherwise.
 */
export function formatWatchLabel(input: {
  name: string;
  brand: string | null;
  model: string | null;
}): string {
  const parts: string[] = [];
  if (input.brand) parts.push(input.brand);
  if (input.model) parts.push(input.model);
  if (parts.length === 0) return input.name;
  return parts.join(" ");
}
