import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setTestDialReader,
  readDial,
  type DialReadResult,
  type DialReadSuccessBody,
  type DialReaderEnv,
} from "./adapter";

// The dial-reader adapter is the typed bridge between the Worker
// and the Cloudflare Container that runs OpenCV / image decoding /
// hand-angle parsing. Slice #74 (this scaffolding step) does not
// wire it into any production code path; the verifier still uses
// the legacy AI runner. These tests pin the contract so slice #75
// can wire the verifier without ambiguity.
//
// The pattern mirrors `__setTestAiRunner` in
// src/domain/ai-dial-reader/runner.ts: a module-level fake lets
// integration tests drive the verifier without spinning up a real
// container, which is impossible inside vitest-pool-workers anyway
// (Container DOs always resolve remotely in production, the same
// way the AI binding does).

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
