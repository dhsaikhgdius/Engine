import { createWorldRng, hashCombine, worldRandom01, worldStreamId } from "../worldRandom";

/**
 * Seeded starfield geometry and twinkle.
 *
 * drei's `<Stars>` seeds its points from `Math.random()` and twinkles from the
 * wall clock, so two sessions of the same project would export different
 * night skies. This generator is a pure function of the world seed instead:
 * identical seeds always produce the identical star dome, and per-star
 * twinkle parameters come from the integer-hash `worldRandom01` streams (no
 * fract(sin) shader noise), evaluated against `worldSeconds` only.
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

/** Twinkle angular speed band, radians per world second. */
export const STAR_TWINKLE_MIN_SPEED = 0.6;
export const STAR_TWINKLE_MAX_SPEED = 2.6;
/** Twinkle modulation depth band: how far a star dips from full brightness. */
export const STAR_TWINKLE_MIN_AMOUNT = 0.25;
export const STAR_TWINKLE_MAX_AMOUNT = 0.75;
/** Per-star base brightness band, so the dome shows magnitude variety. */
export const STAR_MIN_BRIGHTNESS = 0.45;
export const STAR_MAX_BRIGHTNESS = 1;

const TWINKLE_STREAM = worldStreamId("sky-star-twinkle");
const FIELD_TWINKLE_PHASE = 1;
const FIELD_TWINKLE_SPEED = 2;
const FIELD_TWINKLE_AMOUNT = 3;
const FIELD_BRIGHTNESS = 4;

export interface StarFieldTwinkleAttributes {
  /** Per-star twinkle phase offset in [0, 2π). */
  phase: Float32Array;
  /** Per-star twinkle angular speed, radians per world second. */
  speed: Float32Array;
  /** Per-star modulation depth in [STAR_TWINKLE_MIN_AMOUNT, STAR_TWINKLE_MAX_AMOUNT]. */
  amount: Float32Array;
  /** Per-star base brightness in [STAR_MIN_BRIGHTNESS, STAR_MAX_BRIGHTNESS]. */
  brightness: Float32Array;
}

/**
 * Per-star twinkle parameters, one entry per star, from integer-hash streams.
 * A pure function of `(seed, count)`: the same dome always twinkles the same
 * way across sessions, scrubs, and exports.
 *
 * @param seed - The world seed.
 * @param count - Number of stars (must match the positions buffer).
 * @returns Flat per-star attribute arrays for the star shader.
 */
export function createStarFieldTwinkleAttributes(seed: number, count = STAR_FIELD_COUNT): StarFieldTwinkleAttributes {
  const fieldSeed = hashCombine(seed, TWINKLE_STREAM);
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  const amount = new Float32Array(count);
  const brightness = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    phase[index] = worldRandom01(fieldSeed, index, FIELD_TWINKLE_PHASE) * Math.PI * 2;
    speed[index] =
      STAR_TWINKLE_MIN_SPEED +
      (STAR_TWINKLE_MAX_SPEED - STAR_TWINKLE_MIN_SPEED) * worldRandom01(fieldSeed, index, FIELD_TWINKLE_SPEED);
    amount[index] =
      STAR_TWINKLE_MIN_AMOUNT +
      (STAR_TWINKLE_MAX_AMOUNT - STAR_TWINKLE_MIN_AMOUNT) * worldRandom01(fieldSeed, index, FIELD_TWINKLE_AMOUNT);
    brightness[index] =
      STAR_MIN_BRIGHTNESS +
      (STAR_MAX_BRIGHTNESS - STAR_MIN_BRIGHTNESS) * worldRandom01(fieldSeed, index, FIELD_BRIGHTNESS);
  }
  return { phase, speed, amount, brightness };
}

/**
 * Twinkle factor for one star at `worldSeconds` — the CPU twin of the star
 * shader's vertex formula. 1 means full brightness; the star dips by
 * `amount` on a deterministic sine of world time (never the wall clock).
 *
 * @param phase - The star's phase offset.
 * @param speed - The star's angular twinkle speed.
 * @param amount - The star's modulation depth.
 * @param worldSeconds - World time in seconds.
 * @returns Brightness factor in [1 - amount, 1].
 */
export function evaluateStarTwinkle(phase: number, speed: number, amount: number, worldSeconds: number): number {
  return 1 - amount * (0.5 + 0.5 * Math.sin(phase + speed * worldSeconds));
}
