import { beforeEach, describe, expect, it } from "vitest";
import type {
  DirectorWorldSettings,
  DirectorWorldWeather,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  computeClimateRoadSurfaceAppearance,
  computeRoadSurfaceAppearance,
  computeTrafficHeadlightFactor,
  TRAFFIC_HEADLIGHT_DAWN_END_HOURS,
  TRAFFIC_HEADLIGHT_DAWN_START_HOURS,
  TRAFFIC_HEADLIGHT_DUSK_END_HOURS,
  TRAFFIC_HEADLIGHT_DUSK_START_HOURS,
  trafficWeatherSpeedScale,
} from "../../../../../src/comprehensive/editor/world/traffic/trafficEnvironment";
import {
  evaluateWorldClimate,
  resetWorldClimateCaches,
} from "../../../../../src/comprehensive/editor/world/worldClimate";

function weather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return {
    preset: "clear",
    intensity: 0.5,
    wetness: 0,
    cloudCover: 0,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldSettings {
  return {
    enabled: true,
    seed: 20_260_813,
    wind: { directionDegrees: 45, speedMps: 2.5, gustiness: 0.35, turbulence: 0.3 },
    timeOfDay: { mode: "fixed", hours: 14, cycleMinutes: 12, drivesSky: false },
    weather: weather(overrides),
  };
}

beforeEach(() => {
  resetWorldClimateCaches();
});

describe("traffic weather speed scale", () => {
  it("keeps the authored limit on clear and overcast days", () => {
    expect(trafficWeatherSpeedScale(weather())).toBe(1);
    expect(trafficWeatherSpeedScale(weather({ preset: "overcast", intensity: 1 }))).toBe(1);
  });

  it("slows storms hardest, snow next, rain moderately — always within [0.55, 1]", () => {
    const rain = trafficWeatherSpeedScale(weather({ preset: "rain", intensity: 1 }));
    const snow = trafficWeatherSpeedScale(weather({ preset: "snow", intensity: 1 }));
    const storm = trafficWeatherSpeedScale(weather({ preset: "storm", intensity: 1 }));
    expect(storm).toBeLessThan(snow);
    expect(snow).toBeLessThan(rain);
    expect(rain).toBeLessThan(1);
    for (const scale of [rain, snow, storm]) {
      expect(scale).toBeGreaterThanOrEqual(0.55);
      expect(scale).toBeLessThanOrEqual(1);
    }
    // Intensity deepens the slowdown.
    expect(trafficWeatherSpeedScale(weather({ preset: "storm", intensity: 0 }))).toBeGreaterThan(storm);
  });
});

describe("traffic headlight factor", () => {
  it("is fully on at night and fully off through the day", () => {
    expect(computeTrafficHeadlightFactor(0)).toBe(1);
    expect(computeTrafficHeadlightFactor(3)).toBe(1);
    expect(computeTrafficHeadlightFactor(23)).toBe(1);
    expect(computeTrafficHeadlightFactor(12)).toBe(0);
    expect(computeTrafficHeadlightFactor(15)).toBe(0);
  });

  it("ramps smoothly across dawn and dusk and wraps hours", () => {
    expect(computeTrafficHeadlightFactor(TRAFFIC_HEADLIGHT_DAWN_START_HOURS)).toBe(1);
    expect(computeTrafficHeadlightFactor(TRAFFIC_HEADLIGHT_DAWN_END_HOURS)).toBe(0);
    const midDawn = computeTrafficHeadlightFactor(
      (TRAFFIC_HEADLIGHT_DAWN_START_HOURS + TRAFFIC_HEADLIGHT_DAWN_END_HOURS) / 2,
    );
    expect(midDawn).toBeGreaterThan(0.4);
    expect(midDawn).toBeLessThan(0.6);
    expect(computeTrafficHeadlightFactor(TRAFFIC_HEADLIGHT_DUSK_START_HOURS)).toBe(0);
    expect(computeTrafficHeadlightFactor(TRAFFIC_HEADLIGHT_DUSK_END_HOURS)).toBe(1);
    expect(computeTrafficHeadlightFactor(26)).toBe(computeTrafficHeadlightFactor(2));
    expect(computeTrafficHeadlightFactor(-2)).toBe(computeTrafficHeadlightFactor(22));
  });

  it("is a pure function so seek(t) equals play-to-t", () => {
    const sequence = [18.2, 6.1, 18.2, 12, 18.2];
    const values = sequence.map(computeTrafficHeadlightFactor);
    expect(values[0]).toBe(values[2]);
    expect(values[0]).toBe(values[4]);
  });
});

describe("road surface appearance", () => {
  it("returns the dry base exactly on clear + wetness 0", () => {
    expect(computeRoadSurfaceAppearance(weather())).toEqual({ colorScale: 1, roughness: 1, snowMix: 0 });
  });

  it("darkens and glazes wet asphalt, whitens under snow only", () => {
    const storm = computeRoadSurfaceAppearance(weather({ preset: "storm", intensity: 1 }));
    expect(storm.colorScale).toBeLessThan(0.6);
    expect(storm.roughness).toBeLessThan(0.4);
    expect(storm.snowMix).toBe(0);
    const snow = computeRoadSurfaceAppearance(weather({ preset: "snow", intensity: 1 }));
    expect(snow.snowMix).toBeGreaterThan(0.5);
    const authored = computeRoadSurfaceAppearance(weather({ wetness: 0.5 }));
    expect(authored.colorScale).toBeCloseTo(1 - 0.45 * 0.5, 10);
  });

  it("climate appearance reproduces the legacy authored appearance exactly in static mode", () => {
    for (const preset of ["clear", "overcast", "rain", "snow", "storm"] as const) {
      for (const intensity of [0, 0.25, 0.6, 1]) {
        for (const wetness of [0, 0.4, 1]) {
          const settings = makeSettings({ preset, intensity, wetness });
          const climate = evaluateWorldClimate(settings, 25);
          expect(computeClimateRoadSurfaceAppearance(climate)).toEqual(
            computeRoadSurfaceAppearance(settings.weather),
          );
        }
      }
    }
  });

  it("climate appearance ramps continuously through an evolving cycle", () => {
    const settings = makeSettings({ preset: "clear", intensity: 1, evolution: { mode: "cycle", periodSeconds: 120 } });
    let previous = computeClimateRoadSurfaceAppearance(evaluateWorldClimate(settings, 0));
    for (let t = 0.5; t <= 900; t += 0.5) {
      const appearance = computeClimateRoadSurfaceAppearance(evaluateWorldClimate(settings, t));
      expect(Math.abs(appearance.colorScale - previous.colorScale)).toBeLessThan(0.03);
      expect(Math.abs(appearance.roughness - previous.roughness)).toBeLessThan(0.04);
      expect(Math.abs(appearance.snowMix - previous.snowMix)).toBeLessThan(0.03);
      previous = appearance;
    }
  });
});
