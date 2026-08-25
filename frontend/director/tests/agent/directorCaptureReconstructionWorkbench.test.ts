import { describe, expect, it, vi } from "vitest";
import type { CaptureReconstructionPlan } from "@director/protocol/captureReconstructionProtocol";
import type { ProductionJobRecord } from "@director/protocol/productionJobProtocol";
import type { DirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import type { LuminanceImage } from "../../src/comprehensive/editor/reconstruction/captureCompare";
import { executeDirectorCaptureReconstructionWorkbenchCommand } from "../../src/agent/directorCaptureReconstructionWorkbench";
import { directorReconstructionCommandSchema } from "@director/agent-engine/contract";

const sha256 = "a".repeat(64);

const job: ProductionJobRecord = {
  contractVersion: 1,
  id: "job-1",
  kind: "scene.reconstruct",
  status: "succeeded",
  progress: 1,
  inputFingerprint: "fp-1",
  idempotencyKey: "recon-1",
  input: {
    sourceMediaId: `media-input:sha256:${sha256}`,
    sourceKind: "rgbd-bundle",
    fileName: "room.zip",
    maxKeyViews: 4,
    maxObjects: 8,
    gridResolution: 192,
    prompt: "",
  },
  attempts: [
    {
      id: "job-1-attempt-1",
      number: 1,
      status: "succeeded",
      provider: "director.local",
      inputFingerprint: "fp-1",
      idempotencyKey: "recon-1",
      sourceRevisions: {},
      timestamps: {
        createdAt: "2026-08-14T00:00:00.000Z",
        startedAt: "2026-08-14T00:00:00.000Z",
        finishedAt: "2026-08-14T00:01:00.000Z",
      },
      artifacts: [],
    },
  ],
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:01:00.000Z",
  artifacts: [],
} as ProductionJobRecord;

const doorTransform = {
  position: [1.2, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [0.9, 2.05, 0.05] as [number, number, number],
};

const plan: CaptureReconstructionPlan = {
  version: 1,
  id: "capture-plan-job-1",
  jobId: "job-1",
  createdAt: "2026-08-14T00:01:00.000Z",
  status: "draft",
  source: { kind: "rgbd-bundle", fileName: "room.zip", sha256 },
  analysis: {
    status: "ready",
    providers: { poses: "bundle", depth: "sensor", semantics: "heuristic" },
    warnings: [],
    metrics: { frameCount: 16, keyViewCount: 1, floorAreaM2: 21.6, wallCount: 4, objectCount: 1, depthCoverage: 0.8 },
    prompt: "",
  },
  objects: [
    {
      id: "capture-door-01",
      enabled: true,
      name: "门 1",
      role: "door",
      geometryType: "box",
      transform: doorTransform,
      material: {
        baseColor: "#7a5c3e",
        metalness: 0,
        roughness: 0.7,
        emissiveColor: "#000000",
        emissiveIntensity: 0,
        opacity: 1,
      },
      interaction: {
        prompt: "开门 / 关门",
        radiusM: 2,
        closedTransform: doorTransform,
        openTransform: { ...doorTransform, rotation: [0, Math.PI / 2, 0] },
      },
      confidence: 0.7,
      rationale: "门洞。",
    },
  ],
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
  ],
  shell: { artifactId: "job-1-attempt-1-shell-glb", fileName: "mesh.glb", sizeM: [6, 2.6, 3.6] },
};

function fakeStore(overrides: { cameras?: Array<{ id: string }>; objects?: Array<{ id: string; kind: string }> } = {}) {
  return {
    project: {
      objects: overrides.objects ?? [],
      cameras: overrides.cameras ?? [],
    },
  } as unknown as DirectorStore;
}

function flatLuminance(value: number): LuminanceImage {
  return { width: 8, height: 6, data: new Float32Array(48).fill(value) };
}

function parseCommand(input: unknown) {
  return directorReconstructionCommandSchema.parse(input);
}

describe("executeDirectorCaptureReconstructionWorkbenchCommand", () => {
  it("stages gallery media, detects the capture kind, and submits the durable job", async () => {
    const stageSource = vi.fn().mockResolvedValue({ sourceMediaId: `media-input:sha256:${sha256}`, sha256, bytes: 3 });
    const submitJob = vi.fn().mockResolvedValue(job);
    const execution = await executeDirectorCaptureReconstructionWorkbenchCommand(
      parseCommand({ action: "submit", source_media_id: "gallery-1", idempotency_key: "recon-key" }),
      undefined,
      {
        dependencies: {
          getMediaAsset: () =>
            ({ id: "gallery-1", fileName: "scan.zip", mimeType: "application/zip", kind: "file" }) as never,
          getMediaBlob: async () => new Blob(["zip"], { type: "application/zip" }),
          stageSource,
          submitJob,
        },
      },
    );
    expect(execution.success).toBe(true);
    expect(stageSource).toHaveBeenCalledOnce();
    expect(submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: "rgbd-bundle", fileName: "scan.zip" }),
      "recon-key",
      undefined,
    );
  });

  it("requires an explicit source_kind for pre-staged inputs", async () => {
    const execution = await executeDirectorCaptureReconstructionWorkbenchCommand(
      parseCommand({ action: "submit", source_media_id: `media-input:sha256:${sha256}` }),
      undefined,
      { dependencies: {} },
    );
    expect(execution.success).toBe(false);
    expect(execution.error).toContain("source_kind");
  });

  it("applies the plan through one guarded author batch and reports the loop receipt", async () => {
    const executeWorkbench = vi.fn().mockReturnValue({ success: true, result: { changed: true } });
    const execution = await executeDirectorCaptureReconstructionWorkbenchCommand(
      parseCommand({
        action: "apply",
        job_id: "job-1",
        expected_revision: "rev-1",
        idempotency_key: "apply-key",
      }),
      undefined,
      {
        dependencies: {
          fetchPlan: async () => plan,
          getStore: () => fakeStore(),
          executeWorkbench,
        },
      },
    );
    expect(execution.success).toBe(true);
    const [, operation] = executeWorkbench.mock.calls[0]!;
    expect(operation).toMatchObject({ op: "author", expected_revision: "rev-1", idempotency_key: "apply-key" });
    const result = execution.result as { reconstruction: { object_ids: string[]; camera_ids: string[] } };
    expect(result.reconstruction.object_ids).toEqual(["capture-door-01"]);
    expect(result.reconstruction.camera_ids).toEqual(["capture-view-camera-01"]);
  });

  it("stages the shell mesh as a durable model asset when include_shell is set", async () => {
    const uploadModelAsset = vi.fn().mockResolvedValue({ url: "/native-models/capture-shell-job-1/mesh.glb" });
    const executeWorkbench = vi.fn().mockReturnValue({ success: true, result: {} });
    await executeDirectorCaptureReconstructionWorkbenchCommand(
      parseCommand({
        action: "apply",
        job_id: "job-1",
        include_shell: true,
        expected_revision: "rev-1",
        idempotency_key: "apply-key",
      }),
      undefined,
      {
        dependencies: {
          fetchPlan: async () => plan,
          fetchArtifactBlob: async () => new Blob(["glb"]),
          uploadModelAsset,
          getStore: () => fakeStore(),
          executeWorkbench,
        },
      },
    );
    expect(uploadModelAsset).toHaveBeenCalledWith(expect.any(Blob), "mesh.glb", "capture-shell-job-1");
    const [, operation] = executeWorkbench.mock.calls[0]!;
    const actions = (operation as { actions: Array<{ action: string }> }).actions;
    expect(actions.some((action) => action.action === "upsert_asset")).toBe(true);
  });

  it("compares a stage render against the capture keyframe from the matching camera", async () => {
    const requestCapture = vi.fn().mockResolvedValue("data:image/png;base64,render");
    const execution = await executeDirectorCaptureReconstructionWorkbenchCommand(
      parseCommand({ action: "compare", job_id: "job-1", view_id: "view-01" }),
      undefined,
      {
        dependencies: {
          fetchPlan: async () => plan,
          getStore: () => fakeStore({ cameras: [{ id: "capture-view-camera-01" }] }),
          requestCapture,
          fetchArtifactBlob: async () => new Blob(["png"]),
          decodeImage: async (source) => (typeof source === "string" ? flatLuminance(0.52) : flatLuminance(0.5)),
        },
      },
    );
    expect(execution.success).toBe(true);
    expect(requestCapture).toHaveBeenCalledWith(
      { cameraId: "capture-view-camera-01", frame: 0, width: 160, height: 120 },
      undefined,
    );
    const result = execution.result as { compare: { score: { composite: number }; viewId: string } };
    expect(result.compare.viewId).toBe("view-01");
    expect(result.compare.score.composite).toBeGreaterThan(0.8);
  });

  it("directs the caller to apply cameras before comparing", async () => {
    const execution = await executeDirectorCaptureReconstructionWorkbenchCommand(
      parseCommand({ action: "compare", job_id: "job-1" }),
      undefined,
      {
        dependencies: {
          fetchPlan: async () => plan,
          getStore: () => fakeStore({ cameras: [] }),
        },
      },
    );
    expect(execution.success).toBe(false);
    expect(execution.error).toContain("reconstruction.apply");
  });
});
