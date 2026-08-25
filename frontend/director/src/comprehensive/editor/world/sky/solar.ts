import type { DirectorWorldSettings, DirectorWorldWeather } from "../../schema/directorProject";
import { blendWorldPresetScalar, type WorldClimateState } from "../worldClimate";
import { evaluateWorldTimeOfDayHours } from "../worldTime";
import {
  ATMOSPHERE_SUN_SCALE_BASE,
  chromaticityOf,
  getAtmosphereGroundAlbedo,
  getAtmosphereMieScale,
  solveAtmosphere,
  type AtmosphereSolution,
} from "./atmosphere";

/**
 * Pure solar/sky lighting model for the Living World sky layer.
 *
 * Everything in this module is a deterministic function of the project world
 * settings and `worldSeconds`; no wall clock, no unseeded randomness. The
 * solar arc is intentionally simple previz lighting, not an ephemeris:
 * sunrise at 6h, solar noon at 12h, sunset at 18h, with the sun sweeping
 * east (+X) through south (-Z) to west (-X).
 *
 * Climate coupling: every evaluator accepts an optional evaluated climate
 * state. Without one (or in `static` evolution mode) the legacy authored
 * weather path runs unchanged; with an evolving climate the per-preset
 * lighting tables blend across the active transition so weather ramps never
 * pop the sun or ambient intensity.
 */

type WeatherPreset = DirectorWorldWeather["preset"];

/** Peak solar elevation at noon. Below the astronomical 90° so shadows keep direction. */
export const SKY_MAX_SUN_ELEVATION_RADIANS = (68 * Math.PI) / 180;

/** Key light intensity of an unobstructed noon sun, in the project's light scale. */
export const SKY_NOON_SUN_INTENSITY = 2.6;

/** Moonlight is a dim, deep-blue stand-in key: ~3% of the noon sun. */
export const SKY_MOONLIGHT_INTENSITY_RATIO = 0.03;

export interface SkySolarArc {
  /** Radians above the horizon; negative while the sun is below it. */
  elevationRadians: number;
  /** Radians clockwise from +Z (north) seen from above — same convention as world wind. */
  azimuthRadians: number;
  /** Normalized arc height: 1 at solar noon, 0 at sunrise/sunset, -1 at solar midnight. */
  altitudeSin: number;
}

export interface SkyLightingState {
  /**
   * Unit direction from the scene toward the active key light. During the day
   * this is the sun; at night it is the antisolar moon position, so the key
   * light always shines from above the horizon.
   */
  sunDirection: [number, number, number];
  /** Linear RGB in [0, 1]. */
  sunColor: [number, number, number];
  /** Key light intensity on the project's light scale. */
  sunIntensity: number;
  /** Hemisphere ambient colour, blended from night sky, clear sky fill, and overcast. */
  ambientColor: [number, number, number];
  /** Ambient intensity on the project's light scale. */
  ambientIntensity: number;
  /** Hemisphere ground term: bounced sunlight, same radiometric family as the sky. */
  groundColor: [number, number, number];
  /** Horizon inscatter used by aerial fog so distant geometry dissolves into the sky. */
  aerialFogColor: [number, number, number];
  /** Density coefficient for the aerial fog extinction. */
  aerialFogDensity: number;
  /** Sampled sky radiance at the zenith. */
  zenithColor: [number, number, number];
  /** Direct solar irradiance, same units as the sky LUT. */
  sunRadiance: [number, number, number];
  /** 0 at noon, approaching 1 on a clear midnight; clouds and weather hide stars. */
  starsOpacity: number;
  /** Legacy three-stdlib Sky shader turbidity — kept for cloud shading ramps. */
  skyTurbidity: number;
  /** Legacy three-stdlib Sky shader rayleigh — kept for cloud shading ramps. */
  skyRayleigh: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerpColor(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

function directionFromAngles(elevationRadians: number, azimuthRadians: number): [number, number, number] {
  const cosElevation = Math.cos(elevationRadians);
  return [Math.sin(azimuthRadians) * cosElevation, Math.sin(elevationRadians), Math.cos(azimuthRadians) * cosElevation];
}

/** Solar arc angles for the given solar hours (any finite value; wrapped into [0, 24)). */
export function getSkySolarArc(hours: number): SkySolarArc {
  const safeHours = Number.isFinite(hours) ? hours : 12;
  const wrapped = ((safeHours % 24) + 24) % 24;
  // 0 at sunrise (6h), 0.5 at noon (12h), 1 at sunset (18h); continuous across midnight.
  const phase = (wrapped - 6) / 12;
  const altitudeSin = Math.sin(phase * Math.PI);
  return {
    elevationRadians: altitudeSin * SKY_MAX_SUN_ELEVATION_RADIANS,
    azimuthRadians: Math.PI / 2 + phase * Math.PI,
    altitudeSin,
  };
}

/**
 * True solar direction for the sky dome, including below-horizon positions at
 * night (the dome needs the real sun to fade into a dark sky).
 *
 * @param hours - Solar hours in [0, 24).
 * @returns World-space unit direction toward the sun.
 */
export function getSolarDirectionForHours(hours: number): [number, number, number] {
  const arc = getSkySolarArc(hours);
  return directionFromAngles(arc.elevationRadians, arc.azimuthRadians);
}

/** How much direct key light survives the weather, multiplied onto the sun. */
const PRESET_DIRECT_LIGHT: Record<WeatherPreset, number> = {
  clear: 1,
  overcast: 0.55,
  rain: 0.4,
  snow: 0.55,
  storm: 0.4,
};

/** Ambient survival per preset; snow bounces light back, storms swallow it. */
const PRESET_AMBIENT_LIGHT: Record<WeatherPreset, number> = {
  clear: 1,
  overcast: 0.95,
  rain: 0.8,
  snow: 1,
  storm: 0.8,
};

const PRESET_STARS: Record<WeatherPreset, number> = {
  clear: 1,
  overcast: 0.25,
  rain: 0.15,
  snow: 0.25,
  storm: 0.05,
};

const PRESET_TURBIDITY: Record<WeatherPreset, number> = {
  clear: 0,
  overcast: 4,
  rain: 6,
  snow: 5,
  storm: 8,
};

/**
 * Per-preset scalar under an optional climate: static reads the table
 * directly (bit-exact legacy), an evolving climate blends the entries across
 * the active transition.
 */
function presetScalar(
  table: Record<WeatherPreset, number>,
  weather: DirectorWorldWeather,
  climate?: WorldClimateState,
): number {
  if (!climate?.evolving) return table[weather.preset];
  return blendWorldPresetScalar(table, climate);
}

/** Storm darkening on the key light; ramps with the evaluated storm factor. */
function getStormDarkening(weather: DirectorWorldWeather, climate?: WorldClimateState): number {
  if (climate?.evolving) return lerp(1, 0.45, clamp01(weather.intensity) * climate.stormFactor);
  return weather.preset === "storm" ? lerp(1, 0.45, clamp01(weather.intensity)) : 1;
}

/** Fraction of direct key light surviving cloud cover, weather preset, and storm darkening. */
function getDirectWeatherTransmission(weather: DirectorWorldWeather, climate?: WorldClimateState): number {
  return (
    (1 - 0.72 * clamp01(weather.cloudCover)) *
    presetScalar(PRESET_DIRECT_LIGHT, weather, climate) *
    getStormDarkening(weather, climate)
  );
}

const SUN_COLOR_NOON: readonly [number, number, number] = [1, 0.975, 0.93];
const SUN_COLOR_HORIZON: readonly [number, number, number] = [1, 0.6, 0.3];
const MOON_COLOR: readonly [number, number, number] = [0.55, 0.65, 1];
const AMBIENT_COLOR_NIGHT: readonly [number, number, number] = [0.2, 0.28, 0.5];
const AMBIENT_COLOR_OVERCAST: readonly [number, number, number] = [0.74, 0.77, 0.82];

const PRESET_AERIAL_FOG_DENSITY: Record<WeatherPreset, number> = {
  clear: 0.00055,
  overcast: 0.00095,
  rain: 0.00155,
  snow: 0.00085,
  storm: 0.00215,
};

/**
 * Steps per weather ramp for the LUT bake inputs. The Nishita bake is cached
 * on quantized keys, so evolving-climate inputs are snapped to this grid —
 * otherwise a 30–120 s ramp would re-bake the LUT every frame.
 */
const ATMOSPHERE_CLIMATE_STEPS = 24;

/** Coarse climate proxy whose atmosphere-relevant fields are quantized. */
function quantizeClimateForAtmosphere(climate: WorldClimateState): WorldClimateState {
  const q = (value: number) => Math.round(value * ATMOSPHERE_CLIMATE_STEPS) / ATMOSPHERE_CLIMATE_STEPS;
  return {
    ...climate,
    blend: q(climate.blend),
    stormFactor: q(climate.stormFactor),
    weather: {
      ...climate.weather,
      intensity: q(climate.weather.intensity),
      cloudCover: q(climate.weather.cloudCover),
    },
  };
}

function evaluateAtmosphereForSky(
  settings: DirectorWorldSettings,
  worldSeconds: number,
  climate?: WorldClimateState,
): AtmosphereSolution {
  const hours = evaluateWorldTimeOfDayHours(settings.timeOfDay, worldSeconds);
  const arc = getSkySolarArc(hours);
  const trueSunDir = directionFromAngles(arc.elevationRadians, arc.azimuthRadians);
  const daylight = smoothstep(-0.12, 0.25, arc.altitudeSin);
  const bakeClimate = climate?.evolving ? quantizeClimateForAtmosphere(climate) : climate;
  const weather = bakeClimate ? bakeClimate.weather : settings.weather;
  const transmission = getDirectWeatherTransmission(weather, bakeClimate);
  // Keep a little residual sun scale at night so the LUT still has twilight
  // structure instead of collapsing to a black cubemap.
  const sunScale = ATMOSPHERE_SUN_SCALE_BASE * transmission * lerp(0.08, 1, daylight);
  return solveAtmosphere({
    sunDir: trueSunDir,
    sunScale,
    groundAlbedo: getAtmosphereGroundAlbedo(weather, bakeClimate?.evolving ? bakeClimate : undefined),
    mieScale: getAtmosphereMieScale(weather, bakeClimate?.evolving ? bakeClimate : undefined),
  });
}

/**
 * Fraction of the world sun/ambient intensity used when the project already
 * carries authored lights.
 *
 * The world sky lights are additive: a project lit for its own look would be
 * blown out if a full-strength solar key landed on top of it (verified in
 * capture: an authored set washed to near-white with `drivesSky` on). So
 * the world becomes a fill pass in that case and only acts as the key light
 * when nothing else lights the scene.
 */
export const WORLD_SKY_FILL_SCALE = 0.35;

/**
 * Pure companion to the constant above: returns the fill scale when the
 * project already carries authored lights, or 1 when the world sky is the
 * sole key light.
 *
 * @param authoredLitLightCount - Number of authored lit lights in the scene.
 * @returns `WORLD_SKY_FILL_SCALE` when lights exist, otherwise 1.
 */
export function getWorldSkyLightScale(authoredLitLightCount: number): number {
  return authoredLitLightCount > 0 ? WORLD_SKY_FILL_SCALE : 1;
}

/**
 * Deterministic sky lighting for `(settings, worldSeconds)`.
 *
 * Intensities stay on the project's light scale (noon key = 2.6, moonlight
 * ratio, weather transmission) so authored scenes do not blow out. Sun and
 * sky-hemisphere *chromaticity* come from the Nishita bake so PBR materials
 * pick up the same blue fill / warm key the dome shows. Ground is a dimmed
 * sky, not a grass bounce.
 */
export function evaluateSkyLighting(
  settings: DirectorWorldSettings,
  worldSeconds: number,
  climate?: WorldClimateState,
): SkyLightingState {
  const hours = evaluateWorldTimeOfDayHours(settings.timeOfDay, worldSeconds);
  const arc = getSkySolarArc(hours);
  const weather = climate ? climate.weather : settings.weather;
  const cloudCover = clamp01(weather.cloudCover);
  const stormDarkening = getStormDarkening(weather, climate);
  const atmosphere = evaluateAtmosphereForSky(settings, worldSeconds, climate);

  // 0 at deep night, 1 in full daylight, easing through twilight.
  const daylight = smoothstep(-0.12, 0.25, arc.altitudeSin);
  const horizonWarmth = 1 - clamp01(arc.altitudeSin / 0.45);

  const sunUp = arc.altitudeSin >= 0;
  const keyDirection = sunUp
    ? directionFromAngles(arc.elevationRadians, arc.azimuthRadians)
    : directionFromAngles(-arc.elevationRadians, arc.azimuthRadians + Math.PI);

  const directWeather = getDirectWeatherTransmission(weather, climate);
  const sunIntensity = sunUp
    ? SKY_NOON_SUN_INTENSITY * smoothstep(0, 0.25, arc.altitudeSin) * directWeather
    : SKY_NOON_SUN_INTENSITY * SKY_MOONLIGHT_INTENSITY_RATIO * smoothstep(0, 0.25, -arc.altitudeSin) * directWeather;
  const sunColor = sunUp
    ? lerpColor(SUN_COLOR_NOON, atmosphere.sunColor, 0.7)
    : [...MOON_COLOR];

  const cloudLift = 1 + 0.3 * cloudCover * daylight;
  const ambientIntensity =
    lerp(0.14, 0.85, daylight) * cloudLift * presetScalar(PRESET_AMBIENT_LIGHT, weather, climate) * stormDarkening;
  const skyFill = chromaticityOf(atmosphere.skyIrradianceUp);
  const ambientColor = lerpColor(
    lerpColor(AMBIENT_COLOR_NIGHT, skyFill, daylight),
    AMBIENT_COLOR_OVERCAST,
    cloudCover * daylight,
  );
  const groundColor: [number, number, number] = [
    ambientColor[0] * 0.35,
    ambientColor[1] * 0.33,
    ambientColor[2] * 0.3,
  ];
  const aerialFogColor = chromaticityOf(lerpColor(atmosphere.aerialNearColor, atmosphere.horizonColor, 0.35));
  const stormFogBoost = climate?.evolving
    ? lerp(1, 1.35, clamp01(weather.intensity) * climate.stormFactor)
    : weather.preset === "storm"
      ? lerp(1, 1.35, clamp01(weather.intensity))
      : 1;
  const aerialFogDensity =
    presetScalar(PRESET_AERIAL_FOG_DENSITY, weather, climate) * (1 + 0.55 * cloudCover) * stormFogBoost;

  const nightFactor = 1 - smoothstep(-0.18, 0.03, arc.altitudeSin);
  const starsOpacity = clamp01(nightFactor * (1 - cloudCover) * presetScalar(PRESET_STARS, weather, climate));

  const skyTurbidity = clamp(2.2 + 9 * cloudCover + presetScalar(PRESET_TURBIDITY, weather, climate), 2, 20);
  const skyRayleigh = clamp(1 + 2.4 * horizonWarmth * daylight, 0.3, 4);

  return {
    sunDirection: keyDirection,
    sunColor: sunColor as [number, number, number],
    sunIntensity,
    ambientColor,
    ambientIntensity,
    groundColor,
    aerialFogColor,
    aerialFogDensity,
    zenithColor: atmosphere.zenithColor,
    sunRadiance: atmosphere.sunRadiance,
    starsOpacity,
    skyTurbidity,
    skyRayleigh,
  };
}

/** Shared LUT used by the sky dome so lighting and pixels stay on one bake. */
export function evaluateSkyAtmosphere(
  settings: DirectorWorldSettings,
  worldSeconds: number,
  climate?: WorldClimateState,
): AtmosphereSolution {
  return evaluateAtmosphereForSky(settings, worldSeconds, climate);
}

/** The disc hides once the sun drops below civil-twilight depth. */
export const SKY_SUN_DISC_MIN_ELEVATION_RADIANS = (-8 * Math.PI) / 180;
/** Elevation at which the twilight fade reaches full disc brightness. */
export const SKY_SUN_DISC_FULL_ELEVATION_RADIANS = (4 * Math.PI) / 180;
/** Apparent angular diameter of the bright core, slightly above the real 0.53°. */
export const SKY_SUN_DISC_ANGULAR_DIAMETER_RADIANS = (0.8 * Math.PI) / 180;
/** Apparent angular diameter of the soft horizon-glow halo around the disc. */
export const SKY_SUN_GLOW_ANGULAR_DIAMETER_RADIANS = (6 * Math.PI) / 180;

export interface SkySunDiscState {
  /** True while the true sun sits above the −8° twilight cutoff. */
  visible: boolean;
  /** Unit direction toward the true sun — never the night-time moon swap. */
  direction: [number, number, number];
  /** Disc/glow tint: near-white at noon, warming toward the horizon. */
  color: [number, number, number];
  /** 0..1 core strength: twilight fade × weather transmission. */
  discOpacity: number;
  /** 0..1 halo strength; biased stronger near the horizon than the core. */
  glowOpacity: number;
}

/**
 * Deterministic sun-disc appearance for `(settings, worldSeconds)`.
 *
 * The disc tracks the true solar direction (the same one the sky dome uses),
 * fades in across [−8°, +4°] elevation so dawn glow precedes sunrise, and is
 * dimmed by the same weather transmission that attenuates the key light, so a
 * stormy noon shows only a faint smudge where the sun sits.
 */
export function evaluateSunDiscState(
  settings: DirectorWorldSettings,
  worldSeconds: number,
  climate?: WorldClimateState,
): SkySunDiscState {
  const hours = evaluateWorldTimeOfDayHours(settings.timeOfDay, worldSeconds);
  const arc = getSkySolarArc(hours);
  const direction = directionFromAngles(arc.elevationRadians, arc.azimuthRadians);
  const visible = arc.elevationRadians > SKY_SUN_DISC_MIN_ELEVATION_RADIANS;
  if (!visible) {
    return { visible, direction, color: [...SUN_COLOR_HORIZON], discOpacity: 0, glowOpacity: 0 };
  }
  const twilight = smoothstep(
    SKY_SUN_DISC_MIN_ELEVATION_RADIANS,
    SKY_SUN_DISC_FULL_ELEVATION_RADIANS,
    arc.elevationRadians,
  );
  const transmission = getDirectWeatherTransmission(climate ? climate.weather : settings.weather, climate);
  const horizonWarmth = 1 - clamp01(arc.altitudeSin / 0.45);
  const atmosphere = evaluateAtmosphereForSky(settings, worldSeconds, climate);
  return {
    visible,
    direction,
    color: atmosphere.sunColor,
    discOpacity: twilight * transmission,
    glowOpacity: twilight * transmission * lerp(0.55, 1, horizonWarmth),
  };
}
