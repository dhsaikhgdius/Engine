/**
 * Storyboard thumbnail capture: renders a shot's camera framing through the
 * viewport capture bridge at a bounded thumbnail size, stores the image in
 * the persistent creative media library, and returns the thumbnail reference
 * persisted on the storyboard shot. Dependencies (capture function, media
 * library) are injectable so tests run without a live viewport.
 */
import type { ScreenshotResult } from "../io/screenshotExport";
import { requestViewportCapture, type ViewportCaptureRequest } from "../io/captureBridge";
import {
  persistentCreativeMediaLibrary,
  type PersistentCreativeMediaLibrary,
} from "../media/persistentCreativeMediaStore";
import { getDirectorCameraAspectValue } from "../schema/cameraGeometry";
import type { DirectorProject, DirectorStoryboardShot } from "../schema/directorProject";

/** Maximum edge length in pixels for storyboard thumbnail renders. */
export const DIRECTOR_STORYBOARD_THUMBNAIL_MAX_EDGE = 960;

/** The shape of a persisted storyboard thumbnail reference inside a shot. */
export type DirectorStoryboardThumbnail = NonNullable<DirectorStoryboardShot["thumbnail"]>;
/** A capture function that can be injected for testing; defaults to the live viewport bridge. */
export type DirectorStoryboardCapture = (request: ViewportCaptureRequest) => Promise<ScreenshotResult[]>;

/** Injectable dependencies for storyboard thumbnail capture, enabling test isolation. */
export interface DirectorStoryboardCaptureDependencies {
  capture?: DirectorStoryboardCapture;
  mediaLibrary?: Pick<PersistentCreativeMediaLibrary, "importBlob">;
  now?: () => Date;
}

function decodePngDataUrl(dataUrl: string) {
  const match = /^data:image\/png;base64,([a-z\d+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error("分镜截图必须返回 base64 PNG 数据");
  const binary = atob(match[1]!.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Computes the target raster size for a storyboard thumbnail, constrained to the
 * maximum edge length while preserving the camera's aspect ratio.
 *
 * @param project - The Director project containing the referenced camera.
 * @param shot - The storyboard shot whose camera aspect ratio is used.
 * @returns The width and height in pixels for the thumbnail render.
 */
export function getDirectorStoryboardThumbnailSize(project: DirectorProject, shot: DirectorStoryboardShot) {
  const camera = project.cameras.find((candidate) => candidate.id === shot.cameraId);
  if (!camera) throw new Error(shot.cameraId ? `分镜机位不存在：${shot.cameraId}` : "请先为分镜指定机位");
  const aspect = getDirectorCameraAspectValue(camera.aspectRatio);
  return aspect >= 1
    ? {
        width: DIRECTOR_STORYBOARD_THUMBNAIL_MAX_EDGE,
        height: Math.max(1, Math.round(DIRECTOR_STORYBOARD_THUMBNAIL_MAX_EDGE / aspect)),
      }
    : {
        width: Math.max(1, Math.round(DIRECTOR_STORYBOARD_THUMBNAIL_MAX_EDGE * aspect)),
        height: DIRECTOR_STORYBOARD_THUMBNAIL_MAX_EDGE,
      };
}

/**
 * Captures one exact camera/frame as a clean PNG and persists the binary in the
 * media library. The project only receives a bounded media reference.
 */
export async function captureDirectorStoryboardThumbnail(
  project: DirectorProject,
  shot: DirectorStoryboardShot,
  signal: AbortSignal,
  dependencies: DirectorStoryboardCaptureDependencies = {},
): Promise<DirectorStoryboardThumbnail> {
  if (!Number.isSafeInteger(shot.frameStart) || shot.frameStart < 0) throw new Error("分镜入点帧必须是非负整数");
  const camera = project.cameras.find((candidate) => candidate.id === shot.cameraId);
  if (!camera) throw new Error(shot.cameraId ? `分镜机位不存在：${shot.cameraId}` : "请先为分镜指定机位");

  const { width, height } = getDirectorStoryboardThumbnailSize(project, shot);
  const capture = dependencies.capture ?? requestViewportCapture;
  const results = await capture({
    preset: "current",
    source: "capture-panel",
    cameraId: camera.id,
    cleanPlate: true,
    renderPass: "clean",
    width,
    height,
    frame: shot.frameStart,
    signal,
  });
  const result = results[0];
  if (results.length !== 1 || !result) throw new Error("分镜截图必须恰好返回一张画面");
  if (result.meta.cameraId !== camera.id) throw new Error("分镜截图返回了错误机位");
  if (result.meta.frame !== shot.frameStart) throw new Error("分镜截图返回了错误帧");
  if (result.meta.raster?.width !== width || result.meta.raster.height !== height) {
    throw new Error("分镜截图返回了错误分辨率");
  }

  const bytes = decodePngDataUrl(result.dataUrl);
  const blob = new Blob([bytes], { type: "image/png" });
  const capturedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const mediaLibrary = dependencies.mediaLibrary ?? persistentCreativeMediaLibrary;
  const asset = await mediaLibrary.importBlob(blob, {
    kind: "image",
    name: `${shot.title || "分镜"} · F${shot.frameStart}`,
    fileName: `storyboard-${shot.id.replace(/[^a-z0-9_-]+/gi, "-")}-f${shot.frameStart}.png`,
    width,
    height,
    source: `storyboard-shot:${shot.id}`,
    embeddedMetadata: {
      "director.contract": "director-storyboard-thumbnail-v1",
      "director.shotId": shot.id,
      "director.cameraId": camera.id,
      "director.frame": String(shot.frameStart),
    },
  });

  return {
    mediaId: asset.id,
    cameraId: camera.id,
    frame: shot.frameStart,
    width,
    height,
    capturedAt,
  };
}
