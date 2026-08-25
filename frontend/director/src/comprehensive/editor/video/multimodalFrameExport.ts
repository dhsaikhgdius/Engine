import {
  DIRECTOR_DENSE_MOTION_FLOW_SEMANTICS,
  type DirectorDenseMotionFlowField,
  type DirectorDenseMotionFlowSemantics,
} from "../render/denseMotionFlow";
import type { DirectorDepthFloatCaptureResult } from "../render/depthFloatCapture";
import { encodeExrDepth, encodeExrMotionFlow } from "../render/exrEncoder";
import type { DirectorSemanticCategory } from "../render/semanticPalette";
import type { DirectorShotIr } from "../shot/shotIr";
import {
  DIRECTOR_DEPTH_EXR_PATH_TEMPLATE,
  DIRECTOR_MOTION_FLOW_EXR_PATH_TEMPLATE,
  DIRECTOR_SHOT_RENDER_PASS_IDS,
  stableArtifactStringify,
  type DirectorShotDepthSemantics,
  type DirectorShotRenderPassId,
} from "../shot/shotPackage";
import {
  getDirectorDeterministicFramePlan,
  inspectDirectorPng,
  type DirectorPngFrameSource,
} from "./deterministicFrameExport";
import { createDeterministicZipArchive, type DeterministicZipEntry } from "./deterministicZip";
import { buildDirectorInstanceAnnotations } from "./instanceAnnotations";

const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

/** Which render passes and auxiliary channels to include in the multimodal export. */
export interface DirectorMultimodalFrameExportSelection {
  renderPasses: DirectorShotRenderPassId[];
  includeCamera: boolean;
  includeObjects: boolean;
  /**
   * Opt-in dense per-pixel motion flow as a float EXR per frame
   * (passes/motion/frame-{frame:06}.exr). The key is serialized into the
   * manifest only when true, so absent and false both keep the default
   * package bytes byte-identical to packages produced before this option.
   */
  denseMotionExr?: boolean;
  /** Opt-in metric linear eye-depth EXR beside the selected depth PNG. */
  depthExr?: boolean;
  /** Opt-in visible instance colors, pixel counts, and 2D bounds per frame. */
  includeInstanceAnnotations?: boolean;
}

/** A single render pass capture, optionally with depth float, object-id, and category data. */
export interface DirectorMultimodalPassCapture {
  image: DirectorPngFrameSource;
  depthFloat?: DirectorDepthFloatCaptureResult;
  renderPixels?: { width: number; height: number; data: Uint8Array };
  objectIdColors?: Record<string, [number, number, number]>;
  categoryColors?: Record<DirectorSemanticCategory, [number, number, number]>;
}

export type DirectorMultimodalPassCaptureSource = DirectorPngFrameSource | DirectorMultimodalPassCapture;

/** One artifact in the multimodal package manifest — a PNG, EXR, or JSON file. */
export interface DirectorMultimodalFrameArtifact {
  path: string;
  byteLength: number;
  sha256: `sha256:${string}`;
  frame?: number;
  renderPass?: DirectorShotRenderPassId;
  kind:
    | "render-pass"
    | "frame-metadata"
    | "motion-flow-exr"
    | "depth-exr"
    | "instance-annotations"
    | "segmentation-metadata";
  /** Present only on float-EXR artifacts; PNG passes stay untagged. */
  encoding?: "exr";
  depthSemantics?: DirectorShotDepthSemantics;
}

/** The manifest for a multimodal frame package, describing all artifacts and their hashes. */
export interface DirectorMultimodalFrameManifest {
  schemaVersion: 1;
  contract: "director-multimodal-frame-package-v1";
  sourceFrameStart: number;
  sourceFrameEnd: number;
  frameCount: number;
  fps: number;
  raster: { width: number; height: number };
  selection: DirectorMultimodalFrameExportSelection;
  artifacts: DirectorMultimodalFrameArtifact[];
  /** Present only when the dense motion flow EXR channel is enabled. */
  motionFlowSemantics?: DirectorDenseMotionFlowSemantics;
  packageFingerprint: `sha256:${string}`;
}

/** Options for the multimodal frame package export. */
export interface ExportDirectorMultimodalFramePackageOptions {
  frameStart: number;
  frameEnd: number;
  fps: number;
  selection: DirectorMultimodalFrameExportSelection;
  signal?: AbortSignal;
  maxCaptureBytes?: number;
  capturePass: (
    frame: number,
    renderPass: DirectorShotRenderPassId,
    signal?: AbortSignal,
  ) => Promise<DirectorMultimodalPassCaptureSource>;
  /** Required when selection.denseMotionExr is set; must match the PNG raster. */
  captureMotionFlow?: (frame: number, signal?: AbortSignal) => Promise<DirectorDenseMotionFlowField>;
  buildShotIr: (frame: number) => DirectorShotIr;
  onProgress?: (progress: number, frame: number, renderPass: DirectorShotRenderPassId) => void;
}

/** The completed multimodal frame package export result. */
export interface DirectorMultimodalFramePackageExport {
  kind: "multimodal-dataset";
  extension: "zip";
  fileName: "director-multimodal-frames.zip";
  archive: Blob;
  manifest: DirectorMultimodalFrameManifest;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Multimodal frame export was aborted.", "AbortError");
}

function normalizeSelection(selection: DirectorMultimodalFrameExportSelection): DirectorMultimodalFrameExportSelection {
  if (!selection.renderPasses.length) throw new Error("Select at least one render pass.");
  const unique = new Set(selection.renderPasses);
  if (unique.size !== selection.renderPasses.length) throw new Error("Render-pass selection contains duplicates.");
  for (const pass of unique) {
    if (!DIRECTOR_SHOT_RENDER_PASS_IDS.includes(pass)) throw new Error(`Unsupported render pass "${pass}".`);
  }
  if (selection.depthExr === true && !unique.has("depth")) {
    throw new Error('Metric depth EXR requires the "depth" render pass.');
  }
  return {
    renderPasses: DIRECTOR_SHOT_RENDER_PASS_IDS.filter((pass) => unique.has(pass)),
    includeCamera: selection.includeCamera,
    includeObjects: selection.includeObjects,
    // Serialized only when enabled: a false/absent flag must not change the
    // manifest bytes of packages exported before this option existed.
    ...(selection.denseMotionExr === true ? { denseMotionExr: true as const } : {}),
    ...(selection.depthExr === true ? { depthExr: true as const } : {}),
    ...(selection.includeInstanceAnnotations === true ? { includeInstanceAnnotations: true as const } : {}),
  };
}

function normalizeCapture(source: DirectorMultimodalPassCaptureSource): DirectorMultimodalPassCapture {
  if (typeof source === "object" && source !== null && "image" in source) return source;
  return { image: source };
}

async function toBytes(source: DirectorPngFrameSource, remainingBytes: number): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (typeof source === "string") {
    const match = /^data:image\/png;base64,([a-z\d+/=\s]+)$/i.exec(source);
    if (!match) throw new Error("Multimodal render pass must return a base64 PNG data URL.");
    const binary = atob(match[1]!.replace(/\s+/g, ""));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } else if (source instanceof Blob) {
    bytes = new Uint8Array(await source.arrayBuffer());
  } else if (source instanceof Uint8Array) {
    bytes = new Uint8Array(source);
  } else {
    bytes = new Uint8Array(source);
  }
  if (bytes.byteLength > remainingBytes) throw new Error("Multimodal capture exceeds the configured memory limit.");
  inspectDirectorPng(bytes);
  return bytes;
}

async function sha256(value: Uint8Array | string): Promise<`sha256:${string}`> {
  // Digest the view directly; see shotPackage.ts sha256 for the realm rationale.
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function passPath(renderPass: DirectorShotRenderPassId, frame: number): string {
  return `passes/${renderPass}/frame-${String(frame).padStart(6, "0")}.png`;
}

function motionFlowExrPath(frame: number): string {
  return DIRECTOR_MOTION_FLOW_EXR_PATH_TEMPLATE.replace("{frame:06}", String(frame).padStart(6, "0"));
}

function depthExrPath(frame: number): string {
  return DIRECTOR_DEPTH_EXR_PATH_TEMPLATE.replace("{frame:06}", String(frame).padStart(6, "0"));
}

function instanceAnnotationsPath(frame: number): string {
  return `annotations/instances/frame-${String(frame).padStart(6, "0")}.json`;
}

function segmentationMetadataPath(renderPass: "object-id" | "semantic", frame: number): string {
  return `metadata/segmentation/${renderPass}/frame-${String(frame).padStart(6, "0")}.json`;
}

/**
 * Export a multimodal frame package: a deterministic ZIP archive containing
 * render passes (PNG), optional EXR depth/motion flow, instance annotations,
 * segmentation metadata, and per-frame JSONL metadata.
 *
 * @param options - The export options including frame range, FPS, selection, and callbacks.
 * @returns The completed multimodal package with archive blob and manifest.
 */
export async function exportDirectorMultimodalFramePackage(
  options: ExportDirectorMultimodalFramePackageOptions,
): Promise<DirectorMultimodalFramePackageExport> {
  const selection = normalizeSelection(options.selection);
  if (selection.denseMotionExr && !options.captureMotionFlow) {
    throw new Error("Dense motion flow EXR export requires a captureMotionFlow callback.");
  }
  const plan = getDirectorDeterministicFramePlan(options.frameStart, options.frameEnd, options.fps, options.fps);
  const maximumBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("maxCaptureBytes must be a positive safe integer.");
  }

  const entries: DeterministicZipEntry[] = [];
  const artifacts: DirectorMultimodalFrameArtifact[] = [];
  const metadataRows: string[] = [];
  let captureBytes = 0;
  let raster: { width: number; height: number } | null = null;
  const capturesPerFrame =
    selection.renderPasses.length +
    (selection.denseMotionExr ? 1 : 0) +
    (selection.includeInstanceAnnotations && !selection.renderPasses.includes("object-id") ? 1 : 0);
  const totalCaptures = plan.length * capturesPerFrame;
  let completedCaptures = 0;

  for (const sample of plan) {
    throwIfAborted(options.signal);
    const captures = new Map<DirectorShotRenderPassId, DirectorMultimodalPassCapture>();
    let shotIr: DirectorShotIr | undefined;
    const getShotIr = () => (shotIr ??= options.buildShotIr(sample.sourceFrame));
    for (const renderPass of selection.renderPasses) {
      const capture = normalizeCapture(await options.capturePass(sample.sourceFrame, renderPass, options.signal));
      captures.set(renderPass, capture);
      const bytes = await toBytes(capture.image, maximumBytes - captureBytes);
      throwIfAborted(options.signal);
      const dimensions = inspectDirectorPng(bytes);
      if (!raster) raster = dimensions;
      if (dimensions.width !== raster.width || dimensions.height !== raster.height) {
        throw new Error(
          `Render pass ${renderPass} at frame ${sample.sourceFrame} is ${dimensions.width}x${dimensions.height}; expected ${raster.width}x${raster.height}.`,
        );
      }
      captureBytes += bytes.byteLength;
      const path = passPath(renderPass, sample.sourceFrame);
      entries.push({ path, bytes });
      artifacts.push({
        path,
        byteLength: bytes.byteLength,
        sha256: await sha256(bytes),
        frame: sample.sourceFrame,
        renderPass,
        kind: "render-pass",
      });
      completedCaptures += 1;
      options.onProgress?.(completedCaptures / totalCaptures, sample.sourceFrame, renderPass);

      const segmentationRenderPass = renderPass === "object-id" || renderPass === "semantic" ? renderPass : null;
      const segmentationColors =
        renderPass === "object-id" && capture.objectIdColors
          ? { objectIdToRgb: capture.objectIdColors }
          : renderPass === "semantic" && capture.categoryColors
            ? { categoryToRgb: capture.categoryColors }
            : null;
      if (segmentationRenderPass && segmentationColors) {
        const metadataBytes = new TextEncoder().encode(
          `${stableArtifactStringify({
            schemaVersion: 1,
            contract: "director-segmentation-metadata-v1",
            frame: sample.sourceFrame,
            renderPass,
            raster: { ...dimensions, origin: "top-left" },
            encoding: renderPass === "object-id" ? "object-id-rgb" : "semantic-category-rgb",
            colorSpace: "data",
            ...segmentationColors,
          })}\n`,
        );
        if (metadataBytes.byteLength > maximumBytes - captureBytes) {
          throw new Error("Multimodal capture exceeds the configured memory limit.");
        }
        captureBytes += metadataBytes.byteLength;
        const metadataPath = segmentationMetadataPath(segmentationRenderPass, sample.sourceFrame);
        entries.push({ path: metadataPath, bytes: metadataBytes });
        artifacts.push({
          path: metadataPath,
          byteLength: metadataBytes.byteLength,
          sha256: await sha256(metadataBytes),
          frame: sample.sourceFrame,
          renderPass,
          kind: "segmentation-metadata",
        });
      }

      if (selection.depthExr && renderPass === "depth") {
        const depthFloat = capture.depthFloat;
        if (!depthFloat) throw new Error(`Metric depth EXR at frame ${sample.sourceFrame} requires float depth data.`);
        if (depthFloat.metadata.width !== raster.width || depthFloat.metadata.height !== raster.height) {
          throw new Error(
            `Metric depth at frame ${sample.sourceFrame} is ${depthFloat.metadata.width}x${depthFloat.metadata.height}; expected ${raster.width}x${raster.height}.`,
          );
        }
        const depthBytes = encodeExrDepth({
          width: depthFloat.metadata.width,
          height: depthFloat.metadata.height,
          data: depthFloat.depth,
        });
        if (depthBytes.byteLength > maximumBytes - captureBytes) {
          throw new Error("Multimodal capture exceeds the configured memory limit.");
        }
        captureBytes += depthBytes.byteLength;
        const depthPath = depthExrPath(sample.sourceFrame);
        entries.push({ path: depthPath, bytes: depthBytes });
        artifacts.push({
          path: depthPath,
          byteLength: depthBytes.byteLength,
          sha256: await sha256(depthBytes),
          frame: sample.sourceFrame,
          renderPass: "depth",
          kind: "depth-exr",
          encoding: "exr",
          depthSemantics: depthFloat.metadata.depthSemantics,
        });
      }
    }

    if (selection.includeInstanceAnnotations) {
      let objectIdCapture = captures.get("object-id");
      if (!objectIdCapture) {
        objectIdCapture = normalizeCapture(await options.capturePass(sample.sourceFrame, "object-id", options.signal));
        completedCaptures += 1;
        options.onProgress?.(completedCaptures / totalCaptures, sample.sourceFrame, "object-id");
      }
      if (!objectIdCapture.renderPixels || !objectIdCapture.objectIdColors) {
        throw new Error("Instance annotations require object-id pixels and color metadata.");
      }
      const { width, height, data } = objectIdCapture.renderPixels;
      if (!raster || width !== raster.width || height !== raster.height) {
        throw new Error(
          `Object-id pixels at frame ${sample.sourceFrame} are ${width}x${height}; expected ${raster?.width}x${raster?.height}.`,
        );
      }
      const annotations = buildDirectorInstanceAnnotations({
        frame: sample.sourceFrame,
        width,
        height,
        rgba: data,
        objectIdToRgb: objectIdCapture.objectIdColors,
        shotIr: getShotIr(),
      });
      const annotationBytes = new TextEncoder().encode(`${stableArtifactStringify(annotations)}\n`);
      if (annotationBytes.byteLength > maximumBytes - captureBytes) {
        throw new Error("Multimodal capture exceeds the configured memory limit.");
      }
      captureBytes += annotationBytes.byteLength;
      const annotationPath = instanceAnnotationsPath(sample.sourceFrame);
      entries.push({ path: annotationPath, bytes: annotationBytes });
      artifacts.push({
        path: annotationPath,
        byteLength: annotationBytes.byteLength,
        sha256: await sha256(annotationBytes),
        frame: sample.sourceFrame,
        kind: "instance-annotations",
      });
    }

    if (selection.denseMotionExr) {
      const flowField = await options.captureMotionFlow!(sample.sourceFrame, options.signal);
      throwIfAborted(options.signal);
      // The PNG passes above guarantee the raster is known by now.
      if (!raster || flowField.metadata.width !== raster.width || flowField.metadata.height !== raster.height) {
        throw new Error(
          `Dense motion flow at frame ${sample.sourceFrame} is ${flowField.metadata.width}x${flowField.metadata.height}; expected ${raster?.width}x${raster?.height}.`,
        );
      }
      const bytes = encodeExrMotionFlow({
        width: flowField.metadata.width,
        height: flowField.metadata.height,
        data: flowField.flow,
      });
      if (bytes.byteLength > maximumBytes - captureBytes) {
        throw new Error("Multimodal capture exceeds the configured memory limit.");
      }
      captureBytes += bytes.byteLength;
      const path = motionFlowExrPath(sample.sourceFrame);
      entries.push({ path, bytes });
      artifacts.push({
        path,
        byteLength: bytes.byteLength,
        sha256: await sha256(bytes),
        frame: sample.sourceFrame,
        renderPass: "motion",
        kind: "motion-flow-exr",
        encoding: "exr",
      });
      completedCaptures += 1;
      options.onProgress?.(completedCaptures / totalCaptures, sample.sourceFrame, "motion");
    }

    if (selection.includeCamera || selection.includeObjects) {
      const shotIr = getShotIr();
      metadataRows.push(
        stableArtifactStringify({
          frame: sample.sourceFrame,
          outputIndex: sample.outputIndex,
          timestampUs: sample.timestampUs,
          timeSeconds: shotIr.timeSeconds,
          timecode: shotIr.timecode,
          ...(selection.includeCamera ? { camera: shotIr.camera } : {}),
          ...(selection.includeObjects ? { objects: shotIr.objects } : {}),
        }),
      );
    }
  }

  if (!raster) throw new Error("Multimodal export produced no frames.");
  if (metadataRows.length) {
    const content = `${metadataRows.join("\n")}\n`;
    const bytes = new TextEncoder().encode(content);
    entries.push({ path: "metadata/frames.jsonl", bytes });
    artifacts.push({
      path: "metadata/frames.jsonl",
      byteLength: bytes.byteLength,
      sha256: await sha256(bytes),
      kind: "frame-metadata",
    });
  }

  const manifestPayload = {
    schemaVersion: 1 as const,
    contract: "director-multimodal-frame-package-v1" as const,
    sourceFrameStart: options.frameStart,
    sourceFrameEnd: options.frameEnd,
    frameCount: plan.length,
    fps: options.fps,
    raster,
    selection,
    artifacts,
    // Absent unless enabled, keeping default manifests byte-identical.
    ...(selection.denseMotionExr ? { motionFlowSemantics: DIRECTOR_DENSE_MOTION_FLOW_SEMANTICS } : {}),
  };
  const manifest: DirectorMultimodalFrameManifest = {
    ...manifestPayload,
    packageFingerprint: await sha256(stableArtifactStringify(manifestPayload)),
  };
  entries.push({
    path: "manifest.json",
    bytes: new TextEncoder().encode(`${stableArtifactStringify(manifest)}\n`),
  });
  throwIfAborted(options.signal);
  const archive = createDeterministicZipArchive(entries);

  return {
    kind: "multimodal-dataset",
    extension: "zip",
    fileName: "director-multimodal-frames.zip",
    archive: archive.blob,
    manifest,
  };
}

/**
 * Trigger a browser download for a multimodal frame package.
 *
 * @param result - The multimodal package export result.
 * @param baseName - The base file name for the download.
 */
export function downloadDirectorMultimodalFramePackage(
  result: DirectorMultimodalFramePackageExport,
  baseName = "director-multimodal",
): void {
  const url = URL.createObjectURL(result.archive);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${baseName}-f${result.manifest.sourceFrameStart}-f${result.manifest.sourceFrameEnd}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
