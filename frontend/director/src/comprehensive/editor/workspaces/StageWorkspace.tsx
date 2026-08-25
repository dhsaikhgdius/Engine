/**
 * Stage 工作区页面，在 DirectorDeskShell 中渲染 3D 画布。
 *
 * @module stage-workspace
 */

import type { Dispatch, SetStateAction } from "react";
import { DirectorDeskShell } from "../../app/layout/DirectorDeskShell";
import type { DirectorWorkspaceLayout } from "../../app/layout/workspaceLayout";
import { DirectorCanvas } from "../canvas/DirectorCanvas";

/**
 * Stage 工作区，包含 3D 画布和时间轴/Blender 面板切换。
 * @param layout - 工作区布局状态。
 * @param setLayout - 布局状态更新函数。
 * @param timelineVisible - 时间轴是否可见。
 * @param blenderLiveVisible - Blender 实时面板是否可见。
 */
export function StageWorkspace({
  layout,
  setLayout,
  timelineVisible,
  blenderLiveVisible,
}: {
  layout: DirectorWorkspaceLayout;
  setLayout: Dispatch<SetStateAction<DirectorWorkspaceLayout>>;
  timelineVisible: boolean;
  blenderLiveVisible: boolean;
}) {
  return (
    <DirectorDeskShell layout={layout} setLayout={setLayout}>
      <DirectorCanvas
        layout={layout}
        onToggleFrameless={() => setLayout((current) => ({ ...current, frameless: !current.frameless }))}
        onTimelineCollapsedChange={(timelineCollapsed) =>
          setLayout((current) => ({
            ...current,
            timelineCollapsed,
          }))
        }
        onTimelineHeightChange={(timelineHeight) =>
          setLayout((current) => ({
            ...current,
            timelineHeight,
          }))
        }
        timelineVisible={timelineVisible}
        blenderLiveVisible={blenderLiveVisible}
      />
    </DirectorDeskShell>
  );
}
