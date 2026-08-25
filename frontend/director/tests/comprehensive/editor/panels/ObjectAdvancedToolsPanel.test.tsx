import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { ObjectAdvancedToolsPanel } from "../../../../src/comprehensive/editor/panels/ObjectAdvancedToolsPanel";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

it("exposes undoable batch layers, materials, isolation, alignment, and transform reset", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addGeometryPrimitive("box");
  useDirectorStore.getState().addGeometryPrimitive("sphere");
  useDirectorStore.getState().addGeometryPrimitive("cylinder");
  const ids = useDirectorStore
    .getState()
    .project.objects.filter((object) => object.kind !== "camera")
    .slice(-3)
    .map((object) => object.id);
  ids.forEach((id, index) =>
    useDirectorStore.getState().updateObjectTransform(id, {
      position: [index * index * 2, 0, index],
      rotation: [0.2, 0.3, 0.4],
      scale: [2, 2, 2],
    }),
  );
  useDirectorStore.getState().selectObjects(ids);

  render(<ObjectAdvancedToolsPanel />);
  expect(screen.getByRole("button", { name: "选择与可见性" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "变换" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "图层" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "标注与测量" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "材质" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByLabelText("对象枢轴 X")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "图层" }));
  await user.clear(screen.getByRole("textbox", { name: "对象层名称" }));
  await user.type(screen.getByRole("textbox", { name: "对象层名称" }), "foreground");
  await user.click(screen.getByRole("button", { name: "应用层" }));
  await user.click(screen.getByRole("button", { name: "材质" }));
  await user.click(screen.getByRole("button", { name: "应用材质" }));
  await user.click(screen.getByRole("button", { name: /均匀分布/ }));

  expect(
    ids.map((id) => useDirectorStore.getState().project.objects.find((object) => object.id === id)?.layer),
  ).toEqual(["foreground", "foreground", "foreground"]);
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === ids[0])?.material).toMatchObject({
    baseColor: "#d7e7ff",
    roughness: 0.65,
    metalness: 0,
  });
  await user.click(screen.getByRole("button", { name: /重置变换/ }));
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === ids[0])?.transform).toEqual({
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
});

it("authors persistent pivots, annotations, measurements, and whole-layer controls", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addGeometryPrimitive("box");
  useDirectorStore.getState().addGeometryPrimitive("sphere");
  const ids = useDirectorStore
    .getState()
    .project.objects.filter((object) => object.geometryType === "box" || object.geometryType === "sphere")
    .map((object) => object.id);
  useDirectorStore.getState().selectObject(ids[0]!);

  render(<ObjectAdvancedToolsPanel />);
  await user.clear(screen.getByLabelText("对象枢轴 X"));
  await user.type(screen.getByLabelText("对象枢轴 X"), "0.25");
  await user.click(screen.getByRole("button", { name: /应用枢轴/ }));
  expect(useDirectorStore.getState().project.objects.find((object) => object.id === ids[0])?.pivot).toEqual([
    0.25, 0, 0,
  ]);

  await user.click(screen.getByRole("button", { name: "标注与测量" }));
  await user.type(screen.getByLabelText("标注文字"), "Continuity marker");
  await user.click(screen.getByRole("button", { name: /添加到对象/ }));
  expect(useDirectorStore.getState().project.scene.annotations?.[0]).toMatchObject({
    text: "Continuity marker",
    anchor: { objectId: ids[0] },
  });

  act(() => useDirectorStore.getState().selectObjects(ids));
  await user.type(screen.getByLabelText("测量名称"), "spacing");
  await user.click(screen.getByRole("button", { name: /测量两个对象/ }));
  expect(useDirectorStore.getState().project.scene.measurements?.[0]).toMatchObject({
    label: "spacing",
    start: { objectId: ids[0] },
    end: { objectId: ids[1] },
  });

  await user.click(screen.getByRole("button", { name: "图层" }));
  await user.clear(screen.getByRole("textbox", { name: "对象层名称" }));
  await user.type(screen.getByRole("textbox", { name: "对象层名称" }), "foreground");
  await user.click(screen.getByRole("button", { name: "应用层" }));
  await user.click(screen.getByRole("button", { name: "隐藏图层 foreground" }));
  expect(
    useDirectorStore.getState().project.scene.objectLayers?.find((layer) => layer.id === "foreground"),
  ).toMatchObject({
    visible: false,
  });
  await user.click(screen.getByRole("button", { name: "上移图层 foreground" }));
  expect(useDirectorStore.getState().project.scene.objectLayers?.[0]?.id).toBe("foreground");
});
