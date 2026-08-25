import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shotSpecSchema, type ShotSpec } from "../../../../packages/protocol/src/filmPipelineProtocol";
import { StageAnchorResolver, filmStageAnchorRaster } from "../../film/filmStageAnchors";

/** 1x1 transparent PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

function filmShot(idx: number): ShotSpec {
  return shotSpecSchema.parse({
    idx,
    camIdx: idx,
    visualDesc: `镜头 ${idx} 视觉描述`,
    variationType: "small",
    ffDesc: `镜头 ${idx} 首帧描述`,
    motionDesc: `镜头 ${idx} 运动描述`,
  });
}

type StoryboardWireShot = { id: string; title: string; camera_id: string | null };

/** Mirrors the observe result shape produced by directorWorkbenchExecutor observe(). */
function observeResponse(shots: StoryboardWireShot[], cameraIds: string[], storyboardPresent = true) {
  return {
    success: true,
    result: {
      active_camera_id: cameraIds[0] ?? null,
      requested_fields: ["storyboard", "cameras"],
      storyboard: storyboardPresent ? { title: "白膜分镜", shot_count: shots.length, shots } : null,
      cameras: cameraIds.map((id) => ({ id, name: id, focal_length_mm: 35 })),
    },
  };
}

/** Mirrors inspect(entity=storyboard_shot): result is { entity, value: <raw storyboard shot> }. */
function inspectResponse(shotId: string, cameraId: string | null, frameStart: number) {
  return {
    success: true,
    result: {
      entity: "storyboard_shot",
      value: {
        id: shotId,
        title: shotId,
        cameraId,
        frameStart,
        frameEnd: frameStart + 48,
        shotSize: "wide",
        movement: "static",
        action: "",
      },
    },
  };
}

/** Gateway HTTP StageGatewayExecution shape: image under capture.{mimeType,data}. */
function captureRecordResponse() {
  return {
    success: true,
    result: { label: "Camera capture", meta: { renderPass: "clean" }, project_revision: "rev-1" },
    capture: { mimeType: "image/png", data: PNG_BASE64 },
  };
}

/** Browser wire shape: image as captureDataUrl data URL. */
function captureDataUrlResponse() {
  return {
    success: true,
    result: { label: "Camera capture", meta: { renderPass: "clean" } },
    captureDataUrl: `data:image/png;base64,${PNG_BASE64}`,
  };
}

type Responder = (input: Record<string, unknown>) => unknown;

function scriptedExecute(handlers: { observe?: Responder; inspect?: Responder; capture?: Responder }) {
  return vi.fn(async (input: Record<string, unknown>) => {
    const handler = handlers[input.op as keyof typeof handlers];
    if (!handler) throw new Error(`unexpected workbench op: ${String(input.op)}`);
    return handler(input);
  });
}

describe("StageAnchorResolver", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("selects an offscreen clay raster that matches the film aspect", () => {
    expect(filmStageAnchorRaster()).toEqual({ width: 1280, height: 720 });
    expect(filmStageAnchorRaster("16:9")).toEqual({ width: 1280, height: 720 });
    expect(filmStageAnchorRaster("9:16")).toEqual({ width: 720, height: 1280 });
    expect(filmStageAnchorRaster("2.39:1")).toEqual({ width: 1280, height: 536 });
    expect(filmStageAnchorRaster("1:1")).toEqual({ width: 1024, height: 1024 });
    expect(filmStageAnchorRaster("unknown")).toEqual({ width: 1280, height: 720 });
  });

  async function createRunDirectory() {
    const dir = await mkdtemp(join(tmpdir(), "director-film-anchors-"));
    tempDirs.push(dir);
    return dir;
  }

  function createResolver() {
    const events: { stage: string; message: string }[] = [];
    const resolver = new StageAnchorResolver({ onEvent: (stage, message) => events.push({ stage, message }) });
    return { resolver, events };
  }

  it("captures storyboard-aligned shots and writes PNG anchors", async () => {
    const runDirectory = await createRunDirectory();
    const storyboard: StoryboardWireShot[] = [
      { id: "sb-0", title: "开场全景", camera_id: "camera-a" },
      { id: "sb-1", title: "反打近景", camera_id: "camera-b" },
    ];
    const frames: Record<string, number> = { "sb-0": 12, "sb-1": 36.4 };
    const execute = scriptedExecute({
      observe: () => observeResponse(storyboard, ["camera-a", "camera-b"]),
      inspect: (input) => {
        const id = input.id as string;
        return inspectResponse(id, id === "sb-0" ? "camera-a" : "camera-b", frames[id]);
      },
      // Cover both real image shapes: gateway capture record and browser data URL.
      capture: (input) => (input.camera_id === "camera-a" ? captureRecordResponse() : captureDataUrlResponse()),
    });
    const { resolver, events } = createResolver();

    const references = await resolver.resolveSceneAnchors({
      execute,
      runDirectory,
      sceneIdx: 2,
      // Third film shot has no storyboard counterpart and must be ignored.
      shots: [filmShot(0), filmShot(1), filmShot(2)],
    });

    const sceneDirectory = join(runDirectory, "stage_anchors", "scene_2");
    expect(references).toEqual([
      {
        sceneIdx: 2,
        shotIdx: 0,
        imagePath: join(sceneDirectory, "shot_0.png"),
        note: expect.stringContaining("white-box stage capture"),
      },
      {
        sceneIdx: 2,
        shotIdx: 1,
        imagePath: join(sceneDirectory, "shot_1.png"),
        note: expect.stringContaining("authoritative"),
      },
    ]);
    expect(await readFile(join(sceneDirectory, "shot_0.png"))).toEqual(PNG_BYTES);
    expect(await readFile(join(sceneDirectory, "shot_1.png"))).toEqual(PNG_BYTES);

    expect(execute.mock.calls.map(([input]) => input.op)).toEqual([
      "observe",
      "inspect",
      "capture",
      "inspect",
      "capture",
    ]);
    expect(execute.mock.calls[0][0]).toEqual({ op: "observe", fields: ["storyboard", "cameras"] });
    expect(execute.mock.calls[1][0]).toEqual({ op: "inspect", entity: "storyboard_shot", id: "sb-0" });
    expect(execute.mock.calls[2][0]).toEqual({
      op: "capture",
      camera_id: "camera-a",
      frame: 12,
      render_pass: "clay",
      clean_plate: true,
      depth_of_field: false,
      width: 1280,
      height: 720,
    });
    // Fractional frameStart is rounded to a valid integer capture frame.
    expect(execute.mock.calls[4][0]).toMatchObject({
      op: "capture",
      camera_id: "camera-b",
      frame: 36,
      render_pass: "clay",
      width: 1280,
      height: 720,
    });
    expect(events.every((event) => event.stage === "stage_anchors")).toBe(true);
    expect(events.some((event) => event.message.includes("Resolved 2/2"))).toBe(true);
  });

  it("captures a portrait clay raster for 9:16 runs", async () => {
    const runDirectory = await createRunDirectory();
    const execute = scriptedExecute({
      observe: () => observeResponse([{ id: "sb-0", title: "竖屏", camera_id: "camera-a" }], ["camera-a"]),
      inspect: () => inspectResponse("sb-0", "camera-a", 0),
      capture: () => captureRecordResponse(),
    });
    const { resolver } = createResolver();

    await resolver.resolveSceneAnchors({
      execute,
      runDirectory,
      sceneIdx: 0,
      shots: [filmShot(0)],
      aspectRatio: "9:16",
    });

    expect(execute.mock.calls.find(([input]) => input.op === "capture")?.[0]).toMatchObject({
      op: "capture",
      render_pass: "clay",
      depth_of_field: false,
      width: 720,
      height: 1280,
    });
  });

  it("reuses an existing PNG without re-capturing", async () => {
    const runDirectory = await createRunDirectory();
    const sceneDirectory = join(runDirectory, "stage_anchors", "scene_0");
    const existingBytes = Buffer.from("pre-seeded anchor bytes");
    await mkdir(sceneDirectory, { recursive: true });
    await writeFile(join(sceneDirectory, "shot_0.png"), existingBytes);

    const execute = scriptedExecute({
      observe: () => observeResponse([{ id: "sb-0", title: "开场", camera_id: "camera-a" }], ["camera-a"]),
    });
    const { resolver, events } = createResolver();

    const references = await resolver.resolveSceneAnchors({
      execute,
      runDirectory,
      sceneIdx: 0,
      shots: [filmShot(0)],
    });

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ sceneIdx: 0, shotIdx: 0, imagePath: join(sceneDirectory, "shot_0.png") });
    // Only observe ran; neither inspect nor capture was sent for the reused shot.
    expect(execute.mock.calls.map(([input]) => input.op)).toEqual(["observe"]);
    expect(await readFile(join(sceneDirectory, "shot_0.png"))).toEqual(existingBytes);
    expect(events.some((event) => event.message.includes("reusing existing stage anchor"))).toBe(true);
  });

  it("degrades to partial results when captures fail", async () => {
    const runDirectory = await createRunDirectory();
    const storyboard: StoryboardWireShot[] = [
      { id: "sb-0", title: "失败镜头", camera_id: "camera-a" },
      { id: "sb-1", title: "异常镜头", camera_id: "camera-b" },
      { id: "sb-2", title: "成功镜头", camera_id: "camera-c" },
    ];
    const execute = scriptedExecute({
      observe: () => observeResponse(storyboard, ["camera-a", "camera-b", "camera-c"]),
      inspect: (input) => inspectResponse(input.id as string, null, 0),
      capture: (input) => {
        if (input.camera_id === "camera-a") {
          return { success: false, error: "viewport capture is not ready" };
        }
        if (input.camera_id === "camera-b") throw new Error("workbench connection dropped");
        return captureRecordResponse();
      },
    });
    const { resolver, events } = createResolver();

    const references = await resolver.resolveSceneAnchors({
      execute,
      runDirectory,
      sceneIdx: 1,
      shots: [filmShot(0), filmShot(1), filmShot(2)],
    });

    expect(references).toEqual([
      expect.objectContaining({
        sceneIdx: 1,
        shotIdx: 2,
        imagePath: join(runDirectory, "stage_anchors", "scene_1", "shot_2.png"),
      }),
    ]);
    expect(await readFile(join(runDirectory, "stage_anchors", "scene_1", "shot_2.png"))).toEqual(PNG_BYTES);
    expect(events.some((event) => event.message.includes("viewport capture is not ready"))).toBe(true);
    expect(events.some((event) => event.message.includes("workbench connection dropped"))).toBe(true);
    expect(events.some((event) => event.message.includes("Resolved 1/3"))).toBe(true);
  });

  it("returns an empty array when the project has no storyboard", async () => {
    const runDirectory = await createRunDirectory();
    const execute = scriptedExecute({ observe: () => observeResponse([], [], false) });
    const { resolver, events } = createResolver();

    const references = await resolver.resolveSceneAnchors({
      execute,
      runDirectory,
      sceneIdx: 0,
      shots: [filmShot(0)],
    });

    expect(references).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.message.includes("no storyboard shots"))).toBe(true);
  });

  it("returns an empty array when observe itself fails", async () => {
    const runDirectory = await createRunDirectory();
    const execute = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const { resolver, events } = createResolver();

    const references = await resolver.resolveSceneAnchors({
      execute,
      runDirectory,
      sceneIdx: 0,
      shots: [filmShot(0)],
    });

    expect(references).toEqual([]);
    expect(events.some((event) => event.message.includes("gateway unavailable"))).toBe(true);
  });

  it("skips storyboard shots without a usable camera binding", async () => {
    const runDirectory = await createRunDirectory();
    const storyboard: StoryboardWireShot[] = [
      { id: "sb-0", title: "未绑定相机", camera_id: null },
      { id: "sb-1", title: "相机已删除", camera_id: "ghost-camera" },
      { id: "sb-2", title: "正常镜头", camera_id: "camera-c" },
    ];
    const execute = scriptedExecute({
      observe: () => observeResponse(storyboard, ["camera-c"]),
      inspect: (input) => inspectResponse(input.id as string, "camera-c", 24),
      capture: () => captureDataUrlResponse(),
    });
    const { resolver, events } = createResolver();

    // Non-contiguous film idx values prove shotIdx and the file name come from the film spec.
    const references = await resolver.resolveSceneAnchors({
      execute,
      runDirectory,
      sceneIdx: 3,
      shots: [filmShot(10), filmShot(11), filmShot(12)],
    });

    expect(references).toEqual([
      expect.objectContaining({
        sceneIdx: 3,
        shotIdx: 12,
        imagePath: join(runDirectory, "stage_anchors", "scene_3", "shot_12.png"),
      }),
    ]);
    expect(execute.mock.calls.map(([input]) => input.op)).toEqual(["observe", "inspect", "capture"]);
    expect(execute.mock.calls[2][0]).toMatchObject({ op: "capture", camera_id: "camera-c", frame: 24 });
    expect(events.some((event) => event.message.includes("no camera binding"))).toBe(true);
    expect(events.some((event) => event.message.includes('"ghost-camera"'))).toBe(true);
  });

  it("reads results from the MCP tool response shape", async () => {
    const runDirectory = await createRunDirectory();
    const mcpWrap = (result: unknown, image?: string) => {
      const structured = { ok: true, code: null, result, error: null };
      return {
        content: [
          { type: "text", text: JSON.stringify(structured) },
          ...(image
            ? [{ type: "image", data: image, mimeType: "image/png", annotations: { audience: ["assistant"] } }]
            : []),
        ],
        structuredContent: structured,
        isError: false,
      };
    };
    const execute = scriptedExecute({
      observe: () =>
        mcpWrap(observeResponse([{ id: "sb-0", title: "MCP", camera_id: "camera-a" }], ["camera-a"]).result),
      inspect: (input) => mcpWrap(inspectResponse(input.id as string, "camera-a", 0).result),
      capture: () => mcpWrap({ label: "Camera capture", meta: {} }, PNG_BASE64),
    });
    const { resolver } = createResolver();

    const references = await resolver.resolveSceneAnchors({
      execute,
      runDirectory,
      sceneIdx: 0,
      shots: [filmShot(0)],
    });

    expect(references).toHaveLength(1);
    expect(await readFile(join(runDirectory, "stage_anchors", "scene_0", "shot_0.png"))).toEqual(PNG_BYTES);
  });

  it("rethrows when the abort signal fires", async () => {
    const runDirectory = await createRunDirectory();
    const controller = new AbortController();
    controller.abort();
    const execute = scriptedExecute({});
    const { resolver } = createResolver();

    await expect(
      resolver.resolveSceneAnchors({
        execute,
        runDirectory,
        sceneIdx: 0,
        shots: [filmShot(0)],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
