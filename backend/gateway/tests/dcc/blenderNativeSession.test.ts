import { describe, expect, it, vi } from "vitest";
import { BLENDER_LIVE_CONTRACT } from "../../../../packages/protocol/src/blenderLiveProtocol";
import { createBlenderNativeSession } from "../../dcc/blenderNativeSession";

const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Blender native session", () => {
  it("discovers a loopback Blender session and forwards auth", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch,
        blenderVersion: "5.1.2",
        revision: 2,
        busy: false,
      }),
    );
    const session = createBlenderNativeSession({
      fetcher,
      token: "secret",
    });
    await expect(session.status()).resolves.toMatchObject({
      available: true,
      revision: 2,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8791/health",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("submits validated blockout commands", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: "21c84665-2730-4248-9a0e-45b798b5b3fe",
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        status: "queued",
      }),
    );
    const session = createBlenderNativeSession({ fetcher });
    await session.submit({
      contract: BLENDER_LIVE_CONTRACT,
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      expectedSceneEpoch: sceneEpoch,
      operations: [{ op: "create_blockout", preset: "room", idPrefix: "room-a" }],
    });
    const request = fetcher.mock.calls[0]![1]!;
    expect(JSON.parse(String(request.body))).toMatchObject({
      expectedSceneEpoch: sceneEpoch,
      operations: [{ op: "create_blockout", preset: "room", width: 8, depth: 6 }],
    });
  });

  it("sends the configured bearer token with command submissions", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: "21c84665-2730-4248-9a0e-45b798b5b3fe",
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        status: "queued",
      }),
    );
    const session = createBlenderNativeSession({ fetcher, token: "secret" });

    await session.submit({
      contract: BLENDER_LIVE_CONTRACT,
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      operations: [{ op: "export_scene_preview" }],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8791/v1/commands",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("forwards the parameterless read-only GLB preview operation", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: "21c84665-2730-4248-9a0e-45b798b5b3fe",
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        status: "queued",
      }),
    );
    const session = createBlenderNativeSession({ fetcher });

    await session.submit({
      contract: BLENDER_LIVE_CONTRACT,
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      operations: [{ op: "export_scene_preview" }],
    });

    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      contract: BLENDER_LIVE_CONTRACT,
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      operations: [{ op: "export_scene_preview" }],
    });
  });

  it("consumes a terminal one-time native payload through the job endpoint", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        contract: BLENDER_LIVE_CONTRACT,
        jobId: "21c84665-2730-4248-9a0e-45b798b5b3fe",
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        status: "succeeded",
        revision: 2,
        result: null,
        error: null,
      }),
    );
    const session = createBlenderNativeSession({ fetcher });

    await session.job("21c84665-2730-4248-9a0e-45b798b5b3fe", {
      consume: true,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8791/v1/jobs/21c84665-2730-4248-9a0e-45b798b5b3fe?consume=1",
      expect.any(Object),
    );
  });

  it("downloads the detached scene GLB as raw binary with scene headers and auth", async () => {
    const glb = Buffer.from("glTF-binary-payload");
    const fetcher = vi.fn(
      async () =>
        new Response(glb, {
          status: 200,
          headers: {
            "Content-Type": "model/gltf-binary",
            "Content-Length": String(glb.byteLength),
            "X-Blender-Scene-Epoch": sceneEpoch,
            "X-Blender-Revision": "7",
          },
        }),
    );
    const session = createBlenderNativeSession({ fetcher, token: "secret" });

    const preview = await session.previewGlb("21c84665-2730-4248-9a0e-45b798b5b3fe", { consume: true });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8791/v1/previews/21c84665-2730-4248-9a0e-45b798b5b3fe.glb?consume=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
    expect(Buffer.from(preview.bytes)).toEqual(glb);
    expect(preview.sceneEpoch).toBe(sceneEpoch);
    expect(preview.revision).toBe(7);
  });

  it("rejects binary previews without valid scene headers", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(Buffer.from("glTF"), {
          status: 200,
          headers: { "Content-Type": "model/gltf-binary" },
        }),
    );
    const session = createBlenderNativeSession({ fetcher });

    await expect(session.previewGlb("21c84665-2730-4248-9a0e-45b798b5b3fe")).rejects.toThrow(/invalid scene headers/i);
  });

  it("rejects binary previews that declare more than the binary byte cap", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(Buffer.from("glTF"), {
          status: 200,
          headers: {
            "Content-Length": String(513 * 1024 * 1024),
            "X-Blender-Scene-Epoch": sceneEpoch,
            "X-Blender-Revision": "7",
          },
        }),
    );
    const session = createBlenderNativeSession({ fetcher });

    await expect(session.previewGlb("21c84665-2730-4248-9a0e-45b798b5b3fe")).rejects.toThrow(/binary size limit/i);
  });

  it("surfaces the native 404 for unknown or consumed previews", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "Unknown preview" }, 404));
    const session = createBlenderNativeSession({ fetcher });

    await expect(session.previewGlb("21c84665-2730-4248-9a0e-45b798b5b3fe")).rejects.toMatchObject({
      status: 404,
      message: "Unknown preview",
    });
  });

  it("retries a transient snapshot fetch failure", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          contract: BLENDER_LIVE_CONTRACT,
          sceneEpoch,
          revision: 3,
          sceneName: "Scene",
          frame: 1,
          unit: "meter",
          coordinateSystem: "right-handed-y-up-negative-z-forward",
          objects: [],
          cameras: [],
          lights: [],
          selectedObjectIds: [],
          activeObjectId: null,
        }),
      );
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.snapshot()).resolves.toMatchObject({ revision: 3, sceneEpoch });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses non-loopback session URLs", () => {
    expect(() => createBlenderNativeSession({ baseUrl: "http://example.com:8791" })).toThrow(/non-loopback/i);
  });
});
