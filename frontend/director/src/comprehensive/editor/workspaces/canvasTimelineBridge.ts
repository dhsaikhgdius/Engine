import {
  dispatchCreativeWorkspaceOperations,
  type DispatchCreativeWorkspaceResult,
} from "../../../agent/dispatchCreativeWorkspaceOperations";
import type { DirectorMediaItem } from "./directorMediaLibrary";

/** Protocol ceiling for a single clip duration (one hour), mirrored from the creative contract. */
const MAX_CLIP_DURATION_SEC = 60 * 60;

/**
 * Appends a board node's media item as a clip on the timeline and switches to the Video Editor workspace.
 *
 * Both steps route through the shared creative workspace agent contract
 * (`edit.clip.add`, then `workspace.switch`), so the UI and Agents produce the
 * same revision and receipts. The clip is placed on the primary video or audio
 * track based on the item's media kind, starting at time zero. On success the
 * browser URL is updated to reflect the workspace switch so the user lands in
 * the Video Editor view.
 *
 * @param item - The media item to place on the timeline.
 * @returns The failing dispatch receipt when either step is rejected, otherwise the successful clip-add receipt.
 */
export function appendBoardNodeToTimeline(item: DirectorMediaItem): DispatchCreativeWorkspaceResult {
  const trackId = item.kind === "audio" ? "audio-1" : "video-1";
  const durationSec = Math.min(Math.max(item.durationSec || 3, 0.1), MAX_CLIP_DURATION_SEC);
  const added = dispatchCreativeWorkspaceOperations({
    op: "edit.clip.add",
    track_id: trackId,
    media_id: item.id,
    name: item.name.trim().slice(0, 200) || "未命名剪辑",
    start_sec: 0,
    duration_sec: durationSec,
    source_duration_sec: item.kind === "video" || item.kind === "audio" ? durationSec : MAX_CLIP_DURATION_SEC,
  });
  if (!added.ok) return added;
  // workspace.switch is excluded from execute_batch (it is not history-rollback
  // safe), so the navigation dispatches as its own guarded operation.
  const switched = dispatchCreativeWorkspaceOperations({ op: "workspace.switch", workspace: "video" });
  if (!switched.ok) return switched;
  const url = new URL(window.location.href);
  url.searchParams.set("workspace", "video");
  window.history.pushState(window.history.state, "", url);
  return added;
}
