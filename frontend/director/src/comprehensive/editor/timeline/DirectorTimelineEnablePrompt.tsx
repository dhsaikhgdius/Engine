/**
 * @module DirectorTimelineEnablePrompt
 * @description One-shot prompt banner shown when a legacy scene has no frame
 *   timeline, offering a single-click enable action.
 */

import type { CSSProperties } from "react";

export function DirectorTimelineEnablePrompt({ bottom, onEnable }: { bottom: number; onEnable: () => void }) {
  return (
    <section
      aria-label="场景动画时间轴"
      className="director-timeline-enable-prompt"
      style={{ "--director-timeline-bottom": `${bottom}px` } as CSSProperties}
    >
      <span>此旧场景尚未启用帧时间轴</span>
      <button onClick={onEnable} type="button">
        启用时间轴（0–240 帧 / 24 FPS）
      </button>
    </section>
  );
}
