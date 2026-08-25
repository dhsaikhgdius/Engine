import { Quaternion, Vector3, type Object3D } from "three";
import { canonicalizeMixamoBoneName, type MixamoResolvedBones } from "./mixamoCharacterRig";
import type { DirectorCharacterLocomotionRuntimeState } from "./mixamoLocomotionRuntime";

/**
 * Procedural head look-at for roaming Mixamo characters. While the player
 * freely orbits the third-person camera, the character's head (and a share of
 * the neck) turns toward the camera's view direction instead of staring
 * rigidly along its travel heading.
 *
 * Structure mirrors `mixamoCrouch.ts`: a per-character runtime advanced every
 * frame (timed smoothstep crossfade for eligibility plus exponential damping
 * for the angles), and a skeletal post-process applied after clip sampling,
 * crouch, and the world-space foot pass. Only the neck and head bones are
 * rotated - both have no limb descendants, so authored hand IK, the shoulder
 * line, and the planted feet are untouched by construction.
 *
 * All rotations are composed in world space around the owning Director
 * object's axes (+Z forward, +Y up, physical right = -X), then written back
 * through each bone's parent frame. This stays correct for namespaced,
 * rescaled, or rotated Mixamo skeletons whose local bone axes do not align
 * with world axes.
 */

/** Yaw the head/neck chain may actually turn away from the visual forward. */
export const MIXAMO_HEAD_LOOK_MAX_YAW_RAD = (60 * Math.PI) / 180;
/** Pitch limit, symmetric up/down. */
export const MIXAMO_HEAD_LOOK_MAX_PITCH_RAD = (35 * Math.PI) / 180;
/** Requested gaze beyond this is "behind"; the head recenters instead of twisting. */
export const MIXAMO_HEAD_LOOK_BEHIND_ENTER_RAD = (100 * Math.PI) / 180;
/** Hysteresis exit so an orbiting camera near the boundary cannot flicker the gaze. */
export const MIXAMO_HEAD_LOOK_BEHIND_EXIT_RAD = (92 * Math.PI) / 180;
/** Smoothstep blend-in when the eligibility conditions engage. */
export const MIXAMO_HEAD_LOOK_ENTER_BLEND_S = 0.2;
/**
 * Blend-out on losing eligibility. Deliberately shorter than the minimum
 * locomotion crossfade (0.16 s): when an emote such as `talk` starts with its
 * own authored head animation, the procedural gaze is fully gone before the
 * emote clip reaches full weight, so the two can never fight.
 */
export const MIXAMO_HEAD_LOOK_EXIT_BLEND_S = 0.14;
/** Exponential damping rate (1/s) for yaw/pitch; gives the slight camera lag. */
export const MIXAMO_HEAD_LOOK_ANGLE_RESPONSE = 10;
/** Fraction of the gaze rotation carried by the neck; the head completes the rest. */
export const MIXAMO_HEAD_LOOK_NECK_SHARE = 0.35;

const MIN_HEAD_LOOK_WEIGHT = 1e-4;
const MIN_HEAD_LOOK_ANGLE_RAD = 1e-4;
const HEAD_LOOK_SETTLE_EPSILON_RAD = 1e-4;
const MAX_HEAD_LOOK_FRAME_DELTA_S = 0.1;

export interface MixamoHeadLookRuntime {
  /** Linear 0..1 eligibility blend clock advanced by `updateMixamoHeadLook`. */
  progress: number;
  /** Last requested activation, used to detect a settled blend. */
  targetActive: boolean;
  /** Hysteresis latch: the requested gaze currently points behind the actor. */
  behind: boolean;
  /** Clamped gaze the damped angles are approaching. */
  yawTargetRad: number;
  pitchTargetRad: number;
  /** Damped angles actually applied to the skeleton (before the blend weight). */
  yawRad: number;
  pitchRad: number;
  upWorld: Vector3;
  forwardWorld: Vector3;
  rightWorld: Vector3;
  quatScratchA: Quaternion;
  quatScratchB: Quaternion;
  quatScratchC: Quaternion;
  quatScratchD: Quaternion;
}

/** Allocate all scratch values once per character instance. */
export function createMixamoHeadLookRuntime(): MixamoHeadLookRuntime {
  return {
    progress: 0,
    targetActive: false,
    behind: false,
    yawTargetRad: 0,
    pitchTargetRad: 0,
    yawRad: 0,
    pitchRad: 0,
    upWorld: new Vector3(0, 1, 0),
    forwardWorld: new Vector3(0, 0, 1),
    rightWorld: new Vector3(-1, 0, 0),
    quatScratchA: new Quaternion(),
    quatScratchB: new Quaternion(),
    quatScratchC: new Quaternion(),
    quatScratchD: new Quaternion(),
  };
}

/**
 * Head look runs only during plain locomotion (crouched or not) and only when
 * the controller actually publishes a gaze. Jump and fly author their own
 * silhouettes, and emote clips (talk, wave, ...) own the head outright, so
 * those modes are exempt; writers that never send the gaze fields keep their
 * exact previous behavior.
 */
export function isMixamoHeadLookEligible(
  state: Pick<DirectorCharacterLocomotionRuntimeState, "lookPitchRad" | "lookYawRad" | "mode"> | null | undefined,
): boolean {
  if (!state) return false;
  const hasGaze =
    (typeof state.lookYawRad === "number" && Number.isFinite(state.lookYawRad)) ||
    (typeof state.lookPitchRad === "number" && Number.isFinite(state.lookPitchRad));
  if (!hasGaze) return false;
  return state.mode === "idle" || state.mode === "walk" || state.mode === "run";
}

/** Smoothstep-shaped weight derived from the linear blend clock. */
export function getMixamoHeadLookWeight(runtime: Pick<MixamoHeadLookRuntime, "progress">): number {
  const progress = Math.min(1, Math.max(0, runtime.progress));
  return progress * progress * (3 - 2 * progress);
}

/**
 * True once the blend clock reached its endpoint and the damped angles landed
 * on their targets, i.e. re-rendering would not move the skeleton anymore.
 */
export function isMixamoHeadLookSettled(
  runtime: Pick<MixamoHeadLookRuntime, "pitchRad" | "pitchTargetRad" | "progress" | "targetActive" | "yawRad" | "yawTargetRad">,
): boolean {
  if (runtime.progress !== (runtime.targetActive ? 1 : 0)) return false;
  return (
    Math.abs(runtime.yawRad - runtime.yawTargetRad) <= HEAD_LOOK_SETTLE_EPSILON_RAD &&
    Math.abs(runtime.pitchRad - runtime.pitchTargetRad) <= HEAD_LOOK_SETTLE_EPSILON_RAD
  );
}

function wrapAngleRad(value: number) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function clampAbs(value: number, limit: number) {
  return Math.min(limit, Math.max(-limit, value));
}

/** Exponential approach with a snap once inside the settle epsilon. */
function dampAngleTowards(current: number, target: number, factor: number) {
  const next = current + (target - current) * factor;
  return Math.abs(target - next) <= HEAD_LOOK_SETTLE_EPSILON_RAD ? target : next;
}

/**
 * Advance the eligibility crossfade and the damped gaze angles, returning the
 * shaped blend weight. Losing eligibility both fades the weight (fast, inside
 * any clip crossfade window) and relaxes the angles back to center, so a
 * later re-entry starts from wherever the head physically is.
 */
export function updateMixamoHeadLook(
  runtime: MixamoHeadLookRuntime,
  state: Pick<DirectorCharacterLocomotionRuntimeState, "lookPitchRad" | "lookYawRad" | "mode"> | null | undefined,
  deltaS: number,
): number {
  const active = isMixamoHeadLookEligible(state);
  runtime.targetActive = active;
  const safeDelta = Number.isFinite(deltaS) ? Math.min(MAX_HEAD_LOOK_FRAME_DELTA_S, Math.max(0, deltaS)) : 0;

  const yawInput =
    active && typeof state?.lookYawRad === "number" && Number.isFinite(state.lookYawRad)
      ? wrapAngleRad(state.lookYawRad)
      : 0;
  const pitchInput =
    active && typeof state?.lookPitchRad === "number" && Number.isFinite(state.lookPitchRad)
      ? wrapAngleRad(state.lookPitchRad)
      : 0;

  const yawMagnitude = Math.abs(yawInput);
  if (yawMagnitude >= MIXAMO_HEAD_LOOK_BEHIND_ENTER_RAD) runtime.behind = true;
  else if (yawMagnitude <= MIXAMO_HEAD_LOOK_BEHIND_EXIT_RAD) runtime.behind = false;

  const aimed = active && !runtime.behind;
  runtime.yawTargetRad = aimed ? clampAbs(yawInput, MIXAMO_HEAD_LOOK_MAX_YAW_RAD) : 0;
  runtime.pitchTargetRad = aimed ? clampAbs(pitchInput, MIXAMO_HEAD_LOOK_MAX_PITCH_RAD) : 0;

  const dampFactor = 1 - Math.exp(-MIXAMO_HEAD_LOOK_ANGLE_RESPONSE * safeDelta);
  runtime.yawRad = dampAngleTowards(runtime.yawRad, runtime.yawTargetRad, dampFactor);
  runtime.pitchRad = dampAngleTowards(runtime.pitchRad, runtime.pitchTargetRad, dampFactor);

  const blendS = active ? MIXAMO_HEAD_LOOK_ENTER_BLEND_S : MIXAMO_HEAD_LOOK_EXIT_BLEND_S;
  const step = blendS > 0 ? safeDelta / blendS : 1;
  runtime.progress = Math.min(1, Math.max(0, runtime.progress + (active ? step : -step)));
  return getMixamoHeadLookWeight(runtime);
}

export interface MixamoHeadLookPoseFrame {
  /** Cloned character scene that owns the deform skeleton. */
  root: Object3D;
  /** Outer Director character object; its axes define forward/up/right (+Z forward). */
  directorSpace: Object3D;
  bones: MixamoResolvedBones;
}

/** Convert a world-space target orientation into the bone's local frame. */
function writeWorldQuaternionToBone(bone: Object3D, targetWorld: Quaternion, scratch: Quaternion) {
  const parent = bone.parent;
  if (!parent) return;
  const parentWorld = parent.getWorldQuaternion(scratch);
  bone.quaternion.copy(parentWorld.invert().multiply(targetWorld)).normalize();
}

/**
 * The shared bone-role table deliberately stops at `head` (external adapters
 * assert its exact role set), so the neck is resolved structurally: in every
 * Mixamo export it is the head's direct parent. Anything else (a head parented
 * straight to a spine, or a namespaced non-neck joint) makes the head carry
 * the whole arc instead of guessing.
 */
export function resolveMixamoHeadLookNeck(head: Object3D): Object3D | undefined {
  const parent = head.parent;
  if (!parent?.parent) return undefined;
  return canonicalizeMixamoBoneName(parent.name) === "neck" ? parent : undefined;
}

/**
 * Apply the weighted gaze to the sampled skeleton. Call after clip sampling,
 * crouch, and the foot passes - the neck and head have no limb descendants,
 * so nothing downstream is disturbed. Returns false on the zero-cost fast
 * path (inactive weight, negligible angles, or a rig without a head bone).
 *
 * The full gaze delta is a world-space rotation about the character's up axis
 * (positive yaw = counterclockwise from above, matching the runtime state's
 * sign convention) composed with a rotation about the character's physical
 * right axis (positive pitch = look up). The neck carries
 * `MIXAMO_HEAD_LOOK_NECK_SHARE` of that delta; the head is then posed to the
 * exact full delta relative to its pre-pass orientation, so the distribution
 * never changes the final gaze direction and a neckless rig simply lets the
 * head carry everything.
 */
export function applyMixamoHeadLookPose(runtime: MixamoHeadLookRuntime, frame: MixamoHeadLookPoseFrame): boolean {
  const weight = getMixamoHeadLookWeight(runtime);
  if (weight <= MIN_HEAD_LOOK_WEIGHT) return false;
  const yawRad = runtime.yawRad * weight;
  const pitchRad = runtime.pitchRad * weight;
  if (Math.abs(yawRad) < MIN_HEAD_LOOK_ANGLE_RAD && Math.abs(pitchRad) < MIN_HEAD_LOOK_ANGLE_RAD) return false;
  const head = frame.bones.head;
  if (!head?.parent) return false;
  const neck = resolveMixamoHeadLookNeck(head);

  frame.directorSpace.updateWorldMatrix(true, false);
  const basis = frame.directorSpace.matrixWorld.elements;
  runtime.upWorld.set(basis[4], basis[5], basis[6]);
  runtime.forwardWorld.set(basis[8], basis[9], basis[10]);
  if (runtime.upWorld.lengthSq() < 1e-12) runtime.upWorld.set(0, 1, 0);
  else runtime.upWorld.normalize();
  if (runtime.forwardWorld.lengthSq() < 1e-12) runtime.forwardWorld.set(0, 0, 1);
  else runtime.forwardWorld.normalize();
  // A +Z-forward, +Y-up character's physical right hand side is forward x up
  // (-X in director space); rotating around it by positive pitch looks up.
  runtime.rightWorld.crossVectors(runtime.forwardWorld, runtime.upWorld);
  if (runtime.rightWorld.lengthSq() < 1e-12) runtime.rightWorld.set(-1, 0, 0);
  else runtime.rightWorld.normalize();

  // Full world-space gaze delta: yaw about up, then pitch about the unrotated
  // physical right (yaw preserves the vertical component, so both land exact).
  const delta = runtime.quatScratchA.setFromAxisAngle(runtime.upWorld, yawRad);
  delta.multiply(runtime.quatScratchB.setFromAxisAngle(runtime.rightWorld, pitchRad));

  // Capture the head before touching the neck so the final head pose is the
  // exact full delta regardless of how much the neck carried.
  const headWorldBefore = head.getWorldQuaternion(runtime.quatScratchB);
  const headWorldTarget = runtime.quatScratchC.copy(delta).multiply(headWorldBefore).normalize();

  if (neck) {
    const neckDelta = runtime.quatScratchB.identity().slerp(delta, MIXAMO_HEAD_LOOK_NECK_SHARE);
    const neckWorldTarget = neckDelta.multiply(neck.getWorldQuaternion(runtime.quatScratchD)).normalize();
    writeWorldQuaternionToBone(neck, neckWorldTarget, runtime.quatScratchD);
  }
  writeWorldQuaternionToBone(head, headWorldTarget, runtime.quatScratchA);
  frame.root.updateMatrixWorld(true);
  return true;
}
