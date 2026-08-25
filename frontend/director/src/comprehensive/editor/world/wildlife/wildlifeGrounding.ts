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
}

/**
 * Samples ground plus a fore/aft pair along the heading and folds them into a
 * ground pose. The three samples hit the shared quantized cache, so the
 * steady-state cost is three Map lookups. Missing fore/aft samples fall back
 * to the centre height (flat pitch contribution).
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
  // forward ground offset is (sin(yaw), cos(yaw)).
  const dx = Math.sin(headingRad) * probeHalfSpacingM;
  const dz = Math.cos(headingRad) * probeHalfSpacingM;
  const ahead = resolveWildlifeGroundY(sample(x + dx, z + dz), groundY);
  const behind = resolveWildlifeGroundY(sample(x - dx, z - dz), groundY);
  out.groundY = groundY;
  out.slopePitchRad = wildlifeSlopePitchRad(behind, ahead, probeHalfSpacingM * 2);
  return out;
}
