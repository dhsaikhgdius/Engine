import { Bone, Group } from "three";
import {
  getCharacterPoseControlsFromJointRotationDelta,
  getCharacterPoseJointNodeName,
  type CharacterPoseJointId,
} from "../../../../src/comprehensive/editor/pose/characterPoseJoints";
import { resolveCharacterPoseRigBinding } from "../../../../src/comprehensive/editor/pose/characterPoseJointProbe";

it("maps the same shoulder drag through each rig's authored local axes", () => {
  const radians = Math.PI / 6;

  const mannequin = getCharacterPoseControlsFromJointRotationDelta({
    baseControls: {},
    delta: [radians, 0, 0],
    jointId: "rightShoulder",
    skeletonBacked: false,
  });
  expect(mannequin["rightShoulder.pitch"]).toBeCloseTo(30);

  const skeleton = getCharacterPoseControlsFromJointRotationDelta({
    baseControls: {},
    delta: [radians, 0, 0],
    jointId: "rightShoulder",
    skeletonBacked: true,
  });
  expect(skeleton["rightShoulder.spread"]).toBeCloseTo(-30);
});

it("adds rotation deltas to the authored pose and respects hinge limits", () => {
  expect(
    getCharacterPoseControlsFromJointRotationDelta({
      baseControls: { "leftElbow.bend": 145 },
      delta: [0, 0, Math.PI / 6],
      jointId: "leftElbow",
      skeletonBacked: true,
    }),
  ).toEqual({ "leftElbow.bend": 150 });
});

it("binds procedural joint anchors to their shared character-local IK space", () => {
  const character = new Group();
  const mannequin = new Group();
  character.add(mannequin);
  ["body", "torso", "head", "leftShoulder", "leftElbow", "leftHand"].forEach((id) => {
    const anchor = new Group();
    anchor.name = getCharacterPoseJointNodeName(id as CharacterPoseJointId);
    mannequin.add(anchor);
  });

  const binding = resolveCharacterPoseRigBinding(character);

  expect(binding.skeletonRoot).toBeNull();
  expect(binding.ikSpaceRoot).toBe(mannequin);
  expect(binding.joints.map((item) => item.joint.id)).toEqual([
    "body",
    "torso",
    "head",
    "leftShoulder",
    "leftElbow",
    "leftHand",
  ]);
});

it("uses the deform asset parent as the Director-local IK space", () => {
  const character = new Group();
  const runtime = new Group();
  const asset = new Group();
  character.add(runtime);
  runtime.add(asset);
  ["Hips", "Spine2", "Head", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftHand"].forEach((name) => {
    const bone = new Bone();
    bone.name = name;
    asset.add(bone);
  });

  const binding = resolveCharacterPoseRigBinding(character);

  expect(binding.skeletonRoot).toBe(asset);
  expect(binding.ikSpaceRoot).toBe(runtime);
  expect(binding.joints.length).toBeGreaterThanOrEqual(8);
});
