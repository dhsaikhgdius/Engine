import type { DirectorObject, DirectorProject } from "@director/project-schema";
import { getDirectorPrimitiveMetrics, getGroundedLabelY } from "@director/project-schema";

/**
 * A 3D vector represented as a tuple of three numbers [x, y, z].
 *
 * Used throughout the spatial engine for positions, dimensions, and directions.
 */
export type DirectorSpatialVec3 = [number, number, number];

/**
 * Axis-aligned bounding box computed from an object's oriented corners
 * transformed into world space.
 */
export interface DirectorSpatialBounds {
  /** Minimum corner of the bounding box in world space. */
  min: DirectorSpatialVec3;
  /** Maximum corner of the bounding box in world space. */
  max: DirectorSpatialVec3;
  /** Center point of the bounding box. */
  center: DirectorSpatialVec3;
  /** Extent of the bounding box along each axis (max - min). */
  size: DirectorSpatialVec3;
}

export interface DirectorSpatialLocalBounds {
  min: DirectorSpatialVec3;
  max: DirectorSpatialVec3;
}

function characterDimensions(object: DirectorObject, project?: DirectorProject): DirectorSpatialVec3 {
  const asset = object.assetRefId ? project?.assets.find((candidate) => candidate.id === object.assetRefId) : null;
  const measuredHeight = asset?.characterMetadata?.heightM;
  if (measuredHeight && Number.isFinite(measuredHeight) && measuredHeight > 0) {
    // When a measured height is available on the asset, derive width and depth
    // from height using average human proportions. Clamp to a minimum of 0.8 m
    // to avoid degenerate dimensions for very small characters.
    const height = Math.max(0.8, measuredHeight);
    return [height * 0.46, height, height * 0.29];
  }
  // Fall back to body-type heuristics when no measured height is available.
  const bodyWidth = {
    mannequin: 0.82,
    female: 0.72,
    broad: 1.04,
    muscular: 1.08,
    slim: 0.66,
    teen: 0.66,
    child: 0.54,
    chibi: 0.72,
  }[object.bodyType ?? "mannequin"];
  const height = Math.max(0.8, getGroundedLabelY(object.bodyType) - 0.18);
  return [bodyWidth, height, bodyWidth * 0.62];
}

/** Resolves the canonical measured local bounds shared by query, placement, and audit. */
export function getDirectorObjectLocalBounds(
  object: DirectorObject,
  project?: DirectorProject,
): DirectorSpatialLocalBounds | null {
  if (object.kind === "camera" || object.kind === "panorama" || object.isCompositeParent) return null;
  if (object.localBoundsM) {
    return { min: [...object.localBoundsM.min], max: [...object.localBoundsM.max] };
  }
  const asset = object.assetRefId ? project?.assets.find((candidate) => candidate.id === object.assetRefId) : null;
  if (asset?.localBoundsM) {
    return { min: [...asset.localBoundsM.min], max: [...asset.localBoundsM.max] };
  }
  if (object.kind === "character") {
    const [width, height, depth] = characterDimensions(object, project);
    return { min: [-width / 2, 0, -depth / 2], max: [width / 2, height, depth / 2] };
  }
  if (object.geometryType) {
    const [width, height, depth] = getDirectorPrimitiveMetrics(object.geometryType).size;
    return { min: [-width / 2, 0, -depth / 2], max: [width / 2, height, depth / 2] };
  }
  return null;
}

/** Local dimensions retained for callers that only need extents, not the pivot offset. */
export function getDirectorObjectLocalDimensions(
  object: DirectorObject,
  project?: DirectorProject,
): DirectorSpatialVec3 | null {
  const bounds = getDirectorObjectLocalBounds(object, project);
  return bounds ? (bounds.max.map((value, axis) => value - bounds.min[axis]) as DirectorSpatialVec3) : null;
}

function rotatePoint([x, y, z]: DirectorSpatialVec3, [rx, ry, rz]: DirectorSpatialVec3): DirectorSpatialVec3 {
  // Apply Euler rotation in X-Y-Z intrinsic order matching the engine's
  // transform convention: pitch (X), then yaw (Y), then roll (Z).
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);
  const afterX: DirectorSpatialVec3 = [x, y * cosX - z * sinX, y * sinX + z * cosX];
  const afterY: DirectorSpatialVec3 = [
    afterX[0] * cosY + afterX[2] * sinY,
    afterX[1],
    -afterX[0] * sinY + afterX[2] * cosY,
  ];
  return [afterY[0] * cosZ - afterY[1] * sinZ, afterY[0] * sinZ + afterY[1] * cosZ, afterY[2]];
}

function objectCorners(object: DirectorObject, project?: DirectorProject): DirectorSpatialVec3[] {
  const bounds = getDirectorObjectLocalBounds(object, project);
  if (!bounds) return [];
  const [sx, sy, sz] = object.transform.scale;
  const corners: DirectorSpatialVec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        corners.push(rotatePoint([x * sx, y * sy, z * sz], object.transform.rotation));
      }
    }
  }
  return corners;
}

/**
 * Computes the world-space axis-aligned bounding box for an object.
 *
 * Transforms the object's local-dimension corners by its world transform
 * and returns the enclosing AABB. Returns null for objects without
 * computable dimensions (cameras, panoramas, composite parents).
 *
 * @param object - The object whose bounds to compute.
 * @param project - Optional project for asset-backed dimension lookups.
 * @returns The world-space AABB, or null when dimensions are not computable.
 */
export function getDirectorSpatialBounds(
  object: DirectorObject,
  project?: DirectorProject,
): DirectorSpatialBounds | null {
  const corners = objectCorners(object, project);
  if (!corners.length) return null;
  const worldCorners = corners.map(
    (corner) => corner.map((value, index) => value + object.transform.position[index]) as DirectorSpatialVec3,
  );
  const min = [0, 1, 2].map((index) => Math.min(...worldCorners.map((point) => point[index]))) as DirectorSpatialVec3;
  const max = [0, 1, 2].map((index) => Math.max(...worldCorners.map((point) => point[index]))) as DirectorSpatialVec3;
  const size = max.map((value, index) => value - min[index]) as DirectorSpatialVec3;
  const center = max.map((value, index) => (value + min[index]) / 2) as DirectorSpatialVec3;
  return { min, max, size, center };
}

/**
 * Directional support distance from an object's pivot to its projected OBB edge.
 *
 * Projects the object's local corners onto the given horizontal direction
 * and returns the maximum positive projection distance. Used to compute
 * the separation needed when placing one object next to another in a
 * specific direction while preserving the object's current facing.
 *
 * @param object - The object to measure.
 * @param direction - Horizontal direction vector (only x and z components are used).
 * @param project - Optional project for asset-backed dimension lookups.
 * @returns The support radius in meters.
 * @throws {Error} When the direction vector has near-zero length.
 */
export function getDirectorPlanarSupportRadius(
  object: DirectorObject,
  direction: { x: number; z: number },
  project?: DirectorProject,
): number {
  const length = Math.hypot(direction.x, direction.z);
  if (length <= 1e-6) throw new Error("Planar support direction must have non-zero length.");
  const normal = { x: direction.x / length, z: direction.z / length };
  const corners = objectCorners(object, project);
  if (!corners.length) throw new Error(`Object "${object.id}" has no measured local bounds.`);
  return Math.max(0, ...corners.map((corner) => corner[0] * normal.x + corner[2] * normal.z));
}

/**
 * Yaw-independent conservative footprint radius.
 *
 * Returns the maximum horizontal distance from the object's pivot to any
 * of its local corners, regardless of the object's current yaw. Used when
 * an arrangement also changes the object's facing, so the final orientation
 * is not yet known and a direction-specific support radius would be unreliable.
 *
 * @param object - The object to measure.
 * @param project - Optional project for asset-backed dimension lookups.
 * @returns The footprint radius in meters.
 */
export function getDirectorPlanarFootprintRadius(object: DirectorObject, project?: DirectorProject): number {
  const corners = objectCorners(object, project);
  if (!corners.length) throw new Error(`Object "${object.id}" has no measured local bounds.`);
  return Math.max(...corners.map((corner) => Math.hypot(corner[0], corner[2])));
}
