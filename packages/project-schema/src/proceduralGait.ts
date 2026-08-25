/*
 * Procedural gait adaptation from Flier123/agentic-3d-director at
 * a939ec5fd84ae32fcbb3b6b6cb5865216f6d7195.
 * Copyright (c) 2026 YZ. Licensed under the MIT License.
 */
import type { DirectorEntityAnimation, DirectorTrajectoryMotion } from "./directorProject";
import { normalizeDirectorFps } from "./frameTime";
import { getTrajectoryFrameBounds } from "./trajectoryMath";

const MOVEMENT_EPSILON = 1e-3;

function hasTransformMovement(
  left: DirectorEntityAnimation["keyframes"][number],
  right: DirectorEntityAnimation["keyframes"][number],
) {
  const from = left.transform?.position;
  const to = right.transform?.position;
  if (!from || !to) return false;
  return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) > MOVEMENT_EPSILON;
}

/** True only while a trajectory locomotion segment is translating at this frame. */
export function isTrajectoryLocomotionActive(animation: DirectorEntityAnimation | undefined, frame: number) {
  if (animation?.enabled === false || !isGaitMotion(animation?.motion)) {
    return false;
  }
  const bounds = getTrajectoryFrameBounds(animation);
  if (!bounds || frame < bounds.firstFrame || frame >= bounds.lastFrame) return false;

  // Circular trajectories deliberately return to their origin, so their first
  // and last transform can be identical while the character is still moving.
  if (animation.circle || animation.preset === "circle") return true;

  const transformKeys = animation.keyframes
    .filter((keyframe) => keyframe.transform)
    .sort((left, right) => left.frame - right.frame);
  for (let index = 0; index < transformKeys.length - 1; index += 1) {
    const left = transformKeys[index];
    const right = transformKeys[index + 1];
    if (frame >= left.frame && frame < right.frame) {
      return hasTransformMovement(left, right);
    }
  }
  return false;
}

/** Backwards-compatible name used by procedural mannequin pose evaluation. */
export const isProceduralGaitActive = isTrajectoryLocomotionActive;

/**
 * Computes procedural gait pose control values for the given motion at a frame.
 *
 * Each gait (slow-walk, walk, jog, sprint/run) has its own cadence, arm swing,
 * hip swing, knee lift, bounce, and body pitch parameters. The controls are
 * driven by sinusoidal phase functions keyed to elapsed time.
 *
 * @param motion - The gait motion type.
 * @param frame - The current frame number.
 * @param fps - The frame rate for time conversion.
 * @returns A record of pose control overrides, or null for non-gait motions.
 */
export function getProceduralGaitControls(motion: DirectorTrajectoryMotion | undefined, frame: number, fps: number) {
  if (!isGaitMotion(motion)) return null;

  const pace =
    motion === "slow-walk"
      ? {
          cadence: 1.1,
          armSwing: 17,
          hipSwing: 18,
          kneeBase: 3,
          kneeLift: 18,
          bounce: 0.018,
          bodyPitch: 0.5,
          elbow: 6,
          foot: 8,
        }
      : motion === "walk"
        ? {
            cadence: 1.65,
            armSwing: 26,
            hipSwing: 28,
            kneeBase: 4,
            kneeLift: 26,
            bounce: 0.035,
            bodyPitch: 1.5,
            elbow: 8,
            foot: 12,
          }
        : motion === "jog"
          ? {
              cadence: 2.1,
              armSwing: 36,
              hipSwing: 36,
              kneeBase: 10,
              kneeLift: 36,
              bounce: 0.052,
              bodyPitch: 4,
              elbow: 42,
              foot: 17,
            }
          : {
              cadence: 2.45,
              armSwing: 48,
              hipSwing: 46,
              kneeBase: 16,
              kneeLift: 48,
              bounce: 0.07,
              bodyPitch: 7,
              elbow: 70,
              foot: 22,
            };
  const timeSec = frame / normalizeDirectorFps(fps);
  const phase = timeSec * pace.cadence * Math.PI * 2;
  const stride = Math.sin(phase);
  const oppositeStride = -stride;
  const footCycle = Math.sin(phase + Math.PI / 2);
  const bounce = Math.abs(Math.sin(phase));
  return {
    "body.offsetY": bounce * pace.bounce,
    "body.pitch": pace.bodyPitch,
    "torso.yaw": stride * (pace.hipSwing / 9),
    "leftShoulder.pitch": stride * pace.armSwing,
    "rightShoulder.pitch": oppositeStride * pace.armSwing,
    "leftElbow.bend": pace.elbow + stride * Math.min(12, pace.elbow * 0.12),
    "rightElbow.bend": pace.elbow + oppositeStride * Math.min(12, pace.elbow * 0.12),
    "leftHip.pitch": oppositeStride * pace.hipSwing,
    "rightHip.pitch": stride * pace.hipSwing,
    "leftKnee.bend": pace.kneeBase + Math.max(0, -footCycle) * pace.kneeLift,
    "rightKnee.bend": pace.kneeBase + Math.max(0, footCycle) * pace.kneeLift,
    "leftFoot.pitch": Math.max(0, footCycle) * pace.foot,
    "rightFoot.pitch": Math.max(0, -footCycle) * pace.foot,
  };
}

function isGaitMotion(motion: DirectorTrajectoryMotion | undefined) {
  return motion === "slow-walk" || motion === "walk" || motion === "jog" || motion === "sprint" || motion === "run";
}
