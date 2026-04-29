// Chain-of-thought prompt for the VLM dial reader.
//
// Lifted verbatim from
// `scripts/vlm-bakeoff/bakeoff.py::NO_ANCHOR_PROMPT_BASE` and
// `_build_prompt`. The bake-off accuracy numbers
// (MM:SS error ≤ 5s on 18/18 production-realistic runs against
// GPT-5.2 with the cropped 768×768 dial) are conditional on this
// exact text, so any edit must be reconciled against the harness.
//
// The prompt:
//   1. Tells the model what it's looking at.
//   2. Provides the EXIF anchor as a sanity-check.
//   3. Walks it through hand identification (longest/thinnest =
//      second; shortest = hour; minute hand is the priority).
//   4. Tells it explicitly NOT to echo the anchor.
//   5. Constrains the output to a single HH:MM:SS line.

import type { ExifAnchor } from "./types";

/**
 * Compose the full prompt string, including the EXIF anchor block.
 *
 * Pure function. Whitespace and casing matter — the bake-off
 * numbers are tied to this exact string. Snapshot tests guard
 * against accidental drift.
 */
export function buildPrompt(anchor: ExifAnchor): string {
  const anchorHms = formatHms(anchor);
  const anchorBlock =
    `EXIF ANCHOR: this photograph's EXIF DateTimeOriginal is ` +
    `${anchorHms}. The user's phone captured this timestamp at the ` +
    `moment of the photo. The watch should read CLOSE to this time ` +
    `but may be drifting by seconds. Treat the anchor as a ` +
    `sanity-check, NOT as your answer.\n\n`;
  return PROMPT_BASE.replace("{anchor_block}", anchorBlock);
}

/** Two-digit-padded HH:MM:SS — used in the anchor block only. */
function formatHms(anchor: ExifAnchor): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(anchor.h)}:${pad(anchor.m)}:${pad(anchor.s)}`;
}

/**
 * The chain-of-thought prompt template. The `{anchor_block}` token
 * is replaced by either the EXIF anchor block or a no-anchor
 * sentinel — currently this slice always sends an anchor (the
 * verifier requires one).
 */
const PROMPT_BASE =
  "This is a photograph of an analog wristwatch. Read the EXACT time " +
  "shown on the dial as precisely as possible.\n\n" +
  "{anchor_block}" +
  "REQUIRED PROCESS — work through these steps before answering:\n\n" +
  "1. IDENTIFY THE THREE HANDS. The watch has three centre-mounted hands. " +
  "For each visible hand, observe:\n" +
  "   - LENGTH (how far the hand reaches toward the dial edge)\n" +
  "   - THICKNESS (thin needle vs. broad)\n" +
  "   - COLOR / contrast against the dial\n\n" +
  "2. CLASSIFY each hand:\n" +
  "   - SECOND HAND: thinnest needle. Often the longest. Often a different " +
  "colour from the others (red, orange, blue, lume). Reads the seconds " +
  "scale (the outer ring of 60 tick marks).\n" +
  "   - MINUTE HAND: medium length, thicker than the second hand, similar " +
  "in length to (or slightly shorter than) the second hand. Reads the " +
  "minutes on the same outer 60-tick ring. THIS IS THE MOST IMPORTANT " +
  "HAND FOR YOUR ANSWER.\n" +
  "   - HOUR HAND: SHORTEST. Reaches only about half-way to the dial edge. " +
  "Often thicker than the minute hand. Less critical for precision.\n\n" +
  "3. READ EACH HAND'S POSITION:\n" +
  "   - Second hand → reads 0-59 directly off the outer minute scale.\n" +
  "   - Minute hand → reads 0-59 directly off the same scale.\n" +
  "   - Hour hand → falls between two hour numerals (e.g. between 10 and " +
  "11 means the hour is 10).\n\n" +
  "4. SANITY-CHECK against the anchor (if provided):\n" +
  "   - The anchor is the camera's EXIF capture time. The watch may be " +
  "off by seconds or even minutes due to drift, but it should NOT be off " +
  "by hours.\n" +
  "   - If your minute reading differs from the anchor's minute by more " +
  "than ~10 minutes, you've probably misclassified the hands. Look again: " +
  "did you confuse the minute and second hand? Are you reading the wrong " +
  "end of a hand (the tail vs the tip)?\n" +
  "   - DO NOT just echo the anchor. Read the actual pixels.\n\n" +
  "5. ROLLOVER AMBIGUITY: when the minute hand is near :00 (between :58 " +
  "and :02), the hour hand visually points right at a numeral and could " +
  "be the previous or next hour. Use the anchor's hour to disambiguate.\n\n" +
  "OUTPUT — respond with ONLY a single line in the EXACT format HH:MM:SS " +
  "using a 12-hour clock (no AM/PM, no extra text, no explanation, no " +
  "Markdown). Two digits for each component. Example output: 04:37:21";
