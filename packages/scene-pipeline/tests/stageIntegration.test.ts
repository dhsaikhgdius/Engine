// Stage integration tests — verify AssemblyPlan → workbench operations conversion

import { describe, it, expect } from "vitest";
import { applySceneToStage, executeScenePlan, summarizeWorkbenchOperations } from "../src/stageIntegration";
import { assembleScene } from "../src/assembler";
import type { SceneLayout, AssemblyPlan, StageOperation } from "../src/types";

function makeTestLayout(): SceneLayout {
  return {
    version: 1,
    name: "测试场景",
    description: "一个简单的测试场景",
    room: { width: 6, depth: 5, height: 3 },
    objects: [
      {
        id: "floor",
        label: "地板",
        kind: "floor",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 6, y: 0.1, z: 5 },
        color: "#d4a574",
      },
      {
        id: "sofa",
        label: "沙发",
        kind: "furniture",
        position: { x: 0, y: 0.5, z: -1.5 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 2.2, y: 0.9, z: 0.9 },
        color: "#5c6b73",
      },
      {
        id: "table",
        label: "茶几",
        kind: "furniture",
        position: { x: 0, y: 0.4, z: -0.5 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1.2, y: 0.4, z: 0.7 },
        color: "#8b7355",
      },
      {
        id: "lamp",
        label: "落地灯",
        kind: "light",
        position: { x: 2, y: 0, z: -1 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 0.3, y: 1.5, z: 0.3 },
        color: "#f5f0e8",
      },
    ],
    cameras: [
      {
        position: { x: 0, y: 1.6, z: 3 },
        target: { x: 0, y: 1, z: 0 },
        focalLengthMm: 35,
        label: "主视角",
      },
    ],
    lights: [
      { type: "ambient", color: "#fff8e7", intensity: 0.3 },
      { type: "directional", color: "#ffffff", intensity: 0.8, direction: { x: 0, y: -1, z: 0.5 } },
    ],
  };
}

describe("applySceneToStage", () => {
  it("converts a full assembly plan to workbench operations", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);

    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((op) => op.op === "author")).toBe(true);
  });

  it("maps objects to add_object actions with correct fields", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);

    // Find the object batch (first operation should be objects)
    const objectOp = operations[0];
    const addObjectActions = objectOp.actions.filter((a) => a.action === "add_object");

    expect(addObjectActions.length).toBe(4); // floor, sofa, table, lamp

    // Check floor object
    const floor = addObjectActions.find((a) => a.id === "floor");
    expect(floor).toBeDefined();
    expect(floor!.name).toBe("地板");
    expect(floor!.kind).toBe("scene"); // floor maps to scene
    expect(floor!.geometry_type).toBe("box"); // floor maps to box
    expect(floor!.color).toBe("#d4a574");
    expect(floor!.transform).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [6, 0.1, 5],
    });
  });

  it("maps furniture to prop kind with box geometry", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);

    const objectOp = operations[0];
    const sofa = objectOp.actions.find((a) => a.id === "sofa");

    expect(sofa).toBeDefined();
    expect(sofa!.kind).toBe("prop");
    expect(sofa!.geometry_type).toBe("box");
  });

  it("maps light objects to cylinder geometry", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);

    const objectOp = operations[0];
    const lamp = objectOp.actions.find((a) => a.id === "lamp");

    expect(lamp).toBeDefined();
    expect(lamp!.geometry_type).toBe("cylinder");
  });

  it("maps cameras to add_camera actions", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);

    // Find the camera operation (separate batch from objects)
    const cameraOps = operations.filter((op) =>
      op.actions.some((a) => a.action === "add_camera"),
    );

    expect(cameraOps.length).toBe(1);
    const cameraAction = cameraOps[0].actions[0];
    expect(cameraAction.action).toBe("add_camera");
    expect(cameraAction.name).toBe("主视角");
    expect(cameraAction.position).toEqual([0, 1.6, 3]);
    expect(cameraAction.target).toEqual([0, 1, 0]);
    expect(cameraAction.focal_length_mm).toBe(35);
  });

  it("maps lights to add_light actions with correct type", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);

    // Find the light operation
    const lightOps = operations.filter((op) =>
      op.actions.some((a) => a.action === "add_light"),
    );

    expect(lightOps.length).toBe(1);
    const lightActions = lightOps[0].actions;
    expect(lightActions.length).toBe(2); // ambient + directional

    const ambient = lightActions.find((a) =>
      (a.light as { type: string }).type === "ambient",
    );
    expect(ambient).toBeDefined();
    expect((ambient!.light as { color: string }).color).toBe("#fff8e7");
    expect((ambient!.light as { intensity: number }).intensity).toBe(0.3);

    const directional = lightActions.find((a) =>
      (a.light as { type: string }).type === "directional",
    );
    expect(directional).toBeDefined();
    expect((directional!.light as { color: string }).color).toBe("#ffffff");
    expect((directional!.light as { target: number[] }).target).toEqual([0, -1, 0.5]);
  });

  it("separates objects, cameras, and lights into different batches", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);

    // Should have at least 3 batches: objects, cameras, lights
    expect(operations.length).toBeGreaterThanOrEqual(3);

    // First batch should be all object actions
    const firstBatch = operations[0];
    expect(firstBatch.actions.every((a) =>
      a.action === "add_object" || a.action === "update_object" || a.action === "delete_objects",
    )).toBe(true);

    // Second batch should be cameras
    const cameraBatch = operations.find((op) =>
      op.actions.some((a) => a.action === "add_camera"),
    );
    expect(cameraBatch).toBeDefined();
    expect(cameraBatch!.actions.every((a) => a.action === "add_camera")).toBe(true);

    // Third batch should be lights
    const lightBatch = operations.find((op) =>
      op.actions.some((a) => a.action === "add_light"),
    );
    expect(lightBatch).toBeDefined();
    expect(lightBatch!.actions.every((a) => a.action === "add_light")).toBe(true);
  });

  it("handles empty plan", () => {
    const plan: AssemblyPlan = { operations: [] };
    const operations = applySceneToStage(plan);
    expect(operations).toEqual([]);
  });

  it("rounds positions to 3 decimal places", () => {
    const layout: SceneLayout = {
      version: 1,
      name: "test",
      room: { width: 1, depth: 1, height: 1 },
      objects: [{
        id: "obj",
        label: "Object",
        kind: "furniture",
        position: { x: 1.23456789, y: 2.999999, z: 3.000001 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      }],
      cameras: [],
      lights: [],
    };
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);

    const action = operations[0].actions[0];
    expect((action.transform as { position: number[] }).position).toEqual([1.235, 3, 3]);
  });
});

describe("executeScenePlan", () => {
  it("executes all operations and returns results", async () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);

    const mockExecutor = async () => ({ ok: true });
    const result = await executeScenePlan(plan, mockExecutor);

    expect(result.successCount).toBeGreaterThan(0);
    expect(result.failureCount).toBe(0);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("handles executor errors gracefully", async () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);

    const failingExecutor = async () => {
      throw new Error("Workbench unavailable");
    };
    const result = await executeScenePlan(plan, failingExecutor);

    expect(result.failureCount).toBeGreaterThan(0);
    expect(result.successCount).toBe(0);
    expect(result.results[0].error).toBe("Workbench unavailable");
  });

  it("handles mixed success and failure", async () => {
    const plan: AssemblyPlan = {
      operations: [
        { op: "addObject", object: {
          id: "a", label: "A", kind: "furniture",
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
        }},
      ],
    };

    let callCount = 0;
    const mockExecutor = async () => {
      callCount++;
      if (callCount === 1) throw new Error("First call fails");
      return { ok: true };
    };

    const result = await executeScenePlan(plan, mockExecutor);
    expect(result.failureCount).toBe(1);
  });
});

describe("summarizeWorkbenchOperations", () => {
  it("produces a Chinese summary of operations", () => {
    const layout = makeTestLayout();
    const plan = assembleScene(layout);
    const operations = applySceneToStage(plan);
    const summary = summarizeWorkbenchOperations(operations);

    expect(summary).toContain("创建物体");
    expect(summary).toContain("创建摄像机");
    expect(summary).toContain("创建灯光");
  });
});