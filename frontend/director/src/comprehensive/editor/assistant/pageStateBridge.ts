import { applyDirectorDeskTransientState } from "../io/hostBridge";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { useDirectorStore } from "../store/directorStore";
import { getDirectorTrackTargetForObject } from "../timeline/frameTimeline";
import type { DirectorPageEvent, DirectorPageState } from "./assistantProtocol";

/** Handler called when the agent changes playback state (playing, current frame). */
export type DirectorPagePlaybackHandler = (state: Pick<DirectorPageState, "playing" | "currentFrame">) => void;
/** Handler called when the agent changes the viewport camera. */
export type DirectorPageViewportHandler = (snapshot: NonNullable<DirectorPageState["viewportCamera"]>) => void;

let playbackHandler: DirectorPagePlaybackHandler | null = null;
let viewportHandler: DirectorPageViewportHandler | null = null;

/**
 * Register a handler for agent-initiated playback state changes.
 * Only one handler is active at a time; setting a new one replaces the old.
 *
 * @param handler - The playback handler to register.
 * @returns An unsubscribe function that removes the handler if it is still active.
 */
export function setDirectorPagePlaybackHandler(handler: DirectorPagePlaybackHandler) {
  playbackHandler = handler;
  return () => {
    if (playbackHandler === handler) playbackHandler = null;
  };
}

/**
 * Register a handler for agent-initiated viewport camera changes.
 * Only one handler is active at a time; setting a new one replaces the old.
 *
 * @param handler - The viewport handler to register.
 * @returns An unsubscribe function that removes the handler if it is still active.
 */
export function setDirectorPageViewportHandler(handler: DirectorPageViewportHandler) {
  viewportHandler = handler;
  return () => {
    if (viewportHandler === handler) viewportHandler = null;
  };
}

function validSelectedIds(value: unknown, availableIds: Set<string>) {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((item): item is string => typeof item === "string" && availableIds.has(item));
  return [...new Set(ids)].slice(0, 200);
}

/**
 * Apply a page event from the agent gateway to the live workbench state.
 * This is the single entry point for agent-initiated page state changes:
 * it updates selection, panel focus, view mode, playback, and viewport camera
 * within a single transient-state transaction.
 *
 * @param event - The page event from the agent gateway poll.
 */
export function applyDirectorPageEvent(event: DirectorPageEvent) {
  if (!event.state || typeof event.state !== "object") return;
  const state = event.state;
  applyDirectorDeskTransientState(() => {
    const director = useDirectorStore.getState();
    const availableIds = new Set(director.project.objects.map((item) => item.id));
    const selectedIds = validSelectedIds(state.selectedObjectIds, availableIds);
    if (selectedIds) {
      useDirectorStore.setState({
        selectedObjectId: selectedIds[0] ?? null,
        selectedObjectIds: selectedIds,
        selectedCrowdId: null,
        directorInspectorMode: selectedIds.length ? "auto" : "scene",
      });
    }
    if (state.activePanel === "scene") {
      useDirectorStore.getState().openSceneInspector();
      useTimelineRuntimeStore.getState().selectTrack(null);
    } else if (state.activePanel === "timeline") {
      const selectedObjectId = selectedIds?.[0] ?? useDirectorStore.getState().selectedObjectId;
      const track = getDirectorTrackTargetForObject(useDirectorStore.getState().project, selectedObjectId);
      useTimelineRuntimeStore.getState().selectTrack(track?.key ?? null);
    }
    if (state.viewMode === "director" || state.viewMode === "camera") {
      useDirectorStore.getState().setViewMode(state.viewMode);
    }
    const hasCurrentFrame = typeof state.currentFrame === "number" && Number.isSafeInteger(state.currentFrame);
    if (typeof state.playing === "boolean" || hasCurrentFrame) {
      playbackHandler?.({
        ...(typeof state.playing === "boolean" ? { playing: state.playing } : {}),
        ...(hasCurrentFrame ? { currentFrame: state.currentFrame } : {}),
      });
    }
    if (state.viewportCamera) viewportHandler?.(state.viewportCamera);
  });
}
