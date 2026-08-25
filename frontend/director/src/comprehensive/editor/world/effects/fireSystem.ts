import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { worldRandom01 } from "../worldRandom";

/**
 * Mini fire-vs-weather system, entirely View-tier and entirely inside
 * effects/: a pure seeded evaluator that couples every fire emitter (its
 * particles, its glow pass, and its point light) to the global weather —
 * rain visibly smothers flames, storms nearly extinguish them, and wet
 * suppressed fires gutter episodically instead of dimming statically.
 *
 * This is NOT a spread simulation (that belongs to a System-tier CA per
 * survey §3.6): there is no grid, no state, no protocol field. Everything
 * is a closed-form function of `(weather, seedHash, worldSeconds)`, so
 * scrubbing and deterministic export hold by construction and the evaluator
 * needs no checkpoints.
 *
 * Consumers (EffectsLayer):
 * - fire particles: `uIntensity`, `uSizeScale`, and the `uBurn` shader ramp
 *   input all scale by the burn factor;
 * - sparks: intensity scales by the same factor (embers die in the rain);
 * - fire point lights: intensity dims via `computeFireLightState` options.
 */

/** Burn factor floor: authored fires never fully extinguish (previz intent). */
export const FIRE_BURN_FLOOR = 0.12;

/** Max fraction of the burn removed by full surface wetness. */
export const FIRE_WETNESS_SUPPRESSION = 0.65;

/**
 * Additional multiplicative suppression per preset at weather intensity 1.
 * Tuned so a fully soaked fire in a full storm bottoms out at the burn
 * floor: (1 - 0.65) * (1 - 0.7) = 0.105 < FIRE_BURN_FLOOR.
 */
export const FIRE_PRESET_SUPPRESSION: Readonly<Record<DirectorWorldWeather["preset"], number>> = {
  clear: 0,
  overcast: 0,
  rain: 0.45,
  storm: 0.7,
  snow: 0.3,
};

/** Max gutter oscillation depth when fully suppressed. */
export const FIRE_GUTTER_MAX_DEPTH = 0.4;

const TAU = Math.PI * 2;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export interface FireWeatherResponse {
  /** Steady-state burn multiplier before guttering, in [FIRE_BURN_FLOOR, 1]. */
  burn: number;
  /** Gutter oscillation depth in [0, FIRE_GUTTER_MAX_DEPTH]; 0 when dry. */
  gutterDepth: number;
}

/**
 * Steady-state fire response to the current weather block. Pure in
 * `weather`: wetness suppresses multiplicatively with the precipitation
 * preset (a soaked fire in a storm smolders at the floor), and dry clear
 * weather returns a full burn of exactly 1 with no guttering.
 *
 * @param weather - The global weather block.
 * @returns Burn multiplier and gutter depth for the flicker stage.
 */
export function evaluateFireWeatherResponse(weather: DirectorWorldWeather): FireWeatherResponse {
  const wetness = clamp01(Number.isFinite(weather.wetness) ? weather.wetness : 0);
  const intensity = clamp01(Number.isFinite(weather.intensity) ? weather.intensity : 0);
  const presetSuppression = FIRE_PRESET_SUPPRESSION[weather.preset] ?? 0;
  const burnRaw = (1 - FIRE_WETNESS_SUPPRESSION * wetness) * (1 - presetSuppression * intensity);
  const burn = Math.max(FIRE_BURN_FLOOR, burnRaw);
  // Guttering only appears once the weather actually bites the fire.
  const gutterDepth = FIRE_GUTTER_MAX_DEPTH * (1 - burn);
  return { burn, gutterDepth };
}

/**
 * Per-fire burn factor with seeded episodic guttering: a suppressed fire
 * surges and chokes on two incommensurate sine bands whose phases hash from
 * the fire's own seed, so neighbouring fires never gutter in sync yet every
 * scrub to the same `worldSeconds` reproduces the same value.
 *
 * Dry weather short-circuits to exactly 1 so the fast path costs nothing.
 *
 * @param weather - The global weather block.
 * @param seedHash - The fire effect's 32-bit system seed hash.
 * @param worldSeconds - The only time source.
 * @returns Burn multiplier in [FIRE_BURN_FLOOR, 1].
 */
export function evaluateFireBurnFactor(weather: DirectorWorldWeather, seedHash: number, worldSeconds: number): number {
  const { burn, gutterDepth } = evaluateFireWeatherResponse(weather);
  if (gutterDepth <= 0) return burn;
  const phaseA = worldRandom01(seedHash, 11) * TAU;
  const phaseB = worldRandom01(seedHash, 12) * TAU;
  const gutter =
    0.5 + 0.5 * (0.65 * Math.sin(worldSeconds * 1.7 + phaseA) + 0.35 * Math.sin(worldSeconds * 4.3 + phaseB));
  return Math.max(FIRE_BURN_FLOOR, burn * (1 - gutterDepth * gutter));
}
