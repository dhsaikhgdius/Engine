import { describe, expect, it } from "vitest";
import type {
  DirectorWorldWaterBody,
  DirectorWorldWeather,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  WATER_GROUND_CLEARANCE_M,
  WATER_MAX_SEGMENTS_PER_AXIS,
  WATER_MIN_SEGMENTS_PER_AXIS,
  blendFlowDirectionWithWind,
  computeWaterAmplitudeScale,
  computeWaterDetailPhase,
  computeWaterEnvBlendScale,
  computeWaterMurkiness,
  computeWaterSegmentsForAxis,
  computeWaterSteepnessScale,
  computeWaterSunDirectionInto,
  computeWaterSunIntensity,
  computeWaterTroughLift,
  computeWeatherAmplitudeScale,
  computeWeatherChurn,
  computeWeatherFoamBoost,
  computeWeatherSteepnessScale,
  computeWindAmplitudeScale,
  computeWindDirectionWeight,
  computeWindSteepnessScale,
  createWaterSurfaceParams,
  evaluateFoamCrestMask,
  resolveWaterOccluderHeight,
} from "../../../../../src/comprehensive/editor/world/water/waterParams";

function createWeather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0.2, ...overrides };
}

function createBody(overrides: Partial<DirectorWorldWaterBody> = {}): DirectorWorldWaterBody {
  return {
    id: "water_river_1",
    name: "山间河流",
    surface: { center: [0, 0.5, 0], sizeX: 24, sizeZ: 10, rotationDegrees: 15 },
    waveAmplitude: 0.6,
    waveLengthM: 8,
    flowDirectionDegrees: 45,
    flowSpeedMps: 2,
    colorShallow: "#58c4d9",
    colorDeep: "#0a3f5c",
    opacity: 0.85,
    foamIntensity: 0.6,
    visible: true,
    locked: false,
    ...overrides,
  };
}

describe("water segment adaptation", () => {
  it("is pure and clamped to the protocol budget", () => {
    expect(computeWaterSegmentsForAxis(0.5, 5)).toBe(WATER_MIN_SEGMENTS_PER_AXIS);
    expect(computeWaterSegmentsForAxis(5_000, 200)).toBe(WATER_MAX_SEGMENTS_PER_AXIS);
    expect(computeWaterSegmentsForAxis(30, 12)).toBe(computeWaterSegmentsForAxis(30, 12));
    for (const [size, waveLength] of [
      [0.1, 0.2],
      [7, 3],
      [64, 0.5],
      [900, 40],
    ]) {
      const segments = computeWaterSegmentsForAxis(size, waveLength);
      expect(segments).toBeGreaterThanOrEqual(WATER_MIN_SEGMENTS_PER_AXIS);
      expect(segments).toBeLessThanOrEqual(WATER_MAX_SEGMENTS_PER_AXIS);
      expect(Number.isInteger(segments)).toBe(true);
    }
  });

  it("adds density for short dominant wavelengths", () => {
    expect(computeWaterSegmentsForAxis(30, 1)).toBeGreaterThan(computeWaterSegmentsForAxis(30, 20));
  });
});

describe("wind coupling", () => {
  it("scales amplitude mildly with wind speed and clamps", () => {
    expect(computeWindAmplitudeScale(0)).toBe(1);
    expect(computeWindAmplitudeScale(5)).toBeCloseTo(1.2, 10);
    expect(computeWindAmplitudeScale(100)).toBe(1.6);
    expect(computeWindAmplitudeScale(-3)).toBe(1);
  });

  it("scales choppiness mildly with wind speed and clamps", () => {
    expect(computeWindSteepnessScale(0)).toBe(1);
    expect(computeWindSteepnessScale(5)).toBeCloseTo(1.15, 10);
    expect(computeWindSteepnessScale(100)).toBe(1.45);
  });

  it("caps the wind direction weight below the flow weight", () => {
    expect(computeWindDirectionWeight(0)).toBe(0);
    expect(computeWindDirectionWeight(5)).toBeCloseTo(0.2, 10);
    expect(computeWindDirectionWeight(50)).toBe(0.45);
    expect(computeWindDirectionWeight(50)).toBeLessThan(0.5);
  });

  it("lets wind dominate the travel direction only on still water", () => {
    // Still lake: no current to fight — the cap rises to 0.85.
    expect(computeWindDirectionWeight(50, 0)).toBeCloseTo(0.85, 10);
    // Fast river: authored flow keeps dominance (legacy cap).
    expect(computeWindDirectionWeight(50, 3)).toBe(0.45);
    // The cap interpolates smoothly in between.
    const midCap = computeWindDirectionWeight(50, 0.75);
    expect(midCap).toBeGreaterThan(0.45);
    expect(midCap).toBeLessThan(0.85);
    // Light wind stays below every cap regardless of flow.
    expect(computeWindDirectionWeight(2.5, 0)).toBeCloseTo(0.1, 10);
    expect(computeWindDirectionWeight(2.5, 3)).toBeCloseTo(0.1, 10);
  });

  it("flips the travel direction on a still lake under an opposing gale", () => {
    // Flowing water: authored intent wins even against a 40 m/s gale.
    expect(blendFlowDirectionWithWind(0, 0, -40, 3)).toBeCloseTo(0, 10);
    // Still lake: the same gale takes over (blend lands in the −Z half-plane).
    const flipped = blendFlowDirectionWithWind(0, 0, -40, 0);
    expect(Math.abs(flipped)).toBeGreaterThan(Math.PI / 2);
    // Deterministic.
    expect(blendFlowDirectionWithWind(0, 0, -40, 0)).toBe(blendFlowDirectionWithWind(0, 0, -40, 0));
  });

  it("blends flow and wind directions as a pure, wrap-safe function", () => {
    // No wind: authored flow direction passes through untouched.
    expect(blendFlowDirectionWithWind(90, 0, 0)).toBeCloseTo(Math.PI / 2, 12);
    // Wind aligned with flow leaves the direction unchanged.
    expect(blendFlowDirectionWithWind(90, 10, 0)).toBeCloseTo(Math.PI / 2, 10);
    // Perpendicular wind pulls toward itself but flow stays dominant.
    const pulled = blendFlowDirectionWithWind(0, 10, 0);
    expect(pulled).toBeGreaterThan(0);
    expect(pulled).toBeLessThan(Math.PI / 4);
    // Opposed strong wind cannot flip the flow: authored intent wins.
    expect(blendFlowDirectionWithWind(0, 0, -40)).toBeCloseTo(0, 10);
    // Deterministic.
    expect(blendFlowDirectionWithWind(123, 3, -4)).toBe(blendFlowDirectionWithWind(123, 3, -4));
  });
});

describe("weather coupling", () => {
  it("is the identity in clear weather (old bodies keep their look)", () => {
    const clear = createWeather();
    expect(computeWeatherChurn(clear)).toBe(0);
    expect(computeWeatherAmplitudeScale(clear)).toBe(1);
    expect(computeWeatherSteepnessScale(clear)).toBe(1);
    expect(computeWeatherFoamBoost(clear)).toBe(1);
    expect(computeWaterMurkiness(clear)).toBe(0);
    // Composite scales collapse to the wind-only contract.
    expect(computeWaterAmplitudeScale(5, clear)).toBeCloseTo(computeWindAmplitudeScale(5), 12);
    expect(computeWaterSteepnessScale(5, clear)).toBeCloseTo(computeWindSteepnessScale(5), 12);
  });

  it("raises chop and amplitude with preset severity × intensity", () => {
    const storm = createWeather({ preset: "storm", intensity: 1 });
    const rain = createWeather({ preset: "rain", intensity: 1 });
    const drizzle = createWeather({ preset: "rain", intensity: 0.3 });
    expect(computeWeatherChurn(storm)).toBe(1);
    expect(computeWeatherAmplitudeScale(storm)).toBeCloseTo(1.25, 10);
    expect(computeWeatherSteepnessScale(storm)).toBeCloseTo(1.3, 10);
    expect(computeWeatherAmplitudeScale(rain)).toBeGreaterThan(computeWeatherAmplitudeScale(drizzle));
    expect(computeWeatherAmplitudeScale(drizzle)).toBeGreaterThan(1);
    // Snow barely stirs the surface.
    const snow = createWeather({ preset: "snow", intensity: 1 });
    expect(computeWeatherChurn(snow)).toBeLessThan(0.2);
  });

  it("boosts foam and murk under storm and keeps both deterministic", () => {
    const storm = createWeather({ preset: "storm", intensity: 1, wetness: 1 });
    expect(computeWeatherFoamBoost(storm)).toBeCloseTo(1.8, 10);
    expect(computeWaterMurkiness(storm)).toBeCloseTo(0.95, 10);
    // Post-rain wetness alone keeps a little silt in suspension.
    const afterRain = createWeather({ preset: "clear", intensity: 0.5, wetness: 1 });
    expect(computeWaterMurkiness(afterRain)).toBeCloseTo(0.2, 10);
    expect(computeWeatherFoamBoost(storm)).toBe(computeWeatherFoamBoost({ ...storm }));
    expect(computeWaterMurkiness(storm)).toBe(computeWaterMurkiness({ ...storm }));
  });

  it("recedes the environment-probe mirror as the surface gets agitated", () => {
    const clear = createWeather({ cloudCover: 0 });
    const storm = createWeather({ preset: "storm", intensity: 1 });
    expect(computeWaterEnvBlendScale(0, clear)).toBe(1);
    expect(computeWaterEnvBlendScale(0, storm)).toBeLessThan(0.6);
    expect(computeWaterEnvBlendScale(20, storm)).toBeGreaterThanOrEqual(0.3);
    expect(computeWaterEnvBlendScale(20, clear)).toBeLessThan(computeWaterEnvBlendScale(0, clear));
    // Default settings stay near the calm mirror (old scenes look the same).
    expect(computeWaterEnvBlendScale(2.5, createWeather())).toBeGreaterThan(0.94);
  });
});

describe("foam crest mask", () => {
  it("stays in [0, 1] across crest and intensity sweeps", () => {
    for (let crest = -0.5; crest <= 1.5; crest += 0.125) {
      for (let intensity = 0; intensity <= 1; intensity += 0.25) {
        const mask = evaluateFoamCrestMask(crest, intensity);
        expect(mask).toBeGreaterThanOrEqual(0);
        expect(mask).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is zero without intensity, saturates at the crest, and grows monotonically", () => {
    expect(evaluateFoamCrestMask(1, 0)).toBe(0);
    expect(evaluateFoamCrestMask(1, 1)).toBe(1);
    expect(evaluateFoamCrestMask(0.5, 1)).toBeLessThanOrEqual(evaluateFoamCrestMask(0.7, 1));
    expect(evaluateFoamCrestMask(0.7, 1)).toBeLessThanOrEqual(evaluateFoamCrestMask(0.9, 1));
  });

  it("whitecaps earlier and stronger under a weather foam boost, staying in [0, 1]", () => {
    // Boost 1 is the exact legacy mask.
    expect(evaluateFoamCrestMask(0.7, 0.6, 1)).toBe(evaluateFoamCrestMask(0.7, 0.6));
    // A stormy boost foams crests the clear mask ignores entirely.
    expect(evaluateFoamCrestMask(0.4, 1, 1)).toBe(0);
    expect(evaluateFoamCrestMask(0.4, 1, 1.8)).toBeGreaterThan(0);
    // Monotone in the boost and always clamped.
    for (let crest = 0; crest <= 1; crest += 0.2) {
      const base = evaluateFoamCrestMask(crest, 0.8, 1);
      const boosted = evaluateFoamCrestMask(crest, 0.8, 1.8);
      expect(boosted).toBeGreaterThanOrEqual(base);
      expect(boosted).toBeLessThanOrEqual(1);
      expect(boosted).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("water sun arc", () => {
  it("produces unit directions across the whole day", () => {
    const direction = { x: 0, y: 0, z: 0 };
    for (let hours = 0; hours < 24; hours += 1.5) {
      computeWaterSunDirectionInto(direction, hours);
      expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1, 10);
    }
  });

  it("rises east, culminates high at noon, and dips below the horizon at night", () => {
    const direction = { x: 0, y: 0, z: 0 };
    computeWaterSunDirectionInto(direction, 6);
    expect(direction.x).toBeCloseTo(1, 6);
    expect(direction.y).toBeCloseTo(0, 6);
    computeWaterSunDirectionInto(direction, 12);
    expect(direction.y).toBeGreaterThan(0.8);
    computeWaterSunDirectionInto(direction, 0);
    expect(direction.y).toBeLessThan(-0.8);
  });

  it("dims specular at night and under cloud cover", () => {
    expect(computeWaterSunIntensity(12, 0)).toBeCloseTo(1, 6);
    expect(computeWaterSunIntensity(0, 0)).toBeLessThanOrEqual(0.05);
    expect(computeWaterSunIntensity(12, 1)).toBeLessThan(computeWaterSunIntensity(12, 0));
    expect(computeWaterSunIntensity(0, 1)).toBeGreaterThan(0);
  });
});

describe("water trough lift", () => {
  it("leaves a high lake at its authored mean water level", () => {
    expect(computeWaterTroughLift(2, 0.5, 0)).toBe(0);
    expect(computeWaterTroughLift(1.2, 0.8, 0)).toBe(0);
  });

  it("lifts a shallow pond so troughs stay above the ground plane", () => {
    // 5 cm pond, 8 cm waves: troughs sit 3 cm below ground without lift.
    expect(computeWaterTroughLift(0.05, 0.08, 0)).toBeCloseTo(0.05, 10);
    expect(0.05 - 0.08 + computeWaterTroughLift(0.05, 0.08, 0)).toBeCloseTo(WATER_GROUND_CLEARANCE_M, 10);
  });

  it("raises a pond whose mean sits inside a taller occluder, not just one amplitude", () => {
    // Walkway top 8 cm, pond mean 5 cm, 8 cm waves: troughs are 11 cm below the occluder.
    expect(computeWaterTroughLift(0.05, 0.08, 0.08)).toBeCloseTo(0.13, 10);
    expect(0.05 - 0.08 + computeWaterTroughLift(0.05, 0.08, 0.08)).toBeCloseTo(0.08 + WATER_GROUND_CLEARANCE_M, 10);
    expect(computeWaterTroughLift(0, 0.05, 0)).toBeCloseTo(0.07, 10);
    expect(computeWaterTroughLift(10, 0.4, 0)).toBe(0);
    expect(computeWaterTroughLift(0.02, 0, 0)).toBe(0);
    expect(computeWaterTroughLift(0.1, -0.3, 0)).toBe(0);
  });
});

describe("water occluder sampling", () => {
  it("falls back to the scene ground plane when no sampler is provided", () => {
    expect(resolveWaterOccluderHeight(createBody(), 0)).toBe(0);
    expect(resolveWaterOccluderHeight(createBody(), 1.5)).toBe(1.5);
  });

  it("takes the highest sample under the centre and four corners", () => {
    const body = createBody({
      surface: { center: [10, 0.2, 4], sizeX: 8, sizeZ: 6, rotationDegrees: 0 },
    });
    const sample = (x: number, z: number) => (x > 12 && z > 5 ? 0.4 : 0.05);
    expect(resolveWaterOccluderHeight(body, 0, sample)).toBeCloseTo(0.4, 10);
  });
});

describe("surface params assembly", () => {
  it("is deterministic and decorrelated per body", () => {
    const body = createBody();
    const wind: [number, number, number] = [2.5, 0, 2.5];
    expect(createWaterSurfaceParams(99, body, wind)).toEqual(createWaterSurfaceParams(99, body, wind));

    const other = createWaterSurfaceParams(99, createBody({ id: "water_pond_2" }), wind);
    expect(other.waves.map((wave) => wave.directionOffsetRadians)).not.toEqual(
      createWaterSurfaceParams(99, body, wind).waves.map((wave) => wave.directionOffsetRadians),
    );

    expect(computeWaterDetailPhase(99, "water_river_1")).toBe(computeWaterDetailPhase(99, "water_river_1"));
    expect(computeWaterDetailPhase(99, "water_river_1")).not.toBe(computeWaterDetailPhase(99, "water_pond_2"));
  });

  it("applies the wind scales specified by the coupling contract", () => {
    const body = createBody();
    const params = createWaterSurfaceParams(99, body, [3, 0, 4]);
    // |wind| = 5 m/s → ×(1 + 0.04·5) amplitude, ×(1 + 0.03·5) choppiness.
    expect(params.amplitudeScale).toBeCloseTo(1.2, 10);
    expect(params.steepnessScale).toBeCloseTo(1.15, 10);
    expect(params.waves).toHaveLength(4);
  });

  it("matches the rendered storm response when the frame weather is passed", () => {
    const body = createBody();
    const wind: [number, number, number] = [3, 0, 4];
    const storm = createWeather({ preset: "storm", intensity: 1 });
    const stormParams = createWaterSurfaceParams(99, body, wind, storm);
    // Buoyancy consumers get the exact GPU scales: wind × weather.
    expect(stormParams.amplitudeScale).toBeCloseTo(computeWaterAmplitudeScale(5, storm), 12);
    expect(stormParams.steepnessScale).toBeCloseTo(computeWaterSteepnessScale(5, storm), 12);
    // Clear weather (or omitting it) reproduces the legacy wind-only params.
    const clearParams = createWaterSurfaceParams(99, body, wind, createWeather());
    const legacyParams = createWaterSurfaceParams(99, body, wind);
    expect(clearParams.amplitudeScale).toBeCloseTo(legacyParams.amplitudeScale, 12);
    expect(clearParams.baseDirectionRadians).toBe(legacyParams.baseDirectionRadians);
  });
});
