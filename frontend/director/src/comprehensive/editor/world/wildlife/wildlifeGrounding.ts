import type { WorldGroundSampler } from "../worldGround";

/**
 * Render-side terrain grounding helpers for wildlife.
 *
 * Terrain sampling stays strictly OUTSIDE the simulation: `wildlifeSim`
 * checkpoint replay must be byte-identical regardless of scene contents, so
 * agents simulate on the flat ground plane and only the rendered transform is
 * snapped/tilted here. Everything in this module is a pure function so the
 * snap/tilt math is unit-testable without a scene.
 */

const TWO_PI = Math.PI * 2;

/**
 * Linear interpolation, shared by both wildlife render paths.
 *
 * @param a - Start value.
 * @param b - End value.
 * @param t - Interpolation factor in [0, 1].
 * @returns Linearly interpolated value between a and b.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Shortest-arc angle interpolation (slerp-free heading blend).
 *
 * @param a - Start angle, radians.
 * @param b - End angle, radians.
 * @param t - Interpolation factor in [0, 1].
 * @returns Interpolated angle via the shortest arc between a and b.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  else if (delta < -Math.PI) delta += TWO_PI;
  return a + delta * t;
}

/** Slope tilt clamp: bodies never pitch more than ±25° from level. */
export const WILDLIFE_MAX_SLOPE_TILT_RAD = (25 * Math.PI) / 180;

/**
 * Fore/aft slope-probe half-spacing (metres at sizeScale 1). Roughly half a
 * quadruped body length; the ground cache quantizes to a 0.5 m grid anyway,
 * so finer spacing would not add resolution.
 */
export const WILDLIFE_SLOPE_PROBE_HALF_SPACING_M = 0.6;

/** Sampled terrain height, or the sim's flat plane when nothing is below. */
export function resolveWildlifeGroundY(sampled: number | null, flatGroundY: number): number {
  return sampled === null || !Number.isFinite(sampled) ? flatGroundY : sampled;
}

/**
 * Body pitch (radians, Euler-YXZ X axis) from two heights sampled along the
 * heading. Positive X pitch points the nose DOWN in the wildlife model frame
 * (forward +Z), so ascending terrain (`heightAhead > heightBehind`) yields a
 * negative, nose-up pitch. Clamped to ±`maxTiltRad`.
 */
export function wildlifeSlopePitchRad(
  heightBehind: number,
  heightAhead: number,
  spacing: number,
  maxTiltRad: number = WILDLIFE_MAX_SLOPE_TILT_RAD,
): number {
  if (!Number.isFinite(heightBehind) || !Number.isFinite(heightAhead)) return 0;
  const raw = -Math.atan2(heightAhead - heightBehind, Math.max(spacing, 1e-3));
  // +0 to normalize the -0 that negating atan2(0, x) produces.
  return Math.min(maxTiltRad, Math.max(-maxTiltRad, raw)) + 0;
}

/**
 * Body roll (radians, Euler-YXZ Z axis) from two heights sampled across the
 * heading. Positive Z roll lifts the model's +X (right) side, so terrain
 * rising to the right yields a positive roll that lays the body onto the
 * lateral slope. Clamped to ±`maxTiltRad`.
 */
export function wildlifeSlopeRollRad(
  heightLeft: number,
  heightRight: number,
  spacing: number,
  maxTiltRad: number = WILDLIFE_MAX_SLOPE_TILT_RAD,
): number {
  if (!Number.isFinite(heightLeft) || !Number.isFinite(heightRight)) return 0;
  const raw = Math.atan2(heightRight - heightLeft, Math.max(spacing, 1e-3));
  return Math.min(maxTiltRad, Math.max(-maxTiltRad, raw)) + 0;
}

/**
 * Extra body lift (metres) that keeps the uphill feet out of the terrain
 * when the real slope exceeds the tilt clamp: the uphill probe sits
 * |heightDelta|/2 above the centre sample, while a body tilted at
 * `appliedTiltRad` only reaches tan(|tilt|) × halfSpan there — the shortfall
 * is how deep the uphill leg would visually sink.
 */
export function wildlifeClipLiftM(heightDeltaM: number, halfSpanM: number, appliedTiltRad: number): number {
  if (!Number.isFinite(heightDeltaM)) return 0;
  const reach = Math.tan(Math.abs(appliedTiltRad)) * Math.max(halfSpanM, 0);
  return Math.max(0, Math.abs(heightDeltaM) / 2 - reach);
}

/**
 * Vertical band offset for low-flying flocks (butterflies): the authored
 * altitude band follows local terrain relief measured against the flat ground
 * plane. Null samples (holes, water pits) keep the flat band.
 */
export function wildlifeTerrainLift(sampled: number | null, flatGroundY: number): number {
  return sampled === null || !Number.isFinite(sampled) ? 0 : sampled - flatGroundY;
}

export interface WildlifeGroundPose {
  /** Snapped ground height at the agent (terrain, or the sim plane). */
  groundY: number;
  /** Slope-following body pitch, radians (Euler-YXZ X axis), clamped. */
  slopePitchRad: number;
  /** Slope-following body roll, radians (Euler-YXZ Z axis), clamped. */
  slopeRollRad: number;
  /** Extra lift keeping uphill feet above ground when slopes beat the clamp. */
  clipLiftM: number;
}

/**
 * Samples ground plus fore/aft and left/right probe pairs around the heading
 * and folds them into a ground pose: snap height, slope pitch AND roll, and
 * a clip-compensation lift for slopes steeper than the tilt clamp. The five
 * samples hit the shared quantized cache, so the steady-state cost is five
 * Map lookups. Missing probe samples fall back to the centre height (flat
 * contribution).
 */
export function sampleWildlifeGroundPose(
  sample: WorldGroundSampler,
  x: number,
  z: number,
  headingRad: number,
  flatGroundY: number,
  probeHalfSpacingM: number,
  out: WildlifeGroundPose,
): WildlifeGroundPose {
  const groundY = resolveWildlifeGroundY(sample(x, z), flatGroundY);
  // Heading convention matches the sim: yaw about +Y with forward +Z, so the
  // forward offset is (sin(yaw), cos(yaw)) and the model's +X (right) side
  // maps to (cos(yaw), -sin(yaw)).
  const forwardDx = Math.sin(headingRad) * probeHalfSpacingM;
  const forwardDz = Math.cos(headingRad) * probeHalfSpacingM;
  const rightDx = Math.cos(headingRad) * probeHalfSpacingM;
  const rightDz = -Math.sin(headingRad) * probeHalfSpacingM;
  const ahead = resolveWildlifeGroundY(sample(x + forwardDx, z + forwardDz), groundY);
  const behind = resolveWildlifeGroundY(sample(x - forwardDx, z - forwardDz), groundY);
  const right = resolveWildlifeGroundY(sample(x + rightDx, z + rightDz), groundY);
  const left = resolveWildlifeGroundY(sample(x - rightDx, z - rightDz), groundY);
  const spacing = probeHalfSpacingM * 2;
  out.groundY = groundY;
  out.slopePitchRad = wildlifeSlopePitchRad(behind, ahead, spacing);
  out.slopeRollRad = wildlifeSlopeRollRad(left, right, spacing);
  out.clipLiftM = Math.max(
    wildlifeClipLiftM(ahead - behind, probeHalfSpacingM, out.slopePitchRad),
    wildlifeClipLiftM(right - left, probeHalfSpacingM, out.slopeRollRad),
  );
  return out;
}
