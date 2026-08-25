import type { CaptureCompareResult } from "../../../../../../packages/protocol/src/captureReconstructionProtocol";

/**
 * Render-and-compare metric for the reconstruction authoring loop: a stage
 * render from a capture camera against the matching capture keyframe. Pure
 * typed-array math (no DOM), so the browser executor, tests, and any future
 * gateway-side scorer share one implementation.
 */

/** Normalized luminance image for cross-resolution comparison. */
export type LuminanceImage = {
  width: number;
  height: number;
  /** Row-major luminance in 0..1. */
  data: Float32Array;
};

/** Aggregate similarity scores between a reference capture and a rendered candidate. */
export type CaptureCompareScore = CaptureCompareResult["score"];

/** Per-cell breakdown of the comparison grid with worst-performing cells. */
export type CaptureCompareGrid = CaptureCompareResult["grid"];

const COMPARE_WIDTH = 128;
const SSIM_C1 = 0.01 ** 2;
const SSIM_C2 = 0.03 ** 2;

/**
 * Converts RGBA pixel data to a normalized luminance image using ITU-R BT.601
 * coefficients, dropping the alpha channel.
 *
 * @param data - Raw RGBA pixel buffer (4 bytes per pixel).
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @returns A luminance image with values in 0..1.
 */
export function luminanceFromRgba(data: Uint8ClampedArray | Uint8Array, width: number, height: number): LuminanceImage {
  const out = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    out[index] = (0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!) / 255;
  }
  return { width, height, data: out };
}

/**
 * Bilinear resample; comparisons always run at a fixed working resolution.
 *
 * @param image - Source luminance image to resample.
 * @param width - Target width in pixels.
 * @param height - Target height in pixels.
 * @returns A new luminance image at the requested resolution, or the original
 *          if it already matches.
 */
export function resampleLuminance(image: LuminanceImage, width: number, height: number): LuminanceImage {
  if (image.width === width && image.height === height) return image;
  const out = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const sourceY = ((row + 0.5) / height) * image.height - 0.5;
    const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(sourceY)));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sourceY - y0));
    for (let col = 0; col < width; col += 1) {
      const sourceX = ((col + 0.5) / width) * image.width - 0.5;
      const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(sourceX)));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sourceX - x0));
      const top = image.data[y0 * image.width + x0]! * (1 - fx) + image.data[y0 * image.width + x1]! * fx;
      const bottom = image.data[y1 * image.width + x0]! * (1 - fx) + image.data[y1 * image.width + x1]! * fx;
      out[row * width + col] = top * (1 - fy) + bottom * fy;
    }
  }
  return { width, height, data: out };
}

function cellStats(image: LuminanceImage, x0: number, y0: number, x1: number, y1: number) {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let row = y0; row < y1; row += 1) {
    for (let col = x0; col < x1; col += 1) {
      const value = image.data[row * image.width + col]!;
      sum += value;
      sumSq += value * value;
      count += 1;
    }
  }
  const mean = count ? sum / count : 0;
  return { mean, variance: count ? Math.max(sumSq / count - mean * mean, 0) : 0, count };
}

function cellCovariance(
  reference: LuminanceImage,
  candidate: LuminanceImage,
  meanA: number,
  meanB: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  let sum = 0;
  let count = 0;
  for (let row = y0; row < y1; row += 1) {
    for (let col = x0; col < x1; col += 1) {
      sum +=
        (reference.data[row * reference.width + col]! - meanA) * (candidate.data[row * candidate.width + col]! - meanB);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

function edgeDensity(image: LuminanceImage, x0: number, y0: number, x1: number, y1: number) {
  let sum = 0;
  let count = 0;
  for (let row = Math.max(y0, 1); row < y1; row += 1) {
    for (let col = Math.max(x0, 1); col < x1; col += 1) {
      const here = image.data[row * image.width + col]!;
      sum +=
        Math.abs(here - image.data[row * image.width + col - 1]!) +
        Math.abs(here - image.data[(row - 1) * image.width + col]!);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Computes SSIM, luminance, and edge-density similarity between two luminance
 * images on a fixed-resolution grid, plus a weighted composite score.
 *
 * Both images are resampled to a common working resolution before comparison.
 * The grid divides the working image into a configurable number of cells; the
 * worst-performing cells are surfaced for diagnostic overlay.
 *
 * @param reference - The reference luminance image (ground truth).
 * @param candidate - The candidate luminance image (rendered frame).
 * @param options - Optional grid dimensions (rows, cols), both clamped to 1–16.
 * @returns A score aggregate and a per-cell grid with worst cells.
 */
export function compareLuminanceImages(
  reference: LuminanceImage,
  candidate: LuminanceImage,
  options: { rows?: number; cols?: number } = {},
): { score: CaptureCompareScore; grid: CaptureCompareGrid } {
  const rows = Math.max(1, Math.min(16, options.rows ?? 8));
  const cols = Math.max(1, Math.min(16, options.cols ?? 8));
  const width = COMPARE_WIDTH;
  const height = Math.max(16, Math.round((COMPARE_WIDTH * reference.height) / Math.max(reference.width, 1)));
  const referenceWorking = resampleLuminance(reference, width, height);
  const candidateWorking = resampleLuminance(candidate, width, height);

  const cellScores: Array<{ row: number; col: number; ssim: number }> = [];
  let ssimSum = 0;
  let luminanceDeltaSum = 0;
  let edgeSimilaritySum = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.floor((col * width) / cols);
      const x1 = Math.floor(((col + 1) * width) / cols);
      const y0 = Math.floor((row * height) / rows);
      const y1 = Math.floor(((row + 1) * height) / rows);
      const statsA = cellStats(referenceWorking, x0, y0, x1, y1);
      const statsB = cellStats(candidateWorking, x0, y0, x1, y1);
      const covariance = cellCovariance(referenceWorking, candidateWorking, statsA.mean, statsB.mean, x0, y0, x1, y1);
      const ssim =
        ((2 * statsA.mean * statsB.mean + SSIM_C1) * (2 * covariance + SSIM_C2)) /
        ((statsA.mean ** 2 + statsB.mean ** 2 + SSIM_C1) * (statsA.variance + statsB.variance + SSIM_C2));
      const boundedSsim = Math.max(-1, Math.min(1, ssim));
      cellScores.push({ row, col, ssim: Number(boundedSsim.toFixed(4)) });
      ssimSum += boundedSsim;
      luminanceDeltaSum += Math.abs(statsA.mean - statsB.mean);
      const edgeA = edgeDensity(referenceWorking, x0, y0, x1, y1);
      const edgeB = edgeDensity(candidateWorking, x0, y0, x1, y1);
      edgeSimilaritySum += 1 - Math.min(1, Math.abs(edgeA - edgeB) / Math.max(edgeA, edgeB, 0.02));
    }
  }

  const cellCount = rows * cols;
  const ssim = ssimSum / cellCount;
  const luminanceSimilarity = Math.max(0, Math.min(1, 1 - luminanceDeltaSum / cellCount));
  const edgeSimilarity = Math.max(0, Math.min(1, edgeSimilaritySum / cellCount));
  const composite = Math.max(0, Math.min(1, 0.5 * ((ssim + 1) / 2) + 0.3 * luminanceSimilarity + 0.2 * edgeSimilarity));
  const worst = [...cellScores].sort((left, right) => left.ssim - right.ssim).slice(0, 8);

  return {
    score: {
      ssim: Number(ssim.toFixed(4)),
      luminanceSimilarity: Number(luminanceSimilarity.toFixed(4)),
      edgeSimilarity: Number(edgeSimilarity.toFixed(4)),
      composite: Number(composite.toFixed(4)),
    },
    grid: { rows, cols, worst },
  };
}
