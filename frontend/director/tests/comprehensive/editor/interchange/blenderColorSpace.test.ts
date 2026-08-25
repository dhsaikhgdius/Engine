import { describe, expect, it } from "vitest";
import { hexToLinearRgb, linearRgbToHex } from "../../../../src/comprehensive/editor/interchange/blenderColorSpace";

describe("Blender material color boundary", () => {
  it("converts scene-linear mid gray to its sRGB control value", () => {
    expect(linearRgbToHex([0.5, 0.5, 0.5])).toBe("#bcbcbc");
  });

  it("round-trips an sRGB color through Blender scene-linear channels", () => {
    const color = "#804020";
    expect(linearRgbToHex(hexToLinearRgb(color))).toBe(color);
    for (const channel of hexToLinearRgb("#808080")) expect(channel).toBeCloseTo(0.21586, 5);
  });
});
