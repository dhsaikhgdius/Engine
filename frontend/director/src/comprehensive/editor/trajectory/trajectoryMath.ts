/*
 * Frame-authoritative adaptation of trajectory algorithms from
 * Flier123/agentic-3d-director at a939ec5fd84ae32fcbb3b6b6cb5865216f6d7195.
 * Copyright (c) 2026 YZ. Licensed under the MIT License.
 */
import type {
  DirectorAnimationInterpolation,
  DirectorAnimationKeyframe,
  DirectorAnimationTimingCurve,
  DirectorEntityAnimation,
  DirectorTrajectoryMotion,
  DirectorTrajectoryPreset,
  DirectorTrajectorySource,
  DirectorTransform,
} from "../schema/directorProject";
import { clamp } from "../../../../../../packages/protocol/src/primitives";
import { getDirectorInterpolationWeight } from "../schema/animationEasing";
import { MANNEQUIN_POSE_PRESETS } from "../presets/mannequinPosePresets";
import type { PosePresetId } from "../schema/poseSchema";

type Vec3 = [number, number, number];

/** A single authored point along a trajectory path, with optional tangents and camera data. */
export interface DirectorTrajectoryWaypoint {
  /** Timeline frame for this waypoint; defaults to evenly-spaced when omitted. */
  frame?: number;
  /** World-space position of the entity at this waypoint. */
  position: Vec3;
  /** Optional Euler rotation override. */
  rotation?: Vec3;
  /** Optional scale override. */
  scale?: Vec3;
  /** Cubic Bézier tangent handles for this waypoint. */
  curve?: {
    /** Incoming tangent (from the previous waypoint). */
    in?: Vec3;
    /** Outgoing tangent (toward the next waypoint). */
    out?: Vec3;
  };
  /** Optional look-at target for camera-facing entities. */
  lookTarget?: Vec3;
  /** Optional field-of-view override for camera entities. */
  fov?: number;
  /** Interpolation mode between this waypoint and the next. */
  interpolation?: DirectorAnimationInterpolation | "hold";
  /** Optional custom easing curve for this segment. */
  timingCurve?: DirectorAnimationTimingCurve;
}

/** Input bundle for creating a frame-authoritative trajectory animation from waypoints or presets. */
export interface CreateFrameTrajectoryAnimationInput {
  /** The entity's transform at the start of the animation window. */
  baseTransform: DirectorTransform;
  /** First timeline frame (inclusive) of the animation segment. */
  frameStart: number;
  /** Last timeline frame (inclusive) of the animation segment. */
  frameEnd: number;
  /** Trajectory preset shape (line, L-shape, circle, custom, etc.). */
  preset: DirectorTrajectoryPreset;
  /** Existing animation to merge pose-only keyframes from. */
  existingAnimation?: DirectorEntityAnimation;
  /** Explicit waypoints; when provided, presets are ignored. */
  waypoints?: DirectorTrajectoryWaypoint[];
  /** Optional look-at target for camera-facing entities. */
  cameraTarget?: Vec3;
  /** Optional field-of-view for camera entities. */
  cameraFov?: number;
  /** Radius for circular trajectories. */
  radius?: number;
  /** Width extent for line and L-shape presets. */
  width?: number;
  /** Depth extent for L-shape presets. */
  depth?: number;
  /** Whether circular trajectories rotate clockwise. */
  clockwise?: boolean;
  /** Whether the entity should face along the path tangent. */
  orientToPath?: boolean;
  /** Locomotion gait to associate with the trajectory. */
  motion?: DirectorTrajectoryMotion;
  /** Provenance marker for the trajectory source. */
  source?: DirectorTrajectorySource;
  /** Timeline color for the animation track. */
  color?: string;
}

function finite(value: number | undefined, fallback: number) {
  // Guard against NaN and Infinity from user input or serialisation round-trips.
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cloneVec3(value: Vec3): Vec3 {
  return [...value] as Vec3;
}

function cloneTransform(transform: DirectorTransform): DirectorTransform {
  // Deep-copy so the returned animation never shares mutable arrays with the input.
  return {
    position: cloneVec3(transform.position),
    rotation: cloneVec3(transform.rotation),
    scale: cloneVec3(transform.scale),
  };
}

function lerp(left: number, right: number, progress: number) {
  return left + (right - left) * progress;
}

function lerpVec3(left: Vec3, right: Vec3, progress: number): Vec3 {
  return [lerp(left[0], right[0], progress), lerp(left[1], right[1], progress), lerp(left[2], right[2], progress)];
}

function addVec3(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function cubicBezierPoint(start: Vec3, startHandle: Vec3, endHandle: Vec3, end: Vec3, progress: number): Vec3 {
  // Standard cubic Bézier: B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
  const t = clamp(progress, 0, 1);
  const inverse = 1 - t;
  const startWeight = inverse * inverse * inverse;
  const startHandleWeight = 3 * inverse * inverse * t;
  const endHandleWeight = 3 * inverse * t * t;
  const endWeight = t * t * t;
  return [
    start[0] * startWeight + startHandle[0] * startHandleWeight + endHandle[0] * endHandleWeight + end[0] * endWeight,
    start[1] * startWeight + startHandle[1] * startHandleWeight + endHandle[1] * endHandleWeight + end[1] * endWeight,
    start[2] * startWeight + startHandle[2] * startHandleWeight + endHandle[2] * endHandleWeight + end[2] * endWeight,
  ];
}

function cubicBezierTangent(start: Vec3, startHandle: Vec3, endHandle: Vec3, end: Vec3, progress: number): Vec3 {
  // First derivative: B'(t) = 3(1-t)²(P₁-P₀) + 6(1-t)t(P₂-P₁) + 3t²(P₃-P₂)
  const t = clamp(progress, 0, 1);
  const inverse = 1 - t;
  return [
    3 * inverse * inverse * (startHandle[0] - start[0]) +
      6 * inverse * t * (endHandle[0] - startHandle[0]) +
      3 * t * t * (end[0] - endHandle[0]),
    3 * inverse * inverse * (startHandle[1] - start[1]) +
      6 * inverse * t * (endHandle[1] - startHandle[1]) +
      3 * t * t * (end[1] - endHandle[1]),
    3 * inverse * inverse * (startHandle[2] - start[2]) +
      6 * inverse * t * (endHandle[2] - startHandle[2]) +
      3 * t * t * (end[2] - endHandle[2]),
  ];
}

function normalizedInterpolation(
  interpolation: DirectorAnimationInterpolation | "hold" | undefined,
): DirectorAnimationInterpolation {
  // "hold" is a UI concept that maps to step interpolation; default to smooth.
  return interpolation === "hold" ? "step" : (interpolation ?? "smooth");
}

function evenlyTimedWaypoints(positions: Vec3[], frameStart: number, frameEnd: number): DirectorTrajectoryWaypoint[] {
  const divisor = Math.max(1, positions.length - 1);
  return positions.map((position, index) => ({
    frame: frameStart + Math.round(((frameEnd - frameStart) * index) / divisor),
    interpolation: "smooth",
    position,
  }));
}

function createPresetWaypoints(
  base: Vec3,
  preset: Exclude<DirectorTrajectoryPreset, "custom" | "circle">,
  frameStart: number,
  frameEnd: number,
  width: number,
  depth: number,
) {
  if (preset === "line") {
    return evenlyTimedWaypoints([base, [base[0] + width, base[1], base[2]]], frameStart, frameEnd);
  }

  return evenlyTimedWaypoints(
    [
      base,
      [base[0] + width, base[1], base[2]],
      [base[0] + width, base[1], base[2] + depth],
      [base[0], base[1], base[2] + depth],
      base,
    ],
    frameStart,
    frameEnd,
  );
}

function mergePoseOnlyKeyframes(
  existing: DirectorEntityAnimation | undefined,
  trajectoryKeyframes: DirectorAnimationKeyframe[],
) {
  // Pose-only keyframes (no transform) from the existing animation are
  // preserved at their original frames and merged with the new trajectory
  // keyframes. When a trajectory keyframe lands on the same frame, the
  // trajectory transform wins but the pose values are carried forward.
  const byFrame = new Map<number, DirectorAnimationKeyframe>();

  existing?.keyframes.forEach((keyframe) => {
    if (!keyframe.poseValues) return;
    byFrame.set(keyframe.frame, {
      frame: keyframe.frame,
      interpolation: keyframe.interpolation,
      poseValues: { ...keyframe.poseValues },
    });
  });

  trajectoryKeyframes.forEach((keyframe) => {
    const poseFrame = byFrame.get(keyframe.frame);
    byFrame.set(keyframe.frame, {
      ...poseFrame,
      ...keyframe,
      poseValues: poseFrame?.poseValues,
    });
  });

  return [...byFrame.values()].sort((left, right) => left.frame - right.frame);
}

/**
 * Creates a frame-authoritative trajectory animation from waypoints or a
 * geometric preset. This is the central factory for all entity motion
 * animations in Director — it normalises the frame range, generates keyframes
 * from the preset or waypoints, and merges any existing pose-only keyframes
 * so authored character poses survive the trajectory rebuild.
 *
 * @param input - The complete construction context: base transform, frame
 *   bounds, preset shape, and optional waypoints / camera / motion data.
 * @returns A complete {@link DirectorEntityAnimation} with keyframes,
 *   preset metadata, and circle descriptors when applicable.
 */
export function createFrameTrajectoryAnimation(input: CreateFrameTrajectoryAnimationInput): DirectorEntityAnimation {
  const frameStart = Math.round(Math.min(input.frameStart, input.frameEnd));
  const frameEnd = Math.round(Math.max(input.frameStart, input.frameEnd));
  const radius = Math.max(0.1, finite(input.radius, 2));
  const width = Math.max(0.1, finite(input.width, 3));
  const depth = Math.max(0.1, finite(input.depth, 2));
  const baseTransform = cloneTransform(input.baseTransform);
  const circleCenter: Vec3 = [baseTransform.position[0] - radius, baseTransform.position[1], baseTransform.position[2]];
  const waypoints = input.waypoints?.length
    ? input.waypoints
    : input.preset === "circle"
      ? evenlyTimedWaypoints([baseTransform.position, cloneVec3(baseTransform.position)], frameStart, frameEnd)
      : input.preset === "custom"
        ? evenlyTimedWaypoints([baseTransform.position, cloneVec3(baseTransform.position)], frameStart, frameEnd)
        : createPresetWaypoints(baseTransform.position, input.preset, frameStart, frameEnd, width, depth);
  const divisor = Math.max(1, waypoints.length - 1);
  const trajectoryKeyframes = waypoints.map((waypoint, index): DirectorAnimationKeyframe => ({
    frame: clamp(
      Math.round(finite(waypoint.frame, frameStart + ((frameEnd - frameStart) * index) / divisor)),
      frameStart,
      frameEnd,
    ),
    interpolation: normalizedInterpolation(waypoint.interpolation),
    ...(waypoint.timingCurve ? { timingCurve: { ...waypoint.timingCurve } } : {}),
    transform: {
      position: cloneVec3(waypoint.position),
      rotation: waypoint.rotation ? cloneVec3(waypoint.rotation) : cloneVec3(baseTransform.rotation),
      scale: waypoint.scale ? cloneVec3(waypoint.scale) : cloneVec3(baseTransform.scale),
    },
    ...(waypoint.curve
      ? {
          curve: {
            ...(waypoint.curve.in ? { in: cloneVec3(waypoint.curve.in) } : {}),
            ...(waypoint.curve.out ? { out: cloneVec3(waypoint.curve.out) } : {}),
          },
        }
      : {}),
    ...(waypoint.lookTarget || input.cameraTarget
      ? { lookTarget: cloneVec3(waypoint.lookTarget ?? input.cameraTarget!) }
      : {}),
    ...(waypoint.fov !== undefined || input.cameraFov !== undefined
      ? { fov: finite(waypoint.fov, input.cameraFov ?? 50) }
      : {}),
  }));

  return {
    version: 1,
    enabled: true,
    preset: input.preset,
    orientToPath: input.orientToPath ?? input.preset !== "circle",
    motion: input.motion ?? "none",
    source: input.source ?? "preset",
    color: input.color ?? "#18c7e6",
    ...(input.preset === "circle"
      ? {
          circle: {
            center: circleCenter,
            radius,
            startAngle: 0,
            clockwise: Boolean(input.clockwise),
          },
        }
      : {}),
    keyframes: mergePoseOnlyKeyframes(input.existingAnimation, trajectoryKeyframes),
  };
}

/**
 * Stores a selectable character action on the ordinary timeline. The last
 * frame restores the actor's original rig controls, so action duration is a
 * real clip boundary instead of a UI-only label.
 */
export function createFramePoseActionAnimation(input: {
  basePoseValues: Record<string, number>;
  color?: string;
  existingAnimation?: DirectorEntityAnimation;
  frameEnd: number;
  frameStart: number;
  presetId: PosePresetId;
  timelineEnd: number;
}): DirectorEntityAnimation {
  const preset = MANNEQUIN_POSE_PRESETS.find((item) => item.id === input.presetId);
  const start = Math.round(Math.min(input.frameStart, input.frameEnd));
  const end = Math.round(Math.max(input.frameStart, input.frameEnd));
  const actionPose = { ...(preset?.controls ?? {}) };
  const keyframeByFrame = new Map<number, DirectorAnimationKeyframe>();

  input.existingAnimation?.keyframes.forEach((keyframe) => {
    keyframeByFrame.set(keyframe.frame, {
      ...keyframe,
      ...(keyframe.transform ? { transform: cloneTransform(keyframe.transform) } : {}),
      ...(keyframe.curve ? { curve: { ...keyframe.curve } } : {}),
      ...(keyframe.poseValues ? { poseValues: { ...keyframe.poseValues } } : {}),
    });
  });

  function writePose(frame: number, poseValues: Record<string, number>, interpolation: DirectorAnimationInterpolation) {
    const existing = keyframeByFrame.get(frame);
    keyframeByFrame.set(frame, {
      ...existing,
      frame,
      interpolation,
      poseValues: { ...existing?.poseValues, ...poseValues },
    });
  }

  writePose(start, actionPose, "smooth");
  writePose(end, actionPose, "smooth");
  if (end < input.timelineEnd) writePose(end + 1, input.basePoseValues, "linear");

  return {
    ...input.existingAnimation,
    version: 1,
    enabled: true,
    actionPresetId: input.presetId,
    source: "preset",
    color: input.existingAnimation?.color ?? input.color ?? "#d19a3a",
    keyframes: [...keyframeByFrame.values()].sort((left, right) => left.frame - right.frame),
  };
}

/**
 * Downsamples a dense sequence of drawing points to a uniform subset so the
 * trajectory editor remains responsive. Points are picked at regular indices
 * rather than simplified with a tolerance, preserving the original shape's
 * timing.
 *
 * @param points - The raw drawn point sequence.
 * @param maxPoints - Maximum number of points to retain.
 * @returns A uniformly subsampled copy of the input points.
 */
export function resampleTrajectoryDrawingPoints(points: Vec3[], maxPoints: number) {
  const limit = Math.max(2, Math.floor(maxPoints));
  if (points.length <= limit) return points.map(cloneVec3);
  return Array.from({ length: limit }, (_, index) =>
    cloneVec3(points[Math.round((index * (points.length - 1)) / (limit - 1))]),
  );
}

/**
 * Returns the inclusive first and last frame indices that carry transform
 * keyframes in the given animation. Returns `null` when no transform keyframes
 * exist.
 *
 * @param animation - The animation to inspect.
 * @returns The frame bounds, or `null` if the animation has no transform data.
 */
export function getTrajectoryFrameBounds(animation: DirectorEntityAnimation | undefined) {
  const frames = (animation?.keyframes ?? [])
    .filter((keyframe) => keyframe.transform)
    .map((keyframe) => keyframe.frame);
  if (frames.length === 0) return null;
  return { firstFrame: Math.min(...frames), lastFrame: Math.max(...frames) };
}

/**
 * Evaluates the interpolated transform (position, rotation, scale) of a
 * trajectory animation at an arbitrary frame. Supports Bézier tangents for
 * smooth curves, circular path overrides, and optional speed scaling.
 * Returns `null` when the animation is disabled, has no preset, or has no
 * transform keyframes.
 *
 * @param animation - The trajectory animation to evaluate.
 * @param frame - The timeline frame at which to sample the transform.
 * @param options.applySpeed - When `true` (default), the animation's speed
 *   multiplier is applied to the frame before sampling.
 * @returns The interpolated transform, or `null` if evaluation is not possible.
 */
export function evaluateTrajectoryTransform(
  animation: DirectorEntityAnimation | undefined,
  frame: number,
  options: { applySpeed?: boolean } = {},
): DirectorTransform | null {
  if (!animation?.preset || animation.enabled === false) return null;
  const frames = animation.keyframes
    .filter((keyframe): keyframe is DirectorAnimationKeyframe & { transform: DirectorTransform } =>
      Boolean(keyframe.transform),
    )
    .sort((left, right) => left.frame - right.frame);
  if (frames.length === 0) return null;
  if (frames.length === 1) return cloneTransform(frames[0].transform);

  const applySpeed = options.applySpeed ?? true;
  // Speed scaling: shift the sampled frame forward by the speed multiplier.
  // Clamped to ≥0.1 so the animation never runs backwards or stalls.
  const spedFrame =
    applySpeed && animation.speed !== undefined
      ? frames[0].frame + (frame - frames[0].frame) * Math.max(0.1, animation.speed)
      : frame;
  const clampedFrame = clamp(spedFrame, frames[0].frame, frames[frames.length - 1].frame);
  const left = [...frames].reverse().find((keyframe) => keyframe.frame <= clampedFrame) ?? frames[0];
  const right = frames.find((keyframe) => keyframe.frame > clampedFrame) ?? left;
  const rawProgress = right === left ? 0 : (clampedFrame - left.frame) / Math.max(1, right.frame - left.frame);
  const progress = getDirectorInterpolationWeight(left.interpolation, rawProgress, left.timingCurve);
  const rotation = lerpVec3(left.transform.rotation, right.transform.rotation, progress);
  const hasBezierHandles = Boolean(left.curve?.out || right.curve?.in);
  const startHandle = addVec3(left.transform.position, left.curve?.out ?? [0, 0, 0]);
  const endHandle = addVec3(right.transform.position, right.curve?.in ?? [0, 0, 0]);
  let position = hasBezierHandles
    ? cubicBezierPoint(left.transform.position, startHandle, endHandle, right.transform.position, progress)
    : lerpVec3(left.transform.position, right.transform.position, progress);

  if (animation.circle) {
    // Circular path override: compute position on the circle perimeter
    // using the circle descriptor's center, radius, and direction.
    const duration = Math.max(1, frames[frames.length - 1].frame - frames[0].frame);
    const circleRawProgress = clamp((clampedFrame - frames[0].frame) / duration, 0, 1);
    const circleProgress = getDirectorInterpolationWeight(
      frames[0].interpolation,
      circleRawProgress,
      frames[0].timingCurve,
    );
    const direction = animation.circle.clockwise ? -1 : 1;
    const angle = animation.circle.startAngle + direction * Math.PI * 2 * circleProgress;
    position = [
      animation.circle.center[0] + Math.cos(angle) * animation.circle.radius,
      animation.circle.center[1],
      animation.circle.center[2] + Math.sin(angle) * animation.circle.radius,
    ];
    // Pin endpoints to the exact keyframe positions so the circle
    // closes seamlessly even when floating-point drift accumulates.
    if (clampedFrame === frames[0].frame) position = cloneVec3(frames[0].transform.position);
    if (clampedFrame === frames[frames.length - 1].frame) {
      position = cloneVec3(frames[frames.length - 1].transform.position);
    }
    if (animation.orientToPath) {
      // Tangent direction on the circle: the derivative of (cos θ, sin θ)
      // is (-sin θ, cos θ), with clockwise reversing the Y rotation sign.
      rotation[1] = Math.atan2(-Math.sin(angle) * direction, Math.cos(angle) * direction);
    }
  } else if (animation.orientToPath && right !== left) {
    // For non-circular paths, compute the tangent direction at the
    // current sample point. Bézier segments use the analytic derivative;
    // linear segments use the straight-line direction between waypoints.
    const tangent = hasBezierHandles
      ? cubicBezierTangent(left.transform.position, startHandle, endHandle, right.transform.position, progress)
      : [
          right.transform.position[0] - left.transform.position[0],
          right.transform.position[1] - left.transform.position[1],
          right.transform.position[2] - left.transform.position[2],
        ];
    const deltaX = tangent[0];
    const deltaZ = tangent[2];
    // Only rotate when the horizontal tangent is meaningful; sub-millimetre
    // drift in stationary segments should not flip the entity.
    if (Math.hypot(deltaX, deltaZ) > 0.0001) rotation[1] = Math.atan2(deltaX, deltaZ);
  }

  return {
    position,
    rotation,
    scale: lerpVec3(left.transform.scale, right.transform.scale, progress),
  };
}

/**
 * Samples the trajectory's position at uniformly spaced frames across its
 * entire span. Used for trajectory preview overlays and path visualisation
 * in the editor. Speed scaling is never applied so the shape matches the
 * authored keyframes exactly.
 *
 * @param animation - The trajectory animation to sample.
 * @param subdivisions - Approximate number of segments to divide the span into.
 * @returns An array of world-space positions tracing the path.
 */
export function sampleTrajectoryPositions(animation: DirectorEntityAnimation | undefined, subdivisions = 16) {
  const bounds = getTrajectoryFrameBounds(animation);
  if (!bounds || animation?.enabled === false) return [];
  if (bounds.firstFrame === bounds.lastFrame) {
    const value = evaluateTrajectoryTransform(animation, bounds.firstFrame, { applySpeed: false });
    return value ? [value.position] : [];
  }
  const segmentCount = Math.min(
    512,
    animation?.circle
      ? Math.max(64, subdivisions * 4)
      : Math.max(1, bounds.lastFrame - bounds.firstFrame, subdivisions),
  );
  const positions: Vec3[] = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const frame = bounds.firstFrame + ((bounds.lastFrame - bounds.firstFrame) * index) / segmentCount;
    const value = evaluateTrajectoryTransform(animation, frame, { applySpeed: false });
    if (value) positions.push(value.position);
  }
  return positions;
}
