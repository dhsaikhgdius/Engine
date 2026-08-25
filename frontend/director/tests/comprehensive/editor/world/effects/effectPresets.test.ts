import { describe, expect, it } from "vitest";
import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  EFFECT_PRESETS,
  FIRE_RENDER_PASSES,
  SCENE_FOG_EFFECT_KINDS,
  STORM_DENSITY_MULTIPLIER,
  STORM_WIND_MULTIPLIER,
  WEATHER_PRECIPITATION_BOX_SIZE,
  WORLD_EFFECT_KINDS,
  getEffectParticleCount,
  getEffectRenderPasses,
  getWeatherPrecipitationPlan,
} from "../../../../../src/comprehensive/editor/world/effects/effectPresets";

function createWeather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0.2, ...overrides };
}

describe("effect presets", () => {
  it("covers every protocol effect kind exhaustively", () => {
    for (const kind of WORLD_EFFECT_KINDS) {
      const preset = EFFECT_PRESETS[kind];
      expect(preset, `missing preset for ${kind}`).toBeDefined();
      expect(preset.baseCount).toBeGreaterThan(0);
      expect(preset.lifetimeSeconds[0]).toBeGreaterThan(0);
      expect(preset.lifetimeSeconds[1]).toBeGreaterThanOrEqual(preset.lifetimeSeconds[0]);
      expect(preset.sizeRange[0]).toBeGreaterThan(0);
      expect(["additive", "normal"]).toContain(preset.blending);
    }
    expect(Object.keys(EFFECT_PRESETS).sort()).toEqual([...WORLD_EFFECT_KINDS].sort());
  });

  it("locks the shipped particle budget table", () => {
    expect(EFFECT_PRESETS.fire.baseCount).toBe(220);
    expect(EFFECT_PRESETS.smoke.baseCount).toBe(160);
    expect(EFFECT_PRESETS.steam.baseCount).toBe(120);
    expect(EFFECT_PRESETS.sparks.baseCount).toBe(150);
    expect(EFFECT_PRESETS.fireflies.baseCount).toBe(60);
    expect(EFFECT_PRESETS.dust.baseCount).toBe(200);
    expect(EFFECT_PRESETS.rain.baseCount).toBe(2200);
    expect(EFFECT_PRESETS.snow.baseCount).toBe(1500);
  });

  it("uses additive blending for emissive kinds and normal alpha elsewhere", () => {
    expect(EFFECT_PRESETS.sparks.blending).toBe("additive");
    expect(EFFECT_PRESETS.fireflies.blending).toBe("additive");
    // Fire's preset blending describes its BASE pass: the occluding body.
    for (const kind of ["fire", "smoke", "steam", "dust", "rain", "snow"] as const) {
      expect(EFFECT_PRESETS[kind].blending).toBe("normal");
    }
  });

  it("renders fire as an occluding body pass plus an additive glow pass", () => {
    expect(getEffectRenderPasses("fire")).toBe(FIRE_RENDER_PASSES);
    expect(FIRE_RENDER_PASSES).toEqual([
      { id: "fire-body", blending: "normal", sceneFog: false, renderOrderOffset: 0 },
      { id: "fire-glow", blending: "additive", sceneFog: false, renderOrderOffset: 1 },
    ]);
  });

  it("renders every non-fire kind as a single main pass with its preset blending", () => {
    for (const kind of WORLD_EFFECT_KINDS.filter((entry) => entry !== "fire")) {
      const passes = getEffectRenderPasses(kind);
      expect(passes).toHaveLength(1);
      expect(passes[0].id).toBe("main");
      expect(passes[0].blending).toBe(EFFECT_PRESETS[kind].blending);
      expect(passes[0].renderOrderOffset).toBe(0);
    }
  });

  it("applies scene fog to normal-blended volumetric media only", () => {
    expect([...SCENE_FOG_EFFECT_KINDS].sort()).toEqual(["dust", "rain", "smoke", "snow", "steam"]);
    for (const kind of WORLD_EFFECT_KINDS) {
      const fogged = getEffectRenderPasses(kind).some((pass) => pass.sceneFog);
      expect(fogged, `sceneFog mismatch for ${kind}`).toBe(SCENE_FOG_EFFECT_KINDS.includes(kind));
    }
    // Flames pierce fog at short range: both fire passes opt out (documented
    // simplification), as do the additive emissive kinds.
    for (const pass of FIRE_RENDER_PASSES) expect(pass.sceneFog).toBe(false);
  });

  it("scales particle counts linearly with intensity and clamps at bounds", () => {
    expect(getEffectParticleCount("fire", 1)).toBe(220);
    expect(getEffectParticleCount("fire", 2)).toBe(440);
    expect(getEffectParticleCount("fire", 3)).toBe(660);
    expect(getEffectParticleCount("rain", 0.5)).toBe(1100);
    expect(getEffectParticleCount("fireflies", 0.5)).toBe(30);
    expect(getEffectParticleCount("smoke", 0)).toBe(0);
    expect(getEffectParticleCount("smoke", -1)).toBe(0);
    expect(getEffectParticleCount("smoke", Number.NaN)).toBe(0);
  });

  it("returns no precipitation for clear and overcast weather", () => {
    expect(getWeatherPrecipitationPlan(createWeather({ preset: "clear", intensity: 1 }))).toBeNull();
    expect(getWeatherPrecipitationPlan(createWeather({ preset: "overcast", intensity: 1 }))).toBeNull();
    expect(getWeatherPrecipitationPlan(createWeather({ preset: "rain", intensity: 0 }))).toBeNull();
  });

  it("scales rain and snow precipitation with weather intensity", () => {
    const rain = getWeatherPrecipitationPlan(createWeather({ preset: "rain", intensity: 1 }));
    expect(rain).toEqual({ kind: "rain", count: 2200, windMultiplier: 1, speedMultiplier: 1 });

    const halfRain = getWeatherPrecipitationPlan(createWeather({ preset: "rain", intensity: 0.5 }));
    expect(halfRain?.count).toBe(1100);

    const snow = getWeatherPrecipitationPlan(createWeather({ preset: "snow", intensity: 1 }));
    expect(snow?.kind).toBe("snow");
    expect(snow?.count).toBe(1500);
  });

  it("renders storms as denser rain with harder wind", () => {
    const storm = getWeatherPrecipitationPlan(createWeather({ preset: "storm", intensity: 1 }));
    expect(storm?.kind).toBe("rain");
    expect(storm?.count).toBe(Math.round(2200 * STORM_DENSITY_MULTIPLIER));
    expect(storm?.windMultiplier).toBe(STORM_WIND_MULTIPLIER);
    expect(storm?.windMultiplier).toBeGreaterThan(1);
    expect(storm?.speedMultiplier).toBeGreaterThan(1);

    const halfStorm = getWeatherPrecipitationPlan(createWeather({ preset: "storm", intensity: 0.5 }));
    expect(halfStorm?.count).toBe(Math.round(2200 * STORM_DENSITY_MULTIPLIER * 0.5));
  });

  it("keeps the camera-following volume near the documented size", () => {
    expect(WEATHER_PRECIPITATION_BOX_SIZE).toEqual([44, 26, 44]);
  });
});
