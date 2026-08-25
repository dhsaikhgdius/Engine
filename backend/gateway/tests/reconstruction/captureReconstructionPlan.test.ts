import { describe, expect, it } from "vitest";
import type {
  CaptureReconstructionReport,
  CaptureWall,
} from "../../../../packages/protocol/src/captureReconstructionProtocol";
import { composeCaptureReconstructionPlan, segmentWall } from "../../reconstruction/captureReconstructionPlan";

const baseWall: CaptureWall = {
  id: "wall-north",
  start: [0, 0],
  end: [6, 0],
  heightM: 2.6,
  thicknessM: 0.12,
  color: "#c9c2b8",
  openings: [],
};

function report(overrides: Partial<CaptureReconstructionReport> = {}): CaptureReconstructionReport {
  return {
    contract: "director.capture-reconstruction/v1",
    status: "ready",
    sourceKind: "rgbd-bundle",
    providers: { poses: "bundle", depth: "sensor", semantics: "heuristic" },
    warnings: [],
    metrics: {
      frameCount: 60,
      keyViewCount: 1,
      floorAreaM2: 21.6,
      wallCount: 1,
      objectCount: 1,
      depthCoverage: 0.8,
    },
    floor: {
      polygon: [
        [0, 0],
        [6, 0],
        [6, 3.6],
        [0, 3.6],
      ],
    },
    walls: [baseWall],
    objects: [
      {
        id: "object-01",
        label: "table",
        position: [2.5, 0, 1.8],
        rotationYDeg: 0,
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
    mesh: { fileName: "mesh.glb", vertexCount: 100, faceCount: 200 },
    ...overrides,
  };
}

const options = {
  jobId: "job-1",
  planId: "capture-plan-1",
  createdAt: "2026-08-14T00:00:00.000Z",
  source: { kind: "rgbd-bundle" as const, fileName: "room.zip", sha256: "a".repeat(64) },
  prompt: "",
  keyViewArtifactIds: { "view-01": "attempt-1-keyview-view-01" },
  meshArtifactId: "attempt-1-mesh-glb",
  meshSizeM: [6, 2.6, 3.6] as [number, number, number],
};

describe("segmentWall", () => {
  it("keeps a solid wall as one full-height slab", () => {
    expect(segmentWall(baseWall)).toEqual([{ from: 0, to: 6, bottomM: 0, topM: 2.6 }]);
  });

  it("splits a doorway into passable left, right, and lintel slabs", () => {
    const segments = segmentWall({
      ...baseWall,
      openings: [{ id: "door-1", kind: "door", centerM: 1.2, widthM: 0.9, bottomM: 0, heightM: 2.05 }],
    });
    expect(segments).toEqual([
      { from: 0, to: 0.75, bottomM: 0, topM: 2.6 },
      { from: 0.75, to: 1.65, bottomM: 2.05, topM: 2.6 },
      { from: 1.65, to: 6, bottomM: 0, topM: 2.6 },
    ]);
  });

  it("keeps a window sill and lintel while opening the middle band", () => {
    const segments = segmentWall({
      ...baseWall,
      openings: [{ id: "window-1", kind: "window", centerM: 4, widthM: 1.2, bottomM: 0.9, heightM: 1.2 }],
    });
    expect(segments).toEqual([
      { from: 0, to: 3.4, bottomM: 0, topM: 2.6 },
      { from: 3.4, to: 4.6, bottomM: 2.1, topM: 2.6 },
      { from: 3.4, to: 4.6, bottomM: 0, topM: 0.9 },
      { from: 4.6, to: 6, bottomM: 0, topM: 2.6 },
    ]);
  });

  it("clamps openings that overflow the wall ends", () => {
    const segments = segmentWall({
      ...baseWall,
      openings: [{ id: "door-1", kind: "door", centerM: 0.2, widthM: 1, bottomM: 0, heightM: 2.05 }],
    });
    expect(segments[0]).toEqual({ from: 0, to: 0.7, bottomM: 2.05, topM: 2.6 });
    expect(segments[1]).toEqual({ from: 0.7, to: 6, bottomM: 0, topM: 2.6 });
  });
});

describe("composeCaptureReconstructionPlan", () => {
  it("emits floor, wall segments, a swinging door leaf, items, and bound cameras", () => {
    const wallWithDoor: CaptureWall = {
      ...baseWall,
      openings: [{ id: "door-1", kind: "door", centerM: 1.2, widthM: 0.9, bottomM: 0, heightM: 2.05 }],
    };
    const plan = composeCaptureReconstructionPlan(report({ walls: [wallWithDoor] }), options);

    const roles = plan.objects.map((object) => object.role);
    expect(roles).toContain("floor");
    expect(roles.filter((role) => role === "wall")).toHaveLength(3);
    expect(roles).toContain("door");
    expect(roles).toContain("item");

    const door = plan.objects.find((object) => object.role === "door")!;
    expect(door.interaction).toBeDefined();
    expect(door.transform.position[0]).toBeCloseTo(1.2, 3);
    expect(door.transform.scale[0]).toBeCloseTo(0.9, 3);
    // The hinge sits at the start-side edge (x = 0.75); the open leaf swings
    // 90° so its centre lands half a width along the rotated direction.
    const open = door.interaction!.openTransform;
    expect(open.rotation[1]).toBeCloseTo(Math.PI / 2, 3);
    expect(open.position[0]).toBeCloseTo(0.75, 3);
    expect(open.position[2]).toBeCloseTo(-0.45, 3);

    expect(plan.cameras).toHaveLength(1);
    expect(plan.cameras[0]).toMatchObject({
      viewId: "view-01",
      keyframeArtifactId: "attempt-1-keyview-view-01",
      width: 640,
      height: 480,
    });
    expect(plan.shell).toMatchObject({ artifactId: "attempt-1-mesh-glb", fileName: "mesh.glb" });
  });

  it("puts the floor slab top exactly at y=0", () => {
    const plan = composeCaptureReconstructionPlan(report(), options);
    const floor = plan.objects.find((object) => object.role === "floor")!;
    expect(floor.transform.position[1]).toBeCloseTo(-0.1, 3);
    expect(floor.transform.scale[1]).toBeCloseTo(0.1, 3);
  });

  it("orients rotated walls with the three.js Y-up convention", () => {
    const southToNorth: CaptureWall = { ...baseWall, id: "wall-west", start: [0, 3.6], end: [0, 0] };
    const plan = composeCaptureReconstructionPlan(report({ walls: [southToNorth] }), options);
    const wall = plan.objects.find((object) => object.role === "wall")!;
    // Direction (0, -1) maps to rotY = atan2(1, 0) = +90°.
    expect(wall.transform.rotation[1]).toBeCloseTo(Math.PI / 2, 3);
    expect(wall.transform.position).toEqual([0, 0, 1.8]);
    expect(wall.transform.scale[0]).toBeCloseTo(3.6, 3);
  });

  it("falls back to an honest scaffold for degraded RGB-only reports", () => {
    const plan = composeCaptureReconstructionPlan(
      report({
        status: "degraded",
        sourceKind: "rgb-video",
        providers: { poses: "none", depth: "none", semantics: "none" },
        floor: null,
        walls: [],
        objects: [],
        mesh: null,
        metrics: {
          frameCount: 48,
          keyViewCount: 1,
          floorAreaM2: 0,
          wallCount: 0,
          objectCount: 0,
          depthCoverage: 0,
        },
      }),
      { ...options, meshArtifactId: null },
    );
    expect(plan.analysis.status).toBe("degraded");
    expect(plan.objects).toHaveLength(1);
    expect(plan.objects[0]?.confidence).toBeLessThan(0.2);
    expect(plan.shell).toBeNull();
  });

  it("drops cameras whose keyframe artifact is missing", () => {
    const plan = composeCaptureReconstructionPlan(report(), { ...options, keyViewArtifactIds: {} });
    expect(plan.cameras).toHaveLength(0);
  });
});
