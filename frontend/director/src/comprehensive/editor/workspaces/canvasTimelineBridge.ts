import type { DirectorCreativeWorkspaceState } from "./directorWorkspaceStore";
import type { DirectorMediaItem } from "./directorMediaLibrary";

/**
 * Appends a board node's media item as a clip on the timeline and switches to the Video Editor workspace.
 *
 * The clip is placed on the primary video or audio track based on the item's
 * media kind, starting at time zero. The browser URL is updated to reflect the
 * workspace switch so the user lands in the Video Editor view.
 *
 * @param state - A slice of the workspace store that provides `addClip` and `setMode`.
 * @param item - The media item to place on the timeline.
 * @returns The created clip, or `null` if the clip could not be added.
 */
export function appendBoardNodeToTimeline(
  state: Pick<DirectorCreativeWorkspaceState, "addClip" | "setMode">,
  item: DirectorMediaItem,
) {
  const trackId = item.kind === "audio" ? "audio-1" : "video-1";
  const clip = state.addClip({
    trackId,
    mediaId: item.id,
    name: item.name,
    startSec: 0,
    durationSec: item.durationSec || 3,
    sourceDurationSec: item.kind === "video" || item.kind === "audio" ? item.durationSec || 3 : 60 * 60,
  });
  if (!clip) return null;
  state.setMode("video");
  const url = new URL(window.location.href);
  url.searchParams.set("workspace", "video");
  window.history.pushState(window.history.state, "", url);
  return clip;
}