import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import {
  clearViewportCaptureHandler,
  setViewportCaptureHandler,
} from "../../../../src/comprehensive/editor/io/captureBridge";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  getCameraRigPositionFromViewSnapshot,
  getCameraViewSnapshotFromShot,
} from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import { ViewportToolbar } from "../../../../src/comprehensive/editor/canvas/ViewportToolbar";

const mockReadLocalModelFile = vi.fn();
const mockEstimateLocalModelSizeM = vi.fn();

vi.mock("../../../../src/comprehensive/editor/loaders/localModelImport", () => ({
  readLocalModelFile: (...args: unknown[]) => mockReadLocalModelFile(...args),
  estimateLocalModelSizeM: (...args: unknown[]) => mockEstimateLocalModelSizeM(...args),
}));

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    undoStack: [],
    redoStack: [],
    historyUndoStack: [],
    historyRedoStack: [],
  });
  mockReadLocalModelFile.mockReset();
  mockEstimateLocalModelSizeM.mockReset();
  mockEstimateLocalModelSizeM.mockResolvedValue(null);
});

afterEach(() => {
  clearViewportCaptureHandler();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders the viewport capsule as project icon-system buttons", () => {
  render(<ViewportToolbar />);

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });
  const expectedActions = [
    "撤销",
    "重做",
    "套索选择",
    "移动",
    "旋转",
    "缩放",
    "角色漫游",
    "导入全景图",
    "导入本地模型",
    "模型库",
    "添加机位",
    "选择画幅比例",
    "视口标签",
    "四视图",
    "当前视角截图",
    "四方位截图",
    "十二方位截图",
    "全屏",
  ];

  expectedActions.forEach((label) => {
    const button = within(toolbar).getByRole("button", { name: label });

    expect(button.querySelector("svg")).toBeInTheDocument();
    expect(button).toHaveClass("viewport-toolbar-button");
  });

  expect(toolbar).toHaveClass("viewport-toolbar");

  const toolbarButtonLabels = Array.from(toolbar.querySelectorAll("button[aria-label]")).map((button) =>
    button.getAttribute("aria-label"),
  );
  expect(toolbarButtonLabels.indexOf("模型库")).toBe(toolbarButtonLabels.indexOf("导入本地模型") + 1);
});

it("toggles a persistent live quad viewport independently from four-angle capture", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  const button = screen.getByRole("button", { name: "四视图" });
  expect(button).toHaveAttribute("aria-pressed", "false");
  await user.click(button);
  expect(useDirectorStore.getState().viewportLayout).toBe("quad");
  expect(screen.getByRole("button", { name: "退出四视图" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "四方位截图" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全屏" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "3D视口快捷工具" })).toHaveClass("is-quad-view");
  expect(screen.queryByRole("button", { name: "移动" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "角色漫游" })).not.toBeInTheDocument();
});

it("toggles the lasso selection tool", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ViewportToolbar lassoSelectionEnabled={false} onLassoSelectionEnabledChange={onChange} />);

  const button = screen.getByRole("button", { name: "套索选择" });
  expect(button).toHaveAttribute("aria-pressed", "false");
  await user.click(button);
  expect(onChange).toHaveBeenCalledWith(true);
});

it("toggles viewport labels from the toolbar", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  const button = screen.getByRole("button", { name: "视口标签" });
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(useDirectorStore.getState().project.scene.showLabels).toBe(false);

  await user.click(button);

  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(useDirectorStore.getState().project.scene.showLabels).toBe(true);
});

it("exits lasso before activating transform or navigation tools", async () => {
  const user = userEvent.setup();
  const onLassoSelectionEnabledChange = vi.fn();
  const onNavigationModeChange = vi.fn();
  render(
    <ViewportToolbar
      lassoSelectionEnabled
      navigationMode="hand"
      onLassoSelectionEnabledChange={onLassoSelectionEnabledChange}
      onNavigationModeChange={onNavigationModeChange}
    />,
  );

  expect(screen.getByRole("button", { name: "移动" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "手型浏览" })).toHaveAttribute("aria-pressed", "false");

  await user.click(screen.getByRole("button", { name: "旋转" }));
  expect(onLassoSelectionEnabledChange).toHaveBeenLastCalledWith(false);
  expect(useDirectorStore.getState().transformMode).toBe("rotate");

  await user.click(screen.getByRole("button", { name: "游标浏览" }));
  expect(onLassoSelectionEnabledChange).toHaveBeenLastCalledWith(false);
  expect(onNavigationModeChange).toHaveBeenCalledWith("cursor");
});

it("keeps Pan view and Cursor view mutually exclusive", async () => {
  const user = userEvent.setup();
  const onNavigationModeChange = vi.fn();
  const { rerender } = render(
    <ViewportToolbar navigationMode="hand" onNavigationModeChange={onNavigationModeChange} />,
  );

  const panButton = screen.getByRole("button", { name: "手型浏览" });
  const cursorButton = screen.getByRole("button", { name: "游标浏览" });
  expect(panButton).toHaveAttribute("aria-pressed", "true");
  expect(cursorButton).toHaveAttribute("aria-pressed", "false");

  await user.click(cursorButton);
  expect(onNavigationModeChange).toHaveBeenCalledWith("cursor");

  rerender(<ViewportToolbar navigationMode="cursor" onNavigationModeChange={onNavigationModeChange} />);
  expect(panButton).toHaveAttribute("aria-pressed", "false");
  expect(cursorButton).toHaveAttribute("aria-pressed", "true");
});

it("disables lasso selection while transient playback owns object transforms", () => {
  const onChange = vi.fn();
  render(<ViewportToolbar lassoSelectionDisabled onLassoSelectionEnabledChange={onChange} />);

  const button = screen.getByRole("button", { name: "套索选择" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onChange).not.toHaveBeenCalled();
});

it("routes the player-mode action without changing the compact toolbar contract", async () => {
  const user = userEvent.setup();
  const onTogglePlayerMode = vi.fn();
  const { rerender } = render(<ViewportToolbar onTogglePlayerMode={onTogglePlayerMode} />);

  await user.click(screen.getByRole("button", { name: "角色漫游" }));
  expect(onTogglePlayerMode).toHaveBeenCalledTimes(1);

  rerender(<ViewportToolbar onTogglePlayerMode={onTogglePlayerMode} playerMode />);
  expect(screen.getByRole("button", { name: "退出角色漫游" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "手型浏览" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "游标浏览" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "移动" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "旋转" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "缩放" })).toBeDisabled();
});

it("routes camera pilot entry and exit through one pressed toolbar action", async () => {
  const user = userEvent.setup();
  const onToggleCameraPilot = vi.fn();
  const { rerender } = render(<ViewportToolbar onToggleCameraPilot={onToggleCameraPilot} />);

  const startButton = screen.getByRole("button", { name: "开始掌镜" });
  expect(startButton).toHaveAttribute("aria-pressed", "false");
  await user.click(startButton);
  expect(onToggleCameraPilot).toHaveBeenCalledTimes(1);

  rerender(<ViewportToolbar cameraPilotMode onToggleCameraPilot={onToggleCameraPilot} />);
  expect(screen.getByRole("button", { name: "退出掌镜" })).toHaveAttribute("aria-pressed", "true");
});

it("explains why character roam is unavailable without a candidate actor", () => {
  render(<ViewportToolbar playerAvailable={false} />);

  const roamButton = screen.getByRole("button", { name: "角色漫游" });
  expect(roamButton).toBeDisabled();
  expect(roamButton).toHaveAttribute("title", "场景中没有可漫游的角色");
});

it("keeps character roam and camera pilot mutually exclusive", () => {
  render(<ViewportToolbar cameraPilotMode />);

  expect(screen.getByRole("button", { name: "角色漫游" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "角色漫游" })).toHaveAttribute("title", "掌镜时不可漫游");
  expect(screen.getByRole("button", { name: "退出掌镜" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "手型浏览" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "手型浏览" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "游标浏览" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "移动" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "移动" })).toHaveAttribute("aria-pressed", "false");
});

it("undoes and redoes scene edits from the viewport toolbar buttons", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    undoStack: [],
    redoStack: [],
    historyUndoStack: [],
    historyRedoStack: [],
    historyBusy: false,
  });
  render(<ViewportToolbar />);

  const undoButton = screen.getByRole("button", { name: "撤销" });
  const redoButton = screen.getByRole("button", { name: "重做" });
  expect(undoButton).toBeDisabled();
  expect(undoButton).toHaveAttribute("title", "没有可撤销的操作");
  expect(redoButton).toBeDisabled();
  expect(redoButton).toHaveAttribute("title", "没有可重做的操作");
  expect(undoButton).toHaveClass("viewport-toolbar-button");
  expect(undoButton.querySelector("svg")).toHaveClass("lucide-undo2");
  expect(redoButton.querySelector("svg")).toHaveClass("lucide-redo2");

  const initialObjectCount = useDirectorStore.getState().project.objects.length;
  act(() => useDirectorStore.getState().addGeometryPrimitive("box"));
  expect(useDirectorStore.getState().project.objects).toHaveLength(initialObjectCount + 1);
  expect(undoButton).toBeEnabled();

  await user.click(undoButton);
  expect(useDirectorStore.getState().project.objects).toHaveLength(initialObjectCount);
  expect(undoButton).toBeDisabled();
  expect(redoButton).toBeEnabled();

  await user.click(redoButton);
  expect(useDirectorStore.getState().project.objects).toHaveLength(initialObjectCount + 1);
  expect(redoButton).toBeDisabled();
});

it("renders custom hover labels instead of native title tooltips", () => {
  render(<ViewportToolbar />);

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });
  const button = within(toolbar).getByRole("button", { name: "导入本地模型" });
  const label = within(button).getByText("导入本地模型");

  expect(button).not.toHaveAttribute("title");
  expect(label).toHaveClass("viewport-toolbar-label");
});

it("keeps model and import actions out of the viewport toolbar when the right resource panel owns them", () => {
  render(<ViewportToolbar assetActionsInSidebar />);

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });
  expect(within(toolbar).queryByRole("button", { name: "导入全景图" })).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button", { name: "导入本地模型" })).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button", { name: "模型库" })).not.toBeInTheDocument();
});

it("uses the requested viewport toolbar SVG icons for camera and capture actions", () => {
  render(<ViewportToolbar />);

  expect(screen.getByRole("button", { name: "添加机位" }).querySelector("svg")).toHaveClass("lucide-video");
  expect(screen.getByRole("button", { name: "当前视角截图" }).querySelector("svg")).toHaveClass("lucide-camera");
  expect(screen.getByRole("button", { name: "四方位截图" }).querySelector("svg")).toHaveClass("lucide-grid2x2");
  expect(screen.getByRole("button", { name: "十二方位截图" }).querySelector("svg")).toHaveClass("lucide-grid3x3");
});

it("routes the fullscreen button to the transient frameless layout callback", async () => {
  const user = userEvent.setup();
  const onToggleFrameless = vi.fn();
  render(<ViewportToolbar onToggleFrameless={onToggleFrameless} />);

  await user.click(screen.getByRole("button", { name: "全屏" }));

  expect(onToggleFrameless).toHaveBeenCalledTimes(1);
  expect(useDirectorStore.getState().viewportPanelsCollapsed).toBe(false);
});

it("creates a new camera before storing viewport capsule screenshots from director view", async () => {
  const user = userEvent.setup();
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const snapshot = {
    fov: 64,
    position: [3, 2, 1] as [number, number, number],
    target: [0, 1, -2] as [number, number, number],
  };
  const handler = vi.fn(async () => [
    {
      label: "当前机位",
      dataUrl: "data:image/png;base64,current-camera",
      meta: {
        mode: "camera" as const,
        cameraId: "cam_2",
        fov: 64,
        position: [3, 2, 1] as [number, number, number],
        target: [0, 1, -2] as [number, number, number],
      },
    },
  ]);

  setViewportCaptureHandler(handler);
  render(<ViewportToolbar getViewportCameraSnapshot={() => snapshot} />);

  await user.click(screen.getByRole("button", { name: "当前视角截图" }));

  await waitFor(() => {
    expect(handler).toHaveBeenCalledWith({ preset: "current", source: "camera-panel", cameraId: "cam_2" });
  });

  const state = useDirectorStore.getState();
  const originalCamera = state.project.cameras[0];
  const newCamera = state.project.cameras[1];

  expect(anchorClick).not.toHaveBeenCalled();
  expect(state.viewMode).toBe("director");
  expect(state.project.activeCameraId).toBe("cam_2");
  expect(state.selectedObjectId).toBe("cam_object_2");
  expect(originalCamera?.captures).toEqual([]);
  // The shared authoring path canonicalizes fov through the millimetre-rounded
  // focal length, so the stored optics match within that precision.
  expect(newCamera?.fov).toBeCloseTo(64, 2);
  expect(newCamera?.transform.position).toEqual(getCameraRigPositionFromViewSnapshot(snapshot));
  const roundTripSnapshot = getCameraViewSnapshotFromShot(newCamera);
  expect(roundTripSnapshot.fov).toBeCloseTo(snapshot.fov, 2);
  expect(roundTripSnapshot.position).toEqual(snapshot.position);
  expect(roundTripSnapshot.target).toEqual(snapshot.target);
  expect(newCamera?.captures).toEqual([
    {
      id: "cam_2-capture-01",
      index: 1,
      name: "机位02-截图01",
      dataUrl: "data:image/png;base64,current-camera",
    },
  ]);
  expect(newCamera?.lastCaptureUrl).toBe("data:image/png;base64,current-camera");
});

it("keeps captures in the editor workspace by creating an explicit render camera", async () => {
  const user = userEvent.setup();
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const secondCameraSnapshot = {
    fov: 58,
    position: [1, 2, 6] as [number, number, number],
    target: [0, 1, 0] as [number, number, number],
  };
  const handler = vi.fn(async ({ preset }: { preset: "current" | "four" | "twelve" }) =>
    Array.from({ length: preset === "four" ? 4 : 1 }, (_, index) => ({
      label: `机位截图-${index + 1}`,
      dataUrl: `data:image/png;base64,camera-view-${index + 1}`,
      meta: {
        mode: "camera" as const,
        cameraId: "cam_2",
        fov: 58,
        position: [1, 2, 6] as [number, number, number],
        target: [0, 1, 0] as [number, number, number],
      },
    })),
  );

  useDirectorStore.getState().addCameraShot(secondCameraSnapshot);
  useDirectorStore.getState().setViewMode("camera");
  setViewportCaptureHandler(handler);
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "四方位截图" }));

  await waitFor(() => {
    expect(handler).toHaveBeenCalledWith({ preset: "four", source: "camera-panel", cameraId: "cam_3" });
  });

  const state = useDirectorStore.getState();
  const originalCamera = state.project.cameras[0];
  const previousCamera = state.project.cameras[1];
  const activeCamera = state.project.cameras[2];

  expect(anchorClick).not.toHaveBeenCalled();
  expect(state.project.cameras).toHaveLength(3);
  expect(state.viewMode).toBe("director");
  expect(state.project.activeCameraId).toBe("cam_3");
  expect(originalCamera?.captures).toEqual([]);
  expect(previousCamera?.captures).toEqual([]);
  expect(activeCamera?.captures).toHaveLength(4);
  expect(activeCamera?.captures?.map((item) => item.name)).toEqual([
    "机位03-截图01",
    "机位03-截图02",
    "机位03-截图03",
    "机位03-截图04",
  ]);
  expect(activeCamera?.lastCaptureUrl).toBe("data:image/png;base64,camera-view-4");
});

it("switches the active transform control mode from the viewport capsule", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  expect(screen.getByRole("button", { name: "移动" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "移动" })).toHaveClass("is-active");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "缩放" })).toHaveAttribute("aria-pressed", "false");

  await user.click(screen.getByRole("button", { name: "旋转" }));
  expect(useDirectorStore.getState().transformMode).toBe("rotate");
  expect(screen.getByRole("button", { name: "移动" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveClass("is-active");

  await user.click(screen.getByRole("button", { name: "缩放" }));
  expect(useDirectorStore.getState().transformMode).toBe("scale");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "缩放" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "缩放" })).toHaveClass("is-active");

  await user.click(screen.getByRole("button", { name: "移动" }));
  expect(useDirectorStore.getState().transformMode).toBe("translate");
  expect(screen.getByRole("button", { name: "移动" })).toHaveAttribute("aria-pressed", "true");
});

it("keeps add camera actions available from the viewport capsule", async () => {
  const user = userEvent.setup();
  const snapshot = {
    fov: 64,
    position: [3, 2, 1] as [number, number, number],
    target: [0, 1, -2] as [number, number, number],
  };

  render(<ViewportToolbar getViewportCameraSnapshot={() => snapshot} />);

  await user.click(screen.getByRole("button", { name: "添加机位" }));

  const state = useDirectorStore.getState();
  const cameraCount = state.project.cameras.length;

  expect(cameraCount).toBe(2);
  expect(state.selectedObjectId).toBe("cam_object_2");
  // The shared authoring path canonicalizes fov through the millimetre-rounded
  // focal length, so the stored optics match within that precision.
  expect(state.project.cameras[1].fov).toBeCloseTo(64, 2);
  expect(state.project.cameras[1].transform.position).toEqual(getCameraRigPositionFromViewSnapshot(snapshot));
  expect(getCameraViewSnapshotFromShot(state.project.cameras[1]).position).toEqual(snapshot.position);
  expect(state.project.cameras[1].target).toEqual([0, 1, -2]);
});

it("does not show operation feedback text on the right side of the viewport capsule", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "旋转" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("已切换到旋转工具")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "选择画幅比例" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("画幅比例入口已就绪")).not.toBeInTheDocument();
});

it("renders floating viewport menus and model library outside the frosted toolbar shell", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });

  await user.click(screen.getByRole("button", { name: "模型库" }));
  const modelLibrary = screen.getByRole("dialog", { name: "模型库" });
  expect(toolbar.contains(modelLibrary)).toBe(false);
});

it("closes the model library panel from its close button", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("button", { name: "关闭模型库" }));

  expect(screen.queryByRole("dialog", { name: "模型库" })).not.toBeInTheDocument();
});

it("still imports a local model directly into the scene from the viewport capsule action", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-model-2",
    fileName: "lamp.obj",
    name: "本地台灯",
    url: "blob:local-lamp",
  });
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "导入本地模型" }));

  const fileInput = screen.getByTestId("scene-local-model-input") as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();

  await user.upload(fileInput!, new File(["lamp"], "lamp.obj", { type: "model/obj" }));

  await waitFor(() => {
    expect(useDirectorStore.getState().project.objects.some((item) => item.name === "本地台灯")).toBe(true);
  });

  const state = useDirectorStore.getState();
  expect(state.project.assets.some((item) => item.fileName === "lamp.obj")).toBe(true);
  expect(state.project.objects.some((item) => item.name === "本地台灯")).toBe(true);
});

it("puts a locally imported model on the metric scale once the estimate resolves", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-model-3",
    fileName: "chair.glb",
    name: "本地椅子",
    url: "blob:local-chair",
  });
  mockEstimateLocalModelSizeM.mockResolvedValue(0.92);
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "导入本地模型" }));
  await user.upload(
    screen.getByTestId("scene-local-model-input") as HTMLInputElement,
    new File(["chair"], "chair.glb", { type: "model/gltf-binary" }),
  );

  await waitFor(() => {
    expect(useDirectorStore.getState().project.assets.some((item) => item.realWorldSizeM === 0.92)).toBe(true);
  });
  expect(mockEstimateLocalModelSizeM).toHaveBeenCalledWith("本地椅子");
  expect(useDirectorStore.getState().project.assets.find((item) => item.fileName === "chair.glb")?.sizeSource).toBe(
    "estimated",
  );
});

it("still completes a local import when the gateway cannot estimate a size", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-model-4",
    fileName: "rock.glb",
    name: "本地石块",
    url: "blob:local-rock",
  });
  mockEstimateLocalModelSizeM.mockResolvedValue(null);
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "导入本地模型" }));
  await user.upload(
    screen.getByTestId("scene-local-model-input") as HTMLInputElement,
    new File(["rock"], "rock.glb", { type: "model/gltf-binary" }),
  );

  await waitFor(() => {
    expect(useDirectorStore.getState().project.objects.some((item) => item.name === "本地石块")).toBe(true);
  });
  const asset = useDirectorStore.getState().project.assets.find((item) => item.fileName === "rock.glb");
  expect(asset).toMatchObject({ realWorldSizeM: 2, sizeSource: "estimated" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("closes open viewport toolbar menus when users click outside", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button type="button">画布空白</button>
      <ViewportToolbar />
    </>,
  );

  await user.click(screen.getByRole("button", { name: "模型库" }));

  expect(screen.getByRole("dialog", { name: "模型库" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "画布空白" }));

  expect(screen.queryByRole("dialog", { name: "模型库" })).not.toBeInTheDocument();
});

it("opens the aspect ratio panel from the viewport capsule with the supported presets", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "选择画幅比例" }));

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });
  const dialog = screen.getByRole("dialog", { name: "比例" });

  expect(dialog).toBeInTheDocument();
  expect(toolbar.contains(dialog)).toBe(false);
  expect(screen.getByRole("button", { name: "自动" })).toHaveAttribute("aria-pressed", "true");
  ["1:1", "2:1", "3:4", "4:3", "16:9", "21:9", "9:16"].forEach((label) => {
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });
});

it("updates the viewport aspect ratio from the ratio panel", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "选择画幅比例" }));
  await user.click(screen.getByRole("button", { name: "9:16" }));

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("9:16");
  expect(screen.queryByRole("dialog", { name: "比例" })).not.toBeInTheDocument();
});
