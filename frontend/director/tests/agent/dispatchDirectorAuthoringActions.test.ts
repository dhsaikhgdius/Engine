import { beforeEach, describe, expect, it } from "vitest";
import { applyDirectorAuthoringActions, type DirectorAuthoringAction } from "@director/agent-engine/authoring";
import {
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getDirectorProjectRevision,
  getVerticalFovFromFocalLength,
  type DirectorWorldRoad,
} from "@director/project-schema";
import type { DirectorCharacterMotionState } from "../../src/comprehensive/editor/schema/directorProject";
import {
  createInitialDirectorState,
  getCrowdAnchorTransform,
  useDirectorStore,
} from "../../src/comprehensive/editor/store/directorStore";
import {
  compileDirectorDeleteObjectActions,
  dispatchDirectorAuthoringActions,
} from "../../src/agent/dispatchDirectorAuthoringActions";
import {
  compileDirectorAddLightAction,
  compileDirectorCameraUpdateAction,
  compileDirectorCharacterMotionAction,
  compileDirectorLightUpdateAction,
  compileDirectorPasteClipboardActions,
  compileDirectorSceneUpdateAction,
  compileDirectorWorldSettingsAction,
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

  it("routes addCameraCaptures through shared add_camera_captures with revision parity", () => {
    const cameraId = useDirectorStore.getState().project.activeCameraId;
    if (!cameraId) throw new Error("default project has no active camera");
    const before = structuredClone(useDirectorStore.getState().project);
    const dataUrl = "data:image/png;base64,paritycapture";

    const agentApplied = applyDirectorAuthoringActions(before, [
      {
        action: "add_camera_captures",
        camera_id: cameraId,
        captures: [{ data_url: dataUrl }],
      },
    ]);
    const agentRevision = getDirectorProjectRevision(agentApplied.project);

    useDirectorStore.getState().addCameraCaptures(cameraId, [dataUrl]);
    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).toBe(agentRevision);
    const camera = useDirectorStore.getState().project.cameras.find((item) => item.id === cameraId);
    expect(camera?.captures?.at(-1)).toMatchObject({
      id: `${cameraId}-capture-01`,
      index: 1,
      dataUrl,
    });
    expect(camera?.lastCaptureUrl).toBe(dataUrl);
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

  /** Same 6-decimal rounding the store's crowd transform math applies. */
  function roundTuple(values: [number, number, number]): [number, number, number] {
    return values.map((value) => Number(value.toFixed(6))) as [number, number, number];
  }

  function seedCrowd() {
    const createdIds = useDirectorStore.getState().addCrowdCharacters({ rows: 1, columns: 2, spacing: 2 });
    expect(createdIds.length).toBe(2);
    // Land the locally-written crowd on the shared authoring landing point so
    // the fixture starts from the same migration fixed point both paths use.
    useDirectorStore.getState().applyAuthoredProject(useDirectorStore.getState().project);
    const crowdId = useDirectorStore.getState().project.objects.find((object) => object.id === createdIds[0])?.crowdId;
    if (!crowdId) throw new Error("crowd characters are missing a crowdId");
    return crowdId;
  }

  function crowdMembers(crowdId: string) {
    return useDirectorStore
      .getState()
      .project.objects.filter((object) => object.kind === "character" && object.crowdId === crowdId);
  }

  it("dropObjectToGround matches a direct update_object grounded apply", () => {
    seedProp("drop-parity-box", [3, 2.5, -1]);

    const agentRevision = agentRevisionFor([
      {
        action: "update_object",
        object_id: "drop-parity-box",
        patch: { transform: { position: [3, 0, -1] }, placement_mode: "grounded" },
        force: true,
      },
    ]);

    useDirectorStore.getState().dropObjectToGround("drop-parity-box");

    expect(storeRevision()).toBe(agentRevision);
    const object = useDirectorStore.getState().project.objects.find((item) => item.id === "drop-parity-box");
    expect(object?.transform.position).toEqual([3, 0, -1]);
    expect(object?.placementMode).toBe("grounded");
  });

  it("dropObjectToGround keeps the legacy writer inside a slider/gizmo undo batch", () => {
    seedProp("drop-batch-box", [1, 4, 1]);

    useDirectorStore.getState().beginUndoBatch();
    useDirectorStore.getState().dropObjectToGround("drop-batch-box");
    useDirectorStore.getState().endUndoBatch();

    const object = useDirectorStore.getState().project.objects.find((item) => item.id === "drop-batch-box");
    expect(object?.transform.position).toEqual([1, 0, 1]);
    expect(object?.placementMode).toBe("grounded");
  });

  it("updateUniformScale matches a direct update_object scale apply", () => {
    seedProp("scale-parity-box", [0, 0, 2]);

    const agentRevision = agentRevisionFor([
      {
        action: "update_object",
        object_id: "scale-parity-box",
        patch: { transform: { scale: [2.5, 2.5, 2.5] } },
        force: true,
      },
    ]);

    useDirectorStore.getState().updateUniformScale("scale-parity-box", 2.5);

    expect(storeRevision()).toBe(agentRevision);
    const object = useDirectorStore.getState().project.objects.find((item) => item.id === "scale-parity-box");
    expect(object?.transform.scale).toEqual([2.5, 2.5, 2.5]);
  });

  it("updateCharacterBodyType matches a direct update_object body_type apply", () => {
    const agentRevision = agentRevisionFor([
      { action: "update_object", object_id: "char_default_a", patch: { body_type: "broad" }, force: true },
    ]);

    useDirectorStore.getState().updateCharacterBodyType("char_default_a", "broad");

    expect(storeRevision()).toBe(agentRevision);
    const character = useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a");
    expect(character?.bodyType).toBe("broad");
  });

  it("updateCrowdTransform matches a per-member update_object transform apply", () => {
    const crowdId = seedCrowd();
    const members = crowdMembers(crowdId);
    const anchor = getCrowdAnchorTransform(useDirectorStore.getState().project.objects, crowdId);
    if (!anchor) throw new Error("crowd anchor is missing");
    const target: [number, number, number] = [4, anchor.position[1], -3];

    const agentRevision = agentRevisionFor(
      members.map((member) => ({
        action: "update_object" as const,
        object_id: member.id,
        patch: {
          transform: {
            position: roundTuple([
              target[0] + member.transform.position[0] - anchor.position[0],
              target[1] + member.transform.position[1] - anchor.position[1],
              target[2] + member.transform.position[2] - anchor.position[2],
            ]),
            rotation: roundTuple([...member.transform.rotation]),
            scale: roundTuple([...member.transform.scale]),
          },
        },
        force: true,
      })),
    );

    useDirectorStore.getState().updateCrowdTransform(crowdId, { position: target });

    expect(storeRevision()).toBe(agentRevision);
    const movedAnchor = getCrowdAnchorTransform(useDirectorStore.getState().project.objects, crowdId);
    expect(movedAnchor?.position).toEqual(target);
  });

  it("dropCrowdToGround matches a per-member grounded update_object apply", () => {
    const crowdId = seedCrowd();
    const raisedAnchor = getCrowdAnchorTransform(useDirectorStore.getState().project.objects, crowdId);
    if (!raisedAnchor) throw new Error("crowd anchor is missing");
    useDirectorStore
      .getState()
      .updateCrowdTransform(crowdId, { position: [raisedAnchor.position[0], 1.5, raisedAnchor.position[2]] });

    const members = crowdMembers(crowdId);
    const anchor = getCrowdAnchorTransform(useDirectorStore.getState().project.objects, crowdId);
    if (!anchor) throw new Error("crowd anchor is missing");
    const groundHeight = useDirectorStore.getState().project.scene.groundHeight;

    const agentRevision = agentRevisionFor(
      members.map((member) => ({
        action: "update_object" as const,
        object_id: member.id,
        patch: {
          transform: {
            position: roundTuple([
              member.transform.position[0],
              groundHeight + member.transform.position[1] - anchor.position[1],
              member.transform.position[2],
            ]),
            rotation: roundTuple([...member.transform.rotation]),
            scale: roundTuple([...member.transform.scale]),
          },
          placement_mode: "grounded" as const,
        },
        force: true,
      })),
    );

    useDirectorStore.getState().dropCrowdToGround(crowdId);

    expect(storeRevision()).toBe(agentRevision);
    crowdMembers(crowdId).forEach((member) => {
      expect(member.transform.position[1]).toBe(groundHeight);
      expect(member.placementMode).toBe("grounded");
    });
  });

  it("updateCrowdUniformScale matches a per-member update_object scale apply", () => {
    const crowdId = seedCrowd();
    const members = crowdMembers(crowdId);
    const anchor = getCrowdAnchorTransform(useDirectorStore.getState().project.objects, crowdId);
    if (!anchor) throw new Error("crowd anchor is missing");

    const agentRevision = agentRevisionFor(
      members.map((member) => ({
        action: "update_object" as const,
        object_id: member.id,
        patch: {
          transform: {
            position: roundTuple([
              anchor.position[0] + (member.transform.position[0] - anchor.position[0]) * 2,
              anchor.position[1] + (member.transform.position[1] - anchor.position[1]) * 2,
              anchor.position[2] + (member.transform.position[2] - anchor.position[2]) * 2,
            ]),
            rotation: roundTuple([...member.transform.rotation]),
            scale: roundTuple([
              member.transform.scale[0] * 2,
              member.transform.scale[1] * 2,
              member.transform.scale[2] * 2,
            ]),
          },
        },
        force: true,
      })),
    );

    useDirectorStore.getState().updateCrowdUniformScale(crowdId, 2);

    expect(storeRevision()).toBe(agentRevision);
    crowdMembers(crowdId).forEach((member) => {
      expect(member.transform.scale).toEqual([2, 2, 2]);
    });
  });

  it("updateCrowdLabel matches a per-member update_object crowd_label apply", () => {
    const crowdId = seedCrowd();
    const members = crowdMembers(crowdId);

    const agentRevision = agentRevisionFor(
      members.map((member) => ({
        action: "update_object" as const,
        object_id: member.id,
        patch: { crowd_label: "围观群众" },
        force: true,
      })),
    );

    useDirectorStore.getState().updateCrowdLabel(crowdId, "围观群众");

    expect(storeRevision()).toBe(agentRevision);
    crowdMembers(crowdId).forEach((member) => {
      expect(member.crowdLabel).toBe("围观群众");
    });
  });

  it("updateCrowdColor matches a per-member update_object color apply", () => {
    const crowdId = seedCrowd();
    const members = crowdMembers(crowdId);

    const agentRevision = agentRevisionFor(
      members.map((member) => ({
        action: "update_object" as const,
        object_id: member.id,
        patch: { color: "#ff8800" },
        force: true,
      })),
    );

    useDirectorStore.getState().updateCrowdColor(crowdId, "#ff8800");

    expect(storeRevision()).toBe(agentRevision);
    crowdMembers(crowdId).forEach((member) => {
      expect(member.color).toBe("#ff8800");
    });
  });

  it("updateScene matches a direct set_scene apply", () => {
    const patch = { groundHeight: 0.5, showLabels: false, backgroundColor: "#101418" };
    const action = compileDirectorSceneUpdateAction(patch);
    expect(action).toEqual({ action: "set_scene", patch });
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().updateScene(patch);

    expect(storeRevision()).toBe(agentRevision);
    const scene = useDirectorStore.getState().project.scene;
    expect(scene.groundHeight).toBe(0.5);
    expect(scene.showLabels).toBe(false);
    expect(scene.backgroundColor).toBe("#101418");
  });

  it("updateWorldSettings weather-evolution edits match a direct set_world_settings apply", () => {
    const patch = { weather: { evolution: { mode: "cycle" as const, periodSeconds: 240 } } };
    const action = compileDirectorWorldSettingsAction(patch);
    expect(action).toEqual({
      action: "set_world_settings",
      settings: { weather: { evolution: { mode: "cycle", period_seconds: 240 } } },
    });
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().updateWorldSettings(patch);

    expect(storeRevision()).toBe(agentRevision);
    expect(useDirectorStore.getState().project.world?.settings.weather.evolution).toEqual({
      mode: "cycle",
      periodSeconds: 240,
    });
  });

  it("updateWorldSettings mixed patches match a direct set_world_settings apply", () => {
    const patch = {
      enabled: true,
      seed: 1234,
      wind: { speedMps: 7.5, gustiness: 0.4 },
      timeOfDay: { mode: "cycle" as const, cycleMinutes: 12 },
      weather: { preset: "storm" as const, intensity: 0.9 },
    };
    const action = compileDirectorWorldSettingsAction(patch);
    expect(action).toEqual({
      action: "set_world_settings",
      settings: {
        enabled: true,
        seed: 1234,
        wind: { speed_mps: 7.5, gustiness: 0.4 },
        time_of_day: { mode: "cycle", cycle_minutes: 12 },
        weather: { preset: "storm", intensity: 0.9 },
      },
    });
    const agentRevision = agentRevisionFor([action!]);

    useDirectorStore.getState().updateWorldSettings(patch);

    expect(storeRevision()).toBe(agentRevision);
    const settings = useDirectorStore.getState().project.world?.settings;
    expect(settings?.enabled).toBe(true);
    expect(settings?.seed).toBe(1234);
    expect(settings?.wind.speedMps).toBe(7.5);
    expect(settings?.weather.preset).toBe("storm");
  });

  it("removeImportedAsset matches a direct remove_assets cascade apply", () => {
    const assetId = useDirectorStore.getState().addImportedAsset({
      kind: "prop",
      sourceType: "model",
      name: "Parity model",
      fileName: "parity-model.glb",
      url: "https://example.com/parity-model.glb",
      assetSource: "local",
    });
    const seededObject = useDirectorStore.getState().project.objects.find((object) => object.assetRefId === assetId);
    expect(seededObject).toBeDefined();

    const agentRevision = agentRevisionFor([{ action: "remove_assets", asset_ids: [assetId], cascade: true }]);

    useDirectorStore.getState().removeImportedAsset(assetId);

    expect(storeRevision()).toBe(agentRevision);
    const project = useDirectorStore.getState().project;
    expect(project.assets.some((asset) => asset.id === assetId)).toBe(false);
    expect(project.objects.some((object) => object.assetRefId === assetId)).toBe(false);
  });

  it("addImportedAsset catalog-only matches a direct upsert_asset apply", () => {
    const before = structuredClone(useDirectorStore.getState().project);
    const assetId = useDirectorStore.getState().addImportedAsset({
      kind: "prop",
      sourceType: "model",
      name: "Catalog only",
      fileName: "catalog-only.glb",
      url: "https://example.com/catalog-only.glb",
      assetSource: "local",
      addToScene: false,
    });
    const asset = useDirectorStore.getState().project.assets.find((item) => item.id === assetId)!;
    expect(useDirectorStore.getState().project.objects.some((object) => object.assetRefId === assetId)).toBe(false);

    const agentRevision = getDirectorProjectRevision(
      applyDirectorAuthoringActions(before, [{ action: "upsert_asset", asset: structuredClone(asset) }]).project,
    );
    expect(storeRevision()).toBe(agentRevision);
  });

  it("addImportedAsset panorama matches upsert_asset plus set_panorama_asset", () => {
    const before = structuredClone(useDirectorStore.getState().project);
    const panoramaId = useDirectorStore.getState().addImportedAsset({
      kind: "panorama",
      sourceType: "image",
      name: "Parity sky",
      fileName: "parity-sky.jpg",
      url: "https://example.com/parity-sky.jpg",
    });
    const asset = useDirectorStore.getState().project.assets.find((item) => item.id === panoramaId)!;
    expect(useDirectorStore.getState().project.panoramaAssetId).toBe(panoramaId);

    const agentRevision = getDirectorProjectRevision(
      applyDirectorAuthoringActions(before, [
        { action: "upsert_asset", asset: structuredClone(asset) },
        { action: "set_panorama_asset", asset_id: panoramaId },
      ]).project,
    );
    expect(storeRevision()).toBe(agentRevision);
  });

  it("addImportedAsset scene-placing prop matches upsert_asset plus add_object", () => {
    const before = structuredClone(useDirectorStore.getState().project);
    const assetId = useDirectorStore.getState().addImportedAsset({
      kind: "prop",
      sourceType: "model",
      name: "Placed crate",
      fileName: "crate.glb",
      url: "https://example.com/crate.glb",
      assetSource: "local",
    });
    const project = useDirectorStore.getState().project;
    const asset = project.assets.find((item) => item.id === assetId)!;
    const placed = project.objects.find((item) => item.assetRefId === assetId);
    expect(placed).toBeTruthy();
    expect(placed?.nativeSource).toEqual({ engine: "blender", objectId: placed!.id, provisioned: false });

    const agentRevision = getDirectorProjectRevision(
      applyDirectorAuthoringActions(before, [
        { action: "upsert_asset", asset: structuredClone(asset) },
        {
          action: "add_object",
          id: placed!.id,
          name: placed!.name,
          kind: "prop",
          asset_id: assetId,
          transform: structuredClone(placed!.transform),
        },
      ]).project,
    );
    expect(storeRevision()).toBe(agentRevision);
  });

  it("removePanoramaAsset matches a direct remove_assets apply", () => {
    const panoramaId = useDirectorStore.getState().addImportedAsset({
      kind: "panorama",
      sourceType: "image",
      name: "Parity sky",
      fileName: "parity-sky.jpg",
      url: "https://example.com/parity-sky.jpg",
    });
    expect(useDirectorStore.getState().project.panoramaAssetId).toBe(panoramaId);

    const agentRevision = agentRevisionFor([{ action: "remove_assets", asset_ids: [panoramaId] }]);
    useDirectorStore.getState().removePanoramaAsset();

    expect(storeRevision()).toBe(agentRevision);
    const project = useDirectorStore.getState().project;
    expect(project.panoramaAssetId).toBeNull();
    expect(project.assets.some((asset) => asset.id === panoramaId)).toBe(false);
  });

  it("setAssetRealWorldSize matches a direct upsert_asset apply", () => {
    const assetId = useDirectorStore.getState().addImportedAsset({
      kind: "prop",
      sourceType: "model",
      name: "Sized prop",
      fileName: "sized-prop.glb",
      url: "https://example.com/sized-prop.glb",
      assetSource: "local",
      addToScene: false,
    });
    const asset = useDirectorStore.getState().project.assets.find((item) => item.id === assetId)!;
    const nextAsset = { ...asset, realWorldSizeM: 2.5, sizeSource: "user" as const };
    const agentRevision = agentRevisionFor([{ action: "upsert_asset", asset: structuredClone(nextAsset) }]);

    useDirectorStore.getState().setAssetRealWorldSize(assetId, 2.5, "user");

    expect(storeRevision()).toBe(agentRevision);
    expect(useDirectorStore.getState().project.assets.find((item) => item.id === assetId)).toMatchObject({
      realWorldSizeM: 2.5,
      sizeSource: "user",
    });
  });
});

describe("clipboard paste parity", () => {
  beforeEach(() => {
    resetDirectorStore();
  });

  function copyObjects(ids: string[]) {
    useDirectorStore.getState().selectObjects(ids);
    useDirectorStore.getState().copySelectedObjects();
  }

  function compileCurrentPaste() {
    const state = useDirectorStore.getState();
    return compileDirectorPasteClipboardActions(state.project, state.clipboard, state.clipboardPasteCount);
  }

  function storeRevision() {
    return getDirectorProjectRevision(useDirectorStore.getState().project);
  }

  it("routes one-shot paste through the shared duplicate_objects dispatch with revision parity", () => {
    seedProp("paste-box", [1, 0, -2]);
    copyObjects(["paste-box"]);

    const action = compileCurrentPaste();
    expect(action).toEqual({ action: "duplicate_objects", object_ids: ["paste-box"], offset_m: 0.6 });
    const agentApplied = applyDirectorAuthoringActions(structuredClone(useDirectorStore.getState().project), [action!]);
    const agentRevision = getDirectorProjectRevision(agentApplied.project);

    useDirectorStore.getState().pasteClipboardObjects();

    expect(storeRevision()).toBe(agentRevision);
    const state = useDirectorStore.getState();
    const pastedId = agentApplied.created.object_ids[0];
    expect(state.clipboardPasteCount).toBe(1);
    expect(state.selectedObjectIds).toEqual([pastedId]);
    expect(state.selectedObjectId).toBe(pastedId);
    expect(state.project.objects.find((object) => object.id === pastedId)?.transform.position).toEqual([1.6, 0, -1.4]);
  });

  it("grows the offset on repeated paste exactly like the legacy clipboard writer", () => {
    seedProp("offset-box", [0, 0, 0]);
    copyObjects(["offset-box"]);

    useDirectorStore.getState().pasteClipboardObjects();
    useDirectorStore.getState().pasteClipboardObjects();

    const state = useDirectorStore.getState();
    expect(state.clipboardPasteCount).toBe(2);
    const secondPastedId = state.selectedObjectIds[0];
    expect(state.project.objects.find((object) => object.id === secondPastedId)?.transform.position).toEqual([
      1.2, 0, 1.2,
    ]);
  });

  it("pastes a character through the shared path with the sequential rename and re-keyed native source", () => {
    copyObjects(["char_default_a"]);

    const action = compileCurrentPaste();
    expect(action).not.toBeNull();
    const agentApplied = applyDirectorAuthoringActions(structuredClone(useDirectorStore.getState().project), [action!]);
    const agentRevision = getDirectorProjectRevision(agentApplied.project);

    useDirectorStore.getState().pasteClipboardObjects();

    expect(storeRevision()).toBe(agentRevision);
    const pastedId = agentApplied.created.object_ids[0];
    const pasted = useDirectorStore.getState().project.objects.find((object) => object.id === pastedId);
    expect(pasted?.name).toBe("角色02");
    expect(pasted?.nativeSource).toEqual({ engine: "blender", objectId: pastedId, provisioned: false });
  });

  it("pastes a camera rig through the shared path, resets captures, and activates the duplicate", () => {
    const rigId = useDirectorStore.getState().project.objects.find((object) => object.kind === "camera")!.id;
    copyObjects([rigId]);

    const action = compileCurrentPaste();
    expect(action).not.toBeNull();
    const agentApplied = applyDirectorAuthoringActions(structuredClone(useDirectorStore.getState().project), [action!]);
    const agentRevision = getDirectorProjectRevision(agentApplied.project);

    useDirectorStore.getState().pasteClipboardObjects();

    expect(storeRevision()).toBe(agentRevision);
    const project = useDirectorStore.getState().project;
    const pastedCameraId = agentApplied.created.camera_ids[0];
    expect(project.activeCameraId).toBe(pastedCameraId);
    const pastedCamera = project.cameras.find((camera) => camera.id === pastedCameraId);
    expect(pastedCamera?.captures).toEqual([]);
    expect(pastedCamera?.lastCaptureUrl).toBeNull();
  });

  it("keeps the legacy writer for stale clipboard snapshots and still pastes copy-time state", () => {
    seedProp("stale-box", [1, 0, -2]);
    copyObjects(["stale-box"]);
    useDirectorStore.getState().updateObjectTransform("stale-box", { position: [5, 0, 5] });

    expect(compileCurrentPaste()).toBeNull();

    useDirectorStore.getState().pasteClipboardObjects();

    const state = useDirectorStore.getState();
    const pastedId = state.selectedObjectIds[0];
    // The legacy fallback pastes the copy-time transform, not the live one.
    expect(state.project.objects.find((object) => object.id === pastedId)?.transform.position).toEqual([1.6, 0, -1.4]);
    expect(state.clipboardPasteCount).toBe(1);
  });

  it("keeps the legacy writer when an object-focused camera targets the copied source", () => {
    seedProp("focus-box", [2, 0, 1]);
    const cameraId = useDirectorStore.getState().project.activeCameraId!;
    useDirectorStore.getState().updateCamera(cameraId, { targetMode: "object", targetObjectId: "focus-box" });
    copyObjects(["focus-box"]);

    expect(compileCurrentPaste()).toBeNull();

    useDirectorStore.getState().pasteClipboardObjects();

    const state = useDirectorStore.getState();
    const pastedId = state.selectedObjectIds[0];
    expect(pastedId).toBeTruthy();
    // Legacy semantics retained: the existing camera follows the duplicate.
    expect(state.project.cameras.find((camera) => camera.id === cameraId)?.targetObjectId).toBe(pastedId);
  });

  it("keeps the legacy writer inside slider/gizmo undo batches", () => {
    seedProp("batch-box", [0, 0, 0]);
    copyObjects(["batch-box"]);

    useDirectorStore.getState().beginUndoBatch();
    useDirectorStore.getState().pasteClipboardObjects();
    useDirectorStore.getState().endUndoBatch();

    const state = useDirectorStore.getState();
    expect(state.selectedObjectIds).toHaveLength(1);
    expect(state.project.objects.some((object) => object.id === state.selectedObjectIds[0])).toBe(true);
    expect(state.clipboardPasteCount).toBe(1);
  });
});

describe("timeline audio parity", () => {
  beforeEach(() => {
    resetDirectorStore();
  });

  function storeRevision() {
    return getDirectorProjectRevision(useDirectorStore.getState().project);
  }

  it("routes one-shot timeline audio edits through shared authoring with revision parity", () => {
    const clipId = useDirectorStore.getState().addTimelineAudioClip({
      mediaId: "creative-media:audio:parity",
      name: "对等音效",
      durationFrames: 36,
      startFrame: 6,
    });
    expect(clipId).toBeTruthy();

    const afterAdd = structuredClone(useDirectorStore.getState().project);
    const agentMove = applyDirectorAuthoringActions(afterAdd, [
      { action: "update_timeline_audio_clip", clip_id: clipId!, patch: { startFrame: 18 } },
    ]);
    const agentRevision = getDirectorProjectRevision(agentMove.project);

    useDirectorStore.getState().moveTimelineAudioClip(clipId!, 18);
    expect(storeRevision()).toBe(agentRevision);

    const trackId = useDirectorStore.getState().project.scene.timeline!.audioTracks![0]!.id;
    const agentMute = applyDirectorAuthoringActions(structuredClone(useDirectorStore.getState().project), [
      { action: "set_timeline_audio_track_muted", track_id: trackId, muted: true },
    ]);
    useDirectorStore.getState().setTimelineAudioTrackMuted(trackId, true);
    expect(storeRevision()).toBe(getDirectorProjectRevision(agentMute.project));

    const agentRemove = applyDirectorAuthoringActions(structuredClone(useDirectorStore.getState().project), [
      { action: "remove_timeline_audio_clips", clip_ids: [clipId!] },
    ]);
    useDirectorStore.getState().removeTimelineAudioClip(clipId!);
    expect(storeRevision()).toBe(getDirectorProjectRevision(agentRemove.project));
    expect(useDirectorStore.getState().project.scene.timeline!.audioTracks![0]!.clips).toEqual([]);
  });
});
