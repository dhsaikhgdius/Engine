import { describe, expect, it } from "vitest";
import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  collectWorldVegetationObjectIds,
  computeEffectiveWorldSnowCover,
  computeEffectiveWorldWetness,
  computeWorldAmbientAudioGains,
  computeWorldPuddleAmount,
  computeWorldSurfacePorosity,
  computeWorldVegetationWindStrength,
  isWorldVegetationName,
} from "../../../../../src/comprehensive/editor/world/surface/worldSurfaceResponse";

function weather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return {
    preset: "clear",
    intensity: 0.5,
    wetness: 0,
    cloudCover: 0,
    ...overrides,
  };
}

describe("vegetation name detection", () => {
  it("matches foliage names and rejects ordinary blocking meshes", () => {
    expect(isWorldVegetationName("松树_01")).toBe(true);
    expect(isWorldVegetationName("oak-foliage")).toBe(true);
    expect(isWorldVegetationName("grass_clump")).toBe(true);
    expect(isWorldVegetationName("ground-inner")).toBe(false);
    expect(isWorldVegetationName("大厅")).toBe(false);
    expect(isWorldVegetationName("director-primitive-batch-box")).toBe(false);
    expect(
      [...collectWorldVegetationObjectIds([{ id: "oak", name: "oak-foliage" }, { id: "hall", name: "大厅" }])],
    ).toEqual(["oak"]);
  });
});

describe("effective wetness and snow", () => {
  it("keeps a dry clear day dry unless wetness is authored", () => {
    expect(computeEffectiveWorldWetness(weather())).toBe(0);
    expect(computeEffectiveWorldWetness(weather({ wetness: 0.4 }))).toBeCloseTo(0.4, 10);
    expect(computeEffectiveWorldSnowCover(weather())).toBe(0);
  });

  it("wets the set from rain and storm even when the accumulator is 0", () => {
    expect(computeEffectiveWorldWetness(weather({ preset: "rain", intensity: 1, wetness: 0 }))).toBeGreaterThan(0.9);
    expect(computeEffectiveWorldWetness(weather({ preset: "storm", intensity: 1, wetness: 0 }))).toBeGreaterThan(
      computeEffectiveWorldWetness(weather({ preset: "rain", intensity: 1, wetness: 0 })),
    );
    expect(computeEffectiveWorldWetness(weather({ preset: "rain", intensity: 0, wetness: 0 }))).toBeCloseTo(0.55, 10);
  });

  it("covers upward faces under snow and only slightly wets them", () => {
    expect(computeEffectiveWorldSnowCover(weather({ preset: "snow", intensity: 1 }))).toBeGreaterThan(0.9);
    expect(computeEffectiveWorldWetness(weather({ preset: "snow", intensity: 1 }))).toBeLessThan(0.25);
  });

  it("never snows outside the snow preset", () => {
    expect(computeEffectiveWorldSnowCover(weather({ preset: "storm", intensity: 1, wetness: 1 }))).toBe(0);
    expect(computeEffectiveWorldSnowCover(weather({ preset: "rain", intensity: 1 }))).toBe(0);
  });
});

describe("puddle accumulation", () => {
  it("stays perfectly dry on clear + wetness 0 and only pools past damp", () => {
    expect(computeWorldPuddleAmount(weather())).toBe(0);
    expect(computeWorldPuddleAmount(weather({ wetness: 0.45 }))).toBe(0);
    expect(computeWorldPuddleAmount(weather({ wetness: 0.3 }))).toBe(0);
    expect(computeWorldPuddleAmount(weather({ wetness: 1 }))).toBe(1);
  });

  it("pools under rain and storms even with the accumulator at 0", () => {
    const rain = computeWorldPuddleAmount(weather({ preset: "rain", intensity: 1, wetness: 0 }));
    const storm = computeWorldPuddleAmount(weather({ preset: "storm", intensity: 1, wetness: 0 }));
    expect(rain).toBeGreaterThan(0.5);
    expect(storm).toBeGreaterThanOrEqual(rain);
    // Light snow stays below the pooling threshold.
    expect(computeWorldPuddleAmount(weather({ preset: "snow", intensity: 1, wetness: 0 }))).toBe(0);
  });
});

describe("vegetation wind and porosity", () => {
  it("scales sway with wind speed and clamps", () => {
    expect(computeWorldVegetationWindStrength(0)).toBe(0);
    expect(computeWorldVegetationWindStrength(12)).toBe(1);
    expect(computeWorldVegetationWindStrength(40)).toBe(1.25);
  });

  it("gives foliage high porosity and metals almost none", () => {
    expect(computeWorldSurfacePorosity(0, true)).toBeCloseTo(0.85, 10);
    expect(computeWorldSurfacePorosity(0, false)).toBeCloseTo(0.55, 10);
    expect(computeWorldSurfacePorosity(1, false)).toBeCloseTo(0.08, 10);
  });
});

describe("ambient audio gains", () => {
  it("is silent on a still clear day and rises with wind and rain", () => {
    expect(computeWorldAmbientAudioGains(weather({ intensity: 0 }), 0)).toEqual({
      wind: 0,
      rain: 0,
      snow: 0,
      rumble: 0,
    });
    const storm = computeWorldAmbientAudioGains(weather({ preset: "storm", intensity: 1 }), 14);
    expect(storm.wind).toBeCloseTo(0.45, 10);
    expect(storm.rain).toBeGreaterThan(0.9);
    expect(storm.snow).toBe(0);
    const snow = computeWorldAmbientAudioGains(weather({ preset: "snow", intensity: 1 }), 0);
    expect(snow.snow).toBeGreaterThan(0.4);
    expect(snow.rain).toBe(0);
  });

  it("reserves the deep rumble bed for storms", () => {
    expect(computeWorldAmbientAudioGains(weather({ preset: "rain", intensity: 1 }), 0).rumble).toBe(0);
    expect(computeWorldAmbientAudioGains(weather({ preset: "snow", intensity: 1 }), 0).rumble).toBe(0);
    const storm = computeWorldAmbientAudioGains(weather({ preset: "storm", intensity: 1 }), 0);
    expect(storm.rumble).toBeCloseTo(0.7, 10);
    const mild = computeWorldAmbientAudioGains(weather({ preset: "storm", intensity: 0 }), 0);
    expect(mild.rumble).toBeCloseTo(0.25, 10);
  });
});
