import { describe, expect, it, vi } from "vitest";
import { BLENDER_LIVE_CONTRACT } from "../../../../packages/protocol/src/blenderLiveProtocol";
import { createBlenderNativeSession } from "../../dcc/blenderNativeSession";

/**
 * Adversarial stress tests for the Blender native session HTTP client:
 * token invalidation, oversized and malformed native responses, and
 * disconnect/timeout classification. All host-free via a mocked fetcher.
 */

const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";
const jobId = "21c84665-2730-4248-9a0e-45b798b5b3fe";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("native session stress: token invalidation", () => {
  it.each([[401], [403]])("maps a %d rejection to the structured blender_auth_invalid code", async (status) => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "A valid session bearer token is required" }, status));
    const session = createBlenderNativeSession({ fetcher, token: "rotated-away" });
    await expect(session.snapshot()).rejects.toMatchObject({
      status,
      code: "blender_auth_invalid",
      message: "A valid session bearer token is required",
    });
    // Auth rejections are not transient: exactly one request, no retry loop.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies live-link polling under an invalidated token without retry storms", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "A valid session bearer token is required" }, 401));
    const session = createBlenderNativeSession({ fetcher, token: "expired" });
    await expect(session.liveLink({ sceneEpoch, since: 4 })).rejects.toMatchObject({
      status: 401,
      code: "blender_auth_invalid",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps binary preview auth rejections to the same structured code", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "A valid session bearer token is required" }, 401));
    const session = createBlenderNativeSession({ fetcher, token: "expired" });
    await expect(session.previewGlb(jobId)).rejects.toMatchObject({
      status: 401,
      code: "blender_auth_invalid",
    });
  });

  it("keeps command submission rejections structured when the token is revoked mid-session", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "A valid session bearer token is required" }, 401));
    const session = createBlenderNativeSession({ fetcher, token: "revoked" });
    await expect(
      session.submit({
        contract: BLENDER_LIVE_CONTRACT,
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        operations: [{ op: "export_scene_preview" }],
      }),
    ).rejects.toMatchObject({ status: 401, code: "blender_auth_invalid" });
  });

  it("reports status as unavailable instead of throwing when the token is invalid", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "A valid session bearer token is required" }, 401));
    const session = createBlenderNativeSession({ fetcher, token: "expired" });
    await expect(session.status()).resolves.toMatchObject({
      available: false,
      reason: "A valid session bearer token is required",
    });
  });
});

describe("native session stress: oversized and malformed responses", () => {
  it("rejects a JSON response whose declared content length exceeds the 32 MB cap without reading it", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json", "Content-Length": String(33 * 1024 * 1024) },
        }),
    );
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.snapshot()).rejects.toThrow(/size limit/i);
  });

  it("rejects an actually oversized JSON body even when no content length is declared", async () => {
    const body = `{"padding":"${"x".repeat(33 * 1024 * 1024)}"}`;
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }));
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.snapshot()).rejects.toThrow(/size limit/i);
  }, 30_000);

  it("rejects invalid JSON instead of forwarding garbage to consumers", async () => {
    const fetcher = vi.fn(async () => new Response("{\"contract\": ", { status: 200 }));
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.snapshot()).rejects.toThrow(/invalid JSON/i);
  });

  it("rejects contract-violating payloads with a schema mismatch, never a partial parse", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch: "not-a-uuid",
        revision: -3,
        objects: "nope",
      }),
    );
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.snapshot()).rejects.toThrow(/contract mismatch/i);
  });

  it("rejects binary previews that stream more bytes than declared allows", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(Buffer.from("glTF-small"), {
          status: 200,
          headers: {
            "Content-Type": "model/gltf-binary",
            "Content-Length": String(513 * 1024 * 1024),
            "X-Blender-Scene-Epoch": sceneEpoch,
            "X-Blender-Revision": "3",
          },
        }),
    );
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.previewGlb(jobId)).rejects.toThrow(/binary size limit/i);
  });

  it.each([
    ["missing epoch header", { "X-Blender-Revision": "3" }],
    ["malformed epoch header", { "X-Blender-Scene-Epoch": "not-a-uuid", "X-Blender-Revision": "3" }],
    ["negative revision header", { "X-Blender-Scene-Epoch": sceneEpoch, "X-Blender-Revision": "-1" }],
    ["fractional revision header", { "X-Blender-Scene-Epoch": sceneEpoch, "X-Blender-Revision": "1.5" }],
  ])("rejects a binary preview with %s", async (_name, headers) => {
    const fetcher = vi.fn(
      async () =>
        new Response(Buffer.from("glTF"), {
          status: 200,
          headers: { "Content-Type": "model/gltf-binary", ...headers },
        }),
    );
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.previewGlb(jobId)).rejects.toThrow(/invalid scene headers/i);
  });
});

describe("native session stress: disconnects and replayed identifiers", () => {
  it("classifies an aborted request as a structured timeout, not a transient retry", async () => {
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), 5);
        }),
    );
    const session = createBlenderNativeSession({ fetcher, timeoutMs: 1 });
    await expect(session.snapshot()).rejects.toMatchObject({ status: 504, code: "blender_timeout" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a mid-flight connection reset exactly once before failing structurally", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.snapshot()).rejects.toMatchObject({ status: 503, code: "blender_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([["not-a-uuid"], [""], ["21c84665-2730-4248-9a0e-45b798b5b3f"], ["../../etc/passwd"]])(
    "rejects the malformed job id %j before any network traffic",
    (candidate) => {
      const fetcher = vi.fn();
      const session = createBlenderNativeSession({ fetcher });
      expect(() => session.job(candidate)).toThrow();
      expect(() => session.previewGlb(candidate)).toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed live-link cursors before any network traffic", () => {
    const fetcher = vi.fn();
    const session = createBlenderNativeSession({ fetcher });
    expect(() => session.liveLink({ sceneEpoch: "not-a-uuid", since: 0 })).toThrow();
    expect(() => session.liveLink({ sceneEpoch, since: -1 })).toThrow();
    expect(() => session.liveLink({ sceneEpoch, since: 1.5 })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
