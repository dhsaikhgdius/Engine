import { Matrix4, Quaternion, Vector3, type Object3D } from "three";
import type { DirectorCharacterIkState, DirectorCharacterIkTarget } from "../../schema/directorProject";
import { applyMixamoCharacterIk, type MixamoResolvedBones } from "./mixamoCharacterRig";
import { DEFAULT_FOOT_POLE_FORWARD_M, writeDirectorSemanticHandedness } from "./mixamoFootLockRig";
import type { DirectorCharacterLocomotionRuntimeState } from "./mixamoLocomotionRuntime";

/**
 * Procedural crouch for roaming Mixamo characters. There is no packaged
 * crouch clip, so this layer modifies the already-sampled gait skeleton:
 *
 * 1. capture each animated foot (world position + ankle orientation),
 * 2. drop the hips along the character's down axis by a fraction of the
 *    measured leg length (scale-independent, works for any character height),
 * 3. lean the spine slightly forward to keep the center of mass believable,
 * 4. re-solve both legs with the existing analytic two-bone IK so the feet
 *    return exactly to their animated positions (knees flex to absorb the
 *    drop), then restore the captured ankle orientations.
 *
 * Because the feet end the pass on their unmodified gait trajectory, the
 * world-space foot-lock layer that runs afterwards observes the same contact
 * heights and velocities as without a crouch and never fights this layer.
 */

/** Hip drop at full crouch as a fraction of the measured hip-knee-foot leg length. */
export const MIXAMO_CROUCH_HIP_DROP_LEG_FRACTION = 0.22;
/** Forward spine lean at full crouch. */
export const MIXAMO_CROUCH_SPINE_LEAN_RAD = (7 * Math.PI) / 180;
/** Symmetric enter/exit blend time; smoothstep-shaped so endpoints have zero slope. */
export const MIXAMO_CROUCH_BLEND_S = 0.18;
/** Matches the foot-lock targets so a crouched full extension cannot pop the knee. */
const CROUCH_FOOT_REACH_CLAMP = 0.98;
const MIN_CROUCH_WEIGHT = 1e-4;
const MAX_CROUCH_FRAME_DELTA_S = 0.1;

export interface MixamoCrouchRuntime {
  /** Linear 0..1 blend clock advanced by `updateMixamoCrouchWeight`. */
  progress: number;
  /** Last requested activation, used to detect a settled blend. */
  targetActive: boolean;
  worldToDirectorLocal: Matrix4;
  downWorld: Vector3;
  rightWorld: Vector3;
  hipsWorld: Vector3;
  vecScratchA: Vector3;
  vecScratchB: Vector3;
  vecScratchC: Vector3;
  quatScratchA: Quaternion;
  quatScratchB: Quaternion;
  leftFootWorldQuaternion: Quaternion;
  rightFootWorldQuaternion: Quaternion;
  leftFootTarget: DirectorCharacterIkTarget;
  rightFootTarget: DirectorCharacterIkTarget;
  ik: DirectorCharacterIkState;
}

function createCrouchFootTarget(side: -1 | 1): DirectorCharacterIkTarget {
  return {
    target: [0, 0, 0],
    pole: [side * 0.18, 0.45, DEFAULT_FOOT_POLE_FORWARD_M],
    weight: 0,
    reachClamp: CROUCH_FOOT_REACH_CLAMP,
  };
}

/** Allocate all scratch values and IK records once per character instance. */
export function createMixamoCrouchRuntime(): MixamoCrouchRuntime {
  return {
    progress: 0,
    targetActive: false,
    worldToDirectorLocal: new Matrix4(),
    downWorld: new Vector3(0, -1, 0),
    rightWorld: new Vector3(1, 0, 0),
    hipsWorld: new Vector3(),
    vecScratchA: new Vector3(),
    vecScratchB: new Vector3(),
    vecScratchC: new Vector3(),
    quatScratchA: new Quaternion(),
    quatScratchB: new Quaternion(),
    leftFootWorldQuaternion: new Quaternion(),
    rightFootWorldQuaternion: new Quaternion(),
    leftFootTarget: createCrouchFootTarget(-1),
    rightFootTarget: createCrouchFootTarget(1),
    ik: {},
  };
}

/**
 * The crouch modifier only runs while the controller requests it on solid
 * ground during plain locomotion. Jump/fly author their own silhouettes and
 * emote clips own the whole body, so those modes are exempt.
 */
export function isMixamoCrouchEligible(
  state: Pick<DirectorCharacterLocomotionRuntimeState, "crouching" | "grounded" | "mode"> | null | undefined,
): boolean {
  if (!state || state.crouching !== true || state.grounded !== true) return false;
  return state.mode !== "jump" && state.mode !== "fly" && state.mode !== "emote";
}

/** Smoothstep-shaped weight derived from the linear blend clock. */
export function getMixamoCrouchWeight(runtime: Pick<MixamoCrouchRuntime, "progress">): number {
  const progress = Math.min(1, Math.max(0, runtime.progress));
  return progress * progress * (3 - 2 * progress);
}

/** True once the blend clock has fully reached its requested endpoint. */
export function isMixamoCrouchSettled(runtime: Pick<MixamoCrouchRuntime, "progress" | "targetActive">): boolean {
  return runtime.progress === (runtime.targetActive ? 1 : 0);
}

/**
 * Advance the timed crossfade toward the requested activation and return the
 * shaped weight. Enter and exit both take `MIXAMO_CROUCH_BLEND_S`, so tapping
 * or releasing crouch mid-stride reverses smoothly without a pop.
 */
export function updateMixamoCrouchWeight(runtime: MixamoCrouchRuntime, active: boolean, deltaS: number): number {
  runtime.targetActive = active;
  const safeDelta = Number.isFinite(deltaS) ? Math.min(MAX_CROUCH_FRAME_DELTA_S, Math.max(0, deltaS)) : 0;
  const step = MIXAMO_CROUCH_BLEND_S > 0 ? safeDelta / MIXAMO_CROUCH_BLEND_S : 1;
  runtime.progress = Math.min(1, Math.max(0, runtime.progress + (active ? step : -step)));
  return getMixamoCrouchWeight(runtime);
}

export interface MixamoCrouchPoseFrame {
  /** Cloned character scene that owns the deform skeleton. */
  root: Object3D;
  /** Outer Director character object; its local metre space stores IK goals (+X right, +Z forward). */
  directorSpace: Object3D;
  bones: MixamoResolvedBones;
}

function hasLegChain(bones: MixamoResolvedBones, side: "left" | "right") {
  return Boolean(
    bones[side === "left" ? "leftHip" : "rightHip"] &&
    bones[side === "left" ? "leftKnee" : "rightKnee"] &&
    bones[side === "left" ? "leftFoot" : "rightFoot"],
  );
}

/** Bone segment lengths are pose-invariant, so the posed skeleton measures the bind leg length in world metres. */
function measureLegChainWorldLength(hip: Object3D, knee: Object3D, foot: Object3D, runtime: MixamoCrouchRuntime) {
  hip.getWorldPosition(runtime.vecScratchA);
  knee.getWorldPosition(runtime.vecScratchB);
  foot.getWorldPosition(runtime.vecScratchC);
  return runtime.vecScratchA.distanceTo(runtime.vecScratchB) + runtime.vecScratchB.distanceTo(runtime.vecScratchC);
}

/**
 * Snapshot the animated foot into a Director-local IK goal (full weight: the
 * hip drop itself is already weighted, so the feet must return exactly) and
 * capture the ankle's world orientation for restoration after the solve.
 */
function captureCrouchFootTarget(
  side: "left" | "right",
  bones: MixamoResolvedBones,
  runtime: MixamoCrouchRuntime,
  target: DirectorCharacterIkTarget,
  footWorldQuaternion: Quaternion,
) {
  const hip = bones[side === "left" ? "leftHip" : "rightHip"]!;
  const knee = bones[side === "left" ? "leftKnee" : "rightKnee"]!;
  const foot = bones[side === "left" ? "leftFoot" : "rightFoot"]!;

  foot.getWorldPosition(runtime.vecScratchA).applyMatrix4(runtime.worldToDirectorLocal);
  target.target[0] = runtime.vecScratchA.x;
  target.target[1] = runtime.vecScratchA.y;
  target.target[2] = runtime.vecScratchA.z;
  // Same bend-plane hint as the foot lock: the animated knee pushed forward.
  knee.getWorldPosition(runtime.vecScratchB).applyMatrix4(runtime.worldToDirectorLocal);
  target.pole[0] = runtime.vecScratchB.x;
  target.pole[1] = runtime.vecScratchB.y;
  target.pole[2] = runtime.vecScratchB.z + DEFAULT_FOOT_POLE_FORWARD_M;
  target.weight = 1;
  target.reachClamp = CROUCH_FOOT_REACH_CLAMP;
  foot.getWorldQuaternion(footWorldQuaternion);
  writeDirectorSemanticHandedness(side, hip, runtime.worldToDirectorLocal, runtime.vecScratchC, target);
}

/** Convert a captured world orientation back into the ankle's current local frame. */
function restoreFootWorldQuaternion(foot: Object3D, capturedWorld: Quaternion, scratch: Quaternion) {
  const parent = foot.parent;
  if (!parent) return;
  const parentWorld = parent.getWorldQuaternion(scratch);
  foot.quaternion.copy(parentWorld.invert().multiply(capturedWorld)).normalize();
}

/**
 * Apply the weighted crouch to the sampled skeleton. Call after clip sampling
 * and pose controls, before the world-space foot-lock pass. Returns false on
 * the zero-cost fast path (weight ~0 or an unusable rig).
 */
export function applyMixamoCrouchPose(runtime: MixamoCrouchRuntime, frame: MixamoCrouchPoseFrame): boolean {
  const weight = getMixamoCrouchWeight(runtime);
  if (weight <= MIN_CROUCH_WEIGHT) return false;
  const bones = frame.bones;
  const hips = bones.body;
  const hipsParent = hips?.parent;
  const hasLeft = hasLegChain(bones, "left");
  const hasRight = hasLegChain(bones, "right");
  // Without a complete leg chain the feet cannot be re-planted, so lowering
  // the hips would only sink the character into the ground.
  if (!hips || !hipsParent || (!hasLeft && !hasRight)) return false;

  frame.directorSpace.updateWorldMatrix(true, false);
  runtime.worldToDirectorLocal.copy(frame.directorSpace.matrixWorld).invert();
  const basis = frame.directorSpace.matrixWorld.elements;
  runtime.rightWorld.set(basis[0], basis[1], basis[2]);
  runtime.downWorld.set(-basis[4], -basis[5], -basis[6]);
  if (runtime.rightWorld.lengthSq() < 1e-12) runtime.rightWorld.set(1, 0, 0);
  else runtime.rightWorld.normalize();
  if (runtime.downWorld.lengthSq() < 1e-12) runtime.downWorld.set(0, -1, 0);
  else runtime.downWorld.normalize();

  let legLength = 0;
  let chains = 0;
  if (hasLeft) {
    legLength += measureLegChainWorldLength(bones.leftHip!, bones.leftKnee!, bones.leftFoot!, runtime);
    chains += 1;
  }
  if (hasRight) {
    legLength += measureLegChainWorldLength(bones.rightHip!, bones.rightKnee!, bones.rightFoot!, runtime);
    chains += 1;
  }
  legLength /= chains;
  if (!Number.isFinite(legLength) || legLength <= 1e-6) return false;

  if (hasLeft) {
    captureCrouchFootTarget("left", bones, runtime, runtime.leftFootTarget, runtime.leftFootWorldQuaternion);
  }
  if (hasRight) {
    captureCrouchFootTarget("right", bones, runtime, runtime.rightFootTarget, runtime.rightFootWorldQuaternion);
  }
  runtime.ik.leftFoot = hasLeft ? runtime.leftFootTarget : undefined;
  runtime.ik.rightFoot = hasRight ? runtime.rightFootTarget : undefined;

  // Drop the hips along the character's down axis. The displacement is
  // computed in world space and written back through the parent's frame, so
  // rotated armatures and non-metre asset units both resolve correctly.
  hips.getWorldPosition(runtime.hipsWorld);
  runtime.hipsWorld.addScaledVector(runtime.downWorld, legLength * MIXAMO_CROUCH_HIP_DROP_LEG_FRACTION * weight);
  hips.position.copy(hipsParent.worldToLocal(runtime.hipsWorld));

  // Slight forward lean around the character's lateral axis keeps the
  // silhouette balanced; the head (a spine descendant) follows naturally for
  // the first-person camera.
  const torso = bones.torso;
  if (torso?.parent) {
    const delta = runtime.quatScratchA.setFromAxisAngle(runtime.rightWorld, MIXAMO_CROUCH_SPINE_LEAN_RAD * weight);
    const targetWorld = delta.multiply(torso.getWorldQuaternion(runtime.quatScratchB));
    const parentWorld = torso.parent.getWorldQuaternion(runtime.quatScratchB);
    torso.quaternion.copy(parentWorld.invert().multiply(targetWorld)).normalize();
  }

  // Bend the knees back onto the captured feet with the shared analytic
  // two-bone solve, then restore the exact animated ankle orientation.
  applyMixamoCharacterIk(frame.root, bones, runtime.ik);
  if (hasLeft) restoreFootWorldQuaternion(bones.leftFoot!, runtime.leftFootWorldQuaternion, runtime.quatScratchA);
  if (hasRight) restoreFootWorldQuaternion(bones.rightFoot!, runtime.rightFootWorldQuaternion, runtime.quatScratchA);
  frame.root.updateMatrixWorld(true);
  return true;
}
