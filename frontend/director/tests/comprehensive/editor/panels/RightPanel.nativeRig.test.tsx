// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderLiveSceneSnapshot,
  type BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";

const live = vi.hoisted(() => ({
  apply: vi.fn(),
  inspect: vi.fn(),
  scene: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/api/blenderLiveClient")>();
  return {
    ...actual,
    applyBlenderNativeOperations: live.apply,
    getBlenderLiveScene: live.scene,
    getBlenderLiveStatus: live.status,
    inspectBlenderLiveObject: live.inspect,
  };
});

import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";
import { RightPanel } from "../../../../src/comprehensive/editor/panels/RightPanel";

const compatibleRigInspection: BlenderObjectInspection = {
  id: "rig-a",
  name: "X Bot Rig",
  type: "ARMATURE",
  mode: "OBJECT",
  dimensions: [1, 1, 1],
  evaluatedBounds: {
    min: [-0.5, -0.5, -0.5],
    max: [0.5, 0.5, 0.5],
    center: [0, 0, 0],
    size: [1, 1, 1],
  },
  selection: { selected: true, active: true },
  materialNodes: [],
  materialSlots: [],
  materialGraphs: [],
  geometryGraphs: [],
  rig: {
    boneCount: 1,
    poseBoneCount: 1,
    deformBoneCount: 1,
    constraintCount: 0,
    activeBoneRef: "hips",
    selectedBoneRefs: ["hips"],
    directorStateToken: "",
    mixamoCompatibility: { compatible: true, missingBoneRoles: [], mappedBoneCount: 15 },
    bones: [
      {
        boneRef: "hips",
        parentRef: null,
        deform: true,
        selected: true,
        local: { location: [0, 0, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
        restLocal: { location: [0, 0, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
      },
    ],
  },
  animation: {
    action: null,
    activeAction: null,
    actions: [],
    fCurveCount: 0,
    keyframeCount: 0,
    driverCount: 0,
    nlaTrackCount: 0,
    nlaStripCount: 0,
    nlaTracks: [],
  },
  warnings: [],
};

function nativeObject(
  id: string,
  type: string,
  parentId: string | null = null,
): BlenderLiveSceneSnapshot["objects"][number] {
  return {
    id,
    name: id,
    type,
    kind: type.toLocaleLowerCase(),
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    localTransform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    dimensions: [1, 1, 1],
    visible: true,
    collections: ["Collection"],
    parentId,
    modifierCount: 0,
    constraints: [],
  };
}

function publishRuntimeScene(objects: BlenderLiveSceneSnapshot["objects"], activeObjectId: string | null) {
  useBlenderRuntimeStore.getState().publishStatus({
    available: true,
    ok: true,
    contract: BLENDER_LIVE_CONTRACT,
    projectId: "director-project-a",
    blenderVersion: "5.1.2",
    busy: false,
    revision: 8,
    sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
  });
  useBlenderRuntimeStore.getState().publishSnapshot({
    contract: BLENDER_LIVE_CONTRACT,
    projectId: "director-project-a",
    sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
    revision: 8,
    sceneName: "Scene",
    frame: 1,
    unit: "meter",
    coordinateSystem: "right-handed-y-up-negative-z-forward",
    objects,
    cameras: [],
    lights: [],
    selectedObjectIds: activeObjectId ? [activeObjectId] : [],
    activeObjectId,
  });
}

beforeEach(() => {
  useBlenderRuntimeStore.getState().reset();
  vi.clearAllMocks();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  live.scene.mockResolvedValue({
    sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
    revision: 8,
    frame: 1,
    activeObjectId: "rig-a",
    objects: [{ id: "rig-a", name: "X Bot Rig", type: "ARMATURE" }],
  });
  live.status.mockResolvedValue({ available: true });
  live.inspect.mockResolvedValue({
    inspection: compatibleRigInspection,
  });
});

afterEach(cleanup);

it("keeps Director Properties when Blender has an unrelated active armature", async () => {
  render(<RightPanel />);

  expect(screen.getByLabelText("3D场景右侧属性面板")).toBeInTheDocument();
  expect(screen.queryByLabelText("骨骼属性面板")).not.toBeInTheDocument();
  expect(live.scene).not.toHaveBeenCalled();
});

it("shows the rig for the Director-selected native object", async () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...state.project,
      nativeScene: { engine: "blender", projectId: "director-project-a" },
      objects: [
        ...state.project.objects,
        {
          id: "native-rig-a",
          name: "X Bot Rig",
          kind: "prop",
          visible: true,
          locked: false,
          placementMode: "floating",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          nativeSource: { engine: "blender", objectId: "rig-a" },
        },
      ],
    },
    selectedObjectId: "native-rig-a",
    selectedObjectIds: ["native-rig-a"],
  });
  publishRuntimeScene([nativeObject("rig-a", "ARMATURE"), nativeObject("mesh-a", "MESH", "rig-a")], "rig-a");

  render(<RightPanel />);

  expect(await screen.findByLabelText("骨骼属性面板")).toBeInTheDocument();
  expect(screen.getByLabelText("模型右侧属性面板")).toBeInTheDocument();
  expect(screen.queryByLabelText("Blender 场景")).not.toBeInTheDocument();
  expect(live.inspect).toHaveBeenCalledWith(
    "rig-a",
    expect.objectContaining({
      expectedSceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
      expectedRevision: 8,
    }),
  );
});

it("uses the Director character panel as the only primary UI for a compatible native character", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...state.project,
      nativeScene: { engine: "blender", projectId: "director-project-a" },
      objects: state.project.objects.map((object) =>
        object.id === "char_default_a"
          ? {
              ...object,
              nativeSource: { engine: "blender" as const, objectId: "character-root", provisioned: true },
            }
          : object,
      ),
    },
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  publishRuntimeScene(
    [
      nativeObject("character-root", "EMPTY"),
      nativeObject("rig-a", "ARMATURE", "character-root"),
      nativeObject("mesh-a", "MESH", "character-root"),
    ],
    "rig-a",
  );
  useBlenderRuntimeStore.getState().publishNativeRigCapability({
    rootObjectId: "character-root",
    status: "ready",
    compatible: true,
    missingBoneRoles: [],
    mappedBoneCount: 15,
    sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
    revision: 8,
    inspection: compatibleRigInspection,
  });

  render(<RightPanel />);

  expect(await screen.findByLabelText("角色右侧属性面板")).toBeInTheDocument();
  expect(screen.queryByLabelText("骨骼属性面板")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Blender 场景")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "姿势" }));
  expect(await screen.findByText("姿势预设")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "动作" }));
  await user.click(screen.getByRole("button", { name: "角色骨骼动作" }));
  await user.click(screen.getByRole("option", { name: /向前行走/ }));
  expect(
    screen.getByText("Blender 角色动作使用独立动作轨道与完整权重；往返和混合淡入淡出尚未接入 Blender 骨架。"),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("角色动作权重")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("角色动作淡入秒数")).not.toBeInTheDocument();
  expect(useBlenderRuntimeStore.getState().nativeRigCapabilities["character-root"]).toMatchObject({
    status: "ready",
    compatible: true,
    mappedBoneCount: 15,
  });
});

it("keeps asset-backed mesh tools out of Director Properties", async () => {
  const state = useDirectorStore.getState();
  live.scene.mockResolvedValue({
    sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
    revision: 8,
    frame: 1,
    activeObjectId: null,
    objects: [],
  });
  useDirectorStore.setState({
    project: {
      ...state.project,
      assets: [
        ...state.project.assets,
        {
          id: "asset-chair",
          kind: "prop",
          sourceType: "model",
          fileName: "chair.glb",
          url: "/native-models/model/chair.glb",
        },
      ],
      objects: [
        ...state.project.objects,
        {
          id: "prop-chair",
          name: "Chair",
          kind: "prop",
          visible: true,
          locked: false,
          assetRefId: "asset-chair",
          placementMode: "grounded",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          nativeSource: { engine: "blender", objectId: "prop-chair", provisioned: true },
        },
      ],
    },
    selectedObjectId: "prop-chair",
    selectedObjectIds: ["prop-chair"],
  });

  render(<RightPanel />);

  expect(screen.queryByLabelText("Blender 场景")).not.toBeInTheDocument();
  expect(screen.getByLabelText("模型右侧属性面板")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "PBR 材质" })).not.toBeInTheDocument();
});

it("keeps Blender-created mesh tools out of Director Properties", async () => {
  const state = useDirectorStore.getState();
  live.scene.mockResolvedValue({
    sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
    revision: 8,
    frame: 1,
    activeObjectId: "native-cube",
    objects: [{ id: "native-cube", name: "Native cube", type: "MESH", parentId: null }],
  });
  useDirectorStore.setState({
    project: {
      ...state.project,
      objects: [
        ...state.project.objects,
        {
          id: "native:native-cube",
          name: "Native cube",
          kind: "prop",
          visible: true,
          locked: false,
          placementMode: "floating",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          nativeSource: { engine: "blender", objectId: "native-cube", provisioned: true },
        },
      ],
    },
    selectedObjectId: "native:native-cube",
    selectedObjectIds: ["native:native-cube"],
  });
  publishRuntimeScene([nativeObject("native-cube", "MESH")], "native-cube");

  render(<RightPanel />);

  expect(screen.queryByLabelText("Blender 场景")).not.toBeInTheDocument();
  expect(screen.getByLabelText("模型右侧属性面板")).toBeInTheDocument();
});

it("does not add mesh tools to a Blender-created camera", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...state.project,
      nativeScene: { engine: "blender", projectId: "director-project-a" },
      objects: [
        ...state.project.objects,
        {
          id: "native:native-camera",
          name: "Native camera",
          kind: "prop",
          visible: true,
          locked: false,
          placementMode: "floating",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          nativeSource: { engine: "blender", objectId: "native-camera", provisioned: true },
        },
      ],
    },
    selectedObjectId: "native:native-camera",
    selectedObjectIds: ["native:native-camera"],
  });
  publishRuntimeScene([nativeObject("native-camera", "CAMERA")], "native-camera");

  render(<RightPanel />);

  expect(screen.queryByLabelText("Blender 场景")).not.toBeInTheDocument();
  expect(screen.getByLabelText("模型右侧属性面板")).toBeInTheDocument();
});
