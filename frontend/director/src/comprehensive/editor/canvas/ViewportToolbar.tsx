import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type MutableRefObject,
} from "react";
import {
  Box,
  Boxes,
  Camera,
  Crosshair,
  Expand,
  Footprints,
  Grid2X2,
  Grid3X3,
  Hand,
  ImagePlus,
  LassoSelect,
  LayoutGrid,
  Move3D,
  MousePointer2,
  Ratio,
  Redo2,
  Rotate3D,
  Scale3D,
  Tag,
  Undo2,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { requestViewportCapture } from "../io/captureBridge";
import { readLocalModelFile } from "../loaders/localModelImport";
import { applyEstimatedLocalModelSize } from "../loaders/localModelSize";
import { readPanoramaFile } from "../loaders/panoramaImport";
import { FLICK_HUMAN_DEFAULT_COLOR } from "../schema/flickHumanAppearance";
import { getModelLibraryItemSizeM } from "@director/dcc-interchange";
import { loadLocalFlickStageCatalog } from "../modelLibrary/flickPublicCatalog";
import { loadLocalMixamoCharacterCatalog } from "../modelLibrary/mixamoCharacterCatalog";
import { setModelLibraryDragData } from "../modelLibrary/modelLibraryDrag";
import {
  FLICK_STANDARD_CATEGORIES,
  filterModelLibraryItems,
  getFlickNativeModelLibraryItems,
  type FlickStandardCategoryId,
  type ModelLibraryItem,
} from "../modelLibrary/modelLibraryCatalog";
import { ModelLibraryThumb } from "../panels/ModelLibraryThumb";
import { VIEWPORT_ASPECT_RATIO_OPTIONS, type ViewportAspectRatio } from "@director/protocol/workbench-ui";
import {
  selectDirectorCanRedo,
  selectDirectorCanUndo,
  useDirectorStore,
  type CameraShotSnapshot,
  type TransformMode,
} from "../store/directorStore";

type ToolbarAction = {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  /** Hover explanation shown while the action is disabled. */
  disabledReason?: string;
  mode?: TransformMode;
  onClick: () => void;
};

const DEFAULT_VIEWPORT_TOOLBAR_HEIGHT = 46;
function waitForNextAnimationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function ViewportToolbar({
  bottomOffset = 0,
  getViewportCameraSnapshot,
  onToggleFrameless,
  onTogglePlayerMode,
  cameraPilotMode = false,
  onToggleCameraPilot,
  navigationMode = "hand",
  onNavigationModeChange,
  lassoSelectionDisabled = false,
  lassoSelectionEnabled = false,
  onLassoSelectionEnabledChange,
  assetActionsInSidebar = false,
  playerAvailable = true,
  playerMode = false,
  toolbarContainerRef,
}: {
  bottomOffset?: number;
  getViewportCameraSnapshot?: () => CameraShotSnapshot;
  onToggleFrameless?: () => void;
  onTogglePlayerMode?: () => void;
  cameraPilotMode?: boolean;
  onToggleCameraPilot?: () => void;
  navigationMode?: "hand" | "cursor";
  onNavigationModeChange?: (mode: "hand" | "cursor") => void;
  lassoSelectionDisabled?: boolean;
  lassoSelectionEnabled?: boolean;
  onLassoSelectionEnabledChange?: (enabled: boolean) => void;
  assetActionsInSidebar?: boolean;
  playerAvailable?: boolean;
  playerMode?: boolean;
  toolbarContainerRef?: MutableRefObject<HTMLDivElement | null>;
}) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const aspectRatioPanelRef = useRef<HTMLDivElement | null>(null);
  const modelLibraryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelLibraryPanelRef = useRef<HTMLDivElement | null>(null);
  const sceneLocalModelInputRef = useRef<HTMLInputElement | null>(null);
  const panoramaInputRef = useRef<HTMLInputElement | null>(null);
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);
  const [aspectRatioPanelOpen, setAspectRatioPanelOpen] = useState(false);
  const [toolbarHeight, setToolbarHeight] = useState(DEFAULT_VIEWPORT_TOOLBAR_HEIGHT);
  const [modelLibraryPanelStyle, setModelLibraryPanelStyle] = useState<CSSProperties>({});
  const [activeModelLibraryCategoryId, setActiveModelLibraryCategoryId] = useState<FlickStandardCategoryId>("all");
  const [flickLocalItems, setFlickLocalItems] = useState<ModelLibraryItem[]>([]);
  const [flickLocalCatalogStatus, setFlickLocalCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [flickLocalCatalogError, setFlickLocalCatalogError] = useState<string | null>(null);
  const [characterItems, setCharacterItems] = useState<ModelLibraryItem[]>([]);
  const [characterCatalogStatus, setCharacterCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [characterCatalogError, setCharacterCatalogError] = useState<string | null>(null);
  const [flickLocalQuery, setFlickLocalQuery] = useState("");
  const addImportedAsset = useDirectorStore((state) => state.addImportedAsset);
  const addObjectFromAsset = useDirectorStore((state) => state.addObjectFromAsset);
  const addPresetCharacter = useDirectorStore((state) => state.addPresetCharacter);
  const addGeometryPrimitive = useDirectorStore((state) => state.addGeometryPrimitive);
  const addCameraShot = useDirectorStore((state) => state.addCameraShot);
  const addCameraCaptures = useDirectorStore((state) => state.addCameraCaptures);
  const activeCameraId = useDirectorStore((state) => state.project.activeCameraId);
  const showLabels = useDirectorStore((state) => state.project.scene.showLabels);
  const updateScene = useDirectorStore((state) => state.updateScene);
  const transformMode = useDirectorStore((state) => state.transformMode);
  const viewportAspectRatio = useDirectorStore((state) => state.viewportAspectRatio);
  const viewportLayout = useDirectorStore((state) => state.viewportLayout);
  const setTransformMode = useDirectorStore((state) => state.setTransformMode);
  const setViewportAspectRatio = useDirectorStore((state) => state.setViewportAspectRatio);
  const toggleViewportLayout = useDirectorStore((state) => state.toggleViewportLayout);
  const canUndo = useDirectorStore(selectDirectorCanUndo);
  const canRedo = useDirectorStore(selectDirectorCanRedo);
  const undo = useDirectorStore((state) => state.undo);
  const redo = useDirectorStore((state) => state.redo);

  useEffect(() => {
    if (!modelLibraryOpen && !aspectRatioPanelOpen) return;

    function closeMenusOnOutsidePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && modelLibraryPanelRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && aspectRatioPanelRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && sceneLocalModelInputRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && panoramaInputRef.current?.contains(event.target)) return;

      setModelLibraryOpen(false);
      setAspectRatioPanelOpen(false);
    }

    function closeMenusOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setModelLibraryOpen(false);
      setAspectRatioPanelOpen(false);
    }

    document.addEventListener("pointerdown", closeMenusOnOutsidePointerDown);
    window.addEventListener("keydown", closeMenusOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeMenusOnOutsidePointerDown);
      window.removeEventListener("keydown", closeMenusOnEscape);
    };
  }, [aspectRatioPanelOpen, modelLibraryOpen]);

  useEffect(() => {
    if (viewportLayout !== "quad") return;
    setModelLibraryOpen(false);
    setAspectRatioPanelOpen(false);
  }, [viewportLayout]);

  useEffect(() => {
    if (!modelLibraryOpen) return;

    let cancelled = false;
    setFlickLocalCatalogStatus("loading");
    setFlickLocalCatalogError(null);
    setCharacterCatalogStatus("loading");
    setCharacterCatalogError(null);
    void loadLocalFlickStageCatalog()
      .then((items) => {
        if (cancelled) return;
        setFlickLocalItems(items);
        setFlickLocalCatalogStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setFlickLocalCatalogStatus("error");
        setFlickLocalCatalogError(error instanceof Error ? error.message : "本地模型目录读取失败");
      });
    void loadLocalMixamoCharacterCatalog()
      .then((items) => {
        if (cancelled) return;
        setCharacterItems(items);
        setCharacterCatalogStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setCharacterCatalogStatus("error");
        setCharacterCatalogError(error instanceof Error ? error.message : "人物目录读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [modelLibraryOpen]);

  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;

    const updateHeight = () => {
      const nextHeight = Math.max(element.offsetHeight, DEFAULT_VIEWPORT_TOOLBAR_HEIGHT);
      setToolbarHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => {
        window.removeEventListener("resize", updateHeight);
      };
    }

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(element);
    window.addEventListener("resize", updateHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  useLayoutEffect(() => {
    const toolbarElement = toolbarRef.current;
    const frameElement = toolbarElement?.parentElement;
    if (!toolbarElement || !frameElement) return;

    const updateFloatingPositions = () => {
      const frameRect = frameElement.getBoundingClientRect();

      if (modelLibraryOpen) {
        const toolbarRect = toolbarElement.getBoundingClientRect();
        setModelLibraryPanelStyle({
          left: `${toolbarRect.left - frameRect.left + toolbarRect.width / 2}px`,
          bottom: `${frameRect.bottom - toolbarRect.top + 10}px`,
        });
      }
    };

    updateFloatingPositions();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateFloatingPositions);
      return () => {
        window.removeEventListener("resize", updateFloatingPositions);
      };
    }

    const resizeObserver = new ResizeObserver(updateFloatingPositions);
    resizeObserver.observe(frameElement);
    resizeObserver.observe(toolbarElement);
    if (modelLibraryTriggerRef.current) {
      resizeObserver.observe(modelLibraryTriggerRef.current);
    }
    window.addEventListener("resize", updateFloatingPositions);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateFloatingPositions);
    };
  }, [modelLibraryOpen]);

  async function handleLocalModelChange(event: ChangeEvent<HTMLInputElement>, addToScene: boolean) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;

    try {
      for (const file of files) {
        const result = await readLocalModelFile(file);
        const assetId = addImportedAsset({
          kind: "prop",
          ...result,
          addToScene,
          assetSource: "local",
        });
        applyEstimatedLocalModelSize(assetId, result.name);
      }
    } catch {
      // The toolbar keeps file actions quiet; detailed import feedback lives in the side panel.
    } finally {
      input.value = "";
    }
  }

  async function handlePanoramaChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const result = await readPanoramaFile(file);
      addImportedAsset({ kind: "panorama", ...result });
    } catch {
      // The toolbar keeps file actions quiet; detailed import feedback lives in the side panel.
    } finally {
      input.value = "";
    }
  }

  async function handleCapture(preset: "current" | "four" | "twelve") {
    try {
      // Capture creates an explicit camera from the editor framing without
      // replacing the Stage with a full-screen camera-view mode.
      const targetCameraId = addCameraShot(getViewportCameraSnapshot?.()) ?? activeCameraId;
      if (!targetCameraId) return;

      await waitForNextAnimationFrame();

      const results = await requestViewportCapture({
        preset,
        source: "camera-panel",
        cameraId: targetCameraId,
      });
      addCameraCaptures(
        targetCameraId,
        results.map((result) => result.dataUrl),
      );
    } catch {
      // Keep the capsule toolbar icon-only and free of transient status text.
    }
  }

  function selectTransformMode(mode: TransformMode) {
    onLassoSelectionEnabledChange?.(false);
    setTransformMode(mode);
  }

  function selectNavigationMode(mode: "hand" | "cursor") {
    onLassoSelectionEnabledChange?.(false);
    onNavigationModeChange?.(mode);
  }

  function toggleModelLibrary() {
    setModelLibraryOpen((isOpen) => !isOpen);
    setAspectRatioPanelOpen(false);
  }

  function addModelLibraryItem(item: ModelLibraryItem) {
    if (item.nativeAction === "add-human") {
      addPresetCharacter(undefined, FLICK_HUMAN_DEFAULT_COLOR);
      setModelLibraryOpen(false);
      return;
    }
    if (item.nativeAction === "add-camera") {
      addCameraShot(getViewportCameraSnapshot?.());
      setModelLibraryOpen(false);
      return;
    }
    if (item.nativeAction === "add-cube") {
      addGeometryPrimitive("box");
      setModelLibraryOpen(false);
      return;
    }
    if (item.nativeAction === "add-sphere") {
      addGeometryPrimitive("sphere");
      setModelLibraryOpen(false);
      return;
    }

    const existingAsset = useDirectorStore
      .getState()
      .project.assets.find(
        (asset) =>
          asset.sourceType === "model" &&
          asset.assetSource === (item.assetSource ?? "library") &&
          asset.kind === (item.kind ?? "prop") &&
          asset.url === item.url,
      );
    if (existingAsset) {
      addObjectFromAsset(existingAsset.id);
      setModelLibraryOpen(false);
      return;
    }

    const catalogSizeM = getModelLibraryItemSizeM(item);
    addImportedAsset({
      id: item.id,
      kind: item.kind ?? "prop",
      assetSource: item.assetSource ?? "library",
      fileName: item.fileName,
      name: item.name,
      url: item.url,
      characterMetadata: item.characterMetadata,
      realWorldSizeM: catalogSizeM,
      sizeSource: catalogSizeM === undefined ? undefined : "catalog",
    });
    setModelLibraryOpen(false);
  }

  function addCameraFromViewport() {
    const snapshot = getViewportCameraSnapshot?.();
    addCameraShot(snapshot);
  }

  function toggleAspectRatioPanel() {
    setAspectRatioPanelOpen((isOpen) => !isOpen);
    setModelLibraryOpen(false);
  }

  function selectAspectRatio(ratio: ViewportAspectRatio) {
    setViewportAspectRatio(ratio);
    setAspectRatioPanelOpen(false);
  }

  const assetActions: ToolbarAction[] = [
    { label: "导入全景图", icon: ImagePlus, onClick: () => panoramaInputRef.current?.click() },
    {
      label: "导入本地模型",
      icon: Box,
      onClick: () => {
        sceneLocalModelInputRef.current?.click();
      },
    },
    { label: "模型库", icon: Boxes, onClick: toggleModelLibrary },
  ];
  const actions: ToolbarAction[] = [
    {
      label: "撤销",
      icon: Undo2,
      disabled: !canUndo,
      disabledReason: "没有可撤销的操作",
      onClick: undo,
    },
    {
      label: "重做",
      icon: Redo2,
      disabled: !canRedo,
      disabledReason: "没有可重做的操作",
      onClick: redo,
    },
    {
      label: "套索选择",
      icon: LassoSelect,
      active: lassoSelectionEnabled,
      disabled: playerMode || lassoSelectionDisabled,
      onClick: () => onLassoSelectionEnabledChange?.(!lassoSelectionEnabled),
    },
    {
      label: "移动",
      icon: Move3D,
      mode: "translate",
      disabled: playerMode || cameraPilotMode,
      onClick: () => selectTransformMode("translate"),
    },
    {
      label: "旋转",
      icon: Rotate3D,
      mode: "rotate",
      disabled: playerMode || cameraPilotMode,
      onClick: () => selectTransformMode("rotate"),
    },
    {
      label: "缩放",
      icon: Scale3D,
      mode: "scale",
      disabled: playerMode || cameraPilotMode,
      onClick: () => selectTransformMode("scale"),
    },
    {
      label: "手型浏览",
      icon: Hand,
      active: !playerMode && !cameraPilotMode && !lassoSelectionEnabled && navigationMode === "hand",
      disabled: playerMode || cameraPilotMode,
      onClick: () => selectNavigationMode("hand"),
    },
    {
      label: "游标浏览",
      icon: MousePointer2,
      active: !playerMode && !cameraPilotMode && !lassoSelectionEnabled && navigationMode === "cursor",
      disabled: playerMode || cameraPilotMode,
      onClick: () => selectNavigationMode("cursor"),
    },
    {
      label: playerMode ? "退出角色漫游" : "角色漫游",
      icon: Footprints,
      active: playerMode,
      disabled: cameraPilotMode || !playerAvailable,
      disabledReason: cameraPilotMode ? "掌镜时不可漫游" : "场景中没有可漫游的角色",
      onClick: () => onTogglePlayerMode?.(),
    },
    {
      label: cameraPilotMode ? "退出掌镜" : "开始掌镜",
      icon: Crosshair,
      active: cameraPilotMode,
      disabled: playerMode,
      onClick: () => onToggleCameraPilot?.(),
    },
    ...(assetActionsInSidebar ? [] : assetActions),
    { label: "添加机位", icon: Video, onClick: addCameraFromViewport },
    { label: "选择画幅比例", icon: Ratio, onClick: toggleAspectRatioPanel },
    {
      label: "视口标签",
      icon: Tag,
      active: showLabels,
      onClick: () => updateScene({ showLabels: !showLabels }),
    },
    {
      label: viewportLayout === "quad" ? "退出四视图" : "四视图",
      icon: LayoutGrid,
      active: viewportLayout === "quad",
      disabled: playerMode || cameraPilotMode,
      onClick: toggleViewportLayout,
    },
    { label: "当前视角截图", icon: Camera, onClick: () => void handleCapture("current") },
    { label: "四方位截图", icon: Grid2X2, onClick: () => void handleCapture("four") },
    { label: "十二方位截图", icon: Grid3X3, onClick: () => void handleCapture("twelve") },
    { label: "全屏", icon: Expand, onClick: () => onToggleFrameless?.() },
  ];
  const visibleActions =
    viewportLayout === "quad"
      ? actions.filter((action) => ["退出四视图", "视口标签", "四方位截图", "全屏"].includes(action.label))
      : actions;

  function renderActionButton(action: ToolbarAction) {
    const Icon = action.icon;
    const active =
      !action.disabled &&
      (action.mode ? !lassoSelectionEnabled && transformMode === action.mode : Boolean(action.active));

    return (
      <button
        key={action.label}
        aria-label={action.label}
        aria-pressed={action.mode || action.active !== undefined ? active : undefined}
        className={`ui-icon-button viewport-toolbar-button${active ? " is-active" : ""}`}
        disabled={action.disabled}
        title={action.disabled && action.disabledReason ? action.disabledReason : undefined}
        type="button"
        onClick={action.onClick}
      >
        <Icon aria-hidden="true" size={17} strokeWidth={1.9} />
        <span className="viewport-toolbar-label">{action.label}</span>
      </button>
    );
  }

  const activeModelLibraryItems = filterModelLibraryItems(
    [...getFlickNativeModelLibraryItems(), ...characterItems, ...flickLocalItems],
    activeModelLibraryCategoryId,
    flickLocalQuery,
  );
  const modelCatalogUnavailable = flickLocalCatalogStatus === "error" && characterCatalogStatus === "error";
  const modelCatalogReady = flickLocalCatalogStatus === "ready" || characterCatalogStatus === "ready";
  const modelCatalogLoading = flickLocalCatalogStatus === "loading" || characterCatalogStatus === "loading";
  const localModelLibraryItemCount = flickLocalItems.length + characterItems.length;
  function setToolbarElement(element: HTMLDivElement | null) {
    toolbarRef.current = element;
    if (toolbarContainerRef) {
      toolbarContainerRef.current = element;
    }
  }

  const viewportToolbarStyle = {
    "--viewport-bottom-offset": `${bottomOffset}px`,
  } as CSSProperties;

  const aspectRatioPanelStyle = {
    "--viewport-bottom-offset": `${bottomOffset}px`,
    "--viewport-toolbar-height": `${toolbarHeight}px`,
  } as CSSProperties;

  return (
    <>
      <div
        className={`viewport-toolbar${viewportLayout === "quad" ? " is-quad-view" : ""}`}
        role="group"
        aria-label="3D视口快捷工具"
        ref={setToolbarElement}
        style={viewportToolbarStyle}
      >
        {visibleActions.map((action) => {
          if (action.label !== "模型库") {
            return renderActionButton(action);
          }

          const Icon = action.icon;

          return (
            <button
              key={action.label}
              aria-label={action.label}
              className="ui-icon-button viewport-toolbar-button"
              ref={modelLibraryTriggerRef}
              type="button"
              onClick={action.onClick}
            >
              <Icon aria-hidden="true" size={17} strokeWidth={1.9} />
              <span className="viewport-toolbar-label">{action.label}</span>
            </button>
          );
        })}
      </div>
      {modelLibraryOpen ? (
        <div
          ref={modelLibraryPanelRef}
          className="model-library-panel"
          role="dialog"
          aria-label="模型库"
          style={modelLibraryPanelStyle}
        >
          <div className="model-library-header">
            <h2 className="model-library-title">模型库</h2>
            <button
              aria-label="关闭模型库"
              className="top-bar-action-button model-library-close-button"
              type="button"
              onClick={() => setModelLibraryOpen(false)}
            >
              <X aria-hidden="true" size={16} strokeWidth={1.8} />
            </button>
          </div>
          <div className="model-library-tabs" role="tablist" aria-label="模型分类">
            {FLICK_STANDARD_CATEGORIES.map((category) => {
              const active = category.id === activeModelLibraryCategoryId;

              return (
                <button
                  key={category.id}
                  aria-selected={active}
                  className={`model-library-tab${active ? " is-active" : ""}`}
                  role="tab"
                  type="button"
                  onClick={() => setActiveModelLibraryCategoryId(category.id)}
                >
                  {category.label}
                </button>
              );
            })}
          </div>
          {modelCatalogLoading && !modelCatalogReady && activeModelLibraryItems.length === 0 ? (
            <div
              className="model-library-empty-state object-search-empty-state"
              role="status"
              aria-label="正在读取本地模型"
            >
              <span>正在读取本地模型目录…</span>
            </div>
          ) : modelCatalogUnavailable ? (
            <div
              className="model-library-empty-state object-search-empty-state"
              role="status"
              aria-label="本地模型目录不可用"
            >
              <span>本地模型目录不可用</span>
              <small>
                {[flickLocalCatalogError, characterCatalogError].filter(Boolean).join("；") ||
                  "请检查本地模型资源后重试。"}
              </small>
            </div>
          ) : (
            <>
              <div className="flick-local-catalog-controls">
                <label>
                  <span>本地 {localModelLibraryItemCount} 个组件</span>
                  <input
                    aria-label="搜索本地模型"
                    className="ui-field"
                    placeholder="搜索组件"
                    type="search"
                    value={flickLocalQuery}
                    onChange={(event) => setFlickLocalQuery(event.currentTarget.value)}
                  />
                </label>
                <small>分类与 Stage 组件保持一致；场景仅引用本地 GLB。</small>
              </div>
              <div className="model-library-grid model-library-grid-flick" role="list" aria-label="模型列表">
                {activeModelLibraryItems.map((item) => (
                  <button
                    key={item.id}
                    aria-label={`添加模型 ${item.name}`}
                    className="model-library-card"
                    draggable
                    type="button"
                    onDragStart={(event) => setModelLibraryDragData(event, item)}
                    onClick={() => addModelLibraryItem(item)}
                  >
                    <ModelLibraryThumb item={item} iconSize={24} name={item.name} thumbnailUrl={item.thumbnailUrl} />
                    <span className="model-library-name" data-i18n-user-content>
                      {item.name}
                    </span>
                  </button>
                ))}
                {!activeModelLibraryItems.length && modelCatalogReady ? (
                  <p className="flick-local-no-results">此分类暂无匹配组件。</p>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
      {aspectRatioPanelOpen ? (
        <div
          ref={aspectRatioPanelRef}
          className="viewport-aspect-panel"
          role="dialog"
          aria-label="比例"
          style={aspectRatioPanelStyle}
        >
          <h2 className="viewport-aspect-panel-title">比例</h2>
          <div className="viewport-aspect-panel-grid" role="group" aria-label="画幅比例选项">
            {VIEWPORT_ASPECT_RATIO_OPTIONS.map((option) => {
              const active = option.id === viewportAspectRatio;
              const frameClassName = `viewport-aspect-option-frame viewport-aspect-option-frame-${option.id.replace(":", "-")}`;

              return (
                <button
                  key={option.id}
                  aria-pressed={active}
                  className={`viewport-aspect-option${active ? " is-active" : ""}`}
                  type="button"
                  onClick={() => selectAspectRatio(option.id)}
                >
                  <span className={frameClassName} aria-hidden="true" />
                  <span className="viewport-aspect-option-label">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <input
        ref={panoramaInputRef}
        aria-hidden="true"
        className="hidden-file-input"
        tabIndex={-1}
        accept=".jpg,.jpeg,.png,.webp"
        type="file"
        onChange={(event) => void handlePanoramaChange(event)}
      />
      <input
        ref={sceneLocalModelInputRef}
        aria-hidden="true"
        className="hidden-file-input"
        data-testid="scene-local-model-input"
        tabIndex={-1}
        accept=".fbx,.obj,.glb,.gltf,.ply,.splat,.ksplat,.spz,.sog,.zip"
        type="file"
        onChange={(event) => void handleLocalModelChange(event, true)}
      />
    </>
  );
}
