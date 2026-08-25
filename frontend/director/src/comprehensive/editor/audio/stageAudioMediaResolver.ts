import { persistentCreativeMediaLibrary } from "../media/persistentCreativeMediaStore";
import type { DirectorTimelineAudioClip } from "../schema/directorProject";

/**
 * Resolves a stage audio clip to a playable URL.
 *
 * The creative media library object URL wins because it always points at the
 * locally imported bytes; the persisted sourceUrl is the fallback for projects
 * opened on another machine.
 *
 * @param clip - The timeline audio clip whose source URL needs resolution.
 * @returns The playable URL, or null when neither the local library nor the
 *   persisted source has a usable URL.
 */
export function resolveStageAudioClipSourceUrl(clip: DirectorTimelineAudioClip): string | null {
  const asset = persistentCreativeMediaLibrary.getAsset(clip.mediaId);
  if (asset?.objectUrl && asset.kind !== "image") return asset.objectUrl;
  return clip.sourceUrl ?? null;
}
