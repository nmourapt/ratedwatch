// Unit tests for the corpus.maybeIngest gate logic. These tests
// drive the consent + confidence + rejection branches against a
// hand-rolled R2Bucket fake so they don't need a miniflare runtime
// — the integration tier (tests/integration/corpus.ingest.test.ts)
// validates the same behaviour against the real binding.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { maybeIngest } from "./maybeIngest";

interface PutCall {
  key: string;
  body: Uint8Array | string;
  contentType?: string;
}

class FakeR2 {
  public puts: PutCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async put(key: string, body: any, opts?: { httpMetadata?: { contentType?: string } }) {
    let captured: Uint8Array | string;
    if (typeof body === "string") {
      captured = body;
    } else if (body instanceof ArrayBuffer) {
      captured = new Uint8Array(body);
    } else if (body instanceof Uint8Array) {
      captured = body.slice();
    } else {
      captured = String(body);
    }
    this.puts.push({
      key,
      body: captured,
      contentType: opts?.httpMetadata?.contentType,
    });
  }
}

const fixedNow = Date.UTC(2026, 4, 1, 12, 34, 56); // 2026-05-01

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
});

function envWithBucket() {
  const bucket = new FakeR2();
  return {
    bucket,
    env: { R2_CORPUS: bucket as unknown as R2Bucket },
  };
}

describe("corpus.maybeIngest — consent gate", () => {
  it("does nothing when consent_corpus is false (rejected reading)", async () => {
    const { bucket, env } = envWithBucket();
    await maybeIngest({
      readingId: "r1",
      photoBytes: new Uint8Array([1, 2, 3]),
      imageContentType: "image/jpeg",
      consentCorpus: false,
      verified: false,
      confidence: null,
      rejectionReason: "no_dial_found",
      dialReaderVersion: "v0.1.0-test",
      env,
    });
    expect(bucket.puts).toHaveLength(0);
  });

  it("does nothing when consent_corpus is false (low-confidence success)", async () => {
    const { bucket, env } = envWithBucket();
    await maybeIngest({
      readingId: "r2",
      photoBytes: new Uint8Array([1, 2, 3]),
      imageContentType: "image/jpeg",
      consentCorpus: false,
      verified: true,
      confidence: 0.72,
      rejectionReason: null,
      dialReaderVersion: "v0.1.0-test",
      env,
    });
    expect(bucket.puts).toHaveLength(0);
  });
});

describe("corpus.maybeIngest — confidence gate", () => {
  it("does nothing when verified=true and confidence >= 0.85", async () => {
    const { bucket, env } = envWithBucket();
    await maybeIngest({
      readingId: "r3",
      photoBytes: new Uint8Array([1, 2, 3]),
      imageContentType: "image/jpeg",
      consentCorpus: true,
      verified: true,
      confidence: 0.92,
      rejectionReason: null,
      dialReaderVersion: "v0.1.0-test",
      env,
    });
    expect(bucket.puts).toHaveLength(0);
  });

  it("does nothing at the exact threshold (confidence == 0.85, verified=true)", async () => {
    // Boundary case: 0.85 is "high enough" — corpus excludes it.
    const { bucket, env } = envWithBucket();
    await maybeIngest({
      readingId: "r3b",
      photoBytes: new Uint8Array([1, 2, 3]),
      imageContentType: "image/jpeg",
      consentCorpus: true,
      verified: true,
      confidence: 0.85,
      rejectionReason: null,
      dialReaderVersion: "v0.1.0-test",
      env,
    });
    expect(bucket.puts).toHaveLength(0);
  });

  it("ingests when verified=true and confidence < 0.85", async () => {
    const { bucket, env } = envWithBucket();
    await maybeIngest({
      readingId: "r4",
      photoBytes: new Uint8Array([1, 2, 3]),
      imageContentType: "image/heic",
      consentCorpus: true,
      verified: true,
      confidence: 0.72,
      rejectionReason: null,
      dialReaderVersion: "v0.1.0-test",
      env,
    });
    expect(bucket.puts).toHaveLength(2);
    const photo = bucket.puts.find((p) => p.key.endsWith("/photo.heic"));
    const sidecar = bucket.puts.find((p) => p.key.endsWith("/sidecar.json"));
    expect(photo).toBeDefined();
    expect(sidecar).toBeDefined();
    expect(photo!.key).toBe("corpus/2026-05-01/r4/photo.heic");
    expect(sidecar!.key).toBe("corpus/2026-05-01/r4/sidecar.json");
  });
});

describe("corpus.maybeIngest — rejection branch", () => {
  it("ingests when reading was rejected (verified=false, rejection_reason set)", async () => {
    const { bucket, env } = envWithBucket();
    await maybeIngest({
      readingId: "r5",
      photoBytes: new Uint8Array([10, 20, 30]),
      imageContentType: "image/jpeg",
      consentCorpus: true,
      verified: false,
      confidence: null,
      rejectionReason: "no_dial_found",
      dialReaderVersion: "v0.1.0-test",
      env,
    });
    expect(bucket.puts).toHaveLength(2);
    const photo = bucket.puts.find((p) => p.key.endsWith("/photo.jpg"));
    expect(photo).toBeDefined();
    expect(photo!.key).toBe("corpus/2026-05-01/r5/photo.jpg");
    expect(photo!.contentType).toBe("image/jpeg");
  });
});

describe("corpus.maybeIngest — sidecar shape", () => {
  it("emits anonymized sidecar with no user/watch fields", async () => {
    const { bucket, env } = envWithBucket();
    const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await maybeIngest({
      readingId: "r6",
      photoBytes,
      imageContentType: "image/heic",
      consentCorpus: true,
      verified: false,
      confidence: 0.6,
      rejectionReason: "low_confidence",
      dialReaderVersion: "v0.2.3",
      env,
    });
    const sidecarCall = bucket.puts.find((p) => p.key.endsWith("/sidecar.json"));
    expect(sidecarCall).toBeDefined();
    const sidecar = JSON.parse(sidecarCall!.body as string) as Record<string, unknown>;
    expect(sidecar.reading_id).toBe("r6");
    expect(sidecar.dial_reader_version).toBe("v0.2.3");
    expect(sidecar.confidence).toBe(0.6);
    expect(sidecar.verified).toBe(false);
    expect(sidecar.rejection_reason).toBe("low_confidence");
    expect(sidecar.image_format).toBe("image/heic");
    expect(sidecar.image_bytes).toBe(photoBytes.length);
    expect(typeof sidecar.created_at).toBe("string");
    // ISO-8601 sanity check.
    expect(() => new Date(sidecar.created_at as string)).not.toThrow();
    // CRITICAL: no PII fields. Anonymization is enforced by the
    // function signature (it does not accept user/watch IDs), but
    // we double-check the emitted JSON to catch a future regression
    // that adds a leak.
    const banned = ["user_id", "userId", "watch_id", "watchId", "email", "username"];
    for (const k of banned) {
      expect(sidecar[k]).toBeUndefined();
    }
  });
});

describe("corpus.maybeIngest — extension mapping", () => {
  it.each([
    ["image/jpeg", "jpg"],
    ["image/jpg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/heic", "heic"],
    ["image/heif", "heif"],
    ["application/octet-stream", "bin"],
  ])("maps %s to .%s", async (contentType, ext) => {
    const { bucket, env } = envWithBucket();
    await maybeIngest({
      readingId: `r-${ext}`,
      photoBytes: new Uint8Array([1]),
      imageContentType: contentType,
      consentCorpus: true,
      verified: false,
      confidence: null,
      rejectionReason: "no_dial_found",
      dialReaderVersion: "v0.1.0-test",
      env,
    });
    const photo = bucket.puts.find((p) => p.key.includes("/photo."));
    expect(photo).toBeDefined();
    expect(photo!.key.endsWith(`/photo.${ext}`)).toBe(true);
  });
});

describe("corpus.maybeIngest — failure tolerance", () => {
  it("swallows R2 errors so the caller's response path is never affected", async () => {
    const broken: R2Bucket = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      put: async () => {
        throw new Error("R2 went away");
      },
    } as unknown as R2Bucket;
    await expect(
      maybeIngest({
        readingId: "r7",
        photoBytes: new Uint8Array([1, 2, 3]),
        imageContentType: "image/jpeg",
        consentCorpus: true,
        verified: false,
        confidence: null,
        rejectionReason: "no_dial_found",
        dialReaderVersion: "v0.1.0-test",
        env: { R2_CORPUS: broken },
      }),
    ).resolves.toBeUndefined();
  });
});
