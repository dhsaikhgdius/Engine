/**
 * The `audit` operation: structural, spatial, timeline, storyboard, and
 * camera-framing validation with machine-applicable fixes.
 *
 * Audit is the checking step of the workbench loop (author → observe/diff →
 * audit). It runs only the passes named in {@link DIRECTOR_AUDIT_SCOPE};
 * `ready` means zero error-severity structural issues and is explicitly not
 * a visual judgment ({@link DIRECTOR_AUDIT_VISUAL_JUDGMENT}) — visual
 * acceptance is a 35–65 mm capture. Where possible an issue carries a
 * `suggested_fix` expressed as ordinary author actions, so an agent can
 * apply the fix through the same atomic vocabulary it already uses.
 *
 * The spatial pass classifies every object's placement (grounded, supported,
 * attached, suspended, or unresolved) against computed bounds with small
 * epsilon tolerances, and validates each declared `placementMode` against
 * the resolved reality.
 *
 * @module directorAudit
 */

import type {
  DirectorEntityAnimation,
  DirectorObject,
  DirectorPlacementMode,
  DirectorProject,
  DirectorTransform,
} from "@director/project-schema";
import { createDefaultScene } from "@director/stage-protocol";
import { executeStageTool } from "./commandEngine";
import { directorProjectToStageScene } from "./directorStageAdapter";
import { getDirectorProjectGraphIssues } from "./directorProjectGraph";
import type { DirectorAuthoringAction } from "./directorAuthoring";
import { findDirectorAgentCatalogAssetsByClaim, getDirectorAgentCatalogAsset } from "./directorAgentAssetCatalog";
import { DEFAULT_MIXAMO_CHARACTER_ASSET_ID } from "@director/dcc-interchange";
import { getDirectorSpatialBounds, type DirectorSpatialBounds } from "./directorSpatialGeometry";

/** Severity tier for an audit issue, driving whether the project is considered ready. */
export type DirectorAuditSeverity = "error" | "warning" | "info";

/** A single audit finding produced by structural or spatial project validation. */
export interface DirectorAuditIssue {
  /** How severe the issue is — errors block the ready signal. */
  severity: DirectorAuditSeverity;
  /** Stable machine-readable issue code for programmatic handling. */
  code: string;
  /** Human-readable description of the problem. */
  message: string;
  /** IDs of the entities (objects, cameras, assets) implicated in the issue. */
  entity_ids?: string[];
  /** Optional suggested fix expressed as a set of authoring actions. */
  suggested_fix?: {
    kind: "author_actions";
    actions: DirectorAuthoringAction[];
  };
}

/** Passes that `audit` actually runs. It never scores pixels, photorealism, or semantic recognition. */
export const DIRECTOR_AUDIT_SCOPE = ["structure", "spatial", "timeline", "storyboard", "camera_framing"] as const;

/** Explicit marker that `ready` is not a visual-quality judgment. */
export const DIRECTOR_AUDIT_VISUAL_JUDGMENT = false;

const DIRECTOR_AUDIT_SCOPE_NOTE =
  "`ready` means zero error-severity structural issues. It is not a visual-quality, photorealism, or semantic-recognition judgment. Use capture or author.evidence for appearance; do not claim a scene looks finished from audit alone.";

/** Options that control which audit passes run and which camera is used for framing validation. */
export interface DirectorAuditOptions {
  /** Override the camera used for framing critique; defaults to the project's active camera. */
  camera_id?: string;
  /** Subject entity ID to focus the framing critique on. */
  subject_id?: string;
  /** When false, skips the spatial placement audit pass. Defaults to true. */
  include_spatial?: boolean;
}

// Round position components to 2 decimal places for stable bucketing of
// co-located objects, avoiding floating-point noise in equality checks.
function stablePosition(position: DirectorTransform["position"]) {
  return position.map((value) => Math.round(value * 100) / 100).join(",");
}

/** Internal pairing of a scene object with its computed spatial bounding box. */
interface SpatialEntry {
  object: DirectorObject;
  bounds: DirectorSpatialBounds;
}

/**
 * The concrete placement mode resolved by the spatial classifier.
 * `unresolved` means no ground, support, attach, or suspend rule matched.
 */
export type DirectorResolvedPlacementMode = Exclude<DirectorPlacementMode, "auto"> | "unresolved";

/** A single object's placement classification result. */
export interface DirectorSpatialPlacement {
  /** The object this placement applies to. */
  object_id: string;
  /** The original placementMode from the project data, or "auto" when absent. */
  declared_mode: DirectorPlacementMode;
  /** The concrete placement mode resolved by spatial analysis. */
  resolved_mode: DirectorResolvedPlacementMode;
  /** Whether the object's placement is valid under its declared mode. */
  valid: boolean;
  /** When resolved as supported/attached/suspended, the ID of the anchor object. */
  anchor_object_id?: string;
}

/** Summary of the spatial placement classification pass across all scene objects. */
export interface DirectorSpatialAuditSummary {
  /** Contract version for forward compatibility. */
  contract_version: 1;
  /** Per-object placement results in scene order. */
  placements: DirectorSpatialPlacement[];
  /** Count of objects in each resolved placement mode. */
  counts: Record<DirectorResolvedPlacementMode, number>;
}

// Allowable vertical gap (in meters) between an object's bottom face and its
// support surface before it is considered unsupported.
const SUPPORT_EPSILON = 0.08;
// Allowable vertical gap (in meters) between an object's bottom face and the
// ground plane before it is considered ungrounded.
const GROUND_EPSILON = 0.06;

// Convenience helper to construct a suggested fix from one or more authoring actions.
function authorActionsFix(...actions: DirectorAuthoringAction[]): NonNullable<DirectorAuditIssue["suggested_fix"]> {
  return { kind: "author_actions", actions };
}

// Round a value to 6 decimal places to avoid floating-point drift in
// position comparisons and serialized transforms.
function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// Compute a grounded position by replacing the object's Y with the target
// ground height while preserving X and Z.
function groundedPosition(object: DirectorObject, targetY: number): DirectorTransform["position"] {
  return [object.transform.position[0], rounded(targetY), object.transform.position[2]];
}

// Clamp all keyframes to lie within [frameStart, frameEnd]. Keyframes that
// land on the same frame after clamping are deduplicated by keeping the last
// one encountered (stable Map insertion order).
function clampAnimationToTimeline(
  animation: DirectorEntityAnimation,
  frameStart: number,
  frameEnd: number,
): DirectorEntityAnimation {
  const keyframesByFrame = new Map<number, DirectorEntityAnimation["keyframes"][number]>();
  animation.keyframes.forEach((keyframe) => {
    const frame = Math.min(frameEnd, Math.max(frameStart, keyframe.frame));
    keyframesByFrame.set(frame, { ...structuredClone(keyframe), frame });
  });
  return {
    ...structuredClone(animation),
    keyframes: [...keyframesByFrame.values()].sort((left, right) => left.frame - right.frame),
  };
}

// Length of the overlap between two 1D intervals, or 0 when they are disjoint.
function intervalOverlap(leftMin: number, leftMax: number, rightMin: number, rightMax: number) {
  return Math.max(0, Math.min(leftMax, rightMax) - Math.max(leftMin, rightMin));
}

// Ratio of the XZ-footprint overlap area relative to the smaller footprint.
// Used to judge whether one object's base rests on another's top surface.
function footprintOverlapRatio(left: DirectorSpatialBounds, right: DirectorSpatialBounds) {
  const overlap =
    intervalOverlap(left.min[0], left.max[0], right.min[0], right.max[0]) *
    intervalOverlap(left.min[2], left.max[2], right.min[2], right.max[2]);
  const smaller = Math.min(left.size[0] * left.size[2], right.size[0] * right.size[2]);
  return smaller > 0 ? overlap / smaller : 0;
}

// Ratio of the 3D bounding-volume intersection relative to the smaller volume.
// Used to detect objects that visually intersect each other.
function intersectionRatio(left: DirectorSpatialBounds, right: DirectorSpatialBounds) {
  const intersection =
    intervalOverlap(left.min[0], left.max[0], right.min[0], right.max[0]) *
    intervalOverlap(left.min[1], left.max[1], right.min[1], right.max[1]) *
    intervalOverlap(left.min[2], left.max[2], right.min[2], right.max[2]);
  const smaller = Math.min(left.size[0] * left.size[1] * left.size[2], right.size[0] * right.size[1] * right.size[2]);
  return smaller > 0 ? intersection / smaller : 0;
}

// Returns true when `bounds` sits on top of `support` within the allowable
// vertical gap and with at least 18% footprint overlap.
function restsOnTop(bounds: DirectorSpatialBounds, support: DirectorSpatialBounds) {
  const topGap = bounds.min[1] - support.max[1];
  return Math.abs(topGap) <= SUPPORT_EPSILON && footprintOverlapRatio(bounds, support) >= 0.18;
}

// Returns true when the object's bottom face touches or slightly penetrates
// the ground plane within the allowable tolerance.
function hasGroundContact(bounds: DirectorSpatialBounds, ground: number) {
  return (
    Math.abs(bounds.min[1] - ground) <= GROUND_EPSILON ||
    (bounds.min[1] < ground && bounds.max[1] >= ground - GROUND_EPSILON)
  );
}

// Returns true when `parent`'s center is at or above `child`'s center and
// their footprints overlap by at least 5%, qualifying as an overhead anchor.
function isOverheadAnchor(child: DirectorSpatialBounds, parent: DirectorSpatialBounds) {
  return parent.center[1] >= child.center[1] - SUPPORT_EPSILON && footprintOverlapRatio(child, parent) >= 0.05;
}

/**
 * Resolves the declared placement contract without guessing from object names.
 * Legacy `auto` objects may resolve from real ground/support contact, but an
 * unsupported auto object stays unresolved so an Agent must classify intent.
 */
export function classifyDirectorSpatialPlacements(
  entries: SpatialEntry[],
  ground: number,
): DirectorSpatialAuditSummary {
  const entryById = new Map(entries.map((entry) => [entry.object.id, entry]));
  const supportCandidates = new Map<string, SpatialEntry[]>();
  const placements = new Map<string, DirectorSpatialPlacement>();

  entries.forEach(({ object, bounds }) => {
    const declaredMode = object.placementMode ?? "auto";
    if (declaredMode === "floating") {
      placements.set(object.id, {
        object_id: object.id,
        declared_mode: declaredMode,
        resolved_mode: "floating",
        valid: true,
      });
      return;
    }
    if ((declaredMode === "auto" || declaredMode === "grounded") && hasGroundContact(bounds, ground)) {
      placements.set(object.id, {
        object_id: object.id,
        declared_mode: declaredMode,
        resolved_mode: "grounded",
        valid: true,
      });
      return;
    }
    placements.set(object.id, {
      object_id: object.id,
      declared_mode: declaredMode,
      resolved_mode: "unresolved",
      valid: false,
    });
  });

  const supportsByTop = entries
    .map((entry, index) => ({ entry, index, top: entry.bounds.max[1] }))
    .filter(({ entry }) => entry.object.kind !== "character")
    .sort((left, right) => left.top - right.top || left.index - right.index);
  entries.forEach((entry) => {
    const declaredMode = entry.object.placementMode ?? "auto";
    if (declaredMode !== "auto" && declaredMode !== "supported") return;
    const minimumTop = entry.bounds.min[1] - SUPPORT_EPSILON;
    let start = 0;
    let end = supportsByTop.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (supportsByTop[middle].top < minimumTop) start = middle + 1;
      else end = middle;
    }
    const candidates: Array<{ entry: SpatialEntry; index: number }> = [];
    for (let index = start; index < supportsByTop.length; index += 1) {
      const candidate = supportsByTop[index];
      if (candidate.top > entry.bounds.min[1] + SUPPORT_EPSILON) break;
      if (candidate.entry.object.id !== entry.object.id && restsOnTop(entry.bounds, candidate.entry.bounds)) {
        candidates.push(candidate);
      }
    }
    candidates.sort((left, right) => left.index - right.index);
    supportCandidates.set(
      entry.object.id,
      candidates.map((candidate) => candidate.entry),
    );
  });

  // Placement chains can be arbitrarily ordered in JSON. Resolve one level per
  // pass; the bounded pass count also makes malformed cycles terminate.
  for (let pass = 0; pass < entries.length; pass += 1) {
    let changed = false;
    entries.forEach(({ object, bounds }) => {
      const placement = placements.get(object.id)!;
      if (placement.valid) return;
      const declaredMode = placement.declared_mode;

      if (declaredMode === "auto" || declaredMode === "supported") {
        const support = supportCandidates
          .get(object.id)
          ?.find((candidate) => placements.get(candidate.object.id)?.valid);
        if (support) {
          placements.set(object.id, {
            object_id: object.id,
            declared_mode: declaredMode,
            resolved_mode: "supported",
            valid: true,
            anchor_object_id: support.object.id,
          });
          changed = true;
        }
        return;
      }

      if (declaredMode !== "attached" && declaredMode !== "suspended") return;
      if (!object.parentObjectId) return;
      const parent = entryById.get(object.parentObjectId);
      if (!parent || !placements.get(parent.object.id)?.valid) return;
      if (declaredMode === "suspended" && !isOverheadAnchor(bounds, parent.bounds)) return;
      placements.set(object.id, {
        object_id: object.id,
        declared_mode: declaredMode,
        resolved_mode: declaredMode,
        valid: true,
        anchor_object_id: parent.object.id,
      });
      changed = true;
    });
    if (!changed) break;
  }

  const counts: DirectorSpatialAuditSummary["counts"] = {
    grounded: 0,
    supported: 0,
    attached: 0,
    suspended: 0,
    floating: 0,
    unresolved: 0,
  };
  const orderedPlacements = entries.map(({ object }) => placements.get(object.id)!);
  orderedPlacements.forEach((placement) => {
    counts[placement.resolved_mode] += 1;
  });
  return { contract_version: 1, placements: orderedPlacements, counts };
}

// Validate timeline metadata (FPS, frame range, playhead) and check every
// animation keyframe for duplications and out-of-range placement.
function addTimelineIssues(project: DirectorProject, issues: DirectorAuditIssue[]) {
  const timeline = project.scene.timeline;
  if (!timeline) return;
  if (timeline.fps <= 0)
    issues.push({ severity: "error", code: "invalid_fps", message: "Timeline FPS must be greater than zero." });
  if (timeline.frameEnd <= timeline.frameStart) {
    issues.push({
      severity: "error",
      code: "invalid_frame_range",
      message: "Timeline frameEnd must be greater than frameStart.",
    });
  }
  if (timeline.currentFrame < timeline.frameStart || timeline.currentFrame > timeline.frameEnd) {
    issues.push({
      severity: "warning",
      code: "playhead_outside_range",
      message: "The playhead is outside the timeline range.",
      suggested_fix: authorActionsFix({
        action: "set_scene",
        patch: {
          timeline: {
            ...structuredClone(timeline),
            currentFrame: Math.min(timeline.frameEnd, Math.max(timeline.frameStart, timeline.currentFrame)),
          },
        },
      }),
    });
  }

  const animations = [
    ...project.objects.flatMap((object) =>
      object.animation ? [{ id: object.id, target_type: "object" as const, animation: object.animation }] : [],
    ),
    ...project.cameras.flatMap((camera) =>
      camera.animation ? [{ id: camera.id, target_type: "camera" as const, animation: camera.animation }] : [],
    ),
  ];
  animations.forEach(({ id, target_type, animation }) => {
    const suggested_fix = authorActionsFix({
      action: "set_animation",
      target_type,
      target_id: id,
      animation: clampAnimationToTimeline(animation, timeline.frameStart, timeline.frameEnd),
    });
    const seen = new Set<number>();
    animation.keyframes.forEach((keyframe) => {
      if (seen.has(keyframe.frame)) {
        issues.push({
          severity: "warning",
          code: "duplicate_keyframe",
          message: `${id} has more than one keyframe at frame ${keyframe.frame}.`,
          entity_ids: [id],
          suggested_fix,
        });
      }
      seen.add(keyframe.frame);
      if (keyframe.frame < timeline.frameStart || keyframe.frame > timeline.frameEnd) {
        issues.push({
          severity: "warning",
          code: "keyframe_outside_range",
          message: `${id} has a keyframe outside the active timeline at frame ${keyframe.frame}.`,
          entity_ids: [id],
          suggested_fix,
        });
      }
    });
  });
}

// Verify that the active camera is referenced by at least one storyboard shot.
// If not, rendering would validate a different shot than the edit timeline.
function addStoryboardIssues(project: DirectorProject, issues: DirectorAuditIssue[]) {
  if (!project.storyboard?.shots.length) return;
  const storyboardCameraIds = new Set(
    project.storyboard.shots.flatMap((shot) => (shot.cameraId ? [shot.cameraId] : [])),
  );
  if (project.activeCameraId && !storyboardCameraIds.has(project.activeCameraId)) {
    const firstStoryboardCameraId = project.storyboard.shots.find((shot) => shot.cameraId)?.cameraId;
    issues.push({
      severity: "error",
      code: "active_camera_outside_storyboard",
      message: `Active camera ${project.activeCameraId} is not used by the storyboard. Rendering would validate a different shot than the edit timeline.`,
      entity_ids: [project.activeCameraId],
      ...(firstStoryboardCameraId
        ? { suggested_fix: authorActionsFix({ action: "set_active_camera", camera_id: firstStoryboardCameraId }) }
        : {}),
    });
  }
}

// Run the full spatial audit pass: scale checks, placement classification,
// ground-plane violations, facing-angle validation, volume intersections,
// spatial outliers, and co-location detection.
function addSpatialIssues(project: DirectorProject, issues: DirectorAuditIssue[]): DirectorSpatialAuditSummary {
  const renderable = project.objects.filter((object) => object.kind !== "camera" && object.visible);
  const entries = renderable.flatMap((object) => {
    const bounds = getDirectorSpatialBounds(object, project);
    return bounds ? [{ object, bounds }] : [];
  });
  const ground = project.scene.groundHeight;
  const spatial = classifyDirectorSpatialPlacements(entries, ground);
  const placementById = new Map(spatial.placements.map((placement) => [placement.object_id, placement]));
  const spatialEntryById = new Map(entries.map((entry) => [entry.object.id, entry]));
  renderable.forEach((object) => {
    const scales = object.transform.scale.map(Math.abs);
    if (scales.some((value) => value <= 0.001)) {
      const normalizedScale = object.transform.scale.map((value) =>
        Math.abs(value) <= 0.001 ? 1 : value,
      ) as DirectorTransform["scale"];
      issues.push({
        severity: "error",
        code: "collapsed_scale",
        message: `${object.name} has a zero or collapsed scale.`,
        entity_ids: [object.id],
        suggested_fix: authorActionsFix({
          action: "update_object",
          object_id: object.id,
          patch: { transform: { scale: normalizedScale } },
        }),
      });
    } else if (scales.some((value) => value < 0.02 || value > 50)) {
      issues.push({
        severity: "warning",
        code: "extreme_scale",
        message: `${object.name} has an extreme scale and may be invisible or dominate the stage.`,
        entity_ids: [object.id],
      });
    }
    const placementMode = object.placementMode ?? "auto";
    if (
      project.scene.showGround &&
      object.kind === "character" &&
      (placementMode === "auto" || placementMode === "grounded")
    ) {
      const offset = object.transform.position[1] - ground;
      if (offset < -0.08) {
        issues.push({
          severity: "error",
          code: "character_below_ground",
          message: `${object.name} is ${Math.abs(offset).toFixed(2)} units below the ground.`,
          entity_ids: [object.id],
          suggested_fix: authorActionsFix({
            action: "update_object",
            object_id: object.id,
            patch: { transform: { position: groundedPosition(object, ground) } },
          }),
        });
      }
    }
  });

  const objectById = new Map(project.objects.map((object) => [object.id, object]));
  renderable.forEach((object) => {
    if (object.kind !== "character" || !object.lookTargetObjectId) return;
    const target = objectById.get(object.lookTargetObjectId);
    if (!target) return;
    const dx = target.transform.position[0] - object.transform.position[0];
    const dz = target.transform.position[2] - object.transform.position[2];
    const distance = Math.hypot(dx, dz);
    if (distance <= 0.001) return;
    const yaw = object.transform.rotation[1];
    const alignment = Math.sin(yaw) * (dx / distance) + Math.cos(yaw) * (dz / distance);
    if (alignment >= Math.cos((22 * Math.PI) / 180)) return;
    const correctedYaw = rounded(Math.atan2(dx, dz));
    issues.push({
      severity: "error",
      code: "character_facing_mismatch",
      message: `${object.name} is not facing its authored look target ${target.name}.`,
      entity_ids: [object.id, target.id],
      ...(!object.locked
        ? {
            suggested_fix: authorActionsFix({
              action: "update_object",
              object_id: object.id,
              patch: {
                transform: {
                  rotation: [object.transform.rotation[0], correctedYaw, object.transform.rotation[2]],
                },
              },
            }),
          }
        : {}),
    });
  });

  if (project.scene.showGround) {
    entries.forEach(({ object, bounds }) => {
      const placementMode = object.placementMode ?? "auto";
      const placement = placementById.get(object.id)!;
      if (placementMode === "floating") return;
      if (object.kind === "character" && object.transform.position[1] < ground - 0.08) return;

      if (placementMode === "attached") {
        if (!object.parentObjectId) {
          issues.push({
            severity: "error",
            code: "attached_object_missing_parent",
            message: `${object.name} is marked attached but has no parent object.`,
            entity_ids: [object.id],
          });
        } else if (!placement.valid) {
          issues.push({
            severity: "error",
            code: "attached_object_unsupported_parent",
            message: `${object.name} is attached to a parent whose own placement is unresolved.`,
            entity_ids: [object.id, object.parentObjectId],
          });
        }
        return;
      }

      if (placementMode === "suspended") {
        if (!object.parentObjectId) {
          issues.push({
            severity: "error",
            code: "suspended_object_missing_parent",
            message: `${object.name} is marked suspended but has no overhead parent anchor.`,
            entity_ids: [object.id],
          });
          return;
        }
        const parentPlacement = placementById.get(object.parentObjectId);
        if (!parentPlacement?.valid) {
          issues.push({
            severity: "error",
            code: "suspended_object_unsupported_parent",
            message: `${object.name} is suspended from a parent whose own placement is unresolved.`,
            entity_ids: [object.id, object.parentObjectId],
          });
          return;
        }
        const parentEntry = spatialEntryById.get(object.parentObjectId);
        if (!parentEntry || !isOverheadAnchor(bounds, parentEntry.bounds)) {
          issues.push({
            severity: "error",
            code: "suspended_object_anchor_not_overhead",
            message: `${object.name} is marked suspended, but its parent is not spatially above its footprint. Use attached for a wall or side mount.`,
            entity_ids: [object.id, object.parentObjectId],
          });
        }
        return;
      }

      const bottom = bounds.min[1];
      const top = bounds.max[1];
      const grounded = hasGroundContact(bounds, ground);
      if (placementMode === "grounded" && !grounded) {
        const targetY = object.transform.position[1] + ground - bottom;
        issues.push({
          severity: "error",
          code: "object_not_grounded",
          message: `${object.name} uses a floor pivot but starts at Y=${bottom.toFixed(2)} instead of ground Y=${ground.toFixed(2)}.`,
          entity_ids: [object.id],
          suggested_fix: authorActionsFix({
            action: "update_object",
            object_id: object.id,
            patch: { transform: { position: groundedPosition(object, targetY) } },
          }),
        });
        return;
      }

      if (placementMode === "supported" && !placement.valid) {
        issues.push({
          severity: "error",
          code: "supported_object_missing_support",
          message: `${object.name} is marked supported but does not rest on a spatially resolved object.`,
          entity_ids: [object.id],
        });
        return;
      }

      if (top < ground - GROUND_EPSILON) {
        issues.push({
          severity: "error",
          code: "object_below_ground",
          message: `${object.name} is fully below the ground plane.`,
          entity_ids: [object.id],
          ...(placementMode === "grounded"
            ? {
                suggested_fix: authorActionsFix({
                  action: "update_object",
                  object_id: object.id,
                  patch: {
                    transform: {
                      position: groundedPosition(object, object.transform.position[1] + ground - bottom),
                    },
                  },
                }),
              }
            : {}),
        });
        return;
      }
      if (bottom < ground - GROUND_EPSILON && top > ground + GROUND_EPSILON) {
        const penetration = (ground - bottom) / Math.max(bounds.size[1], 0.001);
        if (penetration > 0.18) {
          const targetY = object.transform.position[1] + ground - bottom;
          issues.push({
            severity: "error",
            code: "ground_penetration",
            message: `${object.name} penetrates ${(penetration * 100).toFixed(0)}% of its height into the ground.`,
            entity_ids: [object.id],
            ...(placementMode === "grounded"
              ? {
                  suggested_fix: authorActionsFix({
                    action: "update_object",
                    object_id: object.id,
                    patch: { transform: { position: groundedPosition(object, targetY) } },
                  }),
                }
              : {}),
          });
        }
      }
      if (!grounded && !placement.valid) {
        issues.push({
          severity: "error",
          code: "unsupported_object",
          message: `${object.name} is ${Math.max(0, bottom - ground).toFixed(2)} units above the ground with no resolved placement intent. Classify it as grounded, supported, attached, suspended, or floating before correction.`,
          entity_ids: [object.id],
        });
      }
    });
  }

  const intersectionCandidates = Array.from({ length: entries.length }, () => [] as number[]);
  const sortedEntries = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.bounds.min[0] - right.entry.bounds.min[0] || left.index - right.index);
  const activeEntries: typeof sortedEntries = [];
  sortedEntries.forEach((current) => {
    for (let index = activeEntries.length - 1; index >= 0; index -= 1) {
      if (activeEntries[index].entry.bounds.max[0] <= current.entry.bounds.min[0]) activeEntries.splice(index, 1);
    }
    activeEntries.forEach((candidate) => {
      const leftBounds = candidate.entry.bounds;
      const rightBounds = current.entry.bounds;
      if (
        leftBounds.max[1] <= rightBounds.min[1] ||
        rightBounds.max[1] <= leftBounds.min[1] ||
        leftBounds.max[2] <= rightBounds.min[2] ||
        rightBounds.max[2] <= leftBounds.min[2]
      )
        return;
      const leftIndex = Math.min(candidate.index, current.index);
      intersectionCandidates[leftIndex].push(Math.max(candidate.index, current.index));
    });
    activeEntries.push(current);
  });

  intersectionCandidates.forEach((rightIndices, leftIndex) => {
    rightIndices.sort((left, right) => left - right);
    rightIndices.forEach((rightIndex) => {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (left.object.parentObjectId === right.object.id || right.object.parentObjectId === left.object.id) return;
      if (left.object.placementMode === "attached" || right.object.placementMode === "attached") return;
      const ratio = intersectionRatio(left.bounds, right.bounds);
      const minimumThickness = Math.min(...left.bounds.size, ...right.bounds.size);
      if (ratio > 0.24 && minimumThickness > 0.16) {
        issues.push({
          severity: "warning",
          code: "volume_intersection",
          message: `${left.object.name} and ${right.object.name} have a ${(ratio * 100).toFixed(0)}% bounding-volume intersection.`,
          entity_ids: [left.object.id, right.object.id],
        });
      }
    });
  });

  if (entries.length >= 3) {
    entries.forEach((entry) => {
      let nearestSquared = Number.POSITIVE_INFINITY;
      for (const candidate of entries) {
        if (candidate.object.id === entry.object.id) continue;
        const dx = entry.bounds.center[0] - candidate.bounds.center[0];
        const dy = entry.bounds.center[1] - candidate.bounds.center[1];
        const dz = entry.bounds.center[2] - candidate.bounds.center[2];
        nearestSquared = Math.min(nearestSquared, dx * dx + dy * dy + dz * dz);
        if (nearestSquared <= 25 * 25) break;
      }
      if (nearestSquared > 25 * 25) {
        const nearest = Math.sqrt(nearestSquared);
        issues.push({
          severity: "warning",
          code: "scene_spatial_outlier",
          message: `${entry.object.name} is ${nearest.toFixed(1)} units from the nearest scene object and may belong to another test scene.`,
          entity_ids: [entry.object.id],
        });
      }
    });
  }

  const buckets = new Map<string, string[]>();
  renderable.forEach((object) => {
    const key = `${object.kind}:${stablePosition(object.transform.position)}`;
    const values = buckets.get(key) ?? [];
    values.push(object.id);
    buckets.set(key, values);
  });
  buckets.forEach((ids) => {
    if (ids.length > 1) {
      issues.push({
        severity: "warning",
        code: "overlapping_objects",
        message: `${ids.length} ${project.objects.find((object) => object.id === ids[0])?.kind ?? "scene"} objects occupy the same position.`,
        entity_ids: ids.slice(0, 12),
      });
    }
  });
  return spatial;
}

// Resolve the workbench camera object ID from an optional explicit request,
// falling back to the active camera's linked object, then to any camera object.
function cameraObjectId(project: DirectorProject, requested?: string) {
  if (requested) {
    const direct = project.objects.find((object) => object.kind === "camera" && object.id === requested);
    if (direct) return direct.id;
    const linked = project.objects.find((object) => object.kind === "camera" && object.linkedCameraId === requested);
    if (linked) return linked.id;
  }
  return (
    project.objects.find((object) => object.kind === "camera" && object.linkedCameraId === project.activeCameraId)
      ?.id ?? project.objects.find((object) => object.kind === "camera")?.id
  );
}

// Validate asset-to-object bindings: kind mismatches, character identity
// sourcing (generic vs. asset vs. catalog), and missing asset references.
function addAssetBindingIssues(project: DirectorProject, issues: DirectorAuditIssue[]) {
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  project.objects.forEach((object) => {
    const asset = object.assetRefId ? assetsById.get(object.assetRefId) : undefined;
    if (asset && asset.kind !== object.kind) {
      issues.push({
        severity: "error",
        code: "asset_kind_mismatch",
        message: `${object.name} is a ${object.kind} object but binds ${asset.kind} asset ${asset.id}. Character, prop, scene, and panorama asset kinds are not interchangeable.`,
        entity_ids: [object.id, asset.id],
      });
    }

    if (object.kind !== "character") {
      if (object.characterSource !== undefined) {
        issues.push({
          severity: "error",
          code: "character_source_on_non_character",
          message: `${object.name} declares characterSource=${object.characterSource} but is kind=${object.kind}.`,
          entity_ids: [object.id],
        });
      }
      return;
    }

    if (object.characterSource === "generic" && object.assetRefId) {
      issues.push({
        severity: "error",
        code: "generic_character_has_asset",
        message: `${object.name} is declared as Director's generic performer but also binds asset ${object.assetRefId}. Choose one identity source.`,
        entity_ids: [object.id, object.assetRefId],
      });
      return;
    }
    if (object.assetRefId) return;
    if (object.characterSource === "asset") {
      issues.push({
        severity: "error",
        code: "character_asset_binding_missing",
        message: `${object.name} declares characterSource=asset but has no assetRefId. The viewport would silently display the built-in XBot instead.`,
        entity_ids: [object.id],
      });
      return;
    }
    const claims = findDirectorAgentCatalogAssetsByClaim(object.name);
    const matchingKind = claims.find((candidate) => candidate.kind === "character");
    if (matchingKind) {
      issues.push({
        severity: "error",
        code: "catalog_character_binding_missing",
        message: `${object.name} exactly matches catalog character ${matchingKind.id}, but has no assetRefId and would render as the built-in XBot.`,
        entity_ids: [object.id, matchingKind.id],
        suggested_fix: authorActionsFix(
          { action: "upsert_asset", asset: structuredClone(matchingKind.asset) },
          {
            action: "update_object",
            object_id: object.id,
            patch: { asset_id: matchingKind.id, character_source: "asset" },
          },
        ),
      });
      return;
    }
    if (claims.length) {
      issues.push({
        severity: "error",
        code: "catalog_asset_kind_claim_mismatch",
        message: `${object.name} exactly matches ${claims.map((candidate) => `${candidate.kind} asset ${candidate.id}`).join(", ")}, but the object is a character. Reuse a character catalog action with its declared kind.`,
        entity_ids: [object.id, ...claims.slice(0, 4).map((candidate) => candidate.id)],
      });
      return;
    }

    const defaultCharacter = getDirectorAgentCatalogAsset(DEFAULT_MIXAMO_CHARACTER_ASSET_ID);
    issues.push({
      severity: "error",
      code: "character_asset_binding_missing",
      message: `${object.name} has no assetRefId. Characters must bind a real catalog or local model asset.`,
      entity_ids: [object.id, ...(defaultCharacter ? [defaultCharacter.id] : [])],
      suggested_fix: defaultCharacter
        ? authorActionsFix(
            { action: "upsert_asset", asset: structuredClone(defaultCharacter.asset) },
            {
              action: "update_object",
              object_id: object.id,
              patch: { asset_id: defaultCharacter.id, character_source: "asset" },
            },
          )
        : undefined,
    });
  });
}

// Flag model assets that lack a real-world size annotation, which causes them
// to render at the legacy 2 m display normalization and may be out of scale.
function addScaleConsistencyIssues(project: DirectorProject, issues: DirectorAuditIssue[]) {
  project.assets.forEach((asset) => {
    if (asset.sourceType !== "model" || asset.kind === "character" || asset.kind === "panorama") return;
    const boundObjects = project.objects.filter((object) => object.assetRefId === asset.id && object.visible);
    if (!boundObjects.length) return;
    const objectsWithoutBounds = boundObjects.filter((object) => !getDirectorSpatialBounds(object, project));
    if (objectsWithoutBounds.length) {
      issues.push({
        severity: "warning",
        code: "asset_missing_measured_bounds",
        message: `${asset.name ?? asset.fileName} has no measured local bounds, so spatial placement and collision checks remain unavailable until the model is loaded or provisioned in Blender.`,
        entity_ids: [asset.id, ...objectsWithoutBounds.slice(0, 8).map((object) => object.id)],
      });
    }
    // preserve assets carry a server-normalized metric scale already.
    if (asset.modelNormalization === "preserve" || asset.realWorldSizeM !== undefined) return;
    const catalogAsset = getDirectorAgentCatalogAsset(asset.id);
    const catalogSize = catalogAsset?.asset.realWorldSizeM;
    issues.push({
      severity: "warning",
      code: "asset_missing_real_world_size",
      message: `${asset.name ?? asset.fileName} has no real-world size in meters; it renders at the legacy 2 m display normalization and may be out of scale with characters and the world.`,
      entity_ids: [asset.id, ...boundObjects.slice(0, 8).map((object) => object.id)],
      ...(catalogSize
        ? { suggested_fix: authorActionsFix({ action: "upsert_asset", asset: structuredClone(catalogAsset.asset) }) }
        : {}),
    });
  });
}

/**
 * Runs the full project audit pipeline: graph integrity, asset bindings, scale
 * consistency, timeline, storyboard, spatial placement, and camera framing.
 *
 * The returned `ready` flag is true only when zero error-severity issues exist.
 * It is not a visual-quality or semantic-recognition judgment.
 * Spatial audit is skipped when `options.include_spatial` is explicitly false.
 *
 * @param project - The Director project to audit.
 * @param options - Optional overrides for camera selection and pass toggles.
 * @returns An audit result with issue counts, a compact issue list, and
 *          optional spatial, validation, and framing diagnostics.
 */
export function auditDirectorProject(project: DirectorProject, options: DirectorAuditOptions = {}) {
  const issues: DirectorAuditIssue[] = getDirectorProjectGraphIssues(project).map((message) => ({
    severity: "error" as const,
    code: "invalid_reference",
    message,
  }));
  addAssetBindingIssues(project, issues);
  addScaleConsistencyIssues(project, issues);
  addTimelineIssues(project, issues);
  addStoryboardIssues(project, issues);
  const spatial = options.include_spatial !== false ? addSpatialIssues(project, issues) : null;

  let framing: unknown = null;
  let validation: unknown = null;
  let suggestedActions: unknown[] = [];
  try {
    const aspect = project.cameras.find((camera) => camera.id === project.activeCameraId)?.aspectRatio ?? "16:9";
    const stage = directorProjectToStageScene(project, createDefaultScene(), aspect);
    const validationExecution = executeStageTool(stage, "stage_scene", { op: "validate" });
    validation = validationExecution.result ?? { error: validationExecution.error };
    const resolvedCameraId = cameraObjectId(project, options.camera_id);
    if (!resolvedCameraId) {
      issues.push({ severity: "error", code: "missing_camera", message: "The project has no valid workbench camera." });
    } else {
      const critique = executeStageTool(stage, "stage_read", {
        op: "critique",
        camera_id: resolvedCameraId,
        ...(options.subject_id ? { subject_id: options.subject_id } : {}),
      });
      framing = critique.result ?? { error: critique.error };
      if (!critique.success) {
        issues.push({
          severity: "error",
          code: "framing_failed",
          message: critique.error ?? "Camera framing could not be evaluated.",
        });
      } else {
        const result = critique.result as {
          issues?: Array<{ code?: string; message?: string }>;
          suggested_actions?: unknown[];
        };
        result.issues?.forEach((entry) => {
          issues.push({
            severity:
              entry.code === "subjects_out_of_frame" || entry.code === "subject_clipped" || entry.code === "no_subjects"
                ? "error"
                : "warning",
            code: entry.code ?? "framing_issue",
            message: entry.message ?? "Camera framing needs attention.",
          });
        });
        suggestedActions = result.suggested_actions ?? [];
      }
    }
  } catch (error) {
    issues.push({
      severity: "error",
      code: "stage_projection_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const compactIssues = issues.slice(0, 80);
  return {
    ready: errorCount === 0,
    visual_judgment: DIRECTOR_AUDIT_VISUAL_JUDGMENT,
    scope: [...DIRECTOR_AUDIT_SCOPE],
    note: DIRECTOR_AUDIT_SCOPE_NOTE,
    summary: errorCount
      ? `${errorCount} error(s) and ${warningCount} warning(s) need attention. Structural checks only; not a visual-quality judgment.`
      : warningCount
        ? `No blocking structural errors; ${warningCount} warning(s) remain. Warnings include common outdoor cases such as large ground planes and canopy overlap. This is not a visual-quality judgment.`
        : "Structural checks passed (graph, scale, spatial layout, timeline, storyboard, camera framing). This is not a visual-quality judgment.",
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues: compactIssues,
    spatial,
    validation,
    framing,
    suggested_actions: suggestedActions,
  };
}
