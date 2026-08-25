import type {
  DirectorWorldEffect,
  DirectorWorldWeather,
  WorldEffectKind,
  WorldEmitterShape,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { hashCombine, worldStreamId } from "../worldRandom";
import {
  EFFECT_PRESETS,
  WEATHER_PRECIPITATION_BOX_SIZE,
  getEffectParticleCount,
  getWeatherPrecipitationPlan,
  type WorldEffectPreset,
} from "./effectPresets";

/**
 * Pure, serializable parameterization of one GPU particle system.
 *
 * Everything the render layer feeds into uniforms is derived here from
 * `(effect, worldSeed)` alone, so two builds with identical inputs are deeply
 * equal — the contract that makes deterministic frame export testable without
 * a GL context. Per-frame values (time, wind, resolved origin) intentionally
 * stay out: they are written straight into uniforms each render.
 */

/** GLSL branch selector for the spawn-shape code path. */
export const EMITTER_MODE_BOX = 0;
/** Spherical volume emitter, radius in X. */
export const EMITTER_MODE_SPHERE = 1;
/** Flat disc emitter, radius in X. */
export const EMITTER_MODE_DISC = 2;
/** Union of the three emitter shape modes the GLSL vertex shader branches on. */
export type EmitterMode = typeof EMITTER_MODE_BOX | typeof EMITTER_MODE_SPHERE | typeof EMITTER_MODE_DISC;

export interface EffectEmitterConfig {
  /** Which GLSL spawn-shape branch to take. */
  mode: EmitterMode;
  /** Box: half extents. Sphere/disc: radius in X (Y/Z mirrored for tests). */
  extents: readonly [number, number, number];
}

export interface EffectSystemConfig {
  /** Stable identifier matching the authored effect. */
  id: string;
  /** Particle kind, selecting the preset and shader variant. */
  kind: WorldEffectKind;
  /** Actual particle instance count for this system (intensity already applied). */
  count: number;
  /** Raw 32-bit system hash; uSeed derives from it. */
  seedHash: number;
  /** Two well-conditioned floats in [0, 61.8) driving the GLSL hash chain. */
  seed: readonly [number, number];
  /** Emitter shape and extents for the spawn-shape code path. */
  emitter: EffectEmitterConfig;
  /** Authored effect intensity (0–1 range). */
  intensity: number;
  /** Uniform size multiplier applied in the vertex shader. */
  sizeScale: number;
  /** Uniform speed multiplier applied to the particle clock. */
  speedScale: number;
  /** CPU-side premultiplier for the global wind vector (can exceed 1 for storms). */
  windInfluence: number;
  /**
   * Fraction of particles rendered as ground splash rings instead of falling
   * drops. Only the camera-following weather rain sets this; anchored
   * emitters have no reliable splash plane and keep 0.
   */
  splashFraction: number;
  /** Optional RGB tint from the authored hex color, or null. */
  tint: readonly [number, number, number] | null;
  /** Blend mode for the main pass of this system. */
  blending: "additive" | "normal";
  /** Full box size for camera-following wrap; null disables wrapping. */
  wrapExtents: readonly [number, number, number] | null;
  /** The preset table entry backing this system. */
  preset: WorldEffectPreset;
}

/** Stable system id for the camera-following weather precipitation system. */
export const WEATHER_SYSTEM_ID = "world:weather-precipitation";

/**
 * Float32 uniforms cannot carry a full uint32 exactly, so the hash is split
 * into two 16-bit halves and scaled into a range where `fract`-style GLSL
 * hashing stays well conditioned.
 */
export function seedHashToGlslSeed(seedHash: number): readonly [number, number] {
  const low = (seedHash & 0xffff) / 0x10000;
  const high = ((seedHash >>> 16) & 0xffff) / 0x10000;
  return [low * 61.8033988749895, high * 61.8033988749895];
}

/** #rrggbb -> linear-ish [0,1] triple; null for anything malformed. */
export function parseHexColor01(hex: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * Converts the authored shape descriptor into the GLSL emitter config.
 *
 * @param shape - The authored emitter shape from the effect definition.
 * @param preset - The preset table entry, used for the default "point" half-extents.
 * @returns The resolved emitter mode and extents for the vertex shader.
 */
export function resolveEmitterConfig(shape: WorldEmitterShape, preset: WorldEffectPreset): EffectEmitterConfig {
  switch (shape.type) {
    case "sphere":
      return { mode: EMITTER_MODE_SPHERE, extents: [shape.radius, shape.radius, shape.radius] };
    case "disc":
      return { mode: EMITTER_MODE_DISC, extents: [shape.radius, 0, shape.radius] };
    case "box":
      return { mode: EMITTER_MODE_BOX, extents: [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2] };
    case "point":
      return { mode: EMITTER_MODE_BOX, extents: preset.pointHalfExtents };
  }
}

/**
 * Deterministic 32-bit seed hash for one effect system.
 *
 * @param worldSeed - The world-level seed.
 * @param seedOffset - Per-effect seed offset from the authored definition.
 * @param effectId - Stable effect identifier.
 * @returns A combined hash that seeds the GLSL random chain for this system.
 */
export function getEffectSystemSeedHash(worldSeed: number, seedOffset: number, effectId: string): number {
  return hashCombine(worldSeed, seedOffset, worldStreamId(effectId));
}

/**
 * Full serializable parameterization of one GPU particle system from an
 * authored effect and world seed. Two builds with identical inputs are
 * deeply equal — the contract that makes deterministic frame export testable
 * without a GL context.
 *
 * @param effect - The authored effect definition.
 * @param worldSeed - The world-level seed.
 * @returns A complete, seed-stable effect system config for the render layer.
 */
export function buildEffectSystemConfig(effect: DirectorWorldEffect, worldSeed: number): EffectSystemConfig {
  const preset = EFFECT_PRESETS[effect.kind];
  const seedHash = getEffectSystemSeedHash(worldSeed, effect.seedOffset, effect.id);
  return {
    id: effect.id,
    kind: effect.kind,
    count: getEffectParticleCount(effect.kind, effect.intensity),
    seedHash,
    seed: seedHashToGlslSeed(seedHash),
    emitter: resolveEmitterConfig(effect.shape, preset),
    intensity: effect.intensity,
    sizeScale: effect.sizeScale,
    speedScale: effect.speedScale,
    windInfluence: effect.windInfluence,
    splashFraction: 0,
    tint: effect.colorTint ? parseHexColor01(effect.colorTint) : null,
    blending: preset.blending,
    wrapExtents: null,
    preset,
  };
}

/**
 * Camera-following precipitation system for rain/snow/storm weather.
 * `uOrigin` is written from the render camera each frame, so the config keeps
 * no origin; the wrap extents keep the volume filled around the camera.
 */
export function buildWeatherSystemConfig(weather: DirectorWorldWeather, worldSeed: number): EffectSystemConfig | null {
  const plan = getWeatherPrecipitationPlan(weather);
  if (!plan) return null;
  const preset = EFFECT_PRESETS[plan.kind];
  const seedHash = hashCombine(worldSeed, worldStreamId(WEATHER_SYSTEM_ID));
  const [width, height, depth] = WEATHER_PRECIPITATION_BOX_SIZE;
  return {
    id: WEATHER_SYSTEM_ID,
    kind: plan.kind,
    count: plan.count,
    seedHash,
    seed: seedHashToGlslSeed(seedHash),
    emitter: { mode: EMITTER_MODE_BOX, extents: [width / 2, height / 2, depth / 2] },
    intensity: weather.intensity,
    sizeScale: plan.sizeMultiplier,
    speedScale: plan.speedMultiplier,
    windInfluence: plan.windMultiplier,
    splashFraction: plan.splashFraction,
    tint: null,
    blending: preset.blending,
    wrapExtents: WEATHER_PRECIPITATION_BOX_SIZE,
    preset,
  };
}

/** Instanced `aParticleIndex` payload; two builds must be byte-identical. */
export function buildParticleIndexArray(count: number): Float32Array {
  const safeCount = Math.max(0, Math.floor(count));
  const array = new Float32Array(safeCount);
  for (let index = 0; index < safeCount; index += 1) array[index] = index;
  return array;
}
