import { expect, it } from "vitest";
import { analyzeReferenceImagePixels } from "../../../../src/comprehensive/editor/reconstruction/referenceImageAnalysis";

it("extracts deterministic palette, luminance, edges, and foreground coverage", () => {
  const pixels = new Uint8ClampedArray([
    10, 20, 30, 255, 10, 20, 30, 255, 240, 200, 80, 255, 10, 20, 30, 255, 240, 200, 80, 255, 240, 200, 80, 255,
  ]);
  const metrics = analyzeReferenceImagePixels(pixels, 3, 2);

  expect(metrics).toMatchObject({ width: 3, height: 2 });
  expect(metrics.palette).toEqual(expect.arrayContaining(["#0a141e", "#f0c850"]));
  expect(metrics.meanLuminance).toBeGreaterThan(0.3);
  expect(metrics.edgeDensity).toBeGreaterThan(0);
  expect(metrics.foregroundCoverage).toBeGreaterThan(0);
});

it("rejects pixel buffers whose dimensions are inconsistent", () => {
  expect(() => analyzeReferenceImagePixels(new Uint8ClampedArray(4), 2, 2)).toThrow(/wrong length/);
});
