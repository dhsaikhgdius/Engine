import { beforeEach, describe, expect, it } from "vitest";
import type {
  DirectorWorldSettings,
  WorldWeatherPreset,
} from "../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  blendWorldPresetScalar,
  evaluateWorldClimate,
  evaluateWorldClimateSchedule,
  evaluateWorldWetness,
  getWorldClimateSegmentPreset,
  isWorldWeatherEvolving,
  resetWorldClimateCaches,
  resolveEffectiveWorldSettings,
  WORLD_CLIMATE_NODE_VECTORS,
} from "../../../../src/comprehensive/editor/world/worldClimate";

const SEED = 20_260_813;

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

beforeEach(() => {
  resetWorldClimateCaches();
});

describe("static mode preserves today's numbers", () => {
  it("returns the authored weather block by reference with unit gains", () => {
    for (const preset of ["clear", "overcast", "rain", "snow", "storm"] as const) {
      const settings = makeSettings({ preset, intensity: 0.8, wetness: 0.3, cloudCover: 0.6 });
      const climate = evaluateWorldClimate(settings, 123.4);
      expect(climate.evolving).toBe(false);
      expect(climate.weather).toBe(settings.weather);
      expect(climate.intensity).toBe(0.8);
      expect(climate.wetness).toBe(0.3);
      expect(climate.cloudCover).toBe(0.6);
      expect(climate.windGain).toBe(1);
      expect(climate.preset).toBe(preset);
      expect(resolveEffectiveWorldSettings(settings, climate)).toBe(settings);
    }
  });

  it("maps precipitation levels exactly onto the legacy preset gates", () => {
    const intensity = 0.75;
    const expectRain: Record<WorldWeatherPreset, number> = {
      clear: 0,
      overcast: 0,
      rain: intensity,
      snow: 0,
      storm: intensity,
    };
    for (const preset of Object.keys(expectRain) as WorldWeatherPreset[]) {
      const climate = evaluateWorldClimate(makeSettings({ preset, intensity }), 10);
      expect(climate.rainLevel).toBe(expectRain[preset]);
      expect(climate.snowLevel).toBe(preset === "snow" ? intensity : 0);
      expect(climate.stormFactor).toBe(preset === "storm" ? 1 : 0);
    }
  });

  it("wetness stays the authored constant regardless of time", () => {
    const settings = makeSettings({ preset: "rain", wetness: 0.4 });
    expect(evaluateWorldWetness(settings, 0)).toBe(0.4);
    expect(evaluateWorldWetness(settings, 500)).toBe(0.4);
  });
});

describe("seeded schedule (cycle mode)", () => {
  it("detects evolution mode from the settings", () => {
    expect(isWorldWeatherEvolving(makeSettings())).toBe(false);
    expect(isWorldWeatherEvolving(makeCycleSettings())).toBe(true);
  });

  it("pins segment 0 to the authored preset", () => {
    const settings = makeCycleSettings({ preset: "snow" });
    expect(getWorldClimateSegmentPreset(settings, 0)).toBe("snow");
    const schedule = evaluateWorldClimateSchedule(settings, 5);
    expect(schedule.fromPreset).toBe("snow");
    expect(schedule.toPreset).toBe("snow");
    expect(schedule.blend).toBe(1);
  });

  it("is a pure function of (settings, worldSeconds) — random access matches", () => {
    const settings = makeCycleSettings();
    const times = [700.25, 33.3, 481.9, 0, 1200.5, 481.9];
    const first = times.map((t) => evaluateWorldClimateSchedule(settings, t));
    const second = [...times].reverse().map((t) => evaluateWorldClimateSchedule(settings, t));
    second.reverse();
    expect(second).toEqual(first);
  });

  it("visits more than one preset over a long horizon", () => {
    const settings = makeCycleSettings();
    const seen = new Set<WorldWeatherPreset>();
    for (let segment = 0; segment < 40; segment += 1) seen.add(getWorldClimateSegmentPreset(settings, segment));
    expect(seen.size).toBeGreaterThan(2);
  });

  it("keeps the blended parameter vector continuous across segment boundaries", () => {
    const settings = makeCycleSettings();
    for (let segment = 1; segment <= 8; segment += 1) {
      const boundary = segment * 120;
      const before = evaluateWorldClimate(settings, boundary - 0.05);
      const after = evaluateWorldClimate(settings, boundary + 0.05);
      expect(Math.abs(after.cloudCover - before.cloudCover)).toBeLessThan(0.02);
      expect(Math.abs(after.rainLevel - before.rainLevel)).toBeLessThan(0.02);
      expect(Math.abs(after.windGain - before.windGain)).toBeLessThan(0.02);
      expect(Math.abs(after.stormFactor - before.stormFactor)).toBeLessThan(0.02);
    }
  });

  it("blendWorldPresetScalar interpolates the preset tables", () => {
    const table: Record<WorldWeatherPreset, number> = { clear: 1, overcast: 0.5, rain: 0.4, snow: 0.55, storm: 0.4 };
    expect(
      blendWorldPresetScalar(table, { fromPreset: "clear", toPreset: "rain", blend: 0.5, preset: "rain" }),
    ).toBeCloseTo(0.7, 10);
    expect(
      blendWorldPresetScalar(table, { fromPreset: "storm", toPreset: "storm", blend: 1, preset: "storm" }),
    ).toBe(0.4);
  });
});

describe("wetness integrator (cycle mode)", () => {
  it("integrates up under rain and clamps at 1", () => {
    const settings = makeCycleSettings({ preset: "rain", intensity: 1, wetness: 0 });
    const w30 = evaluateWorldWetness(settings, 30);
    const w60 = evaluateWorldWetness(settings, 60);
    expect(w30).toBeGreaterThan(0.3);
    expect(w60).toBeGreaterThan(w30);
    expect(w60).toBeLessThanOrEqual(1);
    // Segment 0 is pinned to rain; wetness must saturate before the segment ends.
    expect(evaluateWorldWetness(settings, 110)).toBe(1);
  });

  it("dries out under clear and clamps at 0", () => {
    const settings = makeCycleSettings({ preset: "clear", intensity: 1, wetness: 0.5 });
    const w30 = evaluateWorldWetness(settings, 30);
    const w90 = evaluateWorldWetness(settings, 90);
    expect(w30).toBeLessThan(0.5);
    expect(w90).toBeLessThan(w30);
    expect(w90).toBeGreaterThanOrEqual(0);
  });

  it("storm wets faster than rain", () => {
    const rain = makeCycleSettings({ preset: "rain", intensity: 1, wetness: 0 });
    const storm = makeCycleSettings({ preset: "storm", intensity: 1, wetness: 0 });
    expect(evaluateWorldWetness(storm, 20)).toBeGreaterThan(evaluateWorldWetness(rain, 20));
  });

  it("snow contributes less wetness than rain", () => {
    const rain = makeCycleSettings({ preset: "rain", intensity: 1, wetness: 0 });
    const snow = makeCycleSettings({ preset: "snow", intensity: 1, wetness: 0 });
    expect(evaluateWorldWetness(snow, 60)).toBeLessThan(evaluateWorldWetness(rain, 60));
  });

  it("is bit-identical under out-of-order queries (checkpoint replay)", () => {
    const settings = makeCycleSettings({ preset: "rain", intensity: 0.7, wetness: 0.1 });
    // Fresh sequential walk.
    const sequential = [37.7, 90.2, 240.6].map((t) => evaluateWorldWetness(settings, t));
    // Out-of-order queries against a cold cache.
    resetWorldClimateCaches();
    const outOfOrder = [
      evaluateWorldWetness(settings, 240.6),
      evaluateWorldWetness(settings, 37.7),
      evaluateWorldWetness(settings, 90.2),
    ];
    expect(outOfOrder[1]).toBe(sequential[0]);
    expect(outOfOrder[2]).toBe(sequential[1]);
    expect(outOfOrder[0]).toBe(sequential[2]);
  });

  it("the evaluated weather block carries the integrated wetness", () => {
    const settings = makeCycleSettings({ preset: "rain", intensity: 1, wetness: 0 });
    const climate = evaluateWorldClimate(settings, 60);
    expect(climate.weather.wetness).toBe(evaluateWorldWetness(settings, 60));
    expect(climate.weather.wetness).toBeGreaterThan(0.4);
  });
});

describe("node vectors", () => {
  it("cover all five presets with sane ranges", () => {
    for (const [preset, vector] of Object.entries(WORLD_CLIMATE_NODE_VECTORS)) {
      expect(vector.cloudCover).toBeGreaterThanOrEqual(0);
      expect(vector.cloudCover).toBeLessThanOrEqual(1);
      expect(vector.windGain).toBeGreaterThanOrEqual(1);
      expect(vector.wetnessRatePerSecond).toBeGreaterThan(0);
      if (preset === "storm") expect(vector.stormFactor).toBe(1);
      else expect(vector.stormFactor).toBe(0);
    }
  });
});
