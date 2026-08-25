import { expect, it } from "vitest";
import { createDirectorClippingPlaneInstances } from "../../../../src/comprehensive/editor/canvas/DirectorClippingPlanes";

it("normalizes and applies only enabled project clipping planes", () => {
  const planes = createDirectorClippingPlaneInstances([
    { id: "cut-x", name: "X cut", enabled: true, normal: [2, 0, 0], constant: -4 },
    { id: "off", name: "Disabled", enabled: false, normal: [0, 1, 0], constant: 2 },
  ]);
  expect(planes).toHaveLength(1);
  expect(planes[0]!.normal.toArray()).toEqual([1, 0, 0]);
  expect(planes[0]!.constant).toBe(-2);
});
