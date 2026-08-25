import { describe, expect, it } from "vitest";
import type { DirectorWorldWeather } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  createLightningBoltPolyline,
  evaluateLightningState,
  LIGHTNING_BOLT_MAX_DISTANCE,
  LIGHTNING_BOLT_MAX_JITTER,
  LIGHTNING_BOLT_MAX_TOP_HEIGHT,
  LIGHTNING_BOLT_MIN_DISTANCE,
  LIGHTNING_BOLT_MIN_TOP_HEIGHT,
  LIGHTNING_BOLT_POINT_COUNT,
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

  it("replays strike moments bit-identically regardless of scrub order", () => {
    const storm = weather("storm", 0.8);
    const times = Array.from({ length: 600 }, (_, index) => index * 0.117);
    const forward = times.map((t) => evaluateLightningState(11, t, storm));
    const shuffled = [...times].reverse().map((t) => evaluateLightningState(11, t, storm));
    shuffled.reverse();
    expect(shuffled).toEqual(forward);
    // Every active flash names the window it belongs to, so overlays can
    // rebuild the identical bolt for the identical moment.
    for (let index = 0; index < forward.length; index += 1) {
      const state = forward[index]!;
      if (!state.active) continue;
      expect(state.strikeWindowIndex).toBe(Math.floor(times[index]! / LIGHTNING_WINDOW_SECONDS));
    }
  });

  it("flashes brighter on average as storm intensity rises", () => {
    const averagePeakIntensity = (intensity: number): number => {
      let sum = 0;
      let strikes = 0;
      for (let index = 0; index < 8000; index += 1) {
        const state = evaluateLightningState(3, index * LIGHTNING_WINDOW_SECONDS + 0.01, weather("storm", intensity));
        if (!state.active) continue;
        sum += state.intensity;
        strikes += 1;
      }
      expect(strikes).toBeGreaterThan(0);
      return sum / strikes;
    };
    expect(averagePeakIntensity(1)).toBeGreaterThan(averagePeakIntensity(0.2) * 1.8);
  });
});

describe("lightning bolt polyline", () => {
  it("is a pure function of (seed, strikeWindowIndex)", () => {
    expect(createLightningBoltPolyline(42, 137)).toEqual(createLightningBoltPolyline(42, 137));
    expect(createLightningBoltPolyline(42, 137)).not.toEqual(createLightningBoltPolyline(42, 138));
    expect(createLightningBoltPolyline(42, 137)).not.toEqual(createLightningBoltPolyline(43, 137));
  });

  it("runs top-to-ground inside the cloud shell with bounded jag", () => {
    for (const window of [0, 7, 991, 123456]) {
      const points = createLightningBoltPolyline(20260813, window);
      expect(points).toHaveLength(LIGHTNING_BOLT_POINT_COUNT * 3);
      const topY = points[1]!;
      expect(topY).toBeGreaterThanOrEqual(LIGHTNING_BOLT_MIN_TOP_HEIGHT);
      expect(topY).toBeLessThanOrEqual(LIGHTNING_BOLT_MAX_TOP_HEIGHT);
      expect(points[(LIGHTNING_BOLT_POINT_COUNT - 1) * 3 + 1]).toBe(0);
      for (let joint = 1; joint < LIGHTNING_BOLT_POINT_COUNT; joint += 1) {
        // The channel strictly descends; only lateral jag varies per joint.
        expect(points[joint * 3 + 1]!).toBeLessThan(points[(joint - 1) * 3 + 1]!);
        const planar = Math.hypot(points[joint * 3]!, points[joint * 3 + 2]!);
        expect(planar).toBeGreaterThan(LIGHTNING_BOLT_MIN_DISTANCE - 2 * LIGHTNING_BOLT_MAX_JITTER);
        expect(planar).toBeLessThan(LIGHTNING_BOLT_MAX_DISTANCE + 2 * LIGHTNING_BOLT_MAX_JITTER);
      }
    }
  });

  it("keeps the geometry streams from perturbing strike moments", () => {
    const storm = weather("storm", 1);
    const before = Array.from({ length: 2000 }, (_, index) =>
      evaluateLightningState(9, index * LIGHTNING_WINDOW_SECONDS + 0.01, storm).active,
    );
    // Building bolts for arbitrary windows consumes no shared state...
    for (let window = 0; window < 500; window += 7) createLightningBoltPolyline(9, window);
    const after = Array.from({ length: 2000 }, (_, index) =>
      evaluateLightningState(9, index * LIGHTNING_WINDOW_SECONDS + 0.01, storm).active,
    );
    // ...so the strike pattern is unchanged.
    expect(after).toEqual(before);
  });
});
