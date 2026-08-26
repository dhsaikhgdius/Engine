/**
 * Full-bleed workspace shell with draggable left and right sidebars and a central 3D viewport.
 *
 * @module DirectorDeskShell
 */

import {
  useEffect,
  useRef,
  lazy,
  Suspense,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Box, FolderOpen, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { ObjectTreePanel } from "../../editor/panels/ObjectTreePanel";
import { RightPanel } from "../../editor/panels/RightPanel";
import { BlenderLivePanel } from "../../editor/interchange/BlenderLivePanel";
import { useLanguage } from "../../i18n/language";
import {
  clampWorkspaceSize,
  MAX_LEFT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_DIRECTOR_VIEWPORT_WIDTH,
  MIN_LEFT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  PANEL_SASH_CLICK_DRAG_THRESHOLD_PX,
  RIGHT_PANEL_COLLAPSE_OVERDRAG_PX,
  normalizeRightPanelMode,
  type DirectorWorkspaceLayout,
  type RightPanelMode,
} from "./workspaceLayout";
import { createAnimationFrameScheduler } from "./animationFrameScheduler";

const AssetLibraryPanel = lazy(async () => {
  const module = await import("../../editor/panels/AssetLibraryPanel");
  return { default: module.AssetLibraryPanel };
});

const RIGHT_PANEL_MODE_ITEMS: Array<{
  mode: RightPanelMode;
  icon: LucideIcon;
  label: (translate: (key: string) => string) => string;
  title?: (translate: (key: string) => string) => string;
}> = [
  { mode: "properties", icon: SlidersHorizontal, label: (translate) => translate("属性") },
  { mode: "modeling", icon: Box, label: (translate) => translate("Blender") },
  { mode: "assets", icon: FolderOpen, label: (translate) => translate("资源") },
];

/**
 * Renders the main workspace layout: a central 3D viewport flanked by a left object-tree
 * sidebar and a multi-mode right panel, with draggable resizers.
 */
export function DirectorDeskShell({
  children,
  layout,
  setLayout,
}: {
  children: ReactNode;
  layout: DirectorWorkspaceLayout;
  setLayout: Dispatch<SetStateAction<DirectorWorkspaceLayout>>;
}) {
  const { t } = useLanguage();
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    setLayout((current) => {
      const rightPanelMode = normalizeRightPanelMode(current.rightPanelMode);
      return rightPanelMode === current.rightPanelMode ? current : { ...current, rightPanelMode };
    });
  }, [setLayout]);

  useEffect(() => {
    function keepPanelsInsideViewport() {
      setLayout((current) => {
        if (current.frameless) return current;
        const rightPanelWidth = current.rightPanelCollapsed
          ? current.rightPanelWidth
          : clampWorkspaceSize(current.rightPanelWidth, MIN_RIGHT_PANEL_WIDTH, getMaximumPanelWidth("right", current));
        const withClampedRight = { ...current, rightPanelWidth };
        const leftPanelWidth = clampWorkspaceSize(
          current.leftPanelWidth,
          MIN_LEFT_PANEL_WIDTH,
          getMaximumPanelWidth("left", withClampedRight),
        );
        if (rightPanelWidth === current.rightPanelWidth && leftPanelWidth === current.leftPanelWidth) return current;
        return { ...current, leftPanelWidth, rightPanelWidth };
      });
    }

    keepPanelsInsideViewport();
    window.addEventListener("resize", keepPanelsInsideViewport);
    return () => window.removeEventListener("resize", keepPanelsInsideViewport);
  }, [layout.rightPanelCollapsed, setLayout]);

  function getMaximumPanelWidth(side: "left" | "right", current: DirectorWorkspaceLayout) {
    const configuredMaximum = side === "left" ? MAX_LEFT_PANEL_WIDTH : MAX_RIGHT_PANEL_WIDTH;
    const minimum = side === "left" ? MIN_LEFT_PANEL_WIDTH : MIN_RIGHT_PANEL_WIDTH;
    const oppositeWidth =
      side === "left"
        ? current.frameless || current.rightPanelCollapsed
          ? 0
          : current.rightPanelWidth
        : current.frameless
          ? 0
          : current.leftPanelWidth;
    const viewportMaximum =
      typeof window === "undefined"
        ? configuredMaximum
        : window.innerWidth - oppositeWidth - MIN_DIRECTOR_VIEWPORT_WIDTH;
    return Math.max(minimum, Math.min(configuredMaximum, Math.round(viewportMaximum)));
  }

  function beginPanelResize(event: ReactPointerEvent<HTMLDivElement>, side: "left" | "right") {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? layout.leftPanelWidth : layout.rightPanelWidth;
    let collapseOnRelease = false;
    let dragged = false;
    const widthScheduler = createAnimationFrameScheduler<number>((nextWidth) => {
      setLayout((current) => {
        const currentWidth = side === "left" ? current.leftPanelWidth : current.rightPanelWidth;
        if (currentWidth === nextWidth) return current;
        return side === "left" ? { ...current, leftPanelWidth: nextWidth } : { ...current, rightPanelWidth: nextWidth };
      });
    });

    function detach() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      dragCleanupRef.current = null;
    }

    function cleanup(flush = true) {
      if (flush) widthScheduler.flush();
      else widthScheduler.cancel();
      detach();
    }

    function move(pointerEvent: PointerEvent) {
      const delta = side === "left" ? pointerEvent.clientX - startX : startX - pointerEvent.clientX;
      if (Math.abs(pointerEvent.clientX - startX) >= PANEL_SASH_CLICK_DRAG_THRESHOLD_PX) dragged = true;
      const rawWidth = startWidth + delta;
      if (side === "right") {
        collapseOnRelease = rawWidth < MIN_RIGHT_PANEL_WIDTH - RIGHT_PANEL_COLLAPSE_OVERDRAG_PX;
      }
      const nextWidth = clampWorkspaceSize(
        rawWidth,
        side === "left" ? MIN_LEFT_PANEL_WIDTH : MIN_RIGHT_PANEL_WIDTH,
        getMaximumPanelWidth(side, layout),
      );
      widthScheduler.schedule(nextWidth);
    }

    const handlePointerUp = () => {
      if (side === "right" && (!dragged || collapseOnRelease)) {
        widthScheduler.cancel();
        setLayout((current) => ({
          ...current,
          rightPanelWidth: startWidth,
          rightPanelCollapsed: true,
        }));
        detach();
        return;
      }
      cleanup(true);
    };
    const handlePointerCancel = () => cleanup(false);

    dragCleanupRef.current?.();
    dragCleanupRef.current = () => cleanup(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerCancel, { once: true });
  }

  const panelsHidden = layout.frameless;
  const rightPanelHidden = panelsHidden || layout.rightPanelCollapsed;

  function selectRightPanelMode(mode: RightPanelMode) {
    setLayout((current) => (mode === current.rightPanelMode ? current : { ...current, rightPanelMode: mode }));
  }

  function resizePanelFromKeyboard(event: ReactKeyboardEvent<HTMLDivElement>, side: "left" | "right") {
    const minimum = side === "left" ? MIN_LEFT_PANEL_WIDTH : MIN_RIGHT_PANEL_WIDTH;
    const maximum = getMaximumPanelWidth(side, layout);
    const currentWidth = side === "left" ? layout.leftPanelWidth : layout.rightPanelWidth;
    if (side === "right" && event.key === "ArrowRight" && currentWidth <= MIN_RIGHT_PANEL_WIDTH) {
      event.preventDefault();
      setLayout((current) => ({ ...current, rightPanelCollapsed: true }));
      return;
    }
    let nextWidth = currentWidth;
    if (event.key === "Home") nextWidth = minimum;
    else if (event.key === "End") nextWidth = maximum;
    else if (event.key === "ArrowLeft") nextWidth += side === "left" ? -12 : 12;
    else if (event.key === "ArrowRight") nextWidth += side === "left" ? 12 : -12;
    else return;
    event.preventDefault();
    const clamped = clampWorkspaceSize(nextWidth, minimum, maximum);
    setLayout((current) =>
      side === "left" ? { ...current, leftPanelWidth: clamped } : { ...current, rightPanelWidth: clamped },
    );
  }

  return (
    <div className={`director-shell director-shell-fullbleed${layout.frameless ? " is-frameless" : ""}`}>
      <section className="viewport-column" aria-label="3D视口">
        {children}
      </section>
      <aside
        className="left-sidebar director-sidebar"
        aria-hidden={panelsHidden ? "true" : undefined}
        aria-label="场景"
      >
        <ObjectTreePanel
          onSceneSettingsOpen={() =>
            setLayout((current) => ({
              ...current,
              rightPanelCollapsed: false,
              rightPanelMode: "properties",
            }))
          }
        />
      </aside>
      {!panelsHidden ? (
        <div
          aria-label="调整场景面板宽度"
          aria-orientation="vertical"
          aria-valuemax={getMaximumPanelWidth("left", layout)}
          aria-valuemin={MIN_LEFT_PANEL_WIDTH}
          aria-valuenow={layout.leftPanelWidth}
          className="workspace-panel-resizer is-left"
          onKeyDown={(event) => resizePanelFromKeyboard(event, "left")}
          onPointerDown={(event) => beginPanelResize(event, "left")}
          role="separator"
          tabIndex={0}
        />
      ) : null}
      <aside
        className="right-sidebar director-sidebar"
        aria-hidden={rightPanelHidden ? "true" : undefined}
        aria-label={t("属性")}
        hidden={layout.rightPanelCollapsed || undefined}
      >
        <div className="right-sidebar-chrome">
          <div
            className="right-sidebar-mode-toggle"
            role="tablist"
            aria-label="右侧面板模式"
            style={
              {
                "--mode-tab-count": RIGHT_PANEL_MODE_ITEMS.length,
                "--mode-tab-index": Math.max(
                  0,
                  RIGHT_PANEL_MODE_ITEMS.findIndex(({ mode }) => mode === layout.rightPanelMode),
                ),
              } as CSSProperties
            }
          >
            {RIGHT_PANEL_MODE_ITEMS.map(({ mode, icon: Icon, label, title }) => {
              const tabLabel = label(t);
              return (
                <button
                  key={mode}
                  role="tab"
                  type="button"
                  aria-selected={layout.rightPanelMode === mode}
                  className={`right-sidebar-mode-tab${layout.rightPanelMode === mode ? " is-active" : ""}`}
                  onClick={() => selectRightPanelMode(mode)}
                  title={title?.(t) ?? tabLabel}
                >
                  <Icon aria-hidden size={15} />
                  <span className="right-sidebar-mode-tab-label">{tabLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="right-sidebar-body">
          {layout.rightPanelMode === "modeling" ? (
            <BlenderLivePanel />
          ) : layout.rightPanelMode === "assets" ? (
            <Suspense fallback={null}>
              <AssetLibraryPanel />
            </Suspense>
          ) : (
            <RightPanel />
          )}
        </div>
      </aside>
      {!rightPanelHidden ? (
        <div
          aria-label={t("调整属性面板宽度")}
          aria-orientation="vertical"
          aria-valuemax={getMaximumPanelWidth("right", layout)}
          aria-valuemin={MIN_RIGHT_PANEL_WIDTH}
          aria-valuenow={layout.rightPanelWidth}
          className="workspace-panel-resizer is-right"
          onKeyDown={(event) => resizePanelFromKeyboard(event, "right")}
          onPointerDown={(event) => beginPanelResize(event, "right")}
          role="separator"
          tabIndex={0}
          title={t("点击或拉回收起右侧栏")}
        />
      ) : null}
    </div>
  );
}
