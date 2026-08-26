/**
 * Mannequin pose control math.
 *
 * Converts character pose control values (degrees) into radians for
 * the runtime skeleton. All functions clamp to the body-type-specific
 * limits defined in the pose schema.
 *
 * @module director/runtime/mannequin/mannequinPose
 */

import type { CharacterBodyType } from "./bodyTypes";
import { normalizeBodyType } from "./bodyTypes";
import { clampCharacterPoseControlValue, getCharacterPoseControlValueLimits } from "../../schema/poseSchema";

/** Convert degrees to radians. */
export function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

/** Convert radians to degrees. */
export function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

/** Maximum body.pitch limit for the given body type, in degrees. */
export function getBodyTypePoseLimit(bodyType?: string | null): number {
  return Math.round(getCharacterPoseControlValueLimits("body.pitch", normalizeBodyType(bodyType)).max * 1e6) / 1e6;
}

/**
 * Read pitch/yaw/roll control values for a body part prefix and return
 * a [pitch, yaw, roll] tuple in radians, clamped to body-type limits.
 */
export function getRotationFromControls(
  controls: Record<string, number>,
  prefix: string,
  bodyType?: CharacterBodyType,
): [number, number, number] {
  return [
    degreesToRadians(clampCharacterPoseControlValue(`${prefix}.pitch`, controls[`${prefix}.pitch`] ?? 0, bodyType)),
    degreesToRadians(clampCharacterPoseControlValue(`${prefix}.yaw`, controls[`${prefix}.yaw`] ?? 0, bodyType)),
    degreesToRadians(clampCharacterPoseControlValue(`${prefix}.roll`, controls[`${prefix}.roll`] ?? 0, bodyType)),
  ];
}

/** Read a single-axis control value and return it as a [value, 0, 0] rotation tuple. */
export function getSingleAxisRotation(
  controls: Record<string, number>,
  key: string,
  bodyType?: CharacterBodyType,
): [number, number, number] {
  return [degreesToRadians(clampCharacterPoseControlValue(key, controls[key] ?? 0, bodyType)), 0, 0];
}
