import type { Object3D } from "three";
import type { PlayerRaycastMesh } from "./playerRaycastAcceleration";

/**
 * Immutable collision view of one externally-authored static environment.
 * The render owner creates it once per source revision; player physics and the
 * follow camera then share the same flat mesh list without walking the scene
 * graph again on every frame.
 */
export interface PlayerStaticEnvironment {
  /** Flat list of collision-eligible meshes, pre-collected and accelerated. */
  meshes: readonly PlayerRaycastMesh[];
  /** Unique identifier for the collision owner that registered this environment. */
  ownerId: string;
  /** The original scene-graph root used for transform lookups. */
  referenceRoot: Object3D;
  /** The mounted scene-graph root for this environment. */
  root: Object3D;
  /** Revision key that changes when the source geometry is updated. */
  versionKey: string;
}
