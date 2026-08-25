import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { clearViewportCaptureHandler, setViewportCaptureHandler } from "../../../../src/comprehensive/editor/io/captureBridge";
import { clearDirectorDeskHostBridge, initDirectorDeskHostBridge } from "../../../../src/comprehensive/editor/io/hostBridge";
import { getCameraRigPositionFromViewSnapshot, getVerticalFovFromFocalLength } from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useVideoRecordingStore } from "../../../../src/comprehensive/editor/video/videoRecordingStore";
import { CameraPanel } from "../../../../src/comprehensive/editor/panels/CameraPanel";

function expandCameraSection(title: string) {
  fireEvent.click(screen.getByRole("button", { name: title }));
}

function seedCameraCapture() {
  useDirectorStore.setState((state) => ({
    ...state,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) =>
        camera.id === "cam_1"
          ? {
              ...camera,
              lastCaptureUrl: "data:image/png;base64,camera-preview",
              captures: [
                {
                  id: "cam_1-capture-01",
                  index: 1,
                  name: "机位01-截图01",
                  dataUrl: "data:image/png;base64,camera-preview",
                },
              ],
            }
          : camera,
      ),
    },
  }));
}

function seedGroupedCameraCaptures() {
  const baseState = useDirectorStore.getState();
  const firstCamera = baseState.project.cameras[0];
  expect(firstCamera).toBeTruthy();

  useDirectorStore.setState({
    ...baseState,
    project: {
      ...baseState.project,
      cameras: [
        {
          ...firstCamera!,
          captures: [
            {
              id: "cam_1-capture-01",
              index: 1,
              name: "机位01-截图01",
              dataUrl: "data:image/png;base64,camera-1-a",
            },
            {
              id: "cam_1-capture-02",
              index: 2,
              name: "机位01-截图02",
              dataUrl: "data:image/png;base64,camera-1-b",
            },
          ],
          lastCaptureUrl: "data:image/png;base64,camera-1-b",
        },
        {
          ...firstCamera!,
          id: "cam_2",
          name: "机位02",
          captures: [
            {
              id: "cam_2-capture-01",
              index: 1,
              name: "机位02-截图01",
              dataUrl: "data:image/png;base64,camera-2-a",
            },
          ],
          lastCaptureUrl: "data:image/png;base64,camera-2-a",
        },
      ],
    },
  });
}

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    selectedObjectId: "cam_object_1",
  });
  useVideoRecordingStore.getState().reset();
});

afterEach(() => {
  clearViewportCaptureHandler();
  clearDirectorDeskHostBridge();
  vi.restoreAllMocks();
});

it("renders the Flick-compatible camera panel fields", () => {
  render(<CameraPanel />);
  expandCameraSection("高级光学");
  expandCameraSection("镜头运动");
  expandCameraSection("注视");

  expect(screen.getByText("相机")).toBeInTheDocument();
  expect(screen.getByLabelText("机位名称")).toBeInTheDocument();
  expect(screen.getByLabelText("切换机位")).toBeInTheDocument();
  expect(screen.getByLabelText("相机位置 X")).toHaveValue(-0.843);
  expect(screen.getByLabelText("相机旋转 X")).toHaveValue(-8.658);
  expect(screen.getByLabelText("相机焦距")).toHaveValue(35);
  expect(screen.getByText("高级光学")).toBeInTheDocument();
  expect(screen.getByLabelText("相机光圈")).toHaveValue(2.8);
  expect(screen.getByLabelText("相机对焦距离")).toHaveValue(5);
  expect(screen.getByLabelText("相机快门角度")).toHaveValue(180);
  expect(screen.getByLabelText("相机 ISO")).toHaveValue(800);
  expect(screen.getByLabelText("相机实际快门秒数")).toHaveTextContent("0.020833 s（1/48）");
  expect(screen.getByLabelText("相机 EV100")).toHaveTextContent("5.56");
  expect(screen.getByLabelText("相机近裁剪面")).toHaveValue(0.1);
  expect(screen.getByLabelText("相机远裁剪面")).toHaveValue(2000);
  expect(screen.getByLabelText("相机变形宽银幕挤压")).toHaveValue(1);
  expect(screen.getByLabelText("相机宽高比")).toHaveTextContent("16:9");
  expect(screen.getByLabelText("手持镜头晃动")).toHaveTextContent("关");
  expect(screen.getByLabelText("注视目标模式")).toBeInTheDocument();
  expect(screen.getByLabelText("注视坐标 X")).toBeInTheDocument();
});

it("uses the provided right inspector layout for camera properties", () => {
  const { container } = render(<CameraPanel />);
  expandCameraSection("注视");

  expect(screen.getByLabelText("相机右侧属性面板")).toHaveClass("right-inspector");
  expect(container.querySelector(".right-inspector-tabs")).toBeInTheDocument();
  expect(container.querySelector(".right-inspector-content")).toBeInTheDocument();
  expect(screen.queryByLabelText("机位预览卡片")).not.toBeInTheDocument();
  expect(screen.queryByText("FOV 50°")).not.toBeInTheDocument();
  expect(container.querySelector("select.inspector-select-input")).not.toBeInTheDocument();
  expect(screen.getByLabelText("切换机位")).toHaveClass("inspector-dropdown-trigger");
  expect(screen.getByLabelText("注视目标模式")).toHaveClass("inspector-dropdown-trigger");

  const positionY = screen.getByLabelText("相机位置 Y").closest(".inspector-axis-input");
  const focalField = screen.getByLabelText("相机焦距").closest(".inspector-unit-number-field");

  expect(positionY).toBeInTheDocument();
  expect(within(positionY as HTMLElement).getByText("Y")).toHaveClass("inspector-axis-prefix");
  expect(focalField).toBeInTheDocument();
});

it("keeps camera panel tab labels in fixed slots while switching tabs", async () => {
  const user = userEvent.setup();
  const { container } = render(<CameraPanel />);
  const tabList = container.querySelector(".right-inspector-tabs");
  const propertyTab = screen.getByRole("button", { name: "属性" });
  const capturesTab = screen.getByRole("button", { name: "摄像机截图" });
  const recordingsTab = screen.getByRole("button", { name: "渲染视频" });

  expect(tabList).toHaveClass("right-inspector-tabs");
  expect(screen.getByLabelText("相机右侧属性面板")).toHaveClass("camera-inspector", "flick-camera-inspector");
  expect(propertyTab).toHaveClass("right-inspector-tab-button");
  expect(capturesTab).toHaveClass("right-inspector-tab-button");
  expect(recordingsTab).toHaveClass("right-inspector-tab-button");
  expect(propertyTab).toHaveAttribute("aria-pressed", "true");

  // The video library is a first-class camera tab; users do not need to
  // create or open a still capture before viewing it.
  await user.click(recordingsTab);
  expect(recordingsTab).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("status", { name: "暂无渲染视频" })).toBeInTheDocument();

  await user.click(capturesTab);

  expect(propertyTab).toHaveClass("right-inspector-tab-button");
  expect(capturesTab).toHaveClass("right-inspector-tab-button");
  expect(capturesTab).toHaveAttribute("aria-pressed", "true");
});

it("updates the selected camera name and focal length", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);

  await user.clear(screen.getByLabelText("机位名称"));
  await user.type(screen.getByLabelText("机位名称"), "近景机位");
  await user.clear(screen.getByLabelText("相机焦距"));
  await user.type(screen.getByLabelText("相机焦距"), "65");

  const camera = useDirectorStore.getState().project.cameras[0];
  expect(camera.name).toBe("近景机位");
  expect(camera.focalLengthMm).toBe(65);
  expect(camera.fov).toBeCloseTo(17.708, 3);
});

it("keeps output aspect and handheld shake on the camera shot", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);
  expandCameraSection("镜头运动");

  await user.click(screen.getByLabelText("相机宽高比"));
  await user.click(within(screen.getByRole("listbox", { name: "相机宽高比" })).getByRole("option", { name: "2.39:1" }));
  await user.click(screen.getByLabelText("手持镜头晃动"));
  await user.click(within(screen.getByRole("listbox", { name: "手持镜头晃动" })).getByRole("option", { name: "中" }));

  const state = useDirectorStore.getState();
  expect(state.project.cameras[0]).toMatchObject({ aspectRatio: "2.39:1", handheldShake: "medium" });
  expect(state.viewportAspectRatio).toBe("2.39:1");
});

it("changes the physical sensor and recomputes the shot FOV", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);
  const before = useDirectorStore.getState().project.cameras[0]!.fov;

  await user.click(screen.getByLabelText("相机传感器"));
  await user.click(
    within(screen.getByRole("listbox", { name: "相机传感器" })).getByRole("option", { name: "Super 35" }),
  );

  const camera = useDirectorStore.getState().project.cameras[0]!;
  expect(camera.sensorFormat).toBe("super35");
  expect(camera.focalLengthMm).toBe(35);
  expect(camera.fov).not.toBeCloseTo(before, 3);
});

it("applies a cinematography preset and updates the camera plus viewport framing", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);

  expect(screen.getByText("摄影指导")).toBeInTheDocument();
  expect(screen.queryByLabelText("摄影兼容性检查")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "摄影指导" }));
  expect(screen.getByLabelText("摄影兼容性检查")).toHaveTextContent("参数兼容");
  await user.click(screen.getByLabelText("摄影风格预设"));
  await user.click(
    within(screen.getByRole("listbox", { name: "摄影风格预设" })).getByRole("option", {
      name: "变形宽银幕夜景",
    }),
  );
  await user.click(screen.getByRole("button", { name: "应用摄影预设 变形宽银幕夜景" }));

  const state = useDirectorStore.getState();
  expect(state.project.cameras[0]).toMatchObject({
    focalLengthMm: 50,
    sensorFormat: "super35",
    apertureFStop: 2,
    focusDistanceM: 5,
    shutterAngle: 180,
    iso: 1600,
    anamorphicSqueeze: 2,
    aspectRatio: "2.39:1",
    handheldShake: "subtle",
  });
  expect(state.project.cameras[0]?.fov).toBeGreaterThan(0);
  expect(state.viewportAspectRatio).toBe("2.39:1");
  expect(screen.getByLabelText("摄影兼容性检查")).toHaveTextContent("参数兼容");
});

it("authors advanced optical metadata and rejects an inverted clipping range", () => {
  render(<CameraPanel />);
  expandCameraSection("高级光学");

  fireEvent.change(screen.getByLabelText("相机光圈"), { target: { value: "1.4" } });
  fireEvent.change(screen.getByLabelText("相机对焦距离"), { target: { value: "2.75" } });
  fireEvent.change(screen.getByLabelText("相机快门角度"), { target: { value: "144" } });
  fireEvent.change(screen.getByLabelText("相机 ISO"), { target: { value: "1600" } });
  fireEvent.change(screen.getByLabelText("相机近裁剪面"), { target: { value: "0.02" } });
  fireEvent.change(screen.getByLabelText("相机远裁剪面"), { target: { value: "8000" } });
  fireEvent.change(screen.getByLabelText("相机变形宽银幕挤压"), { target: { value: "1.8" } });

  expect(useDirectorStore.getState().project.cameras[0]).toMatchObject({
    apertureFStop: 1.4,
    focusDistanceM: 2.75,
    shutterAngle: 144,
    iso: 1600,
    nearClipM: 0.02,
    farClipM: 8000,
    anamorphicSqueeze: 1.8,
  });
  expect(screen.getByLabelText("相机实际快门秒数")).toHaveTextContent("0.016667 s（1/60）");
  expect(screen.getByLabelText("相机 EV100")).toHaveTextContent("2.88");

  fireEvent.change(screen.getByLabelText("相机近裁剪面"), { target: { value: "50" } });
  fireEvent.change(screen.getByLabelText("相机远裁剪面"), { target: { value: "10" } });
  expect(useDirectorStore.getState().project.cameras[0]?.farClipM).toBe(8000);
});

it("provides Flick camera actions with persisted path and follow settings", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);
  expandCameraSection("镜头运动");

  await user.click(screen.getByLabelText("相机动作模式"));
  await user.click(
    within(screen.getByRole("listbox", { name: "相机动作模式" })).getByRole("option", { name: "路径（Path）" }),
  );
  expect(screen.getByLabelText("路径移动速度")).toHaveValue(1);
  fireEvent.change(screen.getByLabelText("路径移动速度"), { target: { value: "1.5" } });
  expect(useDirectorStore.getState().project.cameras[0]?.action).toMatchObject({
    mode: "path",
    path: { speed: 1.5 },
  });

  await user.click(screen.getByLabelText("相机动作模式"));
  await user.click(
    within(screen.getByRole("listbox", { name: "相机动作模式" })).getByRole("option", { name: "跟随（Follow）" }),
  );
  await user.click(screen.getByLabelText("相机跟随对象"));
  await user.click(
    within(screen.getByRole("listbox", { name: "相机跟随对象" })).getByRole("option", { name: "角色01" }),
  );
  expect(useDirectorStore.getState().project.cameras[0]?.action).toMatchObject({
    mode: "follow",
    follow: { targetObjectId: "char_default_a" },
  });
});

it("records a Transform camera keyframe at the timeline playhead", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState((state) => ({
    ...state,
    project: {
      ...state.project,
      scene: {
        ...state.project.scene,
        timeline: { version: 1, fps: 24, frameStart: 0, frameEnd: 48, currentFrame: 18, loop: false },
      },
    },
  }));
  render(<CameraPanel />);
  expandCameraSection("镜头运动");

  await user.click(screen.getByLabelText("相机动作模式"));
  await user.click(
    within(screen.getByRole("listbox", { name: "相机动作模式" })).getByRole("option", { name: "Transform（关键帧）" }),
  );
  await user.click(screen.getByRole("button", { name: "在当前帧记录关键帧" }));

  expect(useDirectorStore.getState().project.cameras[0]).toMatchObject({
    action: { mode: "transform" },
    animation: { keyframes: [{ frame: 18 }] },
  });
});

it("authors a measured A to B camera move as one undoable change", async () => {
  const user = userEvent.setup();
  const target: [number, number, number] = [0, 1, 0];
  const focalLengthMm = 50;
  const fov = getVerticalFovFromFocalLength(focalLengthMm);
  const positionA: [number, number, number] = [0, 1, 10];

  useDirectorStore.setState((state) => ({
    ...state,
    project: {
      ...state.project,
      scene: {
        ...state.project.scene,
        timeline: { version: 1, fps: 24, frameStart: 0, frameEnd: 48, currentFrame: 0, loop: false },
      },
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        action: { mode: "still" as const },
        animation: undefined,
        focalLengthMm,
        fov,
        target,
        transform: {
          ...camera.transform,
          position: getCameraRigPositionFromViewSnapshot({ position: positionA, target, fov }),
        },
      })),
    },
  }));
  render(<CameraPanel />);
  expandCameraSection("镜头运动");

  await user.click(screen.getByRole("button", { name: "记录构图 A" }));
  expect(screen.getByRole("status", { name: "A/B 运镜状态" })).toHaveTextContent("A · 第 0 帧");

  const positionB: [number, number, number] = [0, 1, 5];
  useDirectorStore.setState((state) => ({
    ...state,
    project: {
      ...state.project,
      scene: {
        ...state.project.scene,
        timeline: { ...state.project.scene.timeline!, currentFrame: 24 },
      },
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        transform: {
          ...camera.transform,
          position: getCameraRigPositionFromViewSnapshot({ position: positionB, target, fov }),
        },
      })),
    },
  }));

  await user.click(screen.getByRole("button", { name: "记录构图 B 并生成运镜" }));

  const authored = useDirectorStore.getState().project.cameras[0]!;
  expect(authored.action).toEqual({ mode: "transform" });
  expect(authored.animation?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 6, 12, 18, 24]);
  expect(screen.getByRole("status", { name: "A/B 运镜状态" })).toHaveTextContent("推进 · 24 帧");

  useDirectorStore.getState().undo();
  expect(useDirectorStore.getState().project.cameras[0]).toMatchObject({ action: { mode: "still" } });
  expect(useDirectorStore.getState().project.cameras[0]?.animation).toBeUndefined();
});

it("does not create an A to B move until B is later on the timeline", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);
  expandCameraSection("镜头运动");

  await user.click(screen.getByRole("button", { name: "记录构图 A" }));
  await user.click(screen.getByRole("button", { name: "记录构图 B 并生成运镜" }));

  expect(screen.getByRole("status", { name: "A/B 运镜状态" })).toHaveTextContent("请将播放头移到 A 之后");
  expect(useDirectorStore.getState().project.cameras[0]?.animation).toBeUndefined();
});

it("uses the custom dropdown menu to switch camera shots", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCameraShot();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("切换机位"));

  const menu = screen.getByRole("listbox", { name: "切换机位" });

  expect(menu).toHaveClass("inspector-dropdown-menu");

  await user.click(within(menu).getByRole("option", { name: "机位01" }));

  expect(useDirectorStore.getState().project.activeCameraId).toBe("cam_1");
  expect(screen.queryByRole("listbox", { name: "切换机位" })).not.toBeInTheDocument();
});

it("renders target mode as the custom dropdown menu", async () => {
  const user = userEvent.setup();

  render(<CameraPanel />);
  expandCameraSection("注视");

  await user.click(screen.getByLabelText("注视目标模式"));

  const menu = screen.getByRole("listbox", { name: "注视目标模式" });
  const manualOption = within(menu).getByRole("option", { name: "手动坐标" });

  expect(menu).toHaveClass("inspector-dropdown-menu");
  expect(manualOption).toHaveClass("is-selected");
  expect(manualOption).toHaveAttribute("aria-selected", "true");
});

it("lists visible viewport models as camera focus targets and centers on the selected model", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().addGeometryPrimitive("box");

  render(<CameraPanel />);
  expandCameraSection("注视");

  await user.click(screen.getByLabelText("注视目标模式"));

  const menu = screen.getByRole("listbox", { name: "注视目标模式" });
  const modelNames = within(menu)
    .getAllByRole("option")
    .map((option) => option.textContent);

  expect(modelNames).toEqual(["手动坐标", "角色01", "角色02", "立方体"]);
  expect(within(menu).queryByRole("option", { name: "机位01" })).not.toBeInTheDocument();

  await user.click(within(menu).getByRole("option", { name: "角色02" }));

  const state = useDirectorStore.getState();
  const focusedObject = state.project.objects.find((item) => item.name === "角色02");
  const camera = state.project.cameras.find((item) => item.id === state.project.activeCameraId);

  expect(focusedObject).toBeTruthy();
  expect(camera?.targetMode).toBe("object");
  expect(camera?.targetObjectId).toBe(focusedObject?.id);
  expect(camera?.target).toEqual([-1.25, 0.89, 0]);
  expect(screen.getByLabelText("注视目标模式")).toHaveTextContent("角色02");
  expect(screen.getByLabelText("注视坐标 X")).toHaveValue(-1.25);
  expect(screen.getByLabelText("注视坐标 Y")).toHaveValue(0.89);
  expect(screen.getByLabelText("注视坐标 Z")).toHaveValue(0);
});

it("updates camera position and target coordinates across all axes", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);
  expandCameraSection("注视");

  await user.clear(screen.getByLabelText("相机位置 Y"));
  await user.type(screen.getByLabelText("相机位置 Y"), "3.4");
  await user.clear(screen.getByLabelText("相机位置 Z"));
  await user.type(screen.getByLabelText("相机位置 Z"), "7.5");
  await user.clear(screen.getByLabelText("注视坐标 Y"));
  await user.type(screen.getByLabelText("注视坐标 Y"), "1.8");
  await user.clear(screen.getByLabelText("注视坐标 Z"));
  await user.type(screen.getByLabelText("注视坐标 Z"), "2");

  const camera = useDirectorStore.getState().project.cameras[0];
  expect(screen.getByLabelText("相机位置 Y")).toHaveValue(3.4);
  expect(screen.getByLabelText("相机位置 Z")).toHaveValue(7.5);
  expect(camera.target).toEqual([0.107576, 1.8, 2]);
});

it("selects the camera and enables the viewport move handle", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState((state) => ({
    ...state,
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
    transformMode: "rotate",
  }));
  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "在画布中移动机位" }));

  expect(useDirectorStore.getState().selectedObjectId).toBe("cam_object_1");
  expect(useDirectorStore.getState().transformMode).toBe("translate");
});

it("captures the current camera preview from the properties tab and shows it in the screenshots overview", async () => {
  const user = userEvent.setup();
  setViewportCaptureHandler(async () => [
    {
      label: "当前机位",
      dataUrl: "data:image/png;base64,camera-preview",
      meta: {
        mode: "camera",
        cameraId: "cam_1",
        fov: 50,
        position: [0, 2.2, 9],
        target: [0, 1.2, 0],
      },
    },
  ]);

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "截图到画布" }));
  await user.click(screen.getByRole("button", { name: "摄像机截图" }));

  expect(useDirectorStore.getState().project.cameras[0]?.lastCaptureUrl).toBe("data:image/png;base64,camera-preview");
  expect(useDirectorStore.getState().project.cameras[0]?.captures).toEqual([
    {
      id: "cam_1-capture-01",
      index: 1,
      name: "机位01-截图01",
      dataUrl: "data:image/png;base64,camera-preview",
    },
  ]);
  expect(await screen.findByAltText("机位01-截图01 缩略图")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "机位01截图" })).toBeInTheDocument();
  expect(screen.getByText("机位01-截图01")).toBeInTheDocument();
});

it("keeps the camera capture section visible at the bottom of the properties tab", () => {
  render(<CameraPanel />);

  expect(screen.getByRole("heading", { name: "相机截图" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "截图到画布" })).toHaveClass("camera-capture-current-button");
  expect(screen.getByTestId("camera-current-capture-icon")).toBeInTheDocument();
});

it("renders the thumbnail actions in a bottom bar and opens the project-style viewer toolbar", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);

  expect(screen.getByRole("group", { name: "机位01-截图01 缩略图操作" })).toHaveClass("camera-capture-actions");

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));

  const viewer = screen.getByRole("dialog", { name: "相机截图查看器" });
  const toolbar = within(viewer).getByRole("toolbar", { name: "相机截图查看器工具栏" });

  expect(viewer).toBeInTheDocument();
  expect(screen.getByAltText("机位01-截图01 查看大图")).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "放大图片" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "缩小图片" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "下载图片" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "关闭相机截图查看器" })).toBeInTheDocument();
});

it("keeps the viewer dialog semantics on the content and the backdrop as presentation", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  const { container } = render(<CameraPanel />);

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));

  const viewer = screen.getByRole("dialog", { name: "相机截图查看器" });
  const backdrop = container.querySelector(".camera-capture-viewer");

  expect(viewer).toHaveAttribute("aria-modal", "true");
  expect(backdrop).toHaveAttribute("role", "presentation");
  expect(backdrop).toContainElement(viewer);
  expect(within(viewer).getByRole("toolbar", { name: "相机截图查看器工具栏" })).toBeInTheDocument();
});

it("moves focus into the viewer, closes on Escape, and restores the thumbnail trigger", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);
  const trigger = screen.getByLabelText("查看截图 机位01-截图01");

  await user.click(trigger);
  expect(screen.getByRole("button", { name: "放大图片" })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "相机截图查看器" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("sends a single camera capture to the host canvas when the thumbnail action is clicked", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  seedCameraCapture();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "发送到画布 机位01-截图01" }));

  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-captures-sent",
      payload: {
        captures: [
          {
            dataUrl: "data:image/png;base64,camera-preview",
            fileName: "机位01-截图01.png",
          },
        ],
      },
    },
    window.location.origin,
  );
});

it("shows all camera screenshots grouped by camera in the screenshots tab", async () => {
  const user = userEvent.setup();
  seedGroupedCameraCaptures();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "摄像机截图" }));

  const firstGroup = screen.getByRole("region", { name: "机位01截图" });
  const secondGroup = screen.getByRole("region", { name: "机位02截图" });

  expect(screen.queryByRole("heading", { name: "相机截图" })).not.toBeInTheDocument();
  expect(within(firstGroup).getByRole("heading", { name: "机位01截图" })).toBeInTheDocument();
  expect(within(firstGroup).getByText("机位01-截图01")).toBeInTheDocument();
  expect(within(firstGroup).getByText("机位01-截图02")).toBeInTheDocument();
  expect(within(secondGroup).getByRole("heading", { name: "机位02截图" })).toBeInTheDocument();
  expect(within(secondGroup).getByText("机位02-截图01")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "清空全部" })).toHaveClass("camera-capture-clear-all");
  expect(screen.getByRole("button", { name: "发送到画布" })).toHaveClass(
    "camera-capture-send-all",
    "viewport-toolbar-crowd-confirm",
  );
  expect(screen.getByRole("button", { name: "发送到画布" })).not.toHaveClass("is-hover-state");
  expect(screen.getByTestId("camera-capture-clear-icon")).toBeInTheDocument();
  expect(screen.getByTestId("camera-capture-send-icon")).toBeInTheDocument();

  const panel = screen.getByLabelText("相机右侧属性面板");
  const content = panel.querySelector(".right-inspector-content");
  const footer = panel.querySelector(".camera-capture-overview-footer");

  expect(footer).toBeInTheDocument();
  expect(content).toBeInTheDocument();
  expect(content).not.toContainElement(footer as HTMLElement);
});

it("sends all visible camera screenshots to the host canvas from the overview footer", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  seedGroupedCameraCaptures();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "摄像机截图" }));
  await user.click(screen.getByRole("button", { name: "发送到画布" }));

  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-captures-sent",
      payload: {
        captures: [
          {
            dataUrl: "data:image/png;base64,camera-1-a",
            fileName: "机位01-截图01.png",
          },
          {
            dataUrl: "data:image/png;base64,camera-1-b",
            fileName: "机位01-截图02.png",
          },
          {
            dataUrl: "data:image/png;base64,camera-2-a",
            fileName: "机位02-截图01.png",
          },
        ],
      },
    },
    window.location.origin,
  );
});

it("clears every camera screenshot from the screenshots tab and shows the empty state", async () => {
  const user = userEvent.setup();
  seedGroupedCameraCaptures();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "摄像机截图" }));
  await user.click(screen.getByRole("button", { name: "清空全部" }));

  // First click only arms the inline confirmation; nothing is cleared yet.
  expect(screen.getByText("机位01-截图01")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "确认清空全部截图？" }));

  expect(screen.queryByText("机位01-截图01")).not.toBeInTheDocument();
  const emptyState = screen.getByRole("status", { name: "暂无摄像机截图" });
  expect(emptyState).toHaveClass("camera-capture-empty", "object-search-empty-state");
  expect(screen.getByTestId("camera-capture-empty-icon")).toHaveClass("object-search-empty-icon");
  expect(screen.getByTestId("camera-capture-empty-icon").querySelector(".lucide-images")).toBeInTheDocument();
  expect(screen.getByTestId("camera-capture-empty-icon").querySelector(".lucide-search")).not.toBeInTheDocument();
  expect(screen.getByText("暂无摄像机截图")).toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras.map((camera) => camera.captures ?? [])).toEqual([[], []]);
  expect(useDirectorStore.getState().project.cameras.map((camera) => camera.lastCaptureUrl ?? null)).toEqual([
    null,
    null,
  ]);
});

it("restores every cleared screenshot with a single undo step", async () => {
  const user = userEvent.setup();
  seedGroupedCameraCaptures();
  useDirectorStore.setState({ ...useDirectorStore.getState(), undoStack: [], redoStack: [] });

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "摄像机截图" }));
  await user.click(screen.getByRole("button", { name: "清空全部" }));
  await user.click(screen.getByRole("button", { name: "确认清空全部截图？" }));

  expect(useDirectorStore.getState().project.cameras.map((camera) => camera.captures ?? [])).toEqual([[], []]);
  // Clearing two cameras must produce exactly one undo entry (batched), so one
  // Cmd+Z brings all screenshots back.
  expect(useDirectorStore.getState().undoStack).toHaveLength(1);

  useDirectorStore.getState().undo();

  const cameras = useDirectorStore.getState().project.cameras;
  expect(cameras[0]?.captures).toHaveLength(2);
  expect(cameras[1]?.captures).toHaveLength(1);
});

it("keeps camera screenshots when the armed clear-all confirmation loses focus", async () => {
  const user = userEvent.setup();
  seedGroupedCameraCaptures();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "摄像机截图" }));
  await user.click(screen.getByRole("button", { name: "清空全部" }));
  expect(screen.getByRole("button", { name: "确认清空全部截图？" })).toBeInTheDocument();

  await user.tab();

  expect(screen.getByRole("button", { name: "清空全部" })).toBeInTheDocument();
  expect(screen.getByText("机位01-截图01")).toBeInTheDocument();
});

it("closes the capture viewer when clicking outside the image", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  const { container } = render(<CameraPanel />);

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));

  const previewImage = screen.getByAltText("机位01-截图01 查看大图");
  const viewerStage = container.querySelector(".camera-capture-viewer-stage");

  expect(viewerStage).toBeInTheDocument();

  await user.click(previewImage);
  expect(screen.getByRole("dialog", { name: "相机截图查看器" })).toBeInTheDocument();

  await user.click(viewerStage as HTMLElement);
  expect(screen.queryByRole("dialog", { name: "相机截图查看器" })).not.toBeInTheDocument();
});

it("zooms the capture preview through the viewer toolbar controls with the canvas image preview step", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));
  await user.click(screen.getByRole("button", { name: "放大图片" }));

  expect(screen.getByAltText("机位01-截图01 查看大图")).toHaveStyle({
    transform: "translate(0px, 0px) scale(1.25)",
  });
});

it("supports wheel zooming and dragging like the canvas image preview", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));

  const previewImage = screen.getByAltText("机位01-截图01 查看大图");

  fireEvent.wheel(previewImage, { deltaY: -100 });
  expect(previewImage).toHaveStyle({ transform: "translate(0px, 0px) scale(1.25)" });

  fireEvent.mouseDown(previewImage, { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 124, clientY: 132 });
  fireEvent.mouseUp(window);

  expect(previewImage).toHaveStyle({ transform: "translate(24px, 32px) scale(1.25)" });
});

it("deletes a camera capture from the screenshot grid", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("删除截图 机位01-截图01"));

  expect(screen.queryByText("机位01-截图01")).not.toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras[0]?.captures).toEqual([]);
  expect(useDirectorStore.getState().project.cameras[0]?.lastCaptureUrl).toBeNull();
});

it("shows session render recordings beside camera screenshots with full clip metadata", async () => {
  const user = userEvent.setup();
  useVideoRecordingStore.getState().addRecording({
    blob: new Blob(["video"], { type: "video/webm" }),
    thumbnailDataUrl: "data:image/png;base64,thumbnail",
    extension: "webm",
    mimeType: "video/webm",
    frameStart: 12,
    frameEnd: 36,
    frameCount: 25,
    sourceFps: 24,
    outputFps: 24,
    durationSec: 1,
  });

  render(<CameraPanel />);
  await user.click(screen.getByRole("button", { name: "渲染视频" }));

  expect(screen.getByLabelText("渲染视频记录列表")).toBeInTheDocument();
  expect(screen.getByAltText("渲染视频01 缩略图")).toHaveAttribute("src", "data:image/png;base64,thumbnail");
  expect(screen.getByText("F12–F36")).toBeInTheDocument();
  expect(screen.getByText("1.000s")).toBeInTheDocument();
  expect(screen.getByText("WEBM")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下载 渲染视频01" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送 渲染视频01 到 ComfyUI" })).toBeInTheDocument();

  // Render recordings live only in page memory, so deletion needs an explicit
  // two-step confirmation instead of a single destructive click.
  await user.click(screen.getByRole("button", { name: "删除 渲染视频01" }));
  expect(screen.getByLabelText("渲染视频记录列表")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "确认删除 渲染视频01" }));
  expect(screen.getByRole("status", { name: "暂无渲染视频" })).toBeInTheDocument();
});

it("keeps the recording when the armed delete confirmation loses focus", async () => {
  const user = userEvent.setup();
  useVideoRecordingStore.getState().addRecording({
    blob: new Blob(["video"], { type: "video/webm" }),
    thumbnailDataUrl: "data:image/png;base64,thumbnail",
    extension: "webm",
    mimeType: "video/webm",
    frameStart: 0,
    frameEnd: 24,
    frameCount: 25,
    sourceFps: 24,
    outputFps: 24,
    durationSec: 1,
  });

  render(<CameraPanel />);
  await user.click(screen.getByRole("button", { name: "渲染视频" }));

  await user.click(screen.getByRole("button", { name: "删除 渲染视频01" }));
  expect(screen.getByRole("button", { name: "确认删除 渲染视频01" })).toBeInTheDocument();

  await user.tab();

  expect(screen.getByRole("button", { name: "删除 渲染视频01" })).toBeInTheDocument();
  expect(useVideoRecordingStore.getState().recordings).toHaveLength(1);
});

it("clears the whole render video library only after the inline confirmation", async () => {
  const user = userEvent.setup();
  for (const [frameStart, frameEnd] of [
    [0, 24],
    [24, 48],
  ] as const) {
    useVideoRecordingStore.getState().addRecording({
      blob: new Blob(["video"], { type: "video/webm" }),
      thumbnailDataUrl: "data:image/png;base64,thumbnail",
      extension: "webm",
      mimeType: "video/webm",
      frameStart,
      frameEnd,
      frameCount: frameEnd - frameStart + 1,
      sourceFps: 24,
      outputFps: 24,
      durationSec: 1,
    });
  }

  render(<CameraPanel />);
  await user.click(screen.getByRole("button", { name: "渲染视频" }));

  await user.click(screen.getByRole("button", { name: "清空全部" }));
  expect(useVideoRecordingStore.getState().recordings).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "确认清空？渲染视频不可恢复" }));

  expect(useVideoRecordingStore.getState().recordings).toHaveLength(0);
  expect(screen.getByRole("status", { name: "暂无渲染视频" })).toBeInTheDocument();
});

it("uploads one recording to ComfyUI and reflects the host acknowledgement", async () => {
  const user = userEvent.setup();
  const item = useVideoRecordingStore.getState().addRecording({
    blob: new Blob(["video"], { type: "video/mp4" }),
    thumbnailDataUrl: "data:image/png;base64,thumbnail",
    extension: "mp4",
    mimeType: "video/mp4;codecs=avc1.42E01E",
    frameStart: 0,
    frameEnd: 24,
    frameCount: 25,
    sourceFps: 24,
    outputFps: 24,
    durationSec: 1,
  });
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();
  render(<CameraPanel />);
  await user.click(screen.getByRole("button", { name: "渲染视频" }));
  await user.click(screen.getByRole("button", { name: "发送 渲染视频01 到 ComfyUI" }));
  const message = postMessage.mock.calls
    .map(([payload]) => payload as { type?: string; payload?: { requestId?: string } })
    .find((payload) => payload.type === "storyai:director-desk-video-sent");
  expect(message?.payload?.requestId).toBeTruthy();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-video-result",
        payload: {
          requestId: message!.payload!.requestId,
          ok: true,
          relativeName: "director/render-01.mp4",
          nodeType: "VHS_LoadVideo",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  await screen.findByText("已上传并创建 VHS_LoadVideo");
  expect(useVideoRecordingStore.getState().recordings.find((recording) => recording.id === item.id)).toMatchObject({
    status: "uploaded",
    statusMessage: "已上传并创建 VHS_LoadVideo",
  });
});
