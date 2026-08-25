import { describe, expect, it } from "vitest";
import type {
  DirectorWorldEffect,
  DirectorWorldWeather,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { EFFECT_PRESETS, WEATHER_PRECIPITATION_BOX_SIZE } from "../../../../../src/comprehensive/editor/world/effects/effectPresets";
import {
  EMITTER_MODE_BOX,
  EMITTER_MODE_DISC,
  EMITTER_MODE_SPHERE,
  WEATHER_SYSTEM_ID,
  buildEffectSystemConfig,
  buildParticleIndexArray,
  buildWeatherSystemConfig,
  parseHexColor01,
  resolveEmitterConfig,
  seedHashToGlslSeed,
} from "../../../../../src/comprehensive/editor/world/effects/effectSystemConfig";

const WORLD_SEED = 20_260_813;

function createEffect(overrides: Partial<DirectorWorldEffect> = {}): DirectorWorldEffect {
  return {
    id: "fx_fire_1",
    name: "篝火火焰",
    kind: "fire",
    anchor: { objectId: null, position: [0, 0, 0] },
    shape: { type: "point" },
    intensity: 1,
    sizeScale: 1,
    speedScale: 1,
    windInfluence: 0.5,
    seedOffset: 0,
    visible: true,
    locked: false,
    createdAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

function createWeather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return { preset: "rain", intensity: 1, wetness: 0, cloudCover: 0.8, ...overrides };
}

describe("effect system parameterization", () => {
  it("is deterministic: two builds for the same (effect, worldSeed) are deeply equal", () => {
    const effect = createEffect({ kind: "smoke", colorTint: "#88aaff", shape: { type: "sphere", radius: 2 } });
    expect(buildEffectSystemConfig(effect, WORLD_SEED)).toEqual(buildEffectSystemConfig(effect, WORLD_SEED));
    expect(buildWeatherSystemConfig(createWeather(), WORLD_SEED)).toEqual(
      buildWeatherSystemConfig(createWeather(), WORLD_SEED),
    );
  });

  it("decorrelates uSeed across seedOffset, id, and world seed", () => {
    const base = buildEffectSystemConfig(createEffect(), WORLD_SEED);
    const offset = buildEffectSystemConfig(createEffect({ seedOffset: 7 }), WORLD_SEED);
    const otherId = buildEffectSystemConfig(createEffect({ id: "fx_fire_2" }), WORLD_SEED);
    const otherWorld = buildEffectSystemConfig(createEffect(), WORLD_SEED + 1);

    expect(offset.seedHash).not.toBe(base.seedHash);
    expect(otherId.seedHash).not.toBe(base.seedHash);
    expect(otherWorld.seedHash).not.toBe(base.seedHash);
    expect(offset.seed).not.toEqual(base.seed);
    expect(otherId.seed).not.toEqual(base.seed);
  });

  it("derives well-conditioned GLSL seed floats from the 32-bit hash", () => {
    const [low, high] = seedHashToGlslSeed(0xffff_ffff);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThan(61.81);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThan(61.81);
    expect(seedHashToGlslSeed(0)).toEqual([0, 0]);
    expect(seedHashToGlslSeed(123456)).toEqual(seedHashToGlslSeed(123456));
  });

  it("maps emitter shapes onto shader-side modes and extents", () => {
    const preset = EFFECT_PRESETS.fire;
    expect(resolveEmitterConfig({ type: "point" }, preset)).toEqual({
      mode: EMITTER_MODE_BOX,
      extents: preset.pointHalfExtents,
    });
    expect(resolveEmitterConfig({ type: "sphere", radius: 3 }, preset)).toEqual({
      mode: EMITTER_MODE_SPHERE,
      extents: [3, 3, 3],
    });
    expect(resolveEmitterConfig({ type: "disc", radius: 2 }, preset)).toEqual({
      mode: EMITTER_MODE_DISC,
      extents: [2, 0, 2],
    });
    expect(resolveEmitterConfig({ type: "box", size: [4, 2, 6] }, preset)).toEqual({
      mode: EMITTER_MODE_BOX,
      extents: [2, 1, 3],
    });
  });

  it("parses hex tints into unit RGB and rejects malformed input", () => {
    expect(parseHexColor01("#ff8000")).toEqual([1, 128 / 255, 0]);
    expect(parseHexColor01("#000000")).toEqual([0, 0, 0]);
    expect(parseHexColor01("#FFFFFF")).toEqual([1, 1, 1]);
    expect(parseHexColor01("red")).toBeNull();
    expect(parseHexColor01("#fff")).toBeNull();

    expect(buildEffectSystemConfig(createEffect({ colorTint: "#336699" }), WORLD_SEED).tint).toEqual([
      0x33 / 255,
      0x66 / 255,
      0x99 / 255,
    ]);
    expect(buildEffectSystemConfig(createEffect(), WORLD_SEED).tint).toBeNull();
  });

  it("builds identical aParticleIndex payloads for identical counts", () => {
    const first = buildParticleIndexArray(220);
    const second = buildParticleIndexArray(220);
    expect(first).toEqual(second);
    expect(first.length).toBe(220);
    expect(first[0]).toBe(0);
    expect(first[219]).toBe(219);
    expect(buildParticleIndexArray(0).length).toBe(0);
    expect(buildParticleIndexArray(-5).length).toBe(0);
  });

  it("configures the weather system as a wrapped camera-following box", () => {
    const storm = buildWeatherSystemConfig(createWeather({ preset: "storm", intensity: 1 }), WORLD_SEED);
    expect(storm).not.toBeNull();
    expect(storm?.id).toBe(WEATHER_SYSTEM_ID);
    expect(storm?.kind).toBe("rain");
    expect(storm?.count).toBe(Math.round(2200 * 1.6));
    expect(storm?.wrapExtents).toEqual(WEATHER_PRECIPITATION_BOX_SIZE);
    expect(storm?.emitter).toEqual({
      mode: EMITTER_MODE_BOX,
      extents: [
        WEATHER_PRECIPITATION_BOX_SIZE[0] / 2,
        WEATHER_PRECIPITATION_BOX_SIZE[1] / 2,
        WEATHER_PRECIPITATION_BOX_SIZE[2] / 2,
      ],
    });
    expect(storm?.windInfluence).toBeGreaterThan(1);

    expect(buildWeatherSystemConfig(createWeather({ preset: "clear" }), WORLD_SEED)).toBeNull();

    // The weather stream must not collide with a user effect on the same seed.
    const effectConfig = buildEffectSystemConfig(createEffect({ kind: "rain" }), WORLD_SEED);
    expect(storm?.seedHash).not.toBe(effectConfig.seedHash);
  });

  it("keeps anchored effects unwrapped", () => {
    const config = buildEffectSystemConfig(createEffect({ kind: "rain" }), WORLD_SEED);
    expect(config.wrapExtents).toBeNull();
  });
});
