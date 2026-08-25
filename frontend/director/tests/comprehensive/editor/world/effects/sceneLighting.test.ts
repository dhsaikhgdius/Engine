import { describe, expect, it } from "vitest";
import type { DirectorWorldSettings } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  FIREFLY_DAY_BOOST,
  evaluateEffectsSceneLighting,
} from "../../../../../src/comprehensive/editor/world/effects/sceneLighting";

interface SettingsOverrides {
  hours?: number;
  preset?: DirectorWorldSettings["weather"]["preset"];
  cloudCover?: number;
  intensity?: number;
  timeOfDay?: Partial<DirectorWorldSettings["timeOfDay"]>;
}

function createSettings(overrides: SettingsOverrides = {}): DirectorWorldSettings {
  return {
    enabled: true,
    seed: 20_260_813,
    wind: { directionDegrees: 45, speedMps: 2.5, gustiness: 0.35, turbulence: 0.3 },
    timeOfDay: {
      mode: "fixed",
      hours: overrides.hours ?? 12,
      cycleMinutes: 12,
      drivesSky: true,
      ...overrides.timeOfDay,
    },
    weather: {
      preset: overrides.preset ?? "clear",
      intensity: overrides.intensity ?? 0,
      wetness: 0,
      cloudCover: overrides.cloudCover ?? 0,
    },
  };
}

describe("effects scene light tint", () => {
  it("is a pure function of (settings, worldSeconds)", () => {
    const settings = createSettings({ hours: 9, preset: "rain", cloudCover: 0.6, intensity: 0.7 });
    expect(evaluateEffectsSceneLighting(settings, 12.5)).toEqual(evaluateEffectsSceneLighting(settings, 12.5));
    // Fixed time-of-day mode must ignore worldSeconds entirely.
    expect(evaluateEffectsSceneLighting(settings, 0)).toEqual(evaluateEffectsSceneLighting(settings, 3600));
  });

  it("advances with worldSeconds in cycling day mode", () => {
    // cycleMinutes 12 -> one full day every 720 s; +360 s is solar noon.
    const cycling = createSettings({ timeOfDay: { mode: "cycle", hours: 0 } });
    const midnight = evaluateEffectsSceneLighting(cycling, 0);
    const noon = evaluateEffectsSceneLighting(cycling, 360);
    expect(noon.tintLevel).toBeGreaterThan(midnight.tintLevel);
  });

  it("normalizes an unclouded clear noon to level 1", () => {
    expect(evaluateEffectsSceneLighting(createSettings({ hours: 12 }), 0).tintLevel).toBeCloseTo(1, 5);
  });

  it("keeps a clear midnight inside the dark-silhouette band", () => {
    const { tintColor, tintLevel } = evaluateEffectsSceneLighting(createSettings({ hours: 0 }), 0);
    expect(tintLevel).toBeGreaterThanOrEqual(0.05);
    expect(tintLevel).toBeLessThanOrEqual(0.12);
    // Moonlit chroma: blue leads, red trails.
    expect(tintColor[2]).toBe(1);
    expect(tintColor[0]).toBeLessThan(tintColor[2]);
  });

  it("dims overcast below clear at the same hour", () => {
    for (const hours of [0, 9, 12, 17]) {
      const clear = evaluateEffectsSceneLighting(createSettings({ hours }), 0).tintLevel;
      const overcast = evaluateEffectsSceneLighting(
        createSettings({ hours, preset: "overcast", cloudCover: 0.7 }),
        0,
      ).tintLevel;
      expect(overcast).toBeLessThan(clear);
    }
  });

  it("orders levels noon > dusk > midnight on a clear day", () => {
    const at = (hours: number) => evaluateEffectsSceneLighting(createSettings({ hours }), 0).tintLevel;
    expect(at(12)).toBeGreaterThan(at(17.5));
    expect(at(17.5)).toBeGreaterThan(at(0));
  });

  it("warms the chroma toward dusk", () => {
    const noon = evaluateEffectsSceneLighting(createSettings({ hours: 12 }), 0).tintColor;
    const dusk = evaluateEffectsSceneLighting(createSettings({ hours: 17 }), 0).tintColor;
    // The red:blue ratio rises as the horizon sun reddens the key light.
    expect(dusk[0] / dusk[2]).toBeGreaterThan(noon[0] / noon[2]);
    expect(dusk[0]).toBeGreaterThan(0.9);
  });

  it("keeps the chroma normalized with its max component at 1", () => {
    for (const hours of [0, 3, 6, 9, 12, 15, 18, 21]) {
      const { tintColor } = evaluateEffectsSceneLighting(
        createSettings({ hours, preset: "storm", cloudCover: 1, intensity: 1 }),
        0,
      );
      expect(Math.max(...tintColor)).toBeCloseTo(1, 10);
      for (const channel of tintColor) {
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("firefly night boost", () => {
  it("stays subtle at noon and fully luminous at midnight", () => {
    expect(evaluateEffectsSceneLighting(createSettings({ hours: 12 }), 0).fireflyNightBoost).toBeCloseTo(
      FIREFLY_DAY_BOOST,
      10,
    );
    expect(evaluateEffectsSceneLighting(createSettings({ hours: 0 }), 0).fireflyNightBoost).toBeCloseTo(1, 10);
  });

  it("rises monotonically through dusk", () => {
    const boosts = [12, 17.5, 18, 18.5].map(
      (hours) => evaluateEffectsSceneLighting(createSettings({ hours }), 0).fireflyNightBoost,
    );
    for (let index = 1; index < boosts.length; index += 1) {
      expect(boosts[index]).toBeGreaterThan(boosts[index - 1]);
    }
  });

  it("is bounded to [day boost, 1] and tracks daylight only, not weather", () => {
    for (let hours = 0; hours < 24; hours += 0.25) {
      const clear = evaluateEffectsSceneLighting(createSettings({ hours }), 0);
      expect(clear.fireflyNightBoost).toBeGreaterThanOrEqual(FIREFLY_DAY_BOOST);
      expect(clear.fireflyNightBoost).toBeLessThanOrEqual(1);
      expect(clear.fireflyNightBoost).toBeCloseTo(
        FIREFLY_DAY_BOOST + (1 - FIREFLY_DAY_BOOST) * (1 - clear.daylight),
        10,
      );
      const storm = evaluateEffectsSceneLighting(
        createSettings({ hours, preset: "storm", cloudCover: 1, intensity: 1 }),
        0,
      );
      expect(storm.fireflyNightBoost).toBe(clear.fireflyNightBoost);
    }
  });
});
