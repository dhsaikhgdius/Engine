import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { ScenePanel } from "../../../../src/comprehensive/editor/panels/ScenePanel";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

function expandSceneTransform() {
  fireEvent.click(screen.getByRole("button", { name: "变换" }));
}

function expandPanoramaPrecision() {
  fireEvent.click(screen.getByRole("button", { name: "全景精调" }));
}

function expandGroundPrecision() {
  fireEvent.click(screen.getByRole("button", { name: "地面高度精调" }));
}

it("uses the provided right inspector layout for scene properties", () => {
  const { container } = render(<ScenePanel />);

  expect(screen.getByLabelText("3D场景右侧属性面板")).toHaveClass("right-inspector", "scene-inspector");
  expect(container.querySelector(".right-inspector-header")).toBeInTheDocument();
  expect(container.querySelector(".right-inspector-content")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "变换" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "显示与吸附" })).toBeInTheDocument();
  expandSceneTransform();
  expect(screen.getByLabelText("场景平移 X").closest(".inspector-axis-input")).toBeInTheDocument();
});

it("keeps semantic scene controls open and folds numeric calibration", () => {
  render(<ScenePanel />);

  expect(screen.getByRole("button", { name: "变换" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "背景与全景" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "显示与吸附" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "全景精调" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "地面高度精调" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "氛围" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "剖切平面" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "灯光" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByLabelText("启用环境照明")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "添加灯光" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("场景缩放")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("全景球半径")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("地面高度")).not.toBeInTheDocument();
});

it("keeps scene switches as individual rows and only toggles from the checkbox", async () => {
  const user = userEvent.setup();
  const { container } = render(<ScenePanel />);

  const switchRow = container.querySelector(".scene-switch-row");
  const labelText = screen.getByText("视口标签");
  const checkbox = screen.getByLabelText("视口标签");

  expect(switchRow).toBeInTheDocument();
  expect(switchRow?.querySelectorAll(".inspector-toggle-row")).toHaveLength(3);
  expect(checkbox).not.toBeChecked();

  await user.click(labelText);

  expect(checkbox).not.toBeChecked();

  await user.click(checkbox);

  expect(checkbox).toBeChecked();
});

it("updates scene transform, panorama, and ground controls", async () => {
  const user = userEvent.setup();
  render(<ScenePanel />);

  expandSceneTransform();
  expandPanoramaPrecision();
  expandGroundPrecision();
  await user.clear(screen.getByLabelText("场景缩放"));
  await user.type(screen.getByLabelText("场景缩放"), "1.3");
  await user.clear(screen.getByLabelText("场景平移 Y"));
  await user.type(screen.getByLabelText("场景平移 Y"), "2");
  await user.clear(screen.getByLabelText("场景旋转 Z"));
  await user.type(screen.getByLabelText("场景旋转 Z"), "45");
  await user.clear(screen.getByLabelText("天空颜色 HEX"));
  await user.type(screen.getByLabelText("天空颜色 HEX"), "#123456");
  await user.clear(screen.getByLabelText("全景球水平旋转"));
  await user.type(screen.getByLabelText("全景球水平旋转"), "30");
  await user.clear(screen.getByLabelText("全景球半径"));
  await user.type(screen.getByLabelText("全景球半径"), "90");
  await user.click(screen.getByLabelText("视口标签"));
  await user.click(screen.getByLabelText("网格吸附"));
  await user.clear(screen.getByLabelText("地面高度"));
  await user.type(screen.getByLabelText("地面高度"), "1.2");

  const scene = useDirectorStore.getState().project.scene;
  expect(scene.scale).toBe(1.3);
  expect(scene.position).toEqual([0, 2, 0]);
  expect(scene.rotation).toEqual([0, 0, 45]);
  expect(scene.backgroundColor).toBe("#123456");
  expect(scene.panoramaYaw).toBe(30);
  expect(scene.panoramaRadius).toBe(90);
  expect(scene.showLabels).toBe(true);
  expect(scene.snapToGrid).toBe(true);
  expect(scene.groundHeight).toBe(1.2);
});

it("edits environment, fog, and a complete authored light", async () => {
  const user = userEvent.setup();
  render(<ScenePanel />);

  await user.click(screen.getByRole("button", { name: "氛围" }));
  await user.click(screen.getByLabelText("启用环境照明"));
  await user.clear(screen.getByLabelText("环境照明强度"));
  await user.type(screen.getByLabelText("环境照明强度"), "0.9");
  await user.click(screen.getByLabelText("启用雾效"));
  await user.clear(screen.getByLabelText("线性雾远端"));
  await user.type(screen.getByLabelText("线性雾远端"), "150");

  await user.click(screen.getByRole("button", { name: "灯光" }));
  await user.click(screen.getByRole("button", { name: "新增灯光类型" }));
  await user.click(screen.getByRole("option", { name: "聚光灯" }));
  await user.click(screen.getByRole("button", { name: "添加灯光" }));
  await user.clear(screen.getByLabelText("灯光名称"));
  await user.type(screen.getByLabelText("灯光名称"), "轮廓光");
  await user.clear(screen.getByLabelText("灯光强度"));
  await user.type(screen.getByLabelText("灯光强度"), "3.5");
  await user.clear(screen.getByLabelText("灯光位置 X"));
  await user.type(screen.getByLabelText("灯光位置 X"), "4");

  const state = useDirectorStore.getState();
  expect(state.project.scene.environment).toMatchObject({ enabled: true, intensity: 0.9 });
  expect(state.project.scene.fog).toMatchObject({ enabled: true, far: 150 });
  expect(state.project.lights?.find((light) => light.name === "轮廓光")).toMatchObject({
    type: "spot",
    intensity: 3.5,
    position: [4, 5, 3],
  });
});

it("renders a connected panorama as a compact thumbnail card with the file name overlay", () => {
  const initialState = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...initialState,
    project: {
      ...initialState.project,
      assets: [
        {
          id: "asset_panorama_1",
          kind: "panorama",
          sourceType: "image",
          fileName: "studio-panorama.jpg",
          url: "data:image/jpeg;base64,panorama-preview",
        },
      ],
      panoramaAssetId: "asset_panorama_1",
    },
  });

  render(<ScenePanel />);

  expect(screen.queryByText("已连接全景图: studio-panorama.jpg")).not.toBeInTheDocument();
  expect(screen.queryByText("全景图预览")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("全景图预览卡片")).not.toBeInTheDocument();

  const thumbnailCard = screen.getByLabelText("全景图缩略图卡片");
  const thumbnailImage = screen.getByAltText("studio-panorama.jpg 全景图缩略图");

  expect(thumbnailCard).toHaveClass("panorama-thumbnail-card");
  expect(screen.getByText("studio-panorama.jpg")).toHaveClass("panorama-thumbnail-name");
  expect(thumbnailImage).toHaveClass("panorama-thumbnail-image");
  expect(thumbnailImage).toHaveAttribute("src", "data:image/jpeg;base64,panorama-preview");
});

it("removes the connected panorama when the delete icon is clicked", async () => {
  const user = userEvent.setup();
  const initialState = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...initialState,
    project: {
      ...initialState.project,
      assets: [
        {
          id: "asset_panorama_1",
          kind: "panorama",
          sourceType: "image",
          fileName: "studio-panorama.jpg",
          url: "data:image/jpeg;base64,panorama-preview",
        },
      ],
      panoramaAssetId: "asset_panorama_1",
    },
  });

  render(<ScenePanel />);

  await user.click(screen.getByRole("button", { name: "删除全景图" }));

  expect(useDirectorStore.getState().project.panoramaAssetId).toBeNull();
  expect(useDirectorStore.getState().project.assets).toHaveLength(0);
  expect(screen.getByLabelText("全景图连接状态")).toBeInTheDocument();
});

it("renders the disconnected panorama state as a fixed-size dark card", () => {
  render(<ScenePanel />);

  const panoramaStatus = screen.getByLabelText("全景图连接状态");

  expect(panoramaStatus).toHaveClass("panorama-empty-card");
  expect(screen.getByTestId("panorama-empty-icon")).toBeInTheDocument();
  expect(panoramaStatus).toHaveTextContent("未连接全景图");
});

it("updates panorama radius from both slider and numeric input", async () => {
  const user = userEvent.setup();
  render(<ScenePanel />);

  expandPanoramaPrecision();
  await user.clear(screen.getByLabelText("全景球半径"));
  await user.type(screen.getByLabelText("全景球半径"), "150");

  expect(useDirectorStore.getState().project.scene.panoramaRadius).toBe(150);
  expect(screen.getByLabelText("全景球半径滑杆")).toHaveValue("150");

  fireEvent.change(screen.getByLabelText("全景球半径滑杆"), { target: { value: "149" } });

  expect(useDirectorStore.getState().project.scene.panoramaRadius).toBe(149);
  expect(screen.getByLabelText("全景球半径")).toHaveValue(149);
});

it("updates panorama yaw and ground height from both sliders and numeric inputs", async () => {
  const user = userEvent.setup();
  render(<ScenePanel />);

  expandPanoramaPrecision();
  expandGroundPrecision();
  await user.clear(screen.getByLabelText("全景球水平旋转"));
  await user.type(screen.getByLabelText("全景球水平旋转"), "45");

  expect(useDirectorStore.getState().project.scene.panoramaYaw).toBe(45);
  expect(screen.getByLabelText("全景球水平旋转滑杆")).toHaveValue("45");

  fireEvent.change(screen.getByLabelText("全景球水平旋转滑杆"), { target: { value: "-30" } });

  expect(useDirectorStore.getState().project.scene.panoramaYaw).toBe(-30);
  expect(screen.getByLabelText("全景球水平旋转")).toHaveValue(-30);

  await user.clear(screen.getByLabelText("地面高度"));
  await user.type(screen.getByLabelText("地面高度"), "1.2");

  expect(useDirectorStore.getState().project.scene.groundHeight).toBe(1.2);
  expect(screen.getByLabelText("地面高度滑杆")).toHaveValue("1.2");

  fireEvent.change(screen.getByLabelText("地面高度滑杆"), { target: { value: "-1.5" } });

  expect(useDirectorStore.getState().project.scene.groundHeight).toBe(-1.5);
  expect(screen.getByLabelText("地面高度")).toHaveValue(-1.5);
});

it("hides ground height controls when ground is disabled", async () => {
  const user = userEvent.setup();
  render(<ScenePanel />);

  expect(screen.queryByLabelText("地面高度")).not.toBeInTheDocument();
  expandGroundPrecision();
  expect(screen.getByLabelText("地面高度")).toBeInTheDocument();

  await user.click(screen.getByLabelText("地面"));

  expect(screen.queryByLabelText("地面高度")).not.toBeInTheDocument();
});

it("updates scene scale from both slider and numeric input", async () => {
  const user = userEvent.setup();
  render(<ScenePanel />);

  expandSceneTransform();
  expect(screen.getByLabelText("场景缩放滑杆")).toHaveValue("1");

  await user.clear(screen.getByLabelText("场景缩放"));
  await user.type(screen.getByLabelText("场景缩放"), "1.35");

  expect(useDirectorStore.getState().project.scene.scale).toBe(1.35);
  expect(screen.getByLabelText("场景缩放滑杆")).toHaveValue("1.35");

  fireEvent.change(screen.getByLabelText("场景缩放滑杆"), { target: { value: "1.8" } });

  expect(useDirectorStore.getState().project.scene.scale).toBe(1.8);
  expect(screen.getByLabelText("场景缩放")).toHaveValue(1.8);
});

it("keeps the axis drag affordance visible while dragging values", () => {
  render(<ScenePanel />);
  expandSceneTransform();

  const xDragHandle = screen.getByLabelText("场景平移 X 拖动调整");
  const axisInput = xDragHandle.closest(".inspector-axis-input");

  expect(xDragHandle).not.toHaveClass("is-dragging");
  expect(axisInput).not.toHaveClass("is-dragging");

  fireEvent.mouseDown(xDragHandle, { button: 0, clientX: 100 });

  expect(xDragHandle).not.toHaveClass("is-dragging");
  expect(axisInput).toHaveClass("is-dragging");

  fireEvent.mouseMove(window, { clientX: 120 });

  expect(useDirectorStore.getState().project.scene.position[0]).toBe(0.2);

  fireEvent.mouseUp(window);

  expect(xDragHandle).not.toHaveClass("is-dragging");
  expect(axisInput).not.toHaveClass("is-dragging");
});

it("keeps the XYZ drag handle width stable while dragging", () => {
  render(<ScenePanel />);
  expandSceneTransform();

  const xDragHandle = screen.getByLabelText("场景平移 X 拖动调整");
  const widthBeforeDrag = getComputedStyle(xDragHandle).width;

  fireEvent.mouseDown(xDragHandle, { button: 0, clientX: 100 });
  const widthDuringDrag = getComputedStyle(xDragHandle).width;
  fireEvent.mouseMove(window, { clientX: 120 });
  fireEvent.mouseUp(window);

  expect(widthDuringDrag).toBe(widthBeforeDrag);
});

it("keeps the XYZ drag handle visuals stable while dragging", () => {
  render(<ScenePanel />);
  expandSceneTransform();

  const xDragHandle = screen.getByLabelText("场景平移 X 拖动调整");
  const backgroundBeforeDrag = getComputedStyle(xDragHandle).backgroundColor;
  const colorBeforeDrag = getComputedStyle(xDragHandle).color;

  fireEvent.mouseDown(xDragHandle, { button: 0, clientX: 100 });

  const backgroundDuringDrag = getComputedStyle(xDragHandle).backgroundColor;
  const colorDuringDrag = getComputedStyle(xDragHandle).color;

  fireEvent.mouseUp(window);

  expect(backgroundDuringDrag).toBe(backgroundBeforeDrag);
  expect(colorDuringDrag).toBe(colorBeforeDrag);
});

it("keeps the XYZ drag handle focused instead of moving focus into the number input", () => {
  render(<ScenePanel />);
  expandSceneTransform();

  const xDragHandle = screen.getByLabelText("场景平移 X 拖动调整");
  const xInput = screen.getByLabelText("场景平移 X");

  fireEvent.mouseDown(xDragHandle, { button: 0, clientX: 100 });

  expect(document.activeElement).toBe(xDragHandle);
  expect(document.activeElement).not.toBe(xInput);

  fireEvent.mouseUp(window);
});

it("renders the XYZ drag handle inside a responsive themed axis input shell", () => {
  render(<ScenePanel />);
  expandSceneTransform();

  const xDragHandle = screen.getByLabelText("场景平移 X 拖动调整");
  const axisInput = xDragHandle.closest(".inspector-axis-input");
  const valueInput = screen.getByLabelText("场景平移 X");
  const css = readFileSync("frontend/director/src/comprehensive/styles/index.css", "utf8");
  const axisRule = css.match(/\.inspector-axis-input\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body ?? "";

  expect(axisInput).toBeInTheDocument();
  expect(axisInput).toHaveClass("inspector-axis-input");
  expect(valueInput.closest(".inspector-axis-input")).toBe(axisInput);
  expect(axisRule).toContain("width: 100%;");
  expect(axisRule).toContain("background: rgb(var(--field-rgb));");
  expect(css).toMatch(/:root\[data-theme="dark"\],[\s\S]*?--field-rgb:\s*25 26 30;/);
});

it("adds and edits project-native clipping planes", async () => {
  const user = userEvent.setup();
  render(<ScenePanel />);

  await user.click(screen.getByRole("button", { name: "剖切平面" }));
  await user.click(screen.getByRole("button", { name: "添加剖切平面" }));
  const plane = useDirectorStore.getState().project.scene.clippingPlanes?.[0];
  expect(plane).toMatchObject({ enabled: true, normal: [1, 0, 0], constant: 0 });

  const constant = screen.getByLabelText("剖切平面 1平面常量");
  await user.clear(constant);
  await user.type(constant, "-2.5");
  expect(useDirectorStore.getState().project.scene.clippingPlanes?.[0]?.constant).toBe(-2.5);
  await user.click(screen.getByLabelText("启用 剖切平面 1"));
  expect(useDirectorStore.getState().project.scene.clippingPlanes?.[0]?.enabled).toBe(false);
});
