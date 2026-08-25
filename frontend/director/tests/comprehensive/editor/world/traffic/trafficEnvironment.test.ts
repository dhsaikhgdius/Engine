import { describe, expect, it } from "vitest";
import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  computeRoadSurfaceAppearance,
  computeTrafficHeadlightFactor,
  TRAFFIC_HEADLIGHT_DAWN_END_HOURS,
  TRAFFIC_HEADLIGHT_DAWN_START_HOURS,
  TRAFFIC_HEADLIGHT_DUSK_END_HOURS,
  TRAFFIC_HEADLIGHT_DUSK_START_HOURS,
  trafficWeatherSpeedScale,
} from "../../../../../src/comprehensive/editor/world/traffic/trafficEnvironment";

function weather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return {
    preset: "clear",
    intensity: 0.5,
    wetness: 0,
    cloudCover: 0,
    ...overrides,
  };
}

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
});
