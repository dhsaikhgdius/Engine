/**
 * The joints a director can grab directly in the viewport.
 *
 * A joint is not a fourth pose representation: it is a named view onto the
 * portable pose controls that already exist in `characterRig.controls`, plus
 * the optional IK effector that the same anatomical site drives. The inspector
 * sliders, Agent `set_character_pose_controls` calls and viewport dragging
 * therefore all write the same authored fields.
 *
 * @module director/editor/pose/character-pose-joints
 */

import type { CharacterBodyType, DirectorCharacterIkEffector } from "../schema/directorProject";
import { clampCharacterPoseControlValue, type CharacterPoseControlKey } from "../schema/poseSchema";
import { radiansToDegrees } from "../runtime/mannequin/mannequinPose";
import {
  MIXAMO_POSE_AXIS_BINDINGS,
  MIXAMO_POSE_BONE_ROLES,
  type MixamoPoseAxisBinding,
  type MixamoBoneRole,
} from "../runtime/mixamo/mixamoPoseAxes";

/** Joints share the Mixamo bone roles so every rig adapter resolves them. */
export type CharacterPoseJointId = MixamoBoneRole;

export type CharacterPoseJointSide = "center" | "left" | "right";

export interface CharacterPoseJoint {
  id: CharacterPoseJointId;
  label: string;
  side: CharacterPoseJointSide;
  /** Rotation controls this joint drives, in bone-local XYZ axis order. */
  controls: readonly CharacterPoseControlKey[];
  /** Translation control offered instead of rotation, when the joint has one. */
  offsetControl?: CharacterPoseControlKey;
  /** Dragging this joint's position retargets the limb through IK. */
  ikEffector?: DirectorCharacterIkEffector;
  /** Mid-chain joint whose position seeds the IK pole vector. */
  ikPoleJoint?: CharacterPoseJointId;
  /** Handle radius in metres, at a 1.78 m reference height. */
  handleRadiusM: number;
  /** Anchor node the procedural mannequin renders for this joint. */
  mannequinNode: string;
}

/**
 * Name of the anchor node a rig renders so the viewport can locate a joint.
 *
 * @param id - The joint id.
 * @returns The Three.js node name for that joint's anchor.
 */
export function getCharacterPoseJointNodeName(id: CharacterPoseJointId) {
  return `mannequin-joint-${id}`;
}

function joint(
  id: CharacterPoseJointId,
  label: string,
  side: CharacterPoseJointSide,
  handleRadiusM: number,
  extra: Partial<Pick<CharacterPoseJoint, "offsetControl" | "ikEffector" | "ikPoleJoint">> = {},
): CharacterPoseJoint {
  return {
    id,
    label,
    side,
    // Deriving from the axis table keeps a joint from advertising a control
    // that the forward mapping would silently ignore.
    controls: MIXAMO_POSE_AXIS_BINDINGS[id].axes.map((axis) => axis.control),
    handleRadiusM,
    mannequinNode: getCharacterPoseJointNodeName(id),
    ...extra,
  };
}

/** Every joint Director exposes as a viewport handle, in skeleton order. */
export const CHARACTER_POSE_JOINTS: readonly CharacterPoseJoint[] = [
  joint("body", "髋部", "center", 0.055, { offsetControl: "body.offsetY" }),
  joint("torso", "躯干", "center", 0.05),
  joint("head", "头部", "center", 0.045),
  joint("leftShoulder", "左肩", "left", 0.042),
  joint("rightShoulder", "右肩", "right", 0.042),
  joint("leftElbow", "左肘", "left", 0.036),
  joint("rightElbow", "右肘", "right", 0.036),
  joint("leftHand", "左手", "left", 0.034, { ikEffector: "leftHand", ikPoleJoint: "leftElbow" }),
  joint("rightHand", "右手", "right", 0.034, { ikEffector: "rightHand", ikPoleJoint: "rightElbow" }),
  joint("leftHip", "左髋", "left", 0.042),
  joint("rightHip", "右髋", "right", 0.042),
  joint("leftKnee", "左膝", "left", 0.036),
  joint("rightKnee", "右膝", "right", 0.036),
  joint("leftFoot", "左脚", "left", 0.034, { ikEffector: "leftFoot", ikPoleJoint: "leftKnee" }),
  joint("rightFoot", "右脚", "right", 0.034, { ikEffector: "rightFoot", ikPoleJoint: "rightKnee" }),
];

const CHARACTER_POSE_JOINTS_BY_ID = new Map(CHARACTER_POSE_JOINTS.map((item) => [item.id, item]));

const MANNEQUIN_POSE_AXIS_BINDINGS: Partial<Record<CharacterPoseJointId, readonly MixamoPoseAxisBinding[]>> = {
  body: [
    { axis: 0, control: "body.pitch", sign: 1 },
    { axis: 1, control: "body.yaw", sign: 1 },
    { axis: 2, control: "body.roll", sign: 1 },
  ],
  torso: [
    { axis: 0, control: "torso.pitch", sign: 1 },
    { axis: 1, control: "torso.yaw", sign: 1 },
    { axis: 2, control: "torso.roll", sign: 1 },
  ],
  head: [
    { axis: 0, control: "head.pitch", sign: 1 },
    { axis: 1, control: "head.yaw", sign: 1 },
    { axis: 2, control: "head.roll", sign: 1 },
  ],
  leftShoulder: [
    { axis: 0, control: "leftShoulder.pitch", sign: 1 },
    { axis: 1, control: "leftShoulder.twist", sign: 1 },
    { axis: 2, control: "leftShoulder.spread", sign: 1 },
  ],
  rightShoulder: [
    { axis: 0, control: "rightShoulder.pitch", sign: 1 },
    { axis: 1, control: "rightShoulder.twist", sign: 1 },
    { axis: 2, control: "rightShoulder.spread", sign: 1 },
  ],
  leftElbow: [{ axis: 0, control: "leftElbow.bend", sign: 1 }],
  rightElbow: [{ axis: 0, control: "rightElbow.bend", sign: 1 }],
  leftHip: [
    { axis: 0, control: "leftHip.pitch", sign: 1 },
    { axis: 1, control: "leftHip.twist", sign: 1 },
    { axis: 2, control: "leftHip.spread", sign: 1 },
  ],
  rightHip: [
    { axis: 0, control: "rightHip.pitch", sign: 1 },
    { axis: 1, control: "rightHip.twist", sign: 1 },
    { axis: 2, control: "rightHip.spread", sign: 1 },
  ],
  leftKnee: [{ axis: 0, control: "leftKnee.bend", sign: 1 }],
  rightKnee: [{ axis: 0, control: "rightKnee.bend", sign: 1 }],
};

/** All joint ids, matching the Mixamo bone role order. */
export const CHARACTER_POSE_JOINT_IDS: readonly CharacterPoseJointId[] = MIXAMO_POSE_BONE_ROLES;

/**
 * Type guard for a joint id arriving from persisted UI state or a tool call.
 *
 * @param value - The candidate joint id.
 * @returns True when the string names a joint Director can pose.
 */
export function isCharacterPoseJointId(value: string): value is CharacterPoseJointId {
  return CHARACTER_POSE_JOINTS_BY_ID.has(value as CharacterPoseJointId);
}

/**
 * Look up a joint definition.
 *
 * @param id - The joint id.
 * @returns The joint, or null when the id is unknown.
 */
export function getCharacterPoseJoint(id: string | null | undefined): CharacterPoseJoint | null {
  if (!id) return null;
  return CHARACTER_POSE_JOINTS_BY_ID.get(id as CharacterPoseJointId) ?? null;
}

/**
 * Apply a viewport gizmo's local XYZ rotation delta to portable pose controls.
 *
 * Real skeletons and the procedural mannequin expose different local axes for
 * the same anatomical motion. Keeping that distinction here lets both write
 * the one existing `characterRig.controls` representation.
 */
export function getCharacterPoseControlsFromJointRotationDelta({
  baseControls,
  bodyType,
  delta,
  jointId,
  skeletonBacked,
}: {
  baseControls: Record<string, number>;
  bodyType?: CharacterBodyType;
  delta: readonly [number, number, number];
  jointId: CharacterPoseJointId;
  skeletonBacked: boolean;
}): Partial<Record<CharacterPoseControlKey, number>> {
  const bindings = skeletonBacked
    ? MIXAMO_POSE_AXIS_BINDINGS[jointId].axes
    : (MANNEQUIN_POSE_AXIS_BINDINGS[jointId] ?? []);
  const controls: Partial<Record<CharacterPoseControlKey, number>> = {};

  bindings.forEach(({ axis, control, sign }) => {
    controls[control] = clampCharacterPoseControlValue(
      control,
      (baseControls[control] ?? 0) + sign * radiansToDegrees(delta[axis]),
      bodyType,
    );
  });

  return controls;
}
