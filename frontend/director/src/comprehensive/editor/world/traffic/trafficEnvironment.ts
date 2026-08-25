import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { computeEffectiveWorldSnowCover, computeEffectiveWorldWetness } from "../surface/worldSurfaceResponse";

/**
 * Weather and time-of-day responses for the ambient traffic layer.
 *
 * Everything here is a pure function of authored weather / evaluated solar
 * hours, so the layer stays a closed form of (seed, worldSeconds): scrubbing
 * and deterministic export replay identically, and nothing writes back into
 * System checkpoint state.
 */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Uniform lane speed multiplier for the current weather. Applied to a WHOLE
 * lane at once inside buildRoadTrafficStreams, never per car, so same-lane
 * relative speeds stay zero and the no-overtake guarantee holds.
 *
 * Clear/cloudy driving keeps the authored limit; rain slows moderately,
 * storms sharply, snow in between. Result stays within [0.55, 1].
 */
export function trafficWeatherSpeedScale(weather: DirectorWorldWeather): number {
  const intensity = clamp01(weather.intensity);
  if (weather.preset === "storm") return 1 - (0.25 + 0.2 * intensity);
  if (weather.preset === "rain") return 1 - 0.15 * intensity;
  if (weather.preset === "snow") return 1 - (0.15 + 0.15 * intensity);
  return 1;
}

/** Solar hours at which headlights are fully on (before dawn) / fully off. */
export const TRAFFIC_HEADLIGHT_DAWN_START_HOURS = 5.5;
export const TRAFFIC_HEADLIGHT_DAWN_END_HOURS = 7;
/** Solar hours at which headlights begin / finish turning on at dusk. */
export const TRAFFIC_HEADLIGHT_DUSK_START_HOURS = 17.5;
export const TRAFFIC_HEADLIGHT_DUSK_END_HOURS = 19;

/**
 * Headlight brightness [0, 1] from solar hours: 1 through the night, 0
 * through the day, smooth ramps across dawn and dusk. Pure in `hours`, which
 * itself is pure in (timeOfDay, worldSeconds), so seek(t) == play-to-t.
 */
export function computeTrafficHeadlightFactor(hours: number): number {
  const wrapped = ((hours % 24) + 24) % 24;
  const dawnOff = 1 - smoothstep(TRAFFIC_HEADLIGHT_DAWN_START_HOURS, TRAFFIC_HEADLIGHT_DAWN_END_HOURS, wrapped);
  const duskOn = smoothstep(TRAFFIC_HEADLIGHT_DUSK_START_HOURS, TRAFFIC_HEADLIGHT_DUSK_END_HOURS, wrapped);
  return Math.max(dawnOff, duskOn);
}

/** Deterministic asphalt appearance for the current weather. */
export interface RoadSurfaceAppearance {
  /** Multiplier on the base asphalt colour; wet asphalt darkens. */
  colorScale: number;
  /** Roughness; rain glazes the surface toward a sheen. */
  roughness: number;
  /** Blend toward snow white on the road surface; snow preset only. */
  snowMix: number;
}

/**
 * Wetness darkens and glazes the asphalt (the surface material patcher skips
 * `living-world-road-*` meshes, so this is the single owner of the road's
 * weather response); snow blends the surface toward trampled white.
 * `clear` + wetness 0 returns the dry base exactly.
 */
export function computeRoadSurfaceAppearance(weather: DirectorWorldWeather): RoadSurfaceAppearance {
  const wetness = computeEffectiveWorldWetness(weather);
  const snowCover = computeEffectiveWorldSnowCover(weather);
  return {
    colorScale: 1 - 0.45 * wetness,
    roughness: 1 - 0.62 * wetness,
    snowMix: 0.72 * snowCover,
  };
}
