import { MathUtils } from "three";
import {
  DEFAULT_CAMERA_PILOT_BANK_STRENGTH,
  DEFAULT_CAMERA_PILOT_INERTIA,
  DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING,
  normalizeCameraPilotFeel,
} from "../schema/viewportNavigation";

// Exponential response coefficients tuned so the fast and floaty endpoints
// feel distinct but never twitchy or sluggish at 60–120 Hz.
const PILOT_ACCELERATION_RESPONSE_FAST = 24;
const PILOT_ACCELERATION_RESPONSE_FLOATY = 3.5;
const PILOT_BRAKING_RESPONSE_FAST = 30;
const PILOT_BRAKING_RESPONSE_FLOATY = 5.5;
const PILOT_LOOK_RESPONSE_FAST = 38;
const PILOT_LOOK_RESPONSE_SMOOTH = 6;
// 8° keeps the bank perceptible without making the horizon feel tilted.
const PILOT_MAX_BANK_RADIANS = MathUtils.degToRad(8);
// Empirical gain that produces a natural-feeling bank at typical yaw rates.
const PILOT_TURN_BANK_GAIN = 0.012;

/**
 * Compute the exponential-easing response rate for the camera pilot's
 * movement (acceleration and braking).
 *
 * @param inertia - The pilot's inertia feel setting, normalized to 0–1.
 * @param accelerating - Whether the pilot is accelerating (true) or braking (false).
 * @returns The response coefficient for the exponential damping filter.
 */
export function getCameraPilotInputResponse(inertia: number, accelerating: boolean) {
  const amount = normalizeCameraPilotFeel(inertia, DEFAULT_CAMERA_PILOT_INERTIA);
  return MathUtils.lerp(
    accelerating ? PILOT_ACCELERATION_RESPONSE_FAST : PILOT_BRAKING_RESPONSE_FAST,
    accelerating ? PILOT_ACCELERATION_RESPONSE_FLOATY : PILOT_BRAKING_RESPONSE_FLOATY,
    amount,
  );
}

/**
 * Compute the exponential-easing response rate for the camera pilot's
 * look/rotate smoothing.
 *
 * @param smoothing - The look smoothing setting, normalized to 0–1.
 * @returns The response coefficient for the look damping filter.
 */
export function getCameraPilotLookResponse(smoothing: number) {
  const amount = normalizeCameraPilotFeel(smoothing, DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING);
  return MathUtils.lerp(PILOT_LOOK_RESPONSE_FAST, PILOT_LOOK_RESPONSE_SMOOTH, amount);
}

/**
 * Compute the target bank angle (radians) for the camera pilot, combining
 * strafe-induced roll with turn-induced roll.
 *
 * @param bankStrength - The bank strength setting, normalized to 0–1. A value
 *   of zero disables all banking.
 * @param strafe - Lateral movement intent, clamped to [-1, 1].
 * @param yawVelocity - Current yaw angular velocity in radians per second.
 * @returns Desired bank angle in radians, clamped to ±maximum.
 */
export function getCameraPilotBankTarget({
  bankStrength,
  strafe,
  yawVelocity,
}: {
  bankStrength: number;
  strafe: number;
  yawVelocity: number;
}) {
  const amount = normalizeCameraPilotFeel(bankStrength, DEFAULT_CAMERA_PILOT_BANK_STRENGTH);
  const maximum = PILOT_MAX_BANK_RADIANS * amount;
  if (maximum <= 0) return 0;

  const strafeBank = -MathUtils.clamp(strafe, -1, 1) * maximum;
  // Turn bank saturates at 70% of maximum so strafe always has reserve headroom.
  const turnBank = MathUtils.clamp(-yawVelocity * PILOT_TURN_BANK_GAIN * amount, -maximum * 0.7, maximum * 0.7);
  return MathUtils.clamp(strafeBank + turnBank, -maximum, maximum);
}

/**
 * Convert a response rate into a frame-rate-independent exponential damping
 * alpha for use in a one-pole low-pass filter.
 *
 * The frame delta is clamped to 0–100 ms to prevent spikes from yielding
 * an alpha of 1.0 (instant snap) and to guard against non-finite inputs.
 *
 * @param response - The response rate coefficient (higher = faster convergence).
 * @param delta - Frame delta in seconds.
 * @returns Alpha value in [0, 1) for the damping filter.
 */
export function getCameraPilotDampingAlpha(response: number, delta: number) {
  // Clamp delta to 0–100 ms: a zero delta would produce alpha=0 (frozen),
  // and a spike above 100 ms would produce alpha≈1 (instant snap).
  const frameDelta = Math.min(0.1, Math.max(0, Number.isFinite(delta) ? delta : 0));
  return 1 - Math.exp(-Math.max(0, response) * frameDelta);
}
