import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { DirectorCameraShot, DirectorTransform } from "../schema/directorProject";

/** The canonical glTF/USD camera look direction: negative Z in local space. */
const CAMERA_FORWARD = new Vector3(0, 0, -1);
/** World-space up vector used for building the look-at matrix. */
const CAMERA_WORLD_UP = new Vector3(0, 1, 0);
/** Fallback up vector when the camera looks straight up or down (gimbal-avoidance). */
const CAMERA_VERTICAL_UP = new Vector3(0, 0, 1);

function quaternionFromEuler(rotation: DirectorTransform["rotation"]) {
  return new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ")).normalize();
}

/**
 * glTF and OpenUSD cameras both look down local -Z with local +Y as up.
 * Director stores the look target as the authoritative framing intent, so
 * interchange orientation is derived from position -> target rather than the
 * camera-rig model's persisted Euler rotation.
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

export function directorCameraLookEuler(
  camera: Pick<DirectorCameraShot, "transform" | "target">,
): DirectorTransform["rotation"] {
  const [x, y, z, w] = directorCameraLookQuaternion(camera);
  const euler = new Euler().setFromQuaternion(new Quaternion(x, y, z, w), "XYZ");
  return [euler.x, euler.y, euler.z];
}

/**
 * Computes the distance from a camera position to its look target.
 *
 * Returns a clamped minimum of 0.1 to avoid degenerate near-zero distances
 * that would produce unstable downstream transforms.
 *
 * @param position - The camera's world-space position.
 * @param target - The look-at target point.
 * @param fallback - Value returned when the distance is zero or non-finite.
 * @returns The Euclidean distance, at least 0.1.
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
 * Reconstructs a look-at target from a camera position and quaternion rotation.
 *
 * This is the inverse of {@link directorCameraLookQuaternion}: given a pose,
 * it projects the canonical forward vector along the given distance to produce
 * the target point the camera would be looking at.
 *
 * @param position - The camera's world-space position.
 * @param rotation - Quaternion [x, y, z, w] representing the camera's orientation.
 * @param distance - The look distance in meters; clamped to at least 0.1.
 * @returns The inferred target point [x, y, z].
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
 * Reconstructs a look-at target from a camera position and Euler rotation.
 *
 * Convenience wrapper around {@link directorCameraTargetFromQuaternion}
 * that accepts Director's native Euler rotation format.
 *
 * @param position - The camera's world-space position.
 * @param rotation - Euler rotation [x, y, z] in radians.
 * @param distance - The look distance in meters.
 * @returns The inferred target point [x, y, z].
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
