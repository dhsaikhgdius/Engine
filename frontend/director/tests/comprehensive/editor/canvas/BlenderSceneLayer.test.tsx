// @vitest-environment jsdom

import { act, createEvent, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Bone,
  BoxGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Skeleton,
  SkinnedMesh,
  Texture,
} from "three";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderLiveSceneSnapshot,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";

const liveClient = vi.hoisted(() => ({
  applyOperations: vi.fn(),
  bindProject: vi.fn(),
  getPreview: vi.fn(),
  getScene: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", () => ({
  applyBlenderNativeOperations: liveClient.applyOperations,
  bindBlenderDirectorProject: liveClient.bindProject,
  getBlenderLivePreviewGlb: liveClient.getPreview,
  getBlenderLiveScene: liveClient.getScene,
  getBlenderLiveStatus: liveClient.getStatus,
  blenderSetSceneFrameOperation: (frame: number) => ({ op: "set_scene_frame", frame }),
}));

vi.mock("../../../../src/comprehensive/editor/canvas/SceneRoot", () => ({
  CenteredObjectTransformControls: ({
    localCenter,
    onTransformChange,
    transform,
  }: {
    localCenter: readonly [number, number, number];
    onTransformChange: (transform: {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    }) => void;
    transform: {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    };
  }) => (
    <button
      data-local-center={JSON.stringify(localCenter)}
      data-testid="blender-floor-pivot-controls"
      onClick={() =>
        onTransformChange({
          ...transform,
          position: [transform.position[0] + 1, transform.position[1], transform.position[2]],
        })
      }
      type="button"
    />
  ),
  ViewportTransformControls: () => null,
}));

import {
  applyDirectorOwnedBlenderVisibility,
  applyBlenderDirectorSegmentationMetadata,
  collectHiddenBlenderVisualIds,
  collectBlenderStaticMeshes,
  buildDirectorBlenderOperations,
  directorRendersCharacterAsset,
  disposeBlenderScene,
  isBlenderSelectionWithinRoot,
  prepareBlenderPreviewScene,
  BlenderSceneLayer,
  type BlenderSceneLayerStatus,
} from "../../../../src/comprehensive/editor/canvas/BlenderSceneLayer";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";
import { useTimelineRuntimeStore } from "../../../../src/comprehensive/editor/runtime/timelineRuntimeStore";
import type {
  DirectorCameraShot,
  DirectorLight,
  DirectorObject,
} from "../../../../src/comprehensive/editor/schema/directorProject";
import { getCameraViewSnapshotFromShot } from "../../../../src/comprehensive/editor/schema/cameraGeometry";

function sceneSnapshot(revision = 0, sceneEpoch = "scene-epoch-a", projectId?: string) {
  return {
    contract: BLENDER_LIVE_CONTRACT,
    ...(projectId ? { projectId } : {}),
    sceneEpoch,
    revision,
    sceneName: "Scene",
    frame: 1,
    unit: "meter" as const,
    coordinateSystem: "right-handed-y-up-negative-z-forward" as const,
    objects: [],
    cameras: [],
    lights: [],
    selectedObjectIds: [],
    activeObjectId: null,
  };
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useBlenderRuntimeStore.getState().reset();
  useTimelineRuntimeStore.getState().reset();
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState() });
  liveClient.getScene.mockResolvedValue(sceneSnapshot());
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function availableStatus(revision: number, sceneEpoch = "scene-epoch-a") {
  return {
    available: true as const,
    ok: true as const,
    contract: BLENDER_LIVE_CONTRACT,
    blenderVersion: "5.1.2",
    busy: false,
    revision,
    sceneEpoch,
  };
}

function nativeApplyResult(options: {
  revisionBefore: number;
  revisionAfter: number;
  activeObjectId?: string | null;
  selectedObjectIds?: string[];
}) {
  const requestId = "63a521f0-7fe3-4fd7-8e06-8457e806c6b3";
  const selection = {
    mode: "OBJECT",
    activeObjectId: options.activeObjectId ?? null,
    selectedObjectIds: options.selectedObjectIds ?? [],
  };
  return {
    sceneEpoch: "scene-epoch-a",
    job: {
      contract: BLENDER_LIVE_CONTRACT,
      jobId: "f77b2668-c080-4773-bf54-7b7d536ec2d4",
      requestId,
      status: "succeeded",
      revision: options.revisionAfter,
      error: null,
    },
    receipt: {
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch: "scene-epoch-a",
      requestId,
      revisionBefore: options.revisionBefore,
      revisionAfter: options.revisionAfter,
      createdObjectIds: [],
      changedObjectIds: [],
      deletedObjectIds: [],
      dirtyObjectIds: [],
      selection,
      metrics: {
        before: { entities: 0, objects: 0, cameras: 0, lights: 0 },
        after: { entities: 0, objects: 0, cameras: 0, lights: 0 },
      },
      operations: [],
      warnings: [],
    },
    evidence: {
      sceneEpoch: "scene-epoch-a",
      revision: options.revisionAfter,
      objects: [],
      cameras: [],
      lights: [],
    },
  };
}

describe("BlenderSceneLayer", () => {
  it("keeps Blender child selection within the Director-owned native root", () => {
    const root: BlenderLiveSceneSnapshot["objects"][number] = {
      id: "asset-root",
      name: "Asset root",
      type: "EMPTY",
      kind: "object",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      localTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [1, 1, 1],
      visible: true,
      collections: ["Collection"],
      parentId: null,
      modifierCount: 0,
      constraints: [],
    };
    const snapshot: BlenderLiveSceneSnapshot = {
      ...sceneSnapshot(4),
      activeObjectId: "asset-mesh",
      selectedObjectIds: ["asset-mesh"],
      objects: [
        root,
        { ...root, id: "asset-mesh", name: "Asset mesh", type: "MESH", parentId: "asset-root" },
        { ...root, id: "outside-mesh", name: "Outside mesh", type: "MESH" },
      ],
    };

    expect(
      isBlenderSelectionWithinRoot(snapshot, "asset-root", snapshot.activeObjectId, snapshot.selectedObjectIds),
    ).toBe(true);
    expect(isBlenderSelectionWithinRoot(snapshot, "asset-root", "outside-mesh", ["outside-mesh"])).toBe(false);
  });

  it("hides Mixamo character preview meshes that Director already renders", () => {
    const character = useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a")!;
    expect(directorRendersCharacterAsset(character)).toBe(true);

    const root: BlenderLiveSceneSnapshot["objects"][number] = {
      id: character.id,
      directorId: character.id,
      name: character.name,
      type: "EMPTY",
      kind: "object",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      localTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [1, 1, 1],
      visible: true,
      collections: ["Collection"],
      parentId: null,
      modifierCount: 0,
      constraints: [],
    };
    const snapshot: BlenderLiveSceneSnapshot = {
      ...sceneSnapshot(4),
      objects: [root, { ...root, id: "mixamo-surface", name: "Beta_Surface", type: "MESH", parentId: character.id }],
    };
    const hiddenIds = collectHiddenBlenderVisualIds(useDirectorStore.getState().project.objects, snapshot);
    expect(hiddenIds.has(character.id)).toBe(true);
    expect(hiddenIds.has("mixamo-surface")).toBe(true);

    const scene = new Group();
    const characterRoot = new Group();
    characterRoot.userData.worldengine_id = character.id;
    characterRoot.userData.director_id = character.id;
    const surface = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: "#000000" }));
    surface.userData.worldengine_id = "mixamo-surface";
    characterRoot.add(surface);
    const cube = new Group();
    cube.userData.worldengine_id = "native-cube";
    scene.add(characterRoot);
    scene.add(cube);

    applyDirectorOwnedBlenderVisibility(scene, hiddenIds);
    expect(characterRoot.visible).toBe(false);
    expect(surface.visible).toBe(false);
    expect(cube.visible).toBe(true);
  });

  it("projects native root identity onto Blender meshes for segmentation", () => {
    const scene = new Group();
    const nativeRoot = new Group();
    nativeRoot.userData.worldengine_id = "native-chair";
    const nativeMesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    nativeMesh.userData.worldengine_id = "native-chair-mesh";
    nativeRoot.add(nativeMesh);
    scene.add(nativeRoot);
    const root = {
      id: "native-chair",
      directorId: "chair-a",
      name: "Chair",
      type: "EMPTY",
      kind: "object",
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      localTransform: {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      dimensions: [1, 1, 1] as [number, number, number],
      visible: true,
      collections: [],
      parentId: null,
      modifierCount: 0,
      constraints: [],
    };
    const directorObject: DirectorObject = {
      id: "chair-a",
      name: "Chair",
      kind: "prop",
      visible: true,
      locked: false,
      placementMode: "grounded",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      nativeSource: { engine: "blender", objectId: "native-chair", provisioned: true },
    };

    applyBlenderDirectorSegmentationMetadata(
      scene,
      { ...sceneSnapshot(1), objects: [root, { ...root, id: "native-chair-mesh", parentId: "native-chair" }] },
      [directorObject],
    );

    expect(nativeRoot.userData).toMatchObject({ directorObjectId: "chair-a", directorObjectKind: "prop" });
    expect(nativeMesh.userData).toMatchObject({ directorObjectId: "chair-a", directorObjectKind: "prop" });
  });

  it("translates Director object edits into native root operations", () => {
    const snapshot = {
      ...sceneSnapshot(4, "scene-epoch-a", "director-project-a"),
      objects: [
        {
          id: "asset-root",
          name: "Old lobby",
          type: "EMPTY",
          kind: "object",
          position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
          localTransform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          dimensions: [1, 1, 1] as [number, number, number],
          visible: true,
          collections: ["Collection"],
          parentId: null,
          modifierCount: 0,
          constraints: [],
        },
        {
          id: "deleted-root",
          name: "Deleted root",
          type: "MESH",
          kind: "object",
          position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
          localTransform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          dimensions: [1, 1, 1] as [number, number, number],
          visible: true,
          collections: ["Collection"],
          parentId: null,
          modifierCount: 0,
          constraints: [],
        },
      ],
    };

    expect(
      buildDirectorBlenderOperations(snapshot, [
        {
          id: "native:asset-root",
          name: "Lobby set",
          kind: "prop",
          visible: false,
          locked: false,
          placementMode: "floating",
          transform: { position: [3, 0, -2], rotation: [0, 0.5, 0], scale: [2, 2, 2] },
          nativeSource: { engine: "blender", objectId: "asset-root" },
        },
      ]),
    ).toEqual([
      {
        op: "update_transform",
        id: "asset-root",
        transform: { position: [3, 0, -2], rotation: [0, 0.5, 0], scale: [2, 2, 2] },
      },
      { op: "set_object_name", id: "asset-root", name: "Lobby set" },
      { op: "set_object_visibility", id: "asset-root", visible: false },
      { op: "delete_object", id: "deleted-root" },
    ]);
  });

  it("projects Director camera and light edits through typed native operations", () => {
    const camera: DirectorCameraShot = {
      id: "camera-a",
      name: "Hero camera",
      fov: 45,
      focalLengthMm: 50,
      sensorFormat: "fullFrame",
      nearClipM: 0.2,
      farClipM: 3_000,
      transform: { position: [1, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
      targetMode: "manual",
      target: [1, 2, 0],
      lastCaptureUrl: null,
      captures: [],
      projectionType: "orthographic",
      orthographicScaleM: 14,
      sensorFit: "horizontal",
      sensorWidthMm: 40,
      sensorHeightMm: 22,
      lensShiftX: 0.1,
      lensShiftY: -0.05,
      nativeSource: { engine: "blender", objectId: "native-camera-a", provisioned: true },
    };
    const light: DirectorLight = {
      id: "light-a",
      name: "Warm key",
      type: "rect-area",
      visible: false,
      locked: false,
      color: "#808080",
      intensity: 2.5,
      position: [4, 6, 2],
      target: [0, 1, 0],
      width: 3,
      height: 3,
      nativeSource: { engine: "blender", objectId: "native-light-a", provisioned: true },
    };
    const snapshot: BlenderLiveSceneSnapshot = {
      ...sceneSnapshot(4),
      cameras: [
        {
          id: "native-camera-a",
          name: "Old camera",
          position: [0, 2, 10],
          rotation: [0, 0, 0],
          projectionType: "PERSPECTIVE",
          focalLengthMm: 35,
          sensorFit: "AUTO",
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          shiftX: 0,
          shiftY: 0,
          clipStart: 0.1,
          clipEnd: 1_000,
          orthographicScale: 10,
          active: false,
        },
      ],
      lights: [
        {
          id: "native-light-a",
          name: "Old light",
          kind: "point",
          position: [0, 3, 0],
          rotation: [0, 0, 0],
          color: [1, 1, 1],
          energy: 1_000,
          size: 0.25,
          visible: true,
        },
      ],
    };

    const operations = buildDirectorBlenderOperations(snapshot, [], [], new Map(), null, [camera], [light], camera.id);
    const cameraTransform = operations.find(
      (operation) => operation.op === "update_transform" && operation.id === "native-camera-a",
    );
    expect(cameraTransform).toMatchObject({
      op: "update_transform",
      id: "native-camera-a",
      transform: { position: getCameraViewSnapshotFromShot(camera).position },
    });
    expect(operations).toContainEqual({
      op: "set_camera_data",
      id: "native-camera-a",
      projectionType: "ORTHOGRAPHIC",
      focalLengthMm: 50,
      sensorFit: "HORIZONTAL",
      sensorWidthMm: 40,
      sensorHeightMm: 22,
      shiftX: 0.1,
      shiftY: -0.05,
      clipStart: 0.2,
      clipEnd: 3_000,
      orthographicScale: 14,
    });
    expect(operations).toContainEqual(expect.objectContaining({ op: "set_object_name", id: "native-camera-a" }));
    expect(operations).toContainEqual(expect.objectContaining({ op: "set_object_name", id: "native-light-a" }));
    expect(operations).toContainEqual({
      op: "set_object_visibility",
      id: "native-light-a",
      visible: false,
    });
    expect(operations).toContainEqual({
      op: "set_light_data",
      id: "native-light-a",
      kind: "area",
      color: expect.arrayContaining([expect.closeTo(0.21586, 4)]),
      energy: 2_500,
      size: 3,
    });
    expect(operations.at(-1)).toEqual({ op: "set_active_camera", id: "native-camera-a" });
  });

  it("provisions new Director cameras and supported lights in the bound Blender scene", () => {
    const camera: DirectorCameraShot = {
      id: "camera-new",
      name: "New camera",
      fov: 45,
      focalLengthMm: 35,
      transform: { position: [0, 1, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
      targetMode: "manual",
      target: [0, 1, 0],
      lastCaptureUrl: null,
      captures: [],
      nativeSource: { engine: "blender", objectId: "camera-new", provisioned: false },
    };
    const light: DirectorLight = {
      id: "light-new",
      name: "New sun",
      type: "directional",
      visible: true,
      locked: false,
      color: "#ffffff",
      intensity: 1.2,
      position: [5, 8, 5],
      target: [0, 0, 0],
      nativeSource: { engine: "blender", objectId: "light-new", provisioned: false },
    };

    const operations = buildDirectorBlenderOperations(
      sceneSnapshot(4),
      [],
      [],
      new Map(),
      null,
      [camera],
      [light],
      camera.id,
    );
    expect(operations.map((operation) => operation.op)).toEqual([
      "create_camera",
      "set_camera_data",
      "create_light",
      "set_active_camera",
    ]);
    expect(operations[0]).toMatchObject({ id: "camera-new", name: "New camera" });
    expect(operations[2]).toMatchObject({ id: "light-new", kind: "sun", energy: 1.2 });
  });

  it("does not echo a reconciled Blender camera or light back as a new edit", () => {
    const snapshot: BlenderLiveSceneSnapshot = {
      ...sceneSnapshot(4, "scene-epoch-a", "project-a"),
      cameras: [
        {
          id: "camera-a",
          name: "Camera",
          position: [2, 3, 8],
          rotation: [0.1, 0.2, 0],
          projectionType: "PERSPECTIVE",
          focalLengthMm: 50,
          sensorFit: "HORIZONTAL",
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          shiftX: 0.1,
          shiftY: -0.05,
          clipStart: 0.1,
          clipEnd: 2_000,
          orthographicScale: 10,
          active: true,
        },
      ],
      lights: [
        {
          id: "light-a",
          name: "Key",
          kind: "area",
          position: [4, 6, 2],
          rotation: [0.4, 0.2, 0],
          color: [1, 0.5, 0.25],
          energy: 1_500,
          size: 3,
          visible: true,
        },
      ],
    };
    const initial = useDirectorStore.getState();
    useDirectorStore.setState({
      ...initial,
      project: { ...initial.project, nativeScene: { engine: "blender", projectId: "project-a" } },
    });
    useDirectorStore.getState().syncBlenderScene(snapshot);
    const project = useDirectorStore.getState().project;
    const camera = project.cameras.find((candidate) => candidate.nativeSource?.objectId === "camera-a")!;
    const light = project.lights?.find((candidate) => candidate.nativeSource?.objectId === "light-a")!;

    expect(buildDirectorBlenderOperations(snapshot, [], [], new Map(), null, [camera], [light], camera.id)).toEqual([]);
  });

  it("does not resubmit transforms when Blender canonicalizes an equivalent rotation", () => {
    const root = {
      id: "asset-root",
      name: "Actor",
      type: "EMPTY",
      kind: "object",
      directorId: "actor-a",
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 1.2128647459659326, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      localTransform: {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 1.2128647459659326, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      dimensions: [1, 1, 1] as [number, number, number],
      visible: true,
      collections: ["Collection"],
      parentId: null,
      modifierCount: 0,
      constraints: [],
    };
    const object: DirectorObject = {
      id: "actor-a",
      name: "Actor",
      kind: "character",
      visible: true,
      locked: false,
      placementMode: "floating",
      transform: { position: [0, 0, 0], rotation: [0, 13.779235360325105, 0], scale: [1, 1, 1] },
      nativeSource: { engine: "blender", objectId: "asset-root", provisioned: true },
    };

    expect(buildDirectorBlenderOperations({ ...sceneSnapshot(4), objects: [root] }, [object])).toEqual([]);
  });

  it("imports each Director model instance as its canonical native root", () => {
    const object: DirectorObject = {
      id: "prop-chair-a",
      name: "Hero chair",
      kind: "prop" as const,
      visible: true,
      locked: false,
      assetRefId: "asset-chair",
      placementMode: "grounded" as const,
      transform: { position: [2, 0, -1], rotation: [0, 0.5, 0], scale: [1.2, 1.2, 1.2] },
      nativeSource: { engine: "blender" as const, objectId: "prop-chair-a", provisioned: false },
    };
    const asset = {
      id: "asset-chair",
      kind: "prop" as const,
      sourceType: "model" as const,
      fileName: "chair.glb",
      name: "Chair",
      url: "https://assets.example/chair.glb",
    };

    expect(buildDirectorBlenderOperations(sceneSnapshot(), [object], [asset])).toEqual([]);
    expect(
      buildDirectorBlenderOperations(
        sceneSnapshot(),
        [object],
        [asset],
        new Map([["asset-chair", "http://127.0.0.1:8787/native-models/model/chair.glb"]]),
        new Set(["another-object"]),
      ),
    ).toEqual([]);
    expect(
      buildDirectorBlenderOperations(
        sceneSnapshot(),
        [object],
        [asset],
        new Map([["asset-chair", "http://127.0.0.1:8787/native-models/model/chair.glb"]]),
        new Set([object.id]),
      ),
    ).toEqual([
      {
        op: "import_asset",
        id: "prop-chair-a",
        directorId: "prop-chair-a",
        assetId: "asset-chair",
        sourceUrl: "http://127.0.0.1:8787/native-models/model/chair.glb",
        fileName: "chair.glb",
        name: "Hero chair",
        kind: "prop",
        normalization: "auto",
        grounded: true,
        transform: object.transform,
      },
    ]);
    expect(
      buildDirectorBlenderOperations(
        sceneSnapshot(),
        [
          {
            ...object,
            nativeSource: { engine: "blender", objectId: "prop-chair-a", provisioned: true },
          },
        ],
        [asset],
      ),
    ).toEqual([]);
  });

  it("never imports gaussian splat captures into Blender, which has no splat importer", () => {
    const object: DirectorObject = {
      id: "prop-garden-a",
      name: "Garden scan",
      kind: "prop" as const,
      visible: true,
      locked: false,
      assetRefId: "asset-garden",
      placementMode: "grounded" as const,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      nativeSource: { engine: "blender" as const, objectId: "prop-garden-a", provisioned: false },
    };
    const asset = {
      id: "asset-garden",
      kind: "prop" as const,
      sourceType: "model" as const,
      fileName: "garden.spz",
      name: "Garden scan",
      url: "/native-models/asset-garden/garden.spz",
    };

    expect(
      buildDirectorBlenderOperations(
        sceneSnapshot(),
        [object],
        [asset],
        new Map([["asset-garden", "http://127.0.0.1:8787/native-models/asset-garden/garden.spz"]]),
      ),
    ).toEqual([]);
  });

  it("binds the modeling engine to the current Director project before loading its preview", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValue({ ...availableStatus(0), projectId: null });
    liveClient.bindProject.mockResolvedValue(sceneSnapshot(0, "bound-epoch", "director-project-a"));
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 0,
      sceneEpoch: "bound-epoch",
    });

    render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(new Group())}
        pollIntervalMs={250}
        projectId="director-project-a"
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(liveClient.bindProject).toHaveBeenCalledWith("director-project-a", { signal: expect.any(AbortSignal) });
    expect(liveClient.getScene).not.toHaveBeenCalled();
    expect(liveClient.getPreview).toHaveBeenCalledOnce();
  });

  it("pushes the persisted Director transform instead of importing a stale native transform on mount", async () => {
    vi.useFakeTimers();
    const state = useDirectorStore.getState();
    const character = state.project.objects.find((object) => object.id === "char_default_a")!;
    const nativeCharacter = {
      id: character.id,
      directorId: character.id,
      name: character.name,
      type: "EMPTY",
      kind: "object",
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
    };
    const snapshot = {
      ...sceneSnapshot(4, "scene-epoch-a", "director-project-a"),
      objects: [nativeCharacter],
    };
    useDirectorStore.setState({
      ...state,
      project: {
        ...state.project,
        nativeScene: { engine: "blender", projectId: "director-project-a" },
        objects: state.project.objects.map((object) =>
          object.id === character.id
            ? {
                ...object,
                nativeSource: { engine: "blender" as const, objectId: object.id, provisioned: true },
              }
            : object,
        ),
      },
    });
    liveClient.getStatus.mockResolvedValue({ ...availableStatus(4), projectId: "director-project-a" });
    liveClient.getScene.mockResolvedValueOnce(snapshot).mockResolvedValue({
      ...snapshot,
      revision: 5,
      objects: [
        {
          ...nativeCharacter,
          position: [24, 4, 6],
          localTransform: {
            ...nativeCharacter.localTransform,
            position: [24, 4, 6],
          },
        },
      ],
    });
    liveClient.getPreview.mockResolvedValue({ blob: new Blob(["glb"]), revision: 4, sceneEpoch: "scene-epoch-a" });
    liveClient.applyOperations.mockResolvedValue(nativeApplyResult({ revisionBefore: 4, revisionAfter: 5 }));

    render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(new Group())}
        pollIntervalMs={250}
        projectId="director-project-a"
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(useDirectorStore.getState().project.objects.find((object) => object.id === character.id)?.transform).toEqual(
      character.transform,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(160);
    });
    expect(liveClient.applyOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSceneEpoch: "scene-epoch-a",
        expectedRevision: 4,
        operations: expect.arrayContaining([
          { op: "update_transform", id: character.id, transform: character.transform },
        ]),
      }),
    );
    expect(useDirectorStore.getState().project.objects.find((object) => object.id === character.id)?.transform).toEqual(
      character.transform,
    );
  });

  it("does not keep rebinding when another Director project becomes active", async () => {
    vi.useFakeTimers();
    liveClient.getStatus
      .mockResolvedValueOnce({ ...availableStatus(0), projectId: null })
      .mockResolvedValue({ ...availableStatus(0, "foreign-epoch"), projectId: "director-project-b" });
    liveClient.bindProject.mockResolvedValue(sceneSnapshot(0, "bound-epoch", "director-project-a"));
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 0,
      sceneEpoch: "bound-epoch",
    });

    render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(new Group())}
        pollIntervalMs={250}
        projectId="director-project-a"
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(liveClient.bindProject).toHaveBeenCalledTimes(1);
    expect(liveClient.getPreview).toHaveBeenCalledTimes(1);
  });

  it("restores the Director playhead after the native engine restarts", async () => {
    vi.useFakeTimers();
    const initial = { ...sceneSnapshot(4, "scene-epoch-a", "director-project-a"), frame: 4 };
    const synchronized = { ...sceneSnapshot(5, "scene-epoch-a", "director-project-a"), frame: 71 };
    liveClient.getStatus.mockResolvedValue({
      ...availableStatus(4),
      projectId: "director-project-a",
    });
    liveClient.getScene.mockResolvedValueOnce(initial).mockResolvedValue(synchronized);
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 4,
      sceneEpoch: "scene-epoch-a",
    });
    liveClient.applyOperations.mockResolvedValue(nativeApplyResult({ revisionBefore: 4, revisionAfter: 5 }));
    const directorState = useDirectorStore.getState();
    useDirectorStore.setState({
      ...directorState,
      project: {
        ...directorState.project,
        nativeScene: { engine: "blender", projectId: "director-project-a" },
      },
    });
    useTimelineRuntimeStore.getState().setPlayheadFrame(71);

    render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(new Group())}
        pollIntervalMs={250}
        projectId="director-project-a"
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(160);
    });

    expect(liveClient.applyOperations).toHaveBeenCalledWith({
      expectedSceneEpoch: "scene-epoch-a",
      expectedRevision: 4,
      intentId: expect.any(String),
      operations: [{ op: "set_scene_frame", frame: 71 }],
    });
  });

  it("does not let a background tab overwrite the active Director native scene", async () => {
    vi.useFakeTimers();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    liveClient.getStatus.mockResolvedValue({
      ...availableStatus(4),
      projectId: "director-project-b",
    });
    liveClient.getScene.mockResolvedValue({
      ...sceneSnapshot(4, "scene-epoch-a", "director-project-a"),
      frame: 4,
    });
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 4,
      sceneEpoch: "scene-epoch-a",
    });
    const directorState = useDirectorStore.getState();
    useDirectorStore.setState({
      ...directorState,
      project: {
        ...directorState.project,
        nativeScene: { engine: "blender", projectId: "director-project-a" },
      },
    });
    useTimelineRuntimeStore.getState().setPlayheadFrame(71);

    render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(new Group())}
        pollIntervalMs={250}
        projectId="director-project-a"
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(liveClient.applyOperations).not.toHaveBeenCalled();
    expect(liveClient.bindProject).not.toHaveBeenCalled();
  });

  it("loads revision zero once and does not refetch an unchanged fresh scene", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValue(availableStatus(0));
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 0,
      sceneEpoch: "scene-epoch-a",
    });
    const loadScene = vi.fn().mockResolvedValue(new Group());
    const statuses: BlenderSceneLayerStatus[] = [];
    const collisionChanges = vi.fn();
    const referenceRoot = new Group();
    const { container, unmount } = render(
      <BlenderSceneLayer
        loadScene={loadScene}
        onCollisionEnvironmentChange={collisionChanges}
        onStatusChange={(status) => statuses.push(status)}
        pollIntervalMs={250}
        referenceRoot={referenceRoot}
        visible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statuses.at(-1)).toEqual({ phase: "ready", revision: 0 });
    expect(container.querySelector("primitive")).not.toBeNull();
    expect(useBlenderRuntimeStore.getState().previewActive).toBe(true);
    expect(liveClient.getPreview).toHaveBeenCalledTimes(1);
    expect(collisionChanges).toHaveBeenCalledTimes(1);
    expect(collisionChanges.mock.calls[0]?.[0]).toMatchObject({
      ownerId: "blender-live",
      referenceRoot,
      versionKey: "scene-epoch-a:0",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(liveClient.getStatus).toHaveBeenCalledTimes(2);
    expect(liveClient.getPreview).toHaveBeenCalledTimes(1);
    expect(collisionChanges).toHaveBeenCalledTimes(1);

    unmount();
    expect(collisionChanges).toHaveBeenLastCalledWith(null);
    expect(useBlenderRuntimeStore.getState().previewActive).toBe(false);
  });

  it("runs an explicit shared refresh immediately and stops responding after unmount", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValue(availableStatus(0));
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 0,
      sceneEpoch: "scene-epoch-a",
    });
    const { unmount } = render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(new Group())}
        pollIntervalMs={1_000}
        referenceRoot={new Group()}
        visible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(liveClient.getStatus).toHaveBeenCalledTimes(1);

    let refreshRequestId = 0;
    act(() => {
      refreshRequestId = useBlenderRuntimeStore.getState().requestRefresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(liveClient.getStatus).toHaveBeenCalledTimes(2);
    expect(useBlenderRuntimeStore.getState().refreshCompletedId).toBe(refreshRequestId);

    unmount();
    act(() => {
      useBlenderRuntimeStore.getState().requestRefresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(liveClient.getStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps the structured scene current while the native preview is hidden", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValue(availableStatus(3));
    liveClient.getScene.mockResolvedValue(sceneSnapshot(3));
    const loadScene = vi.fn().mockResolvedValue(new Group());

    render(
      <BlenderSceneLayer loadScene={loadScene} pollIntervalMs={250} referenceRoot={new Group()} visible={false} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(liveClient.getStatus).toHaveBeenCalledOnce();
    expect(liveClient.getScene).toHaveBeenCalledOnce();
    expect(useBlenderRuntimeStore.getState().snapshot?.revision).toBe(3);
    expect(liveClient.getPreview).not.toHaveBeenCalled();
    expect(loadScene).not.toHaveBeenCalled();
    expect(useBlenderRuntimeStore.getState().previewActive).toBe(false);
  });

  it("does not queue scene or preview work while Blender is busy", async () => {
    vi.useFakeTimers();
    liveClient.getStatus
      .mockResolvedValueOnce({ ...availableStatus(3), busy: true })
      .mockResolvedValue(availableStatus(3));
    liveClient.getScene.mockResolvedValue(sceneSnapshot(3));
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 3,
      sceneEpoch: "scene-epoch-a",
    });
    const statuses: BlenderSceneLayerStatus[] = [];

    render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(new Group())}
        onStatusChange={(status) => statuses.push(status)}
        pollIntervalMs={250}
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(statuses.at(-1)).toMatchObject({ phase: "syncing", revision: null, targetRevision: 3 });
    expect(liveClient.getScene).not.toHaveBeenCalled();
    expect(liveClient.getPreview).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(liveClient.getScene).toHaveBeenCalledOnce();
    expect(liveClient.getPreview).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toEqual({ phase: "ready", revision: 3 });
  });

  it("excludes Director-owned hidden character proxies from the live collision source", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValue(availableStatus(0));
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 0,
      sceneEpoch: "scene-epoch-a",
    });
    const character = useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a")!;
    const mounted = new Group();
    const characterRoot = new Group();
    characterRoot.userData.worldengine_id = character.id;
    characterRoot.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    mounted.add(characterRoot);
    const collisionChanges = vi.fn();

    render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(mounted)}
        onCollisionEnvironmentChange={collisionChanges}
        pollIntervalMs={250}
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(characterRoot.visible).toBe(false);
    expect(collisionChanges).toHaveBeenCalledOnce();
    expect(collisionChanges.mock.calls[0]?.[0]?.meshes).toEqual([]);
  });

  it("re-poses the mounted scene without reloading the GLB when every new revision is transform-only", async () => {
    vi.useFakeTimers();
    const nativeCube = (x: number) => ({
      id: "cube-a",
      directorId: null,
      name: "Cube",
      type: "MESH",
      kind: "object",
      position: [x, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      localTransform: {
        position: [x, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      dimensions: [1, 1, 1] as [number, number, number],
      visible: true,
      collections: [],
      parentId: null,
      modifierCount: 0,
      constraints: [],
    });
    liveClient.getStatus
      .mockResolvedValueOnce({ ...availableStatus(1), contentRevision: 1 })
      .mockResolvedValue({ ...availableStatus(2), contentRevision: 1 });
    liveClient.getScene
      .mockResolvedValueOnce({ ...sceneSnapshot(1), contentRevision: 1, objects: [nativeCube(0)] })
      .mockResolvedValue({ ...sceneSnapshot(2), contentRevision: 1, objects: [nativeCube(3)] });
    liveClient.getPreview.mockResolvedValue({ blob: new Blob(["glb"]), revision: 1, sceneEpoch: "scene-epoch-a" });
    const mounted = new Group();
    const cubeNode = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    cubeNode.userData.worldengine_id = "cube-a";
    mounted.add(cubeNode);
    const loadScene = vi.fn().mockResolvedValue(mounted);
    const statuses: BlenderSceneLayerStatus[] = [];
    const collisionChanges = vi.fn();

    render(
      <BlenderSceneLayer
        loadScene={loadScene}
        onCollisionEnvironmentChange={collisionChanges}
        onStatusChange={(status) => statuses.push(status)}
        pollIntervalMs={250}
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statuses.at(-1)).toEqual({ phase: "ready", revision: 1 });
    expect(loadScene).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(statuses.at(-1)).toEqual({ phase: "ready", revision: 2 });
    expect(liveClient.getPreview).toHaveBeenCalledTimes(1);
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(cubeNode.position.x).toBeCloseTo(3);
    expect(collisionChanges.mock.calls.at(-1)?.[0]).toMatchObject({ versionKey: "scene-epoch-a:2" });
  });

  it("still reloads the preview GLB when the kernel reports a content change", async () => {
    vi.useFakeTimers();
    liveClient.getStatus
      .mockResolvedValueOnce({ ...availableStatus(1), contentRevision: 1 })
      .mockResolvedValue({ ...availableStatus(2), contentRevision: 2 });
    liveClient.getScene
      .mockResolvedValueOnce({ ...sceneSnapshot(1), contentRevision: 1 })
      .mockResolvedValue({ ...sceneSnapshot(2), contentRevision: 2 });
    liveClient.getPreview
      .mockResolvedValueOnce({ blob: new Blob(["one"]), revision: 1, sceneEpoch: "scene-epoch-a" })
      .mockResolvedValue({ blob: new Blob(["two"]), revision: 2, sceneEpoch: "scene-epoch-a" });
    const loadScene = vi.fn().mockResolvedValue(new Group());

    render(<BlenderSceneLayer loadScene={loadScene} pollIntervalMs={250} referenceRoot={new Group()} visible />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(liveClient.getPreview).toHaveBeenCalledTimes(2);
    expect(loadScene).toHaveBeenCalledTimes(2);
  });

  it("falls back to a full reload when a visible snapshot object has no mounted node", async () => {
    vi.useFakeTimers();
    const orphanObject = {
      id: "orphan-a",
      directorId: null,
      name: "Orphan",
      type: "MESH",
      kind: "object",
      position: [2, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      localTransform: {
        position: [2, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      dimensions: [1, 1, 1] as [number, number, number],
      visible: true,
      collections: [],
      parentId: null,
      modifierCount: 0,
      constraints: [],
    };
    liveClient.getStatus
      .mockResolvedValueOnce({ ...availableStatus(1), contentRevision: 1 })
      .mockResolvedValue({ ...availableStatus(2), contentRevision: 1 });
    liveClient.getScene
      .mockResolvedValueOnce({ ...sceneSnapshot(1), contentRevision: 1, objects: [] })
      .mockResolvedValue({ ...sceneSnapshot(2), contentRevision: 1, objects: [orphanObject] });
    liveClient.getPreview
      .mockResolvedValueOnce({ blob: new Blob(["one"]), revision: 1, sceneEpoch: "scene-epoch-a" })
      .mockResolvedValue({ blob: new Blob(["two"]), revision: 2, sceneEpoch: "scene-epoch-a" });
    const loadScene = vi.fn().mockResolvedValue(new Group());

    render(<BlenderSceneLayer loadScene={loadScene} pollIntervalMs={250} referenceRoot={new Group()} visible />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(liveClient.getPreview).toHaveBeenCalledTimes(2);
    expect(loadScene).toHaveBeenCalledTimes(2);
  });

  it("extracts one flat visible static mesh set and excludes rigged or hidden content", () => {
    const root = new Group();
    const wall = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const hiddenRoot = new Group();
    hiddenRoot.visible = false;
    hiddenRoot.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    const rigged = new SkinnedMesh(new BoxGeometry(), new MeshStandardMaterial());
    root.add(wall, hiddenRoot, rigged, new PerspectiveCamera(), new PointLight());
    const traverse = vi.spyOn(root, "traverse");

    expect(collectBlenderStaticMeshes(root)).toEqual([wall]);
    expect(traverse).toHaveBeenCalledOnce();
  });

  it("keeps Blender preview geometry without importing duplicate cameras or lights", () => {
    const root = new Group();
    const wall = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    root.add(wall, new PerspectiveCamera(), new PointLight());

    prepareBlenderPreviewScene(root);

    expect(root.children).toEqual([wall]);
    expect(root.userData.blenderLiveEnvironment).toBe(true);
  });

  it("keeps the last successful scene when a newer preview temporarily fails", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValueOnce(availableStatus(1)).mockResolvedValue(availableStatus(2));
    liveClient.getPreview
      .mockResolvedValueOnce({ blob: new Blob(["one"]), revision: 1, sceneEpoch: "scene-epoch-a" })
      .mockRejectedValue(new Error("preview unavailable"));
    const loadScene = vi.fn().mockResolvedValue(new Group());
    const statuses: BlenderSceneLayerStatus[] = [];
    const { container } = render(
      <BlenderSceneLayer
        loadScene={loadScene}
        onStatusChange={(status) => statuses.push(status)}
        pollIntervalMs={250}
        referenceRoot={new Group()}
        visible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statuses.at(-1)).toEqual({ phase: "ready", revision: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(statuses.at(-1)).toEqual({
      phase: "stale",
      revision: 1,
      targetRevision: 2,
      message: "preview unavailable",
    });
    expect(container.querySelector("primitive")).not.toBeNull();
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(useBlenderRuntimeStore.getState().status).toMatchObject({
      available: true,
      revision: 2,
    });
  });

  it("disposes the replaced revision and the final revision on unmount", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValueOnce(availableStatus(1)).mockResolvedValue(availableStatus(2));
    liveClient.getPreview
      .mockResolvedValueOnce({ blob: new Blob(["one"]), revision: 1, sceneEpoch: "scene-epoch-a" })
      .mockResolvedValueOnce({ blob: new Blob(["two"]), revision: 2, sceneEpoch: "scene-epoch-a" });
    const firstGeometry = new BoxGeometry();
    const secondGeometry = new BoxGeometry();
    const firstDispose = vi.spyOn(firstGeometry, "dispose");
    const secondDispose = vi.spyOn(secondGeometry, "dispose");
    const firstScene = new Group();
    firstScene.add(new Mesh(firstGeometry, new MeshStandardMaterial()));
    const secondScene = new Group();
    secondScene.add(new Mesh(secondGeometry, new MeshStandardMaterial()));
    const loadScene = vi.fn().mockResolvedValueOnce(firstScene).mockResolvedValueOnce(secondScene);
    const { unmount } = render(
      <BlenderSceneLayer loadScene={loadScene} pollIntervalMs={250} referenceRoot={new Group()} visible />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(loadScene).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(loadScene).toHaveBeenCalledTimes(2);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();

    unmount();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("treats a new Blender scene epoch as a new scene even when revision resets", async () => {
    vi.useFakeTimers();
    liveClient.getStatus
      .mockResolvedValueOnce(availableStatus(4, "scene-epoch-a"))
      .mockResolvedValue(availableStatus(4, "scene-epoch-b"));
    liveClient.getPreview
      .mockResolvedValueOnce({ blob: new Blob(["one"]), revision: 4, sceneEpoch: "scene-epoch-a" })
      .mockResolvedValueOnce({ blob: new Blob(["two"]), revision: 4, sceneEpoch: "scene-epoch-b" });
    const loadScene = vi.fn().mockResolvedValue(new Group());
    const collisionChanges = vi.fn();

    render(
      <BlenderSceneLayer
        loadScene={loadScene}
        onCollisionEnvironmentChange={collisionChanges}
        pollIntervalMs={250}
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(liveClient.getPreview).toHaveBeenCalledTimes(2);
    expect(loadScene).toHaveBeenCalledTimes(2);
    expect(collisionChanges.mock.calls.map(([environment]) => environment?.versionKey)).toEqual([
      "scene-epoch-a:4",
      "scene-epoch-b:4",
    ]);
  });

  it("backs off repeated preview failures but retries immediately for another scene epoch", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValue(availableStatus(2, "scene-epoch-a"));
    liveClient.getPreview.mockRejectedValue(new Error("preview unavailable"));
    const loadScene = vi.fn();

    render(<BlenderSceneLayer loadScene={loadScene} pollIntervalMs={250} referenceRoot={new Group()} visible />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(liveClient.getPreview).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(liveClient.getStatus).toHaveBeenCalledTimes(2);
    expect(liveClient.getPreview).toHaveBeenCalledTimes(1);

    liveClient.getStatus.mockResolvedValue(availableStatus(2, "scene-epoch-b"));
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["two"]),
      revision: 2,
      sceneEpoch: "scene-epoch-b",
    });
    loadScene.mockResolvedValue(new Group());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(liveClient.getPreview).toHaveBeenCalledTimes(2);
    expect(loadScene).toHaveBeenCalledOnce();
  });

  it("does not replace the last-good scene with a preview from another epoch or revision", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValueOnce(availableStatus(1)).mockResolvedValue(availableStatus(2));
    liveClient.getScene.mockResolvedValueOnce(sceneSnapshot(1)).mockResolvedValue(sceneSnapshot(2));
    liveClient.getPreview
      .mockResolvedValueOnce({ blob: new Blob(["current"]), revision: 1, sceneEpoch: "scene-epoch-a" })
      .mockResolvedValue({ blob: new Blob(["stale"]), revision: 1, sceneEpoch: "scene-epoch-a" });
    const geometry = new BoxGeometry();
    const material = new MeshStandardMaterial();
    const geometryDispose = vi.spyOn(geometry, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");
    const lastGoodScene = new Group();
    const lastGoodMesh = new Mesh(geometry, material);
    lastGoodScene.add(lastGoodMesh);
    const loadScene = vi.fn().mockResolvedValue(lastGoodScene);
    const collisionChanges = vi.fn();

    const { container, unmount } = render(
      <BlenderSceneLayer
        loadScene={loadScene}
        onCollisionEnvironmentChange={collisionChanges}
        pollIntervalMs={250}
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(loadScene).toHaveBeenCalledOnce();
    expect(collisionChanges).toHaveBeenCalledOnce();
    expect(collisionChanges.mock.calls[0]?.[0]?.meshes).toEqual([lastGoodMesh]);
    expect(container.querySelector("primitive")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(loadScene).toHaveBeenCalledOnce();
    expect(collisionChanges).toHaveBeenCalledOnce();
    expect(container.querySelector("primitive")).not.toBeNull();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();

    unmount();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });

  it("shows authoritative native selection and sends a clicked stable id back to Blender", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValue(availableStatus(3));
    liveClient.getScene.mockResolvedValue({
      ...sceneSnapshot(3),
      objects: [
        {
          id: "native-cube",
          name: "Native cube",
          type: "MESH",
          kind: "object",
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          localTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          dimensions: [1, 1, 1],
          visible: true,
          collections: ["Collection"],
          parentId: null,
          modifierCount: 0,
          constraints: [],
        },
      ],
    });
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 3,
      sceneEpoch: "scene-epoch-a",
    });
    const nativeRoot = new Group();
    const stableNode = new Group();
    stableNode.userData.worldengine_id = "native-cube";
    const clickedMesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    clickedMesh.position.set(2, 3, -1);
    stableNode.add(clickedMesh);
    nativeRoot.add(stableNode);
    liveClient.applyOperations.mockResolvedValue(
      nativeApplyResult({
        revisionBefore: 3,
        revisionAfter: 3,
        activeObjectId: "native-cube",
        selectedObjectIds: ["native-cube"],
      }),
    );
    const loadScene = vi.fn().mockResolvedValue(nativeRoot);
    const directorState = useDirectorStore.getState();
    useDirectorStore.setState({
      ...directorState,
      project: {
        ...directorState.project,
        objects: [
          ...directorState.project.objects,
          {
            id: "native:native-cube",
            name: "Native cube",
            kind: "prop",
            visible: true,
            locked: false,
            placementMode: "floating",
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            nativeSource: { engine: "blender", objectId: "native-cube" },
          },
        ],
      },
    });
    const { container, rerender } = render(
      <BlenderSceneLayer loadScene={loadScene} pollIntervalMs={250} referenceRoot={new Group()} visible />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const preview = container.querySelector("primitive");
    expect(preview).not.toBeNull();
    const click = createEvent.click(preview!);
    Object.defineProperty(click, "object", { value: clickedMesh });
    await act(async () => {
      fireEvent(preview!, click);
    });

    expect(liveClient.applyOperations).toHaveBeenCalledWith({
      expectedSceneEpoch: "scene-epoch-a",
      expectedRevision: 3,
      intentId: expect.any(String),
      operations: [
        {
          op: "set_selection",
          selectedIds: ["native-cube"],
          activeId: "native-cube",
          mode: "OBJECT",
        },
      ],
    });
    expect(useDirectorStore.getState().selectedObjectId).toBe("native:native-cube");
    expect(container.querySelector('primitive[name="blender-selection-native-cube"]')).not.toBeNull();
    const floorPivotControls = container.querySelector('[data-testid="blender-floor-pivot-controls"]');
    expect(floorPivotControls).toHaveAttribute("data-local-center", JSON.stringify([2, 2.5, -1]));

    fireEvent.click(floorPivotControls!);
    expect(stableNode.position.toArray()).toEqual([1, 0, 0]);
    expect(
      useDirectorStore.getState().project.objects.find((object) => object.id === "native:native-cube")?.transform
        .position,
    ).toEqual([1, 0, 0]);

    rerender(
      <BlenderSceneLayer
        interactionEnabled={false}
        loadScene={loadScene}
        pollIntervalMs={250}
        referenceRoot={new Group()}
        visible
      />,
    );
    const disabledPreview = container.querySelector("primitive");
    const disabledClick = createEvent.click(disabledPreview!);
    Object.defineProperty(disabledClick, "object", { value: clickedMesh });
    await act(async () => {
      fireEvent(disabledPreview!, disabledClick);
    });
    expect(liveClient.applyOperations).toHaveBeenCalledTimes(1);
  });

  it("publishes the active native camera pose and physical optics once per camera state", async () => {
    vi.useFakeTimers();
    liveClient.getStatus.mockResolvedValue(availableStatus(4));
    liveClient.getScene.mockResolvedValue({
      ...sceneSnapshot(4),
      cameras: [
        {
          id: "native-camera",
          name: "Native camera",
          position: [1, 2, 3],
          rotation: [0, 0, 0],
          projectionType: "PERSPECTIVE",
          focalLengthMm: 36,
          sensorFit: "HORIZONTAL",
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          shiftX: 0.12,
          shiftY: -0.08,
          clipStart: 0.05,
          clipEnd: 750,
          orthographicScale: 6,
          active: true,
        },
      ],
    });
    liveClient.getPreview.mockResolvedValue({
      blob: new Blob(["glb"]),
      revision: 4,
      sceneEpoch: "scene-epoch-a",
    });
    const cameraChanges = vi.fn();
    render(
      <BlenderSceneLayer
        loadScene={vi.fn().mockResolvedValue(new Group())}
        onActiveCameraChange={cameraChanges}
        pollIntervalMs={250}
        referenceRoot={new Group()}
        visible
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(cameraChanges).toHaveBeenCalledOnce();
    expect(cameraChanges).toHaveBeenCalledWith({
      aspectRatio: 16 / 9,
      clipEnd: 750,
      clipStart: 0.05,
      focalLengthMm: 36,
      fov: expect.closeTo(31.417, 3),
      orthographicScale: 6,
      position: [1, 2, 3],
      projectionType: "PERSPECTIVE",
      sensorFit: "HORIZONTAL",
      sensorHeightMm: 24,
      sensorWidthMm: 36,
      shiftX: 0.12,
      shiftY: -0.08,
      target: [1, 2, 2],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(cameraChanges).toHaveBeenCalledOnce();
  });

  it("disposes shared GPU resources and owned bitmap data once", () => {
    const geometry = new BoxGeometry();
    const image = { close: vi.fn() };
    const texture = new Texture(image);
    const material = new MeshStandardMaterial({ map: texture });
    const boneTexture = new DataTexture(new Uint8Array(16), 4, 1);
    const skeleton = new Skeleton([new Bone()]);
    skeleton.boneTexture = boneTexture;
    const first = new SkinnedMesh(geometry, material);
    const second = new SkinnedMesh(geometry, material);
    first.bind(skeleton);
    second.bind(skeleton);
    const scene = new Group();
    scene.userData.blenderOwnsImageBitmaps = true;
    scene.add(first, second);

    const geometryDispose = vi.spyOn(geometry, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");
    const textureDispose = vi.spyOn(texture, "dispose");
    const boneTextureDispose = vi.spyOn(boneTexture, "dispose");
    disposeBlenderScene(scene);

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(boneTextureDispose).toHaveBeenCalledOnce();
    expect(image.close).toHaveBeenCalledOnce();
    expect(skeleton.boneTexture).toBeNull();
  });
});
