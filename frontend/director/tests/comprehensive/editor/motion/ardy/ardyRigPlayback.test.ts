import { Bone, Group, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { CSKEL27_JOINTS, CSKEL27_NEUTRAL, CSKEL27_NEUTRAL_MIN_Y } from "../../../../../src/comprehensive/editor/motion/ardy/cskel27";
import type { ArdyMotionClip } from "../../../../../src/comprehensive/editor/motion/ardy/ardyNpz";
import { applyArdyMotionFrame, prepareArdyRigBinding, restoreArdyRigBinding } from "../../../../../src/comprehensive/editor/motion/ardy/ardyRigPlayback";

const JOINT_INDEX = new Map<string, number>(CSKEL27_JOINTS.map((name, index) => [name, index]));

/** Mixamo bone name -> the cskel27 joint whose neutral position it mirrors
 * (the inverse of the runtime's spine-shifted skinning map). */
const BONE_TO_JOINT: Array<[string, string, string | null]> = [
  // [bone name, joint providing its position, parent bone name]
  ["Hips", "Hips", null],
  ["Spine", "Spine1", "Hips"],
  ["Spine1", "Spine2", "Spine"],
  ["Spine2", "Spine3", "Spine1"],
  ["Neck", "Neck", "Spine2"],
  ["Head", "Head", "Neck"],
  ["LeftShoulder", "LeftShoulder", "Spine2"],
  ["LeftArm", "LeftArm", "LeftShoulder"],
  ["LeftForeArm", "LeftForeArm", "LeftArm"],
  ["LeftHand", "LeftHand", "LeftForeArm"],
  ["RightShoulder", "RightShoulder", "Spine2"],
  ["RightArm", "RightArm", "RightShoulder"],
  ["RightForeArm", "RightForeArm", "RightArm"],
  ["RightHand", "RightHand", "RightForeArm"],
  ["LeftUpLeg", "LeftUpLeg", "Hips"],
  ["LeftLeg", "LeftLeg", "LeftUpLeg"],
  ["LeftFoot", "LeftFoot", "LeftLeg"],
  ["LeftToeBase", "LeftToeBase", "LeftFoot"],
  ["RightUpLeg", "RightUpLeg", "Hips"],
  ["RightLeg", "RightLeg", "RightUpLeg"],
  ["RightFoot", "RightFoot", "RightLeg"],
  ["RightToeBase", "RightToeBase", "RightFoot"],
];

/**
 * Build a T-pose rig whose bind joints coincide with the floor-aligned ARDY
 * neutral pose (hips at leg height, toes on the floor), using namespaced
 * Mixamo bone names. Identity-rotation frames must then reproduce the bind
 * pose exactly.
 */
function buildRig() {
  const root = new Group();
  root.name = "director-object-char_test";
  const armature = new Group();
  armature.name = "Armature";
  root.add(armature);

  const neutralOf = (jointName: string) => {
    const neutral = CSKEL27_NEUTRAL[JOINT_INDEX.get(jointName)!]!;
    return new Vector3(neutral[0], neutral[1] - CSKEL27_NEUTRAL_MIN_Y, neutral[2]);
  };

  const bones = new Map<string, Bone>();
  for (const [boneName, jointName, parentName] of BONE_TO_JOINT) {
    const bone = new Bone();
    bone.name = `mixamorig:${boneName}`;
    const world = neutralOf(jointName);
    if (parentName) {
      const parentJoint = BONE_TO_JOINT.find(([name]) => name === parentName)![1];
      bone.position.copy(world).sub(neutralOf(parentJoint));
      bones.get(parentName)!.add(bone);
    } else {
      bone.position.copy(world);
      armature.add(bone);
    }
    bones.set(boneName, bone);
  }
  root.updateMatrixWorld(true);
  return { root, bones };
}

function identityClip({ frames = 2, hipsTravelX = 0 }: { frames?: number; hipsTravelX?: number } = {}): ArdyMotionClip {
  const joints = CSKEL27_JOINTS.length;
  const rotMats = new Float32Array(frames * joints * 9);
  const posedJoints = new Float32Array(frames * joints * 3);
  const rootPositions = new Float32Array(frames * 3);
  for (let frame = 0; frame < frames; frame += 1) {
    const travel = frame * hipsTravelX;
    rootPositions[frame * 3] = travel;
    rootPositions[frame * 3 + 1] = -CSKEL27_NEUTRAL_MIN_Y;
    for (let joint = 0; joint < joints; joint += 1) {
      const rotBase = (frame * joints + joint) * 9;
      rotMats[rotBase] = 1;
      rotMats[rotBase + 4] = 1;
      rotMats[rotBase + 8] = 1;
      const neutral = CSKEL27_NEUTRAL[joint]!;
      const posBase = (frame * joints + joint) * 3;
      posedJoints[posBase] = neutral[0] + travel;
      posedJoints[posBase + 1] = neutral[1] - CSKEL27_NEUTRAL_MIN_Y;
      posedJoints[posBase + 2] = neutral[2];
    }
  }
  return { frames, fps: 20, rotMats, rootPositions, posedJoints, durationS: frames / 20 };
}

describe("prepareArdyRigBinding", () => {
  it("maps namespaced Mixamo bones with the spine shift and unit scale for an ARDY-proportioned rig", () => {
    const { root, bones } = buildRig();
    const binding = prepareArdyRigBinding(root);

    expect(binding).not.toBeNull();
    expect(binding!.scale).toBeCloseTo(1, 5);
    expect(binding!.bones[JOINT_INDEX.get("Hips")!]).toBe(bones.get("Hips"));
    // Core Spine drives no bone; Spine1 drives the rig's "Spine" bone.
    expect(binding!.bones[JOINT_INDEX.get("Spine")!]).toBeNull();
    expect(binding!.bones[JOINT_INDEX.get("Spine1")!]).toBe(bones.get("Spine"));
    expect(binding!.bones[JOINT_INDEX.get("Spine3")!]).toBe(bones.get("Spine2"));
    expect(binding!.bones[JOINT_INDEX.get("LeftHandEnd")!]).toBeNull();
  });

  it("returns null when the subtree has no Mixamo hips", () => {
    const root = new Group();
    const notACharacter = new Group();
    root.add(notACharacter);
    expect(prepareArdyRigBinding(root)).toBeNull();
  });
});

describe("applyArdyMotionFrame", () => {
  it("reproduces the bind pose bit-for-bit on an identity frame", () => {
    const { root, bones } = buildRig();
    const before = new Map(
      [...bones.entries()].map(([name, bone]) => [name, bone.getWorldPosition(new Vector3()).clone()]),
    );
    const binding = prepareArdyRigBinding(root)!;

    applyArdyMotionFrame(binding, identityClip(), 0);

    for (const [name, bone] of bones) {
      const position = bone.getWorldPosition(new Vector3());
      expect(position.distanceTo(before.get(name)!), `bone ${name}`).toBeLessThan(1e-6);
    }
  });

  it("anchors the first frame's root at the character origin and applies later travel", () => {
    const { root, bones } = buildRig();
    const binding = prepareArdyRigBinding(root)!;
    const clip = identityClip({ frames: 2, hipsTravelX: 0.75 });

    applyArdyMotionFrame(binding, clip, 1);

    const hips = bones.get("Hips")!.getWorldPosition(new Vector3());
    expect(hips.x).toBeCloseTo(0.75, 5);
    expect(hips.y).toBeCloseTo(-CSKEL27_NEUTRAL_MIN_Y, 5);
    const foot = bones.get("LeftFoot")!.getWorldPosition(new Vector3());
    expect(foot.x).toBeCloseTo(0.0949182 + 0.75, 5);
  });

  it("prefers the published authored rest pose over live bone transforms", () => {
    const { root, bones } = buildRig();
    // Publish the authored T-pose, then knock the live pose out of it — as
    // Director's neutral stance and active clips do before a preview starts.
    const restPose: Record<string, { position: number[]; quaternion: number[]; scale: number[] }> = {};
    for (const bone of bones.values()) {
      restPose[bone.uuid] = {
        position: bone.position.toArray(),
        quaternion: bone.quaternion.toArray() as number[],
        scale: bone.scale.toArray(),
      };
    }
    root.userData.directorMixamoRestPose = restPose;
    bones.get("LeftArm")!.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -1.2);
    root.updateMatrixWorld(true);

    const binding = prepareArdyRigBinding(root)!;
    applyArdyMotionFrame(binding, identityClip(), 0);

    const hand = bones.get("LeftHand")!.getWorldPosition(new Vector3());
    // The identity frame restores the T-pose hand position, not the lowered one.
    expect(hand.x).toBeCloseTo(0.7189909, 4);
    expect(hand.y).toBeCloseTo(0.5259196 - CSKEL27_NEUTRAL_MIN_Y, 4);
  });

  it("restores the pre-preview pose exactly", () => {
    const { root, bones } = buildRig();
    bones.get("RightArm")!.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    root.updateMatrixWorld(true);
    const savedQuaternion = bones.get("RightArm")!.quaternion.clone();
    const savedPosition = bones.get("Hips")!.position.clone();

    const binding = prepareArdyRigBinding(root)!;
    applyArdyMotionFrame(binding, identityClip({ frames: 2, hipsTravelX: 1 }), 1);
    restoreArdyRigBinding(binding);

    expect(bones.get("RightArm")!.quaternion.angleTo(savedQuaternion)).toBeLessThan(1e-7);
    expect(bones.get("Hips")!.position.distanceTo(savedPosition)).toBeLessThan(1e-7);
  });

  it("keeps world rotation deltas equal to the joint's global rotation", () => {
    const { root, bones } = buildRig();
    const binding = prepareArdyRigBinding(root)!;
    const clip = identityClip();
    // Rotate the hips joint 90° about Y on frame 0 (row-major world matrix).
    const hipsBase = JOINT_INDEX.get("Hips")! * 9;
    clip.rotMats.set([0, 0, 1, 0, 1, 0, -1, 0, 0], hipsBase);

    const bindWorldQuat = bones.get("Hips")!.getWorldQuaternion(new Quaternion());
    applyArdyMotionFrame(binding, clip, 0);
    const posedWorldQuat = bones.get("Hips")!.getWorldQuaternion(new Quaternion());

    const delta = posedWorldQuat.multiply(bindWorldQuat.invert());
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(Math.abs(delta.angleTo(expected))).toBeLessThan(1e-5);
  });
});
