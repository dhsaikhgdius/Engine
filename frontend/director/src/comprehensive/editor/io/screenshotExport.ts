import type { DirectorDenseMotionFlowField } from "../render/denseMotionFlow";
import type { DirectorDepthFloatCaptureResult } from "../render/depthFloatCapture";
import type { DirectorSemanticCategory } from "../render/semanticPalette";
import type { DirectorShotRenderPassId } from "../shot/shotPackage";

/** Metadata describing the camera, render pass, and encoding of a captured screenshot. */
export interface ScreenshotMeta {
  mode: "director" | "camera";
  cameraId: string | null;
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
  renderPass?: DirectorShotRenderPassId;
  renderEncoding?:
    | "color"
    | "rgba-depth-packed"
    | "view-normal-rgb"
    | "object-id-rgb"
    | "binary-mask-rgb"
    | "base-color-rgb"
    | "roughness-grayscale"
    | "metalness-grayscale"
    | "emissive-rgb"
    | "ambient-occlusion-grayscale"
    | "shadow-matte-grayscale"
    | "semantic-category-rgb"
    | "lineart-binary-rgb"
    | "motion-hsv-rgb"
    | "openpose-coco18-rgb";
  renderColorSpace?: "srgb" | "data";
  bitsPerChannel?: 8;
  raster?: {
    width: number;
    height: number;
  };
  objectIdColors?: Record<string, [number, number, number]>;
  categoryColors?: Record<DirectorSemanticCategory, [number, number, number]>;
  anamorphic?: {
    applied: boolean;
    squeeze: number;
    horizontalFovDegreesBefore: number;
    horizontalFovDegreesAfter: number;
  };
  depthOfField?: {
    applied: boolean;
    quality: "off" | "low" | "high";
    apertureFStop: number;
    focusDistanceM: number;
    sampleCount: number;
    maxBlurPixels: number;
    bypassReason?: "disabled" | "technical-pass" | "zero-blur-budget" | "deep-focus";
  };
  frame?: number;
  revisionRequested?: number;
}

/** A complete screenshot result: a data URL label, the base64 image, its metadata, and optional auxiliary channels. */
export interface ScreenshotResult {
  label: string;
  dataUrl: string;
  meta: ScreenshotMeta;
  /** Float depth readback, present only when the capture requested `depthFloat`. */
  depthFloat?: DirectorDepthFloatCaptureResult;
  /** Dense motion flow field, present only when the capture requested `motionFlowFloat`. */
  motionFlow?: DirectorDenseMotionFlowField;
  /** Raw pass pixels, present only when the internal dataset capture requests them. */
  renderPixels?: {
    width: number;
    height: number;
    format: "rgba8";
    data: Uint8Array;
  };
}

/**
 * Identity passthrough that serves as the canonical builder for ScreenshotMeta.
 * Ensures every capture path constructs metadata through the same shape.
 *
 * @param input - The metadata to passthrough.
 * @returns The same metadata object.
 */
export function buildScreenshotMeta(input: ScreenshotMeta) {
  return input;
}

/** Keeps only object IDs whose exact data-pass color occurs in the captured pixels. */
export function filterVisibleObjectIdColors(
  rgba: Uint8Array,
  objectIdColors: Record<string, [number, number, number]>,
): Record<string, [number, number, number]> {
  const visibleColors = new Set<number>();
  for (let offset = 0; offset < rgba.length; offset += 4) {
    visibleColors.add((rgba[offset]! << 16) | (rgba[offset + 1]! << 8) | rgba[offset + 2]!);
  }

  return Object.fromEntries(
    Object.entries(objectIdColors).filter(([, [red, green, blue]]) =>
      visibleColors.has((red << 16) | (green << 8) | blue),
    ),
  );
}

/**
 * Builds a human-readable file name for a screenshot result.
 *
 * @param result - The screenshot result.
 * @param index - The capture index within the batch.
 * @returns A file name like "storyai-director-desk-director-cameraId-label-1.png".
 */
export function buildCaptureFileName(result: ScreenshotResult, index = 0) {
  const labelSlug = result.label.replace(/\s+/g, "-");
  const cameraSuffix = result.meta.cameraId ? `-${result.meta.cameraId}` : "";
  return `storyai-director-desk-${result.meta.mode}${cameraSuffix}-${labelSlug}-${index + 1}.png`;
}

/**
 * Triggers a browser download of a data URL as a file.
 *
 * @param dataUrl - The base64 data URL to download.
 * @param fileName - The suggested file name for the download.
 */
export function downloadDataUrl(dataUrl: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
}

/**
 * Downloads all screenshot results in a batch as individual PNG files.
 *
 * @param results - The screenshot results to download.
 * @returns The number of files downloaded.
 */
export function downloadCaptureResults(results: ScreenshotResult[]) {
  results.forEach((result, index) => {
    downloadDataUrl(result.dataUrl, buildCaptureFileName(result, index));
  });

  return results.length;
}
