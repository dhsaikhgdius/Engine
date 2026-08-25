// World types come straight from the protocol package: the schema barrel
// re-exports are being reshaped by a parallel track and the protocol is the
// declared source of truth for the world block.
import {
  WORLD_EFFECT_KINDS,
  type DirectorWorldWeather,
  type WorldEffectKind,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";

/**
 * Authoring data for the stateless GPU particle systems.
 *
 * Pure data + pure functions only: this module is imported by tests and by
 * the render layer, and must stay free of three.js/React so the budget table
 * is verifiable in jsdom without a GL context.
 *
 * Units: metres, seconds, radians. All motion is integrated analytically in
 * the vertex shader, so "velocity"/"gravity" describe the closed-form
 * trajectory `spawn + v*t + 0.5*g*t^2`, not a stepped simulation.
 */
export interface WorldEffectPreset {
  /** Instances at intensity 1. Final count = round(baseCount * intensity). */
  baseCount: number;
  /** Per-particle lifetime is hashed into [min, max] seconds. */
  lifetimeSeconds: readonly [number, number];
  /** Mean initial velocity (m/s); vertical sign encodes rise vs fall. */
  velocityBase: readonly [number, number, number];
  /** Uniform +/- random spread added to the base velocity per axis. */
  velocitySpread: readonly [number, number, number];
  /** Constant acceleration; positive Y is buoyancy, negative Y gravity. */
  gravity: readonly [number, number, number];
  /** Amplitude (m) of the analytic sine turbulence displacement. */
  turbulence: number;
  /** Two incommensurate turbulence bands (rad/s-ish frequencies). */
  turbulenceFrequency: readonly [number, number];
  /** Sprite size in metres, interpolated start -> end over the lifetime. */
  sizeRange: readonly [number, number];
  /** Max billboard spin speed (rad/s); invisible for stretched sprites. */
  spinRadPerSec: number;
  /** 0 = spherical billboard; >0 stretches the quad along velocity. */
  velocityStretch: number;
  /** >0 enables per-particle glow pulsing (fireflies). */
  pulseHz: number;
  blending: "additive" | "normal";
  /** Emitter half-extents used when the authored shape is "point". */
  pointHalfExtents: readonly [number, number, number];
}

/**
 * Shipped particle budget (instances at intensity 1):
 * fire 220, smoke 160, steam 120, sparks 150, fireflies 60, dust 200,
 * rain 2200, snow 1500. Locked by effectPresets.test.ts.
 *
 * Fire's preset blending is "normal" because its base pass is the occluding
 * flame body; the additive glow is a second render pass (see
 * `getEffectRenderPasses`).
 */
export const EFFECT_PRESETS: Record<WorldEffectKind, WorldEffectPreset> = {
  fire: {
    baseCount: 220,
    lifetimeSeconds: [0.6, 1.3],
    velocityBase: [0, 1.1, 0],
    velocitySpread: [0.25, 0.45, 0.25],
    gravity: [0, 0.5, 0],
    turbulence: 0.16,
    turbulenceFrequency: [3.1, 7.3],
    sizeRange: [0.55, 0.12],
    spinRadPerSec: 1.4,
    velocityStretch: 0,
    pulseHz: 0,
    blending: "normal",
    pointHalfExtents: [0.22, 0.06, 0.22],
  },
  smoke: {
    baseCount: 160,
    lifetimeSeconds: [2.2, 4.5],
    velocityBase: [0, 1.0, 0],
    velocitySpread: [0.3, 0.35, 0.3],
    gravity: [0, 0.22, 0],
    turbulence: 0.5,
    turbulenceFrequency: [0.9, 2.3],
    sizeRange: [0.5, 1.9],
    spinRadPerSec: 0.6,
    velocityStretch: 0,
    pulseHz: 0,
    blending: "normal",
    pointHalfExtents: [0.25, 0.1, 0.25],
  },
  steam: {
    baseCount: 120,
    lifetimeSeconds: [1.4, 2.6],
    velocityBase: [0, 1.1, 0],
    velocitySpread: [0.25, 0.4, 0.25],
    gravity: [0, 0.35, 0],
    turbulence: 0.3,
    turbulenceFrequency: [1.7, 3.9],
    sizeRange: [0.35, 1.1],
    spinRadPerSec: 0.8,
    velocityStretch: 0,
    pulseHz: 0,
    blending: "normal",
    pointHalfExtents: [0.18, 0.05, 0.18],
  },
  sparks: {
    baseCount: 150,
    lifetimeSeconds: [0.4, 1.1],
    velocityBase: [0, 2.6, 0],
    velocitySpread: [1.7, 1.5, 1.7],
    gravity: [0, -9.8, 0],
    turbulence: 0.05,
    turbulenceFrequency: [8, 17],
    // Slightly above ember scale: additive sprites need the extra footprint
    // to stay legible against bright backgrounds.
    sizeRange: [0.08, 0.03],
    spinRadPerSec: 0,
    velocityStretch: 2.5,
    pulseHz: 0,
    blending: "additive",
    pointHalfExtents: [0.06, 0.06, 0.06],
  },
  fireflies: {
    baseCount: 60,
    lifetimeSeconds: [6, 12],
    velocityBase: [0, 0, 0],
    velocitySpread: [0.4, 0.25, 0.4],
    gravity: [0, 0, 0],
    turbulence: 0.9,
    turbulenceFrequency: [0.4, 1.1],
    // Oversized for a real insect on purpose: additive glow must survive
    // bright backdrops.
    sizeRange: [0.12, 0.12],
    spinRadPerSec: 0,
    velocityStretch: 0,
    pulseHz: 2.6,
    blending: "additive",
    pointHalfExtents: [1.6, 1.0, 1.6],
  },
  dust: {
    baseCount: 200,
    lifetimeSeconds: [4, 9],
    velocityBase: [0, 0.02, 0],
    velocitySpread: [0.12, 0.06, 0.12],
    gravity: [0, -0.02, 0],
    turbulence: 0.35,
    turbulenceFrequency: [0.5, 1.4],
    sizeRange: [0.05, 0.05],
    spinRadPerSec: 0.5,
    velocityStretch: 0,
    pulseHz: 0,
    blending: "normal",
    pointHalfExtents: [1.8, 1.2, 1.8],
  },
  rain: {
    baseCount: 2200,
    lifetimeSeconds: [0.9, 1.4],
    velocityBase: [0, -9.5, 0],
    velocitySpread: [0.4, 1.5, 0.4],
    gravity: [0, -2.0, 0],
    turbulence: 0,
    turbulenceFrequency: [0, 0],
    sizeRange: [0.42, 0.42],
    spinRadPerSec: 0,
    velocityStretch: 1.7,
    pulseHz: 0,
    blending: "normal",
    pointHalfExtents: [3, 0.5, 3],
  },
  snow: {
    baseCount: 1500,
    lifetimeSeconds: [3.5, 6.5],
    velocityBase: [0, -0.9, 0],
    velocitySpread: [0.35, 0.25, 0.35],
    gravity: [0, -0.12, 0],
    turbulence: 0.55,
    turbulenceFrequency: [0.8, 1.9],
    sizeRange: [0.05, 0.05],
    spinRadPerSec: 0,
    velocityStretch: 0,
    pulseHz: 0,
    blending: "normal",
    pointHalfExtents: [3, 0.5, 3],
  },
};

/** Re-export the canonical effect kind catalog from the protocol package. */
export { WORLD_EFFECT_KINDS };

/** round(base * intensity), clamped to >= 0. Non-finite intensity emits nothing. */
export function getEffectParticleCount(kind: WorldEffectKind, intensity: number): number {
  if (!Number.isFinite(intensity)) return 0;
  return Math.max(0, Math.round(EFFECT_PRESETS[kind].baseCount * Math.max(0, intensity)));
}

/** Shader/material variant selector; "main" is the only pass for non-fire kinds. */
export type EffectRenderPassId = "main" | "fire-body" | "fire-glow";

/** Describes one draw pass of an effect: its material, blend mode, and render order. */
export interface EffectRenderPassSpec {
  /** Which shader variant and material to use for this pass. */
  id: EffectRenderPassId;
  /** Blend mode for this pass: additive for emissive glows, normal for occluding media. */
  blending: "additive" | "normal";
  /**
   * Participates in scene fog (`material.fog`): true for the normal-blended
   * volumetric media so distant smoke/rain sinks into fog instead of looking
   * pasted on. Additive emissive kinds and the flame body are excluded — a
   * simplification that lets close-range flames pierce fog.
   */
  sceneFog: boolean;
  /** Added to the effect's base renderOrder so passes layer deterministically. */
  renderOrderOffset: number;
}

/**
 * Fire draws twice over ONE shared InstancedBufferGeometry: an alpha-blended
 * body whose dark-to-saturated ramp occludes the backdrop (legible on bright
 * scenes where pure additive washes out), then the additive heat glow on top.
 * Cost: one extra draw call + one extra ShaderMaterial per fire effect; the
 * geometry, uniforms, and per-frame CPU work are shared between the passes.
 */
export const FIRE_RENDER_PASSES: readonly EffectRenderPassSpec[] = [
  { id: "fire-body", blending: "normal", sceneFog: false, renderOrderOffset: 0 },
  { id: "fire-glow", blending: "additive", sceneFog: false, renderOrderOffset: 1 },
];

/** Normal-blended volumetric media that should sink into scene fog. */
export const SCENE_FOG_EFFECT_KINDS: readonly WorldEffectKind[] = ["smoke", "steam", "dust", "rain", "snow"];

/** Render passes for one effect kind, in draw order. */
export function getEffectRenderPasses(kind: WorldEffectKind): readonly EffectRenderPassSpec[] {
  if (kind === "fire") return FIRE_RENDER_PASSES;
  return [
    {
      id: "main",
      blending: EFFECT_PRESETS[kind].blending,
      sceneFog: SCENE_FOG_EFFECT_KINDS.includes(kind),
      renderOrderOffset: 0,
    },
  ];
}

/** Camera-following precipitation volume: width x height x depth in metres. */
export const WEATHER_PRECIPITATION_BOX_SIZE: readonly [number, number, number] = [44, 26, 44];

/** Storm renders the rain preset at higher density with harder wind shear. */
export const STORM_DENSITY_MULTIPLIER = 1.6;
/** Multiplier on the global wind vector to drive storm rain sideways. */
export const STORM_WIND_MULTIPLIER = 2.2;
/** Scales the local particle clock so storm rain falls faster than calm rain. */
export const STORM_SPEED_MULTIPLIER = 1.25;

export interface WeatherPrecipitationPlan {
  /** Which precipitation kind to render (rain or snow). */
  kind: Extract<WorldEffectKind, "rain" | "snow">;
  /** Total particle count for the precipitation system. */
  count: number;
  /** Premultiplies the global wind vector for the precipitation system. */
  windMultiplier: number;
  /** Scales the local particle clock (harder, faster storm rain). */
  speedMultiplier: number;
}

/**
 * Climate-vector precipitation plan: particle counts ramp continuously with
 * the evaluated rain/snow levels, and storm shear/speed scale with the
 * evaluated storm factor. A static climate reproduces
 * {@link getWeatherPrecipitationPlan} exactly (locked by tests).
 */
export function getClimatePrecipitationPlan(climate: {
  rainLevel: number;
  snowLevel: number;
  stormFactor: number;
}): WeatherPrecipitationPlan | null {
  const rain = Number.isFinite(climate.rainLevel) ? Math.max(0, climate.rainLevel) : 0;
  const snow = Number.isFinite(climate.snowLevel) ? Math.max(0, climate.snowLevel) : 0;
  const storm = Math.min(1, Math.max(0, climate.stormFactor));
  if (rain <= 0 && snow <= 0) return null;
  let plan: WeatherPrecipitationPlan;
  if (rain >= snow) {
    const densityMultiplier = storm >= 1 ? STORM_DENSITY_MULTIPLIER : 1 + (STORM_DENSITY_MULTIPLIER - 1) * storm;
    plan = {
      kind: "rain",
      count: Math.round(EFFECT_PRESETS.rain.baseCount * densityMultiplier * rain),
      windMultiplier: storm >= 1 ? STORM_WIND_MULTIPLIER : 1 + (STORM_WIND_MULTIPLIER - 1) * storm,
      speedMultiplier: storm >= 1 ? STORM_SPEED_MULTIPLIER : 1 + (STORM_SPEED_MULTIPLIER - 1) * storm,
    };
  } else {
    plan = {
      kind: "snow",
      count: Math.round(EFFECT_PRESETS.snow.baseCount * snow),
      windMultiplier: 1,
      speedMultiplier: 1,
    };
  }
  if (plan.count <= 0) return null;
  return plan;
}

/**
 * Global weather -> precipitation plan. Returns null when nothing should
 * render (clear/overcast, or the density rounds to zero particles).
 */
export function getWeatherPrecipitationPlan(weather: DirectorWorldWeather): WeatherPrecipitationPlan | null {
  const intensity = Number.isFinite(weather.intensity) ? Math.max(0, weather.intensity) : 0;
  let plan: WeatherPrecipitationPlan | null = null;
  if (weather.preset === "rain") {
    plan = {
      kind: "rain",
      count: Math.round(EFFECT_PRESETS.rain.baseCount * intensity),
      windMultiplier: 1,
      speedMultiplier: 1,
    };
  } else if (weather.preset === "snow") {
    plan = {
      kind: "snow",
      count: Math.round(EFFECT_PRESETS.snow.baseCount * intensity),
      windMultiplier: 1,
      speedMultiplier: 1,
    };
  } else if (weather.preset === "storm") {
    plan = {
      kind: "rain",
      count: Math.round(EFFECT_PRESETS.rain.baseCount * STORM_DENSITY_MULTIPLIER * intensity),
      windMultiplier: STORM_WIND_MULTIPLIER,
      speedMultiplier: STORM_SPEED_MULTIPLIER,
    };
  }
  if (!plan || plan.count <= 0) return null;
  return plan;
}
