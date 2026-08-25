import { Matrix3, Matrix4, Quaternion, Vector3, type Bone, type Object3D } from "three";
import { canonicalizeHumanoidBoneName } from "../../loaders/humanoidRig";
import type { MixamoRestPose } from "../../runtime/mixamo/mixamoCharacterRig";
import {
  computeCskel27GlobalRotations,
  CSKEL27_JOINT_COUNT,
  CSKEL27_JOINTS,
  CSKEL27_NEUTRAL,
  CSKEL27_NEUTRAL_MIN_Y,
} from "./cskel27";
import type { ArdyMotionClip } from "./ardyNpz";

/**
 * Drive a Mixamo-rigged Director character from a decoded ARDY motion with
 * POSITIONAL SKINNING — the retarget method of NVIDIA's ARDY interactive demo
 * Mixamo avatar (Apache-2.0):
 *
 *   boneWorldPos[j]  = s * posed[f][j] + R[f][j] * (mixamoBind[j] - s * ardyNeutral[j])
 *   boneWorldQuat[j] = R[f][j] * bindQuat[j]
 *
 * where R[f][j] is the joint's GLOBAL rotation (FK over the npz local
 * rotations) and the bind offset is measured against ARDY's floor-aligned
 * neutral T-pose. Nothing assumes the rig's local rotation axes or rest
 * orientation, so any namespaced Mixamo export retargets identically.
 *
 * The uniform scale `s` maps ARDY metres into the rig's own leg proportions
 * (rig leg height over ARDY neutral leg height), keeping the character's
 * authored silhouette while feet plant exactly where the npz puts them. The
 * first frame's root XZ is anchored at the character origin so the clip plays
 * at the object's stage position; height stays floor-absolute.
 *
 * The bind pose is the authored Mixamo T-pose captured at instance
 * preparation (`userData.directorMixamoRestPose`), NOT the live bone
 * transforms — Director's neutral stance already lowers the arms ~70°, and
 * measuring bind offsets against that stance would fold the correction into
 * every frame.
 */

/** cskel27 joint -> canonical Mixamo bone token (null = joint drives no bone).
 * Mirrors the ARDY demo's `_MIXAMO_TO_CORE`: Mixamo's three spine bones map
 * onto core Spine1/Spine2/Spine3, hand-end/thumb leaves stay unmapped. */
const ARDY_SKINNING_TARGETS: ReadonlyArray<string | null> = CSKEL27_JOINTS.map((name) => {
  switch (name) {
    case "Spine":
    case "RightHandEnd":
    case "LeftHandEnd":
    case "RightHandThumb1":
    case "LeftHandThumb1":
      return null;
    case "Spine1":
      return canonicalizeHumanoidBoneName("Spine");
    case "Spine2":
      return canonicalizeHumanoidBoneName("Spine1");
    case "Spine3":
      return canonicalizeHumanoidBoneName("Spine2");
    default:
      return canonicalizeHumanoidBoneName(name);
  }
});

const HIPS_JOINT_INDEX = CSKEL27_JOINTS.indexOf("Hips");

export interface ArdyRigBinding {
  /** Root Object3D of the character subtree this binding was prepared from. */
  root: Object3D;
  /** cskel27 index -> driven bone (null where no bone is mapped). */
  bones: Array<Bone | null>;
  /** Authored T-pose quaternion per mapped joint, used as the orientation offset. */
  bindQuat: Array<Quaternion | null>;
  /** Authored scale per mapped joint, preserved across frames. */
  bindScale: Array<Vector3 | null>;
  /** Bind-pose world matrix of each mapped bone's parent. */
  parentBindWorld: Array<Matrix4 | null>;
  /** Nearest MAPPED ancestor joint index per joint, -1 when none. */
  chainParent: Int32Array;
  /** Bind-relative matrix from the mapped ancestor to the bone's real parent. */
  chainRel: Array<Matrix4 | null>;
  /** Per-joint bind offset against the floor-shifted ARDY neutral pose. */
  offsets: Array<Vector3 | null>;
  /** Uniform scale mapping ARDY metres to the rig's leg proportions. */
  scale: number;
  /** Pre-preview bone transforms captured at binding time, for restoration. */
  snapshot: Array<{ bone: Bone; position: Vector3; quaternion: Quaternion }>;
  /** Reusable scratch objects to avoid per-frame allocation. */
  scratch: {
    globals: Float64Array;
    desiredWorld: Matrix4[];
    desiredWritten: Uint8Array;
    m3: Matrix3;
    m4: Matrix4;
    local: Matrix4;
    parentWorld: Matrix4;
    qGlobal: Quaternion;
    qWorld: Quaternion;
    vOffset: Vector3;
    vWorld: Vector3;
    vPosition: Vector3;
    qLocal: Quaternion;
    vScale: Vector3;
  };
}

function isBone(object: Object3D): object is Bone {
  return "isBone" in object && (object as Bone).isBone === true;
}

/** Collect authored rest poses published by prepared character instances. */
function collectRestPose(root: Object3D): MixamoRestPose {
  const merged: MixamoRestPose = {};
  root.traverse((object) => {
    const restPose = object.userData?.directorMixamoRestPose as MixamoRestPose | undefined;
    if (restPose) Object.assign(merged, restPose);
  });
  return merged;
}

/**
 * Prepare the positional-skinning binding for one character subtree. Returns
 * null when the subtree carries no recognizable Mixamo hips — the caller
 * should present that as "this character cannot preview AI motion".
 */
export function prepareArdyRigBinding(root: Object3D): ArdyRigBinding | null {
  const restPose = collectRestPose(root);

  // Rig-space bind world transform of every node below the root, composing
  // authored rest transforms for bones (current transforms may hold an active
  // pose or clip) and live transforms for plain nodes (armature wrappers and
  // the metre-normalization scale).
  const worldByNode = new Map<Object3D, Matrix4>();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  const walk = (node: Object3D, parentWorld: Matrix4) => {
    const rest = isBone(node) ? restPose[node.uuid] : undefined;
    if (rest) {
      position.set(...rest.position);
      quaternion.set(...rest.quaternion);
      scale.set(...rest.scale);
    } else {
      position.copy(node.position);
      quaternion.copy(node.quaternion);
      scale.copy(node.scale);
    }
    const world = new Matrix4().compose(position, quaternion, scale).premultiply(parentWorld);
    worldByNode.set(node, world);
    for (const child of node.children) walk(child, world);
  };
  for (const child of root.children) walk(child, new Matrix4());

  // First depth-first canonical-name match wins; exact equality beats suffix
  // matches so namespaced exports cannot shadow a sibling bone.
  const bonesByCanonicalName = new Map<string, Bone>();
  const allBones: Bone[] = [];
  root.traverse((object) => {
    if (!isBone(object)) return;
    allBones.push(object);
    const canonical = canonicalizeHumanoidBoneName(object.name);
    if (canonical && !bonesByCanonicalName.has(canonical)) bonesByCanonicalName.set(canonical, object);
  });
  const findBone = (target: string) => {
    const exact = bonesByCanonicalName.get(target);
    if (exact) return exact;
    return allBones.find((bone) => canonicalizeHumanoidBoneName(bone.name).endsWith(target)) ?? null;
  };

  const joints = CSKEL27_JOINT_COUNT;
  const bones: Array<Bone | null> = new Array(joints).fill(null);
  const bindPos: Array<Vector3 | null> = new Array(joints).fill(null);
  const bindQuat: Array<Quaternion | null> = new Array(joints).fill(null);
  const bindScale: Array<Vector3 | null> = new Array(joints).fill(null);
  const parentBindWorld: Array<Matrix4 | null> = new Array(joints).fill(null);
  for (let joint = 0; joint < joints; joint += 1) {
    const target = ARDY_SKINNING_TARGETS[joint];
    if (!target) continue;
    const bone = findBone(target);
    if (!bone) continue;
    const world = worldByNode.get(bone);
    if (!world) continue;
    bones[joint] = bone;
    bindPos[joint] = new Vector3().setFromMatrixPosition(world);
    bindQuat[joint] = new Quaternion().setFromRotationMatrix(world).normalize();
    bindScale[joint] = bone.scale.clone();
    parentBindWorld[joint] = bone.parent ? (worldByNode.get(bone.parent) ?? new Matrix4()) : new Matrix4();
  }

  const hips = bones[HIPS_JOINT_INDEX];
  const hipsBind = bindPos[HIPS_JOINT_INDEX];
  if (!hips || !hipsBind) return null;

  // s = rig leg height / ARDY neutral leg height, both measured hips-to-floor.
  let lowestY = hipsBind.y;
  for (const bind of bindPos) {
    if (bind && bind.y < lowestY) lowestY = bind.y;
  }
  const legHeight = hipsBind.y - lowestY;
  const uniformScale = legHeight > 1e-6 ? legHeight / -CSKEL27_NEUTRAL_MIN_Y : 1;

  // Per-joint bind offset against the floor-shifted ARDY neutral pose.
  const offsets: Array<Vector3 | null> = new Array(joints).fill(null);
  for (let joint = 0; joint < joints; joint += 1) {
    const bind = bindPos[joint];
    if (!bind) continue;
    const neutral = CSKEL27_NEUTRAL[joint]!;
    offsets[joint] = new Vector3(
      bind.x - uniformScale * neutral[0],
      bind.y - uniformScale * (neutral[1] - CSKEL27_NEUTRAL_MIN_Y),
      bind.z - uniformScale * neutral[2],
    );
  }

  // The cskel parent is not always the bone's scene parent (core Spine drives
  // no bone). For local conversion, find each mapped bone's nearest MAPPED
  // ancestor and the bind-relative matrix from that ancestor to the bone's
  // real parent; unmapped chains keep their static bind parent world.
  const jointByBone = new Map<Bone, number>();
  bones.forEach((bone, joint) => {
    if (bone) jointByBone.set(bone, joint);
  });
  const chainParent = new Int32Array(joints).fill(-1);
  const chainRel: Array<Matrix4 | null> = new Array(joints).fill(null);
  for (let joint = 0; joint < joints; joint += 1) {
    const bone = bones[joint];
    if (!bone) continue;
    for (let node = bone.parent; node && node !== root; node = node.parent) {
      if (isBone(node) && jointByBone.has(node)) {
        const ancestorJoint = jointByBone.get(node)!;
        chainParent[joint] = ancestorJoint;
        const ancestorWorld = worldByNode.get(node)!;
        const parentWorld = bone.parent ? worldByNode.get(bone.parent)! : new Matrix4();
        chainRel[joint] = new Matrix4().copy(ancestorWorld).invert().multiply(parentWorld);
        break;
      }
    }
  }

  const snapshot = bones
    .filter((bone): bone is Bone => bone !== null)
    .map((bone) => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone() }));

  return {
    root,
    bones,
    bindQuat,
    bindScale,
    parentBindWorld,
    chainParent,
    chainRel,
    offsets,
    scale: uniformScale,
    snapshot,
    scratch: {
      globals: new Float64Array(joints * 9),
      desiredWorld: Array.from({ length: joints }, () => new Matrix4()),
      desiredWritten: new Uint8Array(joints),
      m3: new Matrix3(),
      m4: new Matrix4(),
      local: new Matrix4(),
      parentWorld: new Matrix4(),
      qGlobal: new Quaternion(),
      qWorld: new Quaternion(),
      vOffset: new Vector3(),
      vWorld: new Vector3(),
      vPosition: new Vector3(),
      qLocal: new Quaternion(),
      vScale: new Vector3(),
    },
  };
}

/**
 * Apply one motion frame. Every mapped bone's rig-space world transform is
 * composed from the frame's global rotations and posed joints, then converted
 * to bone-local against the already-written mapped ancestor (cskel index
 * order is topological along every chain). `frame` is clamped into range.
 */
export function applyArdyMotionFrame(binding: ArdyRigBinding, motion: ArdyMotionClip, frame: number): void {
  const joints = CSKEL27_JOINT_COUNT;
  const clampedFrame = Math.max(0, Math.min(Math.round(frame) || 0, motion.frames - 1));
  const { scratch } = binding;

  computeCskel27GlobalRotations(motion.rotMats, clampedFrame * joints * 9, scratch.globals);

  // First frame's root XZ stays at the character origin; height is floor-absolute.
  const anchorX = motion.posedJoints[HIPS_JOINT_INDEX * 3]!;
  const anchorZ = motion.posedJoints[HIPS_JOINT_INDEX * 3 + 2]!;

  scratch.desiredWritten.fill(0);
  for (let joint = 0; joint < joints; joint += 1) {
    const bone = binding.bones[joint];
    if (!bone) continue;

    const g = joint * 9;
    scratch.m3.set(
      scratch.globals[g]!,
      scratch.globals[g + 1]!,
      scratch.globals[g + 2]!,
      scratch.globals[g + 3]!,
      scratch.globals[g + 4]!,
      scratch.globals[g + 5]!,
      scratch.globals[g + 6]!,
      scratch.globals[g + 7]!,
      scratch.globals[g + 8]!,
    );
    scratch.qGlobal.setFromRotationMatrix(scratch.m4.setFromMatrix3(scratch.m3));

    const posed = (clampedFrame * joints + joint) * 3;
    scratch.vOffset.copy(binding.offsets[joint]!).applyQuaternion(scratch.qGlobal);
    scratch.vWorld.set(
      binding.scale * (motion.posedJoints[posed]! - anchorX) + scratch.vOffset.x,
      binding.scale * motion.posedJoints[posed + 1]! + scratch.vOffset.y,
      binding.scale * (motion.posedJoints[posed + 2]! - anchorZ) + scratch.vOffset.z,
    );
    scratch.qWorld.copy(scratch.qGlobal).multiply(binding.bindQuat[joint]!);

    const ancestorJoint = binding.chainParent[joint]!;
    if (ancestorJoint >= 0 && scratch.desiredWritten[ancestorJoint]) {
      scratch.parentWorld.copy(scratch.desiredWorld[ancestorJoint]!).multiply(binding.chainRel[joint]!);
    } else {
      scratch.parentWorld.copy(binding.parentBindWorld[joint]!);
    }

    const desired = scratch.desiredWorld[joint]!;
    desired.compose(scratch.vWorld, scratch.qWorld, binding.bindScale[joint]!);
    scratch.desiredWritten[joint] = 1;
    scratch.local.copy(scratch.parentWorld).invert().multiply(desired);
    scratch.local.decompose(scratch.vPosition, scratch.qLocal, scratch.vScale);
    bone.position.copy(scratch.vPosition);
    bone.quaternion.copy(scratch.qLocal);
  }
  binding.root.updateMatrixWorld(true);
}

/** Restore every bone the preview touched to its pre-preview transform. */
export function restoreArdyRigBinding(binding: ArdyRigBinding): void {
  for (const entry of binding.snapshot) {
    entry.bone.position.copy(entry.position);
    entry.bone.quaternion.copy(entry.quaternion);
  }
  binding.root.updateMatrixWorld(true);
}
