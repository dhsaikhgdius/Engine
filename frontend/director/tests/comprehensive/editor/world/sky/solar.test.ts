import { describe, expect, it } from "vitest";
import { createDefaultDirectorWorldSettings } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type {
  DirectorWorldSettings,
  DirectorWorldWeather,
} from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  evaluateSkyLighting,
  evaluateSunDiscState,
  getSkySolarArc,
  getSolarDirectionForHours,
  getWorldSkyLightScale,
  SKY_MAX_SUN_ELEVATION_RADIANS,
  SKY_MOONLIGHT_INTENSITY_RATIO,
  SKY_SUN_DISC_MIN_ELEVATION_RADIANS,
  WORLD_SKY_FILL_SCALE,
} from "../../../../../src/comprehensive/editor/world/sky/solar";

function settingsAt(hours: number, weather: Partial<DirectorWorldWeather> = {}): DirectorWorldSettings {
  const base = createDefaultDirectorWorldSettings();
  return {
    ...base,
    timeOfDay: { ...base.timeOfDay, mode: "fixed", hours, drivesSky: true },
    weather: { ...base.weather, preset: "clear", intensity: 0.5, cloudCover: 0, ...weather },
  };
}

describe("sky solar arc", () => {
  it("peaks at solar noon and stays below the horizon at night", () => {
    expect(getSkySolarArc(12).altitudeSin).toBeCloseTo(1, 12);
    expect(getSkySolarArc(12).elevationRadians).toBeCloseTo(SKY_MAX_SUN_ELEVATION_RADIANS, 12);
    expect(getSkySolarArc(12).elevationRadians).toBeGreaterThan(getSkySolarArc(9).elevationRadians);
    expect(getSkySolarArc(12).elevationRadians).toBeGreaterThan(getSkySolarArc(15).elevationRadians);

    expect(getSkySolarArc(6).elevationRadians).toBeCloseTo(0, 12);
    expect(getSkySolarArc(18).elevationRadians).toBeCloseTo(0, 12);
    for (const nightHours of [0, 3, 20, 22, 23.5]) {
      expect(getSkySolarArc(nightHours).elevationRadians).toBeLessThan(0);
    }
  });

  it("sweeps east through south to west", () => {
    expect(getSolarDirectionForHours(8)[0]).toBeGreaterThan(0);
    expect(getSolarDirectionForHours(16)[0]).toBeLessThan(0);
    const noon = getSolarDirectionForHours(12);
    expect(noon[0]).toBeCloseTo(0, 10);
    expect(noon[2]).toBeLessThan(0);
  });
});

describe("world sky light scale", () => {
  it("is a full key light when the project has no authored lights", () => {
    expect(getWorldSkyLightScale(0)).toBe(1);
  });

  it("drops to fill scale once any authored light is already lighting the scene", () => {
    expect(getWorldSkyLightScale(1)).toBe(WORLD_SKY_FILL_SCALE);
    expect(getWorldSkyLightScale(12)).toBe(WORLD_SKY_FILL_SCALE);
    expect(WORLD_SKY_FILL_SCALE).toBe(0.35);
  });
});

describe("evaluateSkyLighting", () => {
  it("is deterministic for identical inputs", () => {
    const settings = settingsAt(9.37, { preset: "rain", intensity: 0.7, cloudCover: 0.6 });
    expect(evaluateSkyLighting(settings, 123.456)).toEqual(evaluateSkyLighting(settings, 123.456));
  });

  it("is seek-stable: scrubbing order never changes a frame's lighting", () => {
    const settings = settingsAt(16.2, { preset: "storm", intensity: 0.85, cloudCover: 0.7 });
    const times = [512.75, 0, 9999.125, 42.5, 512.75, 3.25, 0];
    const forward = times.map((t) => evaluateSkyLighting(settings, t));
    const reversed = [...times].reverse().map((t) => evaluateSkyLighting(settings, t));
    reversed.reverse();
    expect(forward).toEqual(reversed);
    // Re-seeking the same frame after visiting others replays it exactly.
    expect(forward[0]).toEqual(forward[4]);
    expect(forward[1]).toEqual(forward[6]);
  });

  it("makes the five weather presets glance-distinct in key, ambient, and stars", () => {
    const presets = ["clear", "overcast", "rain", "snow", "storm"] as const;
    const noon = presets.map((preset) =>
      evaluateSkyLighting(settingsAt(12, { preset, intensity: 0.5, cloudCover: 0.3 }), 0),
    );
    expect(new Set(noon.map((state) => state.sunIntensity)).size).toBe(presets.length);
    expect(new Set(noon.map((state) => state.ambientIntensity)).size).toBe(presets.length);
    const midnight = presets.map((preset) =>
      evaluateSkyLighting(settingsAt(0, { preset, intensity: 0.5, cloudCover: 0.3 }), 0),
    );
    expect(new Set(midnight.map((state) => state.starsOpacity)).size).toBe(presets.length);
    // Clear keeps the brightest key and the clearest stars; storm the least.
    const clearNoon = noon[0]!;
    const stormNoon = noon[4]!;
    expect(clearNoon.sunIntensity).toBeGreaterThan(2 * Math.max(...noon.slice(1).map((s) => s.sunIntensity)));
    expect(stormNoon.sunIntensity).toBeLessThan(Math.min(...noon.slice(0, 4).map((s) => s.sunIntensity)));
    // Clear midnight at 0.3 cover keeps most stars; a storm blots them out.
    expect(midnight[0]!.starsOpacity).toBeGreaterThan(0.6);
    expect(midnight[4]!.starsOpacity).toBeLessThan(0.01);
  });

  it("moves lighting when the intensity slider moves, for every non-clear preset", () => {
    for (const preset of ["overcast", "rain", "snow", "storm"] as const) {
      const faint = evaluateSkyLighting(settingsAt(12, { preset, intensity: 0.1, cloudCover: 0.3 }), 0);
      const violent = evaluateSkyLighting(settingsAt(12, { preset, intensity: 1, cloudCover: 0.3 }), 0);
      expect(violent.sunIntensity, `${preset} key light must dim with intensity`).toBeLessThan(faint.sunIntensity);
    }
  });

  it("hides stars on an overcast night even when the authored cover slider is low", () => {
    const overcastNight = evaluateSkyLighting(
      settingsAt(0, { preset: "overcast", intensity: 0.6, cloudCover: 0.1 }),
      0,
    );
    expect(overcastNight.starsOpacity).toBeLessThan(0.05);
  });

  it("reads golden hour warmer than noon on the key light", () => {
    const noon = evaluateSkyLighting(settingsAt(12), 0);
    const golden = evaluateSkyLighting(settingsAt(17.2), 0);
    const noonWarmth = noon.sunColor[0] / Math.max(noon.sunColor[2], 1e-6);
    const goldenWarmth = golden.sunColor[0] / Math.max(golden.sunColor[2], 1e-6);
    expect(goldenWarmth).toBeGreaterThan(noonWarmth * 1.5);
  });

  it("dims the direct sun monotonically as cloud cover grows while lifting ambient", () => {
    const covers = [0, 0.25, 0.5, 0.75, 1];
    const sunIntensities = covers.map((cloudCover) => evaluateSkyLighting(settingsAt(12, { cloudCover }), 0));
    for (let index = 1; index < sunIntensities.length; index += 1) {
      expect(sunIntensities[index].sunIntensity).toBeLessThan(sunIntensities[index - 1].sunIntensity);
    }
    expect(sunIntensities[4].ambientIntensity).toBeGreaterThan(sunIntensities[0].ambientIntensity);
  });

  it("hides stars at noon and shows them on a clear midnight", () => {
    expect(evaluateSkyLighting(settingsAt(12), 0).starsOpacity).toBeLessThan(0.02);
    expect(evaluateSkyLighting(settingsAt(0), 0).starsOpacity).toBeGreaterThan(0.9);
    // Cloud cover hides stars again.
    expect(evaluateSkyLighting(settingsAt(0, { cloudCover: 1 }), 0).starsOpacity).toBeLessThan(0.02);
  });

  it("switches to dim deep-blue moonlight from above the horizon at night", () => {
    const noon = evaluateSkyLighting(settingsAt(12), 0);
    const midnight = evaluateSkyLighting(settingsAt(0), 0);
    expect(midnight.sunIntensity / noon.sunIntensity).toBeCloseTo(SKY_MOONLIGHT_INTENSITY_RATIO, 10);
    expect(midnight.sunDirection[1]).toBeGreaterThan(0);
    // Deep blue: the blue channel dominates the moon key.
    expect(midnight.sunColor[2]).toBeGreaterThan(midnight.sunColor[0]);
    // Warm horizon key at golden hour, near-white at noon.
    const dusk = evaluateSkyLighting(settingsAt(17.5), 0);
    expect(dusk.sunColor[2]).toBeLessThan(noon.sunColor[2]);
  });

  it("gates the sun disc by solar elevation with a twilight margin below the horizon", () => {
    expect(evaluateSunDiscState(settingsAt(12), 0)).toEqual(evaluateSunDiscState(settingsAt(12), 0));

    const noon = evaluateSunDiscState(settingsAt(12), 0);
    expect(noon.visible).toBe(true);
    expect(noon.discOpacity).toBeGreaterThan(0.9);
    expect(noon.direction[1]).toBeCloseTo(Math.sin(SKY_MAX_SUN_ELEVATION_RADIANS), 10);

    // Shortly after sunset the sun sits at about −5.3°: still inside the
    // twilight margin, so the disc keeps glowing dimly below the horizon.
    const civilTwilight = evaluateSunDiscState(settingsAt(18.3), 0);
    expect(getSkySolarArc(18.3).elevationRadians).toBeGreaterThan(SKY_SUN_DISC_MIN_ELEVATION_RADIANS);
    expect(civilTwilight.visible).toBe(true);
    expect(civilTwilight.direction[1]).toBeLessThan(0);
    expect(civilTwilight.discOpacity).toBeGreaterThan(0);
    expect(civilTwilight.discOpacity).toBeLessThan(noon.discOpacity);

    for (const hours of [18.8, 19.5, 0, 3]) {
      const hidden = evaluateSunDiscState(settingsAt(hours), 0);
      expect(getSkySolarArc(hours).elevationRadians).toBeLessThan(SKY_SUN_DISC_MIN_ELEVATION_RADIANS);
      expect(hidden.visible).toBe(false);
      expect(hidden.discOpacity).toBe(0);
      expect(hidden.glowOpacity).toBe(0);
    }
  });

  it("dims the sun disc through cloud cover and storms while warming toward the horizon", () => {
    const clear = evaluateSunDiscState(settingsAt(12), 0);
    const covered = evaluateSunDiscState(settingsAt(12, { cloudCover: 1 }), 0);
    const storm = evaluateSunDiscState(settingsAt(12, { preset: "storm", intensity: 1, cloudCover: 1 }), 0);
    expect(covered.discOpacity).toBeLessThan(clear.discOpacity);
    expect(storm.discOpacity).toBeLessThan(covered.discOpacity);
    expect(storm.discOpacity).toBeGreaterThan(0);

    // Near the horizon the tint warms and the halo grows relative to the core.
    const dusk = evaluateSunDiscState(settingsAt(17.5), 0);
    expect(dusk.color[2]).toBeLessThan(clear.color[2]);
    expect(dusk.glowOpacity / dusk.discOpacity).toBeGreaterThan(clear.glowOpacity / clear.discOpacity);
  });

  it("darkens storms beyond plain overcast, scaling with storm intensity", () => {
    const clear = evaluateSkyLighting(settingsAt(12, { cloudCover: 0.5 }), 0);
    const overcast = evaluateSkyLighting(settingsAt(12, { preset: "overcast", cloudCover: 0.5 }), 0);
    const mildStorm = evaluateSkyLighting(settingsAt(12, { preset: "storm", intensity: 0.1, cloudCover: 0.5 }), 0);
    const fullStorm = evaluateSkyLighting(settingsAt(12, { preset: "storm", intensity: 1, cloudCover: 0.5 }), 0);

    expect(overcast.sunIntensity).toBeLessThan(clear.sunIntensity);
    expect(fullStorm.sunIntensity).toBeLessThan(overcast.sunIntensity);
    expect(fullStorm.sunIntensity).toBeLessThan(mildStorm.sunIntensity);
    expect(fullStorm.ambientIntensity).toBeLessThan(clear.ambientIntensity);
    expect(fullStorm.skyTurbidity).toBeGreaterThan(clear.skyTurbidity);
  });

  it("exposes ground bounce and aerial fog from the same atmosphere bake", () => {
    const noon = evaluateSkyLighting(settingsAt(12), 0);
    const dusk = evaluateSkyLighting(settingsAt(17.5), 0);
    expect(noon.aerialFogDensity).toBeGreaterThan(0);
    expect(dusk.aerialFogDensity).toBeGreaterThan(0);
    expect(Math.max(...noon.groundColor)).toBeGreaterThan(0);
    expect(dusk.sunColor[2]).toBeLessThan(noon.sunColor[2]);
  });

  it("keeps hemisphere ground a dimmed sky fill, not a grass bounce", () => {
    const noon = evaluateSkyLighting(settingsAt(12), 0);
    expect(noon.groundColor[0]).toBeCloseTo(noon.ambientColor[0] * 0.35, 5);
    expect(noon.groundColor[1]).toBeCloseTo(noon.ambientColor[1] * 0.33, 5);
    expect(noon.groundColor[2]).toBeCloseTo(noon.ambientColor[2] * 0.3, 5);
    expect(noon.groundColor[1]).toBeLessThan(noon.groundColor[2]);
  });

  it("tints daylight ambient from the sky bake so materials pick up sky blue", () => {
    const noon = evaluateSkyLighting(settingsAt(12), 0);
    expect(noon.ambientColor[2]).toBeGreaterThan(noon.ambientColor[0]);
    expect(noon.sunColor[0]).toBeGreaterThan(noon.sunColor[2]);
  });
});
