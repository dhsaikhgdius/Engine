import { describe, expect, it } from "vitest";
import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  FIRE_BURN_FLOOR,
  FIRE_GUTTER_MAX_DEPTH,
  FIRE_PRESET_SUPPRESSION,
  evaluateFireBurnFactor,
  evaluateFireWeatherResponse,
} from "../../../../../src/comprehensive/editor/world/effects/fireSystem";

const SEED_HASH_A = 0x1234_5678;
const SEED_HASH_B = 0x8765_4321;

function createWeather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0.2, ...overrides };
}

describe("fire weather response", () => {
  it("burns fully in dry clear weather with zero guttering", () => {
    const response = evaluateFireWeatherResponse(createWeather());
    expect(response.burn).toBe(1);
    expect(response.gutterDepth).toBe(0);
    // Overcast is dry too: clouds alone never smother a fire.
    expect(evaluateFireWeatherResponse(createWeather({ preset: "overcast", intensity: 1 })).burn).toBe(1);
  });

  it("suppresses monotonically with wetness", () => {
    let previous = 1;
    for (const wetness of [0.2, 0.4, 0.6, 0.8, 1]) {
      const { burn } = evaluateFireWeatherResponse(createWeather({ wetness }));
      expect(burn).toBeLessThan(previous);
      expect(burn).toBeGreaterThanOrEqual(FIRE_BURN_FLOOR);
      previous = burn;
    }
  });

  it("suppresses harder from rain to storm at equal wetness", () => {
    const rain = evaluateFireWeatherResponse(createWeather({ preset: "rain", intensity: 1, wetness: 0.5 }));
    const storm = evaluateFireWeatherResponse(createWeather({ preset: "storm", intensity: 1, wetness: 0.5 }));
    const snow = evaluateFireWeatherResponse(createWeather({ preset: "snow", intensity: 1, wetness: 0.5 }));
    const dry = evaluateFireWeatherResponse(createWeather({ wetness: 0.5 }));
    expect(rain.burn).toBeLessThan(dry.burn);
    expect(storm.burn).toBeLessThan(rain.burn);
    expect(snow.burn).toBeLessThan(dry.burn);
    expect(FIRE_PRESET_SUPPRESSION.storm).toBeGreaterThan(FIRE_PRESET_SUPPRESSION.rain);
  });

  it("scales precipitation suppression with weather intensity", () => {
    const faint = evaluateFireWeatherResponse(createWeather({ preset: "rain", intensity: 0.2 }));
    const heavy = evaluateFireWeatherResponse(createWeather({ preset: "rain", intensity: 1 }));
    expect(heavy.burn).toBeLessThan(faint.burn);
  });

  it("never extinguishes below the authored floor, even fully soaked in a storm", () => {
    const worst = evaluateFireWeatherResponse(createWeather({ preset: "storm", intensity: 1, wetness: 1 }));
    expect(worst.burn).toBe(FIRE_BURN_FLOOR);
    expect(worst.gutterDepth).toBeLessThanOrEqual(FIRE_GUTTER_MAX_DEPTH);
    expect(worst.gutterDepth).toBeGreaterThan(0);
  });

  it("is a pure function of the weather block", () => {
    const weather = createWeather({ preset: "rain", intensity: 0.7, wetness: 0.4 });
    expect(evaluateFireWeatherResponse(weather)).toEqual(evaluateFireWeatherResponse({ ...weather }));
  });
});

describe("fire burn factor guttering", () => {
  it("short-circuits to the steady burn in dry weather", () => {
    const weather = createWeather();
    for (const time of [0, 1.3, 42.7]) {
      expect(evaluateFireBurnFactor(weather, SEED_HASH_A, time)).toBe(1);
    }
  });

  it("is deterministic: identical (weather, seedHash, worldSeconds) tuples agree", () => {
    const weather = createWeather({ preset: "rain", intensity: 1, wetness: 0.6 });
    for (const time of [0, 0.77, 5.31, 123.456]) {
      expect(evaluateFireBurnFactor(weather, SEED_HASH_A, time)).toBe(
        evaluateFireBurnFactor({ ...weather }, SEED_HASH_A, time),
      );
    }
    // Scrubbing back to a time must reproduce the exact same value.
    const before = evaluateFireBurnFactor(weather, SEED_HASH_A, 9.9);
    evaluateFireBurnFactor(weather, SEED_HASH_A, 50);
    expect(evaluateFireBurnFactor(weather, SEED_HASH_A, 9.9)).toBe(before);
  });

  it("gutters over time inside the [floor, steady burn] band", () => {
    const weather = createWeather({ preset: "storm", intensity: 1, wetness: 0.5 });
    const { burn } = evaluateFireWeatherResponse(weather);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let step = 0; step < 300; step += 1) {
      const value = evaluateFireBurnFactor(weather, SEED_HASH_A, step * 0.117);
      expect(value).toBeGreaterThanOrEqual(FIRE_BURN_FLOOR);
      expect(value).toBeLessThanOrEqual(burn);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    // The gutter actually oscillates rather than sitting on one value.
    expect(max - min).toBeGreaterThan(0.02);
  });

  it("decorrelates gutter phases across fires via the seed hash", () => {
    const weather = createWeather({ preset: "rain", intensity: 1, wetness: 0.8 });
    const samples = Array.from({ length: 24 }, (_, index) => index * 0.29);
    const identical = samples.every(
      (time) =>
        evaluateFireBurnFactor(weather, SEED_HASH_A, time) === evaluateFireBurnFactor(weather, SEED_HASH_B, time),
    );
    expect(identical).toBe(false);
  });
});
