import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { beforeEach, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { setDirectorPageViewportHandler } from "../../../../src/comprehensive/editor/assistant/pageStateBridge";
import { ObjectTreePanel } from "../../../../src/comprehensive/editor/panels/ObjectTreePanel";

const mockReadLocalModelFile = vi.fn();

vi.mock("../../../../src/comprehensive/editor/loaders/localModelImport", () => ({
  readLocalModelFile: (...args: unknown[]) => mockReadLocalModelFile(...args),
  estimateLocalModelSizeM: async () => null,
}));

vi.mock("../../../../src/comprehensive/editor/canvas/AssetBindingPreview", () => ({
  AssetPreviewCanvas: ({ asset }: { asset: { fileName: string } }) => (
    <div data-testid="asset-binding-preview-canvas">{asset.fileName}</div>
  ),
  AssetBindingPreviewDialog: ({ bindingLabel, onClose }: { bindingLabel: string; onClose: () => void }) => (
    <div aria-label={`${bindingLabel} 大图预览`} role="dialog">
      <button onClick={onClose} type="button">
        关闭
      </button>
    </div>
  ),
}));

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  mockReadLocalModelFile.mockReset();
});

it("filters the object tree by keyword", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.type(screen.getByLabelText("搜索场景内容"), "机位");

  expect(screen.getByRole("button", { name: "机位01" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "角色01" })).not.toBeInTheDocument();
});

it("keeps the sidebar focused on scene objects instead of the production sync panel", () => {
  render(<ObjectTreePanel />);

  expect(screen.getByRole("tree", { name: "场景对象列表" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "制作项目" })).not.toBeInTheDocument();
});

it("keeps scene and world settings directly reachable while an object is selected", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "角色01" }));
  expect(useDirectorStore.getState().selectedObjectId).toBe("char_default_a");

  await user.click(screen.getByRole("button", { name: "场景与世界设置" }));

  expect(useDirectorStore.getState().directorInspectorMode).toBe("scene");
  expect(useDirectorStore.getState().selectedObjectId).toBeNull();
  expect(screen.getByRole("button", { name: "场景与世界设置" })).toHaveAttribute("aria-pressed", "true");
});

it("does not rebuild the outliner when only an object's transform changes", () => {
  let renderCount = 0;
  render(
    <Profiler id="object-tree" onRender={() => renderCount++}>
      <ObjectTreePanel />
    </Profiler>,
  );
  const renderCountBeforeTransform = renderCount;
  const object = useDirectorStore.getState().project.objects[0]!;

  act(() => {
    useDirectorStore.getState().updateObjectTransform(object.id, {
      ...object.transform,
      position: [object.transform.position[0] + 1, object.transform.position[1], object.transform.position[2]],
    });
  });

  expect(renderCount).toBe(renderCountBeforeTransform);
});

it("shows a centered empty search state when no objects match", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.type(screen.getByLabelText("搜索场景内容"), "不存在");

  const emptyState = screen.getByRole("status", { name: "未搜索到内容" });
  expect(emptyState).toHaveClass("object-search-empty-state");
  const emptyIcon = within(emptyState).getByTestId("object-search-empty-icon");
  expect(emptyIcon.querySelector(".lucide-search")).toBeInTheDocument();
  expect(emptyIcon.querySelector(".lucide-search-x")).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "角色分组" })).not.toBeInTheDocument();
  expect(screen.queryByRole("treeitem")).not.toBeInTheDocument();
});

it("shows visibility and lock controls in each object's compact action menu", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "打开 角色01 对象操作" }));
  const menu = screen.getByRole("menu", { name: "角色01 对象操作" });
  expect(menu.parentElement).toBe(document.body);
  expect(menu).toHaveClass("object-row-action-menu", "is-floating");
  expect(screen.getByLabelText("角色01 可见性")).toBeInTheDocument();
  expect(screen.getByLabelText("角色01 锁定")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "在视图中定位 角色01" })).toBeInTheDocument();
});

it("frames an out-of-view object from its compact action menu", async () => {
  const user = userEvent.setup();
  const viewport = vi.fn();
  const clearViewport = setDirectorPageViewportHandler(viewport);
  const character = useDirectorStore.getState().project.objects.find((object) => object.kind === "character")!;
  useDirectorStore.getState().updateObjectTransform(character.id, {
    ...character.transform,
    position: [-56, 0.9, 15],
  });
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "打开 角色01 对象操作" }));
  await user.click(screen.getByRole("menuitem", { name: "在视图中定位 角色01" }));

  expect(viewport).toHaveBeenCalledWith(
    expect.objectContaining({
      fov: expect.any(Number),
      position: [expect.any(Number), expect.any(Number), expect.any(Number)],
      target: [-56, expect.any(Number), 15],
    }),
  );
  clearViewport();
});

it("hides empty left panel groups and keeps the approved group order", () => {
  render(<ObjectTreePanel />);

  const groups = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));

  expect(groups).toEqual(["角色分组", "摄像机分组"]);
  expect(screen.queryByRole("group", { name: "群众分组" })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "几何体分组" })).not.toBeInTheDocument();
});

it("shows crowd arrays in a dedicated crowd group using grouped labels like crowd 3x3 and 4x3", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
  });

  useDirectorStore.getState().addCrowdCharacters({ rows: 3, columns: 3, spacing: 1.2 });
  useDirectorStore.getState().addCrowdCharacters({ rows: 4, columns: 3, spacing: 1.2 });

  render(<ObjectTreePanel />);

  expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual([
    "角色分组",
    "群众分组",
    "摄像机分组",
  ]);

  const crowdGroup = screen.getByRole("group", { name: "群众分组" });
  expect(within(crowdGroup).getByRole("treeitem", { name: "群众（3x3）" })).toBeInTheDocument();
  expect(within(crowdGroup).getByRole("treeitem", { name: "群众（4x3）" })).toBeInTheDocument();
  expect(within(crowdGroup).getAllByTestId("object-row-icon-crowd")).toHaveLength(2);
  expect(within(crowdGroup).queryByRole("button", { name: "角色02" })).not.toBeInTheDocument();
});

it("selects all members of a crowd array from the grouped crowd row", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  useDirectorStore.getState().addCrowdCharacters({ rows: 3, columns: 3, spacing: 1.2 });

  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("treeitem", { name: "群众（3x3）" }));

  expect(screen.getByRole("treeitem", { name: "群众（3x3）" })).toHaveAttribute("aria-selected", "true");
  expect(useDirectorStore.getState().selectedObjectIds).toHaveLength(9);
});

it("shift-clicks a crowd as one selection set without disturbing independently selected objects", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });
  const crowdMemberIds = useDirectorStore
    .getState()
    .project.objects.filter((item) => item.crowdId)
    .map((item) => item.id);

  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "角色01" }));
  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("treeitem", { name: "群众（2x2）" }));
  await user.keyboard("{/Shift}");

  expect(new Set(useDirectorStore.getState().selectedObjectIds)).toEqual(
    new Set(["char_default_a", ...crowdMemberIds]),
  );

  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("treeitem", { name: "群众（2x2）" }));
  await user.keyboard("{/Shift}");

  expect(useDirectorStore.getState().selectedObjectIds).toEqual(["char_default_a"]);
});

it("expands and collapses crowd groups to preview the members while keeping group-only selection", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });

  render(<ObjectTreePanel />);

  expect(screen.queryByRole("button", { name: "角色02" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "展开 群众（2x2）" }));

  expect(screen.getByRole("button", { name: "角色02" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "角色03" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "角色04" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "角色05" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "角色02" }));

  expect(screen.getByRole("treeitem", { name: "群众（2x2）" })).toHaveAttribute("aria-selected", "true");
  expect(useDirectorStore.getState().selectedObjectIds).toHaveLength(4);
  expect(useDirectorStore.getState().selectedObjectIds).toContain("char_preset_2");
  expect(useDirectorStore.getState().selectedObjectIds).toContain("char_preset_5");

  await user.click(screen.getByRole("button", { name: "收起 群众（2x2）" }));

  expect(screen.queryByRole("button", { name: "角色02" })).not.toBeInTheDocument();
});

it("deletes every member of a selected crowd array with the keyboard delete key", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  useDirectorStore.getState().addCrowdCharacters({ rows: 3, columns: 3, spacing: 1.2 });

  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("treeitem", { name: "群众（3x3）" }));
  await user.keyboard("{Delete}");

  expect(screen.queryByRole("group", { name: "群众分组" })).not.toBeInTheDocument();
  expect(useDirectorStore.getState().project.objects.filter((item) => item.crowdId)).toHaveLength(0);
});

it("shows geometry groups when prop objects exist and gives each row the matching icon", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: [
        ...base.project.objects,
        {
          id: "prop_cube_1",
          name: "立方体",
          kind: "prop",
          visible: true,
          locked: false,
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    },
  });

  render(<ObjectTreePanel />);

  expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual([
    "角色分组",
    "几何体分组",
    "摄像机分组",
  ]);
  expect(
    within(screen.getByRole("button", { name: "角色01" })).getByTestId("object-row-icon-character"),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("button", { name: "立方体" })).getByTestId("object-row-icon-geometry"),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("button", { name: "机位01" })).getByTestId("object-row-icon-camera"),
  ).toBeInTheDocument();
});

it("keeps large geometry groups to a bounded number of mounted rows", () => {
  const base = createInitialDirectorState();
  const largeGeometrySet = Array.from({ length: 600 }, (_, index) => ({
    id: `large_scene_prop_${index}`,
    name: `Large scene prop ${index}`,
    kind: "prop" as const,
    visible: true,
    locked: false,
    geometryType: "box" as const,
    transform: {
      position: [index % 30, 0, Math.floor(index / 30)] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  }));
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: [...base.project.objects, ...largeGeometrySet],
    },
  });

  const { container } = render(<ObjectTreePanel />);

  expect(screen.getByRole("group", { name: "几何体分组" })).toBeInTheDocument();
  expect(container.querySelectorAll(".object-row").length).toBeGreaterThan(0);
  expect(container.querySelectorAll(".object-row").length).toBeLessThan(120);
});

it("shows imported local and library models in a separate my models group below geometry", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      assets: [
        {
          id: "asset_local_1",
          kind: "prop",
          sourceType: "model",
          fileName: "local-chair.fbx",
          url: "blob:local-chair",
        },
      ],
      objects: [
        ...base.project.objects,
        {
          id: "geo_box_1",
          name: "立方体",
          kind: "prop",
          visible: true,
          locked: false,
          geometryType: "box",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
        {
          id: "obj_local_1",
          name: "本地椅子",
          kind: "prop",
          visible: true,
          locked: false,
          assetRefId: "asset_local_1",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    },
  });

  render(<ObjectTreePanel />);

  expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual([
    "角色分组",
    "几何体分组",
    "我的模型分组",
    "摄像机分组",
  ]);
  expect(
    within(screen.getByRole("group", { name: "几何体分组" })).getByRole("button", { name: "立方体" }),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("group", { name: "我的模型分组" })).getByRole("button", { name: "本地椅子" }),
  ).toBeInTheDocument();
});

it("keeps any object backed by a model asset visible in my models even when older data uses a non-prop kind", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
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
        ...base.project.objects,
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
  });

  render(<ObjectTreePanel />);

  expect(screen.queryByRole("group", { name: "几何体分组" })).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("group", { name: "我的模型分组" })).getByRole("button", { name: "微波炉" }),
  ).toBeInTheDocument();
});

it("selects rows and keeps selected state available for styling", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "角色01" }));

  expect(screen.getByRole("treeitem", { name: "角色01" })).toHaveAttribute("aria-selected", "true");
  expect(useDirectorStore.getState().selectedObjectId).toBe("char_default_a");
});

it("selects a row from anywhere inside the list row without needing repeated clicks", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("treeitem", { name: "角色01" }));

  expect(screen.getByRole("treeitem", { name: "角色01" })).toHaveAttribute("aria-selected", "true");
  expect(useDirectorStore.getState().selectedObjectId).toBe("char_default_a");
});

it("keeps flag buttons from also selecting the row", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "打开 角色01 对象操作" }));
  await user.click(screen.getByLabelText("角色01 可见性"));

  expect(screen.getByRole("treeitem", { name: "角色01" })).toHaveAttribute("aria-selected", "false");
  expect(useDirectorStore.getState().selectedObjectId).toBeNull();
});

it("supports shift-click multi-select in the left object list", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addPresetCharacter("female");
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "角色01" }));
  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("button", { name: "角色02" }));
  await user.keyboard("{/Shift}");

  expect(screen.getByRole("treeitem", { name: "角色01" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("treeitem", { name: "角色02" })).toHaveAttribute("aria-selected", "true");
  expect(useDirectorStore.getState().selectedObjectIds).toEqual(["char_default_a", "char_preset_2"]);
});

it("deletes all selected rows when users press the keyboard delete key", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addPresetCharacter("female");
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "角色01" }));
  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("button", { name: "角色02" }));
  await user.keyboard("{/Shift}");
  await user.keyboard("{Delete}");

  expect(screen.queryByRole("button", { name: "角色01" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "角色02" })).not.toBeInTheDocument();
  expect(useDirectorStore.getState().selectedObjectId).toBeNull();
  expect(useDirectorStore.getState().selectedObjectIds).toEqual([]);
});

it("collapses and reopens each object-category index without removing its objects", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "收起 角色分组" }));
  expect(screen.queryByRole("button", { name: "角色01" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "展开 角色分组" }));
  expect(screen.getByRole("button", { name: "角色01" })).toBeInTheDocument();
  expect(useDirectorStore.getState().project.objects.some((item) => item.id === "char_default_a")).toBe(true);
});

it("renders per-row delete controls for characters, geometry, and cameras", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().addGeometryPrimitive("box");
  useDirectorStore.getState().addCameraShot();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "打开 角色02 对象操作" }));
  expect(screen.getByRole("menuitem", { name: "删除 角色02" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "打开 立方体 对象操作" }));
  expect(screen.getByRole("menuitem", { name: "删除 立方体" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "打开 机位02 对象操作" }));
  expect(screen.getByRole("menuitem", { name: "删除 机位02" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "打开 角色02 对象操作" }));
  await user.click(screen.getByRole("menuitem", { name: "删除 角色02" }));
  await user.click(screen.getByRole("button", { name: "打开 立方体 对象操作" }));
  await user.click(screen.getByRole("menuitem", { name: "删除 立方体" }));
  await user.click(screen.getByRole("button", { name: "打开 机位02 对象操作" }));
  await user.click(screen.getByRole("menuitem", { name: "删除 机位02" }));

  expect(screen.queryByRole("button", { name: "角色02" })).not.toBeInTheDocument();
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(false);
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "立方体")).toBe(false);
  expect(useDirectorStore.getState().project.cameras.some((item) => item.name === "机位02")).toBe(false);
});

it("deletes an entire crowd from its explicit group delete control", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "删除 群众（2x2）" }));

  expect(screen.queryByRole("group", { name: "群众分组" })).not.toBeInTheDocument();
  expect(useDirectorStore.getState().project.objects.filter((item) => item.crowdId)).toHaveLength(0);
});

it("switches the active camera when users select a camera row", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCameraShot();
  render(<ObjectTreePanel />);

  expect(useDirectorStore.getState().project.activeCameraId).toBe("cam_2");

  await user.click(screen.getByRole("button", { name: "机位01" }));

  expect(useDirectorStore.getState().project.activeCameraId).toBe("cam_1");
  expect(useDirectorStore.getState().selectedObjectId).toBe("cam_object_1");
});

it("renames every concrete object inline and keeps a linked camera name synchronized", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "重命名 机位01" }));
  const field = screen.getByLabelText("编辑 机位01 名称");
  await user.clear(field);
  await user.type(field, "走廊特写机位");
  await user.keyboard("{Enter}");

  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "cam_object_1")?.name).toBe(
    "走廊特写机位",
  );
  expect(useDirectorStore.getState().project.cameras.find((item) => item.id === "cam_1")?.name).toBe("走廊特写机位");
});

it("expands an object reference list and persists portable prompt bindings", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "展开 角色01 参考绑定" }));
  expect(screen.getByRole("region", { name: "角色01 参考绑定" })).toBeInTheDocument();
  expect(screen.getByRole("treeitem", { name: "角色01" })).toHaveAttribute("aria-selected", "true");
  expect(useDirectorStore.getState().selectedObjectId).toBe("char_default_a");
  expect(screen.getByLabelText("完整对象 ID：char_default_a")).toHaveAttribute("title", "对象 ID：char_default_a");
  expect(screen.getAllByText("自动")[0]).toHaveClass("object-reference-status");
  await user.type(screen.getByLabelText("角色01 参考名称"), "表演提示");
  await user.type(screen.getByLabelText("角色01 参考内容"), "缓慢回头，看向窗外");
  await user.click(screen.getByRole("button", { name: "添加 角色01 参考" }));

  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.referenceBindings,
  ).toMatchObject([{ kind: "prompt", label: "表演提示", ref: "缓慢回头，看向窗外" }]);

  await user.click(screen.getByRole("button", { name: "重命名 角色01 的表演提示参考" }));
  const renameField = screen.getByLabelText("编辑 角色01 的表演提示参考名称");
  await user.clear(renameField);
  await user.type(renameField, "窗边表演提示");
  await user.keyboard("{Enter}");
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.referenceBindings?.[0]
      ?.label,
  ).toBe("窗边表演提示");

  await user.click(screen.getByRole("button", { name: "移除 角色01 的窗边表演提示参考" }));
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.referenceBindings,
  ).toEqual([]);
});

it("configures an object-anchored prompt visualization with transparent defaults", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "展开 角色01 参考绑定" }));
  await user.type(screen.getByLabelText("角色01 参考名称"), "镜头提示");
  await user.type(screen.getByLabelText("角色01 参考内容"), "老师转身看向黑板");
  await user.click(screen.getByRole("button", { name: "添加 角色01 参考" }));
  await user.click(screen.getByRole("button", { name: "编辑 角色01 的镜头提示提示词可视化样式" }));

  expect(screen.getByLabelText("镜头提示 字体颜色")).toHaveValue("#f3f7ff");
  expect(screen.getByLabelText("镜头提示 文字框填充颜色")).toHaveValue("#000000");
  fireEvent.change(screen.getByLabelText("镜头提示 字体大小"), { target: { value: "22" } });
  await user.click(screen.getByRole("button", { name: "在主画面显示 角色01 的镜头提示提示词可视化" }));

  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.referenceBindings?.[0],
  ).toMatchObject({
    showInViewport: true,
    promptVisual: { fontSize: 22, backgroundColor: "transparent", borderColor: "transparent" },
  });
});

it("uploads a local model from the reference editor and binds its stable asset ID directly", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-file-1",
    name: "课堂椅子",
    fileName: "classroom-chair.glb",
    url: "data:model/gltf-binary;base64,AA==",
  });
  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "展开 角色01 参考绑定" }));
  await user.upload(
    screen.getByLabelText("上传 角色01 绑定资产"),
    new File(["model"], "classroom-chair.glb", { type: "model/gltf-binary" }),
  );

  await waitFor(() => expect(mockReadLocalModelFile).toHaveBeenCalledTimes(1));
  const state = useDirectorStore.getState();
  const uploadedAsset = state.project.assets.find((item) => item.fileName === "classroom-chair.glb");
  expect(uploadedAsset).toMatchObject({ kind: "prop", assetSource: "local" });
  expect(state.project.objects.find((item) => item.id === "char_default_a")?.referenceBindings).toMatchObject([
    { kind: "asset3d", label: "课堂椅子", ref: uploadedAsset?.id, showInViewport: true },
  ]);
  expect(screen.getByRole("status")).toHaveTextContent("已上传 classroom-chair.glb，并已绑定到 角色01。");

  await user.hover(screen.getByText("课堂椅子"));
  expect(screen.getByLabelText("课堂椅子 悬停预览")).toBeInTheDocument();
  expect(screen.getByTestId("asset-binding-preview-canvas")).toHaveTextContent("classroom-chair.glb");

  await user.click(screen.getByRole("button", { name: "从主画面隐藏 角色01 的课堂椅子绑定资产" }));
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.referenceBindings?.[0]
      ?.showInViewport,
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "在主画面显示 角色01 的课堂椅子绑定资产" }));
  await user.click(screen.getByRole("button", { name: "查看 角色01 的课堂椅子绑定资产" }));
  expect(screen.getByRole("dialog", { name: "课堂椅子 大图预览" })).toBeInTheDocument();
});

it("automatically groups independent objects with the same name and numbers their expandable members", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  const first = { ...base.project.objects[0]!, name: "替身" };
  const second = {
    ...first,
    id: "char_double_2",
    transform: { ...first.transform, position: [1, 0, 0] as [number, number, number] },
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: { ...base.project, objects: [first, second, ...base.project.objects.slice(1)] },
  });

  render(<ObjectTreePanel />);

  expect(screen.getByRole("treeitem", { name: "替身" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "替身（1）" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "展开 替身" }));
  expect(screen.getByRole("button", { name: "替身（1）" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "替身（2）" })).toBeInTheDocument();
});

it("renames an automatic list into a persistent list without renaming its members", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  const first = { ...base.project.objects[0]!, name: "替身" };
  const second = {
    ...first,
    id: "char_double_2",
    transform: { ...first.transform, position: [1, 0, 0] as [number, number, number] },
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: { ...base.project, objects: [first, second, ...base.project.objects.slice(1)] },
  });

  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "重命名 替身" }));
  const field = screen.getByLabelText("编辑 替身 名称");
  await user.clear(field);
  await user.type(field, "主演替身组");
  await user.keyboard("{Enter}");

  const members = useDirectorStore
    .getState()
    .project.objects.filter((object) => ["char_default_a", "char_double_2"].includes(object.id));
  expect(members.map((object) => object.name)).toEqual(["替身", "替身"]);
  expect(new Set(members.map((object) => object.objectListId)).size).toBe(1);
  expect(members.every((object) => object.objectListLabel === "主演替身组")).toBe(true);
  expect(screen.getByRole("treeitem", { name: "主演替身组" })).toBeInTheDocument();
});

it("lets a list member be renamed and moved back out as an independent object", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  const first = { ...base.project.objects[0]!, name: "替身", objectListId: "object_list_1", objectListLabel: "替身组" };
  const second = {
    ...first,
    id: "char_double_2",
    transform: { ...first.transform, position: [1, 0, 0] as [number, number, number] },
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: { ...base.project, objects: [first, second, ...base.project.objects.slice(1)] },
  });

  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "展开 替身组" }));
  await user.click(screen.getByRole("button", { name: "重命名 替身（1）" }));
  const field = screen.getByLabelText("编辑 替身（1） 名称");
  await user.clear(field);
  await user.type(field, "主角替身");
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "打开 主角替身（1） 对象操作" }));
  await user.click(screen.getByRole("menuitem", { name: "移出 替身组 列表" }));

  const extracted = useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a");
  expect(extracted).toMatchObject({ name: "主角替身", objectListDetached: true });
  expect(extracted?.objectListId).toBeUndefined();
  expect(screen.getByRole("button", { name: "主角替身" })).toBeInTheDocument();
});

it("adds selected independent objects to a named list", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  const first = { ...base.project.objects[0]!, name: "替身", objectListId: "object_list_1", objectListLabel: "替身组" };
  const second = {
    ...first,
    id: "char_double_2",
    transform: { ...first.transform, position: [1, 0, 0] as [number, number, number] },
  };
  const prop = {
    id: "prop_chair_1",
    name: "椅子",
    kind: "prop" as const,
    visible: true,
    locked: false,
    transform: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: { ...base.project, objects: [first, second, prop, ...base.project.objects.slice(1)] },
  });

  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("button", { name: "椅子" }));
  await user.click(screen.getByRole("button", { name: "打开 替身组 列表操作" }));
  await user.click(screen.getByRole("menuitem", { name: "将选中对象加入列表" }));

  expect(useDirectorStore.getState().project.objects.find((object) => object.id === "prop_chair_1")).toMatchObject({
    objectListId: "object_list_1",
    objectListLabel: "替身组",
  });
  expect(screen.getByRole("group", { name: "对象列表分组" })).toBeInTheDocument();
});

it("shows editable composite parents separately from ordinary object lists", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  const parent = {
    id: "composite_parent_chair",
    name: "课堂椅子",
    kind: "prop" as const,
    visible: true,
    locked: false,
    isCompositeParent: true,
    transform: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
  const seat = {
    id: "chair_seat",
    name: "椅面",
    kind: "prop" as const,
    visible: true,
    locked: false,
    geometryType: "box" as const,
    parentObjectId: parent.id,
    transform: {
      position: [0, 0.5, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: { ...base.project, objects: [parent, seat, ...base.project.objects] },
  });

  render(<ObjectTreePanel />);

  const group = screen.getByRole("group", { name: "组合对象分组" });
  expect(within(group).getByRole("treeitem", { name: "课堂椅子" })).toBeInTheDocument();
  await user.click(within(group).getByRole("button", { name: "展开 课堂椅子" }));
  await user.click(screen.getByRole("button", { name: "椅面" }));
  expect(useDirectorStore.getState().selectedObjectId).toBe("chair_seat");

  await user.click(screen.getByRole("button", { name: "打开 椅面 对象操作" }));
  await user.click(screen.getByRole("menuitem", { name: "移出 课堂椅子 组合" }));
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "chair_seat")?.parentObjectId,
  ).toBeUndefined();
});

function makeGeometryProp(id: string, name: string, parentObjectId?: string) {
  return {
    id,
    name,
    kind: "prop" as const,
    visible: true,
    locked: false,
    geometryType: "box" as const,
    ...(parentObjectId ? { parentObjectId } : {}),
    transform: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
}

it("nests geometry named with a middle-dot under a shared prefix folder", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: [
        ...base.project.objects,
        makeGeometryProp("corner_base", "塔楼A·台座"),
        makeGeometryProp("corner_body", "塔楼A·屋身"),
        makeGeometryProp("corner_beast", "塔楼A·装饰件"),
        makeGeometryProp("plaza", "广场地面"),
      ],
    },
  });

  render(<ObjectTreePanel />);

  const geometry = screen.getByRole("group", { name: "几何体分组" });
  expect(within(geometry).getByRole("treeitem", { name: "塔楼A" })).toBeInTheDocument();
  expect(within(geometry).getByRole("treeitem", { name: "广场地面" })).toBeInTheDocument();
  expect(within(geometry).queryByRole("button", { name: "台座" })).not.toBeInTheDocument();
  expect(within(geometry).getByTestId("object-row-icon-folder")).toBeInTheDocument();

  await user.click(within(geometry).getByRole("button", { name: "展开 塔楼A" }));

  expect(within(geometry).getByRole("button", { name: "台座" })).toBeInTheDocument();
  expect(within(geometry).getByRole("button", { name: "屋身" })).toBeInTheDocument();
  expect(within(geometry).getByRole("button", { name: "装饰件" })).toBeInTheDocument();
  expect(within(geometry).getByRole("treeitem", { name: "塔楼A·装饰件" })).toHaveAttribute("aria-level", "2");
});

it("selects every descendant when clicking a prefix folder, but only the parent object when it exists", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: [
        ...base.project.objects,
        makeGeometryProp("corner_base", "塔楼A·台座"),
        makeGeometryProp("corner_body", "塔楼A·屋身"),
        makeGeometryProp("wall", "东围墙"),
        makeGeometryProp("trim", "东围墙·顶沿"),
      ],
    },
  });

  render(<ObjectTreePanel />);

  await user.click(screen.getByRole("treeitem", { name: "塔楼A" }));
  expect(new Set(useDirectorStore.getState().selectedObjectIds)).toEqual(new Set(["corner_base", "corner_body"]));

  await user.click(screen.getByRole("treeitem", { name: "东围墙" }));
  expect(useDirectorStore.getState().selectedObjectId).toBe("wall");
  expect(useDirectorStore.getState().selectedObjectIds).toEqual(["wall"]);

  await user.click(screen.getByRole("button", { name: "展开 东围墙" }));
  await user.click(screen.getByRole("button", { name: "顶沿" }));
  expect(useDirectorStore.getState().selectedObjectId).toBe("trim");
});

it("reveals a name-nested object in the outliner when it is selected from the viewport", async () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: [
        ...base.project.objects,
        makeGeometryProp("hall_plinth", "大厅·台座"),
        makeGeometryProp("hall_body", "大厅·屋身"),
        makeGeometryProp("hall_column", "侧厅·立柱1"),
      ],
    },
  });

  render(<ObjectTreePanel />);

  const geometry = screen.getByRole("group", { name: "几何体分组" });
  expect(within(geometry).queryByRole("button", { name: "屋身" })).not.toBeInTheDocument();

  act(() => useDirectorStore.getState().selectObject("hall_body"));

  expect(await screen.findByRole("button", { name: "屋身" })).toBeInTheDocument();
  expect(screen.getByRole("treeitem", { name: "大厅·屋身" })).toHaveAttribute("aria-selected", "true");
});

it("does not keep forcing a folder open after the user collapses it", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: [
        ...base.project.objects,
        makeGeometryProp("hall_plinth", "大厅·台座"),
        makeGeometryProp("hall_body", "大厅·屋身"),
      ],
    },
  });

  render(<ObjectTreePanel />);
  act(() => useDirectorStore.getState().selectObject("hall_body"));
  expect(await screen.findByRole("button", { name: "屋身" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "收起 大厅" }));
  expect(screen.queryByRole("button", { name: "屋身" })).not.toBeInTheDocument();

  act(() => useDirectorStore.getState().selectObject("hall_body"));
  expect(screen.queryByRole("button", { name: "屋身" })).not.toBeInTheDocument();
});

it("reveals matching nested descendants when searching", async () => {
  const user = userEvent.setup();
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: [
        ...base.project.objects,
        makeGeometryProp("corner_base", "塔楼A·台座"),
        makeGeometryProp("corner_beast", "塔楼A·装饰件"),
        makeGeometryProp("hall_column", "侧厅·立柱1"),
      ],
    },
  });

  render(<ObjectTreePanel />);

  await user.type(screen.getByLabelText("搜索场景内容"), "装饰");

  expect(screen.getByRole("button", { name: "装饰件" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "台座" })).not.toBeInTheDocument();
  expect(screen.queryByRole("treeitem", { name: "侧厅" })).not.toBeInTheDocument();
});
