import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLENDER_LIVE_CONTRACT } from "../../../../packages/protocol/src/blenderLiveProtocol";
import { BlenderNativeSessionError, type BlenderNativeSession } from "../../dcc/blenderNativeSession";
import { handleBlenderLiveRoute, type BlenderLiveRouteDependencies } from "../../routes/blenderLiveRoutes";

/**
 * Adversarial stress tests for the Blender live route boundary. Everything
 * runs host-free against a mocked native session: the gateway must convert
 * malformed, oversized, replayed, or unauthorized traffic into explicit 4xx
 * responses with structured codes before Blender sees a single byte.
 */

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
    request: (method: string) => ({ method, headers: {} }) as IncomingMessage,
  };
}

async function postCommands(context: ReturnType<typeof harness>) {
  await handleBlenderLiveRoute(
    context.request("POST"),
    context.response,
    new URL("http://director.test/api/dcc/blender/commands"),
    context.dependencies,
  );
  return context.writes.at(-1);
}

async function postNativeTool(context: ReturnType<typeof harness>) {
  await handleBlenderLiveRoute(
    context.request("POST"),
    context.response,
    new URL("http://director.test/api/tools/blender_native"),
    context.dependencies,
  );
  return context.writes.at(-1);
}

describe("Blender live routes stress: malformed and oversized command batches", () => {
  it.each([[null], ["not-json-object"], [42], [[]]])("rejects the non-object body %j with 400", async (payload) => {
    const context = harness(payload);
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_command_invalid" } });
    expect(context.session.submit).not.toHaveBeenCalled();
  });

  it("rejects an empty operations array", async () => {
    const context = harness({ contract: BLENDER_LIVE_CONTRACT, requestId, operations: [] });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_command_invalid" } });
  });

  it("rejects a batch with more than 128 operations", async () => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      operations: Array.from({ length: 129 }, (_, index) => ({
        op: "create_primitive",
        id: `cube-${index}`,
        primitive: "cube",
      })),
    });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_command_invalid" } });
    expect(context.session.submit).not.toHaveBeenCalled();
  });

  it("rejects an unknown operation name before dispatch", async () => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      operations: [{ op: "format_disk" }],
    });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_command_invalid" } });
  });

  it("rejects an identifier longer than 160 characters", async () => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      operations: [{ op: "delete_object", id: "x".repeat(161) }],
    });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_command_invalid" } });
  });

  it("rejects non-finite transform numbers smuggled as strings or JSON extremes", async () => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      operations: [
        {
          op: "update_transform",
          id: "cube-a",
          position: [1e400, 0, 0],
        },
      ],
    });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_command_invalid" } });
  });
});

describe("Blender live routes stress: kernel policy boundary", () => {
  it.each([
    ["wm.open_mainfile"],
    ["wm.revert_mainfile"],
    ["wm.read_homefile"],
    ["wm.read_factory_settings"],
    ["wm.recover_last_session"],
    ["wm.recover_auto_save"],
    ["wm.quit_blender"],
  ])("denies the session-destroying operator %s with a structured code", async (operator) => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      operations: [{ op: "invoke_operator", operator }],
    });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_operator_denied" } });
    expect(context.session.submit).not.toHaveBeenCalled();
  });

  it("still allows saving the mainfile (never session-destroying)", async () => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      operations: [{ op: "invoke_operator", operator: "wm.save_as_mainfile" }],
    });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 202, body: { success: true } });
  });

  it.each([
    ["add_modifier", { op: "add_modifier", id: "cube-a", modifierName: "Bevel", modifierType: "BEVEL", properties: { filepath: "/etc/passwd" } }],
    ["set_modifier", { op: "set_modifier", id: "cube-a", modifierName: "Bevel", properties: { directory: "../.." } }],
    [
      "create_geometry_node",
      {
        op: "create_geometry_node",
        id: "cube-a",
        nodeRef: "node-a",
        nodeType: "MATH",
        nodeProperties: { filename: "evil.py" },
      },
    ],
  ])("denies path-like typed properties on %s before Blender sees them", async (_name, operation) => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      operations: [operation],
    });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_operator_denied" } });
    expect(String((write?.body as { error?: string }).error)).toMatch(/outside the Director modeling kernel/);
    expect(context.session.submit).not.toHaveBeenCalled();
  });

  it("denies the same typed-property escape through the blender_native apply surface", async () => {
    const context = harness({
      input: {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 3,
        operations: [
          {
            op: "set_modifier",
            id: "cube-a",
            modifierName: "Bevel",
            properties: { filepath: "/etc/shadow" },
          },
        ],
      },
      session_id: "agent-a",
    });
    const write = await postNativeTool(context);
    expect(write).toMatchObject({ status: 400, body: { success: false, code: "blender_operator_denied" } });
    expect(context.session.submit).not.toHaveBeenCalled();
  });

  it("keeps in-range typed modifier properties flowing to Blender", async () => {
    const context = harness({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: sceneEpoch,
      operations: [
        { op: "add_modifier", id: "cube-a", modifierName: "Bevel", modifierType: "BEVEL", properties: { width: 0.1 } },
      ],
    });
    const write = await postCommands(context);
    expect(write).toMatchObject({ status: 202, body: { success: true } });
    expect(context.session.submit).toHaveBeenCalledTimes(1);
  });
});

describe("Blender live routes stress: token invalidation and job lookups", () => {
  it("surfaces live-link token invalidation as a structured 401 instead of retry loops", async () => {
    const context = harness();
    vi.mocked(context.session.liveLink).mockRejectedValue(
      new BlenderNativeSessionError("A valid session bearer token is required", 401, "blender_auth_invalid"),
    );
    await handleBlenderLiveRoute(
      context.request("GET"),
      context.response,
      new URL("http://director.test/api/dcc/blender/live-link"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 401,
      body: { success: false, code: "blender_auth_invalid" },
    });
  });

  it.each([["not-a-uuid"], ["1234"], [`${jobId}0`], ["%2e%2e%2fescape"]])(
    "rejects the malformed job id %s with 400",
    async (candidate) => {
      const context = harness();
      await handleBlenderLiveRoute(
        context.request("GET"),
        context.response,
        new URL(`http://director.test/api/dcc/blender/jobs/${candidate}`),
        context.dependencies,
      );
      expect(context.writes.at(-1)).toMatchObject({
        status: 400,
        body: { success: false, code: "blender_job_invalid" },
      });
      expect(context.session.job).not.toHaveBeenCalled();
    },
  );

  it("rejects non-GET job polling with 405", async () => {
    const context = harness();
    await handleBlenderLiveRoute(
      context.request("POST"),
      context.response,
      new URL(`http://director.test/api/dcc/blender/jobs/${jobId}`),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 405,
      body: { success: false, code: "blender_method_not_allowed" },
    });
  });
});

describe("Blender live routes stress: concurrent live sessions and previews", () => {
  it("serves 16 concurrent live-link cursors independently", async () => {
    const context = harness();
    vi.mocked(context.session.liveLink).mockImplementation(async (cursor) => ({
      kind: "frames",
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      seq: (cursor?.since ?? 0) + 1,
      frames: [],
    }));
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        handleBlenderLiveRoute(
          context.request("GET"),
          context.response,
          new URL(`http://director.test/api/dcc/blender/live-link?epoch=${sceneEpoch}&since=${index}`),
          context.dependencies,
        ),
      ),
    );
    expect(context.session.liveLink).toHaveBeenCalledTimes(16);
    const served = context.writes.map((write) => (write.body as { result: { seq: number } }).result.seq).sort(
      (left, right) => left - right,
    );
    expect(served).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
  });

  it("collapses concurrent preview.glb downloads of the same scene into one export", async () => {
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
    await Promise.all(
      Array.from({ length: 8 }, () =>
        handleBlenderLiveRoute(
          context.request("GET"),
          context.response,
          new URL("http://director.test/api/dcc/blender/preview.glb"),
          context.dependencies,
        ),
      ),
    );
    expect(context.session.submit).toHaveBeenCalledTimes(1);
    expect(context.session.previewGlb).toHaveBeenCalledTimes(1);
    expect(context.response.end).toHaveBeenCalledTimes(8);
  });
});

describe("Blender live routes stress: native model upload boundary", () => {
  async function upload(context: ReturnType<typeof harness>, bytes: Buffer, url: string, contentLength?: string) {
    const request = Readable.from([bytes]) as unknown as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      headers: { "content-length": contentLength ?? String(bytes.byteLength) },
    });
    await handleBlenderLiveRoute(request, context.response, new URL(url), context.dependencies);
    return context.writes.at(-1);
  }

  it("rejects a declared content length beyond the 512 MB ceiling with 413", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-stress-"));
    temporaryRoots.push(assetRoot);
    const context = harness();
    context.dependencies.assetRoot = assetRoot;
    const write = await upload(
      context,
      Buffer.from("tiny"),
      "http://director.test/api/dcc/blender/assets?fileName=big.glb",
      String(513 * 1024 * 1024),
    );
    expect(write).toMatchObject({ status: 413, body: { success: false } });
  });

  it("rejects an empty upload with 400", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-stress-"));
    temporaryRoots.push(assetRoot);
    const context = harness();
    context.dependencies.assetRoot = assetRoot;
    const write = await upload(
      context,
      Buffer.alloc(0),
      "http://director.test/api/dcc/blender/assets?fileName=empty.glb",
      "0",
    );
    expect(write).toMatchObject({ status: 400, body: { success: false } });
  });

  it("rejects an overlong asset id with 400", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-stress-"));
    temporaryRoots.push(assetRoot);
    const context = harness();
    context.dependencies.assetRoot = assetRoot;
    const write = await upload(
      context,
      Buffer.from("model"),
      `http://director.test/api/dcc/blender/assets?fileName=a.glb&assetId=${"x".repeat(121)}`,
    );
    expect(write).toMatchObject({ status: 400, body: { success: false } });
  });

  it("stores a traversal-looking filename inside the asset root, never outside", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-stress-"));
    temporaryRoots.push(assetRoot);
    const context = harness();
    context.dependencies.assetRoot = assetRoot;
    const write = await upload(
      context,
      Buffer.from("model"),
      `http://director.test/api/dcc/blender/assets?fileName=${encodeURIComponent("../../evil.glb")}`,
    );
    expect(write).toMatchObject({ status: 201, body: { success: true, result: { fileName: "evil.glb" } } });
    const url = (write?.body as { result: { url: string } }).result.url;
    const stored = resolve(assetRoot, decodeURIComponent(url.slice(1)));
    const canonicalRoot = await realpath(assetRoot);
    const canonicalStored = await realpath(stored);
    const relativePath = relative(canonicalRoot, canonicalStored);
    expect(relativePath.startsWith("..")).toBe(false);
    expect(isAbsolute(relativePath)).toBe(false);
  });

  it("rejects a splat sequence with more than 900 frames with 413", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-stress-"));
    temporaryRoots.push(assetRoot);
    const zip = new JSZip();
    for (let index = 0; index < 901; index += 1) {
      zip.file(`frames/frame_${String(index).padStart(4, "0")}.spz`, Buffer.from([index % 256]));
    }
    const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    const context = harness();
    context.dependencies.assetRoot = assetRoot;
    const write = await upload(context, bytes, "http://director.test/api/dcc/blender/assets?fileName=flood.zip");
    expect(write).toMatchObject({ status: 413, body: { success: false } });
  }, 30_000);

  it("rejects bytes that are not a readable ZIP with 400", async () => {
    const assetRoot = await mkdtemp(resolve(tmpdir(), "director-native-stress-"));
    temporaryRoots.push(assetRoot);
    const context = harness();
    context.dependencies.assetRoot = assetRoot;
    const write = await upload(
      context,
      Buffer.from("definitely not a zip archive"),
      "http://director.test/api/dcc/blender/assets?fileName=fake.zip",
    );
    expect(write).toMatchObject({
      status: 400,
      body: { success: false, error: "Splat sequence archive is not a readable ZIP file." },
    });
  });
});
