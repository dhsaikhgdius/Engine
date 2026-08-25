import { describe, expect, it } from "vitest";
import { applyDirectorAuthoringActions } from "@director/agent-engine/authoring";
import { createDefaultDirectorProject } from "@director/agent-engine/default-project";
import { parseDirectorWorkbenchInput } from "@director/agent-engine/contract";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderLiveSceneSnapshot,
} from "../../../../packages/protocol/src/blenderLiveProtocol";
import { executeDisconnectedWorkbenchRead } from "../../workbenchDisconnectedReads";

function parsed(input: unknown) {
  const result = parseDirectorWorkbenchInput(input);
  if (!result.success) throw new Error(result.error);
  return result.operation;
}

function blenderScene(objectCount: number): BlenderLiveSceneSnapshot {
  return {
    contract: BLENDER_LIVE_CONTRACT,
    sceneEpoch: "11111111-1111-4111-8111-111111111111",
    revision: 4,
    sceneName: "Scene",
    frame: 1,
    unit: "meter",
    coordinateSystem: "right-handed-y-up-negative-z-forward",
    objects: Array.from({ length: objectCount }, (_, index) => ({
      id: `mesh-${index}`,
      name: `Mesh ${index}`,
      type: "MESH",
      kind: "object",
      position: [index, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      localTransform: { position: [index, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [1, 1, 1],
      visible: true,
      collections: ["Collection"],
      parentId: null,
      modifierCount: 0,
      constraints: [],
    })),
    cameras: [],
    lights: [],
    selectedObjectIds: objectCount ? ["mesh-0"] : [],
    activeObjectId: objectCount ? "mesh-0" : null,
  };
}

describe("executeDisconnectedWorkbenchRead", () => {
  it("serves capabilities without a Stage tab or persisted project", () => {
    const result = executeDisconnectedWorkbenchRead(parsed({ op: "capabilities" }), {
      project: null,
      blenderScene: null,
    });
    expect(result).toMatchObject({
      handled: true,
      success: true,
      result: { workbench_connected: false, source: "gateway" },
    });
    if (result.handled && result.success) {
      expect(Array.isArray(result.result.operations)).toBe(true);
    }
  });

  it("prefers live Blender object counts when the kernel is ahead of the persisted project", () => {
    const result = executeDisconnectedWorkbenchRead(parsed({ op: "observe", fields: ["counts", "ui"] }), {
      project: createDefaultDirectorProject(),
      blenderScene: blenderScene(12),
    });
    expect(result).toMatchObject({
      handled: true,
      success: true,
      result: {
        source: "blender_kernel",
        workbench_connected: false,
        counts: { objects: 12 },
        ui: { selectedObjectId: "mesh-0" },
      },
    });
  });

  it("audits the persisted project and warns when Blender is ahead", () => {
    const result = executeDisconnectedWorkbenchRead(parsed({ op: "audit" }), {
      project: createDefaultDirectorProject(),
      blenderScene: blenderScene(12),
    });
    expect(result.handled).toBe(true);
    if (!result.handled || !result.success) throw new Error("expected a disconnected audit");
    expect(result.result.kernel_ahead).toBe(true);
    expect(result.result.ready).toBeTypeOf("boolean");
    expect(result.result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "workbench_disconnected_kernel_ahead" })]),
    );
  });

  it("names a marked camera move from the persisted project without a Stage tab", () => {
    const staged = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      { action: "start_scene" },
      { action: "add_object", id: "hero", name: "主角", kind: "character", placement_mode: "grounded" },
      {
        action: "add_camera",
        id: "cam-move",
        object_id: "cam-move-rig",
        name: "运动机位",
        position: [0, 1.6, 8],
        target: [0, 1.2, 0],
      },
      {
        action: "frame_shot",
        camera_id: "cam-move",
        subject_object_id: "hero",
        size: "full",
        view: "front-quarter",
        side: "right",
        focal_length_mm: 35,
      },
      { action: "mark_camera_move", camera_id: "cam-move", frame: 0 },
      {
        action: "frame_shot",
        camera_id: "cam-move",
        subject_object_id: "hero",
        size: "close-up",
        view: "front-quarter",
        side: "right",
        focal_length_mm: 35,
      },
      { action: "mark_camera_move", camera_id: "cam-move", frame: 48 },
    ] as Parameters<typeof applyDirectorAuthoringActions>[1]).project;

    const result = executeDisconnectedWorkbenchRead(
      parsed({ op: "describe_camera_move", camera_id: "cam-move", subject_object_id: "hero" }),
      { project: staged, blenderScene: null },
    );
    expect(result).toMatchObject({
      handled: true,
      success: true,
      result: { move: "push-in", workbench_connected: false, source: "persisted_project" },
    });

    const missingMarks = executeDisconnectedWorkbenchRead(
      parsed({ op: "describe_camera_move", camera_id: "cam-move", subject_object_id: "ghost" }),
      { project: staged, blenderScene: null },
    );
    expect(missingMarks).toMatchObject({ handled: true, success: false });
  });

  it("does not serve mutations or capture without a Stage tab", () => {
    expect(
      executeDisconnectedWorkbenchRead(parsed({ op: "undo", unconditional: true }), {
        project: createDefaultDirectorProject(),
        blenderScene: null,
      }),
    ).toEqual({ handled: false });
  });

  it("attaches kernel ownership to disconnected object inspects from the persisted project", () => {
    const project = createDefaultDirectorProject();
    const nativeObject = project.objects.find((object) => object.nativeSource?.engine === "blender")!;
    nativeObject.nativeSource = { ...nativeObject.nativeSource!, provisioned: true };

    const result = executeDisconnectedWorkbenchRead(
      parsed({ op: "inspect", entity: "object", id: nativeObject.id }),
      { project, blenderScene: null },
    );
    expect(result).toMatchObject({
      handled: true,
      success: true,
      result: {
        entity: "object",
        source: "persisted_project",
        kernel_ownership: {
          kernel: "blender",
          source: "blender_native",
          blender_object_id: nativeObject.nativeSource!.objectId,
          stage_patchable_fields: ["name", "visible", "locked", "transform"],
        },
      },
    });

    const light = executeDisconnectedWorkbenchRead(
      parsed({ op: "inspect", entity: "light", id: project.lights![0].id }),
      { project, blenderScene: null },
    );
    expect(light).toMatchObject({
      handled: true,
      success: true,
      result: { kernel_ownership: { kernel: "stage", source: "stage_light" } },
    });
  });

  it("marks a Blender-only inspect fallback as unmirrored Blender ownership", () => {
    const result = executeDisconnectedWorkbenchRead(parsed({ op: "inspect", entity: "object", id: "mesh-3" }), {
      project: null,
      blenderScene: blenderScene(6),
    });
    expect(result).toMatchObject({
      handled: true,
      success: true,
      result: {
        entity: "object",
        source: "blender_kernel",
        kernel_ownership: {
          kernel: "blender",
          source: "blender_native",
          blender_object_id: "mesh-3",
          stage_patchable_fields: [],
          deletes_with_blender: true,
        },
      },
    });
  });
});
