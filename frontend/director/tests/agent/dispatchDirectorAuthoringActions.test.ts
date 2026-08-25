import { beforeEach, describe, expect, it } from "vitest";
import { applyDirectorAuthoringActions } from "@director/agent-engine/authoring";
import {
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getDirectorProjectRevision,
  getVerticalFovFromFocalLength,
  type DirectorWorldRoad,
} from "@director/project-schema";
import {
  createInitialDirectorState,
  useDirectorStore,
} from "../../src/comprehensive/editor/store/directorStore";
import {
  compileDirectorDeleteObjectActions,
  dispatchDirectorAuthoringActions,
} from "../../src/agent/dispatchDirectorAuthoringActions";

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

  it("matches set_object_list revision when store object-list mutators manage a named list", () => {
    seedProp("list-box-a");
    seedProp("list-box-b", [1, 0, 0]);
    const before = structuredClone(useDirectorStore.getState().project);

    const agentApplied = applyDirectorAuthoringActions(before, [
      { action: "set_object_list", list_id: "object_list_1", object_ids: ["list-box-a", "list-box-b"], label: "道具组" },
    ]);
    useDirectorStore.getState().applyAuthoredProject(agentApplied.project);
    const agentRevision = getDirectorProjectRevision(useDirectorStore.getState().project);

    useDirectorStore.getState().applyAuthoredProject(structuredClone(before));
    const listId = useDirectorStore.getState().createObjectList(["list-box-a", "list-box-b"], "道具组");

    expect(listId).toBe("object_list_1");
    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).toBe(agentRevision);

    useDirectorStore.getState().updateObjectListLabel("object_list_1", "主镜头道具");
    expect(
      useDirectorStore
        .getState()
        .project.objects.filter((object) => object.objectListId === "object_list_1")
        .every((object) => object.objectListLabel === "主镜头道具"),
    ).toBe(true);

    seedProp("list-box-c", [2, 0, 0]);
    useDirectorStore.getState().addObjectsToObjectList(["list-box-c"], "object_list_1");
    expect(
      useDirectorStore.getState().project.objects.find((object) => object.id === "list-box-c")?.objectListLabel,
    ).toBe("主镜头道具");

    useDirectorStore.getState().removeObjectsFromObjectList(["list-box-a"]);
    const removed = useDirectorStore.getState().project.objects.find((object) => object.id === "list-box-a");
    expect(removed?.objectListId).toBeUndefined();
    expect(removed?.objectListDetached).toBe(true);

    useDirectorStore.getState().undo();
    expect(useDirectorStore.getState().project.objects.find((object) => object.id === "list-box-a")?.objectListId).toBe(
      "object_list_1",
    );
  });

  it("routes store.addObjectFromAsset through add_object_from_asset with the provisioning marker", () => {
    const seeded = applyDirectorAuthoringActions(useDirectorStore.getState().project, [
      {
        action: "upsert_asset",
        asset: {
          id: "local:user-crate",
          kind: "prop",
          sourceType: "model",
          fileName: "crate.glb",
          url: "blob:director-user-crate",
          assetSource: "local",
        },
      },
    ]);
    useDirectorStore.getState().applyAuthoredProject(seeded.project);

    const objectId = useDirectorStore.getState().addObjectFromAsset("local:user-crate");

    expect(objectId).not.toBeNull();
    const object = useDirectorStore.getState().project.objects.find((item) => item.id === objectId);
    expect(object).toMatchObject({
      name: "crate",
      kind: "prop",
      assetRefId: "local:user-crate",
      nativeSource: { engine: "blender", objectId, provisioned: false },
    });
    expect(useDirectorStore.getState().selectedObjectId).toBe(objectId);

    expect(useDirectorStore.getState().addObjectFromAsset("local:missing")).toBeNull();
  });

  it("keeps per-add body types and the rotating palette when store.addPresetCharacter dispatches", () => {
    useDirectorStore.getState().addPresetCharacter("female");
    useDirectorStore.getState().addPresetCharacter("teen");

    const characters = useDirectorStore
      .getState()
      .project.objects.filter((object) => object.kind === "character" && object.id.startsWith("char_preset_"));
    // The default role counts toward the sequential index, matching the
    // historical local mutator: the first preset add lands on char_preset_2.
    expect(characters.map((object) => object.id)).toEqual(["char_preset_2", "char_preset_3"]);
    expect(characters.map((object) => object.bodyType)).toEqual(["female", "teen"]);
    expect(characters.every((object) => object.assetRefId === "mixamo:x-bot")).toBe(true);
    expect(characters.every((object) => object.characterSource === "asset")).toBe(true);
    const allCharacters = useDirectorStore.getState().project.objects.filter((object) => object.kind === "character");
    expect(new Set(allCharacters.map((object) => object.color)).size).toBe(allCharacters.length);
    expect(useDirectorStore.getState().project.assets.some((asset) => asset.id === "mixamo:x-bot")).toBe(true);
    expect(useDirectorStore.getState().selectedObjectId).toBe("char_preset_3");
  });

  it("dispatches store.addCrowdCharacters as one authored batch with crowd grouping and one undo entry", () => {
    const undoDepthBefore = useDirectorStore.getState().undoStack.length;

    const createdIds = useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1 });

    expect(createdIds).toHaveLength(4);
    const members = useDirectorStore
      .getState()
      .project.objects.filter((object) => createdIds.includes(object.id));
    expect(members).toHaveLength(4);
    expect(members.every((object) => object.crowdId === "crowd_1")).toBe(true);
    expect(members.every((object) => object.crowdLabel === "群众（2x2）")).toBe(true);
    expect(useDirectorStore.getState().undoStack.length).toBe(undoDepthBefore + 1);
    expect(useDirectorStore.getState().selectedCrowdId).toBe("crowd_1");

    useDirectorStore.getState().undo();
    expect(
      useDirectorStore.getState().project.objects.some((object) => createdIds.includes(object.id)),
    ).toBe(false);
  });

  it("keeps the exact viewport FOV and sequential ids when store.addCameraShot dispatches", () => {
    const snapshotFov = 48.735021;

    const cameraId = useDirectorStore.getState().addCameraShot({
      fov: snapshotFov,
      position: [0, 2, 8],
      target: [0, 1, 0],
    });

    expect(cameraId).toBe("cam_2");
    const camera = useDirectorStore.getState().project.cameras.find((item) => item.id === "cam_2");
    expect(camera?.fov).toBe(snapshotFov);
    expect(useDirectorStore.getState().project.activeCameraId).toBe("cam_2");
    const rig = useDirectorStore.getState().project.objects.find((item) => item.linkedCameraId === "cam_2");
    expect(rig?.id).toBe("cam_object_2");
    expect(useDirectorStore.getState().selectedObjectId).toBe("cam_object_2");
  });
});
