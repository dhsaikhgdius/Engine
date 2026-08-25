import type { DirectorProject } from "../schema/directorProject";
import { getCameraViewSnapshotFromShot } from "../schema/cameraGeometry";
import { getDirectorObjectFocusTarget } from "../schema/cameraTarget";

/**
 * Computes a camera snapshot that frames the given objects, preserving the
 * current camera's direction and FOV. The camera is positioned so the objects'
 * bounding sphere fills the viewport with a comfortable margin.
 *
 * @param project - The current project state.
 * @param objectIds - The ids of the objects to focus on.
 * @returns A camera snapshot (fov, target, position), or null when no valid objects are found.
 */
export function getDirectorObjectFocusSnapshot(project: DirectorProject, objectIds: readonly string[]) {
  const requested = new Set(objectIds);
  const objects = project.objects.filter((object) => requested.has(object.id) && object.kind !== "camera");
  if (!objects.length) return null;

  const targets = objects.map((object) => getDirectorObjectFocusTarget(object));
  const target = targets
    .reduce<[number, number, number]>(
      (sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]],
      [0, 0, 0],
    )
    .map((value) => value / targets.length) as [number, number, number];
  const radius = Math.max(
    0.75,
    ...objects.map((object, index) => {
      const point = targets[index]!;
      const extent = Math.max(...object.transform.scale.map((value) => Math.abs(value))) * 0.9;
      return Math.hypot(point[0] - target[0], point[1] - target[1], point[2] - target[2]) + extent;
    }),
  );
  const activeCamera =
    project.cameras.find((camera) => camera.id === project.activeCameraId) ?? project.cameras[0] ?? null;
  const shot = activeCamera ? getCameraViewSnapshotFromShot(activeCamera) : null;
  const offset = shot
    ? [shot.position[0] - shot.target[0], shot.position[1] - shot.target[1], shot.position[2] - shot.target[2]]
    : [1, 0.7, 1];
  const length = Math.max(0.001, Math.hypot(...offset));
  const direction = offset.map((value) => value / length) as [number, number, number];
  const fov = shot?.fov ?? 50;
  const distance = Math.max(2.5, (radius / Math.tan((Math.max(20, fov) * Math.PI) / 360)) * 1.35);

  return {
    fov,
    target,
    position: target.map((value, index) => value + direction[index]! * distance) as [number, number, number],
  };
}
