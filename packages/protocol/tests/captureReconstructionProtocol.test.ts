import { describe, expect, it } from "vitest";
import {
  captureCompareResultSchema,
  captureReconstructionJobInputSchema,
  captureReconstructionPlanSchema,
  captureReconstructionReportSchema,
} from "../src/captureReconstructionProtocol";
import { enqueueProductionJobRequestSchema } from "../src/productionJobProtocol";

const stagedSource = `media-input:sha256:${"a".repeat(64)}`;

describe("captureReconstructionJobInputSchema", () => {
  it("accepts staged capture sources and applies bounded defaults", () => {
    const parsed = captureReconstructionJobInputSchema.parse({
      sourceMediaId: stagedSource,
      sourceKind: "rgbd-bundle",
      fileName: "living-room.zip",
    });
    expect(parsed).toMatchObject({ maxKeyViews: 6, maxObjects: 24, gridResolution: 192, prompt: "" });
  });

  it("rejects unstaged sources and unsafe file names", () => {
    expect(
      captureReconstructionJobInputSchema.safeParse({
        sourceMediaId: "https://example.com/scan.zip",
        sourceKind: "rgbd-bundle",
        fileName: "scan.zip",
      }).success,
    ).toBe(false);
    expect(
      captureReconstructionJobInputSchema.safeParse({
        sourceMediaId: stagedSource,
        sourceKind: "rgb-video",
        fileName: "../escape.mp4",
      }).success,
    ).toBe(false);
  });

  it("is registered as the scene.reconstruct production job kind", () => {
    const enqueue = enqueueProductionJobRequestSchema.parse({
      kind: "scene.reconstruct",
      idempotencyKey: "recon-1",
      input: {
        sourceMediaId: stagedSource,
        sourceKind: "rgb-video",
        fileName: "walkthrough.mp4",
      },
    });
    expect(enqueue.kind).toBe("scene.reconstruct");
  });
});

const report = {
  contract: "director.capture-reconstruction/v1",
  status: "ready",
  sourceKind: "rgbd-bundle",
  providers: { poses: "bundle", depth: "sensor", semantics: "heuristic" },
  warnings: ["Wall extraction assumes a dominant Manhattan frame."],
  metrics: {
    frameCount: 96,
    keyViewCount: 4,
    floorAreaM2: 21.6,
    wallCount: 4,
    objectCount: 2,
    depthCoverage: 0.87,
  },
  floor: {
    polygon: [
      [0, 0],
      [6, 0],
      [6, 3.6],
      [0, 3.6],
    ],
  },
  walls: [
    {
      id: "wall-north",
      start: [0, 0],
      end: [6, 0],
      heightM: 2.6,
      thicknessM: 0.12,
      color: "#c9c2b8",
      openings: [{ id: "door-1", kind: "door", centerM: 1.2, widthM: 0.9, bottomM: 0, heightM: 2.05 }],
    },
  ],
  objects: [
    {
      id: "object-01",
      label: "table-like object",
      position: [2.5, 0, 1.8],
      rotationYDeg: 8,
      size: [1.6, 0.74, 0.8],
      color: "#8a6f52",
      confidence: 0.62,
      support: "floor",
    },
  ],
  keyViews: [
    {
      id: "view-01",
      fileName: "view-01.png",
      position: [3, 1.5, 3.2],
      target: [2.5, 0.8, 1.2],
      fovYDeg: 58,
      width: 640,
      height: 480,
    },
  ],
  mesh: { fileName: "mesh.glb", vertexCount: 5_120, faceCount: 9_800 },
} as const;

describe("captureReconstructionReportSchema", () => {
  it("accepts a metric worker report", () => {
    const parsed = captureReconstructionReportSchema.parse(report);
    expect(parsed.walls[0]?.openings[0]?.kind).toBe("door");
  });

  it("rejects openings wider than the bounded vocabulary", () => {
    expect(
      captureReconstructionReportSchema.safeParse({
        ...report,
        walls: [
          {
            ...report.walls[0],
            openings: [{ id: "door-1", kind: "door", centerM: 1.2, widthM: 12, bottomM: 0, heightM: 2.05 }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps the degraded RGB-only shape honest", () => {
    const degraded = captureReconstructionReportSchema.parse({
      ...report,
      status: "degraded",
      sourceKind: "rgb-video",
      providers: { poses: "none", depth: "none", semantics: "none" },
      floor: null,
      walls: [],
      objects: [],
      mesh: null,
      metrics: { ...report.metrics, floorAreaM2: 0, wallCount: 0, objectCount: 0, depthCoverage: 0 },
    });
    expect(degraded.floor).toBeNull();
  });
});

it("binds plan cameras to keyframe artifacts and stores door interactions", () => {
  const transform = {
    position: [1.2, 0, 0.06] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [0.9, 2.05, 0.06] as [number, number, number],
  };
  const plan = captureReconstructionPlanSchema.parse({
    version: 1,
    id: "capture-plan-1",
    jobId: "canvas-job-1",
    createdAt: "2026-08-14T00:00:00.000Z",
    status: "draft",
    source: { kind: "rgbd-bundle", fileName: "living-room.zip", sha256: "b".repeat(64) },
    analysis: {
      status: "ready",
      providers: report.providers,
      warnings: [],
      metrics: report.metrics,
      prompt: "",
    },
    objects: [
      {
        id: "capture-door-1",
        enabled: true,
        name: "Door leaf",
        role: "door",
        geometryType: "box",
        transform,
        material: {
          baseColor: "#7a5c3e",
          metalness: 0.05,
          roughness: 0.7,
          emissiveColor: "#000000",
          emissiveIntensity: 0,
          opacity: 1,
        },
        interaction: {
          prompt: "开门 / 关门",
          radiusM: 2,
          closedTransform: transform,
          openTransform: { ...transform, rotation: [0, Math.PI / 2, 0] },
        },
        confidence: 0.7,
        rationale: "Door opening detected on wall-north.",
      },
    ],
    cameras: [
      {
        id: "capture-view-camera-01",
        viewId: "view-01",
        name: "Capture view 01",
        position: [3, 1.5, 3.2],
        target: [2.5, 0.8, 1.2],
        fovYDeg: 58,
        width: 640,
        height: 480,
        keyframeArtifactId: "attempt-1-keyview-view-01",
      },
    ],
    shell: null,
  });
  expect(plan.objects[0]?.interaction?.radiusM).toBe(2);
  expect(plan.cameras[0]?.keyframeArtifactId).toBe("attempt-1-keyview-view-01");
});

it("bounds compare scores to the grid vocabulary", () => {
  const result = captureCompareResultSchema.parse({
    viewId: "view-01",
    cameraId: "capture-view-camera-01",
    score: { ssim: 0.42, luminanceSimilarity: 0.8, edgeSimilarity: 0.66, composite: 0.58 },
    grid: { rows: 8, cols: 8, worst: [{ row: 2, col: 5, ssim: -0.1 }] },
    capturedAt: "2026-08-14T00:00:00.000Z",
  });
  expect(result.score.composite).toBeCloseTo(0.58);
  expect(
    captureCompareResultSchema.safeParse({
      ...result,
      grid: { rows: 32, cols: 8, worst: [] },
    }).success,
  ).toBe(false);
});
