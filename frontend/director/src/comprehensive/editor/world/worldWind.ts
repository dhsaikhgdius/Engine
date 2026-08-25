import type { DirectorWorldWind } from "../schema/directorProject";

/**
 * Deterministic wind evaluation shared by every Living World layer.
 *
 * The gust model layers three incommensurate sine bands so the signal never
 * visibly repeats, while remaining a pure function of `worldSeconds`.
 * `turbulence` sharpens the model twice over: it adds a high-frequency
 * flutter band to the gust speed and lets the evaluated vector meander a few
 * degrees around the authored heading. Both contributions are scaled by
 * `gustiness`, so a perfectly steady wind (gustiness 0) stays an exact,
 * constant vector along the stored meteorological direction (degrees
 * clockwise from +Z) — that convention is frozen.
 */

/** Peak heading meander at full gustiness × turbulence, radians (≈ 9°). */
const WIND_MEANDER_MAX_RADIANS = 0.16;

/**
 * Normalised high-frequency flutter in [-1, 1]; the turbulence band of the
 * gust model. Two incommensurate sines so the flutter never visibly loops.
 */
export function getWorldWindTurbulence01(wind: DirectorWorldWind, worldSeconds: number): number {
  if (wind.turbulence <= 0) return 0;
  return wind.turbulence * (Math.sin(worldSeconds * 9.171 + 2.9) * 0.6 + Math.sin(worldSeconds * 14.83 + 0.7) * 0.4);
}

export function getWorldWindSpeedMps(wind: DirectorWorldWind, worldSeconds: number): number {
  if (wind.gustiness <= 0) return wind.speedMps;
  const gust =
    Math.sin(worldSeconds * 0.9) * 0.55 +
    Math.sin(worldSeconds * 2.33 + 1.7) * 0.3 +
    Math.sin(worldSeconds * 5.71 + 4.2) * 0.15;
  const flutter = getWorldWindTurbulence01(wind, worldSeconds);
  return Math.max(0, wind.speedMps * (1 + wind.gustiness * (0.6 * gust + 0.25 * flutter)));
}

/**
 * Slow heading deviation in radians around the authored direction. Scaled by
 * both gustiness and turbulence so steady winds never drift off their stored
 * meteorological heading.
 */
export function getWorldWindMeanderRadians(wind: DirectorWorldWind, worldSeconds: number): number {
  const amount = wind.gustiness * wind.turbulence;
  if (amount <= 0) return 0;
  const meander = Math.sin(worldSeconds * 0.53 + 1.3) * 0.7 + Math.sin(worldSeconds * 1.31 + 4.1) * 0.3;
  return amount * WIND_MEANDER_MAX_RADIANS * meander;
}

/**
 * World-space wind velocity in metres/second. Direction follows the
 * meteorological convention stored in the protocol: degrees clockwise from +Z.
 */
export function getWorldWindVector(wind: DirectorWorldWind, worldSeconds: number): [number, number, number] {
  const result: [number, number, number] = [0, 0, 0];
  writeWorldWindVector(result, wind, worldSeconds);
  return result;
}

/** Allocation-free companion for render-loop consumers with a stable tuple. */
export function writeWorldWindVector(
  output: [number, number, number],
  wind: DirectorWorldWind,
  worldSeconds: number,
): void {
  const speed = getWorldWindSpeedMps(wind, worldSeconds);
  const radians = (wind.directionDegrees * Math.PI) / 180 + getWorldWindMeanderRadians(wind, worldSeconds);
  output[0] = Math.sin(radians) * speed;
  output[1] = 0;
  output[2] = Math.cos(radians) * speed;
}
