import { createWorldRng, hashCombine, worldStreamId } from "../worldRandom";

/**
 * Seeded starfield geometry.
 *
 * drei's `<Stars>` seeds its points from `Math.random()` and twinkles from the
 * wall clock, so two sessions of the same project would export different
 * night skies. This generator is a pure function of the world seed instead:
 * identical seeds always produce the identical star dome.
 */

/** Number of star points on the dome. */
export const STAR_FIELD_COUNT = 900;
/** Base radius of the star dome shell in metres. */
export const STAR_FIELD_RADIUS = 1500;
/** Depth of the star shell in metres (stars distribute between radius and radius + depth). */
export const STAR_FIELD_DEPTH = 240;

const STAR_STREAM = worldStreamId("sky-stars");

/**
 * Star positions on a dome shell of `radius..radius + depth`, biased to the
 * upper hemisphere with a small below-horizon margin so the dome still reads
 * from low camera angles.
 */
export function createStarFieldPositions(
  seed: number,
  count = STAR_FIELD_COUNT,
  radius = STAR_FIELD_RADIUS,
  depth = STAR_FIELD_DEPTH,
): Float32Array {
  const random = createWorldRng(hashCombine(seed, STAR_STREAM));
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    // sin(elevation) uniform in [-0.06, 1] keeps stars mostly above the horizon.
    const sinElevation = -0.06 + 1.06 * random();
    const azimuth = random() * Math.PI * 2;
    const shellRadius = radius + depth * random();
    const cosElevation = Math.sqrt(Math.max(0, 1 - sinElevation * sinElevation));
    positions[index * 3] = Math.sin(azimuth) * cosElevation * shellRadius;
    positions[index * 3 + 1] = sinElevation * shellRadius;
    positions[index * 3 + 2] = Math.cos(azimuth) * cosElevation * shellRadius;
  }
  return positions;
}
