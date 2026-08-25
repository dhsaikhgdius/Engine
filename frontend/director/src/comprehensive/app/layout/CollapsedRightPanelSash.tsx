/**
 * A narrow sash bar that lets the user pull or click to expand the collapsed right panel.
 *
 * @module CollapsedRightPanelSash
 */

import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useLanguage } from "../../i18n/language";
import { createAnimationFrameScheduler } from "./animationFrameScheduler";
import {
  clampWorkspaceSize,
  getMaximumRightPanelWidth,
  MIN_RIGHT_PANEL_WIDTH,
  PANEL_SASH_CLICK_DRAG_THRESHOLD_PX,
} from "./workspaceLayout";

/**
 * Renders a draggable sash to expand the right panel from its collapsed state.
 */
export function CollapsedRightPanelSash({
  leftPanelWidth,
  restoredWidth,
  onExpand,
}: {
  leftPanelWidth: number;
  restoredWidth: number;
  onExpand: (width: number) => void;
}) {
  const { t } = useLanguage();
  const dragCleanupRef = useRef<(() => void) | null>(null);

  function expandTo(width: number) {
    const maximum = getMaximumRightPanelWidth(window.innerWidth, leftPanelWidth);
    onExpand(clampWorkspaceSize(width, MIN_RIGHT_PANEL_WIDTH, maximum));
  }

  function beginPull(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    let pulledFarEnough = false;
    const widthScheduler = createAnimationFrameScheduler<number>(expandTo);

    function cleanup(flush: boolean) {
      if (flush) widthScheduler.flush();
      else widthScheduler.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      dragCleanupRef.current = null;
    }

    function move(pointerEvent: PointerEvent) {
      const pulled = startX - pointerEvent.clientX;
      if (!pulledFarEnough && pulled < PANEL_SASH_CLICK_DRAG_THRESHOLD_PX) return;
      pulledFarEnough = true;
      widthScheduler.schedule(Math.max(pulled, MIN_RIGHT_PANEL_WIDTH));
    }

    const handlePointerUp = () => {
      if (!pulledFarEnough) expandTo(restoredWidth);
      cleanup(true);
    };
    const handlePointerCancel = () => cleanup(false);

    dragCleanupRef.current?.();
    dragCleanupRef.current = () => cleanup(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerCancel, { once: true });
  }

  function expandFromKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowLeft") return;
    event.preventDefault();
    expandTo(event.key === "ArrowLeft" ? restoredWidth + 16 : restoredWidth);
  }

  return (
    <div
      aria-label={t("展开右侧栏")}
      aria-orientation="vertical"
      className="workspace-right-panel-sash"
      onKeyDown={expandFromKeyboard}
      onPointerDown={beginPull}
      role="separator"
      tabIndex={0}
      title={t("拉开展开右侧栏")}
    />
  );
}
