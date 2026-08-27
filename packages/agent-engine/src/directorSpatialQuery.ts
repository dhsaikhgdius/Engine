/**
 * Read-only spatial object queries for `director_workbench` observe
 * (`query_objects`).
 *
 * Lets an agent ask "what is near X / inside this box / visible from this
 * camera" against the canonical project geometry instead of scraping the
 * full object list. Supports four spatial modes — `radius`, `nearby`
 * (around an existing object), `aabb`, and `frustum` (camera cone,
 * conservative bounding-sphere test) — composable with name-pattern, kind,
 * and object-list filters. Results are distance-sorted, bounded by
 * `maxResults` with an explicit `truncated` flag, and never mutate the
 * project. Unresolvable references (missing camera or nearby object) throw
 * with the exact id so the rejection message can carry the corrective call.
 *
 * @module directorSpatialQuery
 */

import type {
  DirectorObject,
  DirectorProject,
} from "@director/project-schema";
import {
  getCameraViewSnapshotFromShot,
  getDirectorCameraAspectValue,
  normalizeDirectorCameraOptics,
} from "@director/project-schema";
import type { DirectorObjectSpatialQuery } from "./directorWorkbenchContract";

/** Composable query filters; all present filters must match (logical AND). */
export type DirectorObjectQuery = {
  spatial?: DirectorObjectSpatialQuery;
  namePattern?: string;
  kind?: DirectorObject["kind"];
  /** Exact Stage object-list id (objectListId); same sets create_object_list writes. */
  objectListId?: string;
};
import {
  getDirectorSpatialBounds,
  type DirectorSpatialBounds,
  type DirectorSpatialVec3,
} from "./directorSpatialGeometry";

type QueryOptions = {
  includeHidden: boolean;
  maxResults: number;
};

type Frustum = {
  cameraId: string;
  origin: DirectorSpatialVec3;
  forward: DirectorSpatialVec3;
  right: DirectorSpatialVec3;
  up: DirectorSpatialVec3;
  tanHalfVerticalFov: number;
  tanHalfHorizontalFov: number;
  near: number;
  far: number;
};

function subtract(left: DirectorSpatialVec3, right: DirectorSpatialVec3): DirectorSpatialVec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left: DirectorSpatialVec3, right: DirectorSpatialVec3) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: DirectorSpatialVec3, right: DirectorSpatialVec3): DirectorSpatialVec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalize(value: DirectorSpatialVec3): DirectorSpatialVec3 {
  const length = Math.hypot(...value);
  if (length <= 1e-6) throw new Error("Camera view direction has zero length.");
  return [value[0] / length, value[1] / length, value[2] / length];
}

function distance(left: DirectorSpatialVec3, right: DirectorSpatialVec3) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function rounded(value: number) {
  return Number(value.toFixed(4));
}

function roundedVec3(value: DirectorSpatialVec3): DirectorSpatialVec3 {
  return value.map(rounded) as DirectorSpatialVec3;
}

function roundedBounds(bounds: DirectorSpatialBounds) {
  return {
    min: roundedVec3(bounds.min),
    max: roundedVec3(bounds.max),
    center: roundedVec3(bounds.center),
    size: roundedVec3(bounds.size),
  };
}

function intersectsAabb(bounds: DirectorSpatialBounds, min: DirectorSpatialVec3, max: DirectorSpatialVec3) {
  return [0, 1, 2].every((axis) => bounds.max[axis] >= min[axis] && bounds.min[axis] <= max[axis]);
}

// Build the view frustum for a camera (explicit id or the active camera),
// deriving basis vectors from the camera's view snapshot and half-FOV
// tangents from its optics. Throws when no camera can be resolved.
function resolveFrustum(project: DirectorProject, cameraId?: string): Frustum {
  const resolvedCameraId = cameraId ?? project.activeCameraId;
  if (!resolvedCameraId) throw new Error("Frustum query requires camera_id or an active camera.");
  const camera = project.cameras.find((candidate) => candidate.id === resolvedCameraId);
  if (!camera) throw new Error(`No camera with id "${resolvedCameraId}" exists.`);
  const view = getCameraViewSnapshotFromShot(camera);
  const forward = normalize(subtract(view.target, view.position));
  const worldUp: DirectorSpatialVec3 = Math.abs(forward[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, worldUp));
  const up = normalize(cross(right, forward));
  const optics = normalizeDirectorCameraOptics(camera);
  const tanHalfVerticalFov = Math.tan((view.fov * Math.PI) / 360);
  return {
    cameraId: resolvedCameraId,
    origin: view.position,
    forward,
    right,
    up,
    tanHalfVerticalFov,
    tanHalfHorizontalFov: tanHalfVerticalFov * getDirectorCameraAspectValue(camera.aspectRatio),
    near: optics.nearClipM,
    far: optics.farClipM,
  };
}

// Conservative sphere-vs-frustum test: the object's bounding sphere is
// compared against the expanded frustum planes, so borderline objects are
// included rather than dropped.
function intersectsFrustum(bounds: DirectorSpatialBounds, frustum: Frustum) {
  const offset = subtract(bounds.center, frustum.origin);
  const depth = dot(offset, frustum.forward);
  const radius = Math.hypot(...bounds.size) / 2;
  if (depth + radius < frustum.near || depth - radius > frustum.far) return false;
  const projectedDepth = Math.max(depth, frustum.near);
  return (
    Math.abs(dot(offset, frustum.right)) <= projectedDepth * frustum.tanHalfHorizontalFov + radius &&
    Math.abs(dot(offset, frustum.up)) <= projectedDepth * frustum.tanHalfVerticalFov + radius
  );
}

function objectCenter(object: DirectorObject, project: DirectorProject): DirectorSpatialVec3 {
  return getDirectorSpatialBounds(object, project)?.center ?? object.transform.position;
}

function matchesNamePattern(object: DirectorObject, pattern: string): boolean {
  const needle = pattern.trim().toLocaleLowerCase();
  if (!needle) return true;
  return object.name.toLocaleLowerCase().includes(needle) || object.id.toLocaleLowerCase().includes(needle);
}

function pointBounds(position: DirectorSpatialVec3): DirectorSpatialBounds {
  return { min: position, max: position, center: position, size: [0, 0, 0] };
}

/**
 * Executes a bounded, read-only object query against Director's canonical geometry and names.
 *
 * Spatial matches sort by distance from the query's reference point; pure
 * name/kind queries sort by locale-aware name. Objects without resolvable
 * bounds fall back to their transform position for non-spatial queries but
 * are excluded from spatial modes (no geometry to intersect).
 */
export function queryDirectorObjects(project: DirectorProject, query: DirectorObjectQuery, options: QueryOptions) {
  const spatial = query.spatial;
  const frustum = spatial?.mode === "frustum" ? resolveFrustum(project, spatial.camera_id) : null;
  const nearbyObject =
    spatial?.mode === "nearby" ? project.objects.find((object) => object.id === spatial.object_id) : undefined;
  if (spatial?.mode === "nearby" && !nearbyObject) {
    throw new Error(`No object with id "${spatial.object_id}" exists.`);
  }
  const queryCenter: DirectorSpatialVec3 | null = spatial
    ? spatial.mode === "radius"
      ? spatial.center
      : spatial.mode === "nearby"
        ? objectCenter(nearbyObject!, project)
        : spatial.mode === "aabb"
          ? (spatial.min.map((value, axis) => (value + spatial.max[axis]) / 2) as DirectorSpatialVec3)
          : frustum!.origin
    : null;

  const objectListId = query.objectListId?.trim() || undefined;

  const matches = project.objects
    .filter((object) => options.includeHidden || object.visible)
    .filter((object) => spatial?.mode !== "nearby" || object.id !== spatial.object_id)
    .filter((object) => !query.kind || object.kind === query.kind)
    .filter((object) => !query.namePattern || matchesNamePattern(object, query.namePattern))
    .filter((object) => !objectListId || object.objectListId === objectListId)
    .flatMap((object) => {
      const bounds = getDirectorSpatialBounds(object, project);
      if (spatial && !bounds) return [];
      const effectiveBounds = bounds ?? pointBounds(object.transform.position);
      const matchesQuery =
        !spatial ||
        (spatial.mode === "frustum"
          ? intersectsFrustum(effectiveBounds, frustum!)
          : spatial.mode === "aabb"
            ? intersectsAabb(effectiveBounds, spatial.min, spatial.max)
            : distance(effectiveBounds.center, queryCenter!) <= spatial.radius_m);
      if (!matchesQuery) return [];
      return [
        {
          id: object.id,
          name: object.name,
          kind: object.kind,
          visible: object.visible,
          distance_m: queryCenter ? rounded(distance(effectiveBounds.center, queryCenter)) : 0,
          bounds: roundedBounds(effectiveBounds),
          ...(object.objectListId ? { object_list_id: object.objectListId } : {}),
          ...(object.objectListLabel ? { object_list_label: object.objectListLabel } : {}),
          ...(object.objectListDetached ? { object_list_detached: true } : {}),
        },
      ];
    })
    .sort((left, right) =>
      spatial
        ? left.distance_m - right.distance_m || left.id.localeCompare(right.id)
        : left.name.localeCompare(right.name, "zh") || left.id.localeCompare(right.id),
    );

  return {
    mode: spatial?.mode ?? "all",
    ...(frustum ? { camera_id: frustum.cameraId } : {}),
    ...(spatial?.mode === "nearby" ? { object_id: spatial.object_id } : {}),
    ...(query.namePattern ? { name_pattern: query.namePattern } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(objectListId ? { object_list_id: objectListId } : {}),
    ...(queryCenter ? { reference_point: roundedVec3(queryCenter) } : {}),
    match_count: matches.length,
    returned_count: Math.min(matches.length, options.maxResults),
    truncated: matches.length > options.maxResults,
    objects: matches.slice(0, options.maxResults),
  };
}
