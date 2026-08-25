/**
 * @module Viewport navigation sensitivity, speed, and camera pilot feel constants with normalization.
 */

/** Default rotate sensitivity for viewport orbit controls. */
export const DEFAULT_VIEWPORT_ROTATE_SENSITIVITY = 0.35;
/** Default zoom sensitivity for viewport orbit controls. */
export const DEFAULT_VIEWPORT_ZOOM_SENSITIVITY = 0.4;
/** Default movement speed for viewport fly controls. */
export const DEFAULT_VIEWPORT_MOVE_SPEED = 10;
/** Default inertia for camera pilot auto-follow motion. */
export const DEFAULT_CAMERA_PILOT_INERTIA = 0.4;
/** Default look smoothing for camera pilot auto-follow motion. */
export const DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING = 0.25;
/** Default bank strength for camera pilot auto-follow banking effect. */
export const DEFAULT_CAMERA_PILOT_BANK_STRENGTH = 0.3;

/** Minimum allowed viewport sensitivity value. */
export const VIEWPORT_SENSITIVITY_MIN = 0.1;
/** Maximum allowed viewport sensitivity value. */
export const VIEWPORT_SENSITIVITY_MAX = 1.5;
/** Quantization step for viewport sensitivity sliders. */
export const VIEWPORT_SENSITIVITY_STEP = 0.05;
/** Minimum allowed viewport move speed. */
export const VIEWPORT_MOVE_SPEED_MIN = 1;
/** Maximum allowed viewport move speed. */
export const VIEWPORT_MOVE_SPEED_MAX = 100;
/** Quantization step for viewport move speed. */
export const VIEWPORT_MOVE_SPEED_STEP = 0.5;
/** Default character movement speed in the viewport. */
export const DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED = 1;
/** Minimum allowed character movement speed. */
export const VIEWPORT_CHARACTER_MOVE_SPEED_MIN = 0.25;
/** Maximum allowed character movement speed. */
export const VIEWPORT_CHARACTER_MOVE_SPEED_MAX = 3;
/** Quantization step for character movement speed. */
export const VIEWPORT_CHARACTER_MOVE_SPEED_STEP = 0.05;
/** Minimum allowed camera pilot feel value. */
export const CAMERA_PILOT_FEEL_MIN = 0;
/** Maximum allowed camera pilot feel value. */
export const CAMERA_PILOT_FEEL_MAX = 1;
/** Quantization step for camera pilot feel. */
export const CAMERA_PILOT_FEEL_STEP = 0.05;

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Clamps and quantizes a viewport sensitivity value to the valid range. */
export function normalizeViewportSensitivity(value: unknown, fallback: number) {
  const clamped = Math.min(VIEWPORT_SENSITIVITY_MAX, Math.max(VIEWPORT_SENSITIVITY_MIN, finiteNumber(value, fallback)));
  return Number((Math.round(clamped / VIEWPORT_SENSITIVITY_STEP) * VIEWPORT_SENSITIVITY_STEP).toFixed(2));
}

/** Clamps and quantizes a viewport move speed value to the valid range. */
export function normalizeViewportMoveSpeed(value: unknown) {
  const clamped = Math.min(
    VIEWPORT_MOVE_SPEED_MAX,
    Math.max(VIEWPORT_MOVE_SPEED_MIN, finiteNumber(value, DEFAULT_VIEWPORT_MOVE_SPEED)),
  );
  return Number((Math.round(clamped / VIEWPORT_MOVE_SPEED_STEP) * VIEWPORT_MOVE_SPEED_STEP).toFixed(1));
}

/** Clamps and quantizes a character move speed value to the valid range. */
export function normalizeViewportCharacterMoveSpeed(value: unknown) {
  const clamped = Math.min(
    VIEWPORT_CHARACTER_MOVE_SPEED_MAX,
    Math.max(VIEWPORT_CHARACTER_MOVE_SPEED_MIN, finiteNumber(value, DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED)),
  );
  return Number(
    (Math.round(clamped / VIEWPORT_CHARACTER_MOVE_SPEED_STEP) * VIEWPORT_CHARACTER_MOVE_SPEED_STEP).toFixed(2),
  );
}

/** Clamps and quantizes a camera pilot feel value to the valid range. */
export function normalizeCameraPilotFeel(value: unknown, fallback: number) {
  const clamped = Math.min(CAMERA_PILOT_FEEL_MAX, Math.max(CAMERA_PILOT_FEEL_MIN, finiteNumber(value, fallback)));
  return Number((Math.round(clamped / CAMERA_PILOT_FEEL_STEP) * CAMERA_PILOT_FEEL_STEP).toFixed(2));
}
