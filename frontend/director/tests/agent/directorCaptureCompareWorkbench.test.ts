import { describe, expect, it, vi } from "vitest";
import type { CaptureReconstructionPlan } from "@director/protocol/captureReconstructionProtocol";
import type { DirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import type { LuminanceImage } from "../../src/comprehensive/editor/reconstruction/captureCompare";
import {
  captureCompareHint,
  executeDirectorCaptureCompareWorkbenchCommand,
  resolveCapturePlanCamera,
} from "../../src/agent/directorCaptureCompareWorkbench";
import { directorWorkbenchOperationSchema, type DirectorCompareWorkbenchOperation } from "@director/agent-engine/contract";

const plan: CaptureReconstructionPlan = {
  version: 1,
  id: "capture-plan-job-1",
  jobId: "job-1",
  createdAt: "2026-08-14T00:01:00.000Z",
  status: "draft",
  source: { kind: "rgbd-bundle", fileName: "room.zip", sha256: "a".repeat(64) },
  analysis: {
    status: "ready",
    providers: { poses: "bundle", depth: "sensor", semantics: "heuristic" },
    warnings: [],
    metrics: { frameCount: 16, keyViewCount: 2, floorAreaM2: 21.6, wallCount: 4, objectCount: 1, depthCoverage: 0.8 },
    prompt: "",
  },
  objects: [],
  cameras: [
    {
      id: "capture-view-camera-01",
      viewId: "view-01",
      name: "采集视角 1",
      position: [3, 1.5, 3.2],
      target: [2.5, 0.8, 1.2],
      fovYDeg: 58,
      width: 160,
      height: 120,
      keyframeArtifactId: "job-1-attempt-1-keyview-view-01",
    },
    {
      id: "capture-view-camera-02",
      viewId: "view-02",
      name: "采集视角 2",
      position: [1, 1.5, 3.2],
      target: [0.5, 0.8, 1.2],
      fovYDeg: 58,
      width: 160,
      height: 120,
      keyframeArtifactId: "job-1-attempt-1-keyview-view-02",
    },
  ],
  shell: null,
};

function fakeStore(overrides: { cameras?: Array<{ id: string }>; activeCameraId?: string | null } = {}) {
  return {
    project: {
      objects: [],
      cameras: overrides.cameras ?? [],
      activeCameraId: overrides.activeCameraId ?? null,
    },
  } as unknown as DirectorStore;
}

function flatLuminance(value: number, width = 16, height = 16): LuminanceImage {
  return { width, height, data: new Float32Array(width * height).fill(value) };
}

// Flat 0.5 image with a bright top-left quadrant — the mismatch region when
// compared against a uniform flat reference.
function quadrantLuminance(): LuminanceImage {
  const width = 16;
  const height = 16;
  const data = new Float32Array(width * height).fill(0.5);
  for (let row = 0; row < height / 2; row += 1) {
    for (let col = 0; col < width / 2; col += 1) data[row * width + col] = 1;
  }
  return { width, height, data };
}

function parseCompare(input: unknown): DirectorCompareWorkbenchOperation {
  const parsed = directorWorkbenchOperationSchema.parse(input);
  if (parsed.op !== "compare") throw new Error("expected a compare operation");
  return parsed;
}

describe("executeDirectorCaptureCompareWorkbenchCommand", () => {
  it("scores a Gallery still against the default stage render through the active camera", async () => {
    const requestCapture = vi.fn().mockResolvedValue("data:image/png;base64,render");
    const execution = await executeDirectorCaptureCompareWorkbenchCommand(
      parseCompare({ op: "compare", reference: { kind: "media", media_id: "gallery-still-1" } }),
      undefined,
      {
        dependencies: {
          getStore: () => fakeStore({ cameras: [{ id: "cam-main" }], activeCameraId: "cam-main" }),
          getMediaAsset: () =>
            ({ id: "gallery-still-1", fileName: "ref.png", mimeType: "image/png", kind: "image" }) as never,
          getMediaBlob: async () => new Blob(["png"], { type: "image/png" }),
          requestCapture,
          decodeImage: async (source) => (typeof source === "string" ? flatLuminance(0.52) : flatLuminance(0.5)),
          now: () => "2026-08-25T00:00:00.000Z",
        },
      },
    );
    expect(execution.success).toBe(true);
    expect(requestCapture).toHaveBeenCalledWith({ cameraId: "cam-main", frame: 0, width: 640, height: 360 }, undefined);
    const result = execution.result as {
      compare: {
        reference: { kind: string; media_id: string };
        candidate: { kind: string; camera_id: string };
        score: { composite: number };
        grid: { rows: number; cols: number; worst: Array<{ region: { x0: number } }> };
        captured_at: string;
      };
      hint: string;
    };
    expect(result.compare.reference).toMatchObject({ kind: "media", media_id: "gallery-still-1" });
    expect(result.compare.candidate).toMatchObject({ kind: "stage", camera_id: "cam-main" });
    expect(result.compare.score.composite).toBeGreaterThan(0.8);
    expect(result.compare.grid).toMatchObject({ rows: 8, cols: 8 });
    expect(result.compare.captured_at).toBe("2026-08-25T00:00:00.000Z");
    expect(result.hint).toContain("strong");
  });

  it("locates the mismatch in normalized worst-cell regions for a fix-locally loop", async () => {
    const execution = await executeDirectorCaptureCompareWorkbenchCommand(
      parseCompare({
        op: "compare",
        reference: { kind: "media", media_id: "ref-still" },
        candidate: { kind: "media", media_id: "cand-still" },
        grid: { rows: 4, cols: 4 },
      }),
      undefined,
      {
        dependencies: {
          getMediaAsset: (id) => ({ id, fileName: `${id}.png`, mimeType: "image/png", kind: "image" }) as never,
          getMediaBlob: async (id) => new Blob([id], { type: "image/png" }),
          decodeImage: async (source) =>
            source instanceof Blob && (await source.text()) === "ref-still" ? flatLuminance(0.5) : quadrantLuminance(),
        },
      },
    );
    expect(execution.success).toBe(true);
    const result = execution.result as {
      compare: {
        grid: { rows: number; cols: number; worst: Array<{ row: number; col: number; region: Record<string, number> }> };
      };
      hint: string;
    };
    expect(result.compare.grid).toMatchObject({ rows: 4, cols: 4 });
    const worst = result.compare.grid.worst[0]!;
    // The bright quadrant is the top-left quarter of the frame; the weakest
    // cell must start inside that half on both axes (resampling smears the
    // exact quadrant boundary into the adjacent cell edge).
    expect(worst.region.x0).toBeLessThanOrEqual(0.5);
    expect(worst.region.y0).toBeLessThanOrEqual(0.5);
    expect(worst.region.x0).toBe(worst.col / 4);
    expect(worst.region.y0).toBe(worst.row / 4);
    expect(worst.region.x1).toBe((worst.col + 1) / 4);
    expect(worst.region.y1).toBe((worst.row + 1) / 4);
    expect(result.hint).toContain("grid.worst");
  });

  it("resolves a reconstruction keyframe endpoint through the plan cameras", async () => {
    const fetchArtifactBlob = vi.fn().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const execution = await executeDirectorCaptureCompareWorkbenchCommand(
      parseCompare({
        op: "compare",
        reference: { kind: "reconstruction_keyframe", job_id: "job-1", view_id: "view-02" },
        candidate: { kind: "media", media_id: "cand-still" },
      }),
      undefined,
      {
        dependencies: {
          fetchPlan: async () => plan,
          fetchArtifactBlob,
          getMediaAsset: (id) => ({ id, fileName: `${id}.png`, mimeType: "image/png", kind: "image" }) as never,
          getMediaBlob: async () => new Blob(["png"], { type: "image/png" }),
          decodeImage: async () => flatLuminance(0.5),
        },
      },
    );
    expect(execution.success).toBe(true);
    expect(fetchArtifactBlob).toHaveBeenCalledWith("job-1", "job-1-attempt-1-keyview-view-02", undefined);
    const result = execution.result as { compare: { reference: Record<string, unknown> } };
    expect(result.compare.reference).toMatchObject({
      kind: "reconstruction_keyframe",
      job_id: "job-1",
      view_id: "view-02",
      camera_id: "capture-view-camera-02",
    });
  });

  it("requires a camera for stage endpoints and reports missing cameras precisely", async () => {
    const noActiveCamera = await executeDirectorCaptureCompareWorkbenchCommand(
      parseCompare({ op: "compare", reference: { kind: "stage" } }),
      undefined,
      { dependencies: { getStore: () => fakeStore() } },
    );
    expect(noActiveCamera.success).toBe(false);
    expect(noActiveCamera.error).toContain("camera_id");

    const unknownCamera = await executeDirectorCaptureCompareWorkbenchCommand(
      parseCompare({ op: "compare", reference: { kind: "stage", camera_id: "cam-missing" } }),
      undefined,
      { dependencies: { getStore: () => fakeStore({ cameras: [{ id: "cam-main" }] }) } },
    );
    expect(unknownCamera.success).toBe(false);
    expect(unknownCamera.error).toContain("cam-missing");
  });

  it("rejects non-image media endpoints and unavailable captures", async () => {
    const video = await executeDirectorCaptureCompareWorkbenchCommand(
      parseCompare({ op: "compare", reference: { kind: "media", media_id: "gallery-video-1" } }),
      undefined,
      {
        dependencies: {
          getMediaAsset: () =>
            ({ id: "gallery-video-1", fileName: "clip.mp4", mimeType: "video/mp4", kind: "video" }) as never,
        },
      },
    );
    expect(video.success).toBe(false);
    expect(video.error).toContain("still image");

    const captureFailed = await executeDirectorCaptureCompareWorkbenchCommand(
      parseCompare({
        op: "compare",
        reference: { kind: "media", media_id: "ref-still" },
        candidate: { kind: "stage", camera_id: "cam-main" },
      }),
      undefined,
      {
        dependencies: {
          getStore: () => fakeStore({ cameras: [{ id: "cam-main" }] }),
          getMediaAsset: (id) => ({ id, fileName: `${id}.png`, mimeType: "image/png", kind: "image" }) as never,
          getMediaBlob: async () => new Blob(["png"], { type: "image/png" }),
          decodeImage: async () => flatLuminance(0.5),
          requestCapture: async () => null,
        },
      },
    );
    expect(captureFailed.success).toBe(false);
    expect(captureFailed.error).toContain("Stage capture failed");
  });

  it("surfaces cancellation as a cancelled code", async () => {
    const controller = new AbortController();
    controller.abort();
    const execution = await executeDirectorCaptureCompareWorkbenchCommand(
      parseCompare({ op: "compare", reference: { kind: "media", media_id: "ref-still" } }),
      controller.signal,
      { dependencies: {} },
    );
    expect(execution.success).toBe(false);
    expect(execution.result).toMatchObject({ code: "cancelled" });
  });
});

describe("capture compare helpers", () => {
  it("resolves plan cameras by camera id first, then view id, then the first camera", () => {
    expect(resolveCapturePlanCamera(plan, { cameraId: "capture-view-camera-02" })?.viewId).toBe("view-02");
    expect(resolveCapturePlanCamera(plan, { viewId: "view-01" })?.id).toBe("capture-view-camera-01");
    expect(resolveCapturePlanCamera(plan, {})?.id).toBe("capture-view-camera-01");
    expect(resolveCapturePlanCamera({ ...plan, cameras: [] }, {})).toBeNull();
  });

  it("labels strong and weak matches for the shared hint", () => {
    const strong = captureCompareHint(
      { ssim: 0.9, luminanceSimilarity: 0.9, edgeSimilarity: 0.9, composite: 0.9 },
      "the capture keyframe",
    );
    expect(strong).toContain("the capture keyframe");
    expect(strong).toContain("strong");
    const weak = captureCompareHint({ ssim: 0.1, luminanceSimilarity: 0.2, edgeSimilarity: 0.2, composite: 0.3 });
    expect(weak).toContain("grid.worst");
  });
});
