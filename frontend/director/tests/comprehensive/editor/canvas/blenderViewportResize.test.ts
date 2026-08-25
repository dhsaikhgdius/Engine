import { describe, expect, it } from "vitest";
import { getBlenderViewportFov } from "../../../../src/comprehensive/editor/canvas/blenderViewportResize";

describe("getBlenderViewportFov", () => {
  it("keeps the initial field of view at the reference region height", () => {
    expect(getBlenderViewportFov(50, 700, 700)).toBeCloseTo(50, 8);
  });

  it("reveals extra scene area when the editor region grows instead of scaling the existing pixels", () => {
    expect(getBlenderViewportFov(50, 700, 980)).toBeGreaterThan(50);
  });

  it("crops the surrounding scene when the editor region shrinks", () => {
    expect(getBlenderViewportFov(50, 700, 420)).toBeLessThan(50);
  });
});
