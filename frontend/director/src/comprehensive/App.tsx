import "./styles/index.css";
import "./styles/agentNativeTheme.css";
import "./styles/premiumDirectorTheme.css";
import "./styles/sceneInspector.css";
import "./styles/characterInspector.css";
import "./styles/cameraInspector.css";
import "./styles/canvasEditor.css";
import "./styles/propInspector.css";
import "./styles/trajectoryInspector.css";
import "./styles/videoEditor.css";
import "./styles/objectTreePanel.css";
import "./styles/rightSidebar.css";
import "./styles/workspaceLoading.css";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
} from "react";
import { Bot, Boxes, ChevronDown, Film, Languages, LayoutDashboard, Minimize2, Moon, Sun } from "lucide-react";
import { LanguageProvider, useLanguage } from "./i18n/language";
import { RetryableWorkspace } from "./app/errors/RetryableWorkspace";
import { WorkspaceErrorBoundary } from "./app/errors/WorkspaceErrorBoundary";
import { HelpMenu } from "./app/help/HelpMenu";
import { DirectorTaskTrayMenu } from "./app/tasks/DirectorTaskTrayMenu";
import { GlobalTooltipLayer } from "./app/layout/GlobalTooltipLayer";
import { WelcomeGuide } from "./app/welcome/WelcomeGuide";
import { DirectorNotificationLayer } from "./app/notifications/DirectorNotificationLayer";
import { notifyDirector } from "./app/notifications/directorNotificationStore";
import { DEFAULT_DIRECTOR_WORKSPACE_LAYOUT, type DirectorWorkspaceLayout } from "./app/layout/workspaceLayout";
import {
  isDirectorCreativeWorkspace,
  readDirectorAppWorkspaceFromLocation,
  writeDirectorAppWorkspaceToLocation,
  type DirectorAppWorkspace,
} from "./app/layout/directorAppWorkspace";
import { CollapsedTimelineSash } from "./app/layout/CollapsedTimelineSash";
import { CollapsedRightPanelSash } from "./app/layout/CollapsedRightPanelSash";
import { applyDirectorTheme, getDirectorTheme, subscribeToDirectorTheme } from "./app/theme/directorTheme";
import { ViewportNavigationSettings } from "./editor/canvas/ViewportNavigationSettings";
import { isViewportCaptureHostNeeded, subscribeViewportCaptureHost } from "./editor/io/captureBridge";
import { clearDirectorDeskHostBridge, initDirectorDeskHostBridge } from "./editor/io/hostBridge";
import { importLocalDirectorDeskCaptures } from "./editor/io/localCaptureImport";
import { AgentWorkspaceSettings } from "./editor/assistant/AgentWorkspaceSettings";
import { PerformanceSettings } from "./editor/performance/PerformanceSettings";
import { EditorShortcuts } from "./editor/keyboard/EditorShortcuts";
import { useDirectorSessionRuntime } from "./editor/session/directorSessionRuntime";
import { useDirectorStore } from "./editor/store/directorStore";
import {
  setDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
  type DirectorWorkspaceMode,
} from "./editor/workspaces/directorWorkspaceStore";

const loadCanvasWorkspace = () =>
  import("./editor/workspaces/CanvasWorkspace").then((module) => ({ default: module.CanvasWorkspace }));
const loadVideoEditorWorkspace = () =>
  import("./editor/workspaces/VideoEditorWorkspace").then((module) => ({ default: module.VideoEditorWorkspace }));
const loadStageWorkspace = () =>
  import("./editor/workspaces/StageWorkspace").then((module) => ({ default: module.StageWorkspace }));
const loadAgentWorkspace = () =>
  import("./editor/workspaces/AgentWorkspace").then((module) => ({ default: module.AgentWorkspace }));

const WORKSPACE_TABS = [
  ["canvas", LayoutDashboard, "画布"],
  ["stage", Boxes, "3D 片场"],
  ["video", Film, "视频编辑器"],
  ["agent", Bot, "Agent 工作区"],
] as const;

const StageCaptureHost = lazy(async () => {
  const module = await import("./editor/canvas/StageCaptureHost");
  return { default: module.StageCaptureHost };
});

const DirectorInterchangeMenu = lazy(async () => {
  const module = await import("./editor/interchange/DirectorInterchangeMenu");
  return { default: module.DirectorInterchangeMenu };
});

// The sync bridge drags the Blender scene diffing stack (three.js, GLTF,
// react-three-fiber) with it; loading it lazily and only while it is active
// keeps that stack out of the eager App chunk.
const BlenderProjectSyncBridge = lazy(async () => {
  const module = await import("./editor/runtime/BlenderProjectSyncBridge");
  return { default: module.BlenderProjectSyncBridge };
});

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function isComfyUiEmbedded() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("embed") === "comfyui";
}

function getRequestedAppWorkspace(): DirectorAppWorkspace | null {
  if (typeof window === "undefined") return null;
  return readDirectorAppWorkspaceFromLocation();
}

function DirectorApp() {
  const { locale, setLocale, t } = useLanguage();
  const theme = useSyncExternalStore(subscribeToDirectorTheme, getDirectorTheme, () => "dark" as const);
  const sceneId = useDirectorSessionRuntime((state) => state.sceneId);
  const timelineEnabled = useDirectorStore((state) => Boolean(state.project.scene.timeline));
  const nativeProjectId = useDirectorStore((state) => state.project.nativeScene?.projectId);
  const ensureNativeSceneBinding = useDirectorStore((state) => state.ensureNativeSceneBinding);
  const workspaceMode = useDirectorCreativeWorkspaceStore((state) => state.mode);
  const setWorkspaceMode = useDirectorCreativeWorkspaceStore((state) => state.setMode);
  const comfyUiEmbedded = isComfyUiEmbedded();
  const requestedAppWorkspace = comfyUiEmbedded ? null : getRequestedAppWorkspace();
  const [initialAppWorkspace, setInitialAppWorkspace] = useState<DirectorAppWorkspace | null>(
    () => requestedAppWorkspace,
  );
  const [agentOpen, setAgentOpen] = useState(() => requestedAppWorkspace === "agent");
  const [workspaceLayout, setWorkspaceLayout] = useState<DirectorWorkspaceLayout>(DEFAULT_DIRECTOR_WORKSPACE_LAYOUT);
  const [blenderLiveVisible, setBlenderLiveVisible] = useState(true);
  const captureHostNeeded = useSyncExternalStore(
    subscribeViewportCaptureHost,
    isViewportCaptureHostNeeded,
    () => false,
  );
  const creativeWorkspaceMode: DirectorWorkspaceMode =
    initialAppWorkspace && isDirectorCreativeWorkspace(initialAppWorkspace) ? initialAppWorkspace : workspaceMode;
  const activeAppWorkspace: DirectorAppWorkspace = comfyUiEmbedded
    ? "stage"
    : agentOpen
      ? "agent"
      : creativeWorkspaceMode;
  const timelineVisible =
    activeAppWorkspace === "stage" &&
    timelineEnabled &&
    !workspaceLayout.timelineCollapsed &&
    !workspaceLayout.frameless;
  const rightPanelCollapsed =
    activeAppWorkspace === "stage" && workspaceLayout.rightPanelCollapsed && !workspaceLayout.frameless;
  const visibleRightSidebarWidth = rightPanelCollapsed ? 0 : workspaceLayout.rightPanelWidth;
  const workspaceTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!nativeProjectId) ensureNativeSceneBinding();
  }, [ensureNativeSceneBinding, nativeProjectId]);

  useLayoutEffect(() => {
    applyDirectorTheme(theme, { notify: false });
  }, [theme]);

  useEffect(() => {
    initDirectorDeskHostBridge();
    window.parent?.postMessage({ type: "storyai:director-desk-ready" }, window.location.origin);

    return () => {
      clearDirectorDeskHostBridge();
    };
  }, []);

  useEffect(() => {
    const receiveStandaloneCaptures = (event: MessageEvent) => {
      if (event.source !== window) return;
      void importLocalDirectorDeskCaptures(event.data).catch((error: unknown) => {
        console.error("Failed to import Stage capture into the creative workspace", error);
        notifyDirector({
          key: "stage-capture-import-failed",
          severity: "error",
          title: "截图未能写入媒体库",
          detail: `${error instanceof Error ? error.message : String(error)}。请重新截图；如持续失败，建议直接保存截图文件。`,
        });
      });
    };

    window.addEventListener("message", receiveStandaloneCaptures);
    return () => window.removeEventListener("message", receiveStandaloneCaptures);
  }, []);

  useEffect(() => {
    if (sceneId) setDirectorCreativeWorkspaceScope(sceneId);
  }, [sceneId]);

  useEffect(() => {
    if (comfyUiEmbedded) return;
    const requested = getRequestedAppWorkspace();
    if (requested === "agent") setAgentOpen(true);
    else {
      setAgentOpen(false);
      if (requested) setWorkspaceMode(requested);
    }
    setInitialAppWorkspace(null);

    const syncWorkspaceFromHistory = () => {
      const next = getRequestedAppWorkspace();
      if (next === "agent") {
        setAgentOpen(true);
        return;
      }
      setAgentOpen(false);
      setWorkspaceMode(next ?? "stage");
    };
    window.addEventListener("popstate", syncWorkspaceFromHistory);
    return () => window.removeEventListener("popstate", syncWorkspaceFromHistory);
  }, [comfyUiEmbedded, sceneId, setWorkspaceMode]);

  useEffect(() => {
    if (!agentOpen) return;
    const requested = getRequestedAppWorkspace();
    if (requested && requested !== "agent") setAgentOpen(false);
  }, [agentOpen, workspaceMode]);

  function selectWorkspace(mode: DirectorAppWorkspace) {
    if (mode === "agent") {
      setAgentOpen(true);
      writeDirectorAppWorkspaceToLocation(mode);
      return;
    }
    setAgentOpen(false);
    setWorkspaceMode(mode);
    writeDirectorAppWorkspaceToLocation(mode);
  }

  function focusWorkspaceTab(index: number) {
    const tab = WORKSPACE_TABS[index];
    if (!tab) return;
    selectWorkspace(tab[0]);
    workspaceTabRefs.current[index]?.focus();
  }

  function handleWorkspaceTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusWorkspaceTab((index + 1) % WORKSPACE_TABS.length);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusWorkspaceTab((index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length);
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) return;
      if (!event.metaKey && !event.ctrlKey) return;

      const key = event.key.toLowerCase();
      if (activeAppWorkspace === "stage" && key === "c") {
        event.preventDefault();
        useDirectorStore.getState().copySelectedObjects();
        return;
      }

      if (activeAppWorkspace === "stage" && key === "v") {
        event.preventDefault();
        useDirectorStore.getState().pasteClipboardObjects();
        return;
      }

      if (activeAppWorkspace === "stage" && key === "d") {
        event.preventDefault();
        const stage = useDirectorStore.getState();
        stage.copySelectedObjects();
        stage.pasteClipboardObjects();
        return;
      }

      if (activeAppWorkspace === "stage" && key === "a") {
        event.preventDefault();
        const stage = useDirectorStore.getState();
        stage.selectObjects(stage.project.objects.map((object) => object.id));
        return;
      }

      if (key === "z" && !event.shiftKey) {
        if (activeAppWorkspace === "agent") return;
        event.preventDefault();
        if (activeAppWorkspace === "stage") useDirectorStore.getState().undo();
        else useDirectorCreativeWorkspaceStore.getState().undo();
        return;
      }

      if ((key === "z" && event.shiftKey) || key === "y") {
        if (activeAppWorkspace === "agent") return;
        event.preventDefault();
        if (activeAppWorkspace === "stage") useDirectorStore.getState().redo();
        else useDirectorCreativeWorkspaceStore.getState().redo();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeAppWorkspace]);

  return (
    <div
      className={`app-shell is-workspace-${activeAppWorkspace}${comfyUiEmbedded ? " is-comfyui-embedded" : ""}${timelineVisible ? " is-timeline-open" : ""}${workspaceLayout.frameless && activeAppWorkspace === "stage" ? " is-frameless" : ""}${rightPanelCollapsed ? " is-right-panel-collapsed" : ""}`}
      style={
        {
          "--left-sidebar-width": `${workspaceLayout.leftPanelWidth}px`,
          "--right-sidebar-width": `${visibleRightSidebarWidth}px`,
          "--left-sidebar-content-width": `${Math.max(0, workspaceLayout.leftPanelWidth - 40)}px`,
          "--right-sidebar-content-width": `${Math.max(0, visibleRightSidebarWidth - 40)}px`,
          "--timeline-panel-height": timelineVisible ? `${workspaceLayout.timelineHeight}px` : "0px",
        } as CSSProperties
      }
    >
      <header
        className={`top-bar grid ${
          rightPanelCollapsed
            ? "grid-cols-[var(--left-sidebar-width)_minmax(0,1fr)_auto]"
            : "grid-cols-[var(--left-sidebar-width)_minmax(0,1fr)_var(--right-sidebar-width)]"
        } items-center min-h-[70px] px-5 border-b border-border/[.24] bg-panel${comfyUiEmbedded ? " is-comfyui-embedded" : ""}`}
      >
        {!comfyUiEmbedded ? (
          <div className="top-bar-left flex items-center min-w-0">
            <h1 className="top-bar-title m-0 text-base font-semibold leading-[22px]">
              Director
              <span aria-hidden="true" className="top-bar-brand-signal" />
            </h1>
          </div>
        ) : null}
        {!comfyUiEmbedded ? (
          <nav aria-label={t("工作区")} className="top-bar-center top-workspace-tabs" role="tablist">
            {WORKSPACE_TABS.map(([mode, Icon, label], index) => (
              <button
                aria-controls="director-workspace-panel"
                aria-label={t(label)}
                aria-selected={activeAppWorkspace === mode}
                className={activeAppWorkspace === mode ? "is-active" : ""}
                id={`workspace-tab-${mode}`}
                key={mode}
                onClick={() => selectWorkspace(mode)}
                onKeyDown={(event) => handleWorkspaceTabKeyDown(event, index)}
                ref={(element) => {
                  workspaceTabRefs.current[index] = element;
                }}
                role="tab"
                tabIndex={activeAppWorkspace === mode ? 0 : -1}
                title={t(label)}
                type="button"
              >
                <Icon aria-hidden size={14} />
                <span>{t(label)}</span>
              </button>
            ))}
          </nav>
        ) : (
          <div aria-hidden="true" className="top-bar-center flex items-center justify-center min-w-0" />
        )}
        <div className="top-bar-actions flex items-center justify-end min-w-0 gap-2.5">
          <div className="top-bar-settings-cluster">
            {!comfyUiEmbedded ? (
              <Suspense fallback={null}>
                <DirectorInterchangeMenu workspace={creativeWorkspaceMode} />
              </Suspense>
            ) : null}
            <ViewportNavigationSettings
              blenderLive={
                activeAppWorkspace === "stage"
                  ? { visible: blenderLiveVisible, onVisibleChange: setBlenderLiveVisible }
                  : undefined
              }
            />
            <PerformanceSettings />
            {!comfyUiEmbedded ? <AgentWorkspaceSettings /> : null}
            <DirectorTaskTrayMenu />
            {!comfyUiEmbedded ? <HelpMenu /> : null}
            <EditorShortcuts workspace={creativeWorkspaceMode} />
            <button
              aria-label={t(theme === "dark" ? "切换到浅色模式" : "切换到深色模式")}
              aria-pressed={theme === "light"}
              className="top-bar-settings-trigger theme-switcher"
              onClick={() => applyDirectorTheme(theme === "dark" ? "light" : "dark", { persist: true })}
              title={t(theme === "dark" ? "切换到浅色模式" : "切换到深色模式")}
              type="button"
            >
              {theme === "dark" ? <Sun aria-hidden size={14} /> : <Moon aria-hidden size={14} />}
              <span className="top-bar-settings-label">{t(theme === "dark" ? "浅色" : "深色")}</span>
            </button>
            <label className="top-bar-settings-trigger language-switcher" title={t("界面语言")}>
              <Languages aria-hidden size={14} />
              <span className="sr-only">{t("界面语言")}</span>
              <select
                aria-label={t("界面语言")}
                value={locale}
                onChange={(event) => setLocale(event.currentTarget.value as typeof locale)}
              >
                <option value="zh-CN">{t("中文")}</option>
                <option value="en-US">English</option>
              </select>
              <ChevronDown aria-hidden className="top-bar-settings-chevron" size={12} />
            </label>
          </div>
        </div>
      </header>
      <main aria-labelledby={`workspace-tab-${activeAppWorkspace}`} id="director-workspace-panel" role="tabpanel">
        {activeAppWorkspace === "agent" ? (
          <RetryableWorkspace
            title="Agent 工作区加载失败"
            loadingLabel={t("正在加载 Agent…")}
            loader={loadAgentWorkspace}
          />
        ) : activeAppWorkspace === "canvas" ? (
          <RetryableWorkspace
            title="画布工作区加载失败"
            loadingLabel={t("正在加载画布…")}
            loader={loadCanvasWorkspace}
          />
        ) : activeAppWorkspace === "video" ? (
          <RetryableWorkspace
            title="视频编辑器加载失败"
            loadingLabel={t("正在加载视频编辑器…")}
            loader={loadVideoEditorWorkspace}
          />
        ) : (
          <RetryableWorkspace
            title="3D 片场加载失败"
            loadingLabel={t("正在加载3D 片场…")}
            loader={loadStageWorkspace}
            layout={workspaceLayout}
            setLayout={setWorkspaceLayout}
            timelineVisible={timelineVisible}
            blenderLiveVisible={blenderLiveVisible}
          />
        )}
      </main>
      {activeAppWorkspace !== "stage" && !captureHostNeeded ? (
        <Suspense fallback={null}>
          <BlenderProjectSyncBridge active />
        </Suspense>
      ) : null}
      {!comfyUiEmbedded && activeAppWorkspace !== "stage" && captureHostNeeded ? (
        <WorkspaceErrorBoundary title="片场截图视口加载失败">
          <Suspense fallback={null}>
            <StageCaptureHost />
          </Suspense>
        </WorkspaceErrorBoundary>
      ) : null}
      {activeAppWorkspace === "stage" &&
      timelineEnabled &&
      workspaceLayout.timelineCollapsed &&
      !workspaceLayout.frameless ? (
        <CollapsedTimelineSash
          restoredHeight={workspaceLayout.timelineHeight}
          onExpand={(timelineHeight) =>
            setWorkspaceLayout((current) => ({
              ...current,
              timelineCollapsed: false,
              timelineHeight,
            }))
          }
        />
      ) : null}
      {rightPanelCollapsed ? (
        <CollapsedRightPanelSash
          leftPanelWidth={workspaceLayout.leftPanelWidth}
          restoredWidth={workspaceLayout.rightPanelWidth}
          onExpand={(rightPanelWidth) =>
            setWorkspaceLayout((current) => ({
              ...current,
              rightPanelCollapsed: false,
              rightPanelWidth,
            }))
          }
        />
      ) : null}
      {activeAppWorkspace === "stage" && workspaceLayout.frameless ? (
        <button
          aria-label={t("退出极简无框模式")}
          className="workspace-frameless-exit"
          onClick={() => setWorkspaceLayout((current) => ({ ...current, frameless: false }))}
          type="button"
        >
          <Minimize2 aria-hidden size={16} />
          <span>{t("退出极简模式")}</span>
        </button>
      ) : null}
      <WelcomeGuide embedded={comfyUiEmbedded} />
      <GlobalTooltipLayer />
      <DirectorNotificationLayer />
    </div>
  );
}

/**
 * Director application root.
 *
 * Wraps the main {@link DirectorApp} component in a {@link LanguageProvider}
 * so that every descendant can access locale state and the translation
 * function without prop drilling.
 */
export default function App() {
  return (
    <LanguageProvider>
      <DirectorApp />
    </LanguageProvider>
  );
}
