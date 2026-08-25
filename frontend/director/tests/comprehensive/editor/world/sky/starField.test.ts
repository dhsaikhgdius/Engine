import { describe, expect, it } from "vitest";
import {
  createStarFieldPositions,
  createStarFieldTwinkleAttributes,
  evaluateStarTwinkle,
  STAR_FIELD_DEPTH,
  STAR_FIELD_RADIUS,
  STAR_MAX_BRIGHTNESS,
  STAR_MIN_BRIGHTNESS,
  STAR_TWINKLE_MAX_AMOUNT,
  STAR_TWINKLE_MAX_SPEED,
  STAR_TWINKLE_MIN_AMOUNT,
  STAR_TWINKLE_MIN_SPEED,
} from "../../../../../src/comprehensive/editor/world/sky/starField";

describe("seeded star field", () => {
  it("reproduces the identical dome for the same seed and differs across seeds", () => {
    expect(createStarFieldPositions(123)).toEqual(createStarFieldPositions(123));
    expect(createStarFieldPositions(123)).not.toEqual(createStarFieldPositions(124));
  });

  it("keeps every star on the dome shell, mostly above the horizon", () => {
    const positions = createStarFieldPositions(9, 300);
    expect(positions).toHaveLength(300 * 3);
    for (let index = 0; index < positions.length; index += 3) {
      const radius = Math.hypot(positions[index], positions[index + 1], positions[index + 2]);
      expect(radius).toBeGreaterThanOrEqual(STAR_FIELD_RADIUS - 1e-6);
      expect(radius).toBeLessThanOrEqual(STAR_FIELD_RADIUS + STAR_FIELD_DEPTH + 1e-6);
      expect(positions[index + 1]).toBeGreaterThanOrEqual(-0.06 * (STAR_FIELD_RADIUS + STAR_FIELD_DEPTH) - 1e-6);
    }
  });
});

describe("seeded star twinkle", () => {
  it("reproduces identical per-star parameters for the same seed and differs across seeds", () => {
    expect(createStarFieldTwinkleAttributes(123, 64)).toEqual(createStarFieldTwinkleAttributes(123, 64));
    expect(createStarFieldTwinkleAttributes(123, 64)).not.toEqual(createStarFieldTwinkleAttributes(124, 64));
  });

  it("keeps every parameter inside its band and varied across stars", () => {
    const twinkle = createStarFieldTwinkleAttributes(9, 200);
    expect(twinkle.phase).toHaveLength(200);
    for (let index = 0; index < 200; index += 1) {
      expect(twinkle.phase[index]).toBeGreaterThanOrEqual(0);
      expect(twinkle.phase[index]).toBeLessThan(Math.PI * 2);
      expect(twinkle.speed[index]).toBeGreaterThanOrEqual(STAR_TWINKLE_MIN_SPEED);
      expect(twinkle.speed[index]).toBeLessThanOrEqual(STAR_TWINKLE_MAX_SPEED);
      expect(twinkle.amount[index]).toBeGreaterThanOrEqual(STAR_TWINKLE_MIN_AMOUNT);
      expect(twinkle.amount[index]).toBeLessThanOrEqual(STAR_TWINKLE_MAX_AMOUNT);
      expect(twinkle.brightness[index]).toBeGreaterThanOrEqual(STAR_MIN_BRIGHTNESS);
      expect(twinkle.brightness[index]).toBeLessThanOrEqual(STAR_MAX_BRIGHTNESS);
    }
    // Not a uniform dome: neighbouring stars twinkle out of phase.
    expect(new Set(Array.from(twinkle.phase)).size).toBeGreaterThan(150);
  });

  it("is a pure function of worldSeconds that actually varies over time", () => {
    const twinkle = createStarFieldTwinkleAttributes(7, 8);
    const phase = twinkle.phase[0]!;
    const speed = twinkle.speed[0]!;
    const amount = twinkle.amount[0]!;
    expect(evaluateStarTwinkle(phase, speed, amount, 12.5)).toBe(evaluateStarTwinkle(phase, speed, amount, 12.5));
    const samples = Array.from({ length: 48 }, (_, index) => evaluateStarTwinkle(phase, speed, amount, index * 0.4));
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(amount * 0.8);
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(1 - amount - 1e-9);
      expect(sample).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
