import {
  BatchedMesh,
  Box3,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  type DataTexture,
  type Object3D,
} from "three";

/** A Three.js mesh that batches multiple instances (InstancedMesh or BatchedMesh). */
export type DirectorObjectBatchMesh = InstancedMesh | BatchedMesh;

type BatchedMeshWithColorTexture = BatchedMesh & {
  _colorsTexture: DataTexture | null;
};

/** A snapshot of a batch mesh's color state, used for save/restore during selection highlights. */
export type DirectorObjectBatchColorState =
  | { kind: "instanced"; instanceColor: InstancedMesh["instanceColor"] }
  | { kind: "batched"; colorTexture: DataTexture | null };

/**
 * Type guard for any batch mesh (InstancedMesh or BatchedMesh).
 *
 * @param object - A Three.js Object3D.
 */
export function isDirectorObjectBatchMesh(object: Object3D): object is DirectorObjectBatchMesh {
  return isDirectorInstancedObjectBatchMesh(object) || isDirectorBatchedObjectBatchMesh(object);
}

/**
 * Type guard for InstancedMesh.
 *
 * @param object - A Three.js Object3D.
 */
export function isDirectorInstancedObjectBatchMesh(object: Object3D): object is InstancedMesh {
  return (object as Object3D & { isInstancedMesh?: boolean }).isInstancedMesh === true;
}

/**
 * Type guard for BatchedMesh.
 *
 * @param object - A Three.js Object3D.
 */
export function isDirectorBatchedObjectBatchMesh(object: Object3D): object is BatchedMesh {
  return (object as Object3D & { isBatchedMesh?: boolean }).isBatchedMesh === true;
}

/**
 * Returns the total instance count of a batch mesh.
 *
 * @param mesh - A batch mesh.
 * @returns The instance count.
 */
export function getDirectorObjectBatchCount(mesh: DirectorObjectBatchMesh): number {
  return isDirectorInstancedObjectBatchMesh(mesh) ? mesh.count : mesh.instanceCount;
}

/**
 * Extracts the instance index from a raycasting hit result, supporting both
 * InstancedMesh (instanceId) and BatchedMesh (batchId).
 *
 * @param hit - A raycasting intersection with optional batchId/instanceId.
 * @returns The instance index, or null when neither is present.
 */
export function getDirectorObjectBatchHitIndex(hit: { batchId?: number; instanceId?: number }): number | null {
  return hit.instanceId ?? hit.batchId ?? null;
}

/**
 * Gets the local-space bounding box for a single instance within a batch mesh.
 *
 * @param mesh - A batch mesh.
 * @param index - The instance index.
 * @param target - A Box3 to write the result into.
 * @returns The target Box3, or null when bounds are unavailable.
 */
export function getDirectorObjectBatchLocalBoundsAt(
  mesh: DirectorObjectBatchMesh,
  index: number,
  target: Box3,
): Box3 | null {
  if (isDirectorBatchedObjectBatchMesh(mesh)) return mesh.getBoundingBoxAt(mesh.getGeometryIdAt(index), target);
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox ? target.copy(mesh.geometry.boundingBox) : null;
}

/**
 * Captures the current color state of a batch mesh so it can be restored later.
 *
 * @param mesh - A batch mesh.
 * @returns A snapshot of the current color state.
 */
export function captureDirectorObjectBatchColorState(mesh: DirectorObjectBatchMesh): DirectorObjectBatchColorState {
  if (isDirectorInstancedObjectBatchMesh(mesh)) return { kind: "instanced", instanceColor: mesh.instanceColor };
  return { kind: "batched", colorTexture: (mesh as BatchedMeshWithColorTexture)._colorsTexture };
}

/** Clears all per-instance colors from a batch mesh, restoring the default material color. */
export function clearDirectorObjectBatchColors(mesh: DirectorObjectBatchMesh): void {
  if (isDirectorInstancedObjectBatchMesh(mesh)) {
    mesh.instanceColor = null;
    return;
  }
  (mesh as BatchedMeshWithColorTexture)._colorsTexture = null;
}

/**
 * Sets per-instance colors on a batch mesh. Only the first `colors.length`
 * instances are affected; extra instances keep their current color.
 *
 * @param mesh - A batch mesh.
 * @param colors - An array of Three.js Color objects, one per instance.
 */
export function replaceDirectorObjectBatchColors(mesh: DirectorObjectBatchMesh, colors: readonly Color[]): void {
  const count = Math.min(getDirectorObjectBatchCount(mesh), colors.length);
  if (isDirectorInstancedObjectBatchMesh(mesh)) {
    const values = new Float32Array(mesh.count * 3);
    for (let index = 0; index < count; index += 1) colors[index]!.toArray(values, index * 3);
    const instanceColor = new InstancedBufferAttribute(values, 3);
    instanceColor.needsUpdate = true;
    mesh.instanceColor = instanceColor;
    return;
  }
  const batched = mesh as BatchedMeshWithColorTexture;
  batched._colorsTexture = null;
  for (let index = 0; index < count; index += 1) mesh.setColorAt(index, colors[index]!);
}

/**
 * Restores a batch mesh's color state from a previously captured snapshot.
 * Disposes the old color texture when it differs from the restored one.
 *
 * @param mesh - A batch mesh.
 * @param state - A color state snapshot from `captureDirectorObjectBatchColorState`.
 */
export function restoreDirectorObjectBatchColors(
  mesh: DirectorObjectBatchMesh,
  state: DirectorObjectBatchColorState,
): void {
  if (state.kind === "instanced") {
    if (isDirectorInstancedObjectBatchMesh(mesh)) mesh.instanceColor = state.instanceColor;
    return;
  }
  if (!isDirectorBatchedObjectBatchMesh(mesh)) return;
  const batched = mesh as BatchedMeshWithColorTexture;
  if (batched._colorsTexture && batched._colorsTexture !== state.colorTexture) batched._colorsTexture.dispose();
  batched._colorsTexture = state.colorTexture;
}
