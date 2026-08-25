import { beforeEach, describe, expect, it } from "vitest";
import { applyDirectorAuthoringActions, type DirectorAuthoringAction } from "@director/agent-engine/authoring";
import {
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getDirectorProjectRevision,
  getVerticalFovFromFocalLength,
  type DirectorWorldRoad,
} from "@director/project-schema";
import type { DirectorCharacterMotionState } from "../../src/comprehensive/editor/schema/directorProject";
import { createInitialDirectorState, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import {
  compileDirectorDeleteObjectActions,
  dispatchDirectorAuthoringActions,
} from "../../src/agent/dispatchDirectorAuthoringActions";
import {
  compileDirectorAddLightAction,
  compileDirectorCameraUpdateAction,
  compileDirectorCharacterMotionAction,
  compileDirectorLightUpdateAction,
} from "../../src/agent/compileDirectorUiAuthoringActions";

function resetDirectorStore() {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    clipboard: [],
    clipboardPasteCount: 0,
    undoStack: [],
    redoStack: [],
    undoBatchDepth: 0,
    undoBatchSnapshot: null,
    undoBatchHasTrackedChanges: false,
  });
}

function seedProp(objectId: string, position: [number, number, number] = [0, 0, 0]) {
  const seeded = applyDirectorAuthoringActions(useDirectorStore.getState().project, [
    {
      action: "add_object",
      id: objectId,
      name: objectId,
      kind: "prop",
      geometry_type: "box",
      placement_mode: "grounded",
      transform: {
        position,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    },
  ]);
  useDirectorStore.getState().applyAuthoredProject(seeded.project);
}

describe("dispatchDirectorAuthoringActions", () => {
  beforeEach(() => {
    resetDirectorStore();
  });

  it("matches the project revision of a direct authoring apply for the same delete_objects batch", () => {
    seedProp("parity-box");

    const before = structuredClone(useDirectorStore.getState().project);
    const actions = compileDirectorDeleteObjectActions(before, ["parity-box"]);
    const agentApplied = applyDirectorAuthoringActions(before, actions);
    useDirectorStore.getState().applyAuthoredProject(agentApplied.project);
    const agentRevision = getDirectorProjectRevision(useDirectorStore.getState().project);

    useDirectorStore.getState().applyAuthoredProject(before);
    const uiReceipt = dispatchDirectorAuthoringActions(actions, {
      idempotencyKey: "parity-delete-v1",
    });

    expect(uiReceipt.ok).toBe(true);
    if (!uiReceipt.ok) throw new Error(uiReceipt.error);
    expect(uiReceipt.project_revision).toBe(agentRevision);
    expect(useDirectorStore.getState().project.objects.some((object) => object.id === "parity-box")).toBe(false);
  });

  it("detaches children before deleting a parent so UI delete stays non-cascading", () => {
    seedProp("parent-box", [0, 0, 0]);
    const withChild = applyDirectorAuthoringActions(useDirectorStore.getState().project, [
      {
        action: "add_object",
        id: "child-box",
        name: "child-box",
        kind: "prop",
        geometry_type: "box",
        placement_mode: "grounded",
        parent_id: "parent-box",
        transform: {
          position: [1, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
    ]);
    useDirectorStore.getState().applyAuthoredProject(withChild.project);

    const actions = compileDirectorDeleteObjectActions(useDirectorStore.getState().project, ["parent-box"]);
    expect(actions).toEqual([
      {
        action: "update_object",
        object_id: "child-box",
        patch: { parent_id: null },
        force: true,
      },
      {
        action: "delete_objects",
        object_ids: ["parent-box"],
        force: true,
      },
    ]);

    const receipt = dispatchDirectorAuthoringActions(actions, { idempotencyKey: "parity-detach-delete-v1" });
    expect(receipt.ok).toBe(true);
    const project = useDirectorStore.getState().project;
    expect(project.objects.some((object) => object.id === "parent-box")).toBe(false);
    expect(project.objects.find((object) => object.id === "child-box")?.parentObjectId).toBeUndefined();
  });

  it("routes store.deleteObjects through the shared authoring dispatch path", () => {
    seedProp("store-delete-box", [1, 0, 0]);

    useDirectorStore.getState().deleteObjects(["store-delete-box"]);

    expect(useDirectorStore.getState().project.objects.some((object) => object.id === "store-delete-box")).toBe(false);
  });

  it("rejects an empty action list without mutating the project", () => {
    const before = structuredClone(useDirectorStore.getState().project);
    const beforeRevision = getDirectorProjectRevision(before);

    const receipt = dispatchDirectorAuthoringActions([]);

    expect(receipt.ok).toBe(false);
    if (receipt.ok) throw new Error("expected failure");
    expect(receipt.error).toMatch(/No authoring actions/);
    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).toBe(beforeRevision);
  });

  it("rejects a stale expectedRevision without mutating the project", () => {
    seedProp("stale-guard-box");
    const before = structuredClone(useDirectorStore.getState().project);
    const actions = compileDirectorDeleteObjectActions(before, ["stale-guard-box"]);

    const receipt = dispatchDirectorAuthoringActions(actions, {
      expectedRevision: "stale-revision",
      idempotencyKey: "parity-stale-v1",
    });

    expect(receipt.ok).toBe(false);
    if (receipt.ok) throw new Error("expected failure");
    expect(receipt.error).toMatch(/Stale project revision/);
    expect(useDirectorStore.getState().project.objects.some((object) => object.id === "stale-guard-box")).toBe(true);
  });

  it("matches update_camera revision when store.updateCamera patches focal length and aspect", () => {
    const cameraId = useDirectorStore.getState().project.activeCameraId;
    if (!cameraId) throw new Error("default project has no active camera");
    const camera = useDirectorStore.getState().project.cameras.find((item) => item.id === cameraId);
    if (!camera) throw new Error("active camera is missing");
    const before = structuredClone(useDirectorStore.getState().project);

    const agentApplied = applyDirectorAuthoringActions(before, [
      { action: "update_camera", camera_id: cameraId, patch: { focal_length_mm: 50, aspect_ratio: "2.39:1" } },
    ]);
    useDirectorStore.getState().applyAuthoredProject(agentApplied.project);
    const agentRevision = getDirectorProjectRevision(useDirectorStore.getState().project);

    useDirectorStore.getState().applyAuthoredProject(structuredClone(before));
    // CameraPanel always submits the derived fov alongside optics patches.
    useDirectorStore.getState().updateCamera(cameraId, {
      focalLengthMm: 50,
      aspectRatio: "2.39:1",
      fov: getVerticalFovFromFocalLength(50, "2.39:1", camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT),
    });

    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).toBe(agentRevision);
    const updated = useDirectorStore.getState().project.cameras.find((item) => item.id === cameraId);
    expect(updated?.focalLengthMm).toBe(50);
    expect(updated?.aspectRatio).toBe("2.39:1");
  });

  it("matches update_object pose_preset_id revision when store.applyPosePreset poses a character", () => {
    const characterId = "char_default_a";
    const before = structuredClone(useDirectorStore.getState().project);

    const agentApplied = applyDirectorAuthoringActions(before, [
      { action: "update_object", object_id: characterId, patch: { pose_preset_id: "sit" }, force: true },
    ]);
    useDirectorStore.getState().applyAuthoredProject(agentApplied.project);
    const agentRevision = getDirectorProjectRevision(useDirectorStore.getState().project);

    useDirectorStore.getState().applyAuthoredProject(structuredClone(before));
    useDirectorStore.getState().applyPosePreset(characterId, "sit");

    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).toBe(agentRevision);
    const rig = useDirectorStore.getState().project.objects.find((object) => object.id === characterId)?.characterRig;
    expect(rig?.posePresetId).toBe("sit");
  });

  it("matches add_world_road revision when store.upsertWorldRoad creates a road", () => {
    const road: DirectorWorldRoad = {
      id: "road_parity_1",
      name: "Parity Road",
      points: [
        [-12, 0, 0],
        [12, 0, 4],
      ],
      widthM: 6,
      loop: false,
      vehicleCount: 2,
      speedKph: 30,
      showSurface: true,
      seedOffset: 7,
      visible: true,
      locked: false,
    };
    const before = structuredClone(useDirectorStore.getState().project);

    const agentApplied = applyDirectorAuthoringActions(before, [
      {
        action: "add_world_road",
        id: road.id,
        name: road.name,
        points: road.points.map((point) => [...point] as [number, number, number]),
        width_m: road.widthM,
        loop: road.loop,
        vehicle_count: road.vehicleCount,
        speed_kph: road.speedKph,
        show_surface: road.showSurface,
        seed_offset: road.seedOffset,
      },
    ]);
    useDirectorStore.getState().applyAuthoredProject(agentApplied.project);
    const agentRevision = getDirectorProjectRevision(useDirectorStore.getState().project);

    useDirectorStore.getState().applyAuthoredProject(structuredClone(before));
    const applied = useDirectorStore.getState().upsertWorldRoad(road);

    expect(applied).toBe(true);
    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).toBe(agentRevision);
    expect(useDirectorStore.getState().project.world?.roads?.some((entry) => entry.id === road.id)).toBe(true);
  });

  it("keeps locked-object transform edits a no-op through the store dispatch path", () => {
    seedProp("locked-guard-box", [2, 0, 0]);
    useDirectorStore.getState().toggleObjectLocked("locked-guard-box");
    const beforeRevision = getDirectorProjectRevision(useDirectorStore.getState().project);

    useDirectorStore.getState().updateObjectTransform("locked-guard-box", { position: [9, 1, 9] });

    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).toBe(beforeRevision);
    const object = useDirectorStore.getState().project.objects.find((item) => item.id === "locked-guard-box");
    expect(object?.transform.position).not.toEqual([9, 1, 9]);
  });
});

describe("Stage mutator parity with direct agent authoring", () => {
  beforeEach(() => {
    resetDirectorStore();
  });

  /** Apply actions with the agent engine on a clone of the current project. */
  function agentRevisionFor(actions: DirectorAuthoringAction[]) {
    const before = structuredClone(useDirectorStore.getState().project);
    return getDirectorProjectRevision(applyDirectorAuthoringActions(before, actions).project);
  }

  function storeRevision() {
    return getDirectorProjectRevision(useDirectorStore.getState().project);
  }

  it("updateCamera focal-length edits match a direct update_camera apply", () => {
    const project = useDirectorStore.getState().project;
    const camera = project.cameras[0];
    const focalLengthMm = 50;
    const patch = {
      focalLengthMm,
      fov: getVerticalFovFromFocalLength(focalLengthMm, camera.aspectRatio, camera.sensorFormat),
    };

    const action = compileDirectorCameraUpdateAction(project, camera.id, patch);
    expect(action).not.toBeNull();
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().updateCamera(camera.id, patch);

    expect(storeRevision()).toBe(agentRevision);
    expect(useDirectorStore.getState().project.cameras[0].focalLengthMm).toBe(focalLengthMm);
  });

  it("updateCamera target-object edits match a direct update_camera apply", () => {
    const project = useDirectorStore.getState().project;
    const camera = project.cameras[0];
    const patch = { targetMode: "object" as const, targetObjectId: "char_default_a" };

    const action = compileDirectorCameraUpdateAction(project, camera.id, patch);
    expect(action).toEqual({
      action: "update_camera",
      camera_id: camera.id,
      patch: { target_object_id: "char_default_a" },
    });
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().updateCamera(camera.id, patch);

    expect(storeRevision()).toBe(agentRevision);
    const updated = useDirectorStore.getState().project.cameras[0];
    expect(updated.targetMode).toBe("object");
    expect(updated.targetObjectId).toBe("char_default_a");
  });

  it("setActiveCamera matches a direct set_active_camera apply", () => {
    const newCameraId = useDirectorStore.getState().addCameraShot();
    expect(newCameraId).not.toBe("");
    expect(useDirectorStore.getState().project.activeCameraId).toBe(newCameraId);

    const agentRevision = agentRevisionFor([{ action: "set_active_camera", camera_id: "cam_1" }]);

    useDirectorStore.getState().setActiveCamera("cam_1");

    expect(storeRevision()).toBe(agentRevision);
    expect(useDirectorStore.getState().project.activeCameraId).toBe("cam_1");
  });

  it("setCharacterMotion matches a direct set_character_motion apply", () => {
    const motion: DirectorCharacterMotionState = {
      clipId: "walk",
      enabled: true,
      loop: "repeat",
      speed: 1,
      weight: 1,
      blendInS: 0.2,
      blendOutS: 0.2,
      rootMotion: "in-place",
      startFrame: 0,
    };

    const action = compileDirectorCharacterMotionAction("char_default_a", motion);
    expect(action).not.toBeNull();
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().setCharacterMotion("char_default_a", motion);

    expect(storeRevision()).toBe(agentRevision);
    const character = useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a");
    expect(character?.characterRig?.motion?.clipId).toBe("walk");
  });

  it("clearing a character motion matches a direct clear_character_motion apply", () => {
    const motion: DirectorCharacterMotionState = {
      clipId: "walk",
      enabled: true,
      loop: "repeat",
      speed: 1,
      weight: 1,
      blendInS: 0.2,
      blendOutS: 0.2,
      rootMotion: "in-place",
      startFrame: 0,
    };
    useDirectorStore.getState().setCharacterMotion("char_default_a", motion);

    const agentRevision = agentRevisionFor([
      { action: "clear_character_motion", object_id: "char_default_a", force: true },
    ]);

    useDirectorStore.getState().setCharacterMotion("char_default_a", undefined);

    expect(storeRevision()).toBe(agentRevision);
    const character = useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a");
    expect(character?.characterRig?.motion).toBeUndefined();
  });

  it("addLight matches a direct add_light apply", () => {
    const compiled = compileDirectorAddLightAction(useDirectorStore.getState().project, "point");
    const agentRevision = agentRevisionFor([compiled.action]);

    const lightId = useDirectorStore.getState().addLight("point");

    expect(lightId).toBe(compiled.lightId);
    expect(storeRevision()).toBe(agentRevision);
    expect((useDirectorStore.getState().project.lights ?? []).some((light) => light.id === lightId)).toBe(true);
  });

  it("updateLight matches a direct update_light apply", () => {
    const light = (useDirectorStore.getState().project.lights ?? []).find((item) => item.id === "light_directional_1");
    expect(light).toBeDefined();
    const patch = { intensity: 2.5, color: "#ff8800" };

    const action = compileDirectorLightUpdateAction(light!, patch);
    expect(action).not.toBeNull();
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().updateLight("light_directional_1", patch);

    expect(storeRevision()).toBe(agentRevision);
    const updated = (useDirectorStore.getState().project.lights ?? []).find(
      (item) => item.id === "light_directional_1",
    );
    expect(updated?.intensity).toBe(2.5);
    expect(updated?.color).toBe("#ff8800");
  });

  it("removeLight matches a direct delete_lights apply", () => {
    const agentRevision = agentRevisionFor([{ action: "delete_lights", light_ids: ["light_directional_1"] }]);

    useDirectorStore.getState().removeLight("light_directional_1");

    expect(storeRevision()).toBe(agentRevision);
    expect((useDirectorStore.getState().project.lights ?? []).some((light) => light.id === "light_directional_1")).toBe(
      false,
    );
  });
});
