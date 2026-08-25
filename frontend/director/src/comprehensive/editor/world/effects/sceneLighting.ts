import type { DirectorWorldSettings } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { evaluateSkyLighting, getSkySolarArc, type SkyLightingState } from "../sky/solar";
import type { WorldClimateState } from "../worldClimate";
import { evaluateWorldTimeOfDayHours } from "../worldTime";

/**
 * Per-frame scene-light coupling for the particle layer.
 *
 * Scattering media (smoke, steam, dust, rain, snow) emit nothing — they
 * scatter whatever light the sky provides — so their fragment ramps are
 * multiplied by a tint computed here on the CPU, once per frame, from the
 * same deterministic solar model that lights the rest of the world
 * (`evaluateSkyLighting`). Emissive kinds (fire body/glow, sparks) stay
 * unlit; fireflies instead ramp their emission UP as daylight fades.
 *
 * Everything is a pure function of `(settings, worldSeconds)` — no wall
 * clock, no unseeded randomness — so deterministic frame export holds.
 */

/**
 * Weight of the direct key light in the scattering blend:
 * `blend = ambientColor·ambientIntensity + sunColor·sunIntensity·0.5`.
 * Half weight because treating the full directional sun as flat ambient
 * over-brightens; a physical treatment would need per-particle phase
 * functions, which this layer deliberately avoids.
 */
export const SCENE_LIGHT_SUN_WEIGHT = 0.5;

/**
 * Tone floor added to both sides of the normalization so a clear midnight
 * lands near 0.08 instead of a pitch-black 0.03: particles stay readable as
 * dark silhouettes, mimicking dark-adapted exposure rather than raw radiance.
 */
export const SCENE_LIGHT_NIGHT_FLOOR = 0.1;

/** Firefly emission multiplier in full daylight; deep night reaches 1. */
export const FIREFLY_DAY_BOOST = 0.35;

const REC709_LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * Daylight easing mirrored from `evaluateSkyLighting` (sky/solar.ts does not
 * export its internal daylight factor): 0 deep night → 1 full day, easing
 * through twilight as the solar altitude sine crosses this band.
 */
const DAYLIGHT_EASE_MIN_SIN = -0.12;
const DAYLIGHT_EASE_MAX_SIN = 0.25;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** `ambient·ambientIntensity + sun·sunIntensity·SCENE_LIGHT_SUN_WEIGHT` per channel. */
function blendSceneLight(lighting: SkyLightingState): [number, number, number] {
  const sunScale = lighting.sunIntensity * SCENE_LIGHT_SUN_WEIGHT;
  return [
    lighting.ambientColor[0] * lighting.ambientIntensity + lighting.sunColor[0] * sunScale,
    lighting.ambientColor[1] * lighting.ambientIntensity + lighting.sunColor[1] * sunScale,
    lighting.ambientColor[2] * lighting.ambientIntensity + lighting.sunColor[2] * sunScale,
  ];
}

const luminanceOf = (rgb: readonly [number, number, number]): number =>
  rgb[0] * REC709_LUMA[0] + rgb[1] * REC709_LUMA[1] + rgb[2] * REC709_LUMA[2];

/**
 * Normalization anchor: the scattering blend at an unclouded clear noon.
 * Evaluated from the live solar model instead of a hardcoded constant so
 * "clear noon == level 1.0" stays true by construction if the sky constants
 * are ever re-tuned. Fields that cannot affect lighting are zeroed.
 */
const NOON_CLEAR_SETTINGS: DirectorWorldSettings = {
  enabled: true,
  seed: 0,
  wind: { directionDegrees: 0, speedMps: 0, gustiness: 0, turbulence: 0 },
  timeOfDay: { mode: "fixed", hours: 12, cycleMinutes: 12, drivesSky: true },
  weather: { preset: "clear", intensity: 0, wetness: 0, cloudCover: 0 },
};

const NOON_CLEAR_LUMINANCE = luminanceOf(blendSceneLight(evaluateSkyLighting(NOON_CLEAR_SETTINGS, 0)));

export interface EffectsSceneLighting {
  /**
   * Chromaticity of the combined sky light, max component normalized to 1:
   * cool blue on a clear night, warm near dawn/dusk, near-white at noon.
   */
  tintColor: [number, number, number];
  /** Normalized brightness: 1.0 clear noon, ≈0.08 clear midnight; overcast dims below clear. */
  tintLevel: number;
  /** Solar daylight factor (0 deep night → 1 full day); weather-independent. */
  daylight: number;
  /** Firefly emission multiplier: FIREFLY_DAY_BOOST by day → 1 at night. */
  fireflyNightBoost: number;
}

/**
 * Deterministic per-frame lighting inputs for the effect materials:
 * `uSceneLightColor = tintColor`, `uSceneLightLevel = tintLevel`,
 * `uNightBoost = fireflyNightBoost`.
 */
export function evaluateEffectsSceneLighting(
  settings: DirectorWorldSettings,
  worldSeconds: number,
  climate?: WorldClimateState,
): EffectsSceneLighting {
  const blend = blendSceneLight(evaluateSkyLighting(settings, worldSeconds, climate));
  const tintLevel = clamp01(
    (luminanceOf(blend) + SCENE_LIGHT_NIGHT_FLOOR) / (NOON_CLEAR_LUMINANCE + SCENE_LIGHT_NIGHT_FLOOR),
  );
  // The solar ambient floor keeps the blend strictly positive, but guard the
  // division so the function stays total for arbitrary future sky tunings.
  const maxComponent = Math.max(blend[0], blend[1], blend[2]);
  const tintColor: [number, number, number] =
    maxComponent > 0 ? [blend[0] / maxComponent, blend[1] / maxComponent, blend[2] / maxComponent] : [1, 1, 1];
  const hours = evaluateWorldTimeOfDayHours(settings.timeOfDay, worldSeconds);
  const daylight = smoothstep(DAYLIGHT_EASE_MIN_SIN, DAYLIGHT_EASE_MAX_SIN, getSkySolarArc(hours).altitudeSin);
  return {
    tintColor,
    tintLevel,
    daylight,
    fireflyNightBoost: FIREFLY_DAY_BOOST + (1 - FIREFLY_DAY_BOOST) * (1 - daylight),
  };
}
