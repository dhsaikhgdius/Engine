import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import { DIRECTOR_THEME_STORAGE_KEY } from "../../src/comprehensive/app/theme/directorTheme";
import {
  STAGE_VIEWPORT_AUDIO_STORAGE_KEY,
  setStageViewportAudioEnabled,
} from "../../src/comprehensive/editor/audio/stageViewportAudio";
import {
  resetDirectorSessionRuntime,
  updateDirectorSessionRuntime,
} from "../../src/comprehensive/editor/session/directorSessionRuntime";
import {
  getDirectorCreativeWorkspaceScope,
  setDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
} from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  MIN_RIGHT_PANEL_WIDTH,
  RIGHT_PANEL_COLLAPSE_OVERDRAG_PX,
} from "../../src/comprehensive/app/layout/workspaceLayout";
import {
  requestViewportCaptureHost,
  resetViewportCaptureHostRequest,
} from "../../src/comprehensive/editor/io/captureBridge";

const hostBridgeMocks = vi.hoisted(() => ({
  clear: vi.fn(),
  init: vi.fn(),
}));

const workspaceModuleLoads = vi.hoisted(() => ({
  canvas: vi.fn(),
  stage: vi.fn(),
  video: vi.fn(),
  agent: vi.fn(),
}));

vi.mock("../../src/comprehensive/editor/io/hostBridge", () => ({
  clearDirectorDeskHostBridge: hostBridgeMocks.clear,
  initDirectorDeskHostBridge: hostBridgeMocks.init,
}));

vi.mock("../../src/comprehensive/editor/canvas/DirectorCanvas", () => ({
  DirectorCanvas: ({
    captureOnly,
    onTimelineCollapsedChange,
    onToggleFrameless,
    timelineVisible,
    blenderLiveVisible,
  }: {
    captureOnly?: boolean;
    onTimelineCollapsedChange: (collapsed: boolean) => void;
    onToggleFrameless: () => void;
    timelineVisible: boolean;
    blenderLiveVisible: boolean;
  }) => (
    <div
      data-testid="mock-director-canvas"
      data-blender-live-visible={blenderLiveVisible}
      data-capture-only={captureOnly}
    >
      <button aria-label="全屏" onClick={onToggleFrameless} type="button" />
      {timelineVisible ? (
        <div
          aria-label="调整时间轴高度"
          onClick={() => onTimelineCollapsedChange(true)}
          role="separator"
          tabIndex={0}
        />
      ) : null}
    </div>
  ),
}));

vi.mock("../../src/comprehensive/editor/workspaces/CanvasWorkspace", () => {
  workspaceModuleLoads.canvas();
  return {
    CanvasWorkspace: () => <main data-testid="mock-canvas-workspace">Canvas workspace</main>,
  };
});

vi.mock("../../src/comprehensive/editor/workspaces/VideoEditorWorkspace", () => {
  workspaceModuleLoads.video();
  return {
    VideoEditorWorkspace: () => <main data-testid="mock-video-workspace">Video workspace</main>,
  };
});

vi.mock("../../src/comprehensive/editor/workspaces/StageWorkspace", async (importOriginal) => {
  workspaceModuleLoads.stage();
  return importOriginal<typeof import("../../src/comprehensive/editor/workspaces/StageWorkspace")>();
});

vi.mock("../../src/comprehensive/editor/workspaces/AgentWorkspace", () => {
  workspaceModuleLoads.agent();
  return {
    AgentWorkspace: () => <main data-testid="mock-agent-workspace">Agent workspace</main>,
  };
});

vi.mock("../../src/comprehensive/editor/interchange/BlenderLivePanel", () => ({
  BlenderLivePanel: () => <section aria-label="Blender 场景">Blender scene</section>,
  BlenderNativeMeshInspector: () => null,
}));

import App, { SETTINGS_CLUSTER_COLLAPSED_STORAGE_KEY } from "../../src/comprehensive/App";

beforeEach(() => {
  hostBridgeMocks.clear.mockClear();
  hostBridgeMocks.init.mockClear();
  workspaceModuleLoads.canvas.mockClear();
  workspaceModuleLoads.stage.mockClear();
  workspaceModuleLoads.video.mockClear();
  workspaceModuleLoads.agent.mockClear();
  window.localStorage.removeItem(DIRECTOR_THEME_STORAGE_KEY);
  window.localStorage.removeItem(SETTINGS_CLUSTER_COLLAPSED_STORAGE_KEY);
  window.localStorage.removeItem(STAGE_VIEWPORT_AUDIO_STORAGE_KEY);
  setStageViewportAudioEnabled(true);
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("color-scheme");
  resetDirectorSessionRuntime();
  setDirectorCreativeWorkspaceScope("local");
  window.localStorage.removeItem("director.creative-workspaces.v2.scene-remote");
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    redoStack: [],
  });
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  window.history.replaceState(null, "", "/");
  resetViewportCaptureHostRequest();
});

it("loads a requested creative workspace without importing the Stage boundary", async () => {
  window.history.replaceState(null, "", "/?workspace=canvas");

  render(<App />);

  expect(screen.getByRole("tab", { name: "画布" })).toHaveAttribute("aria-selected", "true");
  expect(workspaceModuleLoads.stage).not.toHaveBeenCalled();
  expect(screen.queryByTestId("mock-director-canvas")).not.toBeInTheDocument();
  expect(await screen.findByTestId("mock-canvas-workspace")).toBeInTheDocument();
  expect(workspaceModuleLoads.canvas).toHaveBeenCalledTimes(1);
  expect(workspaceModuleLoads.stage).not.toHaveBeenCalled();
  expect(screen.queryByTestId("mock-director-canvas")).not.toBeInTheDocument();
});

it("loads a requested Agent workspace without importing the Stage boundary", async () => {
  window.history.replaceState(null, "", "/?workspace=agent");

  render(<App />);

  expect(screen.getByRole("tab", { name: "Agent 工作区" })).toHaveAttribute("aria-selected", "true");
  expect(workspaceModuleLoads.stage).not.toHaveBeenCalled();
  expect(screen.queryByTestId("mock-director-canvas")).not.toBeInTheDocument();
  expect(await screen.findByTestId("mock-agent-workspace")).toBeInTheDocument();
  expect(workspaceModuleLoads.agent).toHaveBeenCalledTimes(1);
  expect(workspaceModuleLoads.stage).not.toHaveBeenCalled();
});

it("mounts a hidden Stage capture host when Agent asks for a screenshot", async () => {
  window.history.replaceState(null, "", "/?workspace=agent");
  render(<App />);

  expect(await screen.findByTestId("mock-agent-workspace")).toBeInTheDocument();
  expect(screen.queryByTestId("mock-director-canvas")).not.toBeInTheDocument();

  act(() => {
    requestViewportCaptureHost();
  });

  const host = await screen.findByTestId("director-stage-capture-host");
  expect(host).toHaveAttribute("aria-hidden", "true");
  expect(host).toHaveAttribute("inert", "");
  expect(screen.getByTestId("mock-director-canvas")).toHaveAttribute("data-capture-only", "true");
  expect(screen.getByTestId("mock-director-canvas")).toHaveAttribute("data-blender-live-visible", "true");
  expect(workspaceModuleLoads.stage).not.toHaveBeenCalled();
});

it("does not overwrite a gateway-initialized creative scope while the scene id is still empty", () => {
  setDirectorCreativeWorkspaceScope("local-stage");

  render(<App />);

  expect(getDirectorCreativeWorkspaceScope()).toBe("local-stage");
});

it("switches between light and dark production themes and remembers the choice", async () => {
  const user = userEvent.setup();
  render(<App />);

  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  await user.click(screen.getByRole("button", { name: "切换到浅色模式" }));

  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(window.localStorage.getItem(DIRECTOR_THEME_STORAGE_KEY)).toBe("light");
  expect(screen.getByRole("button", { name: "切换到深色模式" })).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: "切换到深色模式" }));

  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(window.localStorage.getItem(DIRECTOR_THEME_STORAGE_KEY)).toBe("dark");
});

it("renders the director desk header without a full-screen camera view switch", () => {
  const { container } = render(<App />);

  expect(screen.getByText("Director")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "导演视角" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "机位视角" })).not.toBeInTheDocument();
  expect(container.querySelector(".top-bar-center .mode-toggle")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("帮助")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("关闭")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("收起顶部栏")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "性能 自动" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "视角手感" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "关闭舞台音效" })).not.toBeInTheDocument();
  expect(container.querySelector(".director-collaboration-entry")).not.toBeInTheDocument();
  expect(container.querySelector(".top-bar")).toBeInTheDocument();
});

it("routes the existing view-control toggle to the Blender scene layer", async () => {
  const user = userEvent.setup();
  render(<App />);
  const canvas = await screen.findByTestId("mock-director-canvas", {}, { timeout: 5_000 });
  expect(canvas).toHaveAttribute("data-blender-live-visible", "true");

  await user.click(screen.getByRole("button", { name: "视角手感" }));
  await user.click(screen.getByRole("checkbox", { name: "Blender live" }));
  expect(canvas).toHaveAttribute("data-blender-live-visible", "false");
});

it("keeps workspace tabs in one header slot when leaving Stage's collapsed inspector", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");

  const tabs = container.querySelector(".top-workspace-tabs");
  expect(container.querySelector(".app-shell")).toHaveClass("is-right-panel-collapsed");
  expect(tabs).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "画布" }));
  expect(container.querySelector(".app-shell")).toHaveClass("is-workspace-canvas");
  expect(container.querySelector(".app-shell")).not.toHaveClass("is-right-panel-collapsed");
  expect(container.querySelector(".top-workspace-tabs")).toBe(tabs);
});

it("switches between canvas, 3D stage, and video editor workspaces", async () => {
  const user = userEvent.setup();
  render(<App />);

  expect(await screen.findByTestId("mock-director-canvas")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "3D 片场" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("button", { name: "关闭舞台音效" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "画布" }));
  expect(screen.getByTestId("mock-canvas-workspace")).toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.get("workspace")).toBe("canvas");

  await user.click(screen.getByRole("tab", { name: "视频编辑器" }));
  expect(screen.getByTestId("mock-video-workspace")).toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.get("workspace")).toBe("video");

  expect(screen.queryByRole("tab", { name: "Gallery" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "Agent 工作区" }));
  expect(await screen.findByTestId("mock-agent-workspace")).toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.get("workspace")).toBe("agent");
  expect(screen.queryByTestId("mock-director-canvas")).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "3D 片场" }));
  expect(await screen.findByTestId("mock-director-canvas")).toBeInTheDocument();
});

it("treats a leftover Gallery workspace URL as the 3D stage", async () => {
  window.history.replaceState(null, "", "/?workspace=gallery");
  render(<App />);
  expect(await screen.findByTestId("mock-director-canvas")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "3D 片场" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("tab", { name: "Gallery" })).not.toBeInTheDocument();
});

it("synchronizes workspace changes from browser history, including the URL without an override", async () => {
  window.history.replaceState(null, "", "/?workspace=video");
  render(<App />);
  expect(await screen.findByTestId("mock-video-workspace")).toBeInTheDocument();

  act(() => {
    window.history.replaceState(null, "", "/?workspace=canvas");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByTestId("mock-canvas-workspace")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "画布" })).toHaveAttribute("aria-selected", "true");

  act(() => {
    window.history.replaceState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByTestId("mock-director-canvas")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "3D 片场" })).toHaveAttribute("aria-selected", "true");
});

it("keeps an explicit creative workspace selected when the host scene scope arrives", async () => {
  window.localStorage.setItem(
    "director.creative-workspaces.v2.scene-remote",
    JSON.stringify({ version: 2, state: { mode: "stage" } }),
  );
  window.history.replaceState(null, "", "/?workspace=video");

  render(<App />);

  expect(await screen.findByTestId("mock-video-workspace")).toBeInTheDocument();

  act(() => {
    updateDirectorSessionRuntime({ sceneId: "scene-remote" });
  });

  expect(await screen.findByTestId("mock-video-workspace")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "视频编辑器" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByTestId("mock-director-canvas")).not.toBeInTheDocument();
});

it("uses a compact tool strip when ComfyUI owns the surrounding workbench chrome", () => {
  const previousUrl = window.location.href;
  window.history.replaceState(null, "", "/?embed=comfyui");

  try {
    const { container } = render(<App />);

    expect(container.querySelector(".app-shell.is-comfyui-embedded")).toBeInTheDocument();
    expect(container.querySelector(".top-bar.is-comfyui-embedded")).toBeInTheDocument();
    expect(screen.queryByText("3D Director UI")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("收起顶部栏")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("关闭")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导演视角" })).not.toBeInTheDocument();
  } finally {
    window.history.replaceState(null, "", previousUrl);
  }
});

it("keeps the director desk top bar visible without a collapse control", () => {
  const { container } = render(<App />);

  expect(container.querySelector(".top-bar")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "收起顶部栏" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "展开顶部栏" })).not.toBeInTheDocument();
});

it("folds the top-bar settings cluster without hiding the header", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  const cluster = container.querySelector(".top-bar-settings-cluster");
  const fold = container.querySelector("#top-bar-settings-fold");

  expect(cluster).not.toHaveClass("is-collapsed");
  expect(fold).not.toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "视角手感" })).toBeInTheDocument();

  const collapseToggle = container.querySelector(".top-bar-settings-collapse");
  expect(collapseToggle).toHaveAttribute("aria-expanded", "true");
  expect(collapseToggle).not.toHaveAttribute("title");
  expect(collapseToggle).not.toHaveAttribute("aria-label");

  await user.click(collapseToggle!);

  expect(cluster).toHaveClass("is-collapsed");
  expect(fold).toHaveAttribute("inert", "");
  expect(collapseToggle).toHaveAttribute("aria-expanded", "false");
  expect(window.localStorage.getItem(SETTINGS_CLUSTER_COLLAPSED_STORAGE_KEY)).toBe("1");
  expect(container.querySelector(".top-bar")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "收起顶部栏" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "收起设置栏" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "展开设置栏" })).not.toBeInTheDocument();

  await user.click(collapseToggle!);

  expect(cluster).not.toHaveClass("is-collapsed");
  expect(fold).not.toHaveAttribute("inert");
  expect(collapseToggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "视角手感" })).toBeInTheDocument();
  expect(window.localStorage.getItem(SETTINGS_CLUSTER_COLLAPSED_STORAGE_KEY)).toBe("0");
});

it("restores a collapsed settings cluster from the remembered preference", () => {
  window.localStorage.setItem(SETTINGS_CLUSTER_COLLAPSED_STORAGE_KEY, "1");
  const { container } = render(<App />);
  const collapseToggle = container.querySelector(".top-bar-settings-collapse");

  expect(container.querySelector(".top-bar-settings-cluster")).toHaveClass("is-collapsed");
  expect(container.querySelector("#top-bar-settings-fold")).toHaveAttribute("inert", "");
  expect(collapseToggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "展开设置栏" })).not.toBeInTheDocument();
});

it("notifies the host canvas when the director desk app is ready", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);

  render(<App />);

  expect(postMessage).toHaveBeenCalledWith({ type: "storyai:director-desk-ready" }, window.location.origin);

  postMessage.mockRestore();
});

it("clears the host bridge when the director desk app unmounts", () => {
  const { unmount } = render(<App />);

  expect(hostBridgeMocks.init).toHaveBeenCalledTimes(1);
  expect(hostBridgeMocks.clear).not.toHaveBeenCalled();

  unmount();

  expect(hostBridgeMocks.clear).toHaveBeenCalledTimes(1);
});

it("uses a full-width director desk frame instead of floating card columns", async () => {
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");
  const shell = container.querySelector(".director-shell.director-shell-fullbleed");

  expect(shell).toBeInTheDocument();
  expect(shell?.firstElementChild).toHaveClass("viewport-column");
  expect(screen.getByLabelText("场景")).toHaveClass("left-sidebar");
  expect(screen.getByLabelText("3D视口")).toHaveClass("viewport-column");
  expect(container.querySelector(".right-sidebar")).toHaveClass("director-sidebar");
});

it("opens Stage with the timeline and right inspector collapsed", async () => {
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");
  const shell = container.querySelector<HTMLElement>(".app-shell");

  expect(shell).toHaveClass("is-right-panel-collapsed");
  expect(shell).not.toHaveClass("is-timeline-open");
  expect(shell?.style.getPropertyValue("--right-sidebar-width")).toBe("0px");
  expect(shell?.style.getPropertyValue("--timeline-panel-height")).toBe("0px");
  expect(screen.getByRole("separator", { name: "展开右侧栏" })).toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "展开下方栏" })).toBeInTheDocument();
  expect(screen.queryByRole("separator", { name: "调整属性面板宽度" })).not.toBeInTheDocument();
  expect(screen.queryByRole("separator", { name: "调整时间轴高度" })).not.toBeInTheDocument();
});

it("opens the properties inspector directly from scene and world settings", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");

  await user.click(screen.getByRole("button", { name: "场景与世界设置" }));

  expect(container.querySelector(".app-shell")).not.toHaveClass("is-right-panel-collapsed");
  expect(screen.getByRole("tab", { name: "属性" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("region", { name: "3D场景右侧属性面板" })).toBeInTheDocument();
});

it("keeps the scene sidebar without a collapse control", async () => {
  render(<App />);
  await screen.findByTestId("mock-director-canvas");

  expect(screen.queryByRole("button", { name: /(?:收起|展开)场景面板/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText("场景")).not.toHaveAttribute("aria-hidden");
  expect(screen.queryByRole("button", { name: "收起右侧栏" })).not.toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "展开右侧栏" })).toBeInTheDocument();
});

it("collapses the right inspector from a click on the expanded sash", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");
  await user.click(screen.getByRole("separator", { name: "展开右侧栏" }));
  expect(container.querySelector(".app-shell")).not.toHaveClass("is-right-panel-collapsed");

  await user.click(screen.getByRole("separator", { name: "调整属性面板宽度" }));
  expect(container.querySelector(".app-shell")).toHaveClass("is-right-panel-collapsed");
  expect(screen.getByRole("separator", { name: "展开右侧栏" })).toBeInTheDocument();
});

it("lets the right inspector column collapse, release viewport space, and reopen from the edge sash", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");
  const shell = container.querySelector<HTMLElement>(".app-shell");

  expect(shell).toHaveClass("is-right-panel-collapsed");
  expect(shell?.style.getPropertyValue("--right-sidebar-width")).toBe("0px");
  await user.click(screen.getByRole("separator", { name: "展开右侧栏" }));
  expect(shell).not.toHaveClass("is-right-panel-collapsed");
  expect(shell?.style.getPropertyValue("--right-sidebar-width")).toBe("260px");
  expect(screen.getByLabelText("属性")).not.toHaveAttribute("aria-hidden");
  const resizer = screen.getByRole("separator", { name: "调整属性面板宽度" });
  fireEvent.pointerDown(resizer, { button: 0, clientX: 1000 });
  fireEvent.pointerMove(window, {
    clientX: 1000 + 260 - (MIN_RIGHT_PANEL_WIDTH - RIGHT_PANEL_COLLAPSE_OVERDRAG_PX) + 1,
  });
  fireEvent.pointerUp(window);
  expect(shell).toHaveClass("is-right-panel-collapsed");
  expect(shell?.style.getPropertyValue("--right-sidebar-width")).toBe("0px");
  expect(screen.getByLabelText("属性")).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("separator", { name: "调整属性面板宽度" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "收起右侧栏" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "展开右侧栏" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("separator", { name: "展开右侧栏" }));
  expect(shell).not.toHaveClass("is-right-panel-collapsed");
  expect(shell?.style.getPropertyValue("--right-sidebar-width")).toBe("260px");
  expect(screen.getByLabelText("属性")).not.toHaveAttribute("aria-hidden");
  expect(screen.getByRole("separator", { name: "调整属性面板宽度" })).toBeInTheDocument();
});

it("keeps the Stage inspector to properties, modeling, and assets", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");
  await user.click(screen.getByRole("separator", { name: "展开右侧栏" }));
  const sidebar = container.querySelector(".right-sidebar");
  expect(sidebar).not.toBeNull();

  expect(screen.getByRole("tab", { name: "属性" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Blender" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "资源" })).toBeInTheDocument();
  expect(within(sidebar as HTMLElement).queryByRole("tab", { name: /^Agent$/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "终端" })).not.toBeInTheDocument();
});

it("opens Blender modeling inside the Director sidebar", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("mock-director-canvas");
  await user.click(screen.getByRole("separator", { name: "展开右侧栏" }));

  await user.click(screen.getByRole("tab", { name: "Blender" }));

  expect(await screen.findByRole("region", { name: "Blender 场景" })).toBeInTheDocument();
});

it("resizes each panel within bounds without changing the director project", async () => {
  const originalInnerWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
  const user = userEvent.setup();
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");
  await user.click(screen.getByRole("separator", { name: "展开右侧栏" }));
  const projectBefore = JSON.stringify(useDirectorStore.getState().project);
  const left = screen.getByRole("separator", { name: "调整场景面板宽度" });
  const right = screen.getByRole("separator", { name: "调整属性面板宽度" });

  fireEvent.pointerDown(left, { button: 0, clientX: 220 });
  fireEvent.pointerMove(window, { clientX: 900 });
  fireEvent.pointerUp(window);
  expect(left).toHaveAttribute("aria-valuemax", "640");
  expect(left).toHaveAttribute("aria-valuenow", "640");

  fireEvent.keyDown(right, { key: "Home" });
  expect(right).toHaveAttribute("aria-valuenow", "240");
  fireEvent.keyDown(right, { key: "ArrowRight" });
  expect(container.querySelector(".app-shell")).toHaveClass("is-right-panel-collapsed");
  expect(JSON.stringify(useDirectorStore.getState().project)).toBe(projectBefore);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
});

it("lets the timeline collapse, release viewport space, and reopen from the bottom sash", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().updateScene({
    timeline: { version: 1, fps: 24, frameStart: 0, frameEnd: 48, currentFrame: 0, loop: false },
  });
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");

  expect(container.querySelector(".app-shell.is-timeline-open")).not.toBeInTheDocument();
  await user.click(screen.getByRole("separator", { name: "展开下方栏" }));
  expect(container.querySelector(".app-shell.is-timeline-open")).toBeInTheDocument();
  await user.click(screen.getByRole("separator", { name: "调整时间轴高度" }));
  expect(container.querySelector(".app-shell.is-timeline-open")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "展开下方栏" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("separator", { name: "展开下方栏" }));
  expect(container.querySelector(".app-shell.is-timeline-open")).toBeInTheDocument();
});

it("enters frameless mode from the viewport and restores the previous workspace", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  await screen.findByTestId("mock-director-canvas");

  await user.click(screen.getByRole("button", { name: "全屏" }));
  expect(container.querySelector(".app-shell.is-frameless")).toBeInTheDocument();
  expect(container.querySelector(".director-shell.is-frameless")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "退出极简无框模式" }));
  expect(container.querySelector(".app-shell.is-frameless")).not.toBeInTheDocument();
  expect(screen.getByLabelText("场景")).not.toHaveAttribute("aria-hidden");
  expect(container.querySelector(".app-shell")).toHaveClass("is-right-panel-collapsed");
  expect(screen.getByLabelText("属性")).toHaveAttribute("aria-hidden", "true");
});

it("keeps the Stage workspace in director mode when a legacy camera-view command arrives", () => {
  render(<App />);

  useDirectorStore.getState().setViewMode("camera");

  expect(useDirectorStore.getState().viewMode).toBe("director");
  expect(screen.queryByRole("button", { name: "机位视角" })).not.toBeInTheDocument();
});

it("supports Cmd/Ctrl+C and Cmd/Ctrl+V to duplicate the selected object", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("mock-director-canvas");

  await user.click(screen.getByRole("button", { name: "角色01" }));
  await user.keyboard("{Control>}c{/Control}");
  await user.keyboard("{Control>}v{/Control}");

  const state = useDirectorStore.getState();
  const characters = state.project.objects.filter((item) => item.kind === "character");

  expect(characters).toHaveLength(2);
  expect(characters[1]?.id).not.toBe("char_default_a");
  expect(state.selectedObjectId).toBe(characters[1]?.id ?? null);
});

it("supports Cmd/Ctrl+D duplication and Cmd/Ctrl+A selection in Stage", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("mock-director-canvas");

  await user.click(screen.getByRole("button", { name: "角色01" }));
  await user.keyboard("{Control>}d{/Control}");
  expect(useDirectorStore.getState().project.objects.filter((item) => item.kind === "character")).toHaveLength(2);

  await user.keyboard("{Control>}a{/Control}");
  expect(useDirectorStore.getState().selectedObjectIds).toHaveLength(
    useDirectorStore.getState().project.objects.length,
  );
});

it("supports Cmd/Ctrl+Z to undo the latest scene edit", async () => {
  const user = userEvent.setup();
  render(<App />);

  act(() => {
    useDirectorStore.getState().addPresetCharacter("female");
  });
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(true);

  await user.keyboard("{Control>}z{/Control}");

  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(false);
});

it("supports Cmd/Ctrl+Shift+Z and Cmd/Ctrl+Y to redo a Stage edit", async () => {
  render(<App />);

  act(() => {
    useDirectorStore.getState().addPresetCharacter("female");
  });
  fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(false);

  fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(true);

  fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
  fireEvent.keyDown(window, { key: "y", code: "KeyY", ctrlKey: true });
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(true);
});

it("shows shortcuts for the active workspace without binding Space globally", async () => {
  render(<App />);
  await screen.findByTestId("mock-director-canvas");

  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /键盘快捷键/ }));

  expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toHaveTextContent("复制所选对象");
  expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toHaveTextContent("W · A · S · D · Q · E");
  expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toHaveTextContent("方向键转视角");
});
