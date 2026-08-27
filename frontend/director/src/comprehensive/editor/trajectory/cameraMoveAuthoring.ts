/**
 * A/B camera-move authoring: given two sampled framings (position, target,
 * focal length at two frames), classifies the dominant cinematic move (dolly,
 * pan, orbit, push-in, dolly-zoom, …) and builds the keyframed camera
 * animation that performs it. Pure math over protocol types — the CameraPanel
 * UI and any agent path share this implementation.
 */
import type {
  DirectorCameraAspectRatio,
  DirectorCameraSensorFormat,
  DirectorEntityAnimation,
} from "../schema/directorProject";
import { getCameraRigPositionFromViewSnapshot, getVerticalFovFromFocalLength } from "../schema/cameraGeometry";

type Vec3 = [number, number, number];

/** A single measured camera framing at a point on the timeline. */
export interface DirectorCameraFraming {
  /** Timeline frame at which this framing was sampled. */
  frame: number;
  /** World-space camera position. */
  position: Vec3;
  /** World-space look-at target. */
  target: Vec3;
  /** Lens focal length in millimetres. */
  focalLengthMm: number;
  /** Euler rotation of the camera rig. */
  rotation: Vec3;
  /** Scale of the camera rig transform. */
  scale: Vec3;
}

/** Classification tags for the dominant camera move between two framings. */
export type DirectorCameraMoveKind =
  | "static"
  | "zoom-in"
  | "zoom-out"
  | "pan"
  | "tilt"
  | "dolly-zoom"
  | "orbit"
  | "crane-up"
  | "crane-down"
  | "push-in"
  | "pull-out"
  | "tracking"
  | "compound";

/** Classification result pairing a move kind with its display label. */
export interface DirectorCameraMoveClassification {
  /** The dominant camera move kind detected between two framings. */
  kind: DirectorCameraMoveKind;
  /** Human-readable label in Simplified Chinese. */
  label: string;
}

const MOVE_LABELS: Record<DirectorCameraMoveKind, string> = {
  static: "静止",
  "zoom-in": "变焦推近",
  "zoom-out": "变焦拉远",
  pan: "横摇",
  tilt: "俯仰",
  "dolly-zoom": "希区柯克变焦",
  orbit: "环绕",
  "crane-up": "升镜",
  "crane-down": "降镜",
  "push-in": "推进",
  "pull-out": "拉远",
  tracking: "跟移",
  compound: "复合运镜",
};

const TAU = Math.PI * 2;
const MIN_DISTANCE = 1e-6;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function lerp(left: number, right: number, progress: number) {
  return left + (right - left) * progress;
}

function lerpVec3(left: Vec3, right: Vec3, progress: number): Vec3 {
  return [lerp(left[0], right[0], progress), lerp(left[1], right[1], progress), lerp(left[2], right[2], progress)];
}

function subtractVec3(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function lengthVec3(value: Vec3) {
  return Math.hypot(value[0], value[1], value[2]);
}

function distanceVec3(left: Vec3, right: Vec3) {
  return lengthVec3(subtractVec3(left, right));
}

function shortestAngleDelta(from: number, to: number) {
  // Normalise to (-π, π] so the signed delta is always the shorter arc.
  return ((((to - from + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

function interpolateAngle(from: number, to: number, progress: number) {
  return from + shortestAngleDelta(from, to) * progress;
}

function smoothstep(progress: number) {
  // Hermite smoothstep: zero velocity at endpoints so the camera
  // eases in and out without abrupt start/stop.
  const value = clamp01(progress);
  return value * value * (3 - 2 * value);
}

function relativeSpherical(position: Vec3, target: Vec3) {
  // Target-relative spherical coordinates: distance, azimuth (x-z plane),
  // and elevation (angle above the horizontal plane).
  const relative = subtractVec3(position, target);
  const distance = Math.max(MIN_DISTANCE, lengthVec3(relative));
  return {
    distance,
    azimuth: Math.atan2(relative[0], relative[2]),
    elevation: Math.asin(Math.min(1, Math.max(-1, relative[1] / distance))),
  };
}

function viewAngles(position: Vec3, target: Vec3) {
  // View-direction angles: yaw (rotation around Y from -Z) and pitch
  // (angle above horizontal). Used for classifying pan/tilt.
  const direction = subtractVec3(target, position);
  const distance = Math.max(MIN_DISTANCE, lengthVec3(direction));
  return {
    yaw: Math.atan2(direction[0], -direction[2]),
    pitch: Math.asin(Math.min(1, Math.max(-1, direction[1] / distance))),
  };
}

function classification(kind: DirectorCameraMoveKind): DirectorCameraMoveClassification {
  return { kind, label: MOVE_LABELS[kind] };
}

/**
 * Describes the move that the two measured framings actually make. Thresholds
 * are expressed in metres, radians, and ratios so the result does not depend
 * on viewport pixels or a user-entered label.
 */
export function classifyDirectorCameraMove(
  from: DirectorCameraFraming,
  to: DirectorCameraFraming,
): DirectorCameraMoveClassification {
  const cameraTravel = distanceVec3(from.position, to.position);
  const targetTravel = distanceVec3(from.target, to.target);
  const fromView = viewAngles(from.position, from.target);
  const toView = viewAngles(to.position, to.target);
  const yawDelta = shortestAngleDelta(fromView.yaw, toView.yaw);
  const pitchDelta = toView.pitch - fromView.pitch;
  const aimDelta = Math.hypot(yawDelta, pitchDelta);
  const focalChange = Math.abs(Math.log(Math.max(MIN_DISTANCE, to.focalLengthMm / from.focalLengthMm)));

  if (cameraTravel < 0.05 && targetTravel < 0.05 && aimDelta < Math.PI / 180 && focalChange < 0.02) {
    return classification("static");
  }

  if (cameraTravel < 0.08) {
    if (focalChange >= 0.05) return classification(to.focalLengthMm > from.focalLengthMm ? "zoom-in" : "zoom-out");
    if (aimDelta >= Math.PI / 90) return classification(Math.abs(yawDelta) >= Math.abs(pitchDelta) ? "pan" : "tilt");
  }

  const fromRelative = relativeSpherical(from.position, from.target);
  const toRelative = relativeSpherical(to.position, to.target);
  const radialDelta = toRelative.distance - fromRelative.distance;
  const averageDistance = Math.max(MIN_DISTANCE, (fromRelative.distance + toRelative.distance) / 2);
  const relativeDistanceChange = Math.abs(radialDelta) / averageDistance;
  const imageScaleFrom = from.focalLengthMm / fromRelative.distance;
  const imageScaleTo = to.focalLengthMm / toRelative.distance;
  const imageScaleDrift = Math.abs(Math.log(Math.max(MIN_DISTANCE, imageScaleTo / imageScaleFrom)));
  const azimuthDelta = shortestAngleDelta(fromRelative.azimuth, toRelative.azimuth);
  const relativeOffsetChange = distanceVec3(
    subtractVec3(from.position, from.target),
    subtractVec3(to.position, to.target),
  );

  if (targetTravel >= 0.25 && relativeOffsetChange < 0.25) return classification("tracking");
  if (relativeDistanceChange >= 0.12 && focalChange >= 0.08 && imageScaleDrift <= Math.log(1.15)) {
    return classification("dolly-zoom");
  }
  if (Math.abs(azimuthDelta) >= Math.PI / 22.5 && relativeDistanceChange < 0.2) return classification("orbit");

  const horizontalTravel = Math.hypot(to.position[0] - from.position[0], to.position[2] - from.position[2]);
  const verticalTravel = to.position[1] - from.position[1];
  if (Math.abs(verticalTravel) >= 0.35 && horizontalTravel < 0.35) {
    return classification(verticalTravel > 0 ? "crane-up" : "crane-down");
  }
  if (Math.abs(radialDelta) >= 0.25) return classification(radialDelta < 0 ? "push-in" : "pull-out");
  if (aimDelta >= Math.PI / 90) return classification(Math.abs(yawDelta) >= Math.abs(pitchDelta) ? "pan" : "tilt");
  return classification("compound");
}

/**
 * Interpolates in target-relative spherical coordinates. A Cartesian blend
 * between two orbit framings would cut across the subject instead of following
 * the authored arc.
 */
export function interpolateDirectorCameraFraming(
  from: DirectorCameraFraming,
  to: DirectorCameraFraming,
  progress: number,
): DirectorCameraFraming {
  const weight = smoothstep(progress);
  const fromRelative = relativeSpherical(from.position, from.target);
  const toRelative = relativeSpherical(to.position, to.target);
  const target = lerpVec3(from.target, to.target, weight);
  const distance = lerp(fromRelative.distance, toRelative.distance, weight);
  const azimuth = interpolateAngle(fromRelative.azimuth, toRelative.azimuth, weight);
  const elevation = interpolateAngle(fromRelative.elevation, toRelative.elevation, weight);
  const horizontalDistance = Math.cos(elevation) * distance;

  return {
    frame: Math.round(lerp(from.frame, to.frame, progress)),
    position: [
      target[0] + Math.sin(azimuth) * horizontalDistance,
      target[1] + Math.sin(elevation) * distance,
      target[2] + Math.cos(azimuth) * horizontalDistance,
    ],
    target,
    focalLengthMm: lerp(from.focalLengthMm, to.focalLengthMm, weight),
    rotation: from.rotation.map((value, index) => interpolateAngle(value, to.rotation[index], weight)) as Vec3,
    scale: lerpVec3(from.scale, to.scale, weight),
  };
}

/**
 * Builds a keyframed camera move animation between two measured framings.
 * Interpolation follows target-relative spherical coordinates so the camera
 * arcs naturally around the subject rather than cutting through it. The
 * returned animation is classified automatically so the UI can display the
 * move type without a separate analysis pass.
 *
 * @param from - The starting camera framing.
 * @param to - The ending camera framing (must be on a later frame).
 * @param aspectRatio - Viewport aspect ratio for FOV computation.
 * @param sensorFormat - Camera sensor format for FOV computation.
 * @param existingAnimation - Optional existing animation whose keyframes
 *   outside the [from, to] frame range are preserved.
 * @returns A new animation with the computed keyframes and a move classification.
 */
export function buildDirectorCameraMove({
  from,
  to,
  aspectRatio,
  sensorFormat,
  existingAnimation,
}: {
  from: DirectorCameraFraming;
  to: DirectorCameraFraming;
  aspectRatio: DirectorCameraAspectRatio;
  sensorFormat: DirectorCameraSensorFormat;
  existingAnimation?: DirectorEntityAnimation;
}): { animation: DirectorEntityAnimation; classification: DirectorCameraMoveClassification } {
  const frameSpan = Math.round(to.frame) - Math.round(from.frame);
  if (frameSpan <= 0) throw new Error("Camera move B must be after A on the timeline.");

  const fromRelative = relativeSpherical(from.position, from.target);
  const toRelative = relativeSpherical(to.position, to.target);
  // Keyframe density: one segment per ~45° of azimuth travel, or one per ~6
  // frames of duration — whichever is denser, capped at 48 for performance.
  const angularSegments = Math.ceil(
    Math.abs(shortestAngleDelta(fromRelative.azimuth, toRelative.azimuth)) / (Math.PI / 8),
  );
  const durationSegments = Math.ceil(frameSpan / 6);
  const segmentCount = Math.min(frameSpan, 48, Math.max(1, 4, angularSegments, durationSegments));
  const moveKeyframes = Array.from({ length: segmentCount + 1 }, (_, index) => {
    const sample = interpolateDirectorCameraFraming(from, to, index / segmentCount);
    const fov = getVerticalFovFromFocalLength(sample.focalLengthMm, aspectRatio, sensorFormat);
    return {
      frame: sample.frame,
      interpolation: "linear" as const,
      transform: {
        position: getCameraRigPositionFromViewSnapshot({ position: sample.position, target: sample.target, fov }),
        rotation: sample.rotation,
        scale: sample.scale,
      },
      lookTarget: sample.target,
      fov,
    };
  });
  const outsideKeys =
    existingAnimation?.keyframes.filter((keyframe) => keyframe.frame < from.frame || keyframe.frame > to.frame) ?? [];

  return {
    animation: {
      version: 1,
      enabled: true,
      source: "manual",
      ...(existingAnimation?.color ? { color: existingAnimation.color } : {}),
      keyframes: [...outsideKeys, ...moveKeyframes].sort((left, right) => left.frame - right.frame),
    },
    classification: classifyDirectorCameraMove(from, to),
  };
}
