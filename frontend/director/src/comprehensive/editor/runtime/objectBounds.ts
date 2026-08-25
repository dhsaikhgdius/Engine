/**
 * Object-space bounding box utilities for the 3D viewport.
 *
 * @module director/runtime/objectBounds
 */

import { Box3, Matrix4, Vector3, type Object3D } from "three";

/**
 * Compute the world-space bounding box of an object, then transform it
 * into its parent's local coordinate frame.
 *
 * @param object - The Three.js object whose bounds to compute.
 * @returns The bounding box in parent-local space, or world-space if no parent exists.
 */
export function getBoundsInParentLocal(object: Object3D) {
  (object.parent ?? object).updateMatrixWorld(true);
  const worldBounds = new Box3().setFromObject(object, true);
  if (!object.parent || worldBounds.isEmpty()) return worldBounds;

  const parentInverse = new Matrix4().copy(object.parent.matrixWorld).invert();
  const bounds = new Box3().makeEmpty();
  const vertex = new Vector3();
  for (const x of [worldBounds.min.x, worldBounds.max.x])
    for (const y of [worldBounds.min.y, worldBounds.max.y])
      for (const z of [worldBounds.min.z, worldBounds.max.z])
        bounds.expandByPoint(vertex.set(x, y, z).applyMatrix4(parentInverse));
  return bounds;
}
