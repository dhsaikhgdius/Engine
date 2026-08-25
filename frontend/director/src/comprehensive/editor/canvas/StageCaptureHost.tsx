/**
 * Offscreen Stage canvas used when the visible workspace is not 3D Stage.
 * Capture still needs the R3F handler; this is not a PiP preview.
 *
 * @module StageCaptureHost
 */

import { useMemo } from "react";
import { DEFAULT_DIRECTOR_WORKSPACE_LAYOUT } from "../../app/layout/workspaceLayout";
import { DirectorCanvas } from "./DirectorCanvas";
import "./stageCaptureHost.css";

/**
 * Mounts a sized, inert Director canvas so Agent (and other non-Stage tabs)
 * can register the viewport capture handler.
 */
export function StageCaptureHost() {
  const layout = useMemo(
    () => ({
      ...DEFAULT_DIRECTOR_WORKSPACE_LAYOUT,
      frameless: true,
    }),
    [],
  );

  return (
    <div
      className="director-stage-capture-host"
      data-testid="director-stage-capture-host"
      aria-hidden="true"
      {...{ inert: "" }}
    >
      <DirectorCanvas
        captureOnly
        layout={layout}
        onTimelineCollapsedChange={() => undefined}
        onTimelineHeightChange={() => undefined}
        onToggleFrameless={() => undefined}
        timelineVisible={false}
        blenderLiveVisible
      />
    </div>
  );
}
