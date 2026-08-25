import { beforeEach, describe, expect, it } from "vitest";
import type {
  DirectorWorldSettings,
  DirectorWorldWeather,
  WorldWeatherPreset,
} from "../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  evaluateWorldClimate,
  getWorldClimateSegmentPreset,
  resetWorldClimateCaches,
  WORLD_CLIMATE_NODE_VECTORS,
  type WorldClimateState,
} from "../../../../src/comprehensive/editor/world/worldClimate";
import {
  evaluateSkyLighting,
  evaluateSunDiscState,
} from "../../../../src/comprehensive/editor/world/sky/solar";
import {
  computeClimateAmbientAudioGains,
  computeClimateSnowCover,
  computeClimateSurfaceWetness,
  computeEffectiveWorldSnowCover,
  computeEffectiveWorldWetness,
  computeWorldAmbientAudioGains,
} from "../../../../src/comprehensive/editor/world/surface/worldSurfaceResponse";
import {
  getClimatePrecipitationPlan,
  getWeatherPrecipitationPlan,
} from "../../../../src/comprehensive/editor/world/effects/effectPresets";
import {
  computeWaterBodyLightLevel,
  computeWaterRainAgitation,
  computeWaterSkyReflectionInto,
} from "../../../../src/comprehensive/editor/world/water/waterParams";

/**
 * Cross-system coupling contract: every consumer of the evaluated climate
 * must (a) reproduce today's static-preset numbers bit-for-bit when
 * evolution is off, and (b) vary continuously (no pops) when the seeded
 * cycle ramps the parameter vector.
 */

const SEED = 20_260_813;
const PRESETS: readonly WorldWeatherPreset[] = ["clear", "overcast", "rain", "snow", "storm"];
const INTENSITIES = [0, 0.25, 0.6, 1] as const;

function makeSettings(overrides: Partial<DirectorWorldSettings["weather"]> = {}): DirectorWorldSettings {
  return {
    enabled: true,
    seed: SEED,
    wind: { directionDegrees: 45, speedMps: 2.5, gustiness: 0.35, turbulence: 0.3 },
    timeOfDay: { mode: "fixed", hours: 14, cycleMinutes: 12, drivesSky: false },
    weather: { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0.2, ...overrides },
  };
}

function makeCycleSettings(overrides: Partial<DirectorWorldSettings["weather"]> = {}): DirectorWorldSettings {
  return makeSettings({ evolution: { mode: "cycle", periodSeconds: 120 }, ...overrides });
}

/** Synthetic evolving climate pinned to one node at full hold. */
function makeHoldClimate(preset: WorldWeatherPreset, intensity: number): WorldClimateState {
  const node = WORLD_CLIMATE_NODE_VECTORS[preset];
  const rainLevel = node.rainLevel * intensity;
  const snowLevel = node.snowLevel * intensity;
  const weather: DirectorWorldWeather = {
    preset,
    intensity: Math.max(rainLevel, snowLevel),
    wetness: 0.2,
    cloudCover: node.cloudCover,
  };
  return {
    evolving: true,
    fromPreset: preset,
    toPreset: preset,
    blend: 1,
    preset,
    intensity: weather.intensity,
    cloudCover: node.cloudCover,
    wetness: 0.2,
    rainPresence: node.rainLevel,
    snowPresence: node.snowLevel,
    rainLevel,
    snowLevel,
    windGain: node.windGain,
    stormFactor: node.stormFactor,
    hours: 14,
    weather,
  };
}

/** First segment boundary (>= 1) whose target preset differs from the previous. */
function findTransitionBoundarySeconds(settings: DirectorWorldSettings): number {
  const period = settings.weather.evolution?.periodSeconds ?? 120;
  for (let segment = 1; segment < 64; segment += 1) {
    if (getWorldClimateSegmentPreset(settings, segment) !== getWorldClimateSegmentPreset(settings, segment - 1)) {
      return segment * period;
    }
  }
  throw new Error("no differing segment boundary found in 64 segments");
}

beforeEach(() => {
  resetWorldClimateCaches();
});

describe("solar coupling", () => {
  it("static climate reproduces the legacy sky lighting bit-for-bit", () => {
    for (const preset of PRESETS) {
      for (const intensity of INTENSITIES) {
        const settings = makeSettings({ preset, intensity, cloudCover: 0.4, wetness: 0.1 });
        for (const t of [0, 37.5, 400]) {
          const climate = evaluateWorldClimate(settings, t);
          expect(evaluateSkyLighting(settings, t, climate)).toEqual(evaluateSkyLighting(settings, t));
          expect(evaluateSunDiscState(settings, t, climate)).toEqual(evaluateSunDiscState(settings, t));
        }
      }
    }
  });

  it("sun and ambient intensity ramp continuously across an evolving transition", () => {
    const settings = makeCycleSettings({ preset: "clear", intensity: 1 });
    const boundary = findTransitionBoundarySeconds(settings);
    let previous = evaluateSkyLighting(settings, boundary - 20, evaluateWorldClimate(settings, boundary - 20));
    for (let t = boundary - 19.5; t <= boundary + 130; t += 0.5) {
      const lighting = evaluateSkyLighting(settings, t, evaluateWorldClimate(settings, t));
      // Fixed 14 h time-of-day: only weather moves, so per-half-second steps stay small.
      expect(Math.abs(lighting.sunIntensity - previous.sunIntensity)).toBeLessThan(0.08);
      expect(Math.abs(lighting.ambientIntensity - previous.ambientIntensity)).toBeLessThan(0.05);
      expect(Math.abs(lighting.aerialFogDensity - previous.aerialFogDensity)).toBeLessThan(0.0002);
      previous = lighting;
    }
  });

  it("evolving evaluation is identical for in-order and out-of-order queries", () => {
    const settings = makeCycleSettings({ preset: "overcast", intensity: 0.8 });
    const times = [10, 250, 90, 610, 400, 10, 610];
    const inOrder = new Map<number, ReturnType<typeof evaluateSkyLighting>>();
    for (const t of [...times].sort((a, b) => a - b)) {
      inOrder.set(t, evaluateSkyLighting(settings, t, evaluateWorldClimate(settings, t)));
    }
    resetWorldClimateCaches();
    for (const t of times) {
      expect(evaluateSkyLighting(settings, t, evaluateWorldClimate(settings, t))).toEqual(inOrder.get(t));
    }
  });
});

describe("surface coupling", () => {
  it("static climate wetness/snow match the legacy effective values exactly", () => {
    for (const preset of PRESETS) {
      for (const intensity of INTENSITIES) {
        for (const wetness of [0, 0.4, 1]) {
          const settings = makeSettings({ preset, intensity, wetness });
          const climate = evaluateWorldClimate(settings, 25);
          expect(computeClimateSurfaceWetness(climate)).toBe(computeEffectiveWorldWetness(settings.weather));
          expect(computeClimateSnowCover(climate)).toBe(computeEffectiveWorldSnowCover(settings.weather));
        }
      }
    }
  });

  it("static climate ambient audio gains match the legacy gains exactly", () => {
    for (const preset of PRESETS) {
      for (const intensity of INTENSITIES) {
        const settings = makeSettings({ preset, intensity });
        const climate = evaluateWorldClimate(settings, 5);
        expect(computeClimateAmbientAudioGains(climate, 6)).toEqual(
          computeWorldAmbientAudioGains(settings.weather, 6),
        );
      }
    }
  });

  it("surface wetness floor ramps continuously through an evolving transition", () => {
    const settings = makeCycleSettings({ preset: "clear", intensity: 1 });
    const boundary = findTransitionBoundarySeconds(settings);
    let previous = computeClimateSurfaceWetness(evaluateWorldClimate(settings, boundary - 20));
    for (let t = boundary - 19.5; t <= boundary + 130; t += 0.5) {
      const wetness = computeClimateSurfaceWetness(evaluateWorldClimate(settings, t));
      expect(Math.abs(wetness - previous)).toBeLessThan(0.05);
      previous = wetness;
    }
  });
});

describe("precipitation coupling", () => {
  it("static climate plan equals the legacy weather plan for every preset", () => {
    for (const preset of PRESETS) {
      for (const intensity of INTENSITIES) {
        const settings = makeSettings({ preset, intensity });
        const climate = evaluateWorldClimate(settings, 3);
        expect(getClimatePrecipitationPlan(climate)).toEqual(getWeatherPrecipitationPlan(settings.weather));
      }
    }
  });

  it("an evolving storm hold reproduces the legacy storm particle plan", () => {
    const climate = makeHoldClimate("storm", 0.8);
    const legacy = getWeatherPrecipitationPlan({ preset: "storm", intensity: 0.8, wetness: 0, cloudCover: 1 });
    expect(getClimatePrecipitationPlan(climate)).toEqual(legacy);
  });

  it("particle counts ramp without jumps through an evolving transition", () => {
    const settings = makeCycleSettings({ preset: "clear", intensity: 1 });
    const boundary = findTransitionBoundarySeconds(settings);
    let previous = getClimatePrecipitationPlan(evaluateWorldClimate(settings, boundary - 20))?.count ?? 0;
    for (let t = boundary - 19.5; t <= boundary + 130; t += 0.5) {
      const count = getClimatePrecipitationPlan(evaluateWorldClimate(settings, t))?.count ?? 0;
      // 3520 max instances over a >= 30 s smoothstep ramp: < 150 per half second.
      expect(Math.abs(count - previous)).toBeLessThan(150);
      previous = count;
    }
  });
});

describe("water coupling", () => {
  it("evolving holds land on the legacy preset water numbers", () => {
    for (const preset of PRESETS) {
      const climate = makeHoldClimate(preset, 1);
      const weather = climate.weather;
      expect(computeWaterRainAgitation(weather, climate)).toBeCloseTo(computeWaterRainAgitation(weather), 12);
      expect(computeWaterBodyLightLevel(12, weather, climate)).toBeCloseTo(
        computeWaterBodyLightLevel(12, weather),
        12,
      );
      const horizonA = { r: 0, g: 0, b: 0 };
      const zenithA = { r: 0, g: 0, b: 0 };
      const horizonB = { r: 0, g: 0, b: 0 };
      const zenithB = { r: 0, g: 0, b: 0 };
      computeWaterSkyReflectionInto(horizonA, zenithA, 12, weather, climate);
      computeWaterSkyReflectionInto(horizonB, zenithB, 12, weather);
      expect(horizonA.r).toBeCloseTo(horizonB.r, 12);
      expect(horizonA.g).toBeCloseTo(horizonB.g, 12);
      expect(horizonA.b).toBeCloseTo(horizonB.b, 12);
      expect(zenithA.r).toBeCloseTo(zenithB.r, 12);
    }
  });

  it("rain agitation ramps continuously through an evolving transition", () => {
    const settings = makeCycleSettings({ preset: "clear", intensity: 1 });
    const boundary = findTransitionBoundarySeconds(settings);
    const at = (t: number) => {
      const climate = evaluateWorldClimate(settings, t);
      return computeWaterRainAgitation(climate.weather, climate);
    };
    let previous = at(boundary - 20);
    for (let t = boundary - 19.5; t <= boundary + 130; t += 0.5) {
      const agitation = at(t);
      expect(Math.abs(agitation - previous)).toBeLessThan(0.05);
      previous = agitation;
    }
  });
});

describe("wind gain coupling", () => {
  it("static mode never scales the authored wind", () => {
    for (const preset of PRESETS) {
      expect(evaluateWorldClimate(makeSettings({ preset, intensity: 1 }), 60).windGain).toBe(1);
    }
  });

  it("an evolving storm hold blows harder than clear", () => {
    expect(makeHoldClimate("storm", 1).windGain).toBeGreaterThan(makeHoldClimate("clear", 1).windGain);
    expect(makeHoldClimate("storm", 1).windGain).toBe(WORLD_CLIMATE_NODE_VECTORS.storm.windGain);
  });

  it("wind gain ramps continuously through an evolving transition", () => {
    const settings = makeCycleSettings({ preset: "clear", intensity: 1 });
    const boundary = findTransitionBoundarySeconds(settings);
    let previous = evaluateWorldClimate(settings, boundary - 20).windGain;
    for (let t = boundary - 19.5; t <= boundary + 130; t += 0.5) {
      const gain = evaluateWorldClimate(settings, t).windGain;
      expect(Math.abs(gain - previous)).toBeLessThan(0.05);
      previous = gain;
    }
  });
});
