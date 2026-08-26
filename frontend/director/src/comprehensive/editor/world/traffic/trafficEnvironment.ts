import type {
  DirectorWorldSettings,
  DirectorWorldWeather,
  WorldWeatherPreset,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  computeClimateSnowCover,
  computeClimateSurfaceWetness,
  computeEffectiveWorldSnowCover,
  computeEffectiveWorldWetness,
} from "../surface/worldSurfaceResponse";
import {
  evaluateWorldClimateSchedule,
  getWorldClimateSegmentPreset,
  getWorldClimateSegmentRampSeconds,
  getWorldClimateSegmentSeconds,
  isWorldWeatherEvolving,
  type WorldClimateState,
} from "../worldClimate";

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

function trafficPresetSpeedScale(preset: WorldWeatherPreset, intensity: number): number {
  const safeIntensity = clamp01(intensity);
  if (preset === "storm") return 1 - (0.25 + 0.2 * safeIntensity);
  if (preset === "rain") return 1 - 0.15 * safeIntensity;
  if (preset === "snow") return 1 - (0.15 + 0.15 * safeIntensity);
  return 1;
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
  return trafficPresetSpeedScale(weather.preset, weather.intensity);
}

/**
 * Continuous traffic speed scale at one world time. Static weather reproduces
 * the legacy authored scale; evolving weather follows the same smooth node
 * ramp as sky, precipitation, surfaces, and wildlife.
 */
export function evaluateTrafficWeatherSpeedScale(settings: DirectorWorldSettings, worldSeconds: number): number {
  if (!isWorldWeatherEvolving(settings)) return trafficWeatherSpeedScale(settings.weather);
  const schedule = evaluateWorldClimateSchedule(settings, worldSeconds);
  const from = trafficPresetSpeedScale(schedule.fromPreset, settings.weather.intensity);
  const to = trafficPresetSpeedScale(schedule.toPreset, settings.weather.intensity);
  return from + (to - from) * schedule.blend;
}

interface TrafficTravelClockCacheEntry {
  /** prefixSeconds[k] is accumulated weather-scaled time before segment k. */
  prefixSeconds: number[];
}

const TRAFFIC_TRAVEL_CLOCK_CACHE_LIMIT = 8;
const trafficTravelClockCache = new Map<string, TrafficTravelClockCacheEntry>();

function trafficTravelClockKey(settings: DirectorWorldSettings): string {
  return [
    settings.seed,
    settings.weather.preset,
    settings.weather.intensity,
    settings.weather.evolution?.periodSeconds,
  ].join("|");
}

/** Integral of the smooth speed ramp across part of one climate segment. */
function integrateTrafficSegment(settings: DirectorWorldSettings, segment: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  const intensity = settings.weather.intensity;
  const toPreset = getWorldClimateSegmentPreset(settings, segment);
  const toScale = trafficPresetSpeedScale(toPreset, intensity);
  if (segment === 0) return durationSeconds * toScale;

  const fromPreset = getWorldClimateSegmentPreset(settings, segment - 1);
  const fromScale = trafficPresetSpeedScale(fromPreset, intensity);
  const rampSeconds = getWorldClimateSegmentRampSeconds(settings, segment);
  const rampDuration = Math.min(durationSeconds, rampSeconds);
  const u = rampDuration / rampSeconds;
  // Integral from 0..u of smoothstep(x) = u^3 - 0.5u^4.
  const smoothIntegral = u * u * u - 0.5 * u * u * u * u;
  const rampTravel = fromScale * rampDuration + (toScale - fromScale) * rampSeconds * smoothIntegral;
  return rampTravel + Math.max(0, durationSeconds - rampSeconds) * toScale;
}

/**
 * Accumulated weather-scaled travel time, ∫ speedScale(t) dt.
 *
 * Feeding this clock to the stateless traffic flow lets cars slow and recover
 * through an evolving storm without jumping when the current scale changes.
 * The seeded schedule is integrated analytically and segment prefixes are
 * cached, so arbitrary seeks stay deterministic and cheap.
 */
export function evaluateTrafficTravelSeconds(settings: DirectorWorldSettings, worldSeconds: number): number {
  const seconds = Number.isFinite(worldSeconds) ? worldSeconds : 0;
  if (!isWorldWeatherEvolving(settings)) return seconds * trafficWeatherSpeedScale(settings.weather);
  if (seconds <= 0) return 0;

  const segmentSeconds = getWorldClimateSegmentSeconds(settings);
  const segment = Math.floor(seconds / segmentSeconds);
  const key = trafficTravelClockKey(settings);
  let entry = trafficTravelClockCache.get(key);
  if (!entry) {
    if (trafficTravelClockCache.size >= TRAFFIC_TRAVEL_CLOCK_CACHE_LIMIT) {
      const oldest = trafficTravelClockCache.keys().next().value;
      if (oldest !== undefined) trafficTravelClockCache.delete(oldest);
    }
    entry = { prefixSeconds: [0] };
    trafficTravelClockCache.set(key, entry);
  }

  while (entry.prefixSeconds.length <= segment) {
    const completedSegment = entry.prefixSeconds.length - 1;
    entry.prefixSeconds.push(
      entry.prefixSeconds[completedSegment]! + integrateTrafficSegment(settings, completedSegment, segmentSeconds),
    );
  }

  const secondsIntoSegment = seconds - segment * segmentSeconds;
  return entry.prefixSeconds[segment]! + integrateTrafficSegment(settings, segment, secondsIntoSegment);
}

/** Test seam for deterministic cache-order assertions. */
export function resetTrafficEnvironmentCaches(): void {
  trafficTravelClockCache.clear();
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

/**
 * Climate-vector road appearance: the same asphalt response driven by the
 * continuous climate wetness/snow terms, so an evolving cycle wets, dries,
 * and snow-dusts the road in step with the rest of the surface layer. A
 * static climate reproduces {@link computeRoadSurfaceAppearance} exactly
 * (locked by tests).
 */
export function computeClimateRoadSurfaceAppearance(climate: WorldClimateState): RoadSurfaceAppearance {
  const wetness = computeClimateSurfaceWetness(climate);
  const snowCover = computeClimateSnowCover(climate);
  return {
    colorScale: 1 - 0.45 * wetness,
    roughness: 1 - 0.62 * wetness,
    snowMix: 0.72 * snowCover,
  };
}
