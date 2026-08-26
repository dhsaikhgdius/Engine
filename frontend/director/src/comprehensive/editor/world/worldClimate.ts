import {
  DIRECTOR_WORLD_SIMULATION_HZ,
  DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
  type DirectorWorldSettings,
  type DirectorWorldWeather,
  type WorldWeatherPreset,
} from "../../../../../../packages/protocol/src/worldSystemsProtocol";
import { evaluateWorldTimeOfDayHours } from "./worldTime";
import { worldRandom01, worldStreamId } from "./worldRandom";

/**
 * Deterministic climate evaluation — the single weather truth for every
 * Living World consumer (sky, precipitation, surface wetness, water, audio,
 * wildlife, fire).
 *
 * Design (Far Cry 6-style state machine, see docs/research/living-world-survey.md §3.5):
 * the five authored presets are NODES; `cycle` mode walks a seeded segment
 * schedule between them and every transition is a timed PARAMETER-VECTOR ramp
 * (cloud cover, rain/snow level, wind gain, storm factor, lightning) — never
 * a visual crossfade. Consumers read the evaluated vector at `worldSeconds`.
 *
 * Determinism: the segment schedule is a pure function of (seed, segment
 * index), so `evaluate(t)` is O(1) random access. Wetness is the one
 * integrator; it advances at the fixed world simulation Hz from t = 0 with
 * cached intermediate checkpoints, so out-of-order queries replay the exact
 * same float operations and return bit-identical values.
 *
 * `static` mode (and worlds without an evolution block) must reproduce
 * today's authored numbers verbatim — locked by worldClimate.test.ts.
 */

const HZ = DIRECTOR_WORLD_SIMULATION_HZ;
const WETNESS_DT = 1 / HZ;

/** Per-node climate parameter vector at weather intensity 1. */
export interface WorldClimateNodeVector {
  /** Cloud cover the node ramps toward. */
  cloudCover: number;
  /** Rain-equivalent precipitation level (feeds the rain particle budget). */
  rainLevel: number;
  /** Snow precipitation level (feeds the snow particle budget). */
  snowLevel: number;
  /** Multiplier on the authored wind speed. */
  windGain: number;
  /** 0 = calm precipitation, 1 = full storm shear/speed/lightning. */
  stormFactor: number;
  /** Wetness the integrator drifts toward under this node. */
  wetnessTarget: number;
  /** Wetness change rate toward the target, 1/s at intensity 1. */
  wetnessRatePerSecond: number;
}

/**
 * Node vectors per preset. Wetting rates: rain saturates a dry set in ~50 s,
 * storms in ~30 s; drying under clear takes ~3.5 min; snow contributes a low
 * melt-wet plateau. These are previz-scaled, not meteorology.
 */
export const WORLD_CLIMATE_NODE_VECTORS: Record<WorldWeatherPreset, WorldClimateNodeVector> = {
  clear: {
    cloudCover: 0.12,
    rainLevel: 0,
    snowLevel: 0,
    windGain: 1,
    stormFactor: 0,
    wetnessTarget: 0,
    wetnessRatePerSecond: 0.0048,
  },
  overcast: {
    cloudCover: 0.72,
    rainLevel: 0,
    snowLevel: 0,
    windGain: 1.1,
    stormFactor: 0,
    wetnessTarget: 0,
    wetnessRatePerSecond: 0.0022,
  },
  rain: {
    cloudCover: 0.85,
    rainLevel: 1,
    snowLevel: 0,
    windGain: 1.25,
    stormFactor: 0,
    wetnessTarget: 1,
    wetnessRatePerSecond: 0.02,
  },
  snow: {
    cloudCover: 0.7,
    rainLevel: 0,
    snowLevel: 1,
    windGain: 1.05,
    stormFactor: 0,
    wetnessTarget: 0.35,
    wetnessRatePerSecond: 0.006,
  },
  storm: {
    cloudCover: 0.96,
    rainLevel: 1,
    snowLevel: 0,
    windGain: 1.7,
    stormFactor: 1,
    wetnessTarget: 1,
    wetnessRatePerSecond: 0.033,
  },
};

/** Transition ramps span 30–120 s (survey §3.5), hashed per segment. */
export const WORLD_CLIMATE_MIN_RAMP_SECONDS = 30;
export const WORLD_CLIMATE_MAX_RAMP_SECONDS = 120;

const SCHEDULE_STREAM = worldStreamId("world-climate-schedule");
const PRESET_STREAM = 0;
const RAMP_STREAM = 1;

/**
 * Weighted i.i.d. node picks per segment. Repeats are allowed (they read as a
 * longer hold), storms stay rare, and precipitation is common enough that a
 * cycle visibly wets and dries the set within a few segments.
 */
const SCHEDULE_WEIGHTS: ReadonlyArray<readonly [WorldWeatherPreset, number]> = [
  ["clear", 0.3],
  ["overcast", 0.26],
  ["rain", 0.22],
  ["snow", 0.12],
  ["storm", 0.1],
];

function pickSchedulePreset(roll: number): WorldWeatherPreset {
  let cursor = roll;
  for (const [preset, weight] of SCHEDULE_WEIGHTS) {
    if (cursor < weight) return preset;
    cursor -= weight;
  }
  return SCHEDULE_WEIGHTS[SCHEDULE_WEIGHTS.length - 1][0];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function smoothstep01(t: number): number {
  const clamped = clamp01(t);
  return clamped * clamped * (3 - 2 * clamped);
}

/** Fields shared by the schedule (O(1) random access; no integrator). */
export interface WorldClimateSchedule {
  /** Node being left; equals `toPreset` while holding. */
  fromPreset: WorldWeatherPreset;
  /** Node being entered / held. */
  toPreset: WorldWeatherPreset;
  /** Smoothed ramp position in [0, 1]; 1 while holding. */
  blend: number;
  /** Dominant node for discrete consumers (blend >= 0.5 picks the target). */
  preset: WorldWeatherPreset;
}

/** The full evaluated climate at one `worldSeconds`. */
export interface WorldClimateState extends WorldClimateSchedule {
  /** True when the seeded evolution drives the vector (mode `cycle`). */
  evolving: boolean;
  /** Effective weather intensity: authored (static) or precipitation strength (cycle). */
  intensity: number;
  /** Evaluated cloud cover in [0, 1]. */
  cloudCover: number;
  /** Integrated (evolving) or authored (static) surface wetness in [0, 1]. */
  wetness: number;
  /** How "rainy" the active nodes are in [0, 1], before intensity scaling. */
  rainPresence: number;
  /** How "snowy" the active nodes are in [0, 1], before intensity scaling. */
  snowPresence: number;
  /** Rain particle level in [0, 1] (presence × authored intensity). */
  rainLevel: number;
  /** Snow particle level in [0, 1] (presence × authored intensity). */
  snowLevel: number;
  /** Multiplier applied to the authored wind vector. Static mode = 1. */
  windGain: number;
  /** 0 calm → 1 full storm; drives shear, lightning, and wildlife caution. */
  stormFactor: number;
  /** Solar hours in [0, 24) at this worldSeconds. */
  hours: number;
  /**
   * Effective legacy weather block: the evaluated vector re-expressed in the
   * protocol shape so existing `DirectorWorldWeather` consumers read the
   * evolved values. In static mode this is the authored block by reference,
   * guaranteeing bit-equality with today's pipeline.
   */
  weather: DirectorWorldWeather;
}

/** True when the settings request seeded weather evolution. */
export function isWorldWeatherEvolving(settings: Pick<DirectorWorldSettings, "weather">): boolean {
  return settings.weather.evolution?.mode === "cycle";
}

/** Duration of one seeded weather node, clamped to the simulation minimum. */
export function getWorldClimateSegmentSeconds(settings: DirectorWorldSettings): number {
  const period = settings.weather.evolution?.periodSeconds ?? DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS;
  return Math.max(60, period);
}

/** Node preset of segment k; segment 0 is pinned to the authored preset. */
export function getWorldClimateSegmentPreset(settings: DirectorWorldSettings, segment: number): WorldWeatherPreset {
  if (segment <= 0) return settings.weather.preset;
  return pickSchedulePreset(worldRandom01(settings.seed, SCHEDULE_STREAM, segment, PRESET_STREAM));
}

/** Duration of the smooth transition entering one seeded weather node. */
export function getWorldClimateSegmentRampSeconds(settings: DirectorWorldSettings, segment: number): number {
  const segmentSeconds = getWorldClimateSegmentSeconds(settings);
  const roll = worldRandom01(settings.seed, SCHEDULE_STREAM, segment, RAMP_STREAM);
  const ramp =
    WORLD_CLIMATE_MIN_RAMP_SECONDS + (WORLD_CLIMATE_MAX_RAMP_SECONDS - WORLD_CLIMATE_MIN_RAMP_SECONDS) * roll;
  // A ramp never exceeds 60% of its segment, so every node visibly holds.
  return Math.min(ramp, segmentSeconds * 0.6);
}

/**
 * Seeded schedule lookup at `worldSeconds` — O(1), no integrator, safe to
 * call from fixed-timestep simulations (wildlife, fire) every tick.
 */
export function evaluateWorldClimateSchedule(
  settings: DirectorWorldSettings,
  worldSeconds: number,
): WorldClimateSchedule {
  if (!isWorldWeatherEvolving(settings)) {
    const preset = settings.weather.preset;
    return { fromPreset: preset, toPreset: preset, blend: 1, preset };
  }
  const seconds = Number.isFinite(worldSeconds) ? Math.max(0, worldSeconds) : 0;
  const segmentSeconds = getWorldClimateSegmentSeconds(settings);
  const segment = Math.floor(seconds / segmentSeconds);
  const toPreset = getWorldClimateSegmentPreset(settings, segment);
  const fromPreset = segment === 0 ? toPreset : getWorldClimateSegmentPreset(settings, segment - 1);
  const rampSeconds = getWorldClimateSegmentRampSeconds(settings, segment);
  const secondsIntoSegment = seconds - segment * segmentSeconds;
  const blend = segment === 0 ? 1 : smoothstep01(secondsIntoSegment / rampSeconds);
  const preset = blend >= 0.5 ? toPreset : fromPreset;
  return { fromPreset, toPreset, blend, preset };
}

/** Blends a per-preset scalar table across the schedule's active transition. */
export function blendWorldPresetScalar(
  table: Record<WorldWeatherPreset, number>,
  schedule: WorldClimateSchedule,
): number {
  if (schedule.fromPreset === schedule.toPreset) return table[schedule.toPreset];
  return lerp(table[schedule.fromPreset], table[schedule.toPreset], schedule.blend);
}

function blendNodeField(field: keyof WorldClimateNodeVector, schedule: WorldClimateSchedule): number {
  const from = WORLD_CLIMATE_NODE_VECTORS[schedule.fromPreset][field];
  const to = WORLD_CLIMATE_NODE_VECTORS[schedule.toPreset][field];
  return lerp(from, to, schedule.blend);
}

// ---------------------------------------------------------------------------
// Wetness integrator (fixed 30 Hz walk from t = 0 with cached checkpoints)
// ---------------------------------------------------------------------------

/** Checkpoint stride: one cached wetness value every 64 simulated seconds. */
const WETNESS_CHECKPOINT_TICKS = 64 * HZ;
/** Bounded config cache; old entries are evicted whole. */
const WETNESS_CACHE_LIMIT = 8;

interface WetnessCacheEntry {
  /** checkpoints[k] = wetness after k * WETNESS_CHECKPOINT_TICKS ticks. */
  checkpoints: number[];
}

const wetnessCache = new Map<string, WetnessCacheEntry>();

function wetnessConfigKey(settings: DirectorWorldSettings): string {
  const weather = settings.weather;
  return [
    settings.seed,
    weather.preset,
    weather.intensity,
    weather.wetness,
    weather.evolution?.mode ?? "static",
    weather.evolution?.periodSeconds ?? DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
  ].join("|");
}

/** One 30 Hz integrator step; kept as a single function so replay paths share it. */
function stepWetness(settings: DirectorWorldSettings, wetness: number, tick: number): number {
  const schedule = evaluateWorldClimateSchedule(settings, tick * WETNESS_DT);
  const intensity = clamp01(settings.weather.intensity);
  const target = blendNodeField("wetnessTarget", schedule) * lerp(0.55, 1, intensity);
  const rate = blendNodeField("wetnessRatePerSecond", schedule) * lerp(0.55, 1, intensity);
  const step = rate * WETNESS_DT;
  if (wetness < target) return Math.min(target, wetness + step);
  if (wetness > target) return Math.max(target, wetness - step);
  return wetness;
}

/**
 * Integrated wetness at `worldSeconds` in `cycle` mode. The authored
 * `weather.wetness` is the initial value at t = 0. Deterministic under
 * arbitrary query order: values always come from the same tick walk starting
 * at t = 0 (cached checkpoints store exact intermediate states, so resuming
 * from one executes the identical float sequence).
 */
export function evaluateWorldWetness(settings: DirectorWorldSettings, worldSeconds: number): number {
  if (!isWorldWeatherEvolving(settings)) return clamp01(settings.weather.wetness);
  const seconds = Number.isFinite(worldSeconds) ? Math.max(0, worldSeconds) : 0;
  const targetTick = Math.floor(seconds * HZ);

  const key = wetnessConfigKey(settings);
  let entry = wetnessCache.get(key);
  if (!entry) {
    if (wetnessCache.size >= WETNESS_CACHE_LIMIT) {
      const oldest = wetnessCache.keys().next().value;
      if (oldest !== undefined) wetnessCache.delete(oldest);
    }
    entry = { checkpoints: [clamp01(settings.weather.wetness)] };
    wetnessCache.set(key, entry);
  }

  const wantedCheckpoint = Math.floor(targetTick / WETNESS_CHECKPOINT_TICKS);
  // Extend the checkpoint chain sequentially so every stored value is the
  // exact product of the walk from tick 0.
  while (entry.checkpoints.length <= wantedCheckpoint) {
    const fromCheckpoint = entry.checkpoints.length - 1;
    let wetness = entry.checkpoints[fromCheckpoint];
    const startTick = fromCheckpoint * WETNESS_CHECKPOINT_TICKS;
    const endTick = (fromCheckpoint + 1) * WETNESS_CHECKPOINT_TICKS;
    for (let tick = startTick; tick < endTick; tick += 1) wetness = stepWetness(settings, wetness, tick);
    entry.checkpoints.push(wetness);
  }

  let wetness = entry.checkpoints[wantedCheckpoint];
  for (let tick = wantedCheckpoint * WETNESS_CHECKPOINT_TICKS; tick < targetTick; tick += 1) {
    wetness = stepWetness(settings, wetness, tick);
  }
  return wetness;
}

/** Test seam: drops all cached wetness walks. */
export function resetWorldClimateCaches(): void {
  wetnessCache.clear();
}

// ---------------------------------------------------------------------------
// Full climate evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates the complete climate state at `worldSeconds`.
 *
 * Static mode returns the authored numbers verbatim (weather block by
 * reference; rain/snow/storm levels mapped so shared consumers reproduce the
 * legacy pipeline bit-for-bit). Cycle mode blends the node vectors across the
 * seeded schedule and integrates wetness.
 */
export function evaluateWorldClimate(settings: DirectorWorldSettings, worldSeconds: number): WorldClimateState {
  const hours = evaluateWorldTimeOfDayHours(settings.timeOfDay, worldSeconds);
  const authored = settings.weather;
  const intensity = clamp01(authored.intensity);

  if (!isWorldWeatherEvolving(settings)) {
    const preset = authored.preset;
    const rainPresence = preset === "rain" || preset === "storm" ? 1 : 0;
    const snowPresence = preset === "snow" ? 1 : 0;
    return {
      evolving: false,
      fromPreset: preset,
      toPreset: preset,
      blend: 1,
      preset,
      intensity: authored.intensity,
      cloudCover: authored.cloudCover,
      wetness: authored.wetness,
      rainPresence,
      snowPresence,
      rainLevel: rainPresence * intensity,
      snowLevel: snowPresence * intensity,
      windGain: 1,
      stormFactor: preset === "storm" ? 1 : 0,
      hours,
      weather: authored,
    };
  }

  const schedule = evaluateWorldClimateSchedule(settings, worldSeconds);
  const inFirstSegment =
    Math.max(0, Number.isFinite(worldSeconds) ? worldSeconds : 0) < getWorldClimateSegmentSeconds(settings);
  // Segment 0 "from" state is the authored look, so switching evolution on
  // does not snap the frame at t = 0.
  const cloudCover = inFirstSegment
    ? lerp(authored.cloudCover, blendNodeField("cloudCover", schedule), firstSegmentSettle(settings, worldSeconds))
    : blendNodeField("cloudCover", schedule);
  const rainPresence = blendNodeField("rainLevel", schedule);
  const snowPresence = blendNodeField("snowLevel", schedule);
  const rainLevel = rainPresence * intensity;
  const snowLevel = snowPresence * intensity;
  const windGain = blendNodeField("windGain", schedule);
  const stormFactor = blendNodeField("stormFactor", schedule);
  const wetness = evaluateWorldWetness(settings, worldSeconds);

  const weather: DirectorWorldWeather = {
    preset: schedule.preset,
    intensity: clamp01(Math.max(rainLevel, snowLevel)),
    wetness,
    cloudCover: clamp01(cloudCover),
    ...(authored.evolution ? { evolution: authored.evolution } : {}),
  };

  return {
    evolving: true,
    ...schedule,
    intensity: weather.intensity,
    cloudCover: weather.cloudCover,
    wetness,
    rainPresence,
    snowPresence,
    rainLevel,
    snowLevel,
    windGain,
    stormFactor,
    hours,
    weather,
  };
}

/** Eases the authored t=0 look into the node vector across the first ramp. */
function firstSegmentSettle(settings: DirectorWorldSettings, worldSeconds: number): number {
  const seconds = Number.isFinite(worldSeconds) ? Math.max(0, worldSeconds) : 0;
  const ramp = getWorldClimateSegmentRampSeconds(settings, 0);
  return smoothstep01(seconds / ramp);
}

/**
 * Settings view whose weather block is the evaluated climate — the bridge for
 * consumers typed against `DirectorWorldSettings` (solar model, water params,
 * scene lighting). Static mode returns the input object unchanged so legacy
 * call sites keep reference equality.
 */
export function resolveEffectiveWorldSettings(
  settings: DirectorWorldSettings,
  climate: WorldClimateState,
): DirectorWorldSettings {
  if (!climate.evolving) return settings;
  return { ...settings, weather: climate.weather };
}
