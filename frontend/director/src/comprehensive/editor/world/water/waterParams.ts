import type {
  DirectorWorldWaterBody,
  DirectorWorldWeather,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { WorldClimateState } from "../worldClimate";
import { worldRandom01, worldStreamId } from "../worldRandom";
import { createGerstnerWaveSet, type GerstnerSurfaceParams, type GerstnerWaveSetInput } from "./gerstner";

/**
 * Pure CPU-side parameter mapping for the water layer: mesh density, wind
 * coupling, solar lighting, and the foam crest response. Everything here is a
 * pure function of its inputs (no three.js, no store access), so the exact
 * values the GPU receives are unit-testable and reusable by future CPU
 * consumers (buoyancy, audio, agent queries).
 */

export const WATER_MIN_SEGMENTS_PER_AXIS = 16;
export const WATER_MAX_SEGMENTS_PER_AXIS = 128;

/** Baseline tessellation: two quads per metre keeps small ponds smooth. */
const SEGMENTS_PER_METRE = 2;
/** Resolve at least this many quads across the dominant wavelength. */
const SEGMENTS_PER_WAVELENGTH = 8;

const DEGREES_TO_RADIANS = Math.PI / 180;

/** Wind speed (m/s) at which the direction pull reaches its cap. */
const WIND_DIRECTION_FULL_SPEED_MPS = 25;
/** On flowing water the authored flow stays dominant: wind pulls at most this much. */
const WIND_DIRECTION_MAX_WEIGHT = 0.45;
/**
 * On still water (lakes, ponds) there is no current to fight, so strong wind
 * may take over the wave travel direction almost completely.
 */
const WIND_DIRECTION_MAX_WEIGHT_STILL = 0.85;
/** Flow speed (m/s) at which the authored flow fully re-asserts direction dominance. */
const WIND_DIRECTION_FLOW_DOMINANT_MPS = 1.5;
/** ×(1 + 0.04·|wind|) amplitude boost, capped so the schema budget stays meaningful. */
const WIND_AMPLITUDE_GAIN_PER_MPS = 0.04;
const WIND_AMPLITUDE_MAX_SCALE = 1.6;
const WIND_STEEPNESS_GAIN_PER_MPS = 0.03;
const WIND_STEEPNESS_MAX_SCALE = 1.45;

/**
 * Per-preset surface churn base [0, 1] (scaled by weather intensity):
 * how hard active precipitation works the surface beyond the steady wind.
 */
const WEATHER_CHURN_BY_PRESET: Record<DirectorWorldWeather["preset"], number> = {
  clear: 0,
  overcast: 0.08,
  rain: 0.45,
  snow: 0.12,
  storm: 1,
};

/** Weather amplitude boost at full churn (storm intensity 1): ×1.25. */
const WEATHER_AMPLITUDE_MAX_GAIN = 0.25;
/** Weather choppiness boost at full churn: ×1.3. */
const WEATHER_STEEPNESS_MAX_GAIN = 0.3;
/** Weather foam boost at full churn: ×1.8 on the authored foam intensity. */
const WEATHER_FOAM_MAX_GAIN = 0.8;

/**
 * Foam crest window on the normalized vertical displacement (offsetY / ΣA).
 * These exact constants are interpolated into the fragment shader
 * (waterMaterial.ts), so TS mask and GPU mask cannot drift.
 */
export const WATER_FOAM_CREST_START = 0.45;
export const WATER_FOAM_CREST_END = 0.92;
/**
 * How far the crest window's lower edge widens per unit of foam boost above 1
 * (weather churn breaks lower crests too). Interpolated into the fragment
 * shader so the TS mask and the GPU mask stay mirrored.
 */
export const WATER_FOAM_BOOST_WIDEN = 0.18;

/** Metres of daylight kept between a wave trough and the opaque ground plane. */
export const WATER_GROUND_CLEARANCE_M = 0.02;

/**
 * Vertical lift (metres) applied to the wave displacement so troughs never
 * sink under the opaque occluder below the body (scene ground plane, or a
 * sampled terrain/prop top).
 *
 * Water renders with `depthWrite: false` but still depth-tests, so any part of
 * the surface below an opaque mesh is rejected and the body reads as torn
 * patches instead of a pond (observed in capture on a 5 cm-high pond with
 * 8 cm waves, and again when a QA pond sat on a 8 cm walkway). The lift is
 * exactly the shortfall: a lake authored well above the occluder stays at its
 * mean water level, while a pond whose troughs (or even its mean) sit inside
 * solid geometry is raised until the lowest trough clears it.
 */
export function computeWaterTroughLift(
  surfaceCenterY: number,
  effectiveAmplitude: number,
  groundHeight: number,
): number {
  const amplitude = Math.max(0, effectiveAmplitude);
  const shortfall = groundHeight + WATER_GROUND_CLEARANCE_M - (surfaceCenterY - amplitude);
  return Math.max(0, shortfall);
}

/**
 * Highest occluder under a rectangular water body: the scene ground plane,
 * plus optional terrain samples at the centre and four corners.
 */
export function resolveWaterOccluderHeight(
  body: DirectorWorldWaterBody,
  fallbackHeight: number,
  sampleGroundHeight?: (x: number, z: number) => number | null,
): number {
  let height = fallbackHeight;
  if (!sampleGroundHeight) return height;
  const [cx, , cz] = body.surface.center;
  const hx = body.surface.sizeX * 0.5;
  const hz = body.surface.sizeZ * 0.5;
  const yaw = (body.surface.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const local: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [hx, hz],
    [hx, -hz],
    [-hx, hz],
    [-hx, -hz],
  ];
  for (const [lx, lz] of local) {
    const x = cx + lx * cos - lz * sin;
    const z = cz + lx * sin + lz * cos;
    const hit = sampleGroundHeight(x, z);
    if (hit != null && hit > height) height = hit;
  }
  return height;
}

/** Stream tag decorrelating the fragment detail-noise phase per body. */
const STREAM_DETAIL_PHASE = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Adaptive tessellation for one plane axis: enough quads for both the body
 * size and the dominant wavelength, clamped to the protocol budget
 * (total ≤ 128×128, ≥ 16×16).
 */
export function computeWaterSegmentsForAxis(sizeM: number, waveLengthM: number): number {
  const safeSize = Math.max(sizeM, 0.1);
  const safeWaveLength = Math.max(waveLengthM, 0.2);
  const bySize = safeSize * SEGMENTS_PER_METRE;
  const byWavelength = (safeSize / safeWaveLength) * SEGMENTS_PER_WAVELENGTH;
  return clamp(Math.ceil(Math.max(bySize, byWavelength)), WATER_MIN_SEGMENTS_PER_AXIS, WATER_MAX_SEGMENTS_PER_AXIS);
}

/** Wind-coupled amplitude multiplier: ×(1 + 0.04·|wind|), clamped to [1, 1.6]. */
export function computeWindAmplitudeScale(windSpeedMps: number): number {
  return clamp(1 + WIND_AMPLITUDE_GAIN_PER_MPS * Math.max(windSpeedMps, 0), 1, WIND_AMPLITUDE_MAX_SCALE);
}

/** Wind-coupled choppiness multiplier, clamped to [1, 1.45]. */
export function computeWindSteepnessScale(windSpeedMps: number): number {
  return clamp(1 + WIND_STEEPNESS_GAIN_PER_MPS * Math.max(windSpeedMps, 0), 1, WIND_STEEPNESS_MAX_SCALE);
}

/**
 * Surface churn [0, 1] contributed by the weather preset × intensity: 0 in
 * clear weather (old bodies keep their authored look), 1 in a full storm.
 * Single source for the weather side of amplitude/steepness/foam/murk.
 */
export function computeWeatherChurn(weather: DirectorWorldWeather): number {
  return clamp(WEATHER_CHURN_BY_PRESET[weather.preset] * clamp(weather.intensity, 0, 1), 0, 1);
}

/** Weather-coupled amplitude multiplier: 1 in clear weather → 1.25 in a full storm. */
export function computeWeatherAmplitudeScale(weather: DirectorWorldWeather): number {
  return 1 + WEATHER_AMPLITUDE_MAX_GAIN * computeWeatherChurn(weather);
}

/** Weather-coupled choppiness multiplier: 1 in clear weather → 1.3 in a full storm. */
export function computeWeatherSteepnessScale(weather: DirectorWorldWeather): number {
  return 1 + WEATHER_STEEPNESS_MAX_GAIN * computeWeatherChurn(weather);
}

/**
 * Foam gain ≥ 1 applied on top of the authored foam intensity: rain and storm
 * whip up whitecaps and shoreline froth. 1 in clear weather → 1.8 full storm.
 */
export function computeWeatherFoamBoost(weather: DirectorWorldWeather): number {
  return 1 + WEATHER_FOAM_MAX_GAIN * computeWeatherChurn(weather);
}

/**
 * Suspended-sediment murkiness [0, 1]: churned storm/rain water reads
 * grey-brown and less transparent. Wetness (post-rain runoff) keeps a little
 * silt in suspension even after the preset clears.
 */
export function computeWaterMurkiness(weather: DirectorWorldWeather): number {
  return clamp(0.75 * computeWeatherChurn(weather) + 0.2 * clamp(weather.wetness, 0, 1), 0, 1);
}

/**
 * Combined wind × weather amplitude multiplier — the value the GPU receives
 * as `uGerstnerAmplitudeScale`. ΣQ safety is preserved for any scale because
 * the per-wave anti-loop limit is rescaled by this factor (see
 * `effectiveSteepness` in gerstner.ts).
 */
export function computeWaterAmplitudeScale(windSpeedMps: number, weather: DirectorWorldWeather): number {
  return computeWindAmplitudeScale(windSpeedMps) * computeWeatherAmplitudeScale(weather);
}

/** Combined wind × weather choppiness multiplier (`uGerstnerSteepnessScale`). */
export function computeWaterSteepnessScale(windSpeedMps: number, weather: DirectorWorldWeather): number {
  return computeWindSteepnessScale(windSpeedMps) * computeWeatherSteepnessScale(weather);
}

/**
 * How strongly wind pulls the wave travel direction. On flowing water the
 * authored flow dominates (cap 0.45); on still water (flow ≈ 0 — lakes,
 * ponds) there is no current to fight and strong wind may take over almost
 * completely (cap 0.85). The default flow speed keeps the legacy flowing-water
 * behaviour for callers that do not pass one.
 */
export function computeWindDirectionWeight(
  windSpeedMps: number,
  flowSpeedMps: number = WIND_DIRECTION_FLOW_DOMINANT_MPS,
): number {
  const flowDominance = clamp(Math.max(flowSpeedMps, 0) / WIND_DIRECTION_FLOW_DOMINANT_MPS, 0, 1);
  const maxWeight = lerp(WIND_DIRECTION_MAX_WEIGHT_STILL, WIND_DIRECTION_MAX_WEIGHT, flowDominance);
  return clamp(Math.max(windSpeedMps, 0) / WIND_DIRECTION_FULL_SPEED_MPS, 0, maxWeight);
}

/**
 * Blended wave travel direction (compass radians: 0 = +Z, clockwise — same
 * convention as the wind protocol). Blends unit vectors rather than angles so
 * the 0°/360° wrap needs no special casing; when flow and wind exactly cancel
 * the authored flow direction wins. Passing the body's flow speed lets wind
 * dominate on still lakes while flowing bodies keep the authored direction.
 */
export function blendFlowDirectionWithWind(
  flowDirectionDegrees: number,
  windX: number,
  windZ: number,
  flowSpeedMps: number = WIND_DIRECTION_FLOW_DOMINANT_MPS,
): number {
  const flowRadians = flowDirectionDegrees * DEGREES_TO_RADIANS;
  const windSpeed = Math.hypot(windX, windZ);
  const weight = computeWindDirectionWeight(windSpeed, flowSpeedMps);
  if (weight <= 0 || windSpeed < 1e-6) return flowRadians;
  const blendedX = Math.sin(flowRadians) * (1 - weight) + (windX / windSpeed) * weight;
  const blendedZ = Math.cos(flowRadians) * (1 - weight) + (windZ / windSpeed) * weight;
  if (blendedX * blendedX + blendedZ * blendedZ < 1e-8) return flowRadians;
  return Math.atan2(blendedX, blendedZ);
}

/** Max solar elevation of the simple previz arc (noon), radians. */
const SUN_MAX_ELEVATION_RADIANS = (70 * Math.PI) / 180;

function sunArcParameter(hours: number): number {
  // 6h → sunrise (0), 12h → noon (π/2), 18h → sunset (π); night is negative.
  return (Math.PI * (hours - 6)) / 12;
}

function sunElevationRadians(hours: number): number {
  return Math.sin(sunArcParameter(hours)) * SUN_MAX_ELEVATION_RADIANS;
}

export interface WaterVec3Like {
  /** World-space X component. */
  x: number;
  /** World-space Y component. */
  y: number;
  /** World-space Z component. */
  z: number;
}

/**
 * Unit direction from the surface toward the sun on a simple solar arc:
 * rises east (+X), culminates south (−Z, northern-hemisphere convention with
 * +Z = north), sets west. Writes into `target` so render-loop callers can
 * point it at a uniform's Vector3 with zero allocations.
 */
export function computeWaterSunDirectionInto<T extends WaterVec3Like>(target: T, hours: number): T {
  const arc = sunArcParameter(hours);
  const elevation = sunElevationRadians(hours);
  const cosElevation = Math.cos(elevation);
  target.x = Math.cos(arc) * cosElevation;
  target.y = Math.sin(elevation);
  target.z = -Math.sin(arc) * cosElevation;
  return target;
}

/**
 * Specular strength for the sun uniform: full while the sun is up, fading
 * through twilight, with a faint moon-glint floor at night. Cloud cover from
 * the weather settings dims the highlight (overcast water reads matte).
 */
export function computeWaterSunIntensity(hours: number, cloudCover: number): number {
  const sinElevation = Math.sin(sunElevationRadians(hours));
  const daylight = smoothstep(-0.06, 0.18, sinElevation);
  const cloud = clamp(cloudCover, 0, 1);
  const clearSky = 1 - 0.75 * cloud;
  const moonGlint = 0.045 * (1 - 0.6 * cloud);
  return Math.max(daylight * clearSky, moonGlint);
}

/** Mutable RGB target (matches three.Color) so uniform writes allocate nothing. */
export interface WaterColorLike {
  /** Linear red channel. */
  r: number;
  /** Linear green channel. */
  g: number;
  /** Linear blue channel. */
  b: number;
}

/** 0 at deep night → 1 in full daylight; same curve as the sun intensity ramp. */
function waterDaylight(hours: number): number {
  return smoothstep(-0.06, 0.18, Math.sin(sunElevationRadians(hours)));
}

/** 1 when the (risen) sun sits near the horizon — drives warm dusk/dawn tints. */
function waterHorizonWarmth(hours: number): number {
  const sinElevation = Math.sin(sunElevationRadians(hours));
  return (1 - clamp(sinElevation / 0.45, 0, 1)) * waterDaylight(hours);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Procedural sky-reflection tints (linear RGB). There is no environment map
 * guarantee, so the fragment shader reconstructs a two-band sky — horizon tint
 * blended toward a zenith tint by the reflected ray's elevation — from these
 * two uniforms. They follow the same previz solar arc as the sun uniform:
 * pale blue-grey horizon at midday, warm horizon around dawn/dusk, near-black
 * blue at night. Cloud cover pulls both bands toward the flat bright overcast
 * ambient used by the sky layer, and rain/storm presets damp them slightly.
 */
const SKY_HORIZON_DAY: readonly [number, number, number] = [0.66, 0.74, 0.85];
const SKY_HORIZON_DUSK: readonly [number, number, number] = [1.0, 0.62, 0.36];
const SKY_HORIZON_NIGHT: readonly [number, number, number] = [0.05, 0.07, 0.12];
const SKY_ZENITH_DAY: readonly [number, number, number] = [0.2, 0.36, 0.6];
const SKY_ZENITH_DUSK: readonly [number, number, number] = [0.28, 0.3, 0.46];
const SKY_ZENITH_NIGHT: readonly [number, number, number] = [0.02, 0.03, 0.07];
const SKY_HORIZON_OVERCAST: readonly [number, number, number] = [0.78, 0.81, 0.86];
const SKY_ZENITH_OVERCAST: readonly [number, number, number] = [0.52, 0.56, 0.62];

/** Lerp whose endpoints are bit-exact; keeps climate holds on the preset numbers. */
function exactLerp(from: number, to: number, t: number): number {
  if (t <= 0) return from;
  if (t >= 1) return to;
  return from + (to - from) * t;
}

/**
 * How much of the sky reflection survives the weather, by intensity. An
 * evolving climate ramps the dimming with the evaluated rain presence and
 * storm factor instead of stepping on the preset gate.
 */
function weatherSkyDimming(weather: DirectorWorldWeather, climate?: WorldClimateState): number {
  const intensity = clamp(weather.intensity, 0, 1);
  if (climate?.evolving) {
    const dimmed = exactLerp(0.85, 0.72, clamp(climate.stormFactor, 0, 1));
    return exactLerp(1, dimmed, clamp(climate.rainPresence, 0, 1) * intensity);
  }
  if (weather.preset === "storm") return lerp(1, 0.72, intensity);
  if (weather.preset === "rain") return lerp(1, 0.85, intensity);
  return 1;
}

/**
 * One channel of a sky band: night → (day warmed toward dusk) by daylight,
 * pulled toward the overcast grey by cloud cover, then weather-dimmed.
 * Split per channel so per-frame uniform writes stay allocation-free.
 */
function skyBandChannel(
  night: number,
  day: number,
  dusk: number,
  overcast: number,
  daylight: number,
  warmth: number,
  cloud: number,
  overcastLevel: number,
  dimming: number,
): number {
  const clear = lerp(night, lerp(day, dusk, warmth), daylight);
  return lerp(clear, overcast * overcastLevel, cloud) * dimming;
}

export function computeWaterSkyReflectionInto(
  horizonTarget: WaterColorLike,
  zenithTarget: WaterColorLike,
  hours: number,
  weather: DirectorWorldWeather,
  climate?: WorldClimateState,
): void {
  const daylight = waterDaylight(hours);
  const warmth = waterHorizonWarmth(hours);
  const cloud = clamp(weather.cloudCover, 0, 1);
  const dimming = weatherSkyDimming(weather, climate);
  // Overcast skies stay bright by day but must not glow at night.
  const overcastLevel = lerp(0.08, 1, daylight);

  horizonTarget.r = skyBandChannel(
    SKY_HORIZON_NIGHT[0],
    SKY_HORIZON_DAY[0],
    SKY_HORIZON_DUSK[0],
    SKY_HORIZON_OVERCAST[0],
    daylight,
    warmth,
    cloud,
    overcastLevel,
    dimming,
  );
  horizonTarget.g = skyBandChannel(
    SKY_HORIZON_NIGHT[1],
    SKY_HORIZON_DAY[1],
    SKY_HORIZON_DUSK[1],
    SKY_HORIZON_OVERCAST[1],
    daylight,
    warmth,
    cloud,
    overcastLevel,
    dimming,
  );
  horizonTarget.b = skyBandChannel(
    SKY_HORIZON_NIGHT[2],
    SKY_HORIZON_DAY[2],
    SKY_HORIZON_DUSK[2],
    SKY_HORIZON_OVERCAST[2],
    daylight,
    warmth,
    cloud,
    overcastLevel,
    dimming,
  );
  zenithTarget.r = skyBandChannel(
    SKY_ZENITH_NIGHT[0],
    SKY_ZENITH_DAY[0],
    SKY_ZENITH_DUSK[0],
    SKY_ZENITH_OVERCAST[0],
    daylight,
    warmth,
    cloud,
    overcastLevel,
    dimming,
  );
  zenithTarget.g = skyBandChannel(
    SKY_ZENITH_NIGHT[1],
    SKY_ZENITH_DAY[1],
    SKY_ZENITH_DUSK[1],
    SKY_ZENITH_OVERCAST[1],
    daylight,
    warmth,
    cloud,
    overcastLevel,
    dimming,
  );
  zenithTarget.b = skyBandChannel(
    SKY_ZENITH_NIGHT[2],
    SKY_ZENITH_DAY[2],
    SKY_ZENITH_DUSK[2],
    SKY_ZENITH_OVERCAST[2],
    daylight,
    warmth,
    cloud,
    overcastLevel,
    dimming,
  );
}

const SUN_COLOR_NOON: readonly [number, number, number] = [1, 0.96, 0.88];
const SUN_COLOR_HORIZON: readonly [number, number, number] = [1, 0.55, 0.28];
const MOON_COLOR: readonly [number, number, number] = [0.55, 0.65, 1];

/** Specular tint of the key light: white-warm sun by day, blue moon at night. */
export function computeWaterSunColorInto(target: WaterColorLike, hours: number): void {
  const daylight = waterDaylight(hours);
  const warmth = waterHorizonWarmth(hours);
  target.r = lerp(MOON_COLOR[0], lerp(SUN_COLOR_NOON[0], SUN_COLOR_HORIZON[0], warmth), daylight);
  target.g = lerp(MOON_COLOR[1], lerp(SUN_COLOR_NOON[1], SUN_COLOR_HORIZON[1], warmth), daylight);
  target.b = lerp(MOON_COLOR[2], lerp(SUN_COLOR_NOON[2], SUN_COLOR_HORIZON[2], warmth), daylight);
}

/**
 * Scalar light level on the transmitted body color (the shallow/deep albedo
 * mix): full in daylight, dim at night, slightly damped by cloud cover and
 * rain/storm presets so stormy water reads darker without touching the sky
 * reflection contrast.
 */
export function computeWaterBodyLightLevel(
  hours: number,
  weather: DirectorWorldWeather,
  climate?: WorldClimateState,
): number {
  const daylight = waterDaylight(hours);
  const cloud = clamp(weather.cloudCover, 0, 1);
  const intensity = clamp(weather.intensity, 0, 1);
  let presetFactor = 1;
  if (climate?.evolving) {
    const dimmed = exactLerp(0.9, 0.8, clamp(climate.stormFactor, 0, 1));
    presetFactor = exactLerp(1, dimmed, clamp(climate.rainPresence, 0, 1) * intensity);
  } else if (weather.preset === "storm") presetFactor = lerp(1, 0.8, intensity);
  else if (weather.preset === "rain") presetFactor = lerp(1, 0.9, intensity);
  return clamp(lerp(0.12, 1, daylight) * (1 - 0.25 * cloud) * presetFactor, 0.05, 1.2);
}

/** Wind speed (m/s) at which the micro-ripple band saturates. */
const MICRO_RIPPLE_FULL_WIND_MPS = 9;

/**
 * Strength [0, 1] of the third, wind-driven micro-ripple normal band: calm
 * water keeps a glassy surface, ~9 m/s wind fully roughens it.
 */
export function computeWaterMicroRippleStrength(windSpeedMps: number): number {
  return smoothstep(0.4, MICRO_RIPPLE_FULL_WIND_MPS, Math.max(windSpeedMps, 0));
}

/** Per-preset base of the rain-agitation sparkle (scaled by weather intensity). */
const RAIN_AGITATION_BY_PRESET: Record<DirectorWorldWeather["preset"], number> = {
  clear: 0,
  overcast: 0,
  rain: 0.9,
  snow: 0.12,
  storm: 1,
};

/**
 * Strength [0, 1] of the animated rain-pocking micro-normal noise: raindrops
 * churn the surface into a sparkling, broken-up sheen. Deterministic — the
 * shader animates it purely from uTime. An evolving climate ramps the
 * agitation with the evaluated rain/snow presence so sparkle fades in with
 * the rain instead of snapping at the preset switch.
 */
export function computeWaterRainAgitation(weather: DirectorWorldWeather, climate?: WorldClimateState): number {
  const intensity = clamp(weather.intensity, 0, 1);
  if (climate?.evolving) {
    const rainBase = exactLerp(RAIN_AGITATION_BY_PRESET.rain, RAIN_AGITATION_BY_PRESET.storm, clamp(climate.stormFactor, 0, 1));
    const agitation =
      rainBase * clamp(climate.rainPresence, 0, 1) * intensity +
      RAIN_AGITATION_BY_PRESET.snow * clamp(climate.snowPresence, 0, 1) * intensity;
    return clamp(agitation, 0, 1);
  }
  return clamp(RAIN_AGITATION_BY_PRESET[weather.preset] * intensity, 0, 1);
}

/**
 * Survival factor [0.3, 1] of the environment-probe reflection blend
 * (`uEnvBlend`): an agitated surface (wind micro ripples, storm churn) breaks
 * the mirror up, so the probe capture recedes toward the procedural sky which
 * is already weather-dimmed. Calm clear water keeps the full mirror.
 */
export function computeWaterEnvBlendScale(windSpeedMps: number, weather: DirectorWorldWeather): number {
  const churn = computeWeatherChurn(weather);
  const micro = computeWaterMicroRippleStrength(windSpeedMps);
  return clamp(1 - 0.45 * churn - 0.25 * micro, 0.3, 1);
}

/**
 * Foam crest response, mirrored by the fragment shader through the
 * interpolated WATER_FOAM_CREST_* / WATER_FOAM_BOOST_WIDEN constants:
 * smoothstep over the normalized crest height, scaled by the authored foam
 * intensity × weather foam boost. A boost above 1 also lowers the crest
 * threshold (storm water whitecaps earlier). Always in [0, 1].
 */
export function evaluateFoamCrestMask(normalizedCrest: number, foamIntensity: number, foamBoost = 1): number {
  const crest = clamp(normalizedCrest, 0, 1);
  const gain = clamp(clamp(foamIntensity, 0, 1) * Math.max(foamBoost, 0), 0, 1);
  const widen = clamp((Math.max(foamBoost, 1) - 1) * WATER_FOAM_BOOST_WIDEN, 0, 0.25);
  return clamp(smoothstep(WATER_FOAM_CREST_START - widen, WATER_FOAM_CREST_END, crest) * gain, 0, 1);
}

/** Deterministic per-body phase (radians) for the fragment detail noise. */
export function computeWaterDetailPhase(worldSeed: number, bodyId: string): number {
  return worldRandom01(worldSeed, worldStreamId(bodyId), STREAM_DETAIL_PHASE) * Math.PI * 2;
}

/**
 * The wave-set inputs derived from a body; used as a memo key for spectrum
 * rebuilds so identical bodies share the same wave set.
 *
 * @param worldSeed - The project's world seed for deterministic hashing.
 * @param body - The water body whose sliders are extracted.
 * @returns A plain input object consumed by `createGerstnerWaveSet`.
 */
export function getGerstnerWaveSetInput(worldSeed: number, body: DirectorWorldWaterBody): GerstnerWaveSetInput {
  return {
    worldSeed,
    bodyId: body.id,
    waveAmplitude: body.waveAmplitude,
    waveLengthM: body.waveLengthM,
    flowSpeedMps: body.flowSpeedMps,
  };
}

/**
 * One-call CPU surface description for a body under the current wind and
 * (optionally) weather — the exact parameters the GPU renders with. This is
 * the hook future systems (floating props, ripple-aware wildlife) should use
 * together with `evaluateGerstnerSurface` to stay pixel-consistent with the
 * shader. Pass the frame's weather to match the rendered storm response;
 * omitting it keeps the legacy wind-only coupling.
 * Allocates; render-loop code assembles the same pieces incrementally instead.
 */
export function createWaterSurfaceParams(
  worldSeed: number,
  body: DirectorWorldWaterBody,
  windVector: readonly [number, number, number],
  weather?: DirectorWorldWeather,
): GerstnerSurfaceParams {
  const windSpeed = Math.hypot(windVector[0], windVector[2]);
  return {
    waves: createGerstnerWaveSet(getGerstnerWaveSetInput(worldSeed, body)),
    baseDirectionRadians: blendFlowDirectionWithWind(
      body.flowDirectionDegrees,
      windVector[0],
      windVector[2],
      body.flowSpeedMps,
    ),
    amplitudeScale: weather ? computeWaterAmplitudeScale(windSpeed, weather) : computeWindAmplitudeScale(windSpeed),
    steepnessScale: weather ? computeWaterSteepnessScale(windSpeed, weather) : computeWindSteepnessScale(windSpeed),
  };
}
