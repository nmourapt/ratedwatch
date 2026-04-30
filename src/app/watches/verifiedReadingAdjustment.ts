// Pure helpers for the verified-reading SPA confirmation page.
//
// Originally added in slice #7 of PRD #99 (issue #106) with a
// seconds-only ±30s adjustment cap. PR #122 reworks the UX into
// per-component HH:MM:SS up/down arrows with no cap, after the
// observation that:
//
//   1. The seconds-only cap couldn't actually prevent fraud — a
//      determined cheater knows the rough current time from their
//      phone and can game the value either way regardless of
//      whether the cap is ±30s, ±5s, or unbounded. The cap was
//      always more about gentle UI nudge than security.
//
//   2. The hour shown to the user in the original UI was derived
//      from the server reference timestamp's UTC hour, which is
//      WRONG when EXIF is missing and the user is in a non-UTC
//      timezone (e.g. Lisbon DST = UTC+1 means the watch reads 14
//      while the server says 13). The user couldn't override it,
//      so the deviation calc silently used the wrong hour.
//
//   3. Real watch deviations come in three shapes: seconds (typical
//      mechanical drift), minutes (model misread or watch needs
//      regulation), and hours (model picked the wrong rollover side
//      or DST mismatch). All three need an adjustment knob.
//
// The new design: each of HH / MM / SS gets independent up/down
// arrows. Pressing "MM ▲" at 59 wraps to 00 within the minutes
// component only — it does NOT carry into hours. This keeps the
// mental model dead simple ("set each digit to match what your
// dial reads") and matches the way most setting crowns work on
// real watches.
//
// The photo is still stored for audit (slice #6), the rate limiter
// is still in front (slice #82 of PRD #73), and the SPA still
// hides the deviation. Honest users enter what they see; cheaters
// have always been able to cheat — the photo is the audit trail.

/**
 * 12-hour-clock HH:MM:SS triple, matching what an analog watch
 * displays. `h` is 1..12 (no AM/PM signal — analog dials don't
 * show one). `m` and `s` are 0..59.
 */
export interface Hms {
  h: number;
  m: number;
  s: number;
}

/** Which component the up/down button targets. */
export type HmsComponent = "h" | "m" | "s";

/**
 * Adjust ONE component of the HMS triple by `delta`, wrapping
 * within that component only. Cross-component carry is intentionally
 * disabled: pressing minutes ▲ at 59 wraps to 0 (still within the
 * minute slot), it does NOT increment the hour. Same for seconds.
 *
 * This matches how a manual setting crown on a watch works (you
 * pull the crown and crank the minute hand; hours don't move with
 * minute rollover unless you're explicitly setting them).
 *
 * Hours wrap 12 → 1 → 12 (12-hour cycle, no zero — analog dials
 * read "12" not "0"). Minutes and seconds wrap 59 → 0 → 59.
 */
export function adjustComponent(
  current: Hms,
  component: HmsComponent,
  delta: number,
): Hms {
  if (component === "h") {
    // 12-hour cycle: map 1..12 to 0..11, add delta, mod 12, map back.
    const idx = (((current.h - 1 + delta) % 12) + 12) % 12;
    return { ...current, h: idx + 1 };
  }
  if (component === "m") {
    const next = (((current.m + delta) % 60) + 60) % 60;
    return { ...current, m: next };
  }
  // component === "s"
  const next = (((current.s + delta) % 60) + 60) % 60;
  return { ...current, s: next };
}

/**
 * Format an HMS triple as "HH:MM:SS" with zero padding (note: hour
 * is 1..12 so no leading zeros are stripped — "01:02:03" looks
 * fine, "1:02:03" would look uneven against the bigger numbers).
 */
export function formatHms(hms: Hms): string {
  const h = String(hms.h).padStart(2, "0");
  const m = String(hms.m).padStart(2, "0");
  const s = String(hms.s).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Coerce an arbitrary input into a valid Hms or null. Used for
 * defensive parsing of the server's predicted_hms response — if
 * something upstream goes off the rails we don't want to render
 * NaN in the UI or send NaN to /confirm.
 */
export function parseHms(input: unknown): Hms | null {
  if (input === null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const h = obj.h;
  const m = obj.m;
  const s = obj.s;
  if (typeof h !== "number" || typeof m !== "number" || typeof s !== "number") {
    return null;
  }
  if (!Number.isInteger(h) || !Number.isInteger(m) || !Number.isInteger(s)) {
    return null;
  }
  if (h < 1 || h > 12) return null;
  if (m < 0 || m > 59) return null;
  if (s < 0 || s > 59) return null;
  return { h, m, s };
}
