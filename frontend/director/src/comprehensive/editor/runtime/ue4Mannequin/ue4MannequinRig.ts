/**
 * UE4 Mannequin skeleton rig mapping.
 *
 * Loads bone-scale, position-offset, and rotation maps from the
 * UE4 mannequin rig configuration and applies body-type-specific
 * adjustments to pose controls.
 *
 * @module director/runtime/ue4Mannequin/ue4MannequinRig
 */

import rigConfig from "./ue4MannequinRig.json";
import type { CharacterBodyType } from "../mannequin/bodyTypes";
import { clampCharacterPoseControlValue } from "../../schema/poseSchema";
import { degreesToRadians } from "../mannequin/mannequinPose";

type Vec3 = [number, number, number];

/** Per-bone scale multipliers for the UE4 mannequin skeleton. */
export type UE4BoneScaleMap = Record<string, Vec3>;
/** Per-bone position offsets for the UE4 mannequin skeleton. */
export type UE4BonePositionOffsetMap = Record<string, Vec3>;
/** Per-bone rotation values for the UE4 mannequin skeleton. */
export type UE4BoneRotationMap = Record<string, Vec3>;

type UE4BodyProfile = {
  modelScale: number[];
  groundedLabelY: number;
  boneScales: Record<string, number[]>;
};

const bodyProfiles = rigConfig.bodyProfiles as Record<CharacterBodyType, UE4BodyProfile>;

function cloneVec3(values: number[]): Vec3 {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("UE4 rig vectors must contain three finite numbers");
  }
  return [values[0], values[1], values[2]];
}

function cloneVec3Map(values: Record<string, number[]>): Record<string, Vec3> {
  return Object.fromEntries(Object.entries(values).map(([bone, vector]) => [bone, cloneVec3(vector)]));
}

function bodyProfile(bodyType?: CharacterBodyType): UE4BodyProfile {
  return bodyProfiles[bodyType ?? "mannequin"] ?? bodyProfiles.mannequin;
}

/** Resolve a Director asset URL by joining a base URL with an asset path. */
export function resolveDirectorAssetUrl(baseUrl: string, assetPath: string) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}${assetPath}`;
}

/** Canonical API path for the mannequin GLB model. */
export const DIRECTOR_MANNEQUIN_API_URL = "/te-man/director/mannequin.glb";

/** Resolve the mannequin model URL, using the extension path when available. */
export function resolveMannequinModelUrl(baseUrl: string, pathname = "") {
  if (pathname.includes("/extensions/")) return DIRECTOR_MANNEQUIN_API_URL;
  return resolveDirectorAssetUrl(baseUrl, "models/storyai-open-mannequin.glb");
}

/** Resolved URL for the UE4 mannequin model at build time. */
export const UE4_MANNEQUIN_MODEL_URL = resolveMannequinModelUrl(
  import.meta.env.BASE_URL,
  typeof window === "undefined" ? "" : window.location.pathname,
);

/** Frozen copy of the UE4 mannequin bone name map. */
export const UE4_MANNEQUIN_BONE_MAP = { ...rigConfig.boneMap };

/** Model scale vector for the given body type. */
export function getUE4ModelScale(bodyType?: CharacterBodyType): Vec3 {
  return cloneVec3(bodyProfile(bodyType).modelScale);
}

/** Grounded label Y offset for the given body type. */
export function getUE4GroundedLabelY(bodyType?: CharacterBodyType): number {
  return bodyProfile(bodyType).groundedLabelY;
}

/** Neutral-pose bone rotations from the rig configuration. */
export function getUE4NeutralPoseBoneRotations(): UE4BoneRotationMap {
  return cloneVec3Map(rigConfig.neutralRotations);
}

/** Per-body-type bone scale multipliers from the rig configuration. */
export function getUE4BodyBoneScales(bodyType: CharacterBodyType = "mannequin"): UE4BoneScaleMap {
  return cloneVec3Map(bodyProfile(bodyType).boneScales);
}

function radians(control: string, value: number, bodyType?: CharacterBodyType) {
  return degreesToRadians(clampCharacterPoseControlValue(control, value, bodyType));
}

function ue4Rotation(
  controls: Record<string, number>,
  prefix: string,
  axes: readonly (readonly [suffix: string, sign: 1 | -1])[],
  bodyType?: CharacterBodyType,
): Vec3 {
  return axes.map(([suffix, sign]) => {
    const control = `${prefix}.${suffix}`;
    return sign * radians(control, controls[control] ?? 0, bodyType);
  }) as Vec3;
}

const SPINE_AXES = [
  ["yaw", 1],
  ["roll", 1],
  ["pitch", -1],
] as const;
const HEAD_AXES = [
  ["yaw", 1],
  ["roll", 1],
  ["pitch", 1],
] as const;
const LIMB_END_AXES = [
  ["twist", 1],
  ["roll", 1],
  ["pitch", 1],
] as const;
const ue4SpineRotation = (controls: Record<string, number>, prefix: string, bodyType?: CharacterBodyType) =>
  ue4Rotation(controls, prefix, SPINE_AXES, bodyType);
const ue4HeadRotation = (controls: Record<string, number>, bodyType?: CharacterBodyType) =>
  ue4Rotation(controls, "head", HEAD_AXES, bodyType);
const ue4ShoulderRotation = (controls: Record<string, number>, prefix: string, bodyType?: CharacterBodyType) =>
  ue4Rotation(
    controls,
    prefix,
    [
      ["twist", 1],
      ["spread", 1],
      ["pitch", -1],
    ],
    bodyType,
  );
const ue4HipRotation = (controls: Record<string, number>, prefix: string, bodyType?: CharacterBodyType) =>
  ue4Rotation(
    controls,
    prefix,
    [
      ["twist", 1],
      ["spread", -1],
      ["pitch", 1],
    ],
    bodyType,
  );

function ue4LimbBendRotation(controls: Record<string, number>, key: string, bodyType?: CharacterBodyType): Vec3 {
  return [0, 0, -radians(key, controls[key] ?? 0, bodyType)];
}

function ue4LimbEndRotation(controls: Record<string, number>, prefix: string, bodyType?: CharacterBodyType): Vec3 {
  return ue4Rotation(controls, prefix, LIMB_END_AXES, bodyType);
}

/** Pose-driven bone position offsets. Returns pelvis offset when body.offsetY is non-zero. */
export function getUE4PoseBonePositionOffsets(controls: Record<string, number>): UE4BonePositionOffsetMap {
  const bodyOffsetY = controls["body.offsetY"] ?? 0;
  return bodyOffsetY === 0 ? {} : { Bip001_Pelvis_03: [0, bodyOffsetY, 0] };
}

/** Pose-driven bone rotations for every mapped UE4 mannequin bone. */
export function getUE4PoseBoneRotations(
  controls: Record<string, number>,
  bodyType?: CharacterBodyType,
): UE4BoneRotationMap {
  return {
    Bip001_Pelvis_03: ue4SpineRotation(controls, "body", bodyType),
    Bip001_Spine1_05: ue4SpineRotation(controls, "torso", bodyType),
    Bip001_Head_055: ue4HeadRotation(controls, bodyType),
    Bip001_L_UpperArm_08: ue4ShoulderRotation(controls, "leftShoulder", bodyType),
    Bip001_R_UpperArm_032: ue4ShoulderRotation(controls, "rightShoulder", bodyType),
    Bip001_L_Forearm_09: ue4LimbBendRotation(controls, "leftElbow.bend", bodyType),
    Bip001_R_Forearm_033: ue4LimbBendRotation(controls, "rightElbow.bend", bodyType),
    Bip001_L_Hand_010: ue4LimbEndRotation(controls, "leftHand", bodyType),
    Bip001_R_Hand_034: ue4LimbEndRotation(controls, "rightHand", bodyType),
    Bip001_L_Thigh_057: ue4HipRotation(controls, "leftHip", bodyType),
    Bip001_R_Thigh_061: ue4HipRotation(controls, "rightHip", bodyType),
    Bip001_L_Calf_058: ue4LimbBendRotation(controls, "leftKnee.bend", bodyType),
    Bip001_R_Calf_062: ue4LimbBendRotation(controls, "rightKnee.bend", bodyType),
    Bip001_L_Foot_059: ue4LimbEndRotation(controls, "leftFoot", bodyType),
    Bip001_R_Foot_063: ue4LimbEndRotation(controls, "rightFoot", bodyType),
  };
}
