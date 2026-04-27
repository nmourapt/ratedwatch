import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setTestDialReader,
  readDial,
  type DialReadResult,
  type DialReadSuccessBody,
  type DialReaderEnv,
} from "./adapter";

// Local fake AnalyticsEngine binding used by the slice-83 event tests.
// Captures every writeDataPoint call so we can assert which events
// the adapter emitted and with what payload.
function makeFakeAnalytics() {
  const calls: Array<{ blobs?: unknown[]; indexes?: unknown[]; doubles?: number[] }> = [];
  return {
    calls,
    binding: {
      writeDataPoint(dp?: {
        blobs?: unknown[];
        indexes?: unknown[];
        doubles?: number[];
      }) {
        calls.push({ blobs: dp?.blobs, indexes: dp?.indexes, doubles: dp?.doubles });
      },
    } as unknown as AnalyticsEngineDataset,
  };
}

function eventsOfKind(
  calls: Array<{ blobs?: unknown[]; indexes?: unknown[] }>,
  kind: string,
): Array<{ payload: Record<string, unknown> }> {
  return calls
    .filter((c) => Array.isArray(c.indexes) && c.indexes[0] === kind)
    .map((c) => ({
      payload: JSON.parse((c.blobs as unknown[])[1] as string) as Record<string, unknown>,
    }));
}

const READING_ID = "rdg-abc-123";

// The dial-reader adapter is the typed bridge between the Worker
// and the Cloudflare Container that runs OpenCV / image decoding /
// hand-angle parsing. Scaffolded in slice #74, wired through the
// verifier in slice #75, and made the sole verified-reading
// backend by slice #11 (cutover) of PRD #73.
//
// `__setTestDialReader` is a module-level fake that lets
// integration tests drive the verifier without spinning up a real
// container, which is impossible inside vitest-pool-workers anyway
// (Container DOs always resolve remotely in production).

afterEach(() => {
  __setTestDialReader(null);
});

// Minimal shape that mimics the production binding: a DurableObject
// namespace whose stub exposes a `fetch(req)` that returns the
// container's HTTP response. Slice #75 will replace this fake with
// the verifier-side wiring; this file only validates the adapter
// itself.
function makeFakeContainerEnv(fetchImpl: (req: Request) => Promise<Response>): {
  env: DialReaderEnv;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  const fetchSpy = vi.fn(fetchImpl);
  // The real `getContainer` returns a DurableObjectStub whose only
  // surface we use here is `.fetch(request)`. We don't need to
  // re-implement the namespace lookup in tests because the
  // production path goes through `__setTestDialReader` when a fake
  // is installed; this fake is only exercised when the runtime
  // path reaches into env.DIAL_READER.
  const stub = { fetch: fetchSpy } as unknown as DurableObjectStub;
  const env: DialReaderEnv = {
    DIAL_READER: {
      get: () => stub,
      idFromName: (name: string) =>
        ({ toString: () => name, name }) as unknown as DurableObjectId,
      idFromString: (s: string) =>
        ({ toString: () => s, name: s }) as unknown as DurableObjectId,
      newUniqueId: () => ({ toString: () => "unique" }) as unknown as DurableObjectId,
    } as unknown as DialReaderEnv["DIAL_READER"],
  };
  return { env, fetchSpy };
}

const HARDCODED_RESPONSE: DialReadSuccessBody = {
  version: "v0.0.1-scaffolding",
  ok: true,
  result: {
    displayed_time: { h: 12, m: 0, s: 0 },
    confidence: 0.0,
    dial_detection: { center_xy: [0, 0], radius_px: 0 },
    hand_angles_deg: { hour: 0, minute: 0, second: 0 },
    processing_ms: 0,
  },
};

describe("readDial — test override path", () => {
  it("unwraps a canned success response into a typed DialReadResult", async () => {
    __setTestDialReader(async () => ({ kind: "success", body: HARDCODED_RESPONSE }));
    const { env } = makeFakeContainerEnv(async () => new Response("not used"));
    const result = await readDial(new Uint8Array([0xff, 0xd8]), env);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.body.version).toBe("v0.0.1-scaffolding");
      expect(result.body.result.confidence).toBe(0.0);
    }
  });

  it("propagates a canned rejection as a typed error", async () => {
    __setTestDialReader(async () => ({
      kind: "rejection",
      reason: "no_dial_detected",
    }));
    const { env } = makeFakeContainerEnv(async () => new Response("not used"));
    const result = await readDial(new Uint8Array([0xff]), env);

    expect(result).toEqual<DialReadResult>({
      kind: "rejection",
      reason: "no_dial_detected",
    });
  });

  it("propagates a canned transport error as a typed error", async () => {
    __setTestDialReader(async () => ({
      kind: "transport_error",
      message: "boom",
    }));
    const { env } = makeFakeContainerEnv(async () => new Response("not used"));
    const result = await readDial(new Uint8Array([0xff]), env);

    expect(result).toEqual<DialReadResult>({
      kind: "transport_error",
      message: "boom",
    });
  });
});

describe("readDial — production (binding) path", () => {
  it("calls the DIAL_READER container with POST /v1/read-dial when no test override is installed", async () => {
    const { env, fetchSpy } = makeFakeContainerEnv(
      async () =>
        new Response(JSON.stringify(HARDCODED_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const result = await readDial(image, env);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sentReq = fetchSpy.mock.calls[0]![0] as Request;
    expect(sentReq.method).toBe("POST");
    expect(new URL(sentReq.url).pathname).toBe("/v1/read-dial");
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.body).toEqual(HARDCODED_RESPONSE);
    }
  });

  it("forwards the JPEG bytes verbatim as the request body", async () => {
    let capturedBody: ArrayBuffer | null = null;
    const { env } = makeFakeContainerEnv(async (req) => {
      capturedBody = await req.arrayBuffer();
      return new Response(JSON.stringify(HARDCODED_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34]);
    await readDial(image, env);
    expect(capturedBody).not.toBeNull();
    expect(new Uint8Array(capturedBody!)).toEqual(image);
  });

  it("classifies a non-2xx container response as a transport error", async () => {
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response("internal server error", {
          status: 500,
        }),
    );
    const result = await readDial(new Uint8Array([0xff]), env);

    expect(result.kind).toBe("transport_error");
    if (result.kind === "transport_error") {
      expect(result.message).toMatch(/500/);
    }
  });

  it("classifies a thrown fetch error as a transport error", async () => {
    const { env } = makeFakeContainerEnv(async () => {
      throw new Error("network unreachable");
    });
    const result = await readDial(new Uint8Array([0xff]), env);

    expect(result.kind).toBe("transport_error");
    if (result.kind === "transport_error") {
      expect(result.message).toContain("network unreachable");
    }
  });

  // Slice #76 adds the structured `rejection` block on the
  // success transport (200 + ok:false) and the `malformed_image`
  // 400 path. Both have to round-trip through the adapter as
  // their own DialReadResult kinds.

  it("surfaces an unsupported_format rejection from a 200 response", async () => {
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(
          JSON.stringify({
            version: "v0.1.0-decode",
            ok: false,
            rejection: {
              reason: "unsupported_format",
              details: "GIF is not supported. Use JPEG, PNG, WebP, or HEIC.",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const result = await readDial(new Uint8Array([0x47, 0x49, 0x46, 0x38]), env);

    expect(result.kind).toBe("rejection");
    if (result.kind === "rejection") {
      expect(result.reason).toBe("unsupported_format");
      expect(result.details).toContain("GIF");
    }
  });

  // Slice #77: the dial locator returns `no_dial_found` when no
  // plausible dial circle is detected. The verifier surfaces this
  // as a "we couldn't find a watch dial" UX path with a
  // retake-only button (no manual fallback).
  it("surfaces a no_dial_found rejection from a 200 response", async () => {
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(
          JSON.stringify({
            version: "v0.2.0-dial-locator",
            ok: false,
            rejection: {
              reason: "no_dial_found",
              details: "No watch dial detected. Frame the dial centered and well-lit.",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const result = await readDial(new Uint8Array([0xff, 0xd8, 0xff]), env);

    expect(result.kind).toBe("rejection");
    if (result.kind === "rejection") {
      expect(result.reason).toBe("no_dial_found");
      expect(result.details).toContain("dial");
    }
  });

  it("classifies a 400 malformed_image response as kind: malformed_image", async () => {
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(
          JSON.stringify({
            version: "v0.1.0-decode",
            error: "malformed_image",
            details: "image decoding failed: truncated stream",
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const result = await readDial(new Uint8Array([0xff, 0xd8, 0xff]), env);

    expect(result.kind).toBe("malformed_image");
    if (result.kind === "malformed_image") {
      expect(result.message).toContain("truncated");
    }
  });

  it("falls back to a default malformed_image message when the 400 body is unparsable", async () => {
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response("not json", {
          status: 400,
          headers: { "content-type": "text/plain" },
        }),
    );
    const result = await readDial(new Uint8Array([0xff]), env);

    expect(result.kind).toBe("malformed_image");
    if (result.kind === "malformed_image") {
      expect(result.message).toBeTruthy();
    }
  });

  it("still parses a legacy flat `reason` rejection body", async () => {
    // Defensive: an older container build that never shipped the
    // structured `rejection` block must still surface as a
    // rejection rather than as a parser explosion.
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(JSON.stringify({ ok: false, reason: "legacy_reason" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await readDial(new Uint8Array([0xff]), env);

    expect(result.kind).toBe("rejection");
    if (result.kind === "rejection") {
      expect(result.reason).toBe("legacy_reason");
    }
  });
});

// ---- Slice #83: observability events ------------------------------
//
// `readDial` emits five domain events into Analytics Engine when a
// caller supplies a `ReadDialContext` with `readingId` + an env that
// carries an `ANALYTICS` binding. The legacy two-arg form (no ctx)
// stays silent to keep older tests + any one-off internal callers
// working.
//
// The events let the operator answer (via SQL): how many attempts /
// successes / rejections / transport errors per day, what's the cold
// start rate, and what's the confidence + processing-time
// distribution. See the `EventKind` doc-block in
// src/observability/events.ts.

describe("readDial — observability events (slice #83)", () => {
  it("emits dial_reader_attempt with image_format + image_bytes when context is supplied (success path)", async () => {
    const ana = makeFakeAnalytics();
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(JSON.stringify(HARDCODED_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    // JPEG SOI/EOI bytes — the adapter sniffs format from the magic
    // bytes (Content-Type can lie; the container itself doesn't trust
    // it either, see `image_decoder.py`).
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);

    await readDial(jpeg, { ...env, ANALYTICS: ana.binding }, { readingId: READING_ID });

    const attempts = eventsOfKind(ana.calls, "dial_reader_attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.payload).toMatchObject({
      reading_id: READING_ID,
      image_format: "jpeg",
      image_bytes: jpeg.byteLength,
    });
  });

  it("emits dial_reader_success on a successful container response", async () => {
    const ana = makeFakeAnalytics();
    const successBody: DialReadSuccessBody = {
      version: "v0.7.0",
      ok: true,
      result: {
        displayed_time: { h: 12, m: 32, s: 7 },
        confidence: 0.92,
        dial_detection: { center_xy: [100, 100], radius_px: 80 },
        hand_angles_deg: { hour: 0, minute: 0, second: 0 },
        processing_ms: 412,
      },
    };
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(JSON.stringify(successBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await readDial(
      new Uint8Array([0xff, 0xd8, 0xff]),
      { ...env, ANALYTICS: ana.binding },
      { readingId: READING_ID },
    );

    const successes = eventsOfKind(ana.calls, "dial_reader_success");
    expect(successes).toHaveLength(1);
    expect(successes[0]!.payload).toMatchObject({
      reading_id: READING_ID,
      confidence: 0.92,
      processing_ms: 412,
      dial_reader_version: "v0.7.0",
    });
    // Must NOT have emitted a rejection or error event.
    expect(eventsOfKind(ana.calls, "dial_reader_rejection")).toHaveLength(0);
    expect(eventsOfKind(ana.calls, "dial_reader_error")).toHaveLength(0);
  });

  it("emits dial_reader_rejection when the container returns a structured rejection", async () => {
    const ana = makeFakeAnalytics();
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(
          JSON.stringify({
            version: "v0.7.0",
            ok: false,
            rejection: {
              reason: "low_confidence",
              details: "confidence 0.42 below 0.70 threshold",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await readDial(
      new Uint8Array([0xff, 0xd8, 0xff]),
      { ...env, ANALYTICS: ana.binding },
      { readingId: READING_ID },
    );

    const rejections = eventsOfKind(ana.calls, "dial_reader_rejection");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.payload).toMatchObject({
      reading_id: READING_ID,
      reason: "low_confidence",
    });
    expect(eventsOfKind(ana.calls, "dial_reader_success")).toHaveLength(0);
  });

  it("emits dial_reader_error on a 5xx transport failure", async () => {
    const ana = makeFakeAnalytics();
    const { env } = makeFakeContainerEnv(
      async () => new Response("internal server error", { status: 503 }),
    );

    await readDial(
      new Uint8Array([0xff]),
      { ...env, ANALYTICS: ana.binding },
      { readingId: READING_ID },
    );

    const errors = eventsOfKind(ana.calls, "dial_reader_error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.payload).toMatchObject({
      reading_id: READING_ID,
      error_type: "http_5xx",
    });
    expect(errors[0]!.payload.error_message).toMatch(/503/);
  });

  it("emits dial_reader_error on a thrown fetch exception", async () => {
    const ana = makeFakeAnalytics();
    const { env } = makeFakeContainerEnv(async () => {
      throw new Error("network unreachable");
    });

    await readDial(
      new Uint8Array([0xff]),
      { ...env, ANALYTICS: ana.binding },
      { readingId: READING_ID },
    );

    const errors = eventsOfKind(ana.calls, "dial_reader_error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.payload).toMatchObject({
      reading_id: READING_ID,
      error_type: "transport_exception",
    });
    expect(errors[0]!.payload.error_message).toContain("network unreachable");
  });

  it("emits dial_reader_cold_start when the fetch wait exceeds 1s", async () => {
    const ana = makeFakeAnalytics();
    // Fake a slow container: stall the response 1.5s. We use a real
    // setTimeout with a manipulated Date.now via vi.useFakeTimers
    // would be cleaner, but since the adapter measures wall-clock,
    // we instead patch Date.now around the call.
    const realNow = Date.now;
    let fakeNow = 1_000_000_000_000;
    Date.now = () => fakeNow;

    const { env } = makeFakeContainerEnv(async () => {
      // Advance the fake clock by 1500ms while the fetch is "in flight".
      fakeNow += 1500;
      return new Response(JSON.stringify(HARDCODED_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await readDial(
        new Uint8Array([0xff, 0xd8, 0xff]),
        { ...env, ANALYTICS: ana.binding },
        { readingId: READING_ID },
      );
    } finally {
      Date.now = realNow;
    }

    const colds = eventsOfKind(ana.calls, "dial_reader_cold_start");
    expect(colds).toHaveLength(1);
    expect(colds[0]!.payload).toMatchObject({
      reading_id: READING_ID,
    });
    expect(colds[0]!.payload.wait_ms).toBeGreaterThanOrEqual(1000);
  });

  it("does NOT emit cold_start when the fetch returns within 1s", async () => {
    const ana = makeFakeAnalytics();
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(JSON.stringify(HARDCODED_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await readDial(
      new Uint8Array([0xff, 0xd8, 0xff]),
      { ...env, ANALYTICS: ana.binding },
      { readingId: READING_ID },
    );

    expect(eventsOfKind(ana.calls, "dial_reader_cold_start")).toHaveLength(0);
  });

  it("emits no events when context is omitted (legacy two-arg call)", async () => {
    const ana = makeFakeAnalytics();
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(JSON.stringify(HARDCODED_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    // Use the env that has analytics but call without context — the
    // adapter must stay silent because there is no reading_id to
    // correlate against. (The verifier always supplies context in
    // production; this guards the legacy path.)
    await readDial(new Uint8Array([0xff, 0xd8, 0xff]), {
      ...env,
      ANALYTICS: ana.binding,
    });

    expect(ana.calls).toHaveLength(0);
  });

  it("identifies common image formats from magic bytes", async () => {
    const ana = makeFakeAnalytics();
    const { env } = makeFakeContainerEnv(
      async () =>
        new Response(JSON.stringify(HARDCODED_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const cases: Array<[string, Uint8Array]> = [
      ["jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
      ["png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      [
        "webp",
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        ]),
      ],
      [
        "heic",
        new Uint8Array([
          0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
        ]),
      ],
      ["unknown", new Uint8Array([0x00, 0x00, 0x00, 0x00])],
    ];

    for (const [expected, bytes] of cases) {
      ana.calls.length = 0;
      await readDial(
        bytes,
        { ...env, ANALYTICS: ana.binding },
        { readingId: READING_ID },
      );
      const attempts = eventsOfKind(ana.calls, "dial_reader_attempt");
      expect(attempts[0]!.payload).toMatchObject({ image_format: expected });
    }
  });
});
