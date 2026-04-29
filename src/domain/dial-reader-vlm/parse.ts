// HH:MM:SS extractor for VLM model output.
//
// The prompt asks the model for "ONLY HH:MM:SS" but in practice
// models emit prose, Markdown, or chain-of-thought leakage.
// `parseHmsResponse` lifts the first plausible HH:MM:SS substring
// out of the response and rejects obviously-invalid times.
//
// Lifted from `scripts/vlm-bakeoff/bakeoff.py::_parse_response_hms`.
// The semantics MUST match the bake-off so the bake-off accuracy
// numbers carry over to production.

/**
 * 12-hour clock components extracted from a model response.
 * `h` is in [1, 12], `m` and `s` are in [0, 59].
 */
export interface ParsedHms {
  h: number;
  m: number;
  s: number;
}

// `\b` works on word boundaries, which means it matches between a
// digit and a non-digit. This stops us from picking up the "2:34:56"
// inside "ID-2:34:56X" but does pick up "Time: 10:19:34." which is
// the most common surrounding-prose case.
const HMS_RE = /\b(\d{1,2}):(\d{2}):(\d{2})\b/;

/**
 * Pull HH:MM:SS out of a model response string. Returns `null` if no
 * plausible time is present, or the matched substring is out of
 * range for a 12-hour analog dial (h ∈ [1, 12], m ∈ [0, 59], s ∈
 * [0, 59]).
 *
 * If the response contains multiple matches (e.g. chain-of-thought
 * leakage that echoes a candidate before the final answer), we
 * return the FIRST one. This matches the Python reference.
 */
export function parseHmsResponse(raw: string): ParsedHms | null {
  if (!raw) {
    return null;
  }
  const match = HMS_RE.exec(raw);
  if (!match) {
    return null;
  }
  // Indexed access is `string | undefined` under
  // noUncheckedIndexedAccess. The regex has three capture groups
  // and `match` is non-null here, so all three are present —
  // assert non-null to keep the branch coverage clean (the `??`
  // fallback would be permanently dead). If the regex shape ever
  // changes, the test suite will catch the off-by-one.
  const h = Number(match[1]!);
  const m = Number(match[2]!);
  const s = Number(match[3]!);

  // The regex captures `\d{1,2}` and `\d{2}`, so `Number(hStr)`,
  // `Number(mStr)` and `Number(sStr)` are always finite non-negative
  // ints in [0, 99]. We therefore only need to bound-check the upper
  // ends; the lower bound is implicit from the regex.
  if (h < 1 || h > 12) {
    return null;
  }
  if (m > 59) {
    return null;
  }
  if (s > 59) {
    return null;
  }
  return { h, m, s };
}
