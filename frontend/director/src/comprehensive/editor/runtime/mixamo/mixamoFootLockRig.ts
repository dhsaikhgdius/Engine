import { Matrix4, Quaternion, Vector3, type Object3D } from "three";
import type { DirectorCharacterIkState, DirectorCharacterIkTarget } from "../../schema/directorProject";
import {
  createMixamoFootLockState,
  DEFAULT_MIXAMO_FOOT_LOCK_CONFIG,
  stepMixamoFootLock,
  writeMixamoFootLockOutputToIkTarget,
  type MixamoFootLockConfig,
  type MixamoFootLockFrameInput,
  type MixamoFootLockState,
  type MixamoFootLockVector,
} from "./mixamoFootLock";
import { getMixamoAuthoredBoneSide, type MixamoResolvedBones } from "./mixamoCharacterRig";

/** Shared knee bend-plane hint: Director-local forward offset added to leg IK poles. */
export const DEFAULT_FOOT_POLE_FORWARD_M = 0.45;
const DEFAULT_FOOT_REACH_CLAMP = 0.98;
/** Ankles never tilt past this even on the steepest walkable sample. */
const MAX_SLOPE_ALIGNMENT_RAD = (35 * Math.PI) / 180;
/** Flat-ground fast path: normals within ~0.5 degrees of up cost nothing. */
const MIN_SLOPE_ALIGNMENT_UP_DOT = Math.cos((0.5 * Math.PI) / 180);
const MIN_SLOPE_ALIGNMENT_WEIGHT = 1e-4;

export interface MixamoFootLockRigRuntime {
  lockState: MixamoFootLockState;
  frameInput: MixamoFootLockFrameInput;
  worldToDirectorLocal: Matrix4;
  leftFootWorld: Vector3;
  rightFootWorld: Vector3;
  leftPoleWorld: Vector3;
  rightPoleWorld: Vector3;
  hipWorld: Vector3;
  /** Raw world-space lock goals, kept separate so final blended targets remain stable. */
  leftFootLockTarget: DirectorCharacterIkTarget;
  rightFootLockTarget: DirectorCharacterIkTarget;
  leftFootTarget: DirectorCharacterIkTarget;
  rightFootTarget: DirectorCharacterIkTarget;
  ik: DirectorCharacterIkState;
  /** Per-foot sampled ground normals for slope alignment; up when the frame omits them. */
  leftGroundNormalWorld: Vector3;
  rightGroundNormalWorld: Vector3;
  /** Smoothed lock weights as written to the lock targets, before authored blending. */
  leftFootLockWeight: number;
  rightFootLockWeight: number;
  /** Slope-alignment scratch, allocated once per character. */
  slopeNormal: Vector3;
  slopeAxis: Vector3;
  slopeDelta: Quaternion;
  slopeFootWorldQuaternion: Quaternion;
  slopeParentWorldQuaternion: Quaternion;
  slopeTargetWorldQuaternion: Quaternion;
  slopeTargetLocalQuaternion: Quaternion;
}

export interface MixamoFootLockRigFrame {
  bones: MixamoResolvedBones;
  /** Outer Director character object whose local metre space stores IK goals. */
  directorSpace: Object3D;
  deltaS: number;
  grounded: boolean;
  locomotionMode?: string | null;
  actionKey?: string | null;
  leftGroundHeightWorld: number;
  rightGroundHeightWorld: number;
  /** World normals of each foot's sampled ground; omitted means flat up. */
  leftGroundNormalWorld?: Vector3;
  rightGroundNormalWorld?: Vector3;
  /** Hand IK survives locomotion; authored foot IK crossfades into world foot lock. */
  authoredIk?: DirectorCharacterIkState;
  /** 0 keeps authored feet, 1 gives the runtime lock complete ownership. */
  runtimeOwnershipWeight?: number;
}

function createFootIkTarget(side: -1 | 1): DirectorCharacterIkTarget {
  return {
    target: [0, 0, 0],
    pole: [side * 0.18, 0.45, DEFAULT_FOOT_POLE_FORWARD_M],
    weight: 0,
    reachClamp: DEFAULT_FOOT_REACH_CLAMP,
  };
}

/** Allocate all Three scratch values, tuples, and IK records once per character. */
export function createMixamoFootLockRigRuntime(): MixamoFootLockRigRuntime {
  const leftPositionWorld: MixamoFootLockVector = [0, 0, 0];
  const rightPositionWorld: MixamoFootLockVector = [0, 0, 0];
  const leftFootLockTarget = createFootIkTarget(-1);
  const rightFootLockTarget = createFootIkTarget(1);
  const leftFootTarget = createFootIkTarget(-1);
  const rightFootTarget = createFootIkTarget(1);
  const frameInput: MixamoFootLockFrameInput = {
    deltaS: 0,
    grounded: false,
    locomotionMode: null,
    actionKey: null,
    leftFoot: { enabled: false, positionWorld: leftPositionWorld, groundHeightWorld: 0 },
    rightFoot: { enabled: false, positionWorld: rightPositionWorld, groundHeightWorld: 0 },
  };
  return {
    lockState: createMixamoFootLockState(),
    frameInput,
    worldToDirectorLocal: new Matrix4(),
    leftFootWorld: new Vector3(),
    rightFootWorld: new Vector3(),
    leftPoleWorld: new Vector3(),
    rightPoleWorld: new Vector3(),
    hipWorld: new Vector3(),
    leftFootLockTarget,
    rightFootLockTarget,
    leftFootTarget,
    rightFootTarget,
    ik: { leftFoot: leftFootTarget, rightFoot: rightFootTarget },
    leftGroundNormalWorld: new Vector3(0, 1, 0),
    rightGroundNormalWorld: new Vector3(0, 1, 0),
    leftFootLockWeight: 0,
    rightFootLockWeight: 0,
    slopeNormal: new Vector3(),
    slopeAxis: new Vector3(),
    slopeDelta: new Quaternion(),
    slopeFootWorldQuaternion: new Quaternion(),
    slopeParentWorldQuaternion: new Quaternion(),
    slopeTargetWorldQuaternion: new Quaternion(),
    slopeTargetLocalQuaternion: new Quaternion(),
  };
}

function clampUnit(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function writeBlendedFootTarget(
  target: DirectorCharacterIkTarget,
  authored: DirectorCharacterIkTarget | undefined,
  lock: DirectorCharacterIkTarget,
  runtimeOwnershipWeight: number,
) {
  const runtimeWeight = clampUnit(runtimeOwnershipWeight, 1);
  const authoredContribution = clampUnit(authored?.weight, 0) * (1 - runtimeWeight);
  const lockContribution = clampUnit(lock.weight, 0) * runtimeWeight;
  const totalContribution = authoredContribution + lockContribution;
  target.weight = Math.min(1, totalContribution);

  if (totalContribution <= 1e-8) return;
  const authoredMix = authoredContribution / totalContribution;
  const lockMix = lockContribution / totalContribution;
  for (let axis = 0; axis < 3; axis += 1) {
    target.target[axis] = (authored?.target[axis] ?? lock.target[axis]) * authoredMix + lock.target[axis] * lockMix;
    target.pole[axis] = (authored?.pole[axis] ?? lock.pole[axis]) * authoredMix + lock.pole[axis] * lockMix;
  }
  target.reachClamp = (authored?.reachClamp ?? lock.reachClamp) * authoredMix + lock.reachClamp * lockMix;
}

function writeVectorTuple(target: readonly [number, number, number], source: Vector3) {
  const mutable = target as MixamoFootLockVector;
  mutable[0] = source.x;
  mutable[1] = source.y;
  mutable[2] = source.z;
}

function writeWorldPointToDirectorLocal(source: Vector3, worldToDirectorLocal: Matrix4, target: MixamoFootLockVector) {
  const elements = worldToDirectorLocal.elements;
  const x = source.x;
  const y = source.y;
  const z = source.z;
  const w = elements[3] * x + elements[7] * y + elements[11] * z + elements[15];
  const inverseW = Math.abs(w) > 1e-9 ? 1 / w : 1;
  target[0] = (elements[0] * x + elements[4] * y + elements[8] * z + elements[12]) * inverseW;
  target[1] = (elements[1] * x + elements[5] * y + elements[9] * z + elements[13]) * inverseW;
  target[2] = (elements[2] * x + elements[6] * y + elements[10] * z + elements[14]) * inverseW;
}

function sampleFoot(bone: Object3D | undefined, scratch: Vector3, sample: MixamoFootLockFrameInput["leftFoot"]) {
  sample.enabled = Boolean(bone);
  if (!bone) return;
  bone.getWorldPosition(scratch);
  writeVectorTuple(sample.positionWorld, scratch);
}

function hasFootChain(bones: MixamoResolvedBones, side: "left" | "right") {
  return Boolean(
    bones[side === "left" ? "leftHip" : "rightHip"] &&
    bones[side === "left" ? "leftKnee" : "rightKnee"] &&
    bones[side === "left" ? "leftFoot" : "rightFoot"],
  );
}

/**
 * `applyMixamoCharacterIk` accepts Director's semantic handedness (left is -X)
 * and mirrors it into skeletons such as X Bot where the authored left chain is
 * +X. Foot lock starts from the already-posed physical bone, so mirror it back
 * into the semantic contract here; otherwise the final IK pass crosses legs.
 * The authored thigh offset decides the side when it is decisive; rigs that
 * mirror through the parent orientation fall back to the Director-local
 * position of the posed hip joint.
 *
 * Exported for the procedural crouch layer, which builds its leg IK goals from
 * the same physically posed foot bones and needs the identical mirror.
 */
export function writeDirectorSemanticHandedness(
  side: "left" | "right",
  hip: Object3D | undefined,
  worldToDirectorLocal: Matrix4,
  hipScratch: Vector3,
  target: DirectorCharacterIkTarget,
) {
  if (!hip) return;
  const directorSide = side === "left" ? -1 : 1;
  let skeletonSide = getMixamoAuthoredBoneSide(hip);
  if (skeletonSide === 0) {
    hip.getWorldPosition(hipScratch).applyMatrix4(worldToDirectorLocal);
    skeletonSide = Math.sign(hipScratch.x);
  }
  if (skeletonSide === 0 || skeletonSide === directorSide) return;
  target.target[0] *= -1;
  target.pole[0] *= -1;
}

function updatePole(
  knee: Object3D | undefined,
  scratch: Vector3,
  worldToDirectorLocal: Matrix4,
  target: DirectorCharacterIkTarget,
) {
  if (!knee) return;
  knee.getWorldPosition(scratch);
  writeWorldPointToDirectorLocal(scratch, worldToDirectorLocal, target.pole);
  target.pole[2] += DEFAULT_FOOT_POLE_FORWARD_M;
}

/**
 * Bridge the animated Mixamo skeleton into the allocation-free lock state and
 * return one stable Director IK object. Call after clip sampling and before the
 * final IK solve. Ground heights can come from independent per-foot raycasts.
 */
export function updateMixamoFootLockRigRuntime(
  runtime: MixamoFootLockRigRuntime,
  frame: MixamoFootLockRigFrame,
  config: Readonly<MixamoFootLockConfig> = DEFAULT_MIXAMO_FOOT_LOCK_CONFIG,
): DirectorCharacterIkState {
  frame.directorSpace.updateWorldMatrix(true, false);
  runtime.worldToDirectorLocal.copy(frame.directorSpace.matrixWorld).invert();

  runtime.frameInput.deltaS = frame.deltaS;
  runtime.frameInput.grounded = frame.grounded;
  runtime.frameInput.locomotionMode = frame.locomotionMode;
  runtime.frameInput.actionKey = frame.actionKey;
  runtime.frameInput.leftFoot.groundHeightWorld = frame.leftGroundHeightWorld;
  runtime.frameInput.rightFoot.groundHeightWorld = frame.rightGroundHeightWorld;
  if (frame.leftGroundNormalWorld) runtime.leftGroundNormalWorld.copy(frame.leftGroundNormalWorld);
  else runtime.leftGroundNormalWorld.set(0, 1, 0);
  if (frame.rightGroundNormalWorld) runtime.rightGroundNormalWorld.copy(frame.rightGroundNormalWorld);
  else runtime.rightGroundNormalWorld.set(0, 1, 0);
  const hasLeftChain = hasFootChain(frame.bones, "left");
  const hasRightChain = hasFootChain(frame.bones, "right");
  sampleFoot(hasLeftChain ? frame.bones.leftFoot : undefined, runtime.leftFootWorld, runtime.frameInput.leftFoot);
  sampleFoot(hasRightChain ? frame.bones.rightFoot : undefined, runtime.rightFootWorld, runtime.frameInput.rightFoot);

  const output = stepMixamoFootLock(runtime.lockState, runtime.frameInput, config);
  writeMixamoFootLockOutputToIkTarget(
    output.leftFoot,
    runtime.worldToDirectorLocal.elements,
    runtime.leftFootLockTarget,
  );
  writeMixamoFootLockOutputToIkTarget(
    output.rightFoot,
    runtime.worldToDirectorLocal.elements,
    runtime.rightFootLockTarget,
  );
  // Slope alignment weighs by the pure lock weight; the blended target weight
  // below also carries the authored contribution and would leak authored IK
  // into the runtime-only ankle pass.
  runtime.leftFootLockWeight = runtime.leftFootLockTarget.weight;
  runtime.rightFootLockWeight = runtime.rightFootLockTarget.weight;
  updatePole(frame.bones.leftKnee, runtime.leftPoleWorld, runtime.worldToDirectorLocal, runtime.leftFootLockTarget);
  updatePole(frame.bones.rightKnee, runtime.rightPoleWorld, runtime.worldToDirectorLocal, runtime.rightFootLockTarget);
  if (hasLeftChain) {
    writeDirectorSemanticHandedness(
      "left",
      frame.bones.leftHip,
      runtime.worldToDirectorLocal,
      runtime.hipWorld,
      runtime.leftFootLockTarget,
    );
  }
  if (hasRightChain) {
    writeDirectorSemanticHandedness(
      "right",
      frame.bones.rightHip,
      runtime.worldToDirectorLocal,
      runtime.hipWorld,
      runtime.rightFootLockTarget,
    );
  }

  const runtimeOwnershipWeight = clampUnit(frame.runtimeOwnershipWeight, 1);
  writeBlendedFootTarget(
    runtime.leftFootTarget,
    frame.authoredIk?.leftFoot,
    runtime.leftFootLockTarget,
    runtimeOwnershipWeight,
  );
  writeBlendedFootTarget(
    runtime.rightFootTarget,
    frame.authoredIk?.rightFoot,
    runtime.rightFootLockTarget,
    runtimeOwnershipWeight,
  );

  runtime.ik.leftHand = frame.authoredIk?.leftHand;
  runtime.ik.rightHand = frame.authoredIk?.rightHand;
  runtime.ik.leftFoot = runtime.leftFootTarget;
  runtime.ik.rightFoot = runtime.rightFootTarget;
  return runtime.ik;
}

function alignFootToGroundNormal(
  runtime: MixamoFootLockRigRuntime,
  foot: Object3D | undefined,
  groundNormalWorld: Vector3,
  weight: number,
) {
  if (!foot || weight <= MIN_SLOPE_ALIGNMENT_WEIGHT) return;
  const normal = runtime.slopeNormal.copy(groundNormalWorld);
  if (!Number.isFinite(normal.x) || !Number.isFinite(normal.y) || !Number.isFinite(normal.z)) return;
  const lengthSq = normal.lengthSq();
  if (lengthSq < 1e-12) return;
  normal.multiplyScalar(1 / Math.sqrt(lengthSq));
  if (normal.y >= MIN_SLOPE_ALIGNMENT_UP_DOT) return;

  // up x normal; degenerate when the normal is (anti)parallel to up.
  const axis = runtime.slopeAxis.set(normal.z, 0, -normal.x);
  const axisLengthSq = axis.lengthSq();
  if (axisLengthSq < 1e-12) return;
  axis.multiplyScalar(1 / Math.sqrt(axisLengthSq));
  const angle = Math.min(Math.acos(Math.min(1, Math.max(-1, normal.y))), MAX_SLOPE_ALIGNMENT_RAD);
  // Equivalent to Quaternion.setFromUnitVectors(up, clampedNormal): the clamp
  // shortens the arc around the same shortest-arc rotation axis.
  const delta = runtime.slopeDelta.setFromAxisAngle(axis, angle);

  // getWorldQuaternion refreshes ancestor world matrices on demand, and the
  // preceding applyMixamoCharacterIk pass already left the tree fresh.
  const footWorldQuaternion = foot.getWorldQuaternion(runtime.slopeFootWorldQuaternion);
  const targetWorldQuaternion = runtime.slopeTargetWorldQuaternion
    .copy(delta)
    .multiply(footWorldQuaternion)
    .normalize();
  const parentWorldQuaternion = runtime.slopeParentWorldQuaternion.identity();
  if (foot.parent) foot.parent.getWorldQuaternion(parentWorldQuaternion);
  const targetLocalQuaternion = runtime.slopeTargetLocalQuaternion
    .copy(parentWorldQuaternion)
    .invert()
    .multiply(targetWorldQuaternion)
    .normalize();
  foot.quaternion.slerp(targetLocalQuaternion, Math.min(1, weight)).normalize();
  foot.updateWorldMatrix(false, true);
}

/**
 * Tilt each planted sole onto its sampled ground normal. Run after the final
 * `applyMixamoCharacterIk` solve: the two-bone pass only aims thigh and shin
 * bones, so the ankle orientation written here survives the frame.
 *
 * This pass is purely world-space rotation composition on the physical foot
 * bones. It never touches Director-local goal coordinates, so the semantic
 * left/right handedness mirroring used for the IK targets above does not
 * apply here.
 */
export function applyMixamoFootSlopeAlignment(
  runtime: MixamoFootLockRigRuntime,
  bones: MixamoResolvedBones,
  runtimeOwnershipWeight: number,
) {
  const ownership = clampUnit(runtimeOwnershipWeight, 0);
  if (ownership <= MIN_SLOPE_ALIGNMENT_WEIGHT) return;
  alignFootToGroundNormal(
    runtime,
    bones.leftFoot,
    runtime.leftGroundNormalWorld,
    runtime.leftFootLockWeight * ownership,
  );
  alignFootToGroundNormal(
    runtime,
    bones.rightFoot,
    runtime.rightGroundNormalWorld,
    runtime.rightFootLockWeight * ownership,
  );
}
