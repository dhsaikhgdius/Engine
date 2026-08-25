import { Matrix4, Quaternion, Vector3 } from "three";

/**
 * Produces a camera-space look quaternion. Matrix4.lookAt uses the camera's
 * negative Z viewing convention; Object3D.lookAt does not, so copying a plain
 * Object3D quaternion to a camera turns the lens exactly away from its target.
 *
 * @param matrix - Scratch Matrix4 used for the look-at computation.
 * @param position - The camera's world-space position.
 * @param quaternion - The output Quaternion to write the result into.
 * @param target - The world-space point the camera should face.
 * @param up - The world-space up direction.
 * @returns The same `quaternion` instance, now set to the look rotation.
 */
export function setPlayerCameraLookQuaternion({
  matrix,
  position,
  quaternion,
  target,
  up,
}: {
  matrix: Matrix4;
  position: Vector3;
  quaternion: Quaternion;
  target: Vector3;
  up: Vector3;
}) {
  matrix.lookAt(position, target, up);
  quaternion.setFromRotationMatrix(matrix);
  return quaternion;
}
