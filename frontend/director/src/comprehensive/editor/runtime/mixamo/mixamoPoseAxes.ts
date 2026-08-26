/**
 * Declarative binding between Director's portable pose controls and the local
 * Euler axes of a standard Mixamo deform skeleton.
 *
 * This table is the single source of truth for both directions:
 * `getMixamoPoseBoneRotations` drives the viewport, the Blender live bridge and
 * the Unity connector port, while `getMixamoPoseControlsFromBoneRotation`
 * turns a bone rotation edited in the viewport back into portable controls.
 * Declaring the axes once keeps the two directions from drifting apart, which a
 * hand-written inverse would not.
 *
 * @module director/runtime/mixamo/mixamo-pose-axes
 */

import type { CharacterBodyType } from "../mannequin/bodyTypes";
import { degreesToRadians, radiansToDegrees } from "../mannequin/mannequinPose";
import { clampCharacterPoseControlValue, type CharacterPoseControlKey } from "../../schema/poseSchema";
import mixamoBoneRoleAliases from "./mixamoBoneRoleAliases.json";

export const MIXAMO_BONE_ROLE_ALIASES = mixamoBoneRoleAliases;

export type MixamoBoneRole = keyof typeof MIXAMO_BONE_ROLE_ALIASES;

/** Index into a bone's local XYZ Euler triple. */
export type MixamoPoseAxis = 0 | 1 | 2;

/** A bone-local rotation triple in radians, applied in XYZ order. */
export type MixamoBoneRotationMap = Partial<Record<MixamoBoneRole, [number, number, number]>>;

/**
 * Mixamo characters are authored in a T-pose while Director's static neutral
 * lowers both arms. A sampled clip already carries its own shoulder stance, so
 * this offset applies to static poses only.
 */
export const MIXAMO_STATIC_NEUTRAL_SHOULDER_RADIANS = degreesToRadians(70);

export interface MixamoPoseAxisBinding {
  axis: MixamoPoseAxis;
  control: CharacterPoseControlKey;
  /** Mirrored limbs invert the control so positive degrees stay anatomical. */
  sign: 1 | -1;
}

export interface MixamoPoseBoneBinding {
  /** At most one control per axis, so the inverse stays unambiguous. */
  readonly axes: readonly MixamoPoseAxisBinding[];
  readonly staticNeutral?: { readonly axis: MixamoPoseAxis; readonly radians: number };
}

const SHOULDER_STATIC_NEUTRAL = { axis: 0, radians: MIXAMO_STATIC_NEUTRAL_SHOULDER_RADIANS } as const;

/**
 * Mixamo's upper-arm local Y axis follows the arm, local X points along the
 * character's front/back axis and local Z points down, so the neutral arm
 * lowering belongs on local X rather than local Z. Leg chains use the opposite
 * bend/spread signs from the procedural mannequin. Keeping these conventions
 * here makes the editor controls portable without baking asset-specific
 * rotations into stored projects.
 */
export const MIXAMO_POSE_AXIS_BINDINGS: Readonly<Record<MixamoBoneRole, MixamoPoseBoneBinding>> = {
  body: {
    axes: [
      { axis: 0, control: "body.pitch", sign: 1 },
      { axis: 1, control: "body.yaw", sign: 1 },
      { axis: 2, control: "body.roll", sign: 1 },
    ],
  },
  torso: {
    axes: [
      { axis: 0, control: "torso.pitch", sign: 1 },
      { axis: 1, control: "torso.yaw", sign: 1 },
      { axis: 2, control: "torso.roll", sign: 1 },
    ],
  },
  head: {
    axes: [
      { axis: 0, control: "head.pitch", sign: 1 },
      { axis: 1, control: "head.yaw", sign: 1 },
      { axis: 2, control: "head.roll", sign: 1 },
    ],
  },
  leftShoulder: {
    axes: [
      { axis: 0, control: "leftShoulder.spread", sign: 1 },
      { axis: 1, control: "leftShoulder.twist", sign: 1 },
      { axis: 2, control: "leftShoulder.pitch", sign: 1 },
    ],
    staticNeutral: SHOULDER_STATIC_NEUTRAL,
  },
  rightShoulder: {
    axes: [
      { axis: 0, control: "rightShoulder.spread", sign: -1 },
      { axis: 1, control: "rightShoulder.twist", sign: 1 },
      { axis: 2, control: "rightShoulder.pitch", sign: -1 },
    ],
    staticNeutral: SHOULDER_STATIC_NEUTRAL,
  },
  leftElbow: { axes: [{ axis: 2, control: "leftElbow.bend", sign: 1 }] },
  rightElbow: { axes: [{ axis: 2, control: "rightElbow.bend", sign: -1 }] },
  leftHand: {
    axes: [
      { axis: 0, control: "leftHand.pitch", sign: 1 },
      { axis: 1, control: "leftHand.twist", sign: 1 },
      { axis: 2, control: "leftHand.roll", sign: 1 },
    ],
  },
  rightHand: {
    axes: [
      { axis: 0, control: "rightHand.pitch", sign: 1 },
      { axis: 1, control: "rightHand.twist", sign: 1 },
      { axis: 2, control: "rightHand.roll", sign: 1 },
    ],
  },
  leftHip: {
    axes: [
      { axis: 0, control: "leftHip.pitch", sign: 1 },
      { axis: 1, control: "leftHip.twist", sign: 1 },
      { axis: 2, control: "leftHip.spread", sign: -1 },
    ],
  },
  rightHip: {
    axes: [
      { axis: 0, control: "rightHip.pitch", sign: 1 },
      { axis: 1, control: "rightHip.twist", sign: 1 },
      { axis: 2, control: "rightHip.spread", sign: -1 },
    ],
  },
  leftKnee: { axes: [{ axis: 0, control: "leftKnee.bend", sign: -1 }] },
  rightKnee: { axes: [{ axis: 0, control: "rightKnee.bend", sign: -1 }] },
  leftFoot: {
    axes: [
      { axis: 0, control: "leftFoot.pitch", sign: 1 },
      { axis: 1, control: "leftFoot.twist", sign: 1 },
      { axis: 2, control: "leftFoot.roll", sign: 1 },
    ],
  },
  rightFoot: {
    axes: [
      { axis: 0, control: "rightFoot.pitch", sign: 1 },
      { axis: 1, control: "rightFoot.twist", sign: 1 },
      { axis: 2, control: "rightFoot.roll", sign: 1 },
    ],
  },
};

const MIXAMO_POSE_AXIS_BINDING_ENTRIES = Object.entries(MIXAMO_POSE_AXIS_BINDINGS) as Array<
  [MixamoBoneRole, MixamoPoseBoneBinding]
>;

/** All bone roles Director can pose, in table order. */
export const MIXAMO_POSE_BONE_ROLES = MIXAMO_POSE_AXIS_BINDING_ENTRIES.map(([role]) => role);

function getStaticNeutralRadians(binding: MixamoPoseBoneBinding, axis: MixamoPoseAxis, animated: boolean) {
  if (animated || binding.staticNeutral?.axis !== axis) return 0;
  return binding.staticNeutral.radians;
}

/** Maps Director's semantic controls onto a standard Mixamo T-pose. */
export function getMixamoPoseBoneRotations(
  controls: Record<string, number>,
  bodyType?: CharacterBodyType,
  animated = false,
): MixamoBoneRotationMap {
  const rotations: MixamoBoneRotationMap = {};

  MIXAMO_POSE_AXIS_BINDING_ENTRIES.forEach(([role, binding]) => {
    const rotation: [number, number, number] = [0, 0, 0];
    if (!animated && binding.staticNeutral) {
      rotation[binding.staticNeutral.axis] = binding.staticNeutral.radians;
    }
    binding.axes.forEach(({ axis, control, sign }) => {
      const degrees = clampCharacterPoseControlValue(control, controls[control] ?? 0, bodyType);
      rotation[axis] += sign * degreesToRadians(degrees);
    });
    rotations[role] = rotation;
  });

  return rotations;
}

/**
 * Inverse of {@link getMixamoPoseBoneRotations} for a single bone.
 *
 * Axes the role does not bind are dropped rather than approximated: a knee is a
 * one-axis hinge, so a viewport drag that twists it must not invent a control
 * that the forward mapping would never produce.
 *
 * @param role - The semantic bone role being edited.
 * @param rotation - The bone-local XYZ rotation offset, in radians.
 * @param bodyType - Body type whose limits clamp the recovered degrees.
 * @param animated - True when a sampled clip owns the base pose.
 * @returns The portable pose controls that reproduce this rotation.
 */
export function getMixamoPoseControlsFromBoneRotation(
  role: MixamoBoneRole,
  rotation: readonly [number, number, number],
  bodyType?: CharacterBodyType,
  animated = false,
): Partial<Record<CharacterPoseControlKey, number>> {
  const binding = MIXAMO_POSE_AXIS_BINDINGS[role];
  const controls: Partial<Record<CharacterPoseControlKey, number>> = {};

  binding.axes.forEach(({ axis, control, sign }) => {
    const offset = rotation[axis] - getStaticNeutralRadians(binding, axis, animated);
    controls[control] = clampCharacterPoseControlValue(control, radiansToDegrees(sign * offset), bodyType);
  });

  return controls;
}
