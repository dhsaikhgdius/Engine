import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { PropPanel } from "../../../../src/comprehensive/editor/panels/PropPanel";

beforeEach(() => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    selectedObjectId: "prop_model_1",
    project: {
      ...base.project,
      assets: [
        {
          id: "asset_model_1",
          kind: "prop",
          sourceType: "model",
          fileName: "ATM_low.fbx",
          url: "blob:atm",
        },
        {
          id: "texture_paint",
          kind: "prop",
          sourceType: "image",
          assetSource: "local",
          fileName: "paint.png",
          name: "Paint",
          url: "data:image/png;base64,paint",
        },
      ],
      objects: [
        ...base.project.objects,
        {
          id: "prop_model_1",
          name: "自动取款机",
          kind: "prop",
          visible: true,
          locked: false,
          color: "#d7e7ff",
          assetRefId: "asset_model_1",
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
        },
      ],
    },
  });
});

it("renders the prop inspector fields for imported models", () => {
  const { container } = render(<PropPanel />);

  expect(screen.getByText("模型")).toBeInTheDocument();
  expect(screen.getByLabelText("模型右侧属性面板")).toHaveClass("right-inspector", "prop-inspector");
  expect(container.querySelector(".right-inspector-tabs")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "变换" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "材质" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "贴图" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("heading", { name: "基本信息" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "外观" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("模型名称")).toBeInTheDocument();
  expect(screen.getByLabelText("模型位置 X")).toBeInTheDocument();
  expect(screen.getByLabelText("模型旋转 X")).toBeInTheDocument();
  expect(screen.getByLabelText("模型缩放 X")).toBeInTheDocument();
  expect(screen.getByLabelText("模型位置 X 拖动调整")).toHaveAttribute("data-axis", "X");
  expect(screen.getByLabelText("模型位置 Y 拖动调整")).toHaveAttribute("data-axis", "Y");
  expect(screen.getByLabelText("模型位置 Z 拖动调整")).toHaveAttribute("data-axis", "Z");
  expect(screen.getByLabelText("模型统一缩放")).toBeInTheDocument();
  expect(screen.queryByLabelText("模型颜色 HEX")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "贴地放置" })).toBeInTheDocument();
  expect(screen.queryByLabelText("基础色贴图资产")).not.toBeInTheDocument();
});

it("attaches and tunes a drivable vehicle profile from the prop inspector", async () => {
  const user = userEvent.setup();
  render(<PropPanel />);

  expect(screen.getByRole("button", { name: "载具" })).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "载具" }));
  await user.click(screen.getByLabelText("可驾驶载具"));

  let vehicle = useDirectorStore.getState().project.objects.find((object) => object.id === "prop_model_1")?.vehicle;
  expect(vehicle).toMatchObject({
    kind: "car",
    drivable: true,
    massKg: 1_400,
    maxSpeedKph: 140,
    camera: { chaseDistanceM: 6.5, chaseHeightM: 2.6 },
  });
  expect(screen.getByLabelText("载具最高速度")).toBeInTheDocument();
  expect(screen.getByLabelText("载具质量（千克）")).toBeInTheDocument();

  await user.clear(screen.getByLabelText("载具最高速度"));
  await user.type(screen.getByLabelText("载具最高速度"), "180");
  vehicle = useDirectorStore.getState().project.objects.find((object) => object.id === "prop_model_1")?.vehicle;
  expect(vehicle?.maxSpeedKph).toBe(180);

  await user.click(screen.getByLabelText("可驾驶载具"));
  expect(
    useDirectorStore.getState().project.objects.find((object) => object.id === "prop_model_1")?.vehicle,
  ).toBeUndefined();
});

it("does not expose duplicate Director material state for native models", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...state.project,
      objects: state.project.objects.map((object) =>
        object.id === "prop_model_1"
          ? {
              ...object,
              nativeSource: { engine: "blender" as const, objectId: object.id, provisioned: true },
            }
          : object,
      ),
    },
  });

  const { container } = render(<PropPanel />);

  expect(container.querySelector(".right-inspector-tabs")).not.toBeInTheDocument();
  expect(screen.getByLabelText("模型统一缩放")).toBeInTheDocument();
  expect(screen.queryByLabelText("模型颜色 HEX")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "材质" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "贴图" })).not.toBeInTheDocument();
});

it("edits physical material controls and binds imported image textures", async () => {
  const user = userEvent.setup();
  render(<PropPanel />);

  await user.click(screen.getByRole("button", { name: "材质" }));
  expect(screen.getByLabelText("模型颜色 HEX")).toBeInTheDocument();
  await user.clear(screen.getByLabelText("模型金属度"));
  await user.type(screen.getByLabelText("模型金属度"), "0.85");
  await user.clear(screen.getByLabelText("模型透射"));
  await user.type(screen.getByLabelText("模型透射"), "0.4");

  await user.click(screen.getByRole("button", { name: "贴图" }));
  await user.click(screen.getByRole("button", { name: "基础色贴图资产" }));
  await user.click(screen.getByRole("option", { name: "Paint" }));

  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "prop_model_1")?.material,
  ).toMatchObject({
    metalness: 0.85,
    transmission: 0.4,
    textures: { baseColorMapAssetId: "texture_paint" },
  });
});

it("updates the selected prop name, uniform scale, and color", async () => {
  const user = userEvent.setup();
  render(<PropPanel />);

  await user.clear(screen.getByLabelText("模型名称"));
  await user.type(screen.getByLabelText("模型名称"), "近景 ATM");
  await user.clear(screen.getByLabelText("模型统一缩放"));
  await user.type(screen.getByLabelText("模型统一缩放"), "1.4");
  await user.click(screen.getByRole("button", { name: "材质" }));
  await user.clear(screen.getByLabelText("模型颜色 HEX"));
  await user.type(screen.getByLabelText("模型颜色 HEX"), "#aaccee");

  const prop = useDirectorStore.getState().project.objects.find((item) => item.id === "prop_model_1");
  expect(prop?.name).toBe("近景 ATM");
  expect(prop?.transform.scale).toEqual([1.4, 1.4, 1.4]);
  expect(prop?.color).toBe("#aaccee");
});

it("drops the selected prop to the current scene ground", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      scene: { ...state.project.scene, groundHeight: 1.25 },
      objects: state.project.objects.map((item) =>
        item.id === "prop_model_1"
          ? { ...item, transform: { ...item.transform, position: [2, 7, -3] as [number, number, number] } }
          : item,
      ),
    },
  });

  render(<PropPanel />);
  await user.click(screen.getByRole("button", { name: "贴地放置" }));

  const prop = useDirectorStore.getState().project.objects.find((item) => item.id === "prop_model_1");
  expect(prop?.transform.position).toEqual([2, 1.25, -3]);
  expect(prop?.placementMode).toBe("grounded");
});
