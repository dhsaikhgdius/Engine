/**
 * 创意工作区面板调整器，提供可拖拽/键盘调整面板宽度的钩子和分隔条组件。
 *
 * @module creative-workspace-panel-resizer
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { installWindowPointerDrag } from "./windowPointerDrag";

/** 创意工作区面板标识，media 或 inspector。 */
export type CreativeWorkspacePanel = "media" | "inspector";

type CreativeWorkspacePanelWidths = Record<CreativeWorkspacePanel, number>;

const DEFAULT_PANEL_WIDTHS: CreativeWorkspacePanelWidths = {
  media: 248,
  inspector: 286,
};

const MIN_PANEL_WIDTHS: CreativeWorkspacePanelWidths = {
  media: 196,
  inspector: 220,
};

const MAX_PANEL_WIDTHS: CreativeWorkspacePanelWidths = {
  media: 420,
  inspector: 420,
};

function clampPanelWidth(panel: CreativeWorkspacePanel, width: number) {
  return Math.round(Math.min(MAX_PANEL_WIDTHS[panel], Math.max(MIN_PANEL_WIDTHS[panel], width)));
}

const PANEL_WIDTHS_STORAGE_KEY = "director.creative-panel-widths.v1";

function readStoredPanelWidths(): CreativeWorkspacePanelWidths {
  const widths = { ...DEFAULT_PANEL_WIDTHS };
  if (typeof window === "undefined") return widths;
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY);
    if (!raw) return widths;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return widths;
    for (const panel of Object.keys(widths) as CreativeWorkspacePanel[]) {
      const value = (stored as Partial<Record<CreativeWorkspacePanel, unknown>>)[panel];
      if (typeof value === "number" && Number.isFinite(value)) widths[panel] = clampPanelWidth(panel, value);
    }
    return widths;
  } catch {
    return { ...DEFAULT_PANEL_WIDTHS };
  }
}

/**
 * 创意工作区面板布局钩子，管理面板宽度状态、拖拽调整和键盘调整，并持久化到 localStorage。
 * @returns 包含 beginResize、resizeFromKeyboard、style 和 widths 的对象。
 */
export function useCreativeWorkspacePanelLayout() {
  const [widths, setWidths] = useState<CreativeWorkspacePanelWidths>(readStoredPanelWidths);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // Storage can be unavailable (private mode/quota); widths then stay session-local.
    }
  }, [widths]);

  function setPanelWidth(panel: CreativeWorkspacePanel, width: number) {
    setWidths((current) => ({ ...current, [panel]: clampPanelWidth(panel, width) }));
  }

  function beginResize(panel: CreativeWorkspacePanel, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanupRef.current?.();
    if (event.detail >= 2) {
      setPanelWidth(panel, DEFAULT_PANEL_WIDTHS[panel]);
      return;
    }
    const startX = event.clientX;
    const startWidth = widths[panel];
    const direction = panel === "media" ? 1 : -1;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function move(pointerEvent: PointerEvent) {
      setPanelWidth(panel, startWidth + (pointerEvent.clientX - startX) * direction);
    }

    installWindowPointerDrag(dragCleanupRef, move, () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    });
  }

  function resizeFromKeyboard(panel: CreativeWorkspacePanel, event: ReactKeyboardEvent<HTMLDivElement>) {
    const direction = panel === "media" ? 1 : -1;
    let nextWidth = widths[panel];
    if (event.key === "ArrowRight") nextWidth += 16 * direction;
    else if (event.key === "ArrowLeft") nextWidth -= 16 * direction;
    else if (event.key === "Home") nextWidth = MIN_PANEL_WIDTHS[panel];
    else if (event.key === "End") nextWidth = MAX_PANEL_WIDTHS[panel];
    else return;
    event.preventDefault();
    setPanelWidth(panel, nextWidth);
  }

  return {
    beginResize,
    resizeFromKeyboard,
    style: {
      "--creative-media-width": `${widths.media}px`,
      "--creative-inspector-width": `${widths.inspector}px`,
    } as CSSProperties,
    widths,
  };
}

/**
 * 渲染一个可拖拽和键盘操作的面板分隔条。
 * @param label - 无障碍标签。
 * @param onKeyDown - 键盘事件处理。
 * @param onPointerDown - 指针按下事件处理。
 * @param panel - 关联的面板标识。
 */
export function CreativeWorkspacePanelResizer({
  label,
  onKeyDown,
  onPointerDown,
  panel,
}: {
  label: string;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  panel: CreativeWorkspacePanel;
}) {
  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      className={`creative-workspace-panel-resizer is-${panel}`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex={0}
      title={label}
    />
  );
}
