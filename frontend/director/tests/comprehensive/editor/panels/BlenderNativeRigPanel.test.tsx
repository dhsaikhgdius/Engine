// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderLiveSceneSnapshot,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";

const live = vi.hoisted(() => ({
  apply: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/i18n/language", () => {
  const translate = (value: string) => value;
  return { useLanguage: () => ({ t: translate }) };
});

vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/api/blenderLiveClient")>();
  return {
    ...actual,
    applyBlenderNativeOperations: live.apply,
    inspectBlenderLiveObject: live.inspect,
  };
});

import { BlenderLiveClientError } from "../../../../src/comprehensive/editor/api/blenderLiveClient";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";
import {
  createDefaultDirectorProject,
  useDirectorStore,
} from "../../../../src/comprehensive/editor/store/directorStore";
import { BlenderNativeRigPanel } from "../../../../src/comprehensive/editor/panels/BlenderNativeRigPanel";

const sceneEpoch = "48b0d9b3-2bf8-46a7-8832-909d816369e2";

function sceneSnapshot(
  revision = 4,
  activeObjectType: "ARMATURE" | "MESH" = "ARMATURE",
  frame = 12,
): BlenderLiveSceneSnapshot {
  return {
    contract: BLENDER_LIVE_CONTRACT,
    projectId: "director-project-a",
    sceneEpoch,
    revision,
    sceneName: "Scene",
    frame,
    unit: "meter",
    coordinateSystem: "right-handed-y-up-negative-z-forward",
    objects: [
      {
        id: "rig-a",
        name: "X Bot Rig",
        type: activeObjectType,
        kind: "object",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        localTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        dimensions: [1, 2, 1],
        visible: true,
        collections: ["Collection"],
        parentId: null,
        modifierCount: 0,
        constraints: [],
      },
    ],
    cameras: [],
    lights: [],
    selectedObjectIds: ["rig-a"],
    activeObjectId: "rig-a",
  };
}

function rigInspection(options: { activeBoneRef?: string | null; revision?: number } = {}) {
  const activeBoneRef = options.activeBoneRef === undefined ? "spine" : options.activeBoneRef;
  return {
    id: "rig-a",
    name: "X Bot Rig",
    type: "ARMATURE",
    rig: {
      boneCount: 3,
      poseBoneCount: 3,
      deformBoneCount: 2,
      constraintCount: 0,
      mixamoCompatibility: {
        compatible: true,
        missingBoneRoles: [],
        mappedBoneCount: 22,
      },
      activeBoneRef,
      selectedBoneRefs: activeBoneRef ? [activeBoneRef] : [],
      bones: [
        {
          boneRef: "root",
          parentRef: null,
          deform: false,
          selected: false,
          local: { location: [0, 0, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
          restLocal: { location: [0, 0, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
        },
        {
          boneRef: "hips",
          parentRef: "root",
          deform: true,
          selected: false,
          local: { location: [0, 1, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
          restLocal: { location: [0, 1, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
        },
        {
          boneRef: "spine",
          parentRef: "hips",
          deform: true,
          selected: activeBoneRef === "spine",
          local: { location: [0, 0.5, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
          restLocal: { location: [0, 0.5, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    },
    animation: {
      action: "Confrontation",
      activeAction: {
        actionName: "Confrontation",
        active: true,
        frameRange: [1, 48],
        fCurveCount: 6,
        keyframeCount: 12,
        keyedFrames: [1, 12, 24, 48],
      },
      actions: [
        {
          actionName: "Confrontation",
          active: true,
          frameRange: [1, 48],
          fCurveCount: 6,
          keyframeCount: 12,
          keyedFrames: [1, 12, 24, 48],
        },
      ],
      nlaTracks: [
        {
          name: "Locomotion",
          mute: false,
          solo: false,
          strips: [
            {
              name: "Walk 01",
              actionName: "Confrontation",
              frameStart: 12,
              frameEnd: 60,
              actionFrameStart: 1,
              actionFrameEnd: 48,
              blendMode: "REPLACE",
              influence: 1,
              repeat: 1,
              scale: 1,
            },
          ],
        },
      ],
    },
  };
}

function applyResult(revisionAfter = 5) {
  return {
    receipt: {
      revisionAfter,
      operations: [{ op: "set_pose_bone_transform" }],
    },
  };
}

afterEach(cleanup);

describe("Blender native rig properties", () => {
  beforeEach(() => {
    useBlenderRuntimeStore.getState().reset();
    vi.clearAllMocks();
    const current = useDirectorStore.getState();
    const project = createDefaultDirectorProject();
    useDirectorStore.setState({
      ...current,
      project: {
        ...project,
        nativeScene: { engine: "blender", projectId: "director-project-a" },
        objects: [
          ...project.objects,
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
      selectedCrowdId: null,
    });
    live.inspect.mockResolvedValue({ inspection: rigInspection() });
    live.apply.mockResolvedValue(applyResult());
    useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot());
  });

  it("keeps the existing Properties panel when the native active object is not an armature", async () => {
    useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot(5, "MESH"));
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);

    expect(screen.getByText("Existing properties")).toBeInTheDocument();
    await act(async () => {});
    expect(live.inspect).not.toHaveBeenCalled();
  });

  it("reads one revision-bound armature inspection and renders Bones, Pose, and Action in Properties", async () => {
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);

    expect(await screen.findByLabelText("骨骼属性面板")).toBeInTheDocument();
    expect(screen.getByText("Existing properties")).toBeInTheDocument();
    expect(screen.getByText("骨骼")).toBeInTheDocument();
    expect(screen.getByText("姿势")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(live.inspect).toHaveBeenCalledWith("rig-a", {
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
      signal: expect.any(AbortSignal),
    });
  });

  it("waits for the shared poller after a bound inspect conflict", async () => {
    live.inspect
      .mockRejectedValueOnce(new BlenderLiveClientError("revision changed", 409, "revision_conflict"))
      .mockResolvedValueOnce({ inspection: rigInspection() });

    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);

    await waitFor(() => expect(useBlenderRuntimeStore.getState().refreshRequestId).toBe(1));
    act(() => useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot(5)));
    expect(await screen.findByLabelText("骨骼属性面板")).toBeInTheDocument();
    expect(live.inspect).toHaveBeenNthCalledWith(2, "rig-a", expect.objectContaining({ expectedRevision: 5 }));
  });

  it("uses the same typed atomic apply path for bone selection and canonical quaternion pose edits", async () => {
    const user = userEvent.setup();
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);
    await screen.findByLabelText("骨骼属性面板");

    await user.click(screen.getByRole("button", { name: "hips" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        operations: [
          {
            op: "select_pose_bones",
            id: "rig-a",
            boneRefs: ["hips"],
            activeBoneRef: "hips",
            action: "SET",
          },
        ],
      }),
    );

    fireEvent.change(screen.getByLabelText("本地旋转四元数 W"), { target: { value: "-2" } });
    await user.click(screen.getByRole("button", { name: "应用姿势" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "set_pose_bone_transform",
            id: "rig-a",
            boneRef: "spine",
            local: {
              location: [0, 0.5, 0],
              rotationQuaternion: [1, 0, 0, 0],
              scale: [1, 1, 1],
            },
          },
        ],
      }),
    );
  });

  it("creates actions explicitly and never inserts a key without an existing active action", async () => {
    const user = userEvent.setup();
    live.inspect.mockResolvedValue({
      inspection: {
        ...rigInspection(),
        animation: { action: null, activeAction: null, actions: [] },
      },
    });
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);
    await screen.findByLabelText("骨骼属性面板");

    expect(screen.getByRole("button", { name: "插入关键帧" })).toBeDisabled();
    await user.type(screen.getByLabelText("新 Action 名称"), "Blocking Take");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [{ op: "create_action", id: "rig-a", actionName: "Blocking Take" }],
      }),
    );
  });

  it("inserts and deletes selected-bone keys with the inspected active action and current frame", async () => {
    const user = userEvent.setup();
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);
    await screen.findByLabelText("骨骼属性面板");

    await user.click(screen.getByRole("button", { name: "插入关键帧" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "insert_pose_keyframes",
            id: "rig-a",
            actionName: "Confrontation",
            frame: 12,
            boneRefs: ["spine"],
            channels: ["LOCATION", "ROTATION", "SCALE"],
            interpolation: "BEZIER",
          },
        ],
      }),
    );

    await user.click(screen.getByRole("button", { name: "删除关键帧" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "delete_pose_keyframes",
            id: "rig-a",
            actionName: "Confrontation",
            frame: 12,
            boneRefs: ["spine"],
            channels: ["LOCATION", "ROTATION", "SCALE"],
          },
        ],
      }),
    );
  });

  it("imports a packaged Mixamo motion by catalog id without sending an asset path", async () => {
    const user = userEvent.setup();
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);
    await screen.findByLabelText("骨骼属性面板");

    await user.selectOptions(screen.getByLabelText("Mixamo 动作"), "walk");
    await user.selectOptions(screen.getByLabelText("根运动"), "AUTHORED");
    await user.click(screen.getByRole("button", { name: "导入 Mixamo 动作" }));

    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "import_mixamo_action",
            id: "rig-a",
            motionId: "walk",
            rootMotion: "AUTHORED",
            replaceExisting: false,
          },
        ],
      }),
    );
  });

  it("creates an NLA track and adds an existing Action as a configured strip", async () => {
    const user = userEvent.setup();
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);
    await screen.findByLabelText("骨骼属性面板");

    await user.type(screen.getByLabelText("新 NLA Track 名称"), "Upper Body");
    await user.click(screen.getByRole("button", { name: "创建 Track" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [{ op: "create_nla_track", id: "rig-a", trackName: "Upper Body" }],
      }),
    );

    await user.type(screen.getByLabelText("新 Strip 名称"), "Confrontation 02");
    await user.selectOptions(screen.getByLabelText("Strip 混合模式"), "ADD");
    fireEvent.change(screen.getByLabelText("Strip 起始帧"), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText("Strip 权重"), { target: { value: "0.7" } });
    fireEvent.change(screen.getByLabelText("Strip 重复"), { target: { value: "2" } });
    await user.click(screen.getByRole("button", { name: "添加 Strip" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "add_nla_strip",
            id: "rig-a",
            trackName: "Locomotion",
            stripName: "Confrontation 02",
            actionName: "Confrontation",
            startFrame: 24,
            blendMode: "ADD",
            influence: 0.7,
            repeat: 2,
            scale: 1,
          },
        ],
      }),
    );
  });

  it("updates and removes an inspected NLA strip", async () => {
    const user = userEvent.setup();
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);
    await screen.findByLabelText("骨骼属性面板");

    await user.selectOptions(screen.getByLabelText("Walk 01 混合模式"), "COMBINE");
    fireEvent.change(screen.getByLabelText("Walk 01 权重"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Walk 01 重复"), { target: { value: "3" } });
    await user.click(screen.getByRole("button", { name: "更新 Walk 01" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "update_nla_strip",
            id: "rig-a",
            trackName: "Locomotion",
            stripName: "Walk 01",
            blendMode: "COMBINE",
            influence: 0.5,
            repeat: 3,
          },
        ],
      }),
    );

    await user.click(screen.getByRole("button", { name: "删除 Walk 01" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "remove_nla_strip",
            id: "rig-a",
            trackName: "Locomotion",
            stripName: "Walk 01",
          },
        ],
      }),
    );
  });

  it("keeps receipt-bound bone selection and frame before inserting the next key", async () => {
    const user = userEvent.setup();
    live.inspect
      .mockResolvedValueOnce({ inspection: rigInspection({ activeBoneRef: "spine" }) })
      .mockResolvedValue({ inspection: rigInspection({ activeBoneRef: "hips" }) });

    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);
    await screen.findByLabelText("骨骼属性面板");

    await user.click(screen.getByRole("button", { name: "hips" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "hips" })).toHaveAttribute("aria-current", "true"));
    expect(screen.getByLabelText("本地位置 Y")).toHaveValue(1);

    await user.clear(screen.getByLabelText("当前帧"));
    await user.type(screen.getByLabelText("当前帧"), "24");
    await user.click(screen.getByRole("button", { name: "跳转" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ operations: [{ op: "set_scene_frame", frame: 24 }] }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "跳转" })).toBeDisabled());

    await user.click(screen.getByRole("button", { name: "插入关键帧" }));
    expect(live.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operations: [
          {
            op: "insert_pose_keyframes",
            id: "rig-a",
            actionName: "Confrontation",
            frame: 24,
            boneRefs: ["hips"],
            channels: ["LOCATION", "ROTATION", "SCALE"],
            interpolation: "BEZIER",
          },
        ],
      }),
    );
    expect(live.inspect).toHaveBeenCalledTimes(4);
  });

  it("retains the last-good rig panel when apply fails", async () => {
    const user = userEvent.setup();
    live.apply.mockRejectedValueOnce(new Error("Blender rejected pose"));
    render(<BlenderNativeRigPanel fallback={<div>Existing properties</div>} />);
    await screen.findByLabelText("骨骼属性面板");

    await user.click(screen.getByRole("button", { name: "应用姿势" }));

    expect(await screen.findByText("Blender rejected pose")).toBeInTheDocument();
    expect(screen.getByLabelText("骨骼属性面板")).toBeInTheDocument();
  });
});
