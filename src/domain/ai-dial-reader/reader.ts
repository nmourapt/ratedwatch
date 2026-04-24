// AI dial reader. Takes a JPEG of a watch face and asks a vision
// model for the minute + second positions the watch is displaying.
// Returns a structured `DialReading` (minutes + seconds) or a
// structured error.
//
// This module is deliberately small and side-effect-free apart from
// the single AI call: the verified-reading pipeline (reading-verifier)
// composes on top of it, so any future swap of the underlying model
// just means dropping in a different `resolveAiRunner` — the rest of
// the verifier doesn't change.
//
// Trust contract (AGENTS.md): we never, ever tell the model "just
// return the reference time". The archived watchdrift prototype did
// that and produced a cheating system. The reference clock is used
// as the HOUR anchor only — the hour of a verified reading comes
// from the server clock, not from the model. Minutes and seconds
// both come from the model's own visual read of the dial.
//
// Why both minutes and seconds (changed from seconds-only): a
// seconds-only contract caps us at ±30 s of detectable drift (a
// watch that's drifted ~45 s past the reference would wrap and
// under-report). Real mechanical drift routinely exceeds 30 s over
// a session, so we need the minute hand to disambiguate. Minute +
// second gives us a ±30 *minute* detection range, which is more
// than adequate for any realistic mechanical watch.

import { resolveAiRunner, type AiRunnerEnv, type AiRunResponse } from "./runner";

/**
 * A successful dial read. Minute + second hand positions only — the
 * hour comes from the reference clock in the verifier because a
 * 12-hour dial wrap makes any hour output ambiguous.
 */
export interface DialReading {
  // Minute hand position (0-59). Comes from the model's visual read.
  minutes: number;
  // Second hand position (0-59). Comes from the model's visual read.
  seconds: number;
  raw_response: string;
}

export type DialReaderErrorCode = "refused" | "unparseable" | "implausible";

export interface DialReaderError {
  error: DialReaderErrorCode;
  raw_response?: string;
}

export interface DialReaderEnv extends AiRunnerEnv {}

// Strict parse: MM:SS with 1-2 digits each side, no leading +/-, no
// decimals. Anchored so we don't accept "32:17 seconds" or "about
// 32:17". The model is instructed to reply in this exact shape.
const MINUTES_AND_SECONDS = /^(\d{1,2}):(\d{1,2})$/;

const PROMPT_BASE = `You are reading a mechanical watch dial shown in a photo.

The reference clock reads HH_ANCHOR right now. The watch is approximately
synchronised with this reference — typically within a few minutes either
way. Your task is to read the watch's minute and second hand positions.

Report the time the watch displays in the format MM:SS where:
- MM is the minute value 0-59 (where the MINUTE hand points — usually
  the slightly shorter, thicker hand that advances once per minute)
- SS is the second value 0-59 (where the SECOND hand points — the
  thinnest hand that sweeps continuously or ticks once per second)

Do not report the hour — we have that from the reference clock.
Do not explain. Do not pad with zeros unless natural (both "3:07" and
"03:07" are accepted).

If you cannot read the minute or second hand clearly, reply with
exactly: UNREADABLE

If the image is not a watch dial, reply with exactly: NO_DIAL

Examples of valid replies: "32:17", "03:45", "59:0", "0:12",
"UNREADABLE", "NO_DIAL"`;

/**
 * Build the prompt. Embeds a reference timestamp as an HH:MM:SS
 * anchor, so the model knows "the reference clock reads X right now"
 * and can focus its entire output on the seconds.
 *
 * When no hint is provided (shouldn't happen from the verifier, but
 * keeps this helper honest), the anchor is a generic placeholder
 * that doesn't steer the model toward any particular value.
 */
export function buildPrompt(hintTime?: Date): string {
  const anchor = hintTime ? formatHmsUtc(hintTime) : "an unknown time";
  return PROMPT_BASE.replace("HH_ANCHOR", anchor);
}

function formatHmsUtc(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Call the vision model and parse its reply. Never throws — any
 * network / model failure is reflected as `{ error: "unparseable" }`
 * so the caller can turn it into a 422.
 */
export async function readDialTime(
  image: Uint8Array,
  env: DialReaderEnv,
  hintTime?: Date,
): Promise<DialReading | DialReaderError> {
  const runner = resolveAiRunner(env);

  let result: AiRunResponse;
  try {
    result = await runner({
      image,
      prompt: buildPrompt(hintTime),
    });
  } catch (err) {
    // Network / binding / model failures all collapse to "unparseable"
    // at this layer; the route converts that to a 422 so the SPA can
    // surface a retry prompt. Leave a console.warn so production
    // tails stay debuggable.
    console.warn("ai-dial-reader: upstream AI call threw:", err);
    return { error: "unparseable" };
  }

  const raw = typeof result.response === "string" ? result.response.trim() : "";
  if (raw.length === 0) {
    return { error: "unparseable", raw_response: raw };
  }

  if (raw === "NO_DIAL" || raw === "UNREADABLE") {
    return { error: "refused", raw_response: raw };
  }

  const match = MINUTES_AND_SECONDS.exec(raw);
  if (!match) {
    return { error: "unparseable", raw_response: raw };
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    // e.g. "99:17" — passes the regex but out of range.
    return { error: "implausible", raw_response: raw };
  }

  return { minutes, seconds, raw_response: raw };
}
