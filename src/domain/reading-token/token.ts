// Reading-token module — slice #6 of PRD #99 (issue #105).
//
// The verified-reading flow is split into two HTTP endpoints:
//
//   1. `POST /readings/verified/draft`   — runs the VLM pipeline,
//      returns a signed `reading_token` + the predicted MM:SS.
//   2. `POST /readings/verified/confirm` — accepts the token and a
//      possibly-adjusted MM:SS, validates the token, and persists.
//
// The token is the only state that survives between the two calls.
// We sign it with HMAC-SHA256 so a malicious client can't forge a
// confirmation against a photo it never uploaded.
//
// Format
// ------
//
//   `<base64url(JSON.stringify(payload))>.<base64url(HMAC-SHA256(payload, secret))>`
//
// — chosen over JWT because:
//   * one less dependency and ~40 lines of code,
//   * the payload is application-specific, not a standardized
//     claims set,
//   * verification is HMAC-only (no JWKS, no algorithm negotiation),
//     so the attack surface is narrower than a JWT lib's.
//
// Trust contract
// --------------
//
// * The `signReadingToken` caller MUST set `expires_at_unix` to a
//   sensible future time (5 minutes from now is the route-handler
//   convention; see `READING_TOKEN_TTL_SECONDS`).
// * `verifyReadingToken` only validates signature + expiry. The
//   route handler is responsible for cross-checking that the
//   payload's `user_id`/`watch_id` match the request's session and
//   URL — see the `/confirm` handler.
// * The secret MUST be at least 32 bytes of entropy. Operator
//   provisioning instructions live in `AGENTS.md` and on the slice
//   #6 PR body.
//
// Failure mode: every `verifyReadingToken` failure (malformed
// envelope, bad signature, expired payload, JSON parse error) ends
// up as `null`. This collapses the security-relevant branches into
// a single rejection so the route handler always emits one shape
// of 401.

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * 5 minutes — long enough for a slow user to review the photo +
 * adjust ±30s in the slice-#7 confirmation UI; short enough that
 * abandoned drafts don't pile up. Bake-off-validated value.
 */
export const READING_TOKEN_TTL_SECONDS = 5 * 60;

/**
 * Payload baked into the signed envelope. Keep this lean — it
 * shows up on every verified-reading round-trip.
 *
 *   * `photo_r2_key`  the R2 key under `drafts/` where the photo
 *                     lives until confirm. Move target on confirm.
 *   * `anchor_hms`    the reference timestamp encoded as
 *                     `HH:MM:SS` (UTC, 24h). Confirmation uses this
 *                     as the canonical reference for the deviation
 *                     calc — frees the verifier from re-resolving
 *                     EXIF on confirm.
 *   * `predicted_mm_ss` — the VLM's reading. Confirm validates
 *                     the user's `final_mm_ss` against this within
 *                     ±30s (the per-click adjustment limit).
 *   * `user_id`       the session-bound owner. Cross-checked at
 *                     confirm to catch a token replay across
 *                     sessions.
 *   * `watch_id`      the watch the draft targets. Cross-checked at
 *                     confirm.
 *   * `expires_at_unix` — UNIX seconds. Reject after this.
 *   * `vlm_model`     stamped onto the resulting reading row at
 *                     confirm — written into the `vlm_model` D1
 *                     column.
 */
export interface ReadingTokenPayload {
  photo_r2_key: string;
  /**
   * The server's reference clock at moment of capture, formatted as
   * `HH:MM:SS` (UTC, 24-hour) for human-debug log lines. NOT used in
   * deviation math — the canonical reference is `reference_ms` below.
   */
  anchor_hms: string;
  /**
   * The reference timestamp the deviation is computed against, as
   * unix milliseconds. Source is either EXIF DateTimeOriginal (the
   * camera's local clock encoded UTC-naively) or server arrival
   * (`Date.now()` UTC). Stored at draft time so /confirm computes
   * the same deviation no matter when the user taps Confirm within
   * the token's 5-min TTL. Added in PR #122 alongside the move from
   * MM:SS-only to full-HMS deviation.
   */
  reference_ms: number;
  /**
   * The VLM's predicted reading on a 12-hour analog clock (h ∈
   * [1, 12], m/s ∈ [0, 59]). Hour comes from the server reference
   * (the VLM doesn't determine hour — it disambiguates the
   * rollover-side using the prompt's anchor). Replaces the old
   * `predicted_mm_ss` field added in slice #6 of PRD #99 because
   * PR #122 lets the user adjust HH/MM/SS independently and the
   * SPA needs the predicted hour as the initial value.
   */
  predicted_hms: { h: number; m: number; s: number };
  user_id: string;
  watch_id: string;
  expires_at_unix: number;
  vlm_model: string;
  /**
   * Optional client TZ offset in minutes east of UTC (e.g. Lisbon
   * WEST = +60, Berlin CEST = +120, New York EDT = −240). Captured
   * by the SPA via `-new Date(captureMs).getTimezoneOffset()` so it's
   * DST-aware for the moment of capture.
   *
   * When present, the route layer shifts `reference_ms` by this
   * offset before extracting H/M/S components (both at /draft for
   * `predicted_hms.h` and at /confirm for the deviation calc), so a
   * watch displaying local time produces a clean small deviation
   * rather than a 3600 s TZ-bias-as-deviation. PR #126 fix for the
   * "I saved the correct time, but it still showed a 1h deviation"
   * report against PR #124's behaviour.
   *
   * Optional for backward compat — clients on the pre-#126 SPA omit
   * it and the server falls back to UTC components (the old wrong-
   * for-non-UTC-watches behaviour). Bounds on input: ±840 minutes
   * (covers all real TZs incl. UTC+14 and UTC−12, with DST
   * variants).
   */
  client_tz_offset_minutes?: number;
}

/**
 * Sign a reading-token payload with HMAC-SHA256 against the given
 * secret. Returns the compact `<payload>.<signature>` envelope.
 */
export async function signReadingToken(
  payload: ReadingTokenPayload,
  secret: string,
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(TEXT_ENCODER.encode(payloadJson));
  const sig = await hmacSha256(secret, payloadB64);
  return `${payloadB64}.${base64UrlEncode(sig)}`;
}

/**
 * Verify a reading token. Returns the payload on success, `null`
 * on any failure (malformed envelope, bad signature, expired,
 * un-parseable JSON, missing fields, type mismatch).
 *
 * `nowSeconds` defaults to `Math.floor(Date.now() / 1000)` so the
 * caller can override for tests without `vi.setSystemTime`.
 */
export async function verifyReadingToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ReadingTokenPayload | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot === -1 || dot === 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  // Recompute the expected signature and compare it constant-time.
  let expected: Uint8Array;
  try {
    expected = await hmacSha256(secret, payloadB64);
  } catch {
    return null;
  }
  let received: Uint8Array;
  try {
    received = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  if (!constantTimeEqual(expected, received)) return null;

  // Decode + parse payload.
  let payloadJson: string;
  try {
    payloadJson = TEXT_DECODER.decode(base64UrlDecode(payloadB64));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }

  if (!isReadingTokenPayload(parsed)) return null;
  if (parsed.expires_at_unix <= nowSeconds) return null;
  return parsed;
}

// ---- HMAC-SHA256 helpers -------------------------------------------

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(message));
  return new Uint8Array(sig);
}

/** Constant-time compare of two byte arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) {
    acc |= a[i]! ^ b[i]!;
  }
  return acc === 0;
}

// ---- base64url -----------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  // Workers' `btoa` operates on Latin-1 strings; chunk for safety on
  // large payloads (token payloads are tiny, but keep parity with
  // the dial-reader image encoder).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  const b64 = btoa(binary);
  // base64url: + → -, / → _, strip trailing =
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  if (typeof s !== "string") {
    throw new TypeError("base64url input must be a string");
  }
  // Restore standard base64 padding before atob.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const b64 = padded + "=".repeat(padding);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---- runtime validation --------------------------------------------

function isReadingTokenPayload(value: unknown): value is ReadingTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.photo_r2_key !== "string") return false;
  if (typeof v.anchor_hms !== "string") return false;
  if (typeof v.reference_ms !== "number" || !Number.isFinite(v.reference_ms)) {
    return false;
  }
  if (typeof v.user_id !== "string") return false;
  if (typeof v.watch_id !== "string") return false;
  if (typeof v.vlm_model !== "string") return false;
  if (typeof v.expires_at_unix !== "number" || !Number.isFinite(v.expires_at_unix)) {
    return false;
  }
  // PR #122: predicted_hms = { h: 1..12, m: 0..59, s: 0..59 }. Old
  // tokens carrying `predicted_mm_ss` are rejected here — they
  // expire within 5 minutes of the deploy anyway.
  const hms = v.predicted_hms;
  if (typeof hms !== "object" || hms === null) return false;
  const h = (hms as { h?: unknown }).h;
  const m = (hms as { m?: unknown }).m;
  const s = (hms as { s?: unknown }).s;
  if (typeof h !== "number" || !Number.isFinite(h) || h < 1 || h > 12) return false;
  if (typeof m !== "number" || !Number.isFinite(m) || m < 0 || m > 59) return false;
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 59) return false;
  return true;
}
