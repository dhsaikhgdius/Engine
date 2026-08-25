import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { WorldClimateState } from "../worldClimate";

/**
 * CPU-side surface response for Living World weather and wind.
 *
 * Wetness / snow / vegetation-wind strengths are a pure function of the
 * evaluated climate (or the authored weather block on the legacy path) plus
 * the evaluated wind speed. View shaders read these as uniforms; nothing here
 * touches three.js or wall-clock time.
 */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Names that mark a mesh or project object as vegetation for wind sway.
 * Keep this conservative: ordinary blocking meshes must not bend.
 */
export const WORLD_VEGETATION_NAME_PATTERN =
  /tree|bush|grass|foliage|plant|leaf|bamboo|pine|oak|willow|palm|fern|hedge|shrub|vegetation|植被|树木|灌木|草地|竹|松|柳|槐|叶/i;

/**
 * Returns true when a name matches the vegetation pattern, marking the
 * object for wind sway.
 *
 * @param name - The object name or mesh name to test.
 * @returns Whether this name indicates vegetation.
 */
export function isWorldVegetationName(name: string): boolean {
  return WORLD_VEGETATION_NAME_PATTERN.test(name);
}

/** Object ids whose authored names should wind-sway when instanced in a batch. */
export function collectWorldVegetationObjectIds(
  objects: ReadonlyArray<{ id: string; name: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const object of objects) {
    if (isWorldVegetationName(object.name)) ids.add(object.id);
  }
  return ids;
}

/**
 * Surface wetness actually seen by materials.
 *
 * `weather.wetness` is the authored accumulator (still-wet after a storm).
 * Precipitation presets also contribute, so switching to rain wets the set
 * even when the slider is still at 0 — otherwise rain particles fall on
 * bone-dry set walls.
 */
export function computeEffectiveWorldWetness(weather: DirectorWorldWeather): number {
  const authored = clamp01(weather.wetness);
  const intensity = clamp01(weather.intensity);
  let fromPrecipitation = 0;
  if (weather.preset === "rain") fromPrecipitation = 0.55 + 0.4 * intensity;
  else if (weather.preset === "storm") fromPrecipitation = 0.72 + 0.28 * intensity;
  else if (weather.preset === "snow") fromPrecipitation = 0.18 * intensity;
  return Math.max(authored, fromPrecipitation);
}

/** Upward-facing snow cover; 0 unless the weather preset is snow. */
export function computeEffectiveWorldSnowCover(weather: DirectorWorldWeather): number {
  if (weather.preset !== "snow") return 0;
  return clamp01(0.32 + 0.68 * clamp01(weather.intensity));
}

/** Lerp whose endpoints are bit-exact, so static climates reproduce legacy math. */
function exactLerp(from: number, to: number, t: number): number {
  if (t <= 0) return from;
  if (t >= 1) return to;
  return from + (to - from) * t;
}

/**
 * Climate-vector surface wetness: continuous across weather transitions.
 *
 * The precipitation floor blends the legacy rain/storm/snow constants by the
 * evaluated presences, so a static climate reproduces
 * {@link computeEffectiveWorldWetness} exactly while an evolving climate
 * ramps the floor smoothly and carries the integrated wetness.
 */
export function computeClimateSurfaceWetness(climate: WorldClimateState): number {
  const wetness = clamp01(climate.wetness);
  const intensity = clamp01(climate.intensity);
  const rainFloor = exactLerp(0.55 + 0.4 * intensity, 0.72 + 0.28 * intensity, climate.stormFactor);
  const floor = clamp01(climate.rainPresence * rainFloor + climate.snowPresence * 0.18 * intensity);
  return Math.max(wetness, floor);
}

/** Climate-vector snow cover: continuous version of the preset gate. */
export function computeClimateSnowCover(climate: WorldClimateState): number {
  return clamp01((0.32 + 0.68 * clamp01(climate.intensity)) * clamp01(climate.snowPresence));
}

/**
 * Vegetation sway amplitude scale. 12 m/s wind → 1; calm → 0.
 * Gusts already live in the evaluated wind speed.
 */
export function computeWorldVegetationWindStrength(windSpeedMps: number): number {
  return Math.min(1.25, Math.max(0, windSpeedMps / 12));
}

/**
 * Interpolates surface porosity from metalness, used to control how much
 * wetness darkens and smooths a surface. Vegetation uses a fixed high
 * porosity; non-vegetation lerps between 0.55 (dielectric) and 0.08 (metal).
 *
 * @param metalness - The material metalness factor [0, 1].
 * @param vegetation - Whether this is a vegetation mesh.
 * @returns Porosity factor in [0.08, 0.85].
 */
export function computeWorldSurfacePorosity(metalness: number, vegetation: boolean): number {
  if (vegetation) return 0.85;
  return 0.55 * (1 - clamp01(metalness)) + 0.08 * clamp01(metalness);
}

export interface WorldAmbientAudioGains {
  /** Low rumble; follows wind speed. */
  wind: number;
  /** Broadband hiss; rain and storm. */
  rain: number;
  /** Softer filtered noise; snow. */
  snow: number;
}

/** Master gains for the procedural world bed. 0 = silent. */
export function computeWorldAmbientAudioGains(
  weather: DirectorWorldWeather,
  windSpeedMps: number,
): WorldAmbientAudioGains {
  const intensity = clamp01(weather.intensity);
  const wind = Math.min(1, Math.max(0, windSpeedMps / 14)) * 0.45;
  let rain = 0;
  let snow = 0;
  if (weather.preset === "rain") rain = 0.2 + 0.75 * intensity;
  else if (weather.preset === "storm") rain = 0.45 + 0.55 * intensity;
  else if (weather.preset === "snow") snow = 0.12 + 0.4 * intensity;
  return { wind, rain, snow };
}

/**
 * Climate-vector ambient gains: the rain bed fades in/out with the evaluated
 * precipitation instead of stepping on the preset gate. Static climates
 * reproduce {@link computeWorldAmbientAudioGains} exactly.
 */
export function computeClimateAmbientAudioGains(
  climate: WorldClimateState,
  windSpeedMps: number,
): WorldAmbientAudioGains {
  const intensity = clamp01(climate.intensity);
  const wind = Math.min(1, Math.max(0, windSpeedMps / 14)) * 0.45;
  const rainGain = exactLerp(0.2 + 0.75 * intensity, 0.45 + 0.55 * intensity, climate.stormFactor);
  return {
    wind,
    rain: clamp01(climate.rainPresence * rainGain),
    snow: clamp01(climate.snowPresence * (0.12 + 0.4 * intensity)),
  };
}
