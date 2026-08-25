import { describe, expect, it } from "vitest";
import { compareLuminanceImages, luminanceFromRgba, resampleLuminance, type LuminanceImage } from "../../../../src/comprehensive/editor/reconstruction/captureCompare";

function gradientImage(width: number, height: number, phase = 0): LuminanceImage {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      data[row * width + col] = ((col + phase) % width) / width;
    }
  }
  return { width, height, data };
}

function flatImage(width: number, height: number, value: number): LuminanceImage {
  return { width, height, data: new Float32Array(width * height).fill(value) };
}

describe("luminanceFromRgba", () => {
  it("weights channels with Rec. 709 coefficients", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const image = luminanceFromRgba(rgba, 2, 1);
    expect(image.data[0]).toBeCloseTo(0.2126, 4);
    expect(image.data[1]).toBeCloseTo(0.7152, 4);
  });
});

describe("resampleLuminance", () => {
  it("preserves a constant field at any scale", () => {
    const resampled = resampleLuminance(flatImage(10, 6, 0.4), 64, 48);
    expect(resampled.width).toBe(64);
    expect(Math.min(...resampled.data)).toBeCloseTo(0.4, 5);
    expect(Math.max(...resampled.data)).toBeCloseTo(0.4, 5);
  });
});

describe("compareLuminanceImages", () => {
  it("scores an identical image as a near-perfect match", () => {
    const image = gradientImage(160, 120);
    const { score } = compareLuminanceImages(image, gradientImage(160, 120));
    expect(score.ssim).toBeGreaterThan(0.98);
    expect(score.luminanceSimilarity).toBeGreaterThan(0.99);
    expect(score.composite).toBeGreaterThan(0.95);
  });

  it("ranks a matching render above a mismatched one", () => {
    const reference = gradientImage(160, 120);
    const close = compareLuminanceImages(reference, gradientImage(160, 120, 4));
    const far = compareLuminanceImages(reference, flatImage(160, 120, 0.9));
    expect(close.score.composite).toBeGreaterThan(far.score.composite);
    expect(far.score.ssim).toBeLessThan(close.score.ssim);
  });

  it("handles resolution mismatches by resampling to the reference aspect", () => {
    const { score } = compareLuminanceImages(gradientImage(160, 120), gradientImage(320, 240));
    expect(score.composite).toBeGreaterThan(0.9);
  });

  it("names the worst-agreeing grid cells for targeted correction", () => {
    const reference = flatImage(160, 120, 0.5);
    const candidate = flatImage(160, 120, 0.5);
    // Corrupt the top-left quadrant with noise-like structure.
    for (let row = 0; row < 60; row += 1) {
      for (let col = 0; col < 80; col += 1) {
        candidate.data[row * 160 + col] = (row % 2 === col % 2 ? 0.05 : 0.95) as number;
      }
    }
    const { grid } = compareLuminanceImages(reference, candidate);
    expect(grid.worst.length).toBeGreaterThan(0);
    const worstCell = grid.worst[0]!;
    expect(worstCell.row).toBeLessThan(4);
    expect(worstCell.col).toBeLessThan(4);
  });
});
