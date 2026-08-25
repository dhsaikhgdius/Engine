import { describe, expect, it } from "vitest";
import type { CaptureReconstructionPlan } from "../../../../../../packages/protocol/src/captureReconstructionProtocol";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { applyCaptureReconstructionPlan } from "../../../../src/comprehensive/editor/reconstruction/captureReconstructionApply";

const doorTransform = {
  position: [1.2, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [0.9, 2.05, 0.05] as [number, number, number],
};

const material = {
  baseColor: "#c9c2b8",
  metalness: 0,
  roughness: 0.9,
  emissiveColor: "#000000",
  emissiveIntensity: 0,
  opacity: 1,
};

function plan(): CaptureReconstructionPlan {
  return {
    version: 1,
    id: "capture-plan-test",
    jobId: "canvas-job-test",
    createdAt: "2026-08-14T00:00:00.000Z",
    status: "draft",
    source: { kind: "rgbd-bundle", fileName: "room.zip", sha256: "a".repeat(64) },
    analysis: {
      status: "ready",
      providers: { poses: "bundle", depth: "sensor", semantics: "heuristic" },
      warnings: ["墙体提取假设主导曼哈顿方向；斜墙会被近似。"],
      metrics: { frameCount: 16, keyViewCount: 1, floorAreaM2: 21.6, wallCount: 4, objectCount: 1, depthCoverage: 0.8 },
      prompt: "",
    },
    objects: [
      {
        id: "capture-floor",
        enabled: true,
        name: "地板",
        role: "floor",
        geometryType: "box",
        transform: { position: [3, -0.1, 1.8], rotation: [0, 0, 0], scale: [6, 0.1, 3.6] },
        material,
        confidence: 0.8,
        rationale: "重建地面。",
      },
      {
        id: "capture-wall-01-01",
        enabled: true,
        name: "墙体 1-1",
        role: "wall",
        geometryType: "box",
        transform: { position: [0.375, 0, 0], rotation: [0, 0, 0], scale: [0.75, 2.6, 0.1] },
        material,
        confidence: 0.75,
        rationale: "墙段。",
      },
      {
        id: "capture-door-01",
        enabled: true,
        name: "门 1",
        role: "door",
        geometryType: "box",
        transform: doorTransform,
        material: { ...material, baseColor: "#7a5c3e" },
        interaction: {
          prompt: "开门 / 关门",
          radiusM: 2,
          closedTransform: doorTransform,
          openTransform: { ...doorTransform, position: [0.75, 0, -0.45], rotation: [0, Math.PI / 2, 0] },
        },
        confidence: 0.7,
        rationale: "门洞。",
      },
      {
        id: "capture-item-01",
        enabled: true,
        name: "桌状物体 1",
        role: "item",
        geometryType: "box",
        transform: { position: [2.5, 0, 1.8], rotation: [0, 0.1, 0], scale: [1.6, 0.74, 0.8] },
        material: { ...material, baseColor: "#8a6f52" },
        confidence: 0.6,
        rationale: "占据聚类。",
      },
      {
        id: "capture-item-02",
        enabled: false,
        name: "被排除的物体",
        role: "item",
        geometryType: "box",
        transform: { position: [5, 0, 3], rotation: [0, 0, 0], scale: [0.4, 0.4, 0.4] },
        material,
        confidence: 0.3,
        rationale: "低置信度。",
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
        width: 640,
        height: 480,
        keyframeArtifactId: "attempt-keyview-view-01",
      },
    ],
    shell: { artifactId: "attempt-shell-glb", fileName: "mesh.glb", sizeM: [6, 2.6, 3.6] },
  };
}

describe("applyCaptureReconstructionPlan", () => {
  it("authors enabled objects with exact placement and the door interaction", () => {
    const source = createDefaultDirectorProject();
    const result = applyCaptureReconstructionPlan(source, plan(), { mode: "append", includeCameras: true });

    const byId = new Map(result.project.objects.map((object) => [object.id, object]));
    expect(byId.has("capture-floor")).toBe(true);
    expect(byId.has("capture-wall-01-01")).toBe(true);
    expect(byId.has("capture-item-02")).toBe(false);

    const door = byId.get("capture-door-01")!;
    expect(door.interaction).toMatchObject({ kind: "toggle-transform", prompt: "开门 / 关门", radiusM: 2 });
    expect(door.interaction?.openTransform.rotation[1]).toBeCloseTo(Math.PI / 2, 5);

    // Metric pieces must keep exact transforms: the lintel-style wall pieces
    // and the sunken floor slab may not re-ground.
    const floor = byId.get("capture-floor")!;
    expect(floor.transform.position[1]).toBeCloseTo(-0.1, 5);
    expect(floor.placementMode).toBe("floating");
    expect(byId.get("capture-item-01")?.placementMode).toBe("grounded");
  });

  it("creates capture-view cameras matching the keyframe optics", () => {
    const source = createDefaultDirectorProject();
    const result = applyCaptureReconstructionPlan(source, plan(), { mode: "append", includeCameras: true });
    const camera = result.project.cameras.find((candidate) => candidate.id === "capture-view-camera-01");
    expect(camera).toBeDefined();
    expect(camera?.aspectRatio).toBe("4:3");
    expect(camera?.focalLengthMm).toBeGreaterThan(12);
    expect(result.cameraIds).toEqual(["capture-view-camera-01"]);
    expect(result.plan.status).toBe("applied");
    expect(result.plan.application?.objectIds).toContain("capture-door-01");
  });

  it("replaces non-camera objects in replace mode and links the shell asset", () => {
    const source = createDefaultDirectorProject();
    const withProps = applyCaptureReconstructionPlan(source, plan(), { mode: "append", includeCameras: false });
    const result = applyCaptureReconstructionPlan(withProps.project, plan(), {
      mode: "replace",
      includeCameras: false,
      shellAsset: {
        id: "capture-shell-asset",
        url: "/native-models/x/mesh.glb",
        fileName: "mesh.glb",
        realWorldSizeM: 6,
      },
    });
    const shell = result.project.objects.find((object) => object.id === "capture-plan-test-shell");
    expect(shell?.assetRefId).toBe("capture-shell-asset");
    expect(result.shellObjectId).toBe("capture-plan-test-shell");
    expect(result.project.assets.some((asset) => asset.id === "capture-shell-asset")).toBe(true);
    // replace mode removed the previous append's props before re-adding.
    const wallCount = result.project.objects.filter((object) => object.id === "capture-wall-01-01").length;
    expect(wallCount).toBe(1);
  });

  it("refuses to apply a plan with no enabled objects", () => {
    const source = createDefaultDirectorProject();
    const disabled = { ...plan(), objects: plan().objects.map((object) => ({ ...object, enabled: false })) };
    expect(() => applyCaptureReconstructionPlan(source, disabled, { mode: "append", includeCameras: false })).toThrow(
      "没有启用的物体",
    );
  });
});
