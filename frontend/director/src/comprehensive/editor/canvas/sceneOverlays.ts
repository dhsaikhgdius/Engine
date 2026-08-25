import { Euler, Vector3 } from "three";
import type { DirectorObject, DirectorSceneAnchor, DirectorTransform } from "../schema/directorProject";

/**
 * Transforms a local-space point through a DirectorTransform (scale, rotation, position).
 *
 * @param point - The local point as [x, y, z].
 * @param transform - The director transform to apply.
 * @returns The world-space point as [x, y, z].
 */
export function transformDirectorLocalPoint(
  point: readonly [number, number, number],
  transform: DirectorTransform,
): [number, number, number] {
  const resolved = new Vector3(...point)
    .multiply(new Vector3(...transform.scale))
    .applyEuler(new Euler(...transform.rotation))
    .add(new Vector3(...transform.position));
  return [resolved.x, resolved.y, resolved.z];
}

/**
 * Resolves a scene anchor to its world-space position. When the anchor references
 * an object, the anchor's local position is transformed through that object's world
 * transform. Otherwise the anchor position is used directly.
 *
 * @param anchor - The scene anchor to resolve.
 * @param objectsById - A map of all director objects by id.
 * @returns The world-space position as [x, y, z], or null when the referenced object is not found.
 */
export function resolveDirectorSceneAnchor(
  anchor: DirectorSceneAnchor,
  objectsById: ReadonlyMap<string, DirectorObject>,
): [number, number, number] | null {
  if (!anchor.objectId) return [...anchor.position];
  const object = objectsById.get(anchor.objectId);
  return object ? transformDirectorLocalPoint(anchor.position, object.transform) : null;
}

/**
 * Returns the Euclidean distance between two 3D points.
 *
 * @param start - The start point as [x, y, z].
 * @param end - The end point as [x, y, z].
 * @returns The distance in world units.
 */
export function getDirectorMeasurementDistance(
  start: readonly [number, number, number],
  end: readonly [number, number, number],
) {
  return Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
}
