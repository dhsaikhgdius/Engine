/*
 * Procedural gait adaptation from Flier123/agentic-3d-director at
 * a939ec5fd84ae32fcbb3b6b6cb5865216f6d7195.
 * Copyright (c) 2026 YZ. Licensed under the MIT License.
 */
import type { DirectorEntityAnimation, DirectorTrajectoryMotion } from "../schema/directorProject";
import { normalizeDirectorFps } from "../timeline/frameTime";
import { getTrajectoryFrameBounds } from "./trajectoryMath";

const MOVEMENT_EPSILON = 1e-3;

function hasTransformMovement(
  left: DirectorEntityAnimation["keyframes"][number],
  right: DirectorEntityAnimation["keyframes"][number],
) {
  const from = left.transform?.position;
  const to = right.transform?.position;
  if (!from || !to) return false;
  // Use a small epsilon to avoid triggering gait on sub-millimetre drift
  // from floating-point accumulation in static poses.
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

/**
 * Backwards-compatible alias for {@link isTrajectoryLocomotionActive}.
 * Used by procedural mannequin pose evaluation to decide whether gait
 * controls should be applied at a given frame.
 */
export const isProceduralGaitActive = isTrajectoryLocomotionActive;

/**
 * Computes procedural gait bone-control deltas for the given motion type at a
 * specific timeline frame. Returns a flat map of bone path → degree/offset
 * values that the mannequin rig evaluator layers on top of the authored pose.
 * Returns `null` when the motion is not a recognised gait.
 *
 * @param motion - The locomotion gait preset (slow-walk, walk, jog, sprint, run).
 * @param frame - The current timeline frame.
 * @param fps - The project frame rate, used to convert frame to seconds.
 * @returns A record of bone-control deltas, or `null` if gait is not applicable.
 */
export function getProceduralGaitControls(motion: DirectorTrajectoryMotion | undefined, frame: number, fps: number) {
  if (!isGaitMotion(motion)) return null;

  // Per-gait pace parameters tuned for a natural walk cycle at each speed.
  // Cadence is cycles per second; all angles are in degrees.
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
  // Continuous phase from 0 to 2π per stride cycle; sin(phase) produces
  // the canonical left-leg-forward-at-zero gait waveform.
  const phase = timeSec * pace.cadence * Math.PI * 2;
  const stride = Math.sin(phase);
  const oppositeStride = -stride;
  // Offset by π/2 so foot lift peaks when the leg passes under the body.
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
