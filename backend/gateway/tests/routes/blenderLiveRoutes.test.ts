import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLENDER_LIVE_CONTRACT } from "../../../../packages/protocol/src/blenderLiveProtocol";
import { BlenderNativeSessionError, type BlenderNativeSession } from "../../dcc/blenderNativeSession";
import { handleBlenderLiveRoute, type BlenderLiveRouteDependencies } from "../../routes/blenderLiveRoutes";

const requestId = "63a521f0-7fe3-4fd7-8e06-8457e806c6b3";
const jobId = "21c84665-2730-4248-9a0e-45b798b5b3fe";
const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function harness(payload: unknown = null, jobResult?: unknown) {
  const writes: Array<{ status: number; body: unknown }> = [];
  const response = {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  const session: BlenderNativeSession = {
    status: vi.fn().mockResolvedValue({
      available: true,
      ok: true,
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      blenderVersion: "5.1.2",
      revision: 3,
      busy: false,
    }),
    liveLink: vi.fn(),
    snapshot: vi.fn().mockResolvedValue({
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      revision: 3,
      sceneName: "Scene",
      frame: 1,
      unit: "meter",
      coordinateSystem: "right-handed-y-up-negative-z-forward",
      objects: [],
      cameras: [],
    }),
    submit: vi.fn().mockResolvedValue({
      contract: BLENDER_LIVE_CONTRACT,
      jobId,
      requestId,
      status: "queued",
    }),
    job: vi.fn().mockResolvedValue({
      contract: BLENDER_LIVE_CONTRACT,
      jobId,
      requestId,
      status: "succeeded",
      revision: 4,
      result: jobResult,
      error: null,
    }),
    previewGlb: vi.fn(),
  };
  const dependencies: BlenderLiveRouteDependencies = {
    readBody: vi.fn().mockResolvedValue(payload),
    json: (_response, status, body) => writes.push({ status, body }),
    session,
  };
  return {
    session,
    dependencies,
    writes,
    response,
    request: (method: string, origin?: string) => ({ method, headers: origin ? { origin } : {} }) as IncomingMessage,
  };
}

describe("Blender live routes", () => {
  it("stores a Director model for native Blender import", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-model-"));
    temporaryRoots.push(assetRoot);
    const bytes = Buffer.from("native model fixture");
    const request = Readable.from([bytes]) as unknown as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      headers: { "content-length": String(bytes.byteLength) },
    });
    const context = harness();
    context.dependencies.assetRoot = assetRoot;

    await handleBlenderLiveRoute(
      request,
      context.response,
      new URL("http://director.test/api/dcc/blender/assets?fileName=hero%20chair.glb&assetId=mixamo%3Ax-bot"),
      context.dependencies,
    );

    expect(context.writes.at(-1)).toMatchObject({
      status: 201,
      body: {
        success: true,
        result: {
          byteLength: bytes.byteLength,
          fileName: "hero chair.glb",
          url: "/native-models/asset-bWl4YW1vOngtYm90/hero%20chair.glb",
        },
      },
    });
    const result = context.writes.at(-1)?.body as { result: { url: string } };
    expect(await readFile(resolve(assetRoot, decodeURIComponent(result.result.url.slice(1))))).toEqual(bytes);
  });

  it.each([["garden.ply"], ["garden.splat"], ["garden.ksplat"], ["garden.spz"], ["garden.sog"]])(
    "stores the %s gaussian splat capture for viewport rendering",
    async (fileName) => {
      const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-model-"));
      temporaryRoots.push(assetRoot);
      const bytes = Buffer.from("gaussian splat fixture");
      const request = Readable.from([bytes]) as unknown as IncomingMessage;
      Object.assign(request, {
        method: "POST",
        headers: { "content-length": String(bytes.byteLength) },
      });
      const context = harness();
      context.dependencies.assetRoot = assetRoot;

      await handleBlenderLiveRoute(
        request,
        context.response,
        new URL(`http://director.test/api/dcc/blender/assets?fileName=${encodeURIComponent(fileName)}`),
        context.dependencies,
      );

      expect(context.writes.at(-1)).toMatchObject({
        status: 201,
        body: { success: true, result: { byteLength: bytes.byteLength, fileName } },
      });
    },
  );

  it("rejects model uploads that are neither mesh models nor gaussian splats", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-model-"));
    temporaryRoots.push(assetRoot);
    const bytes = Buffer.from("unsupported fixture");
    const request = Readable.from([bytes]) as unknown as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      headers: { "content-length": String(bytes.byteLength) },
    });
    const context = harness();
    context.dependencies.assetRoot = assetRoot;

    await handleBlenderLiveRoute(
      request,
      context.response,
      new URL("http://director.test/api/dcc/blender/assets?fileName=scene.usd"),
      context.dependencies,
    );

    expect(context.writes.at(-1)).toMatchObject({
      status: 400,
      body: {
        success: false,
        error:
          "Native model filename must use FBX, OBJ, GLB, GLTF, a PLY/SPLAT/KSPLAT/SPZ/SOG gaussian splat, or a ZIP splat sequence.",
      },
    });
  });

  it("unpacks a 4DGS ZIP into ordered frames plus a sequence manifest", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-model-"));
    temporaryRoots.push(assetRoot);
    const zip = new JSZip();
    zip.file("capture/frame_10.spz", Buffer.from("frame ten"));
    zip.file("capture/frame_2.spz", Buffer.from("frame two"));
    zip.file("capture/frame_1.spz", Buffer.from("frame one"));
    zip.file("capture/manifest.json", JSON.stringify({ fps: 24 }));
    zip.file("__MACOSX/capture/._frame_1.spz", Buffer.from("resource fork noise"));
    zip.file("capture/notes.txt", "not a frame");
    const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    const request = Readable.from([bytes]) as unknown as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      headers: { "content-length": String(bytes.byteLength) },
    });
    const context = harness();
    context.dependencies.assetRoot = assetRoot;

    await handleBlenderLiveRoute(
      request,
      context.response,
      new URL("http://director.test/api/dcc/blender/assets?fileName=dance.zip&assetId=capture%3Adance"),
      context.dependencies,
    );

    expect(context.writes.at(-1)).toMatchObject({
      status: 201,
      body: {
        success: true,
        result: {
          fileName: "dance.4dgs.json",
          url: "/native-models/asset-Y2FwdHVyZTpkYW5jZQ/dance.4dgs.json",
          splatSequence: { frameCount: 3, fps: 24 },
        },
      },
    });
    const directory = resolve(assetRoot, "native-models", "asset-Y2FwdHVyZTpkYW5jZQ");
    const manifest = JSON.parse(await readFile(resolve(directory, "dance.4dgs.json"), "utf8"));
    expect(manifest).toEqual({
      format: "director-splat-sequence@1",
      fps: 24,
      frameCount: 3,
      frames: ["frames/frame-00001.spz", "frames/frame-00002.spz", "frames/frame-00003.spz"],
    });
    await expect(readFile(resolve(directory, "frames", "frame-00001.spz"), "utf8")).resolves.toBe("frame one");
    await expect(readFile(resolve(directory, "frames", "frame-00002.spz"), "utf8")).resolves.toBe("frame two");
    await expect(readFile(resolve(directory, "frames", "frame-00003.spz"), "utf8")).resolves.toBe("frame ten");
  });

  it("rejects a splat sequence archive with no splat frames", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-model-"));
    temporaryRoots.push(assetRoot);
    const zip = new JSZip();
    zip.file("readme.txt", "no frames here");
    const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    const request = Readable.from([bytes]) as unknown as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      headers: { "content-length": String(bytes.byteLength) },
    });
    const context = harness();
    context.dependencies.assetRoot = assetRoot;

    await handleBlenderLiveRoute(
      request,
      context.response,
      new URL("http://director.test/api/dcc/blender/assets?fileName=empty.zip"),
      context.dependencies,
    );

    expect(context.writes.at(-1)).toMatchObject({
      status: 400,
      body: {
        success: false,
        error: "Splat sequence archive contains no PLY/SPLAT/KSPLAT/SPZ/SOG frames.",
      },
    });
  });

  it("publishes connection state without exposing native session credentials", async () => {
    const context = harness();
    expect(
      await handleBlenderLiveRoute(
        context.request("GET"),
        context.response,
        new URL("http://director.test/api/dcc/blender/status"),
        context.dependencies,
      ),
    ).toBe(true);
    expect(context.writes.at(-1)).toMatchObject({
      status: 200,
      body: { success: true, result: { available: true, revision: 3 } },
    });
  });

  it("serves the preview-only live-link feed without a cursor as first contact", async () => {
    const context = harness();
    const resync: Awaited<ReturnType<BlenderNativeSession["liveLink"]>> = {
      kind: "resync",
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      seq: 4,
      reason: "initial",
    };
    vi.mocked(context.session.liveLink).mockResolvedValue(resync);

    expect(
      await handleBlenderLiveRoute(
        context.request("GET"),
        context.response,
        new URL("http://director.test/api/dcc/blender/live-link"),
        context.dependencies,
      ),
    ).toBe(true);

    expect(context.session.liveLink).toHaveBeenCalledWith(undefined);
    expect(context.writes.at(-1)).toEqual({ status: 200, body: { success: true, result: resync } });
  });

  it("forwards a live-link cursor and returns the contiguous delta frames", async () => {
    const context = harness();
    const frames: Awaited<ReturnType<BlenderNativeSession["liveLink"]>> = {
      kind: "frames",
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      seq: 6,
      frames: [
        {
          seq: 6,
          kind: "transform",
          revision: 6,
          frame: 1,
          objects: [{ id: "chair", position: [1, 0, 2], rotation: [0, 0.5, 0], scale: [1, 1, 1] }],
          cameras: [],
          lights: [],
        },
      ],
    };
    vi.mocked(context.session.liveLink).mockResolvedValue(frames);

    await handleBlenderLiveRoute(
      context.request("GET"),
      context.response,
      new URL(`http://director.test/api/dcc/blender/live-link?epoch=${sceneEpoch}&since=5`),
      context.dependencies,
    );

    expect(context.session.liveLink).toHaveBeenCalledWith({ sceneEpoch, since: 5 });
    expect(context.writes.at(-1)).toEqual({ status: 200, body: { success: true, result: frames } });
  });

  it.each([
    [`epoch=${sceneEpoch}`],
    ["since=5"],
    ["epoch=not-a-uuid&since=5"],
    [`epoch=${sceneEpoch}&since=-1`],
    [`epoch=${sceneEpoch}&since=1.5`],
  ])("rejects the partial or malformed live-link cursor ?%s", async (query) => {
    const context = harness();

    await handleBlenderLiveRoute(
      context.request("GET"),
      context.response,
      new URL(`http://director.test/api/dcc/blender/live-link?${query}`),
      context.dependencies,
    );

    expect(context.session.liveLink).not.toHaveBeenCalled();
    expect(context.writes.at(-1)).toMatchObject({
      status: 400,
      body: { success: false, code: "blender_live_link_cursor_invalid" },
    });
  });

  it("rejects non-GET live-link requests", async () => {
    const context = harness();

    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/dcc/blender/live-link"),
      context.dependencies,
    );

    expect(context.session.liveLink).not.toHaveBeenCalled();
    expect(context.writes.at(-1)).toMatchObject({
      status: 405,
      body: { success: false, code: "blender_method_not_allowed" },
    });
  });

  it("reports live-link unavailability as a session error instead of crashing", async () => {
    const context = harness();
    vi.mocked(context.session.liveLink).mockRejectedValue(
      new BlenderNativeSessionError("Blender live kernel is not running.", 503, "blender_unavailable"),
    );

    await handleBlenderLiveRoute(
      context.request("GET"),
      context.response,
      new URL("http://director.test/api/dcc/blender/live-link"),
      context.dependencies,
    );

    expect(context.writes.at(-1)).toMatchObject({
      status: 503,
      body: { success: false, code: "blender_unavailable", error: "Blender live kernel is not running." },
    });
  });

  it("validates and forwards a deterministic blockout transaction", async () => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
      operations: [{ op: "create_blockout", preset: "room", idPrefix: "room-a" }],
    });
    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/dcc/blender/commands"),
      context.dependencies,
    );
    expect(context.session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 3,
        operations: [
          expect.objectContaining({
            op: "create_blockout",
            width: 8,
            depth: 6,
          }),
        ],
      }),
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 202,
      body: { success: true },
    });
  });

  it("rejects malformed mutations before Blender receives them", async () => {
    const context = harness({
      requestId,
      operations: [{ op: "delete_object", id: "" }],
    });
    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/dcc/blender/commands"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 400,
      body: { success: false, code: "blender_command_invalid" },
    });
    expect(context.session.submit).not.toHaveBeenCalled();
  });

  it("rejects quitting Blender before Blender receives them", async () => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
      operations: [{ op: "invoke_operator", operator: "wm.quit_blender" }],
    });
    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/dcc/blender/commands"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 400,
      body: { success: false, code: "blender_operator_denied" },
    });
    expect(context.session.submit).not.toHaveBeenCalled();
  });

  it("looks up jobs by validated UUID", async () => {
    const context = harness();
    await handleBlenderLiveRoute(
      context.request("GET"),
      context.response,
      new URL(`http://director.test/api/dcc/blender/jobs/${jobId}`),
      context.dependencies,
    );
    expect(context.session.job).toHaveBeenCalledWith(jobId);
    expect(context.writes.at(-1)).toMatchObject({
      status: 200,
      body: { result: { status: "succeeded" } },
    });
  });

  it("strips binary payloads from the public native job endpoint", async () => {
    const context = harness(null, {
      operations: [
        {
          contract: BLENDER_LIVE_CONTRACT,
          revision: 3,
          mimeType: "model/gltf-binary",
          dataBase64: "Z2xURg==",
          byteLength: 4,
        },
      ],
    });

    await handleBlenderLiveRoute(
      context.request("GET"),
      context.response,
      new URL(`http://director.test/api/dcc/blender/jobs/${jobId}`),
      context.dependencies,
    );

    expect(context.writes.at(-1)?.body).toMatchObject({
      result: {
        result: {
          operations: [{ mimeType: "model/gltf-binary", byteLength: 4 }],
        },
      },
    });
    expect(JSON.stringify(context.writes.at(-1)?.body)).not.toContain("dataBase64");
  });

  it("lets an Agent apply one native Blender transaction and returns compact effect evidence", async () => {
    const context = harness({
      input: {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 3,
        operations: [
          {
            op: "set_parent",
            id: "chair-a",
            parentId: "room-a",
            keepWorldTransform: true,
          },
          {
            op: "add_constraint",
            id: "camera-a",
            targetId: "actor-a",
            kind: "track_to",
          },
        ],
      },
      session_id: "agent-a",
    });
    context.dependencies.bindDirectorProject = vi.fn().mockResolvedValue(undefined);
    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );
    expect(context.session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 3,
        operations: [
          expect.objectContaining({
            op: "set_parent",
            id: "chair-a",
            parentId: "room-a",
          }),
          expect.objectContaining({
            op: "add_constraint",
            kind: "track_to",
            influence: 1,
          }),
        ],
      }),
    );
    expect(context.dependencies.bindDirectorProject).toHaveBeenCalledWith({
      sessionId: "agent-a",
      targetToken: undefined,
    });
    expect(context.session.job).toHaveBeenCalledWith(jobId);
    expect(context.writes.at(-1)).toMatchObject({
      status: 200,
      body: {
        success: true,
        director_project_sync: "automatic",
        result: {
          sceneEpoch,
          job: { status: "succeeded" },
          receipt: {
            sceneEpoch,
            revisionBefore: 3,
            revisionAfter: 3,
            dirtyObjectIds: ["camera-a", "chair-a"],
          },
          evidence: { sceneEpoch, revision: 3 },
        },
      },
    });
    expect((context.writes.at(-1)?.body as { result?: unknown }).result).not.toHaveProperty("scene");
  });

  it("returns exact field guidance for an invalid native request", async () => {
    const context = harness({
      input: {
        op: "apply",
        sceneEpoch,
        revision: 3,
        operations: [{ op: "add_camera", id: "camera-a" }],
      },
    });

    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    expect(context.session.submit).not.toHaveBeenCalled();
    expect(context.writes.at(-1)).toMatchObject({
      status: 400,
      body: {
        success: false,
        error: expect.stringContaining("input.operations.0.op"),
      },
    });
    expect(String((context.writes.at(-1)?.body as { error?: string }).error)).toContain("create_camera");
  });

  it("maps read-only Agent discovery and inspection entry points to native operations", async () => {
    const context = harness(
      {
        input: { op: "catalog", query: "bevel", availableOnly: true },
        session_id: "agent-a",
      },
      { operations: [{ total: 2, operators: [{ id: "mesh.bevel" }] }] },
    );
    context.dependencies.bindDirectorProject = vi.fn().mockResolvedValue(undefined);
    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    expect(context.session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          expect.objectContaining({
            op: "discover_operators",
            query: "bevel",
            scope: "modeling",
            availableOnly: true,
            limit: 80,
          }),
        ],
      }),
    );
    expect(context.session.snapshot).not.toHaveBeenCalled();
    expect(context.dependencies.bindDirectorProject).not.toHaveBeenCalled();
    expect(context.writes.at(-1)).toMatchObject({
      status: 200,
      body: { success: true, result: { result: { total: 2 } } },
    });
  });

  it("lifts blender_native query strings into a NAME object search", async () => {
    const context = harness(
      {
        input: { op: "query", query: "清华" },
      },
      {
        operations: [
          {
            queries: [
              {
                kind: "NAME",
                namePattern: "清华",
                objects: [{ id: "gate-a", name: "清华二校门" }],
                matched: 1,
                truncated: false,
              },
            ],
          },
        ],
      },
    );

    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    expect(context.session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          expect.objectContaining({
            op: "query_spatial",
            queries: [expect.objectContaining({ kind: "NAME", namePattern: "清华" })],
          }),
        ],
      }),
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 200,
      body: {
        success: true,
        result: {
          result: {
            objects: [{ id: "gate-a", name: "清华二校门" }],
          },
        },
      },
    });
  });

  it("inspects a native object without binding a Director project", async () => {
    const inspection = {
      id: "cube-a",
      name: "Cube",
      type: "MESH",
      mode: "OBJECT",
      dimensions: [1, 1, 1],
      evaluatedBounds: {
        min: [-0.5, 0, -0.5],
        max: [0.5, 1, 0.5],
        center: [0, 0.5, 0],
        size: [1, 1, 1],
      },
      selection: { selected: true, active: true },
      materialNodes: [],
      animation: {
        action: null,
        fCurveCount: 0,
        keyframeCount: 0,
        driverCount: 0,
        nlaTrackCount: 0,
        nlaStripCount: 0,
      },
      warnings: [],
    };
    const context = harness(
      { input: { op: "inspect", id: "cube-a" }, session_id: "agent-a" },
      { operations: [inspection] },
    );
    context.dependencies.bindDirectorProject = vi.fn().mockRejectedValue(new Error("should not bind"));

    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    expect(context.dependencies.bindDirectorProject).not.toHaveBeenCalled();
    expect(context.writes.at(-1)).toMatchObject({
      status: 200,
      body: {
        success: true,
        result: { result: { id: "cube-a", dimensions: [1, 1, 1], position: [0, 0.5, 0] } },
      },
    });
  });

  it("returns a complete retry ticket when a naive native apply outcome is unknown", async () => {
    const context = harness({
      input: {
        op: "apply",
        operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
      },
      session_id: "agent-a",
    });
    context.session.submit = vi
      .fn()
      .mockRejectedValue(new BlenderNativeSessionError("Native submit timed out.", 504, "blender_timeout"));

    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    expect(context.writes.at(-1)).toMatchObject({
      status: 409,
      body: {
        success: false,
        code: "outcome_unknown",
        result: {
          operation: "blender_native.apply",
          outcome: "unknown",
          retry_requires_observe: false,
          retry_ticket: {
            input: {
              op: "apply",
              expectedSceneEpoch: sceneEpoch,
              expectedRevision: 3,
              intentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
              operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
            },
          },
        },
      },
    });
  });

  it("promotes a clean Blender capture for Agent vision consumers", async () => {
    const capture = {
      mimeType: "image/png",
      dataBase64: "aW1hZ2U=",
      width: 800,
      height: 450,
      cameraId: "camera-a",
    };
    const context = harness(
      {
        input: { op: "capture", cameraId: "camera-a", width: 800, height: 450 },
        session_id: "agent-a",
      },
      { operations: [capture] },
    );
    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    expect(context.session.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "capture_render",
            cameraId: "camera-a",
            width: 800,
            height: 450,
            transparent: false,
          },
        ],
      }),
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 200,
      body: {
        success: true,
        result: {
          result: {
            mimeType: "image/png",
            width: 800,
            height: 450,
            cameraId: "camera-a",
          },
        },
        capture,
      },
    });
    expect(JSON.stringify((context.writes.at(-1)?.body as { result?: unknown }).result)).not.toContain("dataBase64");
  });

  it("serves the native GLB preview only through the dedicated binary route", async () => {
    const preview = {
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      revision: 3,
      mimeType: "model/gltf-binary",
      byteLength: 4,
    };
    const context = harness(null, { operations: [preview] });
    vi.mocked(context.session.previewGlb).mockResolvedValue({
      bytes: Buffer.from("glTF"),
      sceneEpoch,
      revision: 3,
    });

    await handleBlenderLiveRoute(
      context.request("GET", "http://127.0.0.1:5175"),
      context.response,
      new URL("http://director.test/api/dcc/blender/preview.glb"),
      context.dependencies,
    );
    await handleBlenderLiveRoute(
      context.request("GET", "http://127.0.0.1:5175"),
      context.response,
      new URL("http://director.test/api/dcc/blender/preview.glb"),
      context.dependencies,
    );

    expect(context.session.submit).toHaveBeenCalledWith(
      expect.objectContaining({ operations: [{ op: "export_scene_preview" }] }),
    );
    expect(context.response.writeHead).toHaveBeenCalledWith(200, {
      "access-control-allow-origin": "http://127.0.0.1:5175",
      "access-control-expose-headers": "X-Blender-Revision, X-Blender-Scene-Epoch, Content-Length",
      "cache-control": "private, no-store",
      "content-length": "4",
      "content-type": "model/gltf-binary",
      "x-blender-scene-epoch": sceneEpoch,
      "x-blender-revision": "3",
      vary: "Origin",
    });
    expect(context.response.end).toHaveBeenCalledWith(Buffer.from("glTF"));
    expect(context.session.submit).toHaveBeenCalledTimes(1);
    expect(context.session.job).toHaveBeenCalledTimes(1);
    expect(context.session.job).toHaveBeenCalledWith(jobId);
    expect(context.session.previewGlb).toHaveBeenCalledTimes(1);
    expect(context.session.previewGlb).toHaveBeenCalledWith(jobId, { consume: true });
    expect(context.writes).toEqual([]);
  });

  it("refreshes a cached preview when Blender starts a new scene epoch at the same revision", async () => {
    const nextEpoch = "907d1be9-c19d-4297-8faf-c6f4bcbd8250";
    const context = harness();
    vi.mocked(context.session.status)
      .mockResolvedValueOnce({
        available: true,
        ok: true,
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch,
        blenderVersion: "5.1.2",
        revision: 3,
        busy: false,
      })
      .mockResolvedValueOnce({
        available: true,
        ok: true,
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch: nextEpoch,
        blenderVersion: "5.1.2",
        revision: 3,
        busy: false,
      });
    vi.mocked(context.session.job)
      .mockResolvedValueOnce({
        contract: BLENDER_LIVE_CONTRACT,
        jobId,
        requestId,
        status: "succeeded",
        revision: 3,
        result: {
          operations: [
            {
              contract: BLENDER_LIVE_CONTRACT,
              sceneEpoch,
              revision: 3,
              mimeType: "model/gltf-binary",
              byteLength: 4,
            },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        contract: BLENDER_LIVE_CONTRACT,
        jobId,
        requestId,
        status: "succeeded",
        revision: 3,
        result: {
          operations: [
            {
              contract: BLENDER_LIVE_CONTRACT,
              sceneEpoch: nextEpoch,
              revision: 3,
              mimeType: "model/gltf-binary",
              byteLength: 4,
            },
          ],
        },
        error: null,
      });
    vi.mocked(context.session.previewGlb)
      .mockResolvedValueOnce({ bytes: Buffer.from("glTF"), sceneEpoch, revision: 3 })
      .mockResolvedValueOnce({ bytes: Buffer.from("glTF"), sceneEpoch: nextEpoch, revision: 3 });

    for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
      await handleBlenderLiveRoute(
        context.request("GET"),
        context.response,
        new URL("http://director.test/api/dcc/blender/preview.glb"),
        context.dependencies,
      );
    }

    expect(context.session.submit).toHaveBeenCalledTimes(2);
    expect(context.session.job).toHaveBeenCalledTimes(2);
    expect(context.session.previewGlb).toHaveBeenCalledTimes(2);
    expect(context.response.writeHead).toHaveBeenLastCalledWith(
      200,
      expect.objectContaining({ "x-blender-scene-epoch": nextEpoch }),
    );
  });

  it("rejects internal GLB export operations on the generic Agent tool route", async () => {
    const context = harness({
      input: {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 3,
        operations: [{ op: "export_scene_preview" }],
      },
      session_id: "agent-a",
    });

    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/tools/blender_native"),
      context.dependencies,
    );

    expect(context.writes.at(-1)).toMatchObject({
      status: 400,
      body: { success: false },
    });
    expect(context.session.submit).not.toHaveBeenCalled();
  });
});
