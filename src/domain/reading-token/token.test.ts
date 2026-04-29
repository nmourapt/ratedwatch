// Unit tests for the reading-token module — slice #6 of PRD #99
// (issue #105).
//
// Exercises the security-relevant edges:
//   * round-trip: sign → verify returns the same payload
//   * tamper detection: flip any byte in payload or signature → null
//   * expiry: past `expires_at_unix` → null
//   * malformed envelope: missing dot, empty halves → null
//   * type/shape validation: payloads with missing or wrong-typed
//     fields → null
//
// User_id / watch_id mismatch is *not* checked here — the verify
// function returns the payload as-is, and the route handler does
// the cross-check (different concern, separate test).

import { describe, expect, it } from "vitest";
import {
  READING_TOKEN_TTL_SECONDS,
  signReadingToken,
  verifyReadingToken,
  type ReadingTokenPayload,
} from "./token";

const SECRET = "test-reading-token-secret-32-bytes-of-entropy-yep";

function makePayload(overrides: Partial<ReadingTokenPayload> = {}): ReadingTokenPayload {
  return {
    photo_r2_key: "drafts/user-123/abcd-1234.jpg",
    anchor_hms: "10:19:34",
    predicted_mm_ss: { m: 19, s: 34 },
    user_id: "user-123",
    watch_id: "watch-456",
    expires_at_unix: Math.floor(Date.now() / 1000) + READING_TOKEN_TTL_SECONDS,
    vlm_model: "openai/gpt-5.2",
    ...overrides,
  };
}

describe("readingToken round-trip", () => {
  it("verifies a freshly signed token", async () => {
    const payload = makePayload();
    const token = await signReadingToken(payload, SECRET);
    expect(token).toContain(".");
    const decoded = await verifyReadingToken(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(payload);
  });

  it("preserves all payload fields exactly", async () => {
    // Canary against a future field-stripping bug in the encoder.
    const payload = makePayload({
      predicted_mm_ss: { m: 0, s: 59 },
      anchor_hms: "23:00:01",
    });
    const decoded = await verifyReadingToken(
      await signReadingToken(payload, SECRET),
      SECRET,
    );
    expect(decoded).toEqual(payload);
  });
});

describe("readingToken tamper detection", () => {
  it("rejects a flipped signature byte", async () => {
    const token = await signReadingToken(makePayload(), SECRET);
    const dot = token.indexOf(".");
    expect(dot).toBeGreaterThan(0);
    const sig = token.slice(dot + 1);
    // Flip one character in the signature half. We pick the first
    // char and shift to a different alphabet member; if the char
    // was already 'B' (unlikely) we'd need to pick a different
    // target — assert that the swap actually changed something.
    const swapped = sig[0] === "A" ? "B" + sig.slice(1) : "A" + sig.slice(1);
    expect(swapped).not.toBe(sig);
    const tampered = `${token.slice(0, dot)}.${swapped}`;
    const result = await verifyReadingToken(tampered, SECRET);
    expect(result).toBeNull();
  });

  it("rejects a flipped payload byte", async () => {
    const token = await signReadingToken(makePayload(), SECRET);
    const dot = token.indexOf(".");
    const payload = token.slice(0, dot);
    const swapped = payload[0] === "A" ? "B" + payload.slice(1) : "A" + payload.slice(1);
    const tampered = `${swapped}.${token.slice(dot + 1)}`;
    expect(await verifyReadingToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a wrong secret", async () => {
    const token = await signReadingToken(makePayload(), SECRET);
    expect(await verifyReadingToken(token, "different-secret")).toBeNull();
  });
});

describe("readingToken expiry", () => {
  it("rejects an already-expired token", async () => {
    const expired = makePayload({
      expires_at_unix: Math.floor(Date.now() / 1000) - 1,
    });
    const token = await signReadingToken(expired, SECRET);
    expect(await verifyReadingToken(token, SECRET)).toBeNull();
  });

  it("rejects a token whose expiry equals nowSeconds (boundary)", async () => {
    // We use a strict `<=` check, so equality is rejected.
    const now = 1_700_000_000;
    const payload = makePayload({ expires_at_unix: now });
    const token = await signReadingToken(payload, SECRET);
    expect(await verifyReadingToken(token, SECRET, now)).toBeNull();
  });

  it("accepts a token whose expiry is one second in the future", async () => {
    const now = 1_700_000_000;
    const payload = makePayload({ expires_at_unix: now + 1 });
    const token = await signReadingToken(payload, SECRET);
    const decoded = await verifyReadingToken(token, SECRET, now);
    expect(decoded).not.toBeNull();
  });
});

describe("readingToken malformed input", () => {
  it("returns null for an empty string", async () => {
    expect(await verifyReadingToken("", SECRET)).toBeNull();
  });

  it("returns null when the dot separator is missing", async () => {
    expect(await verifyReadingToken("just-some-string", SECRET)).toBeNull();
  });

  it("returns null when only the payload half is present", async () => {
    expect(await verifyReadingToken("abc.", SECRET)).toBeNull();
  });

  it("returns null when only the signature half is present", async () => {
    expect(await verifyReadingToken(".sig", SECRET)).toBeNull();
  });

  it("returns null when the signature is not valid base64url", async () => {
    const valid = await signReadingToken(makePayload(), SECRET);
    const dot = valid.indexOf(".");
    // Inject characters that are illegal in base64 (atob will throw).
    const broken = `${valid.slice(0, dot)}.@@@invalid@@@`;
    expect(await verifyReadingToken(broken, SECRET)).toBeNull();
  });

  it("returns null when the payload is not valid JSON", async () => {
    // Sign a non-JSON payload manually. We can't use signReadingToken
    // because it stringifies first; build the envelope by hand.
    const payloadB64 = btoa("not json");
    // Mimic base64url
    const b64url = payloadB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    // Build a matching signature so the HMAC check passes — we
    // need to compute it the same way the verifier will.
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, enc.encode(b64url)),
    );
    const sigB64 = btoa(String.fromCharCode(...sigBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const token = `${b64url}.${sigB64}`;
    expect(await verifyReadingToken(token, SECRET)).toBeNull();
  });
});

describe("readingToken shape validation", () => {
  it("rejects a payload missing predicted_mm_ss", async () => {
    // Manually construct a token whose payload omits a required field.
    // We craft this so the signature is correct (otherwise we'd be
    // testing tamper detection, not shape validation).
    const enc = new TextEncoder();
    const bad = JSON.stringify({
      photo_r2_key: "x",
      anchor_hms: "10:00:00",
      // predicted_mm_ss missing
      user_id: "u",
      watch_id: "w",
      expires_at_unix: Math.floor(Date.now() / 1000) + 60,
      vlm_model: "openai/gpt-5.2",
    });
    const payloadB64 = btoa(bad)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)),
    );
    const sigB64 = btoa(String.fromCharCode(...sigBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyReadingToken(`${payloadB64}.${sigB64}`, SECRET)).toBeNull();
  });
});
