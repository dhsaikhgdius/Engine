import { describe, expect, it } from "vitest";
import {
  DIRECTOR_TIMING_CURVE_PRESETS,
  evaluateDirectorTimingCurve,
  getDirectorInterpolationWeight,
} from "../../../../src/comprehensive/editor/schema/animationEasing";

describe("director temporal easing", () => {
  it("resolves CSS-style cubic bezier curves by their x coordinate", () => {
    expect(evaluateDirectorTimingCurve(0, DIRECTOR_TIMING_CURVE_PRESETS.easeInOut)).toBe(0);
    expect(evaluateDirectorTimingCurve(1, DIRECTOR_TIMING_CURVE_PRESETS.easeInOut)).toBe(1);
    expect(evaluateDirectorTimingCurve(0.5, DIRECTOR_TIMING_CURVE_PRESETS.linear)).toBeCloseTo(0.5, 5);
  });

  it("distinguishes ease-in and ease-out motion at the same timeline frame", () => {
    const easeIn = evaluateDirectorTimingCurve(0.25, DIRECTOR_TIMING_CURVE_PRESETS.easeIn);
    const easeOut = evaluateDirectorTimingCurve(0.25, DIRECTOR_TIMING_CURVE_PRESETS.easeOut);
    expect(easeIn).toBeLessThan(0.25);
    expect(easeOut).toBeGreaterThan(0.25);
  });

  it("keeps hold segments discrete and permits intentional y overshoot", () => {
    expect(getDirectorInterpolationWeight("step", 0.99, DIRECTOR_TIMING_CURVE_PRESETS.easeOut)).toBe(0);
    expect(evaluateDirectorTimingCurve(0.75, { x1: 0.2, y1: 0, x2: 0.6, y2: 1.4 })).toBeGreaterThan(1);
  });
});
