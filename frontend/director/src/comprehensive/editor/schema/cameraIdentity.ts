import type { DirectorCameraShot, DirectorProject } from "./directorProject";

/**
 * Resolves either camera identity exposed by Director:
 * - the authored camera-shot id used by DirectorProject.cameras; or
 * - the linked camera-rig object id used by the Stage projection/scene hint.
 *
 * Returning the canonical camera shot keeps capture, Shot IR, and production
 * evaluation on one exact camera without falling back to the active view.
 */
export function findDirectorCameraById(
  project: Pick<DirectorProject, "cameras" | "objects">,
  cameraId: string,
): DirectorCameraShot | undefined {
  const direct = project.cameras.find((camera) => camera.id === cameraId);
  if (direct) return direct;

  const linkedCameraId = project.objects.find(
    (object) => object.kind === "camera" && object.id === cameraId,
  )?.linkedCameraId;
  if (!linkedCameraId) return undefined;

  return project.cameras.find((camera) => camera.id === linkedCameraId);
}
