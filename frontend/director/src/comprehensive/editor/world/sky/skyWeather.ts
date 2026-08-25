import type { DirectorWorldWeather } from "../../schema/directorProject";

/**
 * Weather → sky-appearance mapping shared by the whole sky layer.
 *
 * Every knob the five weather presets expose (direct-light survival, ambient
 * survival, effective cloud cover, star visibility, cloud opacity/size/tint)
 * is resolved here in one place so a preset change reads consistently across
 * the dome, the key/fill lights, the billboard clouds, and the star field.
 *
 * All outputs are pure functions of the weather block — `preset`,
 * `intensity`, `wetness`, and `cloudCover` are first-class inputs; no time,
 * no randomness — so lighting stays a deterministic function of
 * `(settings, worldSeconds)` upstream.
 */

type WeatherPreset = DirectorWorldWeather["preset"];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

/** Fraction of direct cloud-cover attenuation on the key light at full cover. */
export const SKY_WEATHER_COVER_ATTENUATION = 0.72;

/**
 * Direct key-light survival per preset at intensity 0 → 1. Clear stays
 * pristine; every other preset darkens further as its intensity rises so the
 * `intensity` slider visibly moves the light, not just particle counts.
 */
const PRESET_DIRECT_RANGE: Record<WeatherPreset, readonly [number, number]> = {
  clear: [1, 1],
  overcast: [0.72, 0.42],
  rain: [0.55, 0.3],
  snow: [0.66, 0.4],
  storm: [0.42, 0.16],
};

/** Ambient survival per preset; snow bounces light back, storms swallow it. */
const PRESET_AMBIENT_RANGE: Record<WeatherPreset, readonly [number, number]> = {
  clear: [1, 1],
  overcast: [0.92, 0.75],
  rain: [0.78, 0.58],
  snow: [1, 1.08],
  storm: [0.68, 0.42],
};

/**
 * Minimum sky coverage each preset imposes at intensity 0 → 1. An overcast or
 * storm sky must LOOK covered even when the authored `cloudCover` slider was
 * left low; the authored value still wins when it is higher.
 */
const PRESET_COVER_FLOOR: Record<WeatherPreset, readonly [number, number]> = {
  clear: [0, 0],
  overcast: [0.72, 0.92],
  rain: [0.6, 0.9],
  snow: [0.5, 0.8],
  storm: [0.85, 1],
};

/** Star visibility per preset at intensity 0 → 1 (before cover attenuation). */
const PRESET_STAR_RANGE: Record<WeatherPreset, readonly [number, number]> = {
  clear: [1, 1],
  overcast: [0.3, 0.08],
  rain: [0.18, 0.06],
  snow: [0.35, 0.18],
  storm: [0.05, 0.01],
};

/** Billboard-cloud opacity multiplier per preset at intensity 0 → 1. */
const PRESET_CLOUD_OPACITY_RANGE: Record<WeatherPreset, readonly [number, number]> = {
  clear: [1, 1],
  overcast: [1.45, 1.75],
  rain: [1.5, 1.85],
  snow: [1.25, 1.45],
  storm: [1.65, 2.1],
};

/** Billboard-cloud size multiplier per preset at intensity 0 → 1. */
const PRESET_CLOUD_SIZE_RANGE: Record<WeatherPreset, readonly [number, number]> = {
  clear: [1, 1],
  overcast: [1.25, 1.55],
  rain: [1.2, 1.55],
  snow: [1.15, 1.4],
  storm: [1.35, 1.75],
};

/** Cloud brightness multiplier: 1 = bright fair-weather puffs, low = storm slabs. */
const PRESET_CLOUD_DARKEN_RANGE: Record<WeatherPreset, readonly [number, number]> = {
  clear: [1, 1],
  overcast: [0.8, 0.68],
  rain: [0.7, 0.55],
  snow: [0.92, 0.86],
  storm: [0.55, 0.35],
};

export interface SkyWeatherMood {
  /** Fraction of direct key light surviving preset, intensity, and cover. */
  directTransmission: number;
  /** Ambient (hemisphere) survival factor for the preset and intensity. */
  ambientScale: number;
  /**
   * Sky coverage actually shown: the authored `cloudCover` raised to the
   * preset's floor. Drives cloud cluster count, the dome cloud shader, star
   * hiding, and turbidity so heavy presets read covered by default.
   */
  effectiveCloudCover: number;
  /** Star visibility factor before the night/cover attenuation upstream. */
  starVisibility: number;
  /** Multiplier on the billboard-cloud base opacity. */
  cloudOpacityScale: number;
  /** Multiplier on the billboard-cloud quad size (puffs merge into banks). */
  cloudSizeScale: number;
  /** Brightness multiplier for cloud tinting: storms turn slate-dark. */
  cloudShaderDarkening: number;
}

/**
 * Resolves the full sky appearance for a weather block.
 *
 * @param weather - The current world weather settings.
 * @returns Deterministic appearance parameters for the sky layer.
 */
export function evaluateSkyWeatherMood(weather: DirectorWorldWeather): SkyWeatherMood {
  const intensity = clamp01(weather.intensity);
  const cover = clamp01(weather.cloudCover);
  const preset = weather.preset;

  const coverFloor = PRESET_COVER_FLOOR[preset];
  const effectiveCloudCover = clamp01(Math.max(cover, lerp(coverFloor[0], coverFloor[1], intensity)));

  const directRange = PRESET_DIRECT_RANGE[preset];
  const directTransmission =
    (1 - SKY_WEATHER_COVER_ATTENUATION * effectiveCloudCover) * lerp(directRange[0], directRange[1], intensity);

  const ambientRange = PRESET_AMBIENT_RANGE[preset];
  const starRange = PRESET_STAR_RANGE[preset];
  const opacityRange = PRESET_CLOUD_OPACITY_RANGE[preset];
  const sizeRange = PRESET_CLOUD_SIZE_RANGE[preset];
  const darkenRange = PRESET_CLOUD_DARKEN_RANGE[preset];

  return {
    directTransmission,
    ambientScale: lerp(ambientRange[0], ambientRange[1], intensity),
    effectiveCloudCover,
    starVisibility: lerp(starRange[0], starRange[1], intensity),
    cloudOpacityScale: lerp(opacityRange[0], opacityRange[1], intensity),
    cloudSizeScale: lerp(sizeRange[0], sizeRange[1], intensity),
    cloudShaderDarkening: lerp(darkenRange[0], darkenRange[1], intensity),
  };
}
