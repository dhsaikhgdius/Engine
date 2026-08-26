import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDirectorAuthoringActions, type DirectorAuthoringAction } from "@director/agent-engine/authoring";
import {
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getDirectorProjectRevision,
  getVerticalFovFromFocalLength,
  type DirectorWorldEffect,
  type DirectorWorldRoad,
} from "@director/project-schema";
import type { DirectorCharacterMotionState } from "../../src/comprehensive/editor/schema/directorProject";
import { mergeDirectorPbrMaterial } from "../../src/comprehensive/editor/schema/directorMaterial";
import { createDefaultDirectorFrameTimeline } from "../../src/comprehensive/editor/timeline/frameTime";
import { createInitialDirectorState, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import {
  compileDirectorDeleteObjectActions,
  dispatchDirectorAuthoringActions,
} from "../../src/agent/dispatchDirectorAuthoringActions";
import {
  compileDirectorAddLightAction,
  compileDirectorAssetRealWorldSizeAction,
  compileDirectorCameraUpdateAction,
  compileDirectorCharacterMotionAction,
  compileDirectorImportedAssetUpsertAction,
  compileDirectorLightUpdateAction,
  compileDirectorRemoveImportedAssetActions,
  compileDirectorRemovePanoramaAssetAction,
  compileDirectorTimelineAudioClipAdd,
  compileDirectorTimelineAudioClipMove,
  compileDirectorTimelineAudioClipRemoval,
  compileDirectorTimelineAudioClipUpdate,
  compileDirectorTimelineAudioTrackMute,
  compileDirectorTimelineSetSceneAction,
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

/** Apply actions with the agent engine on a clone of the current project. */
function agentRevisionFor(actions: DirectorAuthoringAction[]) {
  const before = structuredClone(useDirectorStore.getState().project);
  return getDirectorProjectRevision(applyDirectorAuthoringActions(before, actions).project);
}

function storeRevision() {
  return getDirectorProjectRevision(useDirectorStore.getState().project);
}

function currentTimeline() {
  return useDirectorStore.getState().project.scene.timeline ?? createDefaultDirectorFrameTimeline();
}

/** Import a local model asset into the library only (no scene instancing). */
function importLibraryModelAsset(name: string) {
  return useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name,
    fileName: `${name}.glb`,
    url: `https://example.com/${name}.glb`,
    addToScene: false,
  });
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

  it("updateScene matches a direct set_scene apply", () => {
    const agentRevision = agentRevisionFor([
      { action: "set_scene", patch: { backgroundColor: "#123456", showLabels: false } },
    ]);

    useDirectorStore.getState().updateScene({ backgroundColor: "#123456", showLabels: false });

    expect(storeRevision()).toBe(agentRevision);
    expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#123456");
  });

  it("setObjectLayerState matches a direct set_object_layer_state apply", () => {
    const agentRevision = agentRevisionFor([{ action: "set_object_layer_state", layer_id: "default", visible: false }]);

    const changed = useDirectorStore.getState().setObjectLayerState("default", { visible: false });

    expect(changed).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
    expect(
      useDirectorStore.getState().project.scene.objectLayers?.find((layer) => layer.id === "default")?.visible,
    ).toBe(false);
  });

  it("moveObjectLayer matches a direct reorder_object_layer apply", () => {
    useDirectorStore.getState().setObjectLayerState("default", { locked: false });
    useDirectorStore.getState().setObjectLayerState("props", { locked: false });
    const agentRevision = agentRevisionFor([
      { action: "reorder_object_layer", layer_id: "props", before_layer_id: "default" },
    ]);

    const moved = useDirectorStore.getState().moveObjectLayer("props", "up");

    expect(moved).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
    expect(useDirectorStore.getState().project.scene.objectLayers?.map((layer) => layer.id)).toEqual([
      "props",
      "default",
    ]);
  });

  it("updateObjectMaterial matches a direct update_object material apply", () => {
    seedProp("material-box");
    const object = useDirectorStore.getState().project.objects.find((item) => item.id === "material-box");
    const patch = { metalness: 0.8, roughness: 0.2 };
    const agentRevision = agentRevisionFor([
      {
        action: "update_object",
        object_id: "material-box",
        patch: { material: mergeDirectorPbrMaterial(object?.material, patch) },
        force: true,
      },
    ]);

    useDirectorStore.getState().updateObjectMaterial("material-box", patch);

    expect(storeRevision()).toBe(agentRevision);
    const updated = useDirectorStore.getState().project.objects.find((item) => item.id === "material-box");
    expect(updated?.material?.metalness).toBe(0.8);
  });

  it("updateObjectMaterialTexture matches a direct update_object textures apply", () => {
    seedProp("texture-box");
    const textureAssetId = useDirectorStore.getState().addImportedAsset({
      kind: "prop",
      name: "纹理",
      fileName: "texture.png",
      url: "https://example.com/texture.png",
      sourceType: "image",
      addToScene: false,
    });
    const object = useDirectorStore.getState().project.objects.find((item) => item.id === "texture-box");
    const agentRevision = agentRevisionFor([
      {
        action: "update_object",
        object_id: "texture-box",
        patch: {
          material: mergeDirectorPbrMaterial(object?.material, { textures: { baseColorMapAssetId: textureAssetId } }),
        },
        force: true,
      },
    ]);

    useDirectorStore.getState().updateObjectMaterialTexture("texture-box", "baseColorMapAssetId", textureAssetId);

    expect(storeRevision()).toBe(agentRevision);
    const updated = useDirectorStore.getState().project.objects.find((item) => item.id === "texture-box");
    expect(updated?.material?.textures?.baseColorMapAssetId).toBe(textureAssetId);
  });

  it("upsertWorldEffect fire propagation matches a direct update_world_effect apply", () => {
    // add_world_effect stamps createdAt; freeze the clock so both applies agree.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    try {
      const effect: DirectorWorldEffect = {
        id: "fx_fire_1",
        name: "火焰 1",
        kind: "fire",
        anchor: { objectId: null, position: [0, 0, 0] },
        shape: { type: "point" },
        intensity: 1,
        sizeScale: 1,
        speedScale: 1,
        windInfluence: 0.6,
        seedOffset: 3,
        visible: true,
        locked: false,
        createdAt: new Date().toISOString(),
      };
      expect(useDirectorStore.getState().upsertWorldEffect(effect)).toBe(true);
      const stored = useDirectorStore.getState().project.world!.effects[0]!;
      expect(stored.propagation).toBeUndefined();

      const agentRevision = agentRevisionFor([
        { action: "update_world_effect", effect_id: "fx_fire_1", patch: { propagation: { enabled: true } } },
      ]);

      const applied = useDirectorStore.getState().upsertWorldEffect({
        ...stored,
        propagation: { enabled: true, radiusM: 12, spreadRate: 1 },
      });

      expect(applied).toBe(true);
      expect(storeRevision()).toBe(agentRevision);
      expect(useDirectorStore.getState().project.world?.effects[0]?.propagation).toEqual({
        enabled: true,
        radiusM: 12,
        spreadRate: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Stage annotation and measurement parity with direct agent authoring", () => {
  beforeEach(() => {
    resetDirectorStore();
    // add_annotation/add_measurement stamp createdAt; freeze the clock so the
    // direct agent apply and the store dispatch build identical entries.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("addSceneAnnotation matches a direct add_annotation apply", () => {
    const agentRevision = agentRevisionFor([
      {
        action: "add_annotation",
        annotation: {
          id: "annotation_1",
          text: "走位标记",
          anchor: { objectId: null, position: [1, 0, 2] },
          color: "#f6c453",
          visible: true,
          createdAt: new Date().toISOString(),
        },
      },
    ]);

    const annotationId = useDirectorStore
      .getState()
      .addSceneAnnotation({ text: "走位标记", anchor: { objectId: null, position: [1, 0, 2] } });

    expect(annotationId).toBe("annotation_1");
    expect(storeRevision()).toBe(agentRevision);
  });

  it("updateSceneAnnotation matches a direct update_annotation apply", () => {
    useDirectorStore
      .getState()
      .addSceneAnnotation({ text: "走位标记", anchor: { objectId: null, position: [1, 0, 2] } });
    const agentRevision = agentRevisionFor([
      { action: "update_annotation", annotation_id: "annotation_1", patch: { text: "更新后的标记", visible: false } },
    ]);

    const changed = useDirectorStore
      .getState()
      .updateSceneAnnotation("annotation_1", { text: "更新后的标记", visible: false });

    expect(changed).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
  });

  it("removeSceneAnnotation matches a direct remove_annotations apply", () => {
    useDirectorStore
      .getState()
      .addSceneAnnotation({ text: "走位标记", anchor: { objectId: null, position: [1, 0, 2] } });
    const agentRevision = agentRevisionFor([{ action: "remove_annotations", annotation_ids: ["annotation_1"] }]);

    const removed = useDirectorStore.getState().removeSceneAnnotation("annotation_1");

    expect(removed).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
  });

  it("addSceneMeasurement matches a direct add_measurement apply", () => {
    const agentRevision = agentRevisionFor([
      {
        action: "add_measurement",
        measurement: {
          id: "measurement_1",
          start: { objectId: null, position: [0, 0, 0] },
          end: { objectId: null, position: [4, 0, 0] },
          color: "#6ed6ff",
          visible: true,
          createdAt: new Date().toISOString(),
        },
      },
    ]);

    const measurementId = useDirectorStore.getState().addSceneMeasurement({
      start: { objectId: null, position: [0, 0, 0] },
      end: { objectId: null, position: [4, 0, 0] },
    });

    expect(measurementId).toBe("measurement_1");
    expect(storeRevision()).toBe(agentRevision);
  });

  it("updateSceneMeasurement matches a direct update_measurement apply", () => {
    useDirectorStore.getState().addSceneMeasurement({
      start: { objectId: null, position: [0, 0, 0] },
      end: { objectId: null, position: [4, 0, 0] },
    });
    const agentRevision = agentRevisionFor([
      { action: "update_measurement", measurement_id: "measurement_1", patch: { label: "开间", visible: false } },
    ]);

    const changed = useDirectorStore
      .getState()
      .updateSceneMeasurement("measurement_1", { label: "开间", visible: false });

    expect(changed).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
  });

  it("removeSceneMeasurement matches a direct remove_measurements apply", () => {
    useDirectorStore.getState().addSceneMeasurement({
      start: { objectId: null, position: [0, 0, 0] },
      end: { objectId: null, position: [4, 0, 0] },
    });
    const agentRevision = agentRevisionFor([{ action: "remove_measurements", measurement_ids: ["measurement_1"] }]);

    const removed = useDirectorStore.getState().removeSceneMeasurement("measurement_1");

    expect(removed).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
  });
});

describe("Stage timeline audio parity with direct agent authoring", () => {
  beforeEach(() => {
    resetDirectorStore();
  });

  function addClip(name = "配乐") {
    const clipId = useDirectorStore.getState().addTimelineAudioClip({
      mediaId: "creative-media:audio:parity",
      name,
      durationFrames: 48,
      sourceDurationSec: 2,
    });
    if (!clipId) throw new Error("failed to add timeline audio clip");
    return clipId;
  }

  it("addTimelineAudioClip matches a direct set_scene timeline apply", () => {
    const built = compileDirectorTimelineAudioClipAdd(currentTimeline(), {
      mediaId: "creative-media:audio:parity",
      name: "配乐",
      durationFrames: 48,
      sourceDurationSec: 2,
    });
    expect(built).not.toBeNull();
    const agentRevision = agentRevisionFor([compileDirectorTimelineSetSceneAction(built!.timeline)]);

    const clipId = addClip();

    expect(clipId).toBe(built!.clipId);
    expect(storeRevision()).toBe(agentRevision);
    const tracks = useDirectorStore.getState().project.scene.timeline?.audioTracks ?? [];
    expect(tracks.some((track) => track.clips.some((clip) => clip.id === clipId))).toBe(true);
  });

  it("updateTimelineAudioClip matches a direct set_scene timeline apply", () => {
    const clipId = addClip();
    const built = compileDirectorTimelineAudioClipUpdate(currentTimeline(), clipId, { volume: 0.5, fadeInSec: 1 });
    expect(built).not.toBeNull();
    const agentRevision = agentRevisionFor([compileDirectorTimelineSetSceneAction(built!)]);

    const changed = useDirectorStore.getState().updateTimelineAudioClip(clipId, { volume: 0.5, fadeInSec: 1 });

    expect(changed).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
  });

  it("moveTimelineAudioClip matches a direct set_scene timeline apply", () => {
    const clipId = addClip();
    const built = compileDirectorTimelineAudioClipMove(currentTimeline(), clipId, 24);
    expect(built).not.toBeNull();
    const agentRevision = agentRevisionFor([compileDirectorTimelineSetSceneAction(built!)]);

    const moved = useDirectorStore.getState().moveTimelineAudioClip(clipId, 24);

    expect(moved).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
  });

  it("removeTimelineAudioClip matches a direct set_scene timeline apply", () => {
    const clipId = addClip();
    const built = compileDirectorTimelineAudioClipRemoval(currentTimeline(), clipId);
    expect(built).not.toBeNull();
    const agentRevision = agentRevisionFor([compileDirectorTimelineSetSceneAction(built!)]);

    const removed = useDirectorStore.getState().removeTimelineAudioClip(clipId);

    expect(removed).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
  });

  it("setTimelineAudioTrackMuted matches a direct set_scene timeline apply", () => {
    addClip();
    const trackId = (useDirectorStore.getState().project.scene.timeline?.audioTracks ?? [])[0]?.id;
    expect(trackId).toBeDefined();
    const built = compileDirectorTimelineAudioTrackMute(currentTimeline(), trackId!, true);
    expect(built).not.toBeNull();
    const agentRevision = agentRevisionFor([compileDirectorTimelineSetSceneAction(built!)]);

    const changed = useDirectorStore.getState().setTimelineAudioTrackMuted(trackId!, true);

    expect(changed).toBe(true);
    expect(storeRevision()).toBe(agentRevision);
  });

  it("keeps volume slider batches on the legacy writer with one undo entry", () => {
    const clipId = addClip();
    const undoDepthBefore = useDirectorStore.getState().undoStack.length;
    // The one-shot dispatch of the final value must land on the same revision.
    const built = compileDirectorTimelineAudioClipUpdate(currentTimeline(), clipId, { volume: 0.25 });
    const agentRevision = agentRevisionFor([compileDirectorTimelineSetSceneAction(built!)]);

    useDirectorStore.getState().beginUndoBatch();
    useDirectorStore.getState().updateTimelineAudioClip(clipId, { volume: 0.6 });
    useDirectorStore.getState().updateTimelineAudioClip(clipId, { volume: 0.25 });
    useDirectorStore.getState().endUndoBatch();

    expect(useDirectorStore.getState().undoStack.length).toBe(undoDepthBefore + 1);
    expect(storeRevision()).toBe(agentRevision);
  });
});

describe("Stage asset flow parity with direct agent authoring", () => {
  beforeEach(() => {
    resetDirectorStore();
  });

  it("addImportedAsset (library only) matches a direct upsert_asset apply", () => {
    const before = structuredClone(useDirectorStore.getState().project);

    const assetId = importLibraryModelAsset("parity-model");

    expect(assetId).toMatch(/^asset_/);
    const stored = useDirectorStore.getState().project.assets.find((asset) => asset.id === assetId);
    expect(stored).toBeDefined();
    const agentRevision = getDirectorProjectRevision(
      applyDirectorAuthoringActions(before, [compileDirectorImportedAssetUpsertAction(structuredClone(stored!))])
        .project,
    );
    expect(storeRevision()).toBe(agentRevision);
  });

  it("setAssetRealWorldSize matches a direct upsert_asset apply", () => {
    const assetId = importLibraryModelAsset("parity-size-model");
    const action = compileDirectorAssetRealWorldSizeAction(useDirectorStore.getState().project, assetId, 2.5, "user");
    expect(action).not.toBeNull();
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().setAssetRealWorldSize(assetId, 2.5, "user");

    expect(storeRevision()).toBe(agentRevision);
    const asset = useDirectorStore.getState().project.assets.find((item) => item.id === assetId);
    expect(asset?.realWorldSizeM).toBe(2.5);
    expect(asset?.sizeSource).toBe("user");
  });

  it("removeImportedAsset detaches children and matches a direct remove_assets cascade apply", () => {
    const assetId = importLibraryModelAsset("parity-remove-model");
    const seeded = applyDirectorAuthoringActions(useDirectorStore.getState().project, [
      {
        action: "add_object",
        id: "asset-instance",
        name: "asset-instance",
        kind: "prop",
        asset_id: assetId,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        action: "add_object",
        id: "asset-child",
        name: "asset-child",
        kind: "prop",
        geometry_type: "box",
        parent_id: "asset-instance",
        transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ]);
    useDirectorStore.getState().applyAuthoredProject(seeded.project);

    const actions = compileDirectorRemoveImportedAssetActions(useDirectorStore.getState().project, assetId);
    expect(actions).toEqual([
      { action: "update_object", object_id: "asset-child", patch: { parent_id: null }, force: true },
      { action: "remove_assets", asset_ids: [assetId], cascade: true },
    ]);
    const agentRevision = agentRevisionFor(actions!);

    useDirectorStore.getState().removeImportedAsset(assetId);

    expect(storeRevision()).toBe(agentRevision);
    const project = useDirectorStore.getState().project;
    expect(project.assets.some((asset) => asset.id === assetId)).toBe(false);
    expect(project.objects.some((object) => object.id === "asset-instance")).toBe(false);
    expect(project.objects.find((object) => object.id === "asset-child")?.parentObjectId).toBeUndefined();
  });

  it("removePanoramaAsset matches a direct remove_assets apply", () => {
    useDirectorStore.getState().addImportedAsset({
      kind: "panorama",
      name: "全景",
      fileName: "panorama.jpg",
      url: "https://example.com/panorama.jpg",
    });
    const panoramaAssetId = useDirectorStore.getState().project.panoramaAssetId;
    expect(panoramaAssetId).toBeTruthy();
    const action = compileDirectorRemovePanoramaAssetAction(useDirectorStore.getState().project);
    expect(action).toEqual({ action: "remove_assets", asset_ids: [panoramaAssetId] });
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().removePanoramaAsset();

    expect(storeRevision()).toBe(agentRevision);
    expect(useDirectorStore.getState().project.panoramaAssetId).toBeNull();
  });
});
