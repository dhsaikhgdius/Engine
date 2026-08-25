import { describe, expect, it } from "vitest";
import { createStarFieldPositions, STAR_FIELD_DEPTH, STAR_FIELD_RADIUS } from "../../../../../src/comprehensive/editor/world/sky/starField";

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
