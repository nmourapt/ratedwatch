// AI dial reader. Takes a JPEG of a watch face and asks a vision
// model for the position of the second hand. Returns a structured
// `DialReading` (seconds only) or a structured error.
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
// as the HH:MM anchor — the hours + minutes of a verified reading
// come from the server clock, not from the model — but the *seconds*
// come from the model's own visual read of the dial. That split is
// both the honest thing to do and cheaper in tokens: the model's
// output surface is a single integer 0-59.

import { resolveAiRunner, type AiRunnerEnv, type AiRunResponse } from "./runner";

/**
 * A successful dial read. Only the second-hand position — hours and
 * minutes come from the reference clock in the verifier. A watch
 * without a visible second hand cannot produce a verified reading;
 * the model must return UNREADABLE in that case.
 */
export interface DialReading {
  // Second hand position (0-59). Hours + minutes come from the
  // reference clock, not the model — the model is only asked for
  // this one number.
  seconds: number;
  raw_response: string;
}

export type DialReaderErrorCode = "refused" | "unparseable" | "implausible";

export interface DialReaderError {
  error: DialReaderErrorCode;
  raw_response?: string;
}

export interface DialReaderEnv extends AiRunnerEnv {}

// Strict parse: exactly 1-2 digits, no leading +/-, no decimals.
// Anchored so we don't accept "42 seconds" or "about 42".
const SECONDS_ONLY = /^\d{1,2}$/;

const PROMPT_BASE = `You are reading a mechanical watch dial shown in a photo.

The reference clock reads HH_ANCHOR right now. The watch is approximately
synchronised with this reference. Your task is only to read the WATCH's
second hand — the thinnest, usually centrally-mounted hand that sweeps
once per minute.

Report only the position of the second hand as a single integer 0-59.

Do not explain. Do not guess if you cannot see the second hand clearly.

If you cannot read the second hand clearly, reply with exactly:
UNREADABLE

If the image is not a watch, reply with exactly:
NO_DIAL

Examples of valid replies: "0", "15", "42", "UNREADABLE", "NO_DIAL"`;

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

  if (!SECONDS_ONLY.test(raw)) {
    return { error: "unparseable", raw_response: raw };
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 59) {
    // e.g. "99" — two digits, passes the regex, but out of range.
    return { error: "implausible", raw_response: raw };
  }

  return { seconds, raw_response: raw };
}
