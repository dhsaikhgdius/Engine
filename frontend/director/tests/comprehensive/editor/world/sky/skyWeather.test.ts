import { describe, expect, it } from "vitest";
import type { DirectorWorldWeather } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  evaluateSkyWeatherMood,
  resolveSkyWeatherMood,
} from "../../../../../src/comprehensive/editor/world/sky/skyWeather";
import type { WorldClimateState } from "../../../../../src/comprehensive/editor/world/worldClimate";

const PRESETS = ["clear", "overcast", "rain", "snow", "storm"] as const;

function weather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return { preset: "clear", intensity: 0.5, wetness: 0.2, cloudCover: 0.3, ...overrides };
}

/** Synthetic evolving climate mid-transition between two presets. */
function blendClimate(
  fromPreset: (typeof PRESETS)[number],
  toPreset: (typeof PRESETS)[number],
  blend: number,
  block: DirectorWorldWeather,
): WorldClimateState {
  return {
    evolving: true,
    fromPreset,
    toPreset,
    blend,
    preset: blend >= 0.5 ? toPreset : fromPreset,
    intensity: block.intensity,
    cloudCover: block.cloudCover,
    wetness: block.wetness,
    rainPresence: 0,
    snowPresence: 0,
    rainLevel: 0,
    snowLevel: 0,
    windGain: 1,
    stormFactor: 0,
    hours: 14,
    weather: block,
  };
}

describe("evaluateSkyWeatherMood", () => {
  it("is a pure function of the weather block", () => {
    const input = weather({ preset: "storm", intensity: 0.7, cloudCover: 0.4 });
    expect(evaluateSkyWeatherMood(input)).toEqual(evaluateSkyWeatherMood(input));
  });

  it("keeps all five presets pairwise distinct on every appearance channel", () => {
    const moods = PRESETS.map((preset) => evaluateSkyWeatherMood(weather({ preset })));
    const channels = [
      "directTransmission",
      "ambientScale",
      "effectiveCloudCover",
      "starVisibility",
      "cloudOpacityScale",
      "cloudSizeScale",
      "cloudShaderDarkening",
    ] as const;
    for (const channel of channels) {
      const values = moods.map((mood) => mood[channel]);
      expect(new Set(values).size, `${channel} must differ across presets`).toBe(PRESETS.length);
    }
  });

  it("orders direct light and ambient from clear down to storm", () => {
    const [clear, overcast, rain, snow, storm] = PRESETS.map((preset) => evaluateSkyWeatherMood(weather({ preset })));
    expect(clear.directTransmission).toBeGreaterThan(overcast.directTransmission);
    expect(overcast.directTransmission).toBeGreaterThan(rain.directTransmission);
    expect(snow.directTransmission).toBeGreaterThan(rain.directTransmission);
    expect(rain.directTransmission).toBeGreaterThan(storm.directTransmission);
    expect(clear.ambientScale).toBeGreaterThan(overcast.ambientScale);
    expect(overcast.ambientScale).toBeGreaterThan(rain.ambientScale);
    expect(rain.ambientScale).toBeGreaterThan(storm.ambientScale);
    // Snow bounce keeps ambient at or above clear levels.
    expect(snow.ambientScale).toBeGreaterThanOrEqual(clear.ambientScale);
  });

  it("treats intensity as first-class: raising it darkens every non-clear preset", () => {
    for (const preset of ["overcast", "rain", "snow", "storm"] as const) {
      const faint = evaluateSkyWeatherMood(weather({ preset, intensity: 0.1 }));
      const violent = evaluateSkyWeatherMood(weather({ preset, intensity: 1 }));
      expect(violent.directTransmission, `${preset} direct light must drop with intensity`).toBeLessThan(
        faint.directTransmission,
      );
      expect(violent.effectiveCloudCover, `${preset} cover must grow with intensity`).toBeGreaterThanOrEqual(
        faint.effectiveCloudCover,
      );
      expect(violent.starVisibility, `${preset} stars must fade with intensity`).toBeLessThan(faint.starVisibility);
      expect(violent.cloudOpacityScale, `${preset} clouds must thicken with intensity`).toBeGreaterThan(
        faint.cloudOpacityScale,
      );
    }
  });

  it("treats cloudCover as first-class: more cover always means less direct light", () => {
    for (const preset of PRESETS) {
      const covers = [0, 0.25, 0.5, 0.75, 1];
      const transmissions = covers.map(
        (cloudCover) => evaluateSkyWeatherMood(weather({ preset, cloudCover, intensity: 0 })).directTransmission,
      );
      for (let index = 1; index < transmissions.length; index += 1) {
        expect(transmissions[index], `${preset} cover ${covers[index]}`).toBeLessThanOrEqual(transmissions[index - 1]!);
      }
      // On a clear sky the slider must strictly darken; heavy presets may
      // already sit at their coverage floor for low slider values.
      if (preset === "clear") {
        expect(transmissions[4]).toBeLessThan(transmissions[0]!);
      }
    }
  });

  it("floors the effective cover so overcast and storm look covered by default", () => {
    const overcast = evaluateSkyWeatherMood(weather({ preset: "overcast", cloudCover: 0.1 }));
    const storm = evaluateSkyWeatherMood(weather({ preset: "storm", cloudCover: 0.1 }));
    const clear = evaluateSkyWeatherMood(weather({ preset: "clear", cloudCover: 0.1 }));
    expect(clear.effectiveCloudCover).toBeCloseTo(0.1, 10);
    expect(overcast.effectiveCloudCover).toBeGreaterThan(0.7);
    expect(storm.effectiveCloudCover).toBeGreaterThan(overcast.effectiveCloudCover);
    // The authored slider still wins when it is higher than the floor.
    const authored = evaluateSkyWeatherMood(weather({ preset: "overcast", cloudCover: 0.99, intensity: 0 }));
    expect(authored.effectiveCloudCover).toBeCloseTo(0.99, 10);
  });
});

describe("resolveSkyWeatherMood", () => {
  it("without a climate, or while holding one node, it equals the direct evaluation exactly", () => {
    for (const preset of PRESETS) {
      const block = weather({ preset, intensity: 0.7 });
      expect(resolveSkyWeatherMood(block)).toEqual(evaluateSkyWeatherMood(block));
      expect(resolveSkyWeatherMood(block, blendClimate(preset, preset, 0.3, block))).toEqual(
        evaluateSkyWeatherMood(block),
      );
    }
  });

  it("blends every mood channel linearly between the from/to preset moods", () => {
    const block = weather({ preset: "storm", intensity: 0.8, cloudCover: 0.4 });
    const from = evaluateSkyWeatherMood({ ...block, preset: "clear" });
    const to = evaluateSkyWeatherMood({ ...block, preset: "storm" });
    const mid = resolveSkyWeatherMood(block, blendClimate("clear", "storm", 0.25, block));
    for (const channel of Object.keys(from) as Array<keyof typeof from>) {
      expect(mid[channel], channel).toBeCloseTo(from[channel] + (to[channel] - from[channel]) * 0.25, 12);
    }
    // Endpoints land exactly on the pure evaluations.
    expect(resolveSkyWeatherMood(block, blendClimate("clear", "storm", 0, block))).toEqual(from);
    expect(resolveSkyWeatherMood(block, blendClimate("clear", "storm", 1, block))).toEqual(to);
  });
});
