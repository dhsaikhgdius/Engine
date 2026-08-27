/**
 * Relational spatial authoring: `place_relative`, `orient_toward`,
 * `arrange_facing_pair`, and `arrange_group`.
 *
 * These high-level author actions let an agent express placement in
 * relations ("in front of the desk", "facing the door", "arc facing the
 * camera") instead of raw coordinates. Each action is expanded by
 * {@link buildDirectorSpatialAuthoringActions} into plain `update_object`
 * transforms computed from the canonical spatial bounds
 * (directorSpatialGeometry) — footprint radii keep clearance-based spacing
 * from interpenetrating — so the output flows through the same atomic
 * executor, validation, and possession scope as any other author action.
 * Camera-referenced relations (foreground/background) resolve against the
 * named or active camera's view snapshot and are rejected without one.
 *
 * @module directorSpatialAuthoring
 */

import { z } from "zod";
import type {
  DirectorCameraShot,
  DirectorObject,
  DirectorProject,
} from "@director/project-schema";
import { getCameraViewSnapshotFromShot } from "@director/project-schema";
import { directorVec3Schema } from "@director/project-schema";
import { strictAction } from "@director/protocol/strictProtocolVariant";
import { getDirectorPlanarFootprintRadius, getDirectorPlanarSupportRadius } from "./directorSpatialGeometry";

const spatialId = z.string().trim().min(1).max(200);
const finiteNumber = z.number().finite();
const planarAxis = z.tuple([finiteNumber, finiteNumber]);
const spatialReference = z.enum(["world", "target", "camera"]);
const spatialForce = { force: z.boolean().optional() } as const;

/**
 * Zod schema for the `place_relative` spatial authoring action.
 *
 * Validates placement of a single object relative to an anchor object using
 * spatial relations (front, behind, left, right, foreground, background).
 * Enforces mutual exclusion of `distance_m` and `clearance_m`, and requires
 * `reference="camera"` for foreground/background relations.
 */
export const directorPlaceRelativeActionSchema = strictAction("place_relative", {
  object_id: spatialId,
  anchor_id: spatialId,
  relation: z.enum(["front", "behind", "left", "right", "foreground", "background"]),
  reference: spatialReference.optional(),
  camera_id: spatialId.optional(),
  distance_m: finiteNumber.positive().max(100).optional(),
  clearance_m: finiteNumber.nonnegative().max(100).optional(),
  offset_m: directorVec3Schema.optional(),
  orient: z.enum(["target", "same_direction", "reference_forward", "none"]).optional(),
  ...spatialForce,
}).superRefine((action, context) => {
  if ((action.relation === "foreground" || action.relation === "background") && action.reference !== "camera") {
    context.addIssue({
      code: "custom",
      path: ["reference"],
      message: `${action.relation} requires reference=\"camera\"`,
    });
  }
  if (action.distance_m !== undefined && action.clearance_m !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["clearance_m"],
      message: "distance_m and clearance_m cannot be used together",
    });
  }
});

/**
 * Zod schema for the `arrange_group` spatial authoring action.
 *
 * Validates arrangement of multiple objects into a line, grid, circle, or arc
 * layout. Enforces unique object IDs, non-zero axis vectors, and mutual
 * exclusion of `spacing_m` and `clearance_m`. Requires `reference_object_id`
 * when `reference="target"` and exactly one of `target_id` or `target_position`
 * when `facing="target"`.
 */
export const directorArrangeGroupActionSchema = strictAction("arrange_group", {
  object_ids: z.array(spatialId).min(2).max(64),
  layout: z.enum(["line", "grid", "circle", "arc"]),
  center: directorVec3Schema.optional(),
  reference: spatialReference.optional(),
  reference_object_id: spatialId.optional(),
  camera_id: spatialId.optional(),
  axis: planarAxis.optional(),
  heading_rad: finiteNumber
    .min(-Math.PI * 2)
    .max(Math.PI * 2)
    .optional(),
  spacing_m: finiteNumber.positive().max(100).optional(),
  clearance_m: finiteNumber.nonnegative().max(100).optional(),
  radius_m: finiteNumber.positive().max(100).optional(),
  columns: z.number().int().min(1).max(64).optional(),
  arc_degrees: finiteNumber.positive().max(359).optional(),
  facing: z.enum(["center", "outward", "same_direction", "next", "target", "none"]).optional(),
  target_id: spatialId.optional(),
  target_position: directorVec3Schema.optional(),
  ...spatialForce,
}).superRefine((action, context) => {
  if (new Set(action.object_ids).size !== action.object_ids.length) {
    context.addIssue({ code: "custom", path: ["object_ids"], message: "object_ids must be unique" });
  }
  if (action.reference === "target" && !action.reference_object_id) {
    context.addIssue({
      code: "custom",
      path: ["reference_object_id"],
      message: 'reference="target" requires reference_object_id',
    });
  }
  if (action.axis && Math.hypot(action.axis[0], action.axis[1]) <= 1e-6) {
    context.addIssue({ code: "custom", path: ["axis"], message: "axis must have non-zero length" });
  }
  if (action.facing === "target" && Boolean(action.target_id) === Boolean(action.target_position)) {
    context.addIssue({
      code: "custom",
      path: ["target_id"],
      message: 'facing="target" requires exactly one of target_id or target_position',
    });
  }
  if (action.spacing_m !== undefined && action.clearance_m !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["clearance_m"],
      message: "spacing_m and clearance_m cannot be used together",
    });
  }
});

/**
 * Zod schema for the `arrange_facing_pair` spatial authoring action.
 *
 * Validates arrangement of exactly two objects to face each other along an
 * axis. Enforces distinct object IDs, non-zero axis vectors, and mutual
 * exclusion of `distance_m` and `clearance_m`.
 */
export const directorArrangeFacingPairActionSchema = strictAction("arrange_facing_pair", {
  object_ids: z.tuple([spatialId, spatialId]),
  center: directorVec3Schema.optional(),
  axis: planarAxis.optional(),
  distance_m: finiteNumber.positive().max(100).optional(),
  clearance_m: finiteNumber.nonnegative().max(100).optional(),
  ...spatialForce,
}).superRefine((action, context) => {
  if (action.object_ids[0] === action.object_ids[1]) {
    context.addIssue({ code: "custom", path: ["object_ids"], message: "object_ids must be different" });
  }
  if (action.axis && Math.hypot(action.axis[0], action.axis[1]) <= 1e-6) {
    context.addIssue({ code: "custom", path: ["axis"], message: "axis must have non-zero length" });
  }
  if (action.distance_m !== undefined && action.clearance_m !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["clearance_m"],
      message: "distance_m and clearance_m cannot be used together",
    });
  }
});

/**
 * Zod schema for the `orient_toward` spatial authoring action.
 *
 * Validates rotation of a single object to face a target position or object.
 * Requires exactly one of `target_id` or `target_position`.
 */
export const directorOrientTowardActionSchema = strictAction("orient_toward", {
  object_id: spatialId,
  target_id: spatialId.optional(),
  target_position: directorVec3Schema.optional(),
  ...spatialForce,
}).superRefine((action, context) => {
  if (Boolean(action.target_id) === Boolean(action.target_position)) {
    context.addIssue({
      code: "custom",
      path: ["target_id"],
      message: "orient_toward requires exactly one of target_id or target_position",
    });
  }
});

/**
 * Union of all spatial authoring action types recognized by the engine.
 *
 * Includes place_relative, arrange_group, arrange_facing_pair, and orient_toward.
 */
export type DirectorSpatialAuthoringAction =
  | z.infer<typeof directorPlaceRelativeActionSchema>
  | z.infer<typeof directorArrangeGroupActionSchema>
  | z.infer<typeof directorArrangeFacingPairActionSchema>
  | z.infer<typeof directorOrientTowardActionSchema>;

/**
 * Concrete update patch produced by spatial authoring actions.
 *
 * Represents the resolved transform and look-target mutations that the engine
 * applies to a single object after spatial reasoning.
 */
export interface DirectorSpatialObjectUpdateAction {
  /** Discriminator identifying this as an object update action. */
  action: "update_object";
  /** ID of the object to mutate. */
  object_id: string;
  /** Mutations to apply to the object's transform and look target. */
  patch: {
    transform?: {
      /** World-space position in meters. */
      position?: [number, number, number];
      /** Euler rotation in radians [pitch, yaw, roll]. */
      rotation?: [number, number, number];
    };
    /** ID of the object this object should look at, or null to clear the look target. */
    look_target_object_id?: string | null;
  };
  /** When true, bypasses collision checks and other safety guards. */
  force?: boolean;
}

type Planar = { x: number; z: number };
type Basis = { right: Planar; forward: Planar };

// Cached set of spatial action discriminators for fast type-guard lookup
// without needing to instantiate Zod schemas at runtime.
const SPATIAL_ACTIONS = new Set<DirectorSpatialAuthoringAction["action"]>([
  "place_relative",
  "arrange_group",
  "arrange_facing_pair",
  "orient_toward",
]);

/**
 * Type guard that checks whether a value with an `action` field is a recognized
 * spatial authoring action.
 *
 * @param value - An object with an `action` string discriminator.
 * @returns True when the value is one of the four spatial authoring action types.
 */
export function isDirectorSpatialAuthoringAction(value: { action: string }): value is DirectorSpatialAuthoringAction {
  return SPATIAL_ACTIONS.has(value.action as DirectorSpatialAuthoringAction["action"]);
}

function objectById(project: DirectorProject, objectId: string): DirectorObject {
  const object = project.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Error(`No object with id "${objectId}" exists.`);
  // Camera transforms are authored via separate camera actions; reject them here
  // to prevent accidental spatial authoring on cameras.
  if (object.kind === "camera") throw new Error(`Use camera authoring actions for camera object "${objectId}".`);
  return object;
}

function cameraById(project: DirectorProject, cameraId?: string): DirectorCameraShot {
  // Falls back to the project's active camera when no explicit camera_id is provided.
  const resolvedId = cameraId ?? project.activeCameraId;
  if (!resolvedId) throw new Error("Camera-relative placement requires camera_id or an active camera.");
  const camera = project.cameras.find((candidate) => candidate.id === resolvedId);
  if (!camera) throw new Error(`No camera with id "${resolvedId}" exists.`);
  return camera;
}

function uniqueObjects(project: DirectorProject, objectIds: string[]): DirectorObject[] {
  if (new Set(objectIds).size !== objectIds.length) throw new Error("Spatial object_ids must be unique.");
  return objectIds.map((objectId) => objectById(project, objectId));
}

function normalizedPlanar(value: Planar, label: string): Planar {
  const length = Math.hypot(value.x, value.z);
  // Reject near-zero-length vectors to prevent NaN directions from degenerate inputs.
  if (length <= 1e-6) throw new Error(`${label} must have a non-zero horizontal length.`);
  return { x: value.x / length, z: value.z / length };
}

function rightFromForward(forward: Planar): Planar {
  return { x: forward.z, z: -forward.x };
}

function rotatePlanar(value: Planar, angle: number): Planar {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: value.x * cosine + value.z * sine, z: -value.x * sine + value.z * cosine };
}

function objectBasis(object: DirectorObject): Basis {
  const yaw = object.transform.rotation[1];
  const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
  return { forward, right: rightFromForward(forward) };
}

function cameraBasis(camera: DirectorCameraShot): Basis {
  const view = getCameraViewSnapshotFromShot(camera);
  const forward = normalizedPlanar(
    { x: view.target[0] - view.position[0], z: view.target[2] - view.position[2] },
    `Camera "${camera.id}" view direction`,
  );
  return { forward, right: rightFromForward(forward) };
}

function actionBasis(
  project: DirectorProject,
  action: {
    reference?: "world" | "target" | "camera";
    reference_object_id?: string;
    camera_id?: string;
    heading_rad?: number;
  },
  fallbackTarget?: DirectorObject,
): Basis {
  const reference = action.reference ?? "world";
  let basis: Basis;
  if (reference === "camera") {
    basis = cameraBasis(cameraById(project, action.camera_id));
  } else if (reference === "target") {
    const target = action.reference_object_id ? objectById(project, action.reference_object_id) : fallbackTarget;
    if (!target) throw new Error("Target-relative placement requires reference_object_id.");
    basis = objectBasis(target);
  } else {
    basis = { right: { x: 1, z: 0 }, forward: { x: 0, z: 1 } };
  }
  if (!action.heading_rad) return basis;
  const forward = normalizedPlanar(rotatePlanar(basis.forward, action.heading_rad), "Rotated forward direction");
  return { forward, right: rightFromForward(forward) };
}

function rounded(value: number): number {
  // Round to 6 decimal places (~0.001 mm precision) to avoid
  // floating-point drift in position comparisons and snap-to-grid.
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundedPosition(value: [number, number, number]): [number, number, number] {
  return [rounded(value[0]), rounded(value[1]), rounded(value[2])];
}

function yawToward(from: [number, number, number], target: [number, number, number]): number {
  const dx = target[0] - from[0];
  const dz = target[2] - from[2];
  // The engine's coordinate system uses Z as the forward axis;
  // atan2(dx, dz) computes the yaw angle from the +Z direction.
  if (Math.hypot(dx, dz) <= 1e-6) throw new Error("Cannot orient an object toward the same horizontal position.");
  return rounded(Math.atan2(dx, dz));
}

function rotationWithYaw(object: DirectorObject, yaw: number): [number, number, number] {
  // Preserve the object's existing pitch and roll; only replace yaw.
  return [object.transform.rotation[0], rounded(yaw), object.transform.rotation[2]];
}

function updateAction(
  object: DirectorObject,
  patch: DirectorSpatialObjectUpdateAction["patch"],
  force?: boolean,
): DirectorSpatialObjectUpdateAction {
  return {
    action: "update_object",
    object_id: object.id,
    patch,
    // Only include force when explicitly provided to avoid polluting
    // the patch with an undefined key.
    ...(force === undefined ? {} : { force }),
  };
}

function averageCenter(objects: DirectorObject[]): [number, number, number] {
  // Arithmetic mean of all object positions; used as the default center
  // when no explicit center is specified for group arrangements.
  const total = objects.reduce(
    (sum, object) => [
      sum[0] + object.transform.position[0],
      sum[1] + object.transform.position[1],
      sum[2] + object.transform.position[2],
    ],
    [0, 0, 0],
  );
  return roundedPosition([total[0] / objects.length, total[1] / objects.length, total[2] / objects.length]);
}

function buildPlaceRelative(
  project: DirectorProject,
  action: z.infer<typeof directorPlaceRelativeActionSchema>,
): DirectorSpatialObjectUpdateAction[] {
  const object = objectById(project, action.object_id);
  const anchor = objectById(project, action.anchor_id);
  if (object.id === anchor.id) throw new Error("place_relative object_id and anchor_id must be different.");
  const basis = actionBasis(project, action, anchor);
  let direction: Planar;
  switch (action.relation) {
    case "front":
      direction = basis.forward;
      break;
    case "behind":
      direction = { x: -basis.forward.x, z: -basis.forward.z };
      break;
    case "left":
      direction = { x: -basis.right.x, z: -basis.right.z };
      break;
    case "right":
      direction = basis.right;
      break;
    case "foreground":
      if ((action.reference ?? "world") !== "camera") {
        throw new Error('foreground is only valid with reference="camera".');
      }
      direction = { x: -basis.forward.x, z: -basis.forward.z };
      break;
    case "background":
      if ((action.reference ?? "world") !== "camera") {
        throw new Error('background is only valid with reference="camera".');
      }
      direction = basis.forward;
      break;
  }
  const orient = action.orient ?? "none";
  // Default clearance of 0.6 m provides a comfortable personal-space gap
  // between objects. When orient is "none", use the support radius in the
  // opposite direction (the object's "back") since the object keeps its
  // current facing; otherwise use the conservative footprint radius.
  const distance =
    action.distance_m ??
    getDirectorPlanarSupportRadius(anchor, direction, project) +
      (orient === "none"
        ? getDirectorPlanarSupportRadius(object, { x: -direction.x, z: -direction.z }, project)
        : getDirectorPlanarFootprintRadius(object, project)) +
      (action.clearance_m ?? 0.6);
  const offset = action.offset_m ?? [0, 0, 0];
  const anchorPosition = anchor.transform.position;
  const position = roundedPosition([
    anchorPosition[0] + direction.x * distance + basis.right.x * offset[0] + basis.forward.x * offset[2],
    anchorPosition[1] + offset[1],
    anchorPosition[2] + direction.z * distance + basis.right.z * offset[0] + basis.forward.z * offset[2],
  ]);
  const patch: DirectorSpatialObjectUpdateAction["patch"] = { transform: { position } };
  if (orient === "target") {
    patch.transform!.rotation = rotationWithYaw(object, yawToward(position, anchorPosition));
    patch.look_target_object_id = anchor.id;
  } else if (orient === "same_direction") {
    patch.transform!.rotation = rotationWithYaw(object, anchor.transform.rotation[1]);
    patch.look_target_object_id = null;
  } else if (orient === "reference_forward") {
    patch.transform!.rotation = rotationWithYaw(object, Math.atan2(basis.forward.x, basis.forward.z));
    patch.look_target_object_id = null;
  }
  return [updateAction(object, patch, action.force)];
}

function groupPositions(
  count: number,
  action: z.infer<typeof directorArrangeGroupActionSchema>,
  center: [number, number, number],
  basis: Basis,
  spacing: number,
): [number, number, number][] {
  const configuredAxis = action.axis
    ? normalizedPlanar({ x: action.axis[0], z: action.axis[1] }, "arrange_group axis")
    : basis.right;
  const right = configuredAxis;
  const forward = { x: -right.z, z: right.x };
  if (action.layout === "line") {
    return Array.from({ length: count }, (_, index) => {
      const offset = (index - (count - 1) / 2) * spacing;
      return roundedPosition([center[0] + right.x * offset, center[1], center[2] + right.z * offset]);
    });
  }
  if (action.layout === "grid") {
    const columns = Math.min(count, action.columns ?? Math.ceil(Math.sqrt(count)));
    const rows = Math.ceil(count / columns);
    return Array.from({ length: count }, (_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const rowLength = Math.min(columns, count - row * columns);
      const rightOffset = (column - (rowLength - 1) / 2) * spacing;
      const forwardOffset = (row - (rows - 1) / 2) * spacing;
      return roundedPosition([
        center[0] + right.x * rightOffset + forward.x * forwardOffset,
        center[1],
        center[2] + right.z * rightOffset + forward.z * forwardOffset,
      ]);
    });
  }
  const arcRadians = ((action.arc_degrees ?? 180) * Math.PI) / 180;
  const minimumRadius =
    action.layout === "circle"
      ? spacing / Math.max(1e-6, 2 * Math.sin(Math.PI / count))
      : spacing / Math.max(1e-6, 2 * Math.sin(arcRadians / (2 * (count - 1))));
  const radius = action.radius_m ?? minimumRadius;
  return Array.from({ length: count }, (_, index) => {
    const angle =
      action.layout === "circle"
        ? (index / count) * Math.PI * 2
        : count === 1
          ? 0
          : -arcRadians / 2 + (index / (count - 1)) * arcRadians;
    const radial = {
      x: forward.x * Math.cos(angle) + right.x * Math.sin(angle),
      z: forward.z * Math.cos(angle) + right.z * Math.sin(angle),
    };
    return roundedPosition([center[0] + radial.x * radius, center[1], center[2] + radial.z * radius]);
  });
}

function buildArrangeGroup(
  project: DirectorProject,
  action: z.infer<typeof directorArrangeGroupActionSchema>,
): DirectorSpatialObjectUpdateAction[] {
  const objects = uniqueObjects(project, action.object_ids);
  const referenceObject = action.reference_object_id ? objectById(project, action.reference_object_id) : undefined;
  const basis = actionBasis(project, action, referenceObject);
  const center = action.center ?? averageCenter(objects);
  const footprintRadii = objects.map((object) => getDirectorPlanarFootprintRadius(object, project));
  // Use the two largest footprint radii to compute default spacing,
  // ensuring no two objects overlap even when the two largest are adjacent.
  const largestRadii = [...footprintRadii].sort((left, right) => right - left);
  // Default clearance of 0.45 m is slightly tighter than place_relative
  // since groups are intentional compositions where tighter packing is expected.
  const spacing =
    action.spacing_m ??
    (largestRadii[0] ?? 0.5) + (largestRadii[1] ?? largestRadii[0] ?? 0.5) + (action.clearance_m ?? 0.45);
  const positions = groupPositions(objects.length, action, center, basis, spacing);
  const facing = action.facing ?? "none";
  if (facing === "target" && Boolean(action.target_id) === Boolean(action.target_position)) {
    throw new Error('arrange_group facing="target" requires exactly one of target_id or target_position.');
  }
  const targetObject = action.target_id ? objectById(project, action.target_id) : null;
  if (targetObject && objects.some((object) => object.id === targetObject.id)) {
    throw new Error("arrange_group target_id must not also appear in object_ids.");
  }
  return objects.map((object, index) => {
    const position = positions[index];
    const patch: DirectorSpatialObjectUpdateAction["patch"] = { transform: { position } };
    let targetPosition: [number, number, number] | null = null;
    let lookTargetId: string | null | undefined;
    if (facing === "center") {
      targetPosition = center;
      lookTargetId = null;
    } else if (facing === "outward") {
      targetPosition = roundedPosition([
        position[0] + (position[0] - center[0]),
        position[1],
        position[2] + (position[2] - center[2]),
      ]);
      lookTargetId = null;
    } else if (facing === "same_direction") {
      targetPosition = roundedPosition([position[0] + basis.forward.x, position[1], position[2] + basis.forward.z]);
      lookTargetId = null;
    } else if (facing === "next") {
      const nextIndex = (index + 1) % objects.length;
      targetPosition = positions[nextIndex];
      lookTargetId = objects[nextIndex].id;
    } else if (facing === "target") {
      targetPosition = targetObject?.transform.position ?? action.target_position!;
      lookTargetId = targetObject?.id ?? null;
    }
    if (targetPosition) {
      patch.transform!.rotation = rotationWithYaw(object, yawToward(position, targetPosition));
      patch.look_target_object_id = lookTargetId ?? null;
    }
    return updateAction(object, patch, action.force);
  });
}

function buildArrangeFacingPair(
  project: DirectorProject,
  action: z.infer<typeof directorArrangeFacingPairActionSchema>,
): DirectorSpatialObjectUpdateAction[] {
  const [left, right] = uniqueObjects(project, action.object_ids);
  const center = action.center ?? averageCenter([left, right]);
  const axis = action.axis
    ? normalizedPlanar({ x: action.axis[0], z: action.axis[1] }, "arrange_facing_pair axis")
    : { x: 1, z: 0 };
  const distance =
    action.distance_m ??
    // Default clearance of 0.6 m matches place_relative for consistency
    // across single-pair and single-object placement operations.
    getDirectorPlanarFootprintRadius(left, project) +
      getDirectorPlanarFootprintRadius(right, project) +
      (action.clearance_m ?? 0.6);
  const halfDistance = distance / 2;
  const leftPosition = roundedPosition([
    center[0] - axis.x * halfDistance,
    center[1],
    center[2] - axis.z * halfDistance,
  ]);
  const rightPosition = roundedPosition([
    center[0] + axis.x * halfDistance,
    center[1],
    center[2] + axis.z * halfDistance,
  ]);
  return [
    updateAction(
      left,
      {
        transform: {
          position: leftPosition,
          rotation: rotationWithYaw(left, yawToward(leftPosition, rightPosition)),
        },
        look_target_object_id: right.id,
      },
      action.force,
    ),
    updateAction(
      right,
      {
        transform: {
          position: rightPosition,
          rotation: rotationWithYaw(right, yawToward(rightPosition, leftPosition)),
        },
        look_target_object_id: left.id,
      },
      action.force,
    ),
  ];
}

function buildOrientToward(
  project: DirectorProject,
  action: z.infer<typeof directorOrientTowardActionSchema>,
): DirectorSpatialObjectUpdateAction[] {
  // Duplicate the schema refinement check here because runtime callers
  // may bypass Zod validation and pass raw action objects.
  if (Boolean(action.target_id) === Boolean(action.target_position)) {
    throw new Error("orient_toward requires exactly one of target_id or target_position.");
  }
  const object = objectById(project, action.object_id);
  const targetObject = action.target_id ? objectById(project, action.target_id) : null;
  if (targetObject?.id === object.id) throw new Error("An object cannot orient toward itself.");
  const targetPosition = targetObject?.transform.position ?? action.target_position!;
  return [
    updateAction(
      object,
      {
        transform: { rotation: rotationWithYaw(object, yawToward(object.transform.position, targetPosition)) },
        look_target_object_id: targetObject?.id ?? null,
      },
      action.force,
    ),
  ];
}

/**
 * Resolves a spatial authoring action into concrete per-object update patches.
 *
 * Computes positions, rotations, and look-targets based on the current project
 * state, object geometry, and the action's spatial constraints. Returns one
 * update action per affected object.
 *
 * @param project - The current project state used for object and camera lookups.
 * @param action - The spatial authoring action to resolve.
 * @returns An array of update actions, one per object whose transform changes.
 * @throws {Error} When referenced objects or cameras are missing, or when
 *   spatial constraints cannot be satisfied (e.g., orienting an object toward itself).
 */
export function buildDirectorSpatialAuthoringActions(
  project: DirectorProject,
  action: DirectorSpatialAuthoringAction,
): DirectorSpatialObjectUpdateAction[] {
  switch (action.action) {
    case "place_relative":
      return buildPlaceRelative(project, action);
    case "arrange_group":
      return buildArrangeGroup(project, action);
    case "arrange_facing_pair":
      return buildArrangeFacingPair(project, action);
    case "orient_toward":
      return buildOrientToward(project, action);
  }
}
