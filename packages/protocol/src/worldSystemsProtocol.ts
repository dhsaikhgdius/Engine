import { z } from "zod";

/**
 * Living World systems protocol.
 *
 * A Director project may carry one optional `world` block describing ambient,
 * self-evolving systems: emitter effects (fire/smoke/rain/...), shader water
 * bodies, wildlife groups, and global wind/weather/time-of-day settings.
 *
 * Every runtime consumer must treat this data as the input of a deterministic
 * evaluation: visual state is a pure function of `(seed, worldSeconds)` for
 * stateless layers, or of a seeded fixed-timestep replay for agent systems.
 * Nothing in this block may depend on wall-clock time or unseeded randomness,
 * otherwise deterministic frame export and timeline scrubbing break.
 */

/** Protocol version for the Director World block. */
export const DIRECTOR_WORLD_PROTOCOL_VERSION = 1 as const;

/** Maximum number of effects (emitters) in a world. */
export const DIRECTOR_WORLD_MAX_EFFECTS = 64;
/** Maximum number of water bodies in a world. */
export const DIRECTOR_WORLD_MAX_WATER_BODIES = 8;
/** Maximum number of wildlife groups in a world. */
export const DIRECTOR_WORLD_MAX_WILDLIFE_GROUPS = 16;
/** Maximum number of individual wildlife agents per group. */
export const DIRECTOR_WORLD_MAX_WILDLIFE_COUNT = 256;

/** Fixed simulation tick for stateful world systems (wildlife steering). */
export const DIRECTOR_WORLD_SIMULATION_HZ = 30;

const finite = z.number().finite();
const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(240);
const color = z.string().regex(/^#[0-9a-f]{6}$/i, "must be a six-digit hex color");
const vec3 = z.tuple([
  finite.min(-100_000).max(100_000),
  finite.min(-100_000).max(100_000),
  finite.min(-100_000).max(100_000),
]);
const seed = z.number().int().min(0).max(2_147_483_647);

/** Allowed emitter effect kinds. */
export const WORLD_EFFECT_KINDS = ["fire", "smoke", "steam", "sparks", "fireflies", "dust", "rain", "snow"] as const;
export type WorldEffectKind = (typeof WORLD_EFFECT_KINDS)[number];

/** Optional spatial anchor for world effects and emitters. */
export const worldAnchorSchema = z.strictObject({
  objectId: id.nullable().optional(),
  /** World position when unbound; object-local offset when objectId is present. */
  position: vec3,
});

/** Emitter shape geometry that controls the particle spawn region. */
export const worldEmitterShapeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("point") }),
  z.strictObject({ type: z.literal("sphere"), radius: finite.min(0.01).max(500) }),
  z.strictObject({ type: z.literal("disc"), radius: finite.min(0.01).max(500) }),
  z.strictObject({
    type: z.literal("box"),
    size: z.tuple([finite.min(0.01).max(1_000), finite.min(0.01).max(1_000), finite.min(0.01).max(1_000)]),
  }),
]);

/** Maximum radius of a fire-propagation substrate around its ignition anchor. */
export const DIRECTOR_WORLD_FIRE_MAX_RADIUS_M = 64;

/**
 * Optional deterministic fire spread for `fire` effects.
 *
 * When enabled, the effect's anchor position seeds an integer-state cellular
 * automaton (Unburnt → Igniting → Burning → Burnt) on a coarse ground grid.
 * Spread is wind-biased and wetness-suppressed, runs at the fixed world
 * simulation Hz with checkpointed replay, and burning cells drive stateless
 * view emitters keyed by (cell, ignitionTick). Propagation only supports
 * unbound anchors (`anchor.objectId` null): an anchor tracking an animated
 * object would make ignition history depend on evaluation time.
 */
export const directorWorldFirePropagationSchema = z.strictObject({
  enabled: z.boolean(),
  /** Substrate half-extent around the anchor, metres. */
  radiusM: finite.min(2).max(DIRECTOR_WORLD_FIRE_MAX_RADIUS_M).default(12),
  /** Scales neighbor damage per tick; 1 = default previz spread speed. */
  spreadRate: finite.min(0.1).max(3).default(1),
});

/** A single emitter effect instance in the world. */
export const directorWorldEffectSchema = z.strictObject({
  id,
  name,
  kind: z.enum(WORLD_EFFECT_KINDS),
  anchor: worldAnchorSchema,
  shape: worldEmitterShapeSchema,
  /** 1 = the preset's authored particle rate; 0 disables emission without deleting. */
  intensity: finite.min(0).max(3),
  sizeScale: finite.min(0.1).max(10),
  speedScale: finite.min(0.1).max(10),
  colorTint: color.optional(),
  /** 0 = ignores global wind, 1 = fully advected by it. */
  windInfluence: finite.min(0).max(1),
  /** Deterministic fire spread; only meaningful for kind "fire". Absent = off. */
  propagation: directorWorldFirePropagationSchema.optional(),
  /** Decorrelates otherwise identical emitters; combined with the world seed. */
  seedOffset: z.number().int().min(0).max(65_535),
  visible: z.boolean(),
  locked: z.boolean(),
  createdAt: z.string().datetime(),
});

/** Global wind parameters that advect particles and affect vegetation. */
export const directorWorldWindSchema = z.strictObject({
  /** Meteorological azimuth the wind blows toward, degrees clockwise from +Z (north). */
  directionDegrees: finite.min(0).max(360),
  speedMps: finite.min(0).max(40),
  gustiness: finite.min(0).max(1),
  turbulence: finite.min(0).max(1),
});

/** Time-of-day driver for sun position, sky dome, and ambient lighting. */
export const directorWorldTimeOfDaySchema = z.strictObject({
  mode: z.enum(["fixed", "cycle"]),
  /** Solar hours, 0..24; the fixed value, or the cycle's value at worldSeconds = 0. */
  hours: finite.min(0).max(24),
  /** Real minutes for a full 24h cycle while in `cycle` mode. */
  cycleMinutes: finite.min(0.5).max(240),
  /** When true the sky layer drives sun position, sky dome, and stars. */
  drivesSky: z.boolean(),
});

/** Supported weather presets. */
export const WORLD_WEATHER_PRESETS = ["clear", "overcast", "rain", "snow", "storm"] as const;
export type WorldWeatherPreset = (typeof WORLD_WEATHER_PRESETS)[number];

/** Weather evolution modes: static preserves the authored preset verbatim. */
export const WORLD_WEATHER_EVOLUTION_MODES = ["static", "cycle"] as const;
export type WorldWeatherEvolutionMode = (typeof WORLD_WEATHER_EVOLUTION_MODES)[number];

/** Default seconds per weather segment (hold + transition) in `cycle` mode. */
export const DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS = 300;

/**
 * Optional seeded weather evolution.
 *
 * `static` (and an absent block) preserves today's behavior: the authored
 * preset/intensity/wetness/cloudCover are the runtime values verbatim.
 * `cycle` treats the five presets as nodes of a seeded state machine:
 * transitions ramp the climate parameter vector (cloud cover, precipitation,
 * wind gain, lightning, wetness target) over 30–120 s, and `weather.wetness`
 * becomes the integrator's initial value instead of a constant. Everything is
 * a pure function of (seed, worldSeconds), so scrubbing replays identically.
 */
export const directorWorldWeatherEvolutionSchema = z.strictObject({
  mode: z.enum(WORLD_WEATHER_EVOLUTION_MODES),
  /** Approximate seconds each weather segment lasts in `cycle` mode. */
  periodSeconds: finite.min(60).max(3_600).default(DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS),
});

/** Weather parameters that drive sky visuals, precipitation, and surface wetness. */
export const directorWorldWeatherSchema = z.strictObject({
  preset: z.enum(WORLD_WEATHER_PRESETS),
  /** Scales precipitation density and weather-driven audio/visual intensity. */
  intensity: finite.min(0).max(1),
  /** Surface wetness accumulator; evolution systems may raise/lower it over time. */
  wetness: finite.min(0).max(1),
  cloudCover: finite.min(0).max(1),
  /** Seeded weather evolution; absent = static (authored values verbatim). */
  evolution: directorWorldWeatherEvolutionSchema.optional(),
});

/** Top-level world settings: seed, wind, time-of-day, and weather. */
export const directorWorldSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  seed,
  wind: directorWorldWindSchema,
  timeOfDay: directorWorldTimeOfDaySchema,
  weather: directorWorldWeatherSchema,
});

/** Maximum number of spline control points for a river. */
export const DIRECTOR_WORLD_RIVER_MAX_POINTS = 64;

/**
 * Optional river geometry. When present the body renders as a ribbon swept
 * along a Catmull-Rom spline through `points` instead of the rectangle:
 * flow follows the spline tangent, banks foam at the ribbon edges, and
 * downhill point sequences read as rapids. `surface.center.y` is ignored for
 * rivers; each control point carries its own water level.
 */
export const directorWorldRiverSchema = z.strictObject({
  points: z.array(vec3).min(2).max(DIRECTOR_WORLD_RIVER_MAX_POINTS),
  widthM: finite.min(0.5).max(200),
  /** Per-point width multipliers; linearly interpolated when shorter than points. */
  widthProfile: z.array(finite.min(0.1).max(8)).max(DIRECTOR_WORLD_RIVER_MAX_POINTS).optional(),
});

/** A water body: rectangular basin or optional river ribbon. */
export const directorWorldWaterBodySchema = z.strictObject({
  id,
  name,
  surface: z.strictObject({
    /** Center of the rectangular surface; Y is the water level. */
    center: vec3,
    sizeX: finite.min(0.1).max(5_000),
    sizeZ: finite.min(0.1).max(5_000),
    rotationDegrees: finite.min(-360).max(360),
  }),
  /** Present = river ribbon; absent = rectangular basin. */
  river: directorWorldRiverSchema.optional(),
  waveAmplitude: finite.min(0).max(3),
  waveLengthM: finite.min(0.2).max(200),
  flowDirectionDegrees: finite.min(0).max(360),
  flowSpeedMps: finite.min(0).max(10),
  colorShallow: color,
  colorDeep: color,
  opacity: finite.min(0.05).max(1),
  foamIntensity: finite.min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
});

/** Supported wildlife species. */
export const WORLD_WILDLIFE_SPECIES = ["birds", "butterflies", "fish", "deer", "rabbits", "wolves", "sheep"] as const;
export type WorldWildlifeSpecies = (typeof WORLD_WILDLIFE_SPECIES)[number];

/** Steering archetypes: flock (aerial), school (underwater), herd (grounded). */
export const WORLD_WILDLIFE_ARCHETYPES = ["flock", "school", "herd"] as const;
export type WorldWildlifeArchetype = (typeof WORLD_WILDLIFE_ARCHETYPES)[number];

/** Behavior archetype per species: aerial flocking, underwater schooling, or grounded herding. */
export const WORLD_WILDLIFE_SPECIES_ARCHETYPE: Record<WorldWildlifeSpecies, WorldWildlifeArchetype> = {
  birds: "flock",
  butterflies: "flock",
  fish: "school",
  deer: "herd",
  rabbits: "herd",
  wolves: "herd",
  sheep: "herd",
};

/** A group of wildlife agents with a shared species, roaming region, and steering parameters. */
export const directorWorldWildlifeGroupSchema = z.strictObject({
  id,
  name,
  species: z.enum(WORLD_WILDLIFE_SPECIES),
  count: z.number().int().min(1).max(DIRECTOR_WORLD_MAX_WILDLIFE_COUNT),
  /** Roaming region. Grounded herds stay on terrain inside it; flocks use it as a column. */
  area: z.strictObject({
    center: vec3,
    radius: finite.min(0.5).max(1_000),
  }),
  /** Flight band for flock archetypes, metres above area center Y. */
  altitude: z
    .strictObject({
      minM: finite.min(0).max(500),
      maxM: finite.min(0).max(500),
    })
    .refine((band) => band.maxM >= band.minM, { message: "altitude maxM must be >= minM" })
    .optional(),
  speedScale: finite.min(0.1).max(4),
  sizeScale: finite.min(0.1).max(10),
  /** Optional rigged model asset; placeholder silhouettes render when absent. */
  assetId: id.optional(),
  seedOffset: z.number().int().min(0).max(65_535),
  visible: z.boolean(),
  locked: z.boolean(),
});

/** Maximum number of roads in a world. */
export const DIRECTOR_WORLD_MAX_ROADS = 16;
/** Maximum number of ambient vehicles per road. */
export const DIRECTOR_WORLD_MAX_ROAD_VEHICLES = 24;
/** Maximum number of spline control points for a road. */
export const DIRECTOR_WORLD_ROAD_MAX_POINTS = 64;

/**
 * Ambient traffic road. Vehicles are a stateless view: every car's arc-length
 * position is a pure function of (seed, worldSeconds), so traffic scrubs and
 * exports deterministically with zero simulation state.
 */
export const directorWorldRoadSchema = z.strictObject({
  id,
  name,
  /** Catmull-Rom centerline; point Y values carry the road height. */
  points: z.array(vec3).min(2).max(DIRECTOR_WORLD_ROAD_MAX_POINTS),
  widthM: finite.min(2).max(30),
  /** Closed circuit when true; open roads respawn vehicles at their start. */
  loop: z.boolean(),
  /** Ambient vehicles across both directions of travel. */
  vehicleCount: z.number().int().min(0).max(DIRECTOR_WORLD_MAX_ROAD_VEHICLES),
  speedKph: finite.min(5).max(120),
  /** Renders the asphalt ribbon under the vehicles. */
  showSurface: z.boolean(),
  seedOffset: z.number().int().min(0).max(65_535),
  visible: z.boolean(),
  locked: z.boolean(),
});

/**
 * The complete world block for a Director project.
 *
 * Contains settings, effects, water bodies, wildlife groups, and roads.
 * Cross-validates that every collection entry has a unique id.
 */
export const directorWorldSchema = z
  .strictObject({
    version: z.literal(DIRECTOR_WORLD_PROTOCOL_VERSION),
    settings: directorWorldSettingsSchema,
    effects: z.array(directorWorldEffectSchema).max(DIRECTOR_WORLD_MAX_EFFECTS),
    waterBodies: z.array(directorWorldWaterBodySchema).max(DIRECTOR_WORLD_MAX_WATER_BODIES),
    wildlife: z.array(directorWorldWildlifeGroupSchema).max(DIRECTOR_WORLD_MAX_WILDLIFE_GROUPS),
    /** Defaulted so world blocks persisted before roads existed keep parsing. */
    roads: z.array(directorWorldRoadSchema).max(DIRECTOR_WORLD_MAX_ROADS).default([]),
  })
  .superRefine((world, context) => {
    (["effects", "waterBodies", "wildlife", "roads"] as const).forEach((collection) => {
      const seen = new Set<string>();
      world[collection].forEach((entry, index) => {
        if (seen.has(entry.id)) {
          context.addIssue({
            code: "custom",
            path: [collection, index, "id"],
            message: `duplicate ${collection} id ${entry.id}`,
          });
        }
        seen.add(entry.id);
      });
    });
  });

export type WorldAnchor = z.infer<typeof worldAnchorSchema>;
export type WorldEmitterShape = z.infer<typeof worldEmitterShapeSchema>;
export type DirectorWorldFirePropagation = z.infer<typeof directorWorldFirePropagationSchema>;
export type DirectorWorldWeatherEvolution = z.infer<typeof directorWorldWeatherEvolutionSchema>;
export type DirectorWorldEffect = z.infer<typeof directorWorldEffectSchema>;
export type DirectorWorldWind = z.infer<typeof directorWorldWindSchema>;
export type DirectorWorldTimeOfDay = z.infer<typeof directorWorldTimeOfDaySchema>;
export type DirectorWorldWeather = z.infer<typeof directorWorldWeatherSchema>;
export type DirectorWorldSettings = z.infer<typeof directorWorldSettingsSchema>;
export type DirectorWorldRiver = z.infer<typeof directorWorldRiverSchema>;
export type DirectorWorldWaterBody = z.infer<typeof directorWorldWaterBodySchema>;
export type DirectorWorldWildlifeGroup = z.infer<typeof directorWorldWildlifeGroupSchema>;
export type DirectorWorldRoad = z.infer<typeof directorWorldRoadSchema>;
export type DirectorWorld = z.infer<typeof directorWorldSchema>;

/**
 * Creates a sensible default world settings payload with midday sun,
 * mild wind, clear weather, and a fixed seed for deterministic replay.
 *
 * @returns A default {@link DirectorWorldSettings} instance.
 */
export function createDefaultDirectorWorldSettings(): DirectorWorldSettings {
  return {
    enabled: true,
    seed: 20_260_813,
    wind: { directionDegrees: 45, speedMps: 2.5, gustiness: 0.35, turbulence: 0.3 },
    timeOfDay: { mode: "fixed", hours: 14, cycleMinutes: 12, drivesSky: false },
    weather: { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0.2 },
  };
}

/**
 * Creates a default, empty world block at the current protocol version.
 *
 * @returns A {@link DirectorWorld} with default settings and no effects,
 * water bodies, wildlife, or roads.
 */
export function createDefaultDirectorWorld(): DirectorWorld {
  return {
    version: DIRECTOR_WORLD_PROTOCOL_VERSION,
    settings: createDefaultDirectorWorldSettings(),
    effects: [],
    waterBodies: [],
    wildlife: [],
    roads: [],
  };
}
