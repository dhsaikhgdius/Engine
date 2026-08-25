import { afterEach, beforeEach, vi } from "vitest";
import {
  createDefaultDirectorProject,
  createInitialDirectorState,
  selectDirectorCanRedo,
  selectDirectorCanUndo,
  useDirectorStore,
} from "../../../../src/comprehensive/editor/store/directorStore";
import { selectRightPanelKind } from "../../../../src/comprehensive/editor/store/directorSelectors";
import {
  getCameraRigPositionFromViewSnapshot,
  getVerticalFovFromFocalLength,
} from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import {
  getDirectorCharacterAssetBindingIssues,
  getMixamoCharacterCatalogItem,
} from "../../../../src/comprehensive/editor/modelLibrary/mixamoCharacterCatalog";
import {
  isDirectorObjectEffectivelyLocked,
  isDirectorObjectEffectivelyVisible,
} from "../../../../src/comprehensive/editor/schema/objectLayers";
import { BLENDER_LIVE_CONTRACT } from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { getDirectorProjectRevision } from "@director/project-schema";

const applyBlenderRuntimeOperationsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/comprehensive/editor/runtime/blenderRuntimeTransactions", () => ({
  applyBlenderRuntimeOperations: applyBlenderRuntimeOperationsMock,
}));

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
  };
}

beforeEach(() => {
  applyBlenderRuntimeOperationsMock.mockReset();
  vi.stubGlobal("localStorage", createMemoryStorage());
  useDirectorStore.getState().openScopedScene(null);
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("seeds the demo with one mannequin role and one camera", () => {
  const state = createInitialDirectorState();
  const defaultCharacter = state.project.objects.find((item) => item.kind === "character");
  const defaultCameraObject = state.project.objects.find((item) => item.kind === "camera");

  expect(state.viewMode).toBe("director");
  expect(state.viewportAspectRatio).toBe("auto");
  expect(state.viewportLayout).toBe("single");
  expect(state.viewportRuleOfThirdsEnabled).toBe(false);
  expect(state.project.scene.backgroundColor).toBe("#c9cdd3");
  expect(defaultCharacter?.name).toBe("角色01");
  expect(defaultCameraObject?.name).toBe("机位01");
  expect(state.project.cameras[0]?.name).toBe("机位01");
  expect(state.project.objects.some((item) => item.kind === "character")).toBe(true);
  expect(state.project.cameras).toHaveLength(1);
});

it("binds one managed modeling scene and reconciles its roots into the Director object tree", () => {
  const store = useDirectorStore.getState();
  const projectId = store.ensureNativeSceneBinding();
  expect(store.ensureNativeSceneBinding()).toBe(projectId);

  const snapshot = {
    contract: BLENDER_LIVE_CONTRACT,
    projectId,
    sceneEpoch: "scene-epoch-a",
    revision: 3,
    contentRevision: 2,
    sceneName: "Director scene",
    frame: 1,
    unit: "meter" as const,
    coordinateSystem: "right-handed-y-up-negative-z-forward" as const,
    objects: [
      {
        id: "asset-root",
        name: "Lobby set",
        type: "EMPTY",
        kind: "object",
        position: [2, 0, -1] as [number, number, number],
        rotation: [0, 0.5, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
        localTransform: {
          position: [2, 0, -1] as [number, number, number],
          rotation: [0, 0.5, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        dimensions: [4, 3, 5] as [number, number, number],
        localBounds: {
          min: [-2, 0, -2.5] as [number, number, number],
          max: [2, 3, 2.5] as [number, number, number],
        },
        visible: true,
        collections: ["Collection"],
        parentId: null,
        modifierCount: 0,
        constraints: [],
      },
      {
        id: "asset-mesh",
        name: "Lobby mesh",
        type: "MESH",
        kind: "object",
        position: [2, 0, -1] as [number, number, number],
        rotation: [0, 0.5, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
        localTransform: {
          position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        dimensions: [4, 3, 5] as [number, number, number],
        visible: true,
        collections: ["Collection"],
        parentId: "asset-root",
        modifierCount: 0,
        constraints: [],
      },
    ],
    cameras: [
      {
        id: "native-camera-a",
        name: "Blender hero camera",
        position: [8, 3, 6] as [number, number, number],
        rotation: [0, 0.5, 0] as [number, number, number],
        projectionType: "PERSPECTIVE" as const,
        focalLengthMm: 50,
        sensorFit: "HORIZONTAL" as const,
        sensorWidthMm: 36,
        sensorHeightMm: 24,
        shiftX: 0,
        shiftY: 0,
        clipStart: 0.1,
        clipEnd: 2_000,
        orthographicScale: 10,
        active: true,
      },
    ],
    lights: [
      {
        id: "native-light-a",
        name: "Blender key",
        kind: "area" as const,
        position: [4, 6, 2] as [number, number, number],
        rotation: [0.4, 0.2, 0] as [number, number, number],
        color: [1, 0.5, 0.25] as [number, number, number],
        energy: 1_500,
        size: 3,
        visible: true,
      },
    ],
    selectedObjectIds: [],
    activeObjectId: null,
  };

  store.syncBlenderScene(snapshot);
  expect(useDirectorStore.getState().project.nativeScene).toEqual({
    engine: "blender",
    projectId,
    sceneEpoch: "scene-epoch-a",
    revision: 3,
    contentRevision: 2,
  });
  expect(useDirectorStore.getState().project.objects.filter((object) => object.id === "native:asset-root")).toEqual([
    expect.objectContaining({
      id: "native:asset-root",
      name: "Lobby set",
      placementMode: "floating",
      transform: { position: [2, 0, -1], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
      nativeSource: { engine: "blender", objectId: "asset-root", provisioned: true },
      localBoundsM: { min: [-2, 0, -2.5], max: [2, 3, 2.5] },
    }),
  ]);
  expect(useDirectorStore.getState().undoStack).toEqual([]);
  expect(useDirectorStore.getState().project.activeCameraId).toBe("native-camera:native-camera-a");
  expect(
    useDirectorStore.getState().project.cameras.find((camera) => camera.nativeSource?.objectId === "native-camera-a"),
  ).toMatchObject({
    id: "native-camera:native-camera-a",
    name: "Blender hero camera",
    focalLengthMm: 50,
    projectionType: "perspective",
    nativeSource: { engine: "blender", objectId: "native-camera-a", provisioned: true },
  });
  expect(
    useDirectorStore
      .getState()
      .project.objects.find((object) => object.kind === "camera" && object.linkedCameraId === "native-camera:native-camera-a"),
  ).toMatchObject({
    id: "native-camera:native-camera-a-rig",
    name: "Blender hero camera",
    kind: "camera",
    linkedCameraId: "native-camera:native-camera-a",
  });
  expect(
    useDirectorStore.getState().project.lights?.find((light) => light.nativeSource?.objectId === "native-light-a"),
  ).toMatchObject({
    id: "native-light:native-light-a",
    name: "Blender key",
    type: "rect-area",
    intensity: 1.5,
    width: 3,
    height: 3,
    nativeSource: { engine: "blender", objectId: "native-light-a", provisioned: true },
  });

  const revisionBeforeNativeRefinement = getDirectorProjectRevision(useDirectorStore.getState().project);
  store.syncBlenderScene({ ...snapshot, revision: 4, contentRevision: 4 });
  expect(useDirectorStore.getState().project.nativeScene).toMatchObject({ revision: 4, contentRevision: 4 });
  expect(getDirectorProjectRevision(useDirectorStore.getState().project)).not.toBe(revisionBeforeNativeRefinement);
  expect(useDirectorStore.getState().undoStack).toEqual([]);

  store.syncBlenderScene({ ...snapshot, revision: 5, contentRevision: 5, objects: [] });
  expect(useDirectorStore.getState().project.objects.some((object) => object.id === "native:asset-root")).toBe(false);
  expect(
    useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a")?.nativeSource,
  ).toEqual({ engine: "blender", objectId: "char_default_a", provisioned: false });
});

it("puts Blender cameras into the object tree even when the native revision is unchanged", () => {
  const store = useDirectorStore.getState();
  const projectId = store.ensureNativeSceneBinding();
  const snapshot = {
    contract: BLENDER_LIVE_CONTRACT,
    projectId,
    sceneEpoch: "scene-epoch-cameras",
    revision: 2,
    contentRevision: 2,
    sceneName: "Director scene",
    frame: 1,
    unit: "meter" as const,
    coordinateSystem: "right-handed-y-up-negative-z-forward" as const,
    objects: [],
    cameras: [
      {
        id: "native-camera-a",
        name: "Blender hero camera",
        position: [8, 3, 6] as [number, number, number],
        rotation: [0, 0.5, 0] as [number, number, number],
        projectionType: "PERSPECTIVE" as const,
        focalLengthMm: 50,
        sensorFit: "HORIZONTAL" as const,
        sensorWidthMm: 36,
        sensorHeightMm: 24,
        shiftX: 0,
        shiftY: 0,
        clipStart: 0.1,
        clipEnd: 2_000,
        orthographicScale: 10,
        active: true,
      },
    ],
    lights: [],
    selectedObjectIds: [],
    activeObjectId: null,
  };

  store.syncBlenderScene(snapshot);
  const cameraId = "native-camera:native-camera-a";
  const current = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...current.project,
      objects: current.project.objects.filter((object) => object.kind !== "camera"),
    },
  });
  expect(useDirectorStore.getState().project.objects.some((object) => object.kind === "camera")).toBe(false);

  store.syncBlenderScene(snapshot);

  const restored = useDirectorStore
    .getState()
    .project.objects.find((object) => object.kind === "camera" && object.linkedCameraId === cameraId);
  expect(restored).toMatchObject({
    id: `${cameraId}-rig`,
    name: "Blender hero camera",
    kind: "camera",
    linkedCameraId: cameraId,
  });
});

it("restores missing camera-rig objects when a persisted scene has cameras but no tree entries", () => {
  const base = createInitialDirectorState();
  const camera = base.project.cameras[0]!;
  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      ...base,
      project: {
        ...base.project,
        objects: base.project.objects.filter((object) => object.kind !== "camera"),
      },
    }),
  );

  useDirectorStore.getState().restoreLatestSnapshot();

  expect(
    useDirectorStore
      .getState()
      .project.objects.some((object) => object.kind === "camera" && object.linkedCameraId === camera.id),
  ).toBe(true);
});

it("keeps Director projections authoritative, adopts direct Blender transforms, and undoes them in order", async () => {
  const store = useDirectorStore.getState();
  const projectId = store.ensureNativeSceneBinding();
  const character = useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a")!;
  const snapshot = {
    contract: BLENDER_LIVE_CONTRACT,
    projectId,
    sceneEpoch: "scene-epoch-a",
    revision: 1,
    sceneName: "Director scene",
    frame: 1,
    unit: "meter" as const,
    coordinateSystem: "right-handed-y-up-negative-z-forward" as const,
    objects: [
      {
        id: "char_default_a",
        directorId: character.id,
        name: character.name,
        type: "EMPTY",
        kind: "object" as const,
        position: [12, 2, 3] as [number, number, number],
        rotation: [0, -2.9, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
        localTransform: {
          position: [12, 2, 3] as [number, number, number],
          rotation: [0, -2.9, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        dimensions: [1, 1.78, 1] as [number, number, number],
        visible: true,
        collections: ["Collection"],
        parentId: null,
        modifierCount: 0,
        constraints: [],
      },
    ],
    cameras: [],
    lights: [],
    selectedObjectIds: [],
    activeObjectId: null,
  };

  store.syncBlenderScene(snapshot);
  store.prepareBlenderSync({ sceneEpoch: snapshot.sceneEpoch, revision: 2, origin: "director-projection" });
  store.syncBlenderScene({
    ...snapshot,
    revision: 2,
    objects: snapshot.objects.map((object) => ({
      ...object,
      position: [24, 4, 6] as [number, number, number],
      localTransform: { ...object.localTransform, position: [24, 4, 6] as [number, number, number] },
    })),
  });

  expect(useDirectorStore.getState().project.objects.find((object) => object.id === character.id)).toMatchObject({
    transform: character.transform,
    nativeSource: { engine: "blender", objectId: "char_default_a", provisioned: true },
  });

  store.syncBlenderScene({
    ...snapshot,
    revision: 3,
    objects: snapshot.objects.map((object) => ({
      ...object,
      position: [6, 1, -2] as [number, number, number],
      localTransform: { ...object.localTransform, position: [6, 1, -2] as [number, number, number] },
    })),
  });

  expect(useDirectorStore.getState().project.objects.find((object) => object.id === character.id)).toMatchObject({
    transform: { position: [6, 1, -2], rotation: [0, -2.9, 0], scale: [1, 1, 1] },
  });
  expect(useDirectorStore.getState().historyUndoStack.at(-1)).toMatchObject({
    domain: "blender",
    projectId,
    sceneEpoch: snapshot.sceneEpoch,
  });

  const undoSnapshot = {
    ...snapshot,
    revision: 4,
    objects: snapshot.objects.map((object) => ({
      ...object,
      position: [...character.transform.position] as [number, number, number],
      rotation: [...character.transform.rotation] as [number, number, number],
      scale: [...character.transform.scale] as [number, number, number],
      localTransform: {
        ...object.localTransform,
        position: [...character.transform.position] as [number, number, number],
        rotation: [...character.transform.rotation] as [number, number, number],
        scale: [...character.transform.scale] as [number, number, number],
      },
    })),
  };
  applyBlenderRuntimeOperationsMock.mockImplementationOnce(async (options) => {
    const result = {
      receipt: { sceneEpoch: snapshot.sceneEpoch, revisionAfter: 4 },
      projectedSnapshot: undoSnapshot,
    };
    options.beforePublish?.(result);
    return result;
  });

  useDirectorStore.getState().undo();

  await vi.waitFor(() => {
    expect(useDirectorStore.getState().historyRedoStack.at(-1)).toMatchObject({ domain: "blender" });
  });

  expect(applyBlenderRuntimeOperationsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedSceneEpoch: snapshot.sceneEpoch,
      expectedRevision: 3,
      operations: [{ op: "undo_scene" }],
    }),
  );
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === character.id)?.transform).toEqual(
    character.transform,
  );
});

it("persists measured object bounds without creating a user undo step", () => {
  const object = useDirectorStore.getState().project.objects.find((candidate) => candidate.kind === "character")!;
  const bounds = {
    min: [-0.4, 0, -0.25] as [number, number, number],
    max: [0.4, 1.8, 0.25] as [number, number, number],
  };

  useDirectorStore.getState().setObjectMeasuredLocalBounds(object.id, bounds);

  expect(
    useDirectorStore.getState().project.objects.find((candidate) => candidate.id === object.id)?.localBoundsM,
  ).toEqual(bounds);
  expect(useDirectorStore.getState().undoStack).toEqual([]);
});

it("reprovisions Director assets instead of deleting them when a native project is rebound", () => {
  const store = useDirectorStore.getState();
  const projectId = store.ensureNativeSceneBinding();
  const state = useDirectorStore.getState();
  const character = state.project.objects.find((object) => object.id === "char_default_a")!;
  expect(state.project.assets.some((asset) => asset.id === character.assetRefId && asset.sourceType === "model")).toBe(
    true,
  );
  useDirectorStore.setState({
    project: {
      ...state.project,
      objects: state.project.objects.map((object) =>
        object.id === character.id
          ? {
              ...object,
              nativeSource: { engine: "blender" as const, objectId: character.id, provisioned: true },
            }
          : object,
      ),
    },
    selectedObjectId: character.id,
    selectedObjectIds: [character.id],
  });

  store.syncBlenderScene({
    contract: BLENDER_LIVE_CONTRACT,
    projectId,
    sceneEpoch: "rebound-epoch",
    revision: 1,
    sceneName: "Rebound project",
    frame: 1,
    unit: "meter",
    coordinateSystem: "right-handed-y-up-negative-z-forward",
    objects: [],
    cameras: [],
    lights: [],
    selectedObjectIds: [],
    activeObjectId: null,
  });

  const next = useDirectorStore.getState();
  expect(next.project.objects.find((object) => object.id === character.id)?.nativeSource).toEqual({
    engine: "blender",
    objectId: character.id,
    provisioned: false,
  });
  expect(next.selectedObjectId).toBe(character.id);
  expect(next.selectedObjectIds).toEqual([character.id]);
});

it("updates the viewport aspect ratio selection in ui state", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().setViewportAspectRatio("9:16");

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("9:16");
});

it("persists the single or quad viewport layout as editor UI state", () => {
  useDirectorStore.setState(createInitialDirectorState());
  expect(useDirectorStore.getState().viewportLayout).toBe("single");
  useDirectorStore.getState().toggleViewportLayout();
  expect(useDirectorStore.getState().viewportLayout).toBe("quad");
  useDirectorStore.getState().setViewportLayout("single");
  expect(useDirectorStore.getState().viewportLayout).toBe("single");
});

it("updates the viewport rule-of-thirds guide toggle in ui state", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().setViewportRuleOfThirdsEnabled(true);

  expect(useDirectorStore.getState().viewportRuleOfThirdsEnabled).toBe(true);
});

it("toggles the viewport side panel collapse flag in ui state", () => {
  useDirectorStore.setState(createInitialDirectorState());

  type CollapseUiState = ReturnType<typeof useDirectorStore.getState> & {
    viewportPanelsCollapsed?: boolean;
    toggleViewportPanelsCollapsed?: () => void;
  };
  const state = useDirectorStore.getState() as CollapseUiState;

  expect(state.viewportPanelsCollapsed ?? false).toBe(false);

  state.toggleViewportPanelsCollapsed?.();

  expect((useDirectorStore.getState() as CollapseUiState).viewportPanelsCollapsed ?? false).toBe(true);
});

it("routes the right panel by object type and view mode", () => {
  const state = createInitialDirectorState();
  const characterId = state.project.objects.find((item) => item.kind === "character")!.id;
  const cameraObjectId = state.project.objects.find((item) => item.kind === "camera")!.id;
  const propState = {
    ...state,
    selectedObjectId: "prop_model_1",
    project: {
      ...state.project,
      objects: [
        ...state.project.objects,
        {
          id: "prop_model_1",
          name: "自动取款机",
          kind: "prop" as const,
          visible: true,
          locked: false,
          assetRefId: "asset_model_1",
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
        },
      ],
      assets: [
        ...state.project.assets,
        {
          id: "asset_model_1",
          kind: "prop" as const,
          sourceType: "model" as const,
          fileName: "ATM_low.fbx",
          url: "blob:atm",
        },
      ],
    },
  };

  expect(selectRightPanelKind(state)).toBe("scene");
  expect(selectRightPanelKind({ ...state, selectedObjectId: characterId })).toBe("character");
  expect(selectRightPanelKind({ ...state, selectedObjectId: cameraObjectId })).toBe("camera");
  expect(selectRightPanelKind(propState)).toBe("prop");
  expect(selectRightPanelKind({ ...state, viewMode: "camera", selectedObjectId: null })).toBe("camera");
});

it("routes a selected crowd group to the role panel", () => {
  const state = createInitialDirectorState();

  expect(selectRightPanelKind({ ...state, selectedCrowdId: "crowd_1" })).toBe("character");
});

it("routes older model-backed scene objects to the model panel", () => {
  const state = createInitialDirectorState();

  expect(
    selectRightPanelKind({
      ...state,
      selectedObjectId: "obj_scene_model_1",
      project: {
        ...state.project,
        assets: [
          {
            id: "asset_scene_model_1",
            kind: "scene",
            sourceType: "model",
            fileName: "microwave_low.fbx",
            url: "blob:microwave",
          },
        ],
        objects: [
          ...state.project.objects,
          {
            id: "obj_scene_model_1",
            name: "微波炉",
            kind: "scene",
            visible: true,
            locked: false,
            assetRefId: "asset_scene_model_1",
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
          },
        ],
      },
    }),
  ).toBe("prop");
});

it("defaults generated characters to the male mannequin body type", () => {
  const project = createDefaultDirectorProject();
  const character = project.objects.find((item) => item.kind === "character");

  expect(character?.bodyType).toBe("mannequin");
  expect(character).toMatchObject({ characterSource: "asset", assetRefId: "mixamo:x-bot" });
});

it("adds preset characters with a requested body type", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addPresetCharacter("female");

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  const added = characters[characters.length - 1];

  expect(added?.bodyType).toBe("female");
  expect(added?.name).toBe("角色02");
  expect(added).toMatchObject({ characterSource: "asset", assetRefId: "mixamo:x-bot" });
  expect(added?.characterRig?.rigType).toBe("mixamo");
  expect(useDirectorStore.getState().selectedObjectId).toBe(added?.id);
});

it("allows the core Human library entry to use its reference ochre default", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addPresetCharacter(undefined, "#d19a3a");

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  expect(characters[characters.length - 1]?.color).toBe("#d19a3a");
});

it("adds camera shots with two-digit camera names", () => {
  useDirectorStore.setState(createInitialDirectorState());
  useDirectorStore.getState().updateCamera("cam_1", { aspectRatio: "9:16" });

  useDirectorStore.getState().addCameraShot();

  const state = useDirectorStore.getState();

  expect(state.project.cameras.map((camera) => camera.name)).toEqual(["机位01", "机位02"]);
  expect(state.project.cameras[1]?.aspectRatio).toBe("16:9");
  expect(state.project.objects.filter((item) => item.kind === "camera").map((item) => item.name)).toEqual([
    "机位01",
    "机位02",
  ]);
});

it("activating a camera selects its physical rig and opens the camera inspector", () => {
  const state = createInitialDirectorState();
  const camera = state.project.cameras[0]!;
  const cameraObject = state.project.objects.find((item) => item.linkedCameraId === camera.id)!;

  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...state,
    directorInspectorMode: "scene",
  });

  useDirectorStore.getState().setActiveCamera(camera.id);

  const nextState = useDirectorStore.getState();
  expect(nextState.project.activeCameraId).toBe(camera.id);
  expect(nextState.selectedObjectId).toBe(cameraObject.id);
  expect(nextState.selectedObjectIds).toEqual([cameraObject.id]);
  expect(nextState.directorInspectorMode).toBe("auto");
  expect(selectRightPanelKind(nextState)).toBe("camera");
});

it("routes camera optics updates through shared authoring as one undoable edit", () => {
  const before = useDirectorStore.getState().project.cameras[0]!;
  const fov = getVerticalFovFromFocalLength(85, before.aspectRatio, before.sensorFormat);

  useDirectorStore.getState().updateCamera(before.id, { focalLengthMm: 85, fov });

  const camera = useDirectorStore.getState().project.cameras[0]!;
  expect(camera.focalLengthMm).toBe(85);
  expect(camera.fov).toBeCloseTo(fov, 6);
  expect(selectDirectorCanUndo(useDirectorStore.getState())).toBe(true);

  useDirectorStore.getState().undo();
  expect(useDirectorStore.getState().project.cameras[0]?.focalLengthMm).toBe(before.focalLengthMm);
});

it("applies pose presets through shared authoring while keeping the preset identity", () => {
  const character = useDirectorStore.getState().project.objects.find((item) => item.kind === "character")!;

  useDirectorStore.getState().applyPosePreset(character.id, "sit");

  const rig = useDirectorStore.getState().project.objects.find((item) => item.id === character.id)?.characterRig;
  expect(rig?.posePresetId).toBe("sit");
  expect(selectDirectorCanUndo(useDirectorStore.getState())).toBe(true);

  useDirectorStore.getState().undo();
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === character.id)?.characterRig?.posePresetId,
  ).toBe("stand");
});

it("uses the reference ochre default and gives newly added characters distinct colors", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().addPresetCharacter("teen");

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");

  expect(characters[0].color).toBe("#d19a3a");
  expect(new Set(characters.map((item) => item.color)).size).toBe(characters.length);
});

it("places newly added preset characters far enough from the default role to avoid overlap", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().addPresetCharacter("teen");

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  const defaultRole = characters.find((item) => item.id === "char_default_a");
  const role02 = characters.find((item) => item.name === "角色02");
  const role03 = characters.find((item) => item.name === "角色03");

  expect(defaultRole?.transform.position).toEqual([0, 0, 0]);
  expect(role02?.transform.position).toEqual([-1.25, 0, 0]);
  expect(role03?.transform.position).toEqual([1.25, 0, 0]);
});

it("adds selected geometry primitives as light blue-white prop objects", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addGeometryPrimitive("torus");

  const prop = useDirectorStore.getState().project.objects.find((item) => item.kind === "prop");

  expect(prop?.name).toBe("环状体");
  expect(prop?.geometryType).toBe("torus");
  expect(prop?.color).toBe("#d7e7ff");
  expect(useDirectorStore.getState().selectedObjectId).toBe(prop?.id);
});

it("deletes the selected list object and linked camera data", () => {
  useDirectorStore.setState(createInitialDirectorState());
  useDirectorStore.getState().addCameraShot();

  expect(useDirectorStore.getState().project.cameras).toHaveLength(2);

  useDirectorStore.getState().deleteSelectedObject();

  const state = useDirectorStore.getState();

  expect(state.selectedObjectId).toBeNull();
  expect(state.project.objects.some((item) => item.id === "cam_object_2")).toBe(false);
  expect(state.project.cameras.some((item) => item.id === "cam_2")).toBe(false);
  expect(state.project.activeCameraId).toBe("cam_1");
});

it("supports multi-selecting objects and deleting the selected set", () => {
  useDirectorStore.setState(createInitialDirectorState());
  useDirectorStore.getState().addPresetCharacter("female");

  useDirectorStore.getState().selectObject("char_default_a");
  useDirectorStore.getState().toggleObjectSelection("char_preset_2");

  expect(useDirectorStore.getState().selectedObjectId).toBe("char_preset_2");
  expect(useDirectorStore.getState().selectedObjectIds).toEqual(["char_default_a", "char_preset_2"]);

  useDirectorStore.getState().deleteSelectedObject();

  const state = useDirectorStore.getState();

  expect(state.selectedObjectId).toBeNull();
  expect(state.selectedObjectIds).toEqual([]);
  expect(state.project.objects.some((item) => item.id === "char_default_a")).toBe(false);
  expect(state.project.objects.some((item) => item.id === "char_preset_2")).toBe(false);
});

it("selects a lasso result as one multi-selection update", () => {
  useDirectorStore.setState(createInitialDirectorState());
  useDirectorStore.getState().addPresetCharacter("female");

  useDirectorStore.getState().selectObjects(["char_default_a", "char_preset_2", "missing"]);

  expect(useDirectorStore.getState().selectedObjectId).toBe("char_preset_2");
  expect(useDirectorStore.getState().selectedObjectIds).toEqual(["char_default_a", "char_preset_2"]);
});

it("keeps the project identity stable for a selection that does not change the active camera", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const project = useDirectorStore.getState().project;

  useDirectorStore.getState().selectObject("char_default_a");

  expect(useDirectorStore.getState().project).toBe(project);
});

it("updates multiple object transforms atomically and keeps linked cameras in sync", () => {
  const initial = useDirectorStore.getState();
  const character = initial.project.objects.find((object) => object.kind === "character")!;
  const cameraObject = initial.project.objects.find((object) => object.kind === "camera")!;

  initial.updateObjectTransforms([
    {
      id: character.id,
      transform: { ...character.transform, position: [2, 0, 1] },
    },
    {
      id: cameraObject.id,
      transform: { ...cameraObject.transform, position: [4, 3, 2] },
    },
  ]);

  const updated = useDirectorStore.getState();
  expect(updated.project.objects.find((object) => object.id === character.id)?.transform.position).toEqual([2, 0, 1]);
  expect(updated.project.objects.find((object) => object.id === cameraObject.id)?.transform.position).toEqual([
    4, 3, 2,
  ]);
  expect(
    updated.project.cameras.find((camera) => camera.id === cameraObject.linkedCameraId)?.transform.position,
  ).toEqual([4, 3, 2]);
  expect(updated.undoStack).toHaveLength(1);

  updated.undo();
  expect(
    useDirectorStore.getState().project.objects.find((object) => object.id === character.id)?.transform.position,
  ).toEqual(character.transform.position);
  expect(
    useDirectorStore.getState().project.objects.find((object) => object.id === cameraObject.id)?.transform.position,
  ).toEqual(cameraObject.transform.position);
});

it("updates a character body type without changing transform or color", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const character = useDirectorStore.getState().project.objects.find((item) => item.kind === "character");
  expect(character).toBeTruthy();

  useDirectorStore.getState().updateObjectColor(character!.id, "#123456");
  useDirectorStore.getState().updateObjectTransform(character!.id, { position: [1, 2, 3] });
  useDirectorStore.getState().updateCharacterBodyType(character!.id, "chibi");

  const updated = useDirectorStore.getState().project.objects.find((item) => item.id === character!.id);
  expect(updated?.bodyType).toBe("chibi");
  expect(updated?.color).toBe("#123456");
  expect(updated?.transform.position).toEqual([1, 2, 3]);
});

it("keeps imported local models separate from procedural body types", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "本地道具",
    fileName: "cube.obj",
    url: "blob:local-model",
  });

  const imported = useDirectorStore.getState().project.objects.find((item) => item.name === "本地道具");

  expect(imported?.kind).toBe("prop");
  expect(imported?.bodyType).toBeUndefined();
  expect(imported?.characterRig).toBeUndefined();
});

it("stores catalog metric sizes and lets users edit or clear an asset's real-world size", () => {
  useDirectorStore.setState(createInitialDirectorState());

  const assetId = useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "目录猫",
    fileName: "cat.glb",
    url: "blob:catalog-cat",
    realWorldSizeM: 0.8,
  });
  const findAsset = () => useDirectorStore.getState().project.assets.find((asset) => asset.id === assetId);
  expect(findAsset()).toMatchObject({ realWorldSizeM: 0.8, sizeSource: "catalog" });

  useDirectorStore.getState().setAssetRealWorldSize(assetId, 1.1);
  expect(findAsset()).toMatchObject({ realWorldSizeM: 1.1, sizeSource: "user" });

  useDirectorStore.getState().setAssetRealWorldSize(assetId, Number.NaN);
  expect(findAsset()).toMatchObject({ realWorldSizeM: 1.1, sizeSource: "user" });

  useDirectorStore.getState().setAssetRealWorldSize(assetId, null);
  expect(findAsset()?.realWorldSizeM).toBeUndefined();
  expect(findAsset()?.sizeSource).toBeUndefined();
});

it("preserves packaged Mixamo metadata and creates a grounded character object", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const characterMetadata = getMixamoCharacterCatalogItem("mixamo:abe")!.characterMetadata!;

  useDirectorStore.getState().addImportedAsset({
    kind: "character",
    id: "mixamo:abe",
    assetSource: "library",
    name: "Abe",
    fileName: "abe.glb",
    url: "/mixamo-characters/models/abe.glb",
    characterMetadata,
  });

  const state = useDirectorStore.getState();
  const importedObject = state.project.objects.find((item) => item.assetRefId === "mixamo:abe");
  const importedAsset = state.project.assets.find((item) => item.id === importedObject?.assetRefId);

  expect(importedAsset?.characterMetadata).toEqual(characterMetadata);
  expect(importedObject).toMatchObject({
    kind: "character",
    characterSource: "asset",
    placementMode: "grounded",
    characterRig: {
      rigType: "mixamo",
      posePresetId: "stand",
      controls: {},
    },
    transform: { position: [0, 0, 0] },
  });
});

it("applies the shared pose limits and clears stale preset identity for direct editing", () => {
  const store = useDirectorStore.getState();

  store.applyPosePreset("char_default_a", "wave");
  store.updatePoseControl("char_default_a", "leftShoulder.pitch", 999);
  store.updatePoseControl("char_default_a", "not-a-control", 12);

  const rig = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig;
  expect(rig?.posePresetId).toBeNull();
  expect(rig?.controls["leftShoulder.pitch"]).toBe(120);
  expect(rig?.controls["not-a-control"]).toBeUndefined();
});

it("clears stale pose preset identity when skeletal motion is authored", () => {
  const store = useDirectorStore.getState();
  store.applyPosePreset("char_default_a", "wave");
  store.setCharacterMotion("char_default_a", {
    clipId: "walk",
    enabled: true,
    loop: "repeat",
    speed: 1,
    weight: 1,
    startFrame: 0,
    blendInS: 0.12,
    blendOutS: 0,
    rootMotion: "in-place",
  });

  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig,
  ).toMatchObject({ posePresetId: null, motion: { clipId: "walk" } });
});

it("keeps imported model object ids unique after deleting an earlier model", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "模型A",
    fileName: "model-a.fbx",
    url: "blob:model-a",
  });
  const firstModelId = useDirectorStore.getState().selectedObjectId;

  useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "模型B",
    fileName: "model-b.fbx",
    url: "blob:model-b",
  });
  const secondModelId = useDirectorStore.getState().selectedObjectId;

  useDirectorStore.getState().selectObject(firstModelId);
  useDirectorStore.getState().deleteSelectedObject();

  useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "模型C",
    fileName: "model-c.fbx",
    url: "blob:model-c",
  });
  const thirdModelId = useDirectorStore.getState().selectedObjectId;
  const modelObjectIds = useDirectorStore
    .getState()
    .project.objects.filter((item) => item.kind === "prop" && item.assetRefId)
    .map((item) => item.id);

  expect(thirdModelId).not.toBe(secondModelId);
  expect(modelObjectIds).toHaveLength(2);
  expect(new Set(modelObjectIds).size).toBe(modelObjectIds.length);
});

it("adds a new camera from the current viewport snapshot", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addCameraShot({
    fov: 62,
    position: [4, 3, 2],
    target: [0.5, 1.1, -2],
  });

  const state = useDirectorStore.getState();
  const addedCamera = state.project.cameras[state.project.cameras.length - 1];
  const addedObject = state.project.objects.find((item) => item.linkedCameraId === addedCamera?.id);
  const rigPosition = getCameraRigPositionFromViewSnapshot({
    fov: 62,
    position: [4, 3, 2],
    target: [0.5, 1.1, -2],
  });

  expect(addedCamera?.fov).toBe(62);
  expect(addedCamera?.transform.position).toEqual(rigPosition);
  expect(addedCamera?.target).toEqual([0.5, 1.1, -2]);
  expect(addedObject?.transform.position).toEqual(rigPosition);
  expect(state.project.activeCameraId).toBe(addedCamera?.id);
  expect(state.selectedObjectId).toBe(addedObject?.id);
});

it("keeps object-focused cameras centered when the target model moves", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addGeometryPrimitive("box");
  const targetObject = useDirectorStore.getState().project.objects.find((item) => item.name === "立方体");
  expect(targetObject).toBeTruthy();

  useDirectorStore.getState().updateCamera("cam_1", {
    targetMode: "object",
    targetObjectId: targetObject!.id,
    target: [-1.725, 0.5, 1.15],
  });
  useDirectorStore.getState().updateObjectTransform(targetObject!.id, { position: [2, 0, -3] });

  const camera = useDirectorStore.getState().project.cameras[0];

  expect(camera.targetMode).toBe("object");
  expect(camera.targetObjectId).toBe(targetObject!.id);
  expect(camera.target).toEqual([2, 0.5, -3]);
});

it("appends camera captures with sequential camera-shot names", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addCameraCaptures("cam_1", ["data:image/png;base64,a"]);
  useDirectorStore.getState().addCameraCaptures("cam_1", ["data:image/png;base64,b", "data:image/png;base64,c"]);

  const camera = useDirectorStore.getState().project.cameras[0];

  expect(camera.captures).toEqual([
    {
      id: "cam_1-capture-01",
      index: 1,
      name: "机位01-截图01",
      dataUrl: "data:image/png;base64,a",
    },
    {
      id: "cam_1-capture-02",
      index: 2,
      name: "机位01-截图02",
      dataUrl: "data:image/png;base64,b",
    },
    {
      id: "cam_1-capture-03",
      index: 3,
      name: "机位01-截图03",
      dataUrl: "data:image/png;base64,c",
    },
  ]);
  expect(camera.lastCaptureUrl).toBe("data:image/png;base64,c");
});

it("debounces scene persistence and writes the latest snapshot after high-frequency changes", () => {
  vi.useFakeTimers();
  localStorage.clear();
  useDirectorStore.getState().setViewportAspectRatio("16:9");
  useDirectorStore.getState().toggleViewportPanelsCollapsed();
  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().updateScene({ backgroundColor: "#151515" });

  expect(localStorage.getItem("storyai-3d-director-desk-demo")).toBeNull();
  vi.advanceTimersByTime(999);
  expect(localStorage.getItem("storyai-3d-director-desk-demo")).toBeNull();
  vi.advanceTimersByTime(1);
  const snapshot = localStorage.getItem("storyai-3d-director-desk-demo");
  expect(snapshot).not.toBeNull();

  const parsed = JSON.parse(snapshot ?? "{}") as {
    viewportAspectRatio?: string;
    viewportPanelsCollapsed?: boolean;
    project?: {
      scene?: {
        backgroundColor?: string;
      };
      objects?: Array<{ id: string; name: string }>;
    };
  };

  expect(parsed.viewportAspectRatio).toBe("16:9");
  expect(parsed.viewportPanelsCollapsed).toBe(true);
  expect(parsed.project?.scene?.backgroundColor).toBe("#151515");
  expect(parsed.project?.objects?.some((item) => item.name === "角色02")).toBe(true);
  vi.useRealTimers();
});

it("defers debounced persistence while an undo batch is active and flushes it after the batch ends", () => {
  vi.useFakeTimers();
  localStorage.clear();
  useDirectorStore.getState().beginUndoBatch();
  const stringify = vi.spyOn(JSON, "stringify");

  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [1, 0, 0] });
  vi.advanceTimersByTime(3_000);
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [2, 0, 0] });
  vi.advanceTimersByTime(3_000);

  // Several debounce windows elapsed mid-drag, yet the project was neither
  // serialized nor written to storage.
  expect(localStorage.getItem("storyai-3d-director-desk-demo")).toBeNull();
  expect(stringify).not.toHaveBeenCalled();
  stringify.mockRestore();

  useDirectorStore.getState().endUndoBatch();

  expect(localStorage.getItem("storyai-3d-director-desk-demo")).toBeNull();
  vi.advanceTimersByTime(999);
  expect(localStorage.getItem("storyai-3d-director-desk-demo")).toBeNull();
  vi.advanceTimersByTime(1);

  const snapshot = localStorage.getItem("storyai-3d-director-desk-demo");
  expect(snapshot).not.toBeNull();
  const parsed = JSON.parse(snapshot ?? "{}") as {
    project?: { objects?: Array<{ id: string; transform?: { position?: number[] } }> };
  };
  expect(parsed.project?.objects?.find((item) => item.id === "char_default_a")?.transform?.position).toEqual([2, 0, 0]);
  vi.useRealTimers();
});

it("still force-writes the latest snapshot on pagehide while an undo batch is active", () => {
  vi.useFakeTimers();
  localStorage.clear();
  useDirectorStore.getState().beginUndoBatch();
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [4, 0, 0] });
  vi.advanceTimersByTime(3_000);
  expect(localStorage.getItem("storyai-3d-director-desk-demo")).toBeNull();

  window.dispatchEvent(new Event("pagehide"));

  const snapshot = localStorage.getItem("storyai-3d-director-desk-demo");
  expect(snapshot).not.toBeNull();
  const parsed = JSON.parse(snapshot ?? "{}") as {
    project?: { objects?: Array<{ id: string; transform?: { position?: number[] } }> };
  };
  expect(parsed.project?.objects?.find((item) => item.id === "char_default_a")?.transform?.position).toEqual([4, 0, 0]);

  useDirectorStore.getState().endUndoBatch();
  vi.useRealTimers();
});

it("keeps persisted director scenes isolated per canvas card instance", () => {
  useDirectorStore.getState().openScopedScene("node_director_a");
  useDirectorStore.getState().setViewportAspectRatio("16:9");
  useDirectorStore.getState().updateScene({ backgroundColor: "#151515" });

  expect(localStorage.getItem("storyai-3d-director-desk-demo:node_director_a")).not.toBeNull();

  useDirectorStore.getState().openScopedScene("node_director_b");

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("auto");
  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#c9cdd3");

  useDirectorStore.getState().updateScene({ backgroundColor: "#303640" });

  expect(localStorage.getItem("storyai-3d-director-desk-demo:node_director_b")).not.toBeNull();

  useDirectorStore.getState().openScopedScene("node_director_a");

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("16:9");
  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#151515");

  useDirectorStore.getState().openScopedScene("node_director_b");

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("auto");
  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#303640");
});

it("hydrates the initial state from the persisted director scene snapshot", () => {
  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      viewMode: "camera",
      selectedObjectId: "char_default_a",
      selectedObjectIds: ["char_default_a"],
      directorInspectorMode: "auto",
      transformMode: "rotate",
      viewportAspectRatio: "9:16",
      viewportLayout: "quad",
      viewportRuleOfThirdsEnabled: true,
      viewportPanelsCollapsed: true,
      project: {
        ...createDefaultDirectorProject(),
        scene: {
          ...createDefaultDirectorProject().scene,
          backgroundColor: "#303640",
        },
      },
    }),
  );

  const hydratedState = createInitialDirectorState({
    includePersistedLocalAssets: true,
    includePersistedScene: true,
  });

  expect(hydratedState.viewMode).toBe("director");
  expect(hydratedState.transformMode).toBe("rotate");
  expect(hydratedState.viewportAspectRatio).toBe("9:16");
  expect(hydratedState.viewportLayout).toBe("quad");
  expect(hydratedState.viewportRuleOfThirdsEnabled).toBe(true);
  expect(hydratedState.viewportPanelsCollapsed).toBe(true);
  expect(hydratedState.selectedObjectId).toBe("char_default_a");
  expect(hydratedState.project.scene.backgroundColor).toBe("#303640");
});

it("migrates persisted procedural characters to the packaged Mixamo rig", () => {
  const legacyProject = createDefaultDirectorProject();
  const legacyCharacter = legacyProject.objects.find((item) => item.kind === "character");

  if (!legacyCharacter) {
    throw new Error("Expected default character");
  }

  legacyCharacter.color = "#4F8EF7";
  legacyCharacter.transform.position = [1, 0, -2];
  legacyCharacter.characterRig = {
    rigType: "mannequin",
    posePresetId: "stand",
    controls: {
      "head.yaw": 12,
    },
  };

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      ...createInitialDirectorState(),
      project: legacyProject,
    }),
  );

  const hydratedState = createInitialDirectorState({
    includePersistedScene: true,
  });
  const migratedCharacter = hydratedState.project.objects.find((item) => item.id === legacyCharacter.id);

  expect(migratedCharacter?.transform.position).toEqual([1, 0, -2]);
  expect(migratedCharacter?.color).toBe("#d19a3a");
  expect(migratedCharacter?.characterRig).toEqual({
    rigType: "mixamo",
    posePresetId: "stand",
    controls: {
      "head.yaw": 12,
    },
  });
});

it("restores an unbound legacy X Bot object to its exact packaged Mixamo asset", () => {
  const legacyProject = createDefaultDirectorProject();
  const xBotAsset = {
    id: "asset_xbot_primary",
    kind: "character" as const,
    sourceType: "model" as const,
    fileName: "x-bot.glb",
    name: "X Bot",
    url: "/mixamo-characters/models/x-bot.glb",
    assetSource: "library" as const,
    characterMetadata: {
      heightM: 1.78,
      groundOffsetY: 0,
      visualCenter: [0, 0.89, 0.011208] as [number, number, number],
      labelAnchorY: 1.9,
      rig: {
        type: "mixamo" as const,
        bonePrefix: "mixamorig:",
        boneCount: 65,
        boneNames: ["Hips", "Spine", "Head"],
      },
    },
  };

  legacyProject.assets.push(xBotAsset, { ...xBotAsset, id: "asset_xbot_duplicate" });
  legacyProject.objects.push({
    id: "obj_legacy_xbot",
    name: "X Bot",
    kind: "character",
    visible: true,
    locked: false,
    transform: {
      position: [2, 0, -3],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    bodyType: "mannequin",
    characterRig: {
      rigType: "mixamo",
      posePresetId: "stand",
      controls: {},
    },
  });

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      ...createInitialDirectorState(),
      project: legacyProject,
    }),
  );

  const migrated = createInitialDirectorState({ includePersistedScene: true });
  const xBot = migrated.project.objects.find((object) => object.id === "obj_legacy_xbot");

  expect(xBot?.assetRefId).toBe("mixamo:x-bot");
  expect(migrated.project.assets.find((asset) => asset.id === xBot?.assetRefId)?.url).toBe(
    "/mixamo-characters/models/x-bot.glb",
  );
});

it("migrates legacy cameras to a full-frame sensor without changing their view", () => {
  const legacyProject = createDefaultDirectorProject();
  const legacyCamera = legacyProject.cameras[0]!;
  const legacyFov = legacyCamera.fov;
  delete legacyCamera.sensorFormat;
  delete legacyCamera.focalLengthMm;
  delete legacyCamera.apertureFStop;
  delete legacyCamera.focusDistanceM;
  delete legacyCamera.shutterAngle;
  delete legacyCamera.iso;
  delete legacyCamera.nearClipM;
  delete legacyCamera.farClipM;
  delete legacyCamera.anamorphicSqueeze;

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({ ...createInitialDirectorState(), project: legacyProject }),
  );

  const migrated = createInitialDirectorState({ includePersistedScene: true }).project.cameras[0]!;
  expect(migrated.sensorFormat).toBe("fullFrame");
  expect(migrated.fov).toBe(legacyFov);
  expect(migrated.focalLengthMm).toBeCloseTo(35, 2);
  expect(migrated).toMatchObject({
    apertureFStop: 2.8,
    focusDistanceM: 5,
    shutterAngle: 180,
    iso: 800,
    nearClipM: 0.1,
    farClipM: 2_000,
    anamorphicSqueeze: 1,
  });
});

it("copies and pastes every authored camera optic while clearing captures", () => {
  useDirectorStore.getState().updateCamera("cam_1", {
    apertureFStop: 1.4,
    focusDistanceM: 2.75,
    shutterAngle: 144,
    iso: 1_600,
    nearClipM: 0.02,
    farClipM: 8_000,
    anamorphicSqueeze: 1.8,
    captures: [{ id: "capture", index: 1, name: "capture", dataUrl: "data:image/png;base64,AAAA" }],
  });
  useDirectorStore.getState().selectObject("cam_object_1");
  useDirectorStore.getState().copySelectedObjects();
  useDirectorStore.getState().pasteClipboardObjects();

  const copied = useDirectorStore.getState().project.cameras.find((camera) => camera.id !== "cam_1");
  expect(copied).toMatchObject({
    apertureFStop: 1.4,
    focusDistanceM: 2.75,
    shutterAngle: 144,
    iso: 1_600,
    nearClipM: 0.02,
    farClipM: 8_000,
    anamorphicSqueeze: 1.8,
    captures: [],
  });
});

it("migrates a legacy scene into one reusable performance take and coverage sequence", () => {
  const legacyProject = createDefaultDirectorProject();
  delete legacyProject.production;

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({ ...createInitialDirectorState(), project: legacyProject }),
  );

  const migrated = createInitialDirectorState({ includePersistedScene: true }).project;
  expect(migrated.production?.takes).toEqual([
    expect.objectContaining({ id: "take_default", objectIds: ["char_default_a"] }),
  ]);
  expect(migrated.production?.sequences[0]?.shots).toEqual([
    expect.objectContaining({ takeId: "take_default", cameraId: "cam_1" }),
  ]);
});

it("adds the packaged Mixamo rig to persisted characters that predate rig metadata", () => {
  const legacyProject = createDefaultDirectorProject();
  const legacyCharacter = legacyProject.objects.find((item) => item.kind === "character");

  if (!legacyCharacter) {
    throw new Error("Expected default character");
  }

  delete legacyCharacter.characterRig;

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      ...createInitialDirectorState(),
      project: legacyProject,
    }),
  );

  const hydratedState = createInitialDirectorState({
    includePersistedScene: true,
  });
  const migratedCharacter = hydratedState.project.objects.find((item) => item.id === legacyCharacter.id);

  expect(migratedCharacter?.characterRig).toEqual({
    rigType: "mixamo",
    posePresetId: "stand",
    controls: {},
  });
});

it("backfills the metric scale of packaged props saved before real-world sizes", () => {
  const legacyProject = createDefaultDirectorProject();
  legacyProject.assets.push(
    {
      id: "flick:animals:cat.glb",
      kind: "prop",
      sourceType: "model",
      fileName: "cat.glb",
      name: "Cat",
      url: "/flick-stage-props/animals/cat.glb",
      assetSource: "library",
    },
    {
      id: "asset_local_prop",
      kind: "prop",
      sourceType: "model",
      fileName: "hand-authored.glb",
      name: "自制道具",
      url: "blob:http://localhost:5175/9f1c0f6a",
      assetSource: "local",
    },
  );

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({ ...createInitialDirectorState(), project: legacyProject }),
  );

  const migrated = createInitialDirectorState({ includePersistedScene: true }).project;

  expect(migrated.assets.find((asset) => asset.id === "flick:animals:cat.glb")).toMatchObject({
    realWorldSizeM: 0.6,
    sizeSource: "catalog",
  });
  const localProp = migrated.assets.find((asset) => asset.id === "asset_local_prop");
  expect(localProp).toMatchObject({ realWorldSizeM: 2, sizeSource: "estimated" });
});

it("ignores malformed persisted project data before running a migration", () => {
  const malformed = createDefaultDirectorProject();
  malformed.cameras[0]!.target = [0, 1] as unknown as [number, number, number];
  localStorage.setItem("storyai-3d-director-desk-demo", JSON.stringify({ project: malformed }));

  const hydrated = createInitialDirectorState({ includePersistedScene: true });

  expect(hydrated.project.cameras[0]?.target).toEqual(createDefaultDirectorProject().cameras[0]?.target);
});

it("copies and pastes the current selection as new scene objects", () => {
  useDirectorStore.getState().selectObject("char_default_a");

  useDirectorStore.getState().copySelectedObjects();
  useDirectorStore.getState().pasteClipboardObjects();

  const state = useDirectorStore.getState();
  const characters = state.project.objects.filter((item) => item.kind === "character");
  const pastedCharacter = characters.find((item) => item.id !== "char_default_a");

  expect(characters).toHaveLength(2);
  expect(pastedCharacter?.id).not.toBe("char_default_a");
  expect(pastedCharacter?.transform.position).toEqual([0.6, 0, 0.6]);
  expect(pastedCharacter?.nativeSource).toEqual({
    engine: "blender",
    objectId: pastedCharacter?.id,
    provisioned: false,
  });
  expect(state.selectedObjectId).toBe(pastedCharacter?.id ?? null);
  expect(state.selectedObjectIds).toEqual(pastedCharacter ? [pastedCharacter.id] : []);
});

it("undoes the latest scene mutation", () => {
  useDirectorStore.getState().addPresetCharacter("female");

  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(true);

  useDirectorStore.getState().undo();

  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(false);
  expect(useDirectorStore.getState().project.objects.filter((item) => item.kind === "character")).toHaveLength(1);
});

it("redoes an undone scene mutation and clears redo after a new edit", () => {
  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().undo();

  expect(useDirectorStore.getState().redoStack).toHaveLength(1);
  useDirectorStore.getState().redo();
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(true);
  expect(useDirectorStore.getState().redoStack).toHaveLength(0);

  useDirectorStore.getState().undo();
  useDirectorStore.getState().beginUndoBatch();
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [1, 0, 0] });
  useDirectorStore.getState().endUndoBatch();
  expect(useDirectorStore.getState().redoStack).toHaveLength(0);
});

it("derives undo/redo availability through the exported selectors", () => {
  expect(selectDirectorCanUndo(useDirectorStore.getState())).toBe(false);
  expect(selectDirectorCanRedo(useDirectorStore.getState())).toBe(false);

  useDirectorStore.getState().addPresetCharacter("female");
  expect(selectDirectorCanUndo(useDirectorStore.getState())).toBe(true);
  expect(selectDirectorCanRedo(useDirectorStore.getState())).toBe(false);

  useDirectorStore.getState().undo();
  expect(selectDirectorCanUndo(useDirectorStore.getState())).toBe(false);
  expect(selectDirectorCanRedo(useDirectorStore.getState())).toBe(true);
});

it("groups repeated transform updates into one undo step while batching", () => {
  const stringify = vi.spyOn(JSON, "stringify");
  useDirectorStore.getState().beginUndoBatch();
  stringify.mockClear();
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [1, 0, 0] });
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [2, 0, 0] });
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [3, 0, 0] });

  // Persistence and the undo baseline are deferred/reused during a drag;
  // intermediate samples must not serialize the entire scene document.
  expect(stringify).not.toHaveBeenCalled();
  stringify.mockRestore();
  useDirectorStore.getState().endUndoBatch();

  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.transform.position,
  ).toEqual([3, 0, 0]);

  useDirectorStore.getState().undo();

  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.transform.position,
  ).toEqual([0, 0, 0]);
});

it("creates a Blender-style composite parent, moves its children, and lets children become independent", () => {
  const base = createInitialDirectorState();
  const deskPart = {
    id: "desk_top",
    name: "桌面",
    kind: "prop" as const,
    visible: true,
    locked: false,
    geometryType: "box" as const,
    transform: {
      position: [2, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: { ...base.project, objects: [base.project.objects[0]!, deskPart, ...base.project.objects.slice(1)] },
  });

  const parentId = useDirectorStore.getState().createCompositeObject(["char_default_a", "desk_top"], "课堂桌椅");
  expect(parentId).toBe("composite_parent_1");
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === parentId)).toMatchObject({
    name: "课堂桌椅",
    isCompositeParent: true,
    transform: { position: [1, 0, 0] },
  });
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.parentObjectId).toBe(
    parentId,
  );
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "desk_top")?.parentObjectId).toBe(
    parentId,
  );

  useDirectorStore.getState().updateObjectTransform(parentId!, { position: [2, 0, 0] });
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.transform.position,
  ).toEqual([1, 0, 0]);
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "desk_top")?.transform.position,
  ).toEqual([3, 0, 0]);

  useDirectorStore.getState().updateObjectTransform("desk_top", { position: [4, 0, 0] });
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "desk_top")?.transform.position,
  ).toEqual([4, 0, 0]);
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === parentId)?.transform.position).toEqual([
    2, 0, 0,
  ]);

  useDirectorStore.getState().removeObjectsFromComposite(["desk_top"]);
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "desk_top")?.parentObjectId,
  ).toBeUndefined();
  useDirectorStore.getState().deleteObjects([parentId!]);
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.parentObjectId,
  ).toBeUndefined();
  expect(useDirectorStore.getState().project.objects.some((item) => item.id === "desk_top")).toBe(true);
});

it("authors undoable PBR materials and validates image texture bindings", () => {
  useDirectorStore.getState().addGeometryPrimitive("box");
  const object = useDirectorStore
    .getState()
    .project.objects.find((item) => item.kind === "prop" && item.geometryType === "box")!;
  const textureId = useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    sourceType: "image",
    addToScene: false,
    assetSource: "local",
    fileName: "paint.png",
    name: "Paint",
    url: "data:image/png;base64,paint",
  });

  useDirectorStore.getState().updateObjectMaterial(object.id, {
    baseColor: "#445566",
    metalness: 0.7,
    roughness: 0.2,
  });
  useDirectorStore.getState().updateObjectMaterialTexture(object.id, "baseColorMapAssetId", textureId);

  expect(useDirectorStore.getState().project.objects.find((item) => item.id === object.id)).toMatchObject({
    color: "#445566",
    material: {
      baseColor: "#445566",
      metalness: 0.7,
      roughness: 0.2,
      textures: { baseColorMapAssetId: textureId },
    },
  });

  useDirectorStore.getState().updateObjectMaterialTexture(object.id, "normalMapAssetId", "missing");
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === object.id)?.material?.textures
      ?.normalMapAssetId,
  ).toBeUndefined();
});

it("adds, edits, locks, removes, and restores lights through undo", () => {
  const lightId = useDirectorStore.getState().addLight("spot");
  useDirectorStore.getState().updateLight(lightId, {
    name: "轮廓光",
    color: "#88aaff",
    intensity: 3.2,
    target: [1, 1, 0],
  });
  expect(useDirectorStore.getState().project.lights?.find((light) => light.id === lightId)).toMatchObject({
    type: "spot",
    name: "轮廓光",
    color: "#88aaff",
    intensity: 3.2,
    target: [1, 1, 0],
  });

  useDirectorStore.getState().updateLight(lightId, { locked: true });
  useDirectorStore.getState().removeLight(lightId);
  expect(useDirectorStore.getState().project.lights?.some((light) => light.id === lightId)).toBe(true);

  useDirectorStore.getState().updateLight(lightId, { locked: false });
  useDirectorStore.getState().removeLight(lightId);
  expect(useDirectorStore.getState().project.lights?.some((light) => light.id === lightId)).toBe(false);

  useDirectorStore.getState().undo();
  expect(useDirectorStore.getState().project.lights?.some((light) => light.id === lightId)).toBe(true);
});

it("marks new cameras and supported lights for Blender provisioning in a bound project", () => {
  useDirectorStore.getState().ensureNativeSceneBinding();
  const cameraId = useDirectorStore.getState().addCameraShot();
  const lightId = useDirectorStore.getState().addLight("spot");
  const ambientId = useDirectorStore.getState().addLight("ambient");

  expect(useDirectorStore.getState().project.cameras.find((camera) => camera.id === cameraId)?.nativeSource).toEqual({
    engine: "blender",
    objectId: cameraId,
    provisioned: false,
  });
  expect(useDirectorStore.getState().project.lights?.find((light) => light.id === lightId)?.nativeSource).toEqual({
    engine: "blender",
    objectId: lightId,
    provisioned: false,
  });
  expect(
    useDirectorStore.getState().project.lights?.find((light) => light.id === ambientId)?.nativeSource,
  ).toBeUndefined();
});

it("applies advanced multi-object edits as bounded undoable mutations", () => {
  const store = useDirectorStore.getState();
  store.addGeometryPrimitive("box");
  store.addGeometryPrimitive("sphere");
  store.addGeometryPrimitive("cylinder");
  const ids = useDirectorStore
    .getState()
    .project.objects.filter((object) => object.kind !== "camera")
    .slice(-3)
    .map((object) => object.id);
  ids.forEach((id, index) =>
    useDirectorStore.getState().updateObjectTransform(id, {
      position: [index === 2 ? 10 : index * 2, 0, index * 3],
      rotation: [0.2, 0.3, 0.4],
      scale: [2, 2, 2],
    }),
  );

  expect(store.distributeObjects(ids, "x")).toBe(3);
  expect(
    ids.map(
      (id) => useDirectorStore.getState().project.objects.find((object) => object.id === id)!.transform.position[0],
    ),
  ).toEqual([0, 5, 10]);
  expect(store.alignObjects(ids, "z", "center")).toBe(3);
  expect(
    new Set(
      ids.map(
        (id) => useDirectorStore.getState().project.objects.find((object) => object.id === id)!.transform.position[2],
      ),
    ),
  ).toEqual(new Set([3]));
  expect(
    store.batchUpdateObjects(ids, {
      layer: "foreground",
      material: { baseColor: "#445566", roughness: 0.25, metalness: 0.5 },
    }),
  ).toBe(3);
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === ids[0])).toMatchObject({
    layer: "foreground",
    material: { baseColor: "#445566", roughness: 0.25, metalness: 0.5 },
  });
  expect(store.isolateObjects(ids.slice(0, 2))).toBeGreaterThan(0);
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === ids[2])?.visible).toBe(false);
  expect(store.showAllObjects()).toBeGreaterThan(0);

  const beforeReset = structuredClone(
    useDirectorStore.getState().project.objects.find((object) => object.id === ids[0])!.transform,
  );
  expect(store.resetObjectTransforms([ids[0]!])).toBe(1);
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === ids[0])?.transform).toEqual({
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  useDirectorStore.getState().undo();
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === ids[0])?.transform).toEqual(
    beforeReset,
  );
});

it("persists pivots, annotations, measurements, and ordered layer state with undo-safe cleanup", () => {
  const store = useDirectorStore.getState();
  store.addGeometryPrimitive("box");
  const hero = useDirectorStore.getState().project.objects.find((object) => object.kind === "character")!;
  const prop = useDirectorStore.getState().project.objects.find((object) => object.geometryType === "box")!;

  expect(store.setObjectPivot(prop.id, [0.25, 0.5, -0.1])).toBe(true);
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === prop.id)?.pivot).toEqual([
    0.25, 0.5, -0.1,
  ]);
  const annotationId = store.addSceneAnnotation({
    text: "Keep logo facing camera",
    anchor: { objectId: prop.id, position: [0, 1, 0] },
  });
  const measurementId = store.addSceneMeasurement({
    label: "hero spacing",
    start: { objectId: hero.id, position: [0, 0, 0] },
    end: { objectId: prop.id, position: [0, 0, 0] },
  });
  expect(annotationId).toMatch(/^annotation_/);
  expect(measurementId).toMatch(/^measurement_/);

  expect(store.batchUpdateObjects([prop.id], { layer: "foreground" })).toBe(1);
  expect(useDirectorStore.getState().project.scene.objectLayers?.map((layer) => layer.id)).toEqual([
    "default",
    "foreground",
  ]);
  expect(store.setObjectLayerState("foreground", { visible: false, locked: true })).toBe(true);
  const currentProp = useDirectorStore.getState().project.objects.find((object) => object.id === prop.id)!;
  expect(isDirectorObjectEffectivelyVisible(useDirectorStore.getState().project.scene, currentProp)).toBe(false);
  expect(isDirectorObjectEffectivelyLocked(useDirectorStore.getState().project.scene, currentProp)).toBe(true);
  expect(store.moveObjectLayer("foreground", "up")).toBe(true);
  expect(useDirectorStore.getState().project.scene.objectLayers?.[0]?.id).toBe("foreground");

  store.deleteObjects([prop.id]);
  expect(useDirectorStore.getState().project.scene.annotations).toEqual([]);
  expect(useDirectorStore.getState().project.scene.measurements).toEqual([]);
  useDirectorStore.getState().undo();
  expect(useDirectorStore.getState().project.scene.annotations?.[0]?.id).toBe(annotationId);
  expect(useDirectorStore.getState().project.scene.measurements?.[0]?.id).toBe(measurementId);
});

it("keeps the user scene intact after deleting the default character, saving, and reloading", () => {
  useDirectorStore.getState().addGeometryPrimitive("box");
  const boxId = useDirectorStore.getState().project.objects.find((item) => item.geometryType === "box")!.id;

  useDirectorStore.getState().deleteObjects(["char_default_a"]);
  const afterDelete = useDirectorStore.getState().project;
  expect(
    afterDelete.production!.takes.every(
      (take) =>
        !take.objectIds.includes("char_default_a") &&
        take.entityTracks.every((track) => track.objectId !== "char_default_a"),
    ),
  ).toBe(true);

  useDirectorStore.getState().saveLatestSnapshot();
  const reloaded = createInitialDirectorState({ includePersistedScene: true });

  expect(reloaded.project.objects.some((item) => item.id === boxId)).toBe(true);
  expect(reloaded.project.objects.some((item) => item.id === "char_default_a")).toBe(false);
});

it("repairs dangling production references from a legacy snapshot instead of discarding the scene", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const legacyState = createInitialDirectorState();
  legacyState.project.scene.backgroundColor = "#123123";
  // 复刻旧版缺陷持久化:对象已删,production 仍引用它
  legacyState.project.objects = legacyState.project.objects.filter((item) => item.id !== "char_default_a");
  localStorage.setItem("storyai-3d-director-desk-demo", JSON.stringify(legacyState));

  const hydrated = createInitialDirectorState({ includePersistedScene: true });

  expect(hydrated.project.scene.backgroundColor).toBe("#123123");
  expect(
    hydrated.project.production!.takes.every(
      (take) =>
        !take.objectIds.includes("char_default_a") &&
        take.entityTracks.every((track) => track.objectId !== "char_default_a"),
    ),
  ).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("已自动修复"));
  warn.mockRestore();
});

it("backs up an unreadable snapshot to a timestamped key instead of silently overwriting it", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const corruptStructure = '{"project":{"version":999}}';
  localStorage.setItem("storyai-3d-director-desk-demo", corruptStructure);

  useDirectorStore.getState().openScopedScene(null);

  const listBackupKeys = () =>
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).filter((key) =>
      key.startsWith("storyai-3d-director-desk-demo.corrupt-"),
    );
  const firstBackups = listBackupKeys();
  expect(firstBackups).toHaveLength(1);
  expect(localStorage.getItem(firstBackups[0]!)).toBe(corruptStructure);
  expect(useDirectorStore.getState().project.objects.some((item) => item.id === "char_default_a")).toBe(true);

  const corruptJson = "not-json{";
  localStorage.setItem("storyai-3d-director-desk-demo", corruptJson);
  useDirectorStore.getState().openScopedScene(null);

  const secondBackups = listBackupKeys();
  expect(secondBackups).toHaveLength(2);
  expect(secondBackups.map((key) => localStorage.getItem(key))).toContain(corruptJson);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

it("rewrites stale packaged character identities from the catalog on load", () => {
  const catalogItem = getMixamoCharacterCatalogItem("mixamo:x-bot")!;
  const legacyState = createInitialDirectorState();
  legacyState.project.assets = legacyState.project.assets.map((asset) =>
    asset.id === "mixamo:x-bot"
      ? { ...asset, name: "旧显示名", url: "/mixamo-characters/models/legacy-x-bot.glb", fileName: "legacy-x-bot.glb" }
      : asset,
  );
  localStorage.setItem("storyai-3d-director-desk-demo", JSON.stringify(legacyState));

  const hydrated = createInitialDirectorState({ includePersistedScene: true });
  const asset = hydrated.project.assets.find((item) => item.id === "mixamo:x-bot")!;

  expect(asset.url).toBe(catalogItem.url);
  expect(asset.name).toBe(catalogItem.name);
  expect(asset.fileName).toBe(catalogItem.fileName);
  expect(getDirectorCharacterAssetBindingIssues(hydrated.project)).toEqual([]);
});

it("rebinds characters whose asset no longer exists to the default packaged character", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const legacyState = createInitialDirectorState();
  legacyState.project.objects = legacyState.project.objects.map((item) =>
    item.id === "char_default_a" ? { ...item, assetRefId: "asset_missing" } : item,
  );
  localStorage.setItem("storyai-3d-director-desk-demo", JSON.stringify(legacyState));

  const hydrated = createInitialDirectorState({ includePersistedScene: true });
  const character = hydrated.project.objects.find((item) => item.id === "char_default_a")!;

  expect(character.assetRefId).toBe("mixamo:x-bot");
  expect(getDirectorCharacterAssetBindingIssues(hydrated.project)).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("已改绑默认角色"));
  warn.mockRestore();
});

function getTimelineAudioTracks() {
  return useDirectorStore.getState().project.scene.timeline?.audioTracks ?? [];
}

it("adds a stage audio clip at the playhead on an auto-created track", () => {
  const timeline = useDirectorStore.getState().project.scene.timeline!;
  useDirectorStore.getState().updateScene({ timeline: { ...timeline, currentFrame: 36 } });

  const clipId = useDirectorStore.getState().addTimelineAudioClip({
    mediaId: "creative-media:audio:abc",
    name: "环境声",
    durationFrames: 48,
    sourceDurationSec: 12,
  });

  expect(clipId).toBe("audio_clip_1");
  const tracks = getTimelineAudioTracks();
  expect(tracks).toHaveLength(1);
  expect(tracks[0]).toMatchObject({ id: "audio_track_1", name: "音频轨 1", muted: false });
  expect(tracks[0]!.clips[0]).toEqual({
    id: "audio_clip_1",
    name: "环境声",
    mediaId: "creative-media:audio:abc",
    startFrame: 36,
    durationFrames: 48,
    inSec: 0,
    sourceDurationSec: 12,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
  });
  expect(useDirectorStore.getState().addTimelineAudioClip({ mediaId: " ", name: "空", durationFrames: 24 })).toBeNull();
});

it("updates, moves, mutes, and removes stage audio clips with undo support", () => {
  const store = useDirectorStore.getState();
  const clipId = store.addTimelineAudioClip({
    mediaId: "creative-media:audio:abc",
    name: "环境声",
    startFrame: 0,
    durationFrames: 48,
  })!;

  expect(store.updateTimelineAudioClip(clipId, { volume: 1.4, fadeInSec: -2, fadeOutSec: 3, muted: true })).toBe(true);
  expect(getTimelineAudioTracks()[0]!.clips[0]).toMatchObject({
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 3,
    muted: true,
  });
  expect(store.updateTimelineAudioClip("missing", { volume: 0.5 })).toBe(false);

  expect(store.moveTimelineAudioClip(clipId, 60.4)).toBe(true);
  expect(getTimelineAudioTracks()[0]!.clips[0]!.startFrame).toBe(60);
  expect(store.moveTimelineAudioClip(clipId, 60)).toBe(false);
  expect(store.moveTimelineAudioClip("missing", 12)).toBe(false);

  expect(store.setTimelineAudioTrackMuted("audio_track_1", true)).toBe(true);
  expect(getTimelineAudioTracks()[0]!.muted).toBe(true);
  expect(store.setTimelineAudioTrackMuted("audio_track_1", true)).toBe(false);
  expect(store.setTimelineAudioTrackMuted("missing", true)).toBe(false);

  expect(store.removeTimelineAudioClip(clipId)).toBe(true);
  expect(getTimelineAudioTracks()[0]!.clips).toEqual([]);
  expect(store.removeTimelineAudioClip(clipId)).toBe(false);

  // add + update + move + track mute + remove = five undoable steps.
  useDirectorStore.getState().undo();
  expect(getTimelineAudioTracks()[0]!.clips).toHaveLength(1);
  useDirectorStore.getState().undo();
  expect(getTimelineAudioTracks()[0]!.muted).toBe(false);
  useDirectorStore.getState().undo();
  expect(getTimelineAudioTracks()[0]!.clips[0]!.startFrame).toBe(0);
  useDirectorStore.getState().undo();
  expect(getTimelineAudioTracks()[0]!.clips[0]!.muted).toBe(false);
  useDirectorStore.getState().undo();
  expect(getTimelineAudioTracks()).toEqual([]);
  useDirectorStore.getState().redo();
  expect(getTimelineAudioTracks()[0]!.clips).toHaveLength(1);
});

it("groups slider-style audio volume changes into one undo step while batching", () => {
  const store = useDirectorStore.getState();
  const clipId = store.addTimelineAudioClip({
    mediaId: "creative-media:audio:abc",
    name: "环境声",
    startFrame: 0,
    durationFrames: 48,
  })!;
  const undoDepthAfterAdd = useDirectorStore.getState().undoStack.length;

  store.beginUndoBatch();
  store.updateTimelineAudioClip(clipId, { volume: 0.7 });
  store.updateTimelineAudioClip(clipId, { volume: 0.4 });
  store.updateTimelineAudioClip(clipId, { volume: 0.2 });
  store.endUndoBatch();

  expect(getTimelineAudioTracks()[0]!.clips[0]!.volume).toBe(0.2);
  expect(useDirectorStore.getState().undoStack.length).toBe(undoDepthAfterAdd + 1);
  useDirectorStore.getState().undo();
  expect(getTimelineAudioTracks()[0]!.clips[0]!.volume).toBe(1);
});
