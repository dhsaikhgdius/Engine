import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { RightPanel } from "../../../../src/comprehensive/editor/panels/RightPanel";
import { useTimelineRuntimeStore } from "../../../../src/comprehensive/editor/runtime/timelineRuntimeStore";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";

beforeEach(() => {
  const initial = createInitialDirectorState();
  initial.selectedObjectId = "char_default_a";
  initial.selectedObjectIds = ["char_default_a"];
  initial.project.scene.timeline = {
    version: 1,
    fps: 24,
    frameStart: 0,
    frameEnd: 48,
    currentFrame: 0,
    loop: false,
  };
  initial.project.objects[0].animation = {
    version: 1,
    enabled: true,
    preset: "line",
    orientToPath: true,
    motion: "walk",
    source: "preset",
    color: "#18c7e6",
    keyframes: [
      { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { frame: 48, transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ],
  };
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...initial });
  useTimelineRuntimeStore.getState().reset();
  useTimelineRuntimeStore.getState().selectTrack("object:char_default_a", 0);
});

it("edits frame-native trajectory metadata and keyframes from the right inspector", () => {
  render(<RightPanel />);

  expect(screen.getByLabelText("运动轨迹右侧属性面板")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "轨迹移动动作" }));
  fireEvent.click(screen.getByRole("option", { name: "跑动（连续步态）" }));
  expect(useDirectorStore.getState().project.objects[0].animation?.motion).toBe("run");

  fireEvent.change(screen.getByLabelText("轨迹关键帧帧号"), { target: { value: "12" } });
  expect(useDirectorStore.getState().project.objects[0].animation?.keyframes[0].frame).toBe(12);

  fireEvent.click(screen.getByRole("button", { name: "渐入" }));
  expect(useDirectorStore.getState().project.objects[0].animation?.keyframes[0].timingCurve).toEqual({
    x1: 0.42,
    y1: 0,
    x2: 1,
    y2: 1,
  });

  fireEvent.click(screen.getByLabelText("沿轨迹自动朝向"));
  expect(useDirectorStore.getState().project.objects[0].animation?.orientToPath).toBe(false);
});

it("removes only transform trajectory data and returns to the ordinary inspector", () => {
  render(<RightPanel />);
  fireEvent.click(screen.getByRole("button", { name: "删除整条轨迹" }));
  expect(useDirectorStore.getState().project.objects[0].animation).toBeUndefined();
  expect(useTimelineRuntimeStore.getState().selectedTrackKey).toBeNull();
});

it("explains path, timing, and spatial handles as separate inspector sections", () => {
  render(<RightPanel />);

  expect(screen.getByRole("heading", { name: "路径" })).toBeInTheDocument();
  expect(screen.getByText("预设会重算整条路线。自由绘制保留你拖过的点。")).toBeInTheDocument();
  expect(screen.getByText("只改快慢，不改路线。左下是这一帧，右上是下一帧。")).toBeInTheDocument();
  expect(screen.getByText("空间手柄，单位米。全 0 是折线。跟上面的时间曲线不是一回事。")).toBeInTheDocument();
  expect(screen.getByText("到达这一帧")).toBeInTheDocument();
  expect(screen.getByText("离开这一帧")).toBeInTheDocument();
  expect(screen.getByText("位置")).toBeInTheDocument();
  expect(screen.getByText("预设生成")).toBeInTheDocument();
});

it("edits camera Path speed and target locking from the trajectory inspector", () => {
  const state = useDirectorStore.getState();
  const camera = state.project.cameras[0]!;
  useDirectorStore.setState({
    ...state,
    selectedObjectId: "cam_object_1",
    selectedObjectIds: ["cam_object_1"],
    project: {
      ...state.project,
      cameras: [
        {
          ...camera,
          action: { mode: "path", path: { speed: 1, lockTarget: false, targetObjectId: null } },
          animation: {
            version: 1,
            enabled: true,
            preset: "custom",
            keyframes: [
              { frame: 0, transform: camera.transform },
              { frame: 48, transform: { ...camera.transform, position: [3, 1, 0] } },
            ],
          },
        },
      ],
    },
  });
  useTimelineRuntimeStore.getState().selectTrack("camera:cam_1", 0);

  render(<RightPanel />);

  fireEvent.change(screen.getByLabelText("轨迹机位移动速度"), { target: { value: "1.8" } });
  expect(useDirectorStore.getState().project.cameras[0]?.action).toMatchObject({
    mode: "path",
    path: { speed: 1.8 },
  });

  fireEvent.click(screen.getByLabelText("轨迹机位锁定目标"));
  fireEvent.click(screen.getByRole("option", { name: "角色01" }));
  fireEvent.click(screen.getByLabelText("轨迹机位保持注视目标"));
  expect(useDirectorStore.getState().project.cameras[0]?.action).toMatchObject({
    path: { lockTarget: true, targetObjectId: "char_default_a" },
  });
});
