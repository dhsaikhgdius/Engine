import { describe, expect, it } from "vitest";
import type { DirectorWorldWeather } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  evaluateLightningState,
  LIGHTNING_WINDOW_SECONDS,
} from "../../../../../src/comprehensive/editor/world/sky/lightning";

function weather(preset: DirectorWorldWeather["preset"], intensity: number): DirectorWorldWeather {
  return { preset, intensity, wetness: 0.5, cloudCover: 0.8 };
}

/** Samples just after each window boundary so every strike window is observed once. */
function countActiveWindows(seed: number, intensity: number, windowCount: number): number {
  let active = 0;
  for (let index = 0; index < windowCount; index += 1) {
    const state = evaluateLightningState(seed, index * LIGHTNING_WINDOW_SECONDS + 0.01, weather("storm", intensity));
    if (state.active) active += 1;
  }
  return active;
}

describe("storm lightning", () => {
  it("never flashes outside storms or at zero intensity", () => {
    for (const preset of ["clear", "overcast", "rain", "snow"] as const) {
      for (let t = 0; t < 60; t += 0.37) {
        expect(evaluateLightningState(7, t, weather(preset, 1))).toEqual({ active: false, intensity: 0 });
      }
    }
    expect(evaluateLightningState(7, 12.3, weather("storm", 0))).toEqual({ active: false, intensity: 0 });
  });

  it("is a pure, deterministic function of (seed, worldSeconds, weather)", () => {
    const sampleTimes = Array.from({ length: 400 }, (_, index) => index * 0.13);
    const first = sampleTimes.map((t) => evaluateLightningState(42, t, weather("storm", 0.8)));
    const second = sampleTimes.map((t) => evaluateLightningState(42, t, weather("storm", 0.8)));
    expect(first).toEqual(second);

    const otherSeed = sampleTimes.map((t) => evaluateLightningState(43, t, weather("storm", 0.8)));
    expect(otherSeed.map((state) => state.active)).not.toEqual(first.map((state) => state.active));
  });

  it("strikes more often as storm intensity rises", () => {
    const windows = 8000;
    const faint = countActiveWindows(20260813, 0.2, windows);
    const violent = countActiveWindows(20260813, 1, windows);
    expect(faint).toBeGreaterThan(0);
    expect(violent).toBeGreaterThan(faint * 1.5);
  });

  it("keeps active flash intensity within (0, 1]", () => {
    for (let index = 0; index < 4000; index += 1) {
      const state = evaluateLightningState(5, index * 0.11, weather("storm", 1));
      if (!state.active) {
        expect(state.intensity).toBe(0);
        continue;
      }
      expect(state.intensity).toBeGreaterThan(0);
      expect(state.intensity).toBeLessThanOrEqual(1);
    }
  });
});
