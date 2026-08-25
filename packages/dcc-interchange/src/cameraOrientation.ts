import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { DirectorCameraShot, DirectorTransform } from "@director/project-schema";

const CAMERA_FORWARD = new Vector3(0, 0, -1);
const CAMERA_WORLD_UP = new Vector3(0, 1, 0);
const CAMERA_VERTICAL_UP = new Vector3(0, 0, 1);

function quaternionFromEuler(rotation: DirectorTransform["rotation"]) {
  return new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ")).normalize();
}

/**
 * Compute a look-at quaternion from a camera's position and target, suitable
 * for glTF and OpenUSD cameras that look down local -Z with local +Y as up.
 * Falls back to the camera's Euler rotation when position and target are coincident.
 *
 * @param camera - The camera with transform and target.
 * @returns A normalized quaternion [x, y, z, w].
 */
export function directorCameraLookQuaternion(
  camera: Pick<DirectorCameraShot, "transform" | "target">,
): [number, number, number, number] {
  const position = new Vector3(...camera.transform.position);
  const target = new Vector3(...camera.target);
  const forward = target.clone().sub(position);
  if (forward.lengthSq() <= Number.EPSILON) {
    const fallback = quaternionFromEuler(camera.transform.rotation);
    return [fallback.x, fallback.y, fallback.z, fallback.w];
  }

  forward.normalize();
  const up = Math.abs(forward.dot(CAMERA_WORLD_UP)) > 0.999 ? CAMERA_VERTICAL_UP.clone() : CAMERA_WORLD_UP.clone();
  const matrix = new Matrix4().lookAt(position, target, up);
  const quaternion = new Quaternion().setFromRotationMatrix(matrix).normalize();
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

/**
 * Compute look-at Euler angles (XYZ order) from a camera's position and target.
 * Delegates to `directorCameraLookQuaternion` and converts to Euler.
 *
 * @param camera - The camera with transform and target.
 * @returns Euler angles [x, y, z] in radians.
 */
export function directorCameraLookEuler(
  camera: Pick<DirectorCameraShot, "transform" | "target">,
): DirectorTransform["rotation"] {
  const [x, y, z, w] = directorCameraLookQuaternion(camera);
  const euler = new Euler().setFromQuaternion(new Quaternion(x, y, z, w), "XYZ");
  return [euler.x, euler.y, euler.z];
}

/**
 * Compute the distance between a camera position and its look-at target.
 * Falls back to a minimum of 0.1 when the distance is zero or degenerate.
 *
 * @param position - The camera position in world space.
 * @param target - The look-at target in world space.
 * @param fallback - Fallback distance when the computed distance is zero (default 1).
 * @returns The distance in world units.
 */
export function directorCameraTargetDistance(
  position: DirectorTransform["position"],
  target: DirectorCameraShot["target"],
  fallback = 1,
) {
  const distance = new Vector3(...target).distanceTo(new Vector3(...position));
  return Number.isFinite(distance) && distance > Number.EPSILON ? distance : Math.max(fallback, 0.1);
}

/**
 * Reconstruct a look-at target from a camera position and quaternion rotation.
 * Projects the camera's forward vector by the given distance.
 *
 * @param position - The camera position in world space.
 * @param rotation - The quaternion rotation [x, y, z, w] (w defaults to 1 if not finite).
 * @param distance - The distance from the camera to the target (clamped to ≥ 0.1).
 * @returns The target point [x, y, z] in world space.
 */
export function directorCameraTargetFromQuaternion(
  position: DirectorTransform["position"],
  rotation: readonly number[],
  distance = 1,
): DirectorCameraShot["target"] {
  const quaternion = new Quaternion(
    Number(rotation[0]) || 0,
    Number(rotation[1]) || 0,
    Number(rotation[2]) || 0,
    Number.isFinite(rotation[3]) ? Number(rotation[3]) : 1,
  ).normalize();
  const forward = CAMERA_FORWARD.clone().applyQuaternion(quaternion).normalize();
  const target = new Vector3(...position).add(forward.multiplyScalar(Math.max(distance, 0.1)));
  return [target.x, target.y, target.z];
}

/**
 * Reconstruct a look-at target from a camera position and Euler rotation (XYZ).
 * Converts Euler to quaternion first, then delegates to `directorCameraTargetFromQuaternion`.
 *
 * @param position - The camera position in world space.
 * @param rotation - Euler angles [x, y, z] in radians.
 * @param distance - The distance from the camera to the target (default 1).
 * @returns The target point [x, y, z] in world space.
 */
export function directorCameraTargetFromEuler(
  position: DirectorTransform["position"],
  rotation: DirectorTransform["rotation"],
  distance = 1,
) {
  const quaternion = quaternionFromEuler(rotation);
  return directorCameraTargetFromQuaternion(
    position,
    [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    distance,
  );
}
