import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { CameraViewportProperties } from "../../../../src/comprehensive/editor/canvas/CameraViewportProperties";
import { resetCameraViewportChromeOffsets } from "../../../../src/comprehensive/editor/canvas/viewportChromeDrag";
import { getVerticalFovFromFocalLength } from "../../../../src/comprehensive/editor/schema/cameraGeometry";

beforeEach(() => {
  resetCameraViewportChromeOffsets();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    selectedObjectId: "cam_object_1",
    selectedObjectIds: ["cam_object_1"],
  });
});

it("exposes the Flick camera fields beside the selected camera and persists their values", () => {
  render(<CameraViewportProperties />);

  expect(screen.getByLabelText("相机快捷属性")).toBeInTheDocument();
  expect(screen.getByLabelText("视口相机名称")).toHaveValue("机位01");
  expect(screen.getByLabelText("视口相机位置 X")).toBeInTheDocument();
  expect(screen.getByLabelText("视口相机旋转 Z")).toBeInTheDocument();
  expect(screen.getByLabelText("视口相机焦距")).toHaveValue(35);
  expect(screen.getByLabelText("视口相机宽高比")).toHaveValue("16:9");
  expect(screen.getByRole("button", { name: "移动当前相机" })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("视口相机名称"), { target: { value: "主机位" } });
  fireEvent.change(screen.getByLabelText("视口相机焦距"), { target: { value: "50" } });
  fireEvent.click(screen.getByRole("button", { name: "强烈" }));
  fireEvent.click(screen.getByRole("button", { name: "移动当前相机" }));

  const camera = useDirectorStore.getState().project.cameras[0];
  expect(camera.name).toBe("主机位");
  expect(camera.focalLengthMm).toBe(50);
  expect(camera.handheldShake).toBe("strong");
  expect(useDirectorStore.getState().transformMode).toBe("translate");
});

it("stays hidden unless a camera object is selected", () => {
  useDirectorStore.setState((state) => ({
    ...state,
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  }));

  render(<CameraViewportProperties />);

  expect(screen.queryByLabelText("相机快捷属性")).not.toBeInTheDocument();
});

it("defaults legacy cameras without an aspect ratio to 16:9", () => {
  const state = createInitialDirectorState();
  const camera = state.project.cameras[0]!;
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...state,
    project: {
      ...state.project,
      cameras: [{ ...camera, aspectRatio: undefined }],
    },
    selectedObjectId: "cam_object_1",
    selectedObjectIds: ["cam_object_1"],
  });

  render(<CameraViewportProperties />);

  expect(screen.getByLabelText("视口相机宽高比")).toHaveValue("16:9");
});

it("uses the selected camera sensor when quick focal and aspect controls recompute FOV", () => {
  useDirectorStore.getState().updateCamera("cam_1", { sensorFormat: "super16" });
  render(<CameraViewportProperties />);

  fireEvent.change(screen.getByLabelText("视口相机焦距"), { target: { value: "50" } });
  expect(useDirectorStore.getState().project.cameras[0]?.fov).toBeCloseTo(
    getVerticalFovFromFocalLength(50, "16:9", "super16"),
    6,
  );

  fireEvent.change(screen.getByLabelText("视口相机宽高比"), { target: { value: "4:3" } });
  expect(useDirectorStore.getState().project.cameras[0]?.fov).toBeCloseTo(
    getVerticalFovFromFocalLength(50, "4:3", "super16"),
    6,
  );
});

it("drags the camera properties panel from its header", async () => {
  render(
    <div className="canvas-frame" style={{ position: "relative", width: 800, height: 600 }}>
      <CameraViewportProperties />
    </div>,
  );

  const frame = document.querySelector(".canvas-frame") as HTMLElement;
  const panel = screen.getByLabelText("相机快捷属性");
  const handle = screen.getByLabelText("拖动相机属性面板");
  expect(panel).toHaveStyle({ "--camera-viewport-properties-width": "240px" });
  Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 274 });
  panel.getBoundingClientRect = () =>
    ({
      x: 18,
      y: 18,
      top: 18,
      left: 18,
      right: 258,
      bottom: 292,
      width: 240,
      height: 274,
      toJSON() {
        return {};
      },
    }) as DOMRect;
  frame.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON() {
        return {};
      },
    }) as DOMRect;

  fireEvent.pointerDown(handle, { button: 0, clientX: 40, clientY: 30, isPrimary: true, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 120, clientY: 90, isPrimary: true, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 120, clientY: 90, isPrimary: true, pointerId: 1 });

  await waitFor(() => expect(panel).toHaveStyle({ left: "98px", top: "78px" }));
});
