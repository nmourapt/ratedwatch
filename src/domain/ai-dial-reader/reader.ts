// AI dial reader. Takes a JPEG of a watch face and asks a vision
// model what time is displayed. Returns a structured `DialReading`
// (HH:MM:SS) or a structured error.
//
// This module is deliberately small and side-effect-free apart from
// the single AI call: the verified-reading pipeline (reading-verifier)
// composes on top of it, so any future swap of the underlying model
// just means dropping in a different `resolveAiRunner` — the rest of
// the verifier doesn't change.
//
// Trust contract (AGENTS.md): we never, ever tell the model "just
// return the hint time". The archived watchdrift prototype did that
// and produced a cheating system. The hint is only used as an AM/PM
// disambiguator — the model's own visual read is what lands in the
// reading.

import { resolveAiRunner, type AiRunnerEnv, type AiRunResponse } from "./runner";

/**
 * A successful dial read. Seconds may legitimately be 0 when the
 * watch doesn't have a second hand — the caller shouldn't treat a
 * zero-second read as a failure.
 */
export interface DialReading {
  hours: number; // 0-23
  minutes: number; // 0-59
  seconds: number; // 0-59
  raw_response: string;
}

export type DialReaderErrorCode = "refused" | "unparseable" | "implausible";

export interface DialReaderError {
  error: DialReaderErrorCode;
  raw_response?: string;
}

export interface DialReaderEnv extends AiRunnerEnv {}

// Strict parse: exactly HH:MM:SS, zero-padded, nothing else. Anchored
// so we don't accept "14:32:07 is the time".
const HHMMSS = /^([0-1][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/;

const PROMPT_BASE =
  "Look at the watch dial in this image and report the time shown as exactly HH:MM:SS in 24-hour format. " +
  "If the image does not show a clock face, reply with exactly: NO_DIAL. " +
  "If you cannot read the time clearly, reply with exactly: UNREADABLE. " +
  "Do not add any other text.";

/**
 * Build the prompt. Embeds a reference-time hint when provided, but
 * phrased as a disambiguation aid — the model is told to *use* the
 * hint to pick AM vs PM if it's unsure, NOT to copy the hint into
 * the response. See the AGENTS.md warning about the archived
 * prototype doing exactly that.
 */
export function buildPrompt(hintTime?: Date): string {
  if (!hintTime) return PROMPT_BASE;
  const hh = String(hintTime.getUTCHours()).padStart(2, "0");
  const mm = String(hintTime.getUTCMinutes()).padStart(2, "0");
  return (
    `The approximate time is ${hh}:${mm}; use this only to disambiguate AM/PM if the hour hand is ambiguous. ` +
    `Do not copy this value — report what the watch dial actually shows. ` +
    PROMPT_BASE
  );
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
      image: Array.from(image),
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

  const m = HHMMSS.exec(raw);
  if (!m) {
    return { error: "unparseable", raw_response: raw };
  }

  // The regex already restricts each field to its valid range, so a
  // successful match implies hours ∈ [0,23], minutes/seconds ∈ [0,59].
  // We still run the explicit plausibility check for defence in
  // depth in case the regex ever loosens.
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return { error: "implausible", raw_response: raw };
  }

  return { hours, minutes, seconds, raw_response: raw };
}
