/**
 * A narrow sash bar that lets the user pull or click to expand the collapsed timeline panel.
 *
 * @module CollapsedTimelineSash
 */

import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useLanguage } from "../../i18n/language";
import { createAnimationFrameScheduler } from "./animationFrameScheduler";
import {
  clampWorkspaceSize,
  getMaximumTimelineHeight,
  MIN_TIMELINE_HEIGHT,
  PANEL_SASH_CLICK_DRAG_THRESHOLD_PX,
} from "./workspaceLayout";

/**
 * Renders a draggable sash to expand the timeline panel from its collapsed state.
 */
export function CollapsedTimelineSash({
  restoredHeight,
  onExpand,
}: {
  restoredHeight: number;
  onExpand: (height: number) => void;
}) {
  const { t } = useLanguage();
  const dragCleanupRef = useRef<(() => void) | null>(null);

  function expandTo(height: number) {
    const maximum = getMaximumTimelineHeight(window.innerHeight);
    onExpand(clampWorkspaceSize(height, MIN_TIMELINE_HEIGHT, maximum));
  }

  function beginPull(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    let pulledFarEnough = false;
    const heightScheduler = createAnimationFrameScheduler<number>(expandTo);

    function cleanup(flush: boolean) {
      if (flush) heightScheduler.flush();
      else heightScheduler.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      dragCleanupRef.current = null;
    }

    function move(pointerEvent: PointerEvent) {
      const pulled = startY - pointerEvent.clientY;
      if (!pulledFarEnough && pulled < PANEL_SASH_CLICK_DRAG_THRESHOLD_PX) return;
      pulledFarEnough = true;
      heightScheduler.schedule(Math.max(pulled, MIN_TIMELINE_HEIGHT));
    }

    const handlePointerUp = () => {
      if (!pulledFarEnough) expandTo(restoredHeight);
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
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowUp") return;
    event.preventDefault();
    expandTo(event.key === "ArrowUp" ? restoredHeight + 16 : restoredHeight);
  }

  return (
    <div
      aria-label={t("展开下方栏")}
      aria-orientation="horizontal"
      className="workspace-timeline-sash"
      onKeyDown={expandFromKeyboard}
      onPointerDown={beginPull}
      role="separator"
      tabIndex={0}
      title={t("上拉展开下方栏")}
    />
  );
}
