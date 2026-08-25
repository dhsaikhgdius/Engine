import type { DirectorWorldEffect } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { ResolvedWorldEffect } from "../livingWorldContracts";
import { hashCombine, worldRandom01, worldStreamId } from "../worldRandom";

/**
 * Fire effects additionally mount a flickering point light. Both the light
 * budget selection and the flicker signal are pure functions so deterministic
 * export holds and both are unit-testable without a scene.
 */

/** Maximum number of fire effects that receive a real point light. */
export const MAX_FIRE_LIGHTS = 8;

/** Warm campfire tone; constant so React never re-sets the color per frame. */
export const FIRE_LIGHT_COLOR = "#ff9a4a";

/**
 * Picks which fires get a real light: highest intensity first, ties broken by
 * id (code-point order) so the selection is stable across renders and
 * machines. Non-fire and zero-intensity entries never qualify.
 */
export function selectFireLightEffects(
  effects: readonly ResolvedWorldEffect[],
  maxLights: number = MAX_FIRE_LIGHTS,
): ResolvedWorldEffect[] {
  return effects
    .filter((entry) => entry.effect.kind === "fire" && entry.effect.intensity > 0)
    .sort((a, b) => {
      if (b.effect.intensity !== a.effect.intensity) return b.effect.intensity - a.effect.intensity;
      if (a.effect.id < b.effect.id) return -1;
      if (a.effect.id > b.effect.id) return 1;
      return 0;
    })
    .slice(0, Math.max(0, maxLights));
}

/** Cube shadow map resolution per face for the one shadow-casting fire. */
export const FIRE_SHADOW_MAP_SIZE = 512;

/** Shadow camera near plane, well inside the 8 m minimum light distance. */
export const FIRE_SHADOW_CAMERA_NEAR = 0.1;

/** Depth bias tuned against acne on the flickering 512px cube faces. */
export const FIRE_SHADOW_BIAS = -0.002;

/**
 * Shadow budget: exactly ONE fire may cast shadows. A point-light shadow
 * re-renders the scene into all six cube-map faces, so even two casters
 * would double that cost for marginal visual gain. The pick reuses the
 * light-budget ordering (highest intensity, ties by id) so it is stable
 * across renders and machines; null when no fire qualifies. The flag is
 * inert unless the renderer enables shadow maps — three.js keeps
 * object-level castShadow independent of renderer configuration.
 */
export function selectShadowCastingFireId(effects: readonly ResolvedWorldEffect[]): string | null {
  const [top] = selectFireLightEffects(effects, 1);
  return top ? top.effect.id : null;
}

export interface FireLightState {
  /** Point light intensity in candela (three r184 physical units), already flickered. */
  intensity: number;
  /** Falloff cutoff distance, clamped into [8, 15] m (decay 2 does the real falloff). */
  distance: number;
  /** Metres above the emitter origin so the light sits inside the flames. */
  offsetY: number;
  /** Raw flicker factor in [0.56, 1.0]; exposed for tests. */
  flicker: number;
}

/**
 * Candela at effect intensity 1 / sizeScale 1 (campfire). three r184 ships
 * physically-correct lights only: with decay 2 a PointLight needs tens of
 * candela to read on standard materials, so single-digit values vanish.
 * Scaling by sqrt(intensity x sizeScale) keeps a bonfire (2 x 2) at ~110 cd
 * instead of exploding multiplicatively.
 */
export const FIRE_LIGHT_BASE_INTENSITY = 34;

/** Cutoff clamp keeps small fires useful and large ones inside perf budget. */
export const FIRE_LIGHT_MIN_DISTANCE = 8;
/** Upper bound on light distance so large fires don't overtax shadow rendering. */
export const FIRE_LIGHT_MAX_DISTANCE = 15;

/**
 * Deterministic flicker: three incommensurate sine bands with phases hashed
 * from (worldSeed, effect). Pure in (effect, worldSeed, worldSeconds).
 */
export function computeFireLightState(
  effect: DirectorWorldEffect,
  worldSeed: number,
  worldSeconds: number,
): FireLightState {
  const hash = hashCombine(worldSeed, effect.seedOffset, worldStreamId(effect.id), worldStreamId("fire-light"));
  const phaseA = worldRandom01(hash, 1) * Math.PI * 2;
  const phaseB = worldRandom01(hash, 2) * Math.PI * 2;
  const phaseC = worldRandom01(hash, 3) * Math.PI * 2;
  const t = worldSeconds * effect.speedScale;
  const flicker =
    0.78 + 0.13 * Math.sin(t * 9.7 + phaseA) + 0.06 * Math.sin(t * 22.3 + phaseB) + 0.03 * Math.sin(t * 4.1 + phaseC);
  const scale = Math.sqrt(Math.max(0, effect.intensity * effect.sizeScale));
  return {
    intensity: FIRE_LIGHT_BASE_INTENSITY * scale * flicker,
    distance: Math.min(
      FIRE_LIGHT_MAX_DISTANCE,
      Math.max(FIRE_LIGHT_MIN_DISTANCE, 6 * effect.sizeScale * effect.intensity),
    ),
    offsetY: 0.55 * effect.sizeScale,
    flicker,
  };
}
