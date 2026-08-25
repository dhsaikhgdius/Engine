import { protocolKeys } from "../../../../../../packages/protocol/src/primitives";
import poseProtocol from "./poseProtocol.json";

export type PosePresetId = keyof typeof poseProtocol.presetIds;
export const POSE_PRESET_IDS = protocolKeys(poseProtocol.presetIds);

/**
 * Portable humanoid controls shared by the inspector, Agent authoring and all
 * runtime rig adapters. Values are degrees unless the suffix says otherwise.
 * Keeping this list explicit prevents an Agent from writing a typo that is
 * valid JSON but has no visible effect in the viewport.
 */
export type CharacterPoseControlKey = keyof typeof poseProtocol.controlKeys;
export const CHARACTER_POSE_CONTROL_KEYS = protocolKeys(poseProtocol.controlKeys);
const CHARACTER_POSE_CONTROL_KEY_SET = new Set<string>(CHARACTER_POSE_CONTROL_KEYS);

export function isCharacterPoseControlKey(control: string): control is CharacterPoseControlKey {
  return CHARACTER_POSE_CONTROL_KEY_SET.has(control);
}

export interface CharacterPoseControlValueLimits {
  min: number;
  max: number;
}

const CHARACTER_POSE_BASE_LIMITS = {
  degrees: { min: -90, max: 90 },
  extendedDegrees: { min: -120, max: 120 },
  bendDegrees: { min: 0, max: 150 },
  offsetMeters: { min: -1, max: 1 },
} as const;

function getBaseCharacterPoseControlValueLimits(control: string): CharacterPoseControlValueLimits {
  if (control === "body.offsetY") return CHARACTER_POSE_BASE_LIMITS.offsetMeters;
  if (control.endsWith("Elbow.bend") || control.endsWith("Knee.bend")) {
    return CHARACTER_POSE_BASE_LIMITS.bendDegrees;
  }
  if (control.endsWith("Shoulder.pitch") || control.endsWith("Hip.pitch")) {
    return CHARACTER_POSE_BASE_LIMITS.extendedDegrees;
  }
  return CHARACTER_POSE_BASE_LIMITS.degrees;
}

function getCharacterPoseBodyScale(bodyType?: string | null) {
  if (bodyType === "chibi") return 58 / 90;
  if (bodyType === "child") return 72 / 90;
  return 1;
}

/**
 * Single source of truth for UI sliders, Agent validation, and rig adapters.
 * Elbows and knees are one-direction hinge joints and need more than 90° for
 * useful crouch/kneel poses; shoulders and hips need a smaller extended arc.
 * Child/chibi rigs retain their stricter proportional safety envelope.
 */
export function getCharacterPoseControlValueLimits(
  control: string,
  bodyType?: string | null,
): CharacterPoseControlValueLimits {
  const base = getBaseCharacterPoseControlValueLimits(control);
  if (control === "body.offsetY") return base;
  const scale = getCharacterPoseBodyScale(bodyType);
  return { min: base.min * scale, max: base.max * scale };
}

export function clampCharacterPoseControlValue(control: string, value: number, bodyType?: string | null) {
  const limits = getCharacterPoseControlValueLimits(control, bodyType);
  return Math.min(limits.max, Math.max(limits.min, value));
}

export const CHARACTER_POSE_CONTROL_VALUE_LIMITS = {
  ...CHARACTER_POSE_BASE_LIMITS,
  byControl: Object.fromEntries(
    CHARACTER_POSE_CONTROL_KEYS.map((control) => [control, getCharacterPoseControlValueLimits(control)]),
  ) as Record<CharacterPoseControlKey, CharacterPoseControlValueLimits>,
} as const;
