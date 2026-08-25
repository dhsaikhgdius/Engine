import type { DirectorWorldWind } from "../schema/directorProject";

/**
 * Deterministic wind evaluation shared by every Living World layer.
 *
 * The gust model layers three incommensurate sine bands so the signal never
 * visibly repeats, while remaining a pure function of `worldSeconds`.
 */
export function getWorldWindSpeedMps(wind: DirectorWorldWind, worldSeconds: number): number {
  if (wind.gustiness <= 0) return wind.speedMps;
  const gust =
    Math.sin(worldSeconds * 0.9) * 0.55 +
    Math.sin(worldSeconds * 2.33 + 1.7) * 0.3 +
    Math.sin(worldSeconds * 5.71 + 4.2) * 0.15;
  return Math.max(0, wind.speedMps * (1 + wind.gustiness * 0.6 * gust));
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
  const radians = (wind.directionDegrees * Math.PI) / 180;
  output[0] = Math.sin(radians) * speed;
  output[1] = 0;
  output[2] = Math.cos(radians) * speed;
}
