import {
  DIRECTOR_WORLD_SIMULATION_HZ,
  WORLD_WILDLIFE_SPECIES_ARCHETYPE,
  type DirectorWorldSettings,
  type DirectorWorldWeather,
  type DirectorWorldWildlifeGroup,
  type DirectorWorldWind,
  type WorldWeatherPreset,
  type WorldWildlifeArchetype,
  type WorldWildlifeSpecies,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { hashCombine, hashUint32, worldStreamId } from "../worldRandom";
import { writeWorldWindVector } from "../worldWind";
import {
  blendWorldPresetScalar,
  evaluateWorldClimateSchedule,
  isWorldWeatherEvolving,
  WORLD_CLIMATE_NODE_VECTORS,
} from "../worldClimate";
import { createWildlifeSpatialHash } from "./wildlifeSpatialHash";

/**
 * Pure wildlife simulation core (no three.js imports).
 *
 * Determinism contract: state is a pure function of (group config, world seed,
 * groundHeight, environment, quantized tick). Time is quantized to the fixed
 * DIRECTOR_WORLD_SIMULATION_HZ timestep; `stepTo(seconds)` may be called with
 * arbitrary, non-monotonic targets (scrubbing, out-of-order frame export) and
 * must resolve to bit-identical Float32Array state regardless of the path
 * taken. Backward (and far-forward) jumps restore the nearest checkpoint at or
 * before the target tick and replay; replay executes the exact same float ops
 * on bit-identical restored state, so results match continuous stepping.
 *
 * All per-agent state lives in preallocated SoA typed arrays; stepping
 * performs zero allocations. Neighbor queries run through a preallocated
 * spatial hash (see wildlifeSpatialHash.ts) instead of an O(N²) pair scan;
 * candidate order is a pure function of agent positions, so replay stays
 * bit-identical even though float accumulation order differs from the old
 * naive scan.
 *
 * Climate coupling: the optional environment feeds per-tick wind and storm
 * values evaluated INSIDE the sim from the deterministic wind/climate
 * functions of the quantized tick — never from the render loop — so
 * checkpoint replay stays bit-identical. Wind drifts flocks (butterflies more
 * than birds), storms drop flight bands and slow grazing herds (wolves are
 * unbothered), fish stay inside an overlapping authored water rectangle, and
 * prey herds steer away from wolf territory circles.
 */

const HZ = DIRECTOR_WORLD_SIMULATION_HZ;
const DT = 1 / HZ;
const TWO_PI = Math.PI * 2;

/** Checkpoint cadence: one full snapshot every 5 simulated seconds. */
export const WILDLIFE_CHECKPOINT_INTERVAL_TICKS = 150;
/** Ring capacity; the tick-0 snapshot is kept separately and never evicted. */
export const WILDLIFE_MAX_CHECKPOINTS = 64;

/**
 * Containment tuning. The sim softly steers agents back from 85% of the area
 * radius and hard-clamps at 108%, comfortably inside the 15% soft margin the
 * behavior tests (and the visual contract) allow.
 */
const SOFT_CONTAINMENT_SCALE = 0.85;
const HARD_CONTAINMENT_SCALE = 1.08;
/** Altitude band hard clamp expands the band by 8% of its span (min 0.05 m). */
const BAND_HARD_MARGIN_SCALE = 0.08;

/** Agent is moving toward a walk target. */
export const WILDLIFE_BEHAVIOR_WALK = 0;
/** Agent is stationary, grazing (herd species only). */
export const WILDLIFE_BEHAVIOR_GRAZE = 1;
/** Agent is returning to the herd center after being pushed out. */
export const WILDLIFE_BEHAVIOR_REGROUP = 2;
/** Short high-speed burst: rabbit dash or wolf chase lope. */
export const WILDLIFE_BEHAVIOR_SPRINT = 3;
/** Startled bolt away from the herd (sheep), resolved by a regroup. */
export const WILDLIFE_BEHAVIOR_FLEE = 4;

// ---------------------------------------------------------------------------
// Environment input (wind + weather)
// ---------------------------------------------------------------------------

/**
 * Wind and weather snapshot the sim consumes. These are the AUTHORED settings
 * (not the per-frame evaluated wind vector): the sim re-evaluates the shared
 * deterministic gust model per tick from `wind`, so wind at tick T is a pure
 * function of tick and seek stays bit-stable. Changing any consumed field
 * changes the config key, which discards the sim and replays fresh — the same
 * lifecycle as every other simulation-relevant config change.
 */
export interface WildlifeEnvironment {
  /** Authored wind settings (direction, mean speed, gustiness). */
  wind: DirectorWorldWind;
  /** Authored weather block; only `preset` and `intensity` drive behavior. */
  weather: DirectorWorldWeather;
}

/** Default environment: still air, clear sky. Keeps older call sites valid. */
export const WILDLIFE_CALM_ENVIRONMENT: WildlifeEnvironment = {
  wind: { directionDegrees: 0, speedMps: 0, gustiness: 0, turbulence: 0 },
  weather: { preset: "clear", intensity: 0, wetness: 0, cloudCover: 0 },
};

/**
 * Weather response tables at intensity 1; every factor lerps from the clear
 * value by `weather.intensity`. Only the five protocol presets exist — do not
 * add rows without a protocol change.
 */
const WEATHER_HERD_SPEED_AT_FULL: Record<WorldWeatherPreset, number> = {
  clear: 1,
  overcast: 0.95,
  rain: 0.8,
  snow: 0.7,
  storm: 0.55,
};
const WEATHER_HERD_CLUSTER_AT_FULL: Record<WorldWeatherPreset, number> = {
  clear: 1,
  overcast: 0.95,
  rain: 0.75,
  snow: 0.65,
  storm: 0.5,
};
const WEATHER_HERD_GRAZE_SCALE_AT_FULL: Record<WorldWeatherPreset, number> = {
  clear: 1,
  overcast: 1,
  rain: 1.25,
  snow: 1.35,
  storm: 1.5,
};
/** Flock downwind steering bias (accel per m/s of wind) at intensity 1. */
const WEATHER_WIND_BIAS_AT_FULL: Record<WorldWeatherPreset, number> = {
  clear: 0.06,
  overcast: 0.12,
  rain: 0.3,
  snow: 0.25,
  storm: 0.8,
};

function lerpByIntensity(clearValue: number, fullValue: number, intensity: number): number {
  const t = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
  return clearValue + (fullValue - clearValue) * t;
}

/** Wolves' shared prowl anchor orbits the area once every 90 seconds. */
const PACK_ANCHOR_RAD_PER_S = TWO_PI / 90;

/** Nominal cruise/walk speed per species (m/s) before `speedScale`. */
export const WILDLIFE_CRUISE_SPEED_MPS: Record<WorldWildlifeSpecies, number> = {
  birds: 9,
  butterflies: 1.2,
  fish: 1.6,
  deer: 1.8,
  rabbits: 2.2,
  wolves: 2.5,
  sheep: 1.2,
};

/** Default flight band (metres above area.center.y) when `altitude` is absent. */
export const WILDLIFE_DEFAULT_ALTITUDE_BAND_M: Record<"birds" | "butterflies", [number, number]> = {
  birds: [8, 25],
  butterflies: [0.5, 3],
};

// ---------------------------------------------------------------------------
// Environment coupling (optional; absent = today's behavior exactly)
// ---------------------------------------------------------------------------

/**
 * Air-mass advection: fraction of the evaluated wind velocity added to flier
 * motion. Only near-passive fliers are carried; birds hold position but bias
 * their flight direction instead (see WILDLIFE_WIND_HEADING_FACTOR).
 */
export const WILDLIFE_WIND_DRIFT_FACTOR: Partial<Record<WorldWildlifeSpecies, number>> = {
  butterflies: 0.85,
};

/**
 * Active fliers prefer flying with the wind: acceleration (m/s² per m/s of
 * wind) steering the flock downwind without overriding its containment.
 */
export const WILDLIFE_WIND_HEADING_FACTOR: Partial<Record<WorldWildlifeSpecies, number>> = {
  birds: 0.3,
};

/** Fraction of the flight band a full storm pushes flocks down by. */
export const WILDLIFE_STORM_BAND_DROP = 0.45;
/**
 * Downward acceleration (m/s²) a full storm applies across the whole flock.
 * Speed regulation turns this into a heading bias, so birds fly lower rather
 * than diving; the band-bottom spring still holds the authored floor.
 */
export const WILDLIFE_STORM_SINK_ACCEL = 1.5;
/** Cruise-speed loss for grazing herds in a full storm (wolves exempt). */
export const WILDLIFE_STORM_HERD_SLOWDOWN = 0.35;
/** Extra metres past a wolf territory radius that prey still avoids. */
export const WILDLIFE_PREDATOR_AVOID_MARGIN_M = 3;
/** Steering weight of predator avoidance relative to the walk target. */
const PREDATOR_AVOID_WEIGHT = 2.5;

/** Herd species that avoid wolf territories. */
export const WILDLIFE_PREY_SPECIES: ReadonlySet<WorldWildlifeSpecies> = new Set(["deer", "rabbits", "sheep"]);

/** Axis-aligned-in-local-frame water rectangle a school is confined to. */
export interface WildlifeWaterRect {
  centerX: number;
  centerZ: number;
  sizeX: number;
  sizeZ: number;
  rotationDegrees: number;
}

/** Wolf territory circle prey herds steer away from. */
export interface WildlifePredatorZone {
  x: number;
  z: number;
  radius: number;
}

/**
 * Optional deterministic environment inputs. Every field is folded into the
 * sim config key, so changing them resets and replays the simulation.
 */
export interface WildlifeSimEnvironment {
  /** World settings whose wind + weather the sim evaluates per tick. */
  settings: DirectorWorldSettings;
  /** Water rectangles overlapping a school's area (first one confines it). */
  waterRects?: WildlifeWaterRect[];
  /** Wolf territories overlapping a prey herd's area. */
  predatorZones?: WildlifePredatorZone[];
}

/**
 * Either environment shape the sim accepts: the legacy authored wind+weather
 * snapshot, or the richer settings-backed environment with water/predator
 * context and per-tick climate evolution.
 */
export type WildlifeAnyEnvironment = WildlifeEnvironment | WildlifeSimEnvironment;

function isWildlifeSimEnvironment(environment: WildlifeAnyEnvironment): environment is WildlifeSimEnvironment {
  return "settings" in environment;
}

/** Authored wind+weather view of either environment shape (calm when absent). */
function resolveAuthoredEnvironment(environment?: WildlifeAnyEnvironment): WildlifeEnvironment {
  if (!environment) return WILDLIFE_CALM_ENVIRONMENT;
  if (isWildlifeSimEnvironment(environment)) {
    return { wind: environment.settings.wind, weather: environment.settings.weather };
  }
  return environment;
}

/**
 * Resolves the environment for one group from the world state: schools get
 * the water rectangles overlapping their area, prey herds get the wolf
 * territories overlapping theirs, and every species gets the settings whose
 * wind/storm the sim evaluates per tick. Pure and unit-testable.
 */
export function buildWildlifeEnvironment(
  settings: DirectorWorldSettings,
  group: DirectorWorldWildlifeGroup,
  allGroups: ReadonlyArray<DirectorWorldWildlifeGroup>,
  waterRects: ReadonlyArray<WildlifeWaterRect>,
): WildlifeSimEnvironment {
  const environment: WildlifeSimEnvironment = { settings };
  const archetype = WORLD_WILDLIFE_SPECIES_ARCHETYPE[group.species];
  const [groupX, , groupZ] = group.area.center;
  if (archetype === "school") {
    const overlapping = waterRects.filter((rect) => {
      const reach = group.area.radius + Math.hypot(rect.sizeX, rect.sizeZ) / 2;
      return Math.hypot(rect.centerX - groupX, rect.centerZ - groupZ) <= reach;
    });
    if (overlapping.length > 0) environment.waterRects = overlapping;
  } else if (archetype === "herd" && WILDLIFE_PREY_SPECIES.has(group.species)) {
    const zones: WildlifePredatorZone[] = [];
    for (const other of allGroups) {
      if (other.id === group.id || other.species !== "wolves" || !other.visible) continue;
      const [wolfX, , wolfZ] = other.area.center;
      if (Math.hypot(wolfX - groupX, wolfZ - groupZ) <= group.area.radius + other.area.radius) {
        zones.push({ x: wolfX, z: wolfZ, radius: other.area.radius });
      }
    }
    if (zones.length > 0) environment.predatorZones = zones;
  }
  return environment;
}

const WIND_GAIN_BY_PRESET: Record<WorldWeatherPreset, number> = {
  clear: WORLD_CLIMATE_NODE_VECTORS.clear.windGain,
  overcast: WORLD_CLIMATE_NODE_VECTORS.overcast.windGain,
  rain: WORLD_CLIMATE_NODE_VECTORS.rain.windGain,
  snow: WORLD_CLIMATE_NODE_VECTORS.snow.windGain,
  storm: WORLD_CLIMATE_NODE_VECTORS.storm.windGain,
};

const STORM_FACTOR_BY_PRESET: Record<WorldWeatherPreset, number> = {
  clear: 0,
  overcast: 0,
  rain: 0,
  snow: 0,
  storm: 1,
};

/**
 * Environment fragment of the sim identity key, scoped per archetype.
 *
 * Herds and flocks consume the authored wind (direction, speed, gustiness)
 * and weather (preset, intensity, evolution) — turbulence, wetness, and
 * cloud cover never touch the sim, so editing them (or letting an evolution
 * system drift wetness) must not reset herds mid-shot. Schools consume
 * neither wind nor weather, only the confining water rectangles, so weather
 * edits never reset a fish school.
 */
function wildlifeEnvironmentKey(species: WorldWildlifeSpecies, environment?: WildlifeAnyEnvironment): string {
  if (!environment) return "env:0";
  const archetype = WORLD_WILDLIFE_SPECIES_ARCHETYPE[species];
  const parts: string[] = [];
  const authored = resolveAuthoredEnvironment(environment);
  if (archetype !== "school") {
    const weather = authored.weather;
    const evolution = weather.evolution ? `${weather.evolution.mode},${weather.evolution.periodSeconds}` : "static";
    parts.push(`wx:${weather.preset},${weather.intensity},${evolution}`);
    const wind = authored.wind;
    parts.push(`wind:${wind.directionDegrees},${wind.speedMps},${wind.gustiness}`);
  }
  const simEnvironment = isWildlifeSimEnvironment(environment) ? environment : undefined;
  if (archetype === "school" && simEnvironment?.waterRects && simEnvironment.waterRects.length > 0) {
    parts.push(
      `water:${simEnvironment.waterRects
        .map((rect) => `${rect.centerX},${rect.centerZ},${rect.sizeX},${rect.sizeZ},${rect.rotationDegrees}`)
        .join(";")}`,
    );
  }
  if (
    archetype === "herd" &&
    WILDLIFE_PREY_SPECIES.has(species) &&
    simEnvironment?.predatorZones &&
    simEnvironment.predatorZones.length > 0
  ) {
    parts.push(`pred:${simEnvironment.predatorZones.map((zone) => `${zone.x},${zone.z},${zone.radius}`).join(";")}`);
  }
  return parts.length > 0 ? `env:${parts.join("|")}` : "env:0";
}

// ---------------------------------------------------------------------------
// Serializable RNG
// ---------------------------------------------------------------------------

/**
 * Serializable RNG contract so checkpoint save/restore can capture the state.
 */
export interface WildlifeRng {
  /** Returns the next pseudo-random float in [0, 1). */
  next(): number;
  /** Returns the current internal state for checkpoint serialization. */
  getState(): number;
  /** Restores the internal state from a checkpoint. */
  setState(state: number): void;
}

/**
 * Serializable twin of `createWorldRng`.
 *
 * `createWorldRng` hides its state inside a closure, so checkpoints could not
 * capture or restore it. This wrapper re-implements the exact same algorithm
 * (a Weyl sequence advanced by the golden-ratio increment, avalanched through
 * the shared lowbias32 `hashUint32` — a splitmix32-family generator) with
 * explicit get/set state. A unit test locks both sequences together so the
 * implementations can never drift apart.
 */
export function createWildlifeRng(seed: number): WildlifeRng {
  let state = hashUint32(seed === 0 ? 0x1234_5678 : seed);
  return {
    next(): number {
      state = (state + 0x9e37_79b9) >>> 0;
      return hashUint32(state) / 4_294_967_296;
    },
    getState(): number {
      return state;
    },
    setState(next: number): void {
      state = next >>> 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Public state views
// ---------------------------------------------------------------------------

/**
 * Read-only window onto sim buffers. Arrays are live views (no copies); the
 * sim rewrites them on `stepTo`, so consumers must not retain values across
 * frames or mutate them. `tick` is managed by the sim.
 */
export interface WildlifeSimStateView {
  /** Number of agents in this group. */
  readonly count: number;
  /** Current simulation tick (managed by the sim). */
  tick: number;
  /** Agent X positions (live view, do not retain across frames). */
  readonly posX: Float32Array;
  /** Agent Y positions (live view, do not retain across frames). */
  readonly posY: Float32Array;
  /** Agent Z positions (live view, do not retain across frames). */
  readonly posZ: Float32Array;
  /** Agent X velocity components (live view). */
  readonly velX: Float32Array;
  /** Agent Y velocity components (live view). */
  readonly velY: Float32Array;
  /** Agent Z velocity components (live view). */
  readonly velZ: Float32Array;
  /** Herd steering heading (radians, yaw around +Y, forward +Z). */
  readonly heading: Float32Array;
  /** WILDLIFE_BEHAVIOR_* flag per agent (flock/school agents stay at WALK). */
  readonly behaviorState: Float32Array;
  /** Smoothed 0..1 graze pose blend for render (head-down transition). */
  readonly grazeBlend: Float32Array;
  /** Immutable per-agent animation phase offset in [0, 2π). */
  readonly phase: Float32Array;
}

/** Two surrounding ticks plus blend factor for inter-tick interpolation. */
export interface WildlifeSimRenderView {
  /** Number of agents in this group. */
  readonly count: number;
  /** Interpolation factor in [0, 1] between `prev` and `curr` ticks. */
  alpha: number;
  /** State at tick floor(seconds × HZ). */
  readonly prev: WildlifeSimStateView;
  /** State at the following tick (lookahead for interpolation). */
  readonly curr: WildlifeSimStateView;
}

export interface WildlifeSim {
  /** Deterministic identity key of the sim; changing it forces recreation. */
  readonly configKey: string;
  /** Behavioral archetype: flock, school, or herd. */
  readonly archetype: WorldWildlifeArchetype;
  /** Wildlife species driving gait and visual tuning. */
  readonly species: WorldWildlifeSpecies;
  /** Total number of agents in this group. */
  readonly count: number;
  /**
   * Advance/rewind to the quantized tick floor(targetSeconds × HZ). Safe to
   * call with any finite value in any order.
   */
  stepTo(targetSeconds: number): void;
  /** Canonical state at the last stepTo target tick. */
  readState(): WildlifeSimStateView;
  /** Interpolation pair around the last stepTo target time. */
  readRenderState(): WildlifeSimRenderView;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

interface ResolvedSimConfig {
  archetype: WorldWildlifeArchetype;
  species: WorldWildlifeSpecies;
  count: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  groundY: number;
  cruise: number;
  // Boids (flock/school)
  neighborRadius: number;
  separationRadius: number;
  alignWeight: number;
  cohesionWeight: number;
  separationWeight: number;
  containAccel: number;
  maxAccel: number;
  flutterAccel: number;
  /** Butterflies: slow circling drift that reads as meandering. */
  wanderAccel: number;
  /** Birds: spring toward a per-agent preferred altitude (layered flight). */
  layerAccel: number;
  /**
   * Scale on the VERTICAL component of alignment + cohesion. Birds use a
   * small value so the layer spring owns the Y axis (strata don't collapse
   * onto the flock's mean height); everyone else keeps full 3D flocking.
   */
  flockVerticalFactor: number;
  /** Flock downwind steering bias, acceleration per m/s of wind. */
  windBiasAccel: number;
  /** Absolute altitude band (flock) or [unused, soft ceiling] (school). */
  bandMinY: number;
  bandMaxY: number;
  bandHardMinY: number;
  bandHardMaxY: number;
  // Herd
  turnRate: number;
  accel: number;
  herdSeparationRadius: number;
  /** Scales walk-target distance from the anchor (sheep small → knot up). */
  walkRadiusScale: number;
  /** Graze pause range in seconds (wolves short/restless, sheep long/placid). */
  grazeMinS: number;
  grazeMaxS: number;
  /** Probability of a sprint burst when leaving a graze (rabbits, wolves). */
  sprintProbability: number;
  sprintSpeedMult: number;
  sprintMinS: number;
  sprintMaxS: number;
  /** Probability of a startle flee when leaving a graze (sheep). */
  fleeProbability: number;
  fleeSpeedMult: number;
  fleeMinS: number;
  fleeMaxS: number;
  /** Wolves: 0..1 pull of walk/chase targets toward the roaming pack anchor. */
  packPull: number;
  // Weather (already folded with intensity; 1 = no effect)
  weatherSpeedFactor: number;
  weatherClusterFactor: number;
  weatherGrazeScale: number;
}

interface HerdSpeciesTuning {
  turnRate: number;
  accel: number;
  walkRadiusScale: number;
  grazeMinS: number;
  grazeMaxS: number;
  sprintProbability: number;
  sprintSpeedMult: number;
  sprintMinS: number;
  sprintMaxS: number;
  fleeProbability: number;
  fleeSpeedMult: number;
  fleeMinS: number;
  fleeMaxS: number;
  packPull: number;
}

/**
 * Herd species character:
 * - deer: baseline alternation of walking and grazing.
 * - rabbits: frequent short sprint bursts between grazes.
 * - wolves: restless rangers; short grazes, targets pulled toward a roaming
 *   pack anchor, occasional chase lopes after the anchor's lead point.
 * - sheep: placid and clustered near the centre, with rare startle bolts
 *   that resolve into a regroup.
 */
const HERD_SPECIES_TUNING: Record<"deer" | "rabbits" | "wolves" | "sheep", HerdSpeciesTuning> = {
  deer: {
    turnRate: 2.5,
    accel: 2.5,
    walkRadiusScale: 1,
    grazeMinS: 2,
    grazeMaxS: 8,
    sprintProbability: 0,
    sprintSpeedMult: 1,
    sprintMinS: 0,
    sprintMaxS: 0,
    fleeProbability: 0,
    fleeSpeedMult: 1,
    fleeMinS: 0,
    fleeMaxS: 0,
    packPull: 0,
  },
  rabbits: {
    turnRate: 4,
    accel: 6,
    walkRadiusScale: 0.9,
    grazeMinS: 2,
    grazeMaxS: 6,
    sprintProbability: 0.45,
    sprintSpeedMult: 2.3,
    sprintMinS: 0.7,
    sprintMaxS: 1.4,
    fleeProbability: 0,
    fleeSpeedMult: 1,
    fleeMinS: 0,
    fleeMaxS: 0,
    packPull: 0,
  },
  wolves: {
    turnRate: 2.8,
    accel: 3,
    walkRadiusScale: 0.5,
    grazeMinS: 1,
    grazeMaxS: 3,
    sprintProbability: 0.3,
    sprintSpeedMult: 1.9,
    sprintMinS: 1.5,
    sprintMaxS: 3,
    fleeProbability: 0,
    fleeSpeedMult: 1,
    fleeMinS: 0,
    fleeMaxS: 0,
    packPull: 0.65,
  },
  sheep: {
    turnRate: 2,
    accel: 1.5,
    walkRadiusScale: 0.45,
    grazeMinS: 3,
    grazeMaxS: 9,
    sprintProbability: 0,
    sprintSpeedMult: 1,
    sprintMinS: 0,
    sprintMaxS: 0,
    fleeProbability: 0.12,
    fleeSpeedMult: 1.8,
    fleeMinS: 1.2,
    fleeMaxS: 2,
    packPull: 0,
  },
};

function resolveSimConfig(
  group: DirectorWorldWildlifeGroup,
  groundHeight: number,
  environment: WildlifeEnvironment,
): ResolvedSimConfig {
  const species = group.species;
  const archetype = WORLD_WILDLIFE_SPECIES_ARCHETYPE[species];
  const [centerX, centerY, centerZ] = group.area.center;
  const radius = group.area.radius;
  const cruise = WILDLIFE_CRUISE_SPEED_MPS[species] * group.speedScale;
  const { preset, intensity } = environment.weather;

  const config: ResolvedSimConfig = {
    archetype,
    species,
    count: group.count,
    centerX,
    centerY,
    centerZ,
    radius,
    groundY: groundHeight,
    cruise,
    neighborRadius: 6,
    separationRadius: 2,
    alignWeight: 1.5,
    cohesionWeight: 1.2,
    separationWeight: 4,
    containAccel: cruise * 3,
    maxAccel: cruise * 3.5,
    flutterAccel: 0,
    wanderAccel: 0,
    layerAccel: 0,
    flockVerticalFactor: 1,
    windBiasAccel: 0,
    bandMinY: centerY,
    bandMaxY: centerY,
    bandHardMinY: centerY,
    bandHardMaxY: centerY,
    turnRate: 2.5,
    accel: 2.5,
    herdSeparationRadius: 1.6,
    walkRadiusScale: 1,
    grazeMinS: 2,
    grazeMaxS: 8,
    sprintProbability: 0,
    sprintSpeedMult: 1,
    sprintMinS: 0,
    sprintMaxS: 0,
    fleeProbability: 0,
    fleeSpeedMult: 1,
    fleeMinS: 0,
    fleeMaxS: 0,
    packPull: 0,
    weatherSpeedFactor: lerpByIntensity(1, WEATHER_HERD_SPEED_AT_FULL[preset], intensity),
    weatherClusterFactor: lerpByIntensity(1, WEATHER_HERD_CLUSTER_AT_FULL[preset], intensity),
    weatherGrazeScale: lerpByIntensity(1, WEATHER_HERD_GRAZE_SCALE_AT_FULL[preset], intensity),
  };

  // Downwind steering bias only applies to airborne archetypes; the per-tick
  // wind vector itself is evaluated inside the step from `environment.wind`.
  const windBiasBase = lerpByIntensity(WEATHER_WIND_BIAS_AT_FULL.clear, WEATHER_WIND_BIAS_AT_FULL[preset], intensity);

  if (archetype === "flock") {
    const defaults = WILDLIFE_DEFAULT_ALTITUDE_BAND_M[species === "birds" ? "birds" : "butterflies"];
    const minM = group.altitude ? group.altitude.minM : defaults[0];
    const maxM = group.altitude ? group.altitude.maxM : defaults[1];
    config.bandMinY = centerY + Math.min(minM, maxM);
    config.bandMaxY = centerY + Math.max(minM, maxM);
    const hardMargin = Math.max((config.bandMaxY - config.bandMinY) * BAND_HARD_MARGIN_SCALE, 0.05);
    config.bandHardMinY = config.bandMinY - hardMargin;
    config.bandHardMaxY = config.bandMaxY + hardMargin;
    if (species === "birds") {
      config.neighborRadius = 6;
      config.separationRadius = 2.2;
      // Layered flight: each bird holds a preferred slice of the altitude
      // band, so the flock reads as stacked strata instead of one sheet.
      // Vertical cohesion/alignment shrink so the layer spring owns Y.
      config.layerAccel = cruise * 0.8;
      config.flockVerticalFactor = 0.2;
      config.windBiasAccel = windBiasBase;
    } else {
      // Butterflies: loose micro-flock with strong per-agent flutter plus a
      // slow circling wander; they are light, so wind moves them harder.
      config.neighborRadius = 2;
      config.separationRadius = 0.5;
      config.alignWeight = 0.5;
      config.cohesionWeight = 0.35;
      config.flutterAccel = 3;
      config.wanderAccel = 2.5;
      config.windBiasAccel = windBiasBase * 1.6;
    }
  } else if (archetype === "school") {
    // area.center.y is the water surface; fish live in the sphere below it.
    // Tighter than the aerial flock: a longer sensing radius (the school
    // finds itself instead of fragmenting), shorter separation, and stronger
    // cohesion/alignment produce the dense bait-ball look.
    config.neighborRadius = 5;
    config.separationRadius = 0.45;
    config.alignWeight = 2.6;
    config.cohesionWeight = 3.6;
    config.separationWeight = 4;
    config.bandMinY = centerY - radius;
    config.bandMaxY = centerY - Math.min(0.5, radius * 0.6); // soft ceiling
    config.bandHardMaxY = centerY - Math.min(0.05, radius * 0.1); // hard ceiling
    config.bandHardMinY = centerY - radius;
  } else {
    const tuning = HERD_SPECIES_TUNING[species as keyof typeof HERD_SPECIES_TUNING] ?? HERD_SPECIES_TUNING.deer;
    config.turnRate = tuning.turnRate;
    config.accel = tuning.accel;
    config.walkRadiusScale = tuning.walkRadiusScale;
    config.grazeMinS = tuning.grazeMinS;
    config.grazeMaxS = tuning.grazeMaxS;
    config.sprintProbability = tuning.sprintProbability;
    config.sprintSpeedMult = tuning.sprintSpeedMult;
    config.sprintMinS = tuning.sprintMinS;
    config.sprintMaxS = tuning.sprintMaxS;
    config.fleeProbability = tuning.fleeProbability;
    config.fleeSpeedMult = tuning.fleeSpeedMult;
    config.fleeMinS = tuning.fleeMinS;
    config.fleeMaxS = tuning.fleeMaxS;
    config.packPull = tuning.packPull;
    if (species === "wolves") {
      // Apex predators are unbothered by weather: the pack keeps its speed,
      // roaming ring, and graze cadence through rain and storm alike.
      config.weatherSpeedFactor = 1;
      config.weatherClusterFactor = 1;
      config.weatherGrazeScale = 1;
    }
  }
  return config;
}

/**
 * Identity of a sim run. Any field that influences simulation state is part
 * of the key — including the archetype-relevant environment inputs — while
 * render-only fields (sizeScale, assetId, name, visible, locked) are
 * deliberately excluded so tweaking them never resets the simulation.
 * From the environment, only the consumed fields participate (see
 * wildlifeEnvironmentKey): turbulence, wetness, and cloud cover never touch
 * the sim, so editing them (or letting an evolution system drift wetness)
 * must not reset herds mid-shot.
 */
export function wildlifeSimConfigKey(
  group: DirectorWorldWildlifeGroup,
  worldSeed: number,
  groundHeight: number,
  environment?: WildlifeAnyEnvironment,
): string {
  const altitude = group.altitude ? `${group.altitude.minM},${group.altitude.maxM}` : "default";
  return [
    group.id,
    group.species,
    group.count,
    group.seedOffset,
    group.speedScale,
    group.area.center.join(","),
    group.area.radius,
    altitude,
    worldSeed,
    groundHeight,
    wildlifeEnvironmentKey(group.species, environment),
  ].join("|");
}

/** True when the render layer must throw away `sim` and create a fresh one. */
export function shouldRecreateWildlifeSim(
  sim: WildlifeSim,
  group: DirectorWorldWildlifeGroup,
  worldSeed: number,
  groundHeight: number,
  environment?: WildlifeAnyEnvironment,
): boolean {
  return sim.configKey !== wildlifeSimConfigKey(group, worldSeed, groundHeight, environment);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface CheckpointSlot {
  tick: number;
  rngState: number;
  arrays: Float32Array[];
}

function wrapAngle(angle: number): number {
  let wrapped = angle % TWO_PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  else if (wrapped < -Math.PI) wrapped += TWO_PI;
  return wrapped;
}

/**
 * Creates a deterministic wildlife simulation for a group.
 *
 * All state lives in preallocated SoA typed arrays; stepping performs zero
 * allocations. The sim is a pure function of (group config, world seed,
 * groundHeight, environment settings, quantized tick) — no three.js, no
 * scene, no DOM. Per-tick wind is re-derived from the authored settings via
 * the shared gust model, never sampled from the frame, so seeks replay the
 * exact same wind history as continuous playback.
 *
 * @param group - The wildlife group configuration from the world system.
 * @param worldSeed - The world-level seed for deterministic RNG.
 * @param groundHeight - Flat ground-plane Y for the sim (terrain is applied in render).
 * @param environment - Authored wind + weather settings (defaults to calm/clear).
 * @returns A WildlifeSim ready to stepTo any target time.
 */
export function createWildlifeSim(
  group: DirectorWorldWildlifeGroup,
  worldSeed: number,
  groundHeight: number,
  environment?: WildlifeAnyEnvironment,
): WildlifeSim {
  const authoredEnvironment = resolveAuthoredEnvironment(environment);
  const config = resolveSimConfig(group, groundHeight, authoredEnvironment);
  const configKey = wildlifeSimConfigKey(group, worldSeed, groundHeight, environment);
  const n = config.count;
  const rng = createWildlifeRng(hashCombine(worldSeed, group.seedOffset, worldStreamId(group.id)));
  // Per-tick wind scratch (allocation-free) and the wolves' pack anchor
  // phase, both derived deterministically from config/seed.
  const windScratch: [number, number, number] = [0, 0, 0];
  const packAnchorPhase =
    (hashUint32(hashCombine(worldSeed, group.seedOffset, worldStreamId(group.id), 0x9e77)) / 4_294_967_296) * TWO_PI;

  // Environment resolution (constants for the sim's lifetime). The richer
  // per-tick couplings only activate for the settings-backed environment
  // shape; a legacy wind+weather snapshot keeps today's behavior bit-exact.
  const simEnvironment = environment && isWildlifeSimEnvironment(environment) ? environment : undefined;
  const envSettings = simEnvironment?.settings;
  const windDriftFactor =
    config.archetype === "flock" && envSettings ? (WILDLIFE_WIND_DRIFT_FACTOR[config.species] ?? 0) : 0;
  const windHeadingFactor =
    config.archetype === "flock" && envSettings ? (WILDLIFE_WIND_HEADING_FACTOR[config.species] ?? 0) : 0;
  const respondsToStorm =
    envSettings !== undefined &&
    (config.archetype === "flock" || (config.archetype === "herd" && config.species !== "wolves"));
  // First authored water rectangle confines the school (previz-level).
  const waterRect = config.archetype === "school" ? simEnvironment?.waterRects?.[0] : undefined;
  const waterRectCos = waterRect ? Math.cos((-waterRect.rotationDegrees * Math.PI) / 180) : 1;
  const waterRectSin = waterRect ? Math.sin((-waterRect.rotationDegrees * Math.PI) / 180) : 0;
  const waterHalfX = waterRect ? Math.max(0.5, waterRect.sizeX / 2 - 0.4) : 0;
  const waterHalfZ = waterRect ? Math.max(0.5, waterRect.sizeZ / 2 - 0.4) : 0;
  const predatorZones =
    config.archetype === "herd" && WILDLIFE_PREY_SPECIES.has(config.species)
      ? (simEnvironment?.predatorZones ?? [])
      : [];

  // Per-tick environment sample, evaluated inside step() from the quantized
  // tick (pure function of tick — replay-safe).
  const envWindScratch: [number, number, number] = [0, 0, 0];
  let envWindX = 0;
  let envWindZ = 0;
  let envStorm = 0;

  const needsWind = windDriftFactor > 0 || windHeadingFactor > 0;

  function evaluateEnvironmentTick(tick: number): void {
    if (!envSettings) return;
    const seconds = tick * DT;
    const needsSchedule = respondsToStorm || needsWind;
    if (!needsSchedule) return;
    const evolving = isWorldWeatherEvolving(envSettings);
    const schedule = evolving ? evaluateWorldClimateSchedule(envSettings, seconds) : null;
    if (respondsToStorm) {
      const base = schedule
        ? blendWorldPresetScalar(STORM_FACTOR_BY_PRESET, schedule)
        : STORM_FACTOR_BY_PRESET[envSettings.weather.preset];
      envStorm = base * Math.min(1, Math.max(0, envSettings.weather.intensity));
    }
    if (needsWind) {
      writeWorldWindVector(envWindScratch, envSettings.wind, seconds);
      // Static mode keeps the authored wind (gain 1) to match the rest of the
      // world; an evolving cycle applies the blended node gain.
      const gain = schedule ? blendWorldPresetScalar(WIND_GAIN_BY_PRESET, schedule) : 1;
      envWindX = envWindScratch[0] * gain;
      envWindZ = envWindScratch[2] * gain;
    }
  }

  // Live SoA state -----------------------------------------------------------
  const posX = new Float32Array(n);
  const posY = new Float32Array(n);
  const posZ = new Float32Array(n);
  const velX = new Float32Array(n);
  const velY = new Float32Array(n);
  const velZ = new Float32Array(n);
  const heading = new Float32Array(n);
  const behaviorState = new Float32Array(n);
  const behaviorTimer = new Float32Array(n);
  const targetX = new Float32Array(n);
  const targetZ = new Float32Array(n);
  const speedCur = new Float32Array(n);
  const grazeBlend = new Float32Array(n);
  const phase = new Float32Array(n); // immutable after spawn — excluded from checkpoints

  // Scratch accumulators (Float64 to keep neighbor sums in double precision).
  const accSepX = new Float64Array(n);
  const accSepY = new Float64Array(n);
  const accSepZ = new Float64Array(n);
  const accAliX = new Float64Array(n);
  const accAliY = new Float64Array(n);
  const accAliZ = new Float64Array(n);
  const accCohX = new Float64Array(n);
  const accCohY = new Float64Array(n);
  const accCohZ = new Float64Array(n);
  const neighborCount = new Float64Array(n);

  // Spatial hash + candidate scratch, preallocated so stepping never
  // allocates. Cell size equals the largest interaction radius, so a
  // one-cell neighborhood always covers every in-range candidate.
  const spatialHash = createWildlifeSpatialHash(
    n,
    config.archetype === "herd"
      ? config.herdSeparationRadius
      : Math.max(config.neighborRadius, config.separationRadius),
  );
  const neighborScratch = new Int32Array(n);

  // Previous-tick copies exposed to the render layer for interpolation.
  const prevPosX = new Float32Array(n);
  const prevPosY = new Float32Array(n);
  const prevPosZ = new Float32Array(n);
  const prevVelX = new Float32Array(n);
  const prevVelY = new Float32Array(n);
  const prevVelZ = new Float32Array(n);
  const prevHeading = new Float32Array(n);
  const prevBehaviorState = new Float32Array(n);
  const prevGrazeBlend = new Float32Array(n);

  /**
   * Every mutable array a step can touch. Flock/school steering never writes
   * the herd behavior arrays (they stay at their spawn values), so their
   * checkpoints only carry pos+vel — roughly half the memory of a herd slot.
   */
  const mutableArrays: Float32Array[] =
    config.archetype === "herd"
      ? [
          posX,
          posY,
          posZ,
          velX,
          velY,
          velZ,
          heading,
          behaviorState,
          behaviorTimer,
          targetX,
          targetZ,
          speedCur,
          grazeBlend,
        ]
      : [posX, posY, posZ, velX, velY, velZ];

  const makeSlot = (): CheckpointSlot => ({
    tick: -1,
    rngState: 0,
    arrays: mutableArrays.map((array) => new Float32Array(array.length)),
  });
  // Preallocated up front so stepping (including checkpoint stores) never allocates.
  const ringSlots: CheckpointSlot[] = Array.from({ length: WILDLIFE_MAX_CHECKPOINTS }, makeSlot);
  const zeroSlot = makeSlot();

  let simTick = 0;
  let prevTick = -1;
  let lastAlpha = 0;

  function storeCheckpoint(slot: CheckpointSlot): void {
    slot.tick = simTick;
    slot.rngState = rng.getState();
    for (let index = 0; index < mutableArrays.length; index += 1) {
      slot.arrays[index].set(mutableArrays[index]);
    }
  }

  function restoreCheckpoint(slot: CheckpointSlot): void {
    for (let index = 0; index < mutableArrays.length; index += 1) {
      mutableArrays[index].set(slot.arrays[index]);
    }
    rng.setState(slot.rngState);
    simTick = slot.tick;
    prevTick = -1; // prev copies are stale until the next stepTo refills them
  }

  /**
   * Newest checkpoint at or before `tick`. The dedicated tick-0 slot always
   * qualifies, so lookup never fails; ring entries ahead of the current sim
   * tick stay valid too (the trajectory is deterministic, so previously
   * simulated futures can be jumped to directly).
   */
  function bestCheckpointAtMost(tick: number): CheckpointSlot {
    let best = zeroSlot;
    for (let index = 0; index < ringSlots.length; index += 1) {
      const slot = ringSlots[index];
      if (slot.tick >= 0 && slot.tick <= tick && slot.tick > best.tick) best = slot;
    }
    return best;
  }

  // --- Spawn -----------------------------------------------------------------

  function spawn(): void {
    const { centerX, centerZ, radius } = config;
    for (let i = 0; i < n; i += 1) {
      if (config.archetype === "herd") {
        const angle = rng.next() * TWO_PI;
        const dist = radius * 0.7 * Math.sqrt(rng.next());
        posX[i] = centerX + Math.sin(angle) * dist;
        posZ[i] = centerZ + Math.cos(angle) * dist;
        posY[i] = config.groundY;
        heading[i] = rng.next() * TWO_PI;
        phase[i] = rng.next() * TWO_PI;
        behaviorState[i] = WILDLIFE_BEHAVIOR_GRAZE;
        behaviorTimer[i] = 0.5 + rng.next() * 4; // staggered first transitions
        targetX[i] = posX[i];
        targetZ[i] = posZ[i];
        speedCur[i] = 0;
        grazeBlend[i] = 1;
        velX[i] = 0;
        velY[i] = 0;
        velZ[i] = 0;
      } else {
        const angle = rng.next() * TWO_PI;
        const dist = radius * 0.6 * Math.sqrt(rng.next());
        const yMix = rng.next();
        const velYaw = rng.next() * TWO_PI;
        const velPitch = (rng.next() - 0.5) * 0.5;
        phase[i] = rng.next() * TWO_PI;
        posX[i] = centerX + Math.sin(angle) * dist;
        posZ[i] = centerZ + Math.cos(angle) * dist;
        posY[i] =
          config.archetype === "school"
            ? config.bandHardMaxY - Math.min(0.1, config.radius * 0.1) - yMix * config.radius * 0.5
            : config.bandMinY + (config.bandMaxY - config.bandMinY) * yMix;
        const cosPitch = Math.cos(velPitch);
        velX[i] = Math.sin(velYaw) * cosPitch * config.cruise;
        velY[i] = Math.sin(velPitch) * config.cruise;
        velZ[i] = Math.cos(velYaw) * cosPitch * config.cruise;
        heading[i] = velYaw;
        behaviorState[i] = WILDLIFE_BEHAVIOR_WALK;
        behaviorTimer[i] = 0;
        targetX[i] = posX[i];
        targetZ[i] = posZ[i];
        speedCur[i] = config.cruise;
        grazeBlend[i] = 0;
      }
    }
  }

  // --- Boids step (flock + school) -------------------------------------------

  function stepBoids(): void {
    const {
      centerX,
      centerY,
      centerZ,
      radius,
      cruise,
      neighborRadius,
      separationRadius,
      alignWeight,
      cohesionWeight,
      separationWeight,
      containAccel,
      maxAccel,
      flutterAccel,
      wanderAccel,
      layerAccel,
      flockVerticalFactor,
      windBiasAccel,
    } = config;
    const isSchool = config.archetype === "school";
    const neighborR2 = neighborRadius * neighborRadius;
    const separationR2 = separationRadius * separationRadius;
    const softRadius = radius * SOFT_CONTAINMENT_SCALE;
    const hardRadius = radius * HARD_CONTAINMENT_SCALE;
    const bandSpan = config.bandMaxY - config.bandMinY;
    const bandEdge = Math.max(bandSpan * 0.2, 0.1);
    const stateSeconds = simTick * DT;
    // Storms press flocks toward the bottom of their flight band (soft
    // springs only; the hard band clamp stays authored).
    const stormBandTop = config.bandMaxY - envStorm * WILDLIFE_STORM_BAND_DROP * (config.bandMaxY - config.bandMinY);
    // Air-mass advection per tick (pure function of the quantized tick):
    // fliers get carried by a fraction of the wind on top of their steering.
    const windAdvectX = envWindX * windDriftFactor;
    const windAdvectZ = envWindZ * windDriftFactor;

    // Downwind steering bias: the shared gust model evaluated at the tick's
    // own time, so replay from a checkpoint sees the identical wind history.
    // Only the legacy wind+weather environment path uses it — a settings-
    // backed environment owns the wind response through the per-tick climate
    // couplings (drift/heading) above, and applying both would double-count
    // the same authored wind.
    let windAx = 0;
    let windAz = 0;
    if (windBiasAccel > 0 && !needsWind) {
      writeWorldWindVector(windScratch, authoredEnvironment.wind, stateSeconds);
      windAx = windScratch[0] * windBiasAccel;
      windAz = windScratch[2] * windBiasAccel;
    }

    // Phase 1: per-agent neighbor gather against the pre-step snapshot. The
    // spatial hash is rebuilt from pre-step positions and every agent's
    // accumulators are filled before any integration, so the update stays
    // synchronous (reads never observe this tick's writes).
    spatialHash.rebuild(posX, posY, posZ, n);
    for (let i = 0; i < n; i += 1) {
      const pix = posX[i];
      const piy = posY[i];
      const piz = posZ[i];
      let sepX = 0;
      let sepY = 0;
      let sepZ = 0;
      let aliX = 0;
      let aliY = 0;
      let aliZ = 0;
      let cohX = 0;
      let cohY = 0;
      let cohZ = 0;
      let neighbors = 0;
      const candidates = spatialHash.collectNeighbors(pix, piy, piz, neighborScratch);
      for (let c = 0; c < candidates; c += 1) {
        const j = neighborScratch[c];
        if (j === i) continue;
        const dx = posX[j] - pix;
        const dy = posY[j] - piy;
        const dz = posZ[j] - piz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > neighborR2) continue;
        aliX += velX[j];
        aliY += velY[j];
        aliZ += velZ[j];
        cohX += posX[j];
        cohY += posY[j];
        cohZ += posZ[j];
        neighbors += 1;
        if (d2 < separationR2 && d2 > 1e-9) {
          const inv = 1 / d2;
          sepX -= dx * inv;
          sepY -= dy * inv;
          sepZ -= dz * inv;
        }
      }
      accSepX[i] = sepX;
      accSepY[i] = sepY;
      accSepZ[i] = sepZ;
      accAliX[i] = aliX;
      accAliY[i] = aliY;
      accAliZ[i] = aliZ;
      accCohX[i] = cohX;
      accCohY[i] = cohY;
      accCohZ[i] = cohZ;
      neighborCount[i] = neighbors;
    }

    // Phase 2: integrate.
    for (let i = 0; i < n; i += 1) {
      let px = posX[i];
      let py = posY[i];
      let pz = posZ[i];
      let vx = velX[i];
      let vy = velY[i];
      let vz = velZ[i];

      let ax = accSepX[i] * separationWeight;
      let ay = accSepY[i] * separationWeight;
      let az = accSepZ[i] * separationWeight;
      const neighbors = neighborCount[i];
      if (neighbors > 0) {
        const inv = 1 / neighbors;
        ax += (accAliX[i] * inv - vx) * alignWeight;
        ay += (accAliY[i] * inv - vy) * alignWeight * flockVerticalFactor;
        az += (accAliZ[i] * inv - vz) * alignWeight;
        ax += (accCohX[i] * inv - px) * cohesionWeight;
        ay += (accCohY[i] * inv - py) * cohesionWeight * flockVerticalFactor;
        az += (accCohZ[i] * inv - pz) * cohesionWeight;
      }

      // Containment steering toward the area center.
      if (isSchool) {
        const ox = px - centerX;
        const oy = py - centerY;
        const oz = pz - centerZ;
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (dist > softRadius && dist > 1e-6) {
          const excess = Math.min((dist - softRadius) / Math.max(radius - softRadius, 1e-6), 1.5);
          const pull = containAccel * excess * excess;
          ax -= (ox / dist) * pull;
          ay -= (oy / dist) * pull;
          az -= (oz / dist) * pull;
        }
        // Soft ceiling below the water surface.
        if (py > config.bandMaxY) ay -= containAccel * Math.min((py - config.bandMaxY) / bandEdge, 1.5);
      } else {
        const ox = px - centerX;
        const oz = pz - centerZ;
        const dist = Math.sqrt(ox * ox + oz * oz);
        if (dist > softRadius && dist > 1e-6) {
          const excess = Math.min((dist - softRadius) / Math.max(radius - softRadius, 1e-6), 1.5);
          const pull = containAccel * excess * excess;
          ax -= (ox / dist) * pull;
          az -= (oz / dist) * pull;
        }
        // Altitude band springs (storms lower the effective ceiling).
        if (py < config.bandMinY + bandEdge) {
          ay += containAccel * Math.min((config.bandMinY + bandEdge - py) / bandEdge, 1.5);
        } else if (py > stormBandTop - bandEdge) {
          ay -= containAccel * Math.min((py - (stormBandTop - bandEdge)) / bandEdge, 1.5);
        }
        // Storm sink presses the whole flock down, not just the ceiling.
        // envStorm is 0 for schools, so this only moves flocks.
        ay -= envStorm * WILDLIFE_STORM_SINK_ACCEL;
      }

      // Butterfly flutter: seeded sine jitter, deterministic in (tick, phase).
      if (flutterAccel > 0) {
        const flutterPhase = phase[i];
        ax += Math.sin(stateSeconds * 5.1 + flutterPhase * 1.7) * flutterAccel;
        ay += Math.sin(stateSeconds * 7.3 + flutterPhase) * flutterAccel * 1.6;
        az += Math.cos(stateSeconds * 4.3 + flutterPhase * 2.3) * flutterAccel;
      }

      // Butterfly wander: a slow, per-agent circling drift (much lower
      // frequency than the flutter) that reads as aimless meandering.
      if (wanderAccel > 0) {
        const wanderPhase = phase[i];
        ax += Math.sin(stateSeconds * 0.83 + wanderPhase * 3.7) * wanderAccel;
        az += Math.cos(stateSeconds * 0.67 + wanderPhase * 2.9) * wanderAccel;
      }

      // Bird layering: every agent holds a preferred slice of the altitude
      // band (a pure function of its immutable phase), so the flock stacks
      // into visible strata instead of collapsing onto one plane.
      if (layerAccel > 0) {
        const preferredY = config.bandMinY + bandSpan * (0.1 + 0.8 * (phase[i] / TWO_PI));
        const normalized = (preferredY - py) / Math.max(bandSpan * 0.25, 0.5);
        ay += Math.min(Math.max(normalized, -1), 1) * layerAccel;
      }

      // Downwind bias (weather-scaled): storms visibly push fliers along.
      ax += windAx;
      az += windAz;

      // Active fliers additionally lean downwind with the evaluated climate
      // wind: an acceleration bias that turns the flock with the wind while
      // speed regulation keeps the cruise envelope.
      if (windHeadingFactor > 0) {
        ax += envWindX * windHeadingFactor;
        az += envWindZ * windHeadingFactor;
      }

      const accel2 = ax * ax + ay * ay + az * az;
      if (accel2 > maxAccel * maxAccel) {
        const scale = maxAccel / Math.sqrt(accel2);
        ax *= scale;
        ay *= scale;
        az *= scale;
      }

      vx += ax * DT;
      vy += ay * DT;
      vz += az * DT;

      // Speed regulation: clamp into [0.5, 1.5] × cruise, then relax toward cruise.
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed < 1e-4) {
        // Deterministic recovery from a degenerate stall: head out by phase.
        vx = Math.sin(phase[i]) * cruise;
        vy = 0;
        vz = Math.cos(phase[i]) * cruise;
      } else {
        let targetSpeed = Math.min(Math.max(speed, cruise * 0.5), cruise * 1.5);
        targetSpeed += (cruise - targetSpeed) * 0.06;
        const scale = targetSpeed / speed;
        vx *= scale;
        vy *= scale;
        vz *= scale;
      }

      px += (vx + windAdvectX) * DT;
      py += vy * DT;
      pz += (vz + windAdvectZ) * DT;

      // Hard clamps guarantee the containment contract regardless of tuning.
      if (isSchool) {
        const ox = px - centerX;
        const oy = py - centerY;
        const oz = pz - centerZ;
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (dist > hardRadius) {
          const scale = hardRadius / dist;
          px = centerX + ox * scale;
          py = centerY + oy * scale;
          pz = centerZ + oz * scale;
          const radialDot = (vx * ox + vy * oy + vz * oz) / dist;
          if (radialDot > 0) {
            vx -= (radialDot * ox) / dist;
            vy -= (radialDot * oy) / dist;
            vz -= (radialDot * oz) / dist;
          }
        }
        if (py > config.bandHardMaxY) {
          py = config.bandHardMaxY;
          if (vy > 0) vy = 0;
        }
        // Authored water rectangle: fish never leave the basin footprint.
        // Clamp in the rect's local frame (rotation-aware) after all other
        // constraints so the guarantee is unconditional.
        if (waterRect) {
          const ox = px - waterRect.centerX;
          const oz = pz - waterRect.centerZ;
          let localX = ox * waterRectCos - oz * waterRectSin;
          let localZ = ox * waterRectSin + oz * waterRectCos;
          if (localX < -waterHalfX || localX > waterHalfX || localZ < -waterHalfZ || localZ > waterHalfZ) {
            localX = Math.min(waterHalfX, Math.max(-waterHalfX, localX));
            localZ = Math.min(waterHalfZ, Math.max(-waterHalfZ, localZ));
            // Inverse rotation (transpose) back to world space.
            px = waterRect.centerX + localX * waterRectCos + localZ * waterRectSin;
            pz = waterRect.centerZ - localX * waterRectSin + localZ * waterRectCos;
          }
        }
      } else {
        const ox = px - centerX;
        const oz = pz - centerZ;
        const dist = Math.sqrt(ox * ox + oz * oz);
        if (dist > hardRadius) {
          const scale = hardRadius / dist;
          px = centerX + ox * scale;
          pz = centerZ + oz * scale;
          const radialDot = (vx * ox + vz * oz) / dist;
          if (radialDot > 0) {
            vx -= (radialDot * ox) / dist;
            vz -= (radialDot * oz) / dist;
          }
        }
        if (py < config.bandHardMinY) {
          py = config.bandHardMinY;
          if (vy < 0) vy = 0;
        } else if (py > config.bandHardMaxY) {
          py = config.bandHardMaxY;
          if (vy > 0) vy = 0;
        }
      }

      posX[i] = px;
      posY[i] = py;
      posZ[i] = pz;
      velX[i] = vx;
      velY[i] = vy;
      velZ[i] = vz;
    }
  }

  // --- Herd step ---------------------------------------------------------------

  /**
   * Wolves' shared prowl anchor: a point orbiting the area centre, a pure
   * function of the tick. Walk/chase targets pull toward it so the pack roves
   * together with a common direction instead of milling around the centre.
   * `leadSeconds` aims ahead of the orbit — chase lopes pursue that lead
   * point like a quarry.
   */
  function packAnchorX(leadSeconds: number): number {
    const anchorAngle = packAnchorPhase + (simTick * DT + leadSeconds) * PACK_ANCHOR_RAD_PER_S;
    return config.centerX + Math.sin(anchorAngle) * config.radius * 0.5 * config.packPull * config.weatherClusterFactor;
  }

  function packAnchorZ(leadSeconds: number): number {
    const anchorAngle = packAnchorPhase + (simTick * DT + leadSeconds) * PACK_ANCHOR_RAD_PER_S;
    return config.centerZ + Math.cos(anchorAngle) * config.radius * 0.5 * config.packPull * config.weatherClusterFactor;
  }

  function pickWalkTarget(i: number): void {
    const angle = rng.next() * TWO_PI;
    // Species spread scale keeps sheep knotted near the anchor while deer
    // range wide; bad weather shrinks the roaming ring further (clustering).
    const dist = config.radius * (0.12 + 0.68 * rng.next()) * config.walkRadiusScale * config.weatherClusterFactor;
    const anchorX = config.packPull > 0 ? packAnchorX(0) : config.centerX;
    const anchorZ = config.packPull > 0 ? packAnchorZ(0) : config.centerZ;
    targetX[i] = anchorX + Math.sin(angle) * dist;
    targetZ[i] = anchorZ + Math.cos(angle) * dist;
    behaviorTimer[i] = 4 + 6 * rng.next();
  }

  function pickRegroupTarget(i: number): void {
    const angle = rng.next() * TWO_PI;
    const dist = config.radius * 0.25 * rng.next();
    targetX[i] = config.centerX + Math.sin(angle) * dist;
    targetZ[i] = config.centerZ + Math.cos(angle) * dist;
    behaviorTimer[i] = 8 + 4 * rng.next();
  }

  /** Sprint burst: rabbit dash from the current spot, or a wolf chase lope. */
  function pickSprintTarget(i: number, px: number, pz: number): void {
    const angle = rng.next() * TWO_PI;
    const dash = config.radius * (0.15 + 0.25 * rng.next());
    if (config.packPull > 0) {
      // Chase the pack anchor's lead point (with a little scatter) so
      // several wolves lope the same way — reads as pursuit, not panic.
      targetX[i] = packAnchorX(15) + Math.sin(angle) * dash * 0.3;
      targetZ[i] = packAnchorZ(15) + Math.cos(angle) * dash * 0.3;
    } else {
      targetX[i] = px + Math.sin(angle) * dash;
      targetZ[i] = pz + Math.cos(angle) * dash;
    }
    behaviorTimer[i] = config.sprintMinS + (config.sprintMaxS - config.sprintMinS) * rng.next();
  }

  /** Startle bolt: outward from the herd centre with bearing jitter. */
  function pickFleeTarget(i: number, px: number, pz: number): void {
    const outward = Math.atan2(px - config.centerX, pz - config.centerZ);
    const bearing = outward + (rng.next() - 0.5) * 1.2;
    const dash = config.radius * (0.3 + 0.3 * rng.next());
    targetX[i] = px + Math.sin(bearing) * dash;
    targetZ[i] = pz + Math.cos(bearing) * dash;
    behaviorTimer[i] = config.fleeMinS + (config.fleeMaxS - config.fleeMinS) * rng.next();
  }

  /** Graze pause draw, stretched by bad weather (animals hunker down). */
  function drawGrazeTimer(minS: number, maxS: number): number {
    return (minS + (maxS - minS) * rng.next()) * config.weatherGrazeScale;
  }

  function stepHerd(): void {
    const { centerX, centerZ, radius, cruise, turnRate, accel, herdSeparationRadius } = config;
    const separationR2 = herdSeparationRadius * herdSeparationRadius;
    const hardRadius = radius * HARD_CONTAINMENT_SCALE;
    const containTrigger2 = radius * 0.95 * (radius * 0.95);
    const regroupDone2 = radius * 0.4 * (radius * 0.4);

    // Separation gather via the 2D spatial hash (herds live on the ground
    // plane, so agents hash on (x, z) only). All accumulators fill before the
    // integration loop below mutates positions — synchronous update.
    spatialHash.rebuild(posX, null, posZ, n);
    for (let i = 0; i < n; i += 1) {
      const pix = posX[i];
      const piz = posZ[i];
      let sepX = 0;
      let sepZ = 0;
      const candidates = spatialHash.collectNeighbors(pix, 0, piz, neighborScratch);
      for (let c = 0; c < candidates; c += 1) {
        const j = neighborScratch[c];
        if (j === i) continue;
        const dx = posX[j] - pix;
        const dz = posZ[j] - piz;
        const d2 = dx * dx + dz * dz;
        if (d2 > separationR2 || d2 < 1e-9) continue;
        const inv = 1 / d2;
        sepX -= dx * inv;
        sepZ -= dz * inv;
      }
      accSepX[i] = sepX;
      accSepZ[i] = sepZ;
    }

    for (let i = 0; i < n; i += 1) {
      let px = posX[i];
      let pz = posZ[i];
      let state = behaviorState[i];
      behaviorTimer[i] -= DT;

      const offCenterX = px - centerX;
      const offCenterZ = pz - centerZ;
      const centerDist2 = offCenterX * offCenterX + offCenterZ * offCenterZ;

      // Transitions. RNG is consumed only here, in fixed agent order, so the
      // draw sequence is a pure function of the replayed trajectory.
      if (centerDist2 > containTrigger2 && state !== WILDLIFE_BEHAVIOR_REGROUP) {
        state = WILDLIFE_BEHAVIOR_REGROUP;
        pickRegroupTarget(i);
      } else if (state === WILDLIFE_BEHAVIOR_GRAZE) {
        if (behaviorTimer[i] <= 0) {
          // Species character: sheep may startle, rabbits dash, wolves lope
          // after the pack anchor; everyone else just walks. One roll per
          // graze exit keeps the draw pattern state-driven and replay-safe.
          const roll = rng.next();
          if (roll < config.fleeProbability) {
            state = WILDLIFE_BEHAVIOR_FLEE;
            pickFleeTarget(i, px, pz);
          } else if (roll < config.fleeProbability + config.sprintProbability) {
            state = WILDLIFE_BEHAVIOR_SPRINT;
            pickSprintTarget(i, px, pz);
          } else {
            state = WILDLIFE_BEHAVIOR_WALK;
            pickWalkTarget(i);
          }
        }
      } else if (state === WILDLIFE_BEHAVIOR_WALK) {
        const toTargetX = targetX[i] - px;
        const toTargetZ = targetZ[i] - pz;
        const arrived = toTargetX * toTargetX + toTargetZ * toTargetZ < 0.64;
        if (arrived || behaviorTimer[i] <= 0) {
          state = WILDLIFE_BEHAVIOR_GRAZE;
          behaviorTimer[i] = drawGrazeTimer(config.grazeMinS, config.grazeMaxS);
        }
      } else if (state === WILDLIFE_BEHAVIOR_SPRINT) {
        const toTargetX = targetX[i] - px;
        const toTargetZ = targetZ[i] - pz;
        const arrived = toTargetX * toTargetX + toTargetZ * toTargetZ < 1;
        if (arrived || behaviorTimer[i] <= 0) {
          state = WILDLIFE_BEHAVIOR_GRAZE; // catch breath after the burst
          behaviorTimer[i] = drawGrazeTimer(config.grazeMinS, config.grazeMaxS);
        }
      } else if (state === WILDLIFE_BEHAVIOR_FLEE) {
        if (behaviorTimer[i] <= 0) {
          state = WILDLIFE_BEHAVIOR_REGROUP; // startle resolves into a regroup
          pickRegroupTarget(i);
        }
      } else if (centerDist2 < regroupDone2) {
        state = WILDLIFE_BEHAVIOR_GRAZE;
        behaviorTimer[i] = drawGrazeTimer(1, 3);
      } else if (behaviorTimer[i] <= 0) {
        pickRegroupTarget(i);
      }

      // Desired direction: normalized target bearing plus separation push.
      let dirX = 0;
      let dirZ = 0;
      if (state !== WILDLIFE_BEHAVIOR_GRAZE) {
        const toTargetX = targetX[i] - px;
        const toTargetZ = targetZ[i] - pz;
        const dist = Math.sqrt(toTargetX * toTargetX + toTargetZ * toTargetZ);
        if (dist > 1e-6) {
          dirX = toTargetX / dist;
          dirZ = toTargetZ / dist;
        }
      }
      dirX += accSepX[i] * 0.8;
      dirZ += accSepZ[i] * 0.8;

      // Predator avoidance: steer away from overlapping wolf territories and
      // keep moving while inside one (mild previz flight, no RNG involved).
      let insidePredatorZone = false;
      for (let zoneIndex = 0; zoneIndex < predatorZones.length; zoneIndex += 1) {
        const zone = predatorZones[zoneIndex];
        const awayX = px - zone.x;
        const awayZ = pz - zone.z;
        const avoidRadius = zone.radius + WILDLIFE_PREDATOR_AVOID_MARGIN_M;
        const away2 = awayX * awayX + awayZ * awayZ;
        if (away2 >= avoidRadius * avoidRadius) continue;
        insidePredatorZone = true;
        const away = Math.sqrt(Math.max(away2, 1e-6));
        const weight = PREDATOR_AVOID_WEIGHT * (1 - away / avoidRadius);
        dirX += (awayX / away) * weight;
        dirZ += (awayZ / away) * weight;
      }

      // Burst states commit harder: doubled turn-in and acceleration so a
      // dash or startle reads as an impulse rather than a gentle lane change.
      const burst = state === WILDLIFE_BEHAVIOR_SPRINT || state === WILDLIFE_BEHAVIOR_FLEE ? 2 : 1;

      // Turn-rate-limited heading keeps motion animal-like (no pivoting).
      let yaw = heading[i];
      if (dirX * dirX + dirZ * dirZ > 1e-8) {
        const desiredYaw = Math.atan2(dirX, dirZ);
        const delta = wrapAngle(desiredYaw - yaw);
        const maxTurn = turnRate * burst * DT;
        yaw = wrapAngle(yaw + Math.min(Math.max(delta, -maxTurn), maxTurn));
      }

      const speedMult =
        state === WILDLIFE_BEHAVIOR_GRAZE
          ? 0
          : state === WILDLIFE_BEHAVIOR_REGROUP
            ? 1.25
            : state === WILDLIFE_BEHAVIOR_SPRINT
              ? config.sprintSpeedMult
              : state === WILDLIFE_BEHAVIOR_FLEE
                ? config.fleeSpeedMult
                : 1;
      // Bad weather slows every beast except apex predators (storm at full
      // intensity ≈ half speed; wolves keep weatherSpeedFactor = 1).
      let targetSpeed = cruise * speedMult * config.weatherSpeedFactor;
      // Prey inside a wolf territory keeps walking out instead of grazing.
      if (insidePredatorZone) targetSpeed = Math.max(targetSpeed, cruise * 1.1);
      // Evolving-climate storms slow grazing herds further (envStorm stays 0
      // for wolves and for legacy wind+weather environments).
      targetSpeed *= 1 - WILDLIFE_STORM_HERD_SLOWDOWN * envStorm;
      let speed = speedCur[i];
      const speedDelta = targetSpeed - speed;
      const maxSpeedStep = accel * burst * DT;
      speed += Math.min(Math.max(speedDelta, -maxSpeedStep), maxSpeedStep);

      const vx = Math.sin(yaw) * speed;
      const vz = Math.cos(yaw) * speed;
      px += vx * DT;
      pz += vz * DT;

      // Hard containment: project back onto the allowed disc.
      const ox = px - centerX;
      const oz = pz - centerZ;
      const dist = Math.sqrt(ox * ox + oz * oz);
      if (dist > hardRadius) {
        const scale = hardRadius / dist;
        px = centerX + ox * scale;
        pz = centerZ + oz * scale;
      }

      const grazeTarget = state === WILDLIFE_BEHAVIOR_GRAZE ? 1 : 0;
      const blendDelta = grazeTarget - grazeBlend[i];
      const maxBlendStep = 2.5 * DT;
      grazeBlend[i] += Math.min(Math.max(blendDelta, -maxBlendStep), maxBlendStep);

      posX[i] = px;
      posY[i] = config.groundY;
      posZ[i] = pz;
      velX[i] = vx;
      velY[i] = 0;
      velZ[i] = vz;
      heading[i] = yaw;
      behaviorState[i] = state;
      speedCur[i] = speed;
    }
  }

  // --- Tick machinery ------------------------------------------------------------

  function step(): void {
    evaluateEnvironmentTick(simTick);
    if (config.archetype === "herd") stepHerd();
    else stepBoids();
    simTick += 1;
    if (simTick % WILDLIFE_CHECKPOINT_INTERVAL_TICKS === 0) {
      const slotIndex = (simTick / WILDLIFE_CHECKPOINT_INTERVAL_TICKS) % WILDLIFE_MAX_CHECKPOINTS;
      storeCheckpoint(ringSlots[slotIndex]);
    }
  }

  function copyLiveToPrev(): void {
    prevPosX.set(posX);
    prevPosY.set(posY);
    prevPosZ.set(posZ);
    prevVelX.set(velX);
    prevVelY.set(velY);
    prevVelZ.set(velZ);
    prevHeading.set(heading);
    prevBehaviorState.set(behaviorState);
    prevGrazeBlend.set(grazeBlend);
    prevTick = simTick;
  }

  // Spawn, snapshot tick 0, and pre-step one lookahead tick so readState()
  // is valid (tick 0) before the first stepTo call.
  spawn();
  storeCheckpoint(zeroSlot);
  copyLiveToPrev();
  step();

  const prevView: WildlifeSimStateView = {
    count: n,
    tick: prevTick,
    posX: prevPosX,
    posY: prevPosY,
    posZ: prevPosZ,
    velX: prevVelX,
    velY: prevVelY,
    velZ: prevVelZ,
    heading: prevHeading,
    behaviorState: prevBehaviorState,
    grazeBlend: prevGrazeBlend,
    phase,
  };
  const currView: WildlifeSimStateView = {
    count: n,
    tick: simTick,
    posX,
    posY,
    posZ,
    velX,
    velY,
    velZ,
    heading,
    behaviorState,
    grazeBlend,
    phase,
  };
  const renderView: WildlifeSimRenderView = { count: n, alpha: 0, prev: prevView, curr: currView };

  function stepTo(targetSeconds: number): void {
    const seconds = Number.isFinite(targetSeconds) ? Math.max(0, targetSeconds) : 0;
    const canonicalTick = Math.floor(seconds * HZ);
    lastAlpha = Math.min(1, Math.max(0, seconds * HZ - canonicalTick));
    if (prevTick === canonicalTick && simTick === canonicalTick + 1) return;

    if (simTick > canonicalTick) {
      restoreCheckpoint(bestCheckpointAtMost(canonicalTick));
    } else {
      // Forward jump: a previously stored future checkpoint may be closer.
      const best = bestCheckpointAtMost(canonicalTick);
      if (best.tick > simTick) restoreCheckpoint(best);
    }
    while (simTick < canonicalTick) step();
    copyLiveToPrev();
    step(); // lookahead tick for interpolation
  }

  return {
    configKey,
    archetype: config.archetype,
    species: config.species,
    count: n,
    stepTo,
    readState(): WildlifeSimStateView {
      prevView.tick = prevTick;
      return prevView;
    },
    readRenderState(): WildlifeSimRenderView {
      prevView.tick = prevTick;
      currView.tick = simTick;
      renderView.alpha = lastAlpha;
      return renderView;
    },
  };
}
