/**
 * Dispatches the right sidebar content based on the current selection kind.
 *
 * @module RightPanel
 */

import { useDirectorStore } from "../store/directorStore";
import { selectRightPanelKind } from "../store/directorSelectors";
import { CameraPanel } from "./CameraPanel";
import { CharacterPanel } from "./CharacterPanel";
import { ObjectAdvancedToolsPanel } from "./ObjectAdvancedToolsPanel";
import { PropPanel } from "./PropPanel";
import { ScenePanel } from "./ScenePanel";
import { TrajectoryPropertiesPanel } from "../trajectory/TrajectoryPropertiesPanel";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { getDirectorFrameTrackByKey } from "../timeline/frameTimeline";
import { BlenderNativeMeshInspector } from "../interchange/BlenderLivePanel";
import { BlenderNativeRigPanel } from "./BlenderNativeRigPanel";

/**
 * Renders the appropriate panel (scene, camera, character, prop, multi-select, or trajectory)
 * based on the current selection, with native rig and mesh overlay support.
 */
export function RightPanel() {
  const panelKind = useDirectorStore(selectRightPanelKind);
  const selectedObjectIds = useDirectorStore((state) => state.selectedObjectIds);
  const selectedCrowdId = useDirectorStore((state) => state.selectedCrowdId);
  const selectedTrackKey = useTimelineRuntimeStore((state) => state.selectedTrackKey);
  const hasSelectedTrack = useDirectorStore((state) =>
    Boolean(getDirectorFrameTrackByKey(state.project, selectedTrackKey)),
  );
  const isMultiSelect = selectedObjectIds.length > 1 && !selectedCrowdId;
  const fallback = isMultiSelect ? (
    <ObjectAdvancedToolsPanel />
  ) : hasSelectedTrack ? (
    <TrajectoryPropertiesPanel />
  ) : panelKind === "character" ? (
    <CharacterPanel />
  ) : panelKind === "prop" ? (
    <PropPanel />
  ) : panelKind === "camera" ? (
    <CameraPanel />
  ) : (
    <ScenePanel />
  );

  return (
    <>
      <BlenderNativeRigPanel fallback={fallback} />
      <BlenderNativeMeshInspector />
    </>
  );
}
