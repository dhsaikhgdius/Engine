import { compareText } from "../../../../../../packages/protocol/src/primitives";
import { stableLexicalJson } from "../../../../../../packages/protocol/src/stableJson";
import type { DirectorShotIr } from "./shotIr";
import { normalizeDirectorTimebase, serializeDirectorFrameRate } from "../timeline/frameRate";
import { formatDirectorTimelineTimecode } from "../timeline/timecode";
import defaultRenderPasses from "./defaultRenderPasses.json";
import {
  DIRECTOR_SHOT_RENDER_PASS_IDS,
  type DirectorShotRenderPassId,
} from "@director/protocol/workbench-ui";

export { DIRECTOR_SHOT_RENDER_PASS_IDS, type DirectorShotRenderPassId };

/** Descriptor for a render pass: format, color space, bit depth, and path template. */
export interface DirectorShotRenderPassDescriptor {
  /** The pass id. */
  id: DirectorShotRenderPassId;
  /** Output image format; always "png". */
  imageFormat: "png";
  /** Color space: srgb for display, linear for HDR data, data for raw values. */
  colorSpace: "srgb" | "linear" | "data";
  /** Bit depth. */
  bitDepth: 8 | 16 | 32;
  /** Must always be false — helpers are excluded from render passes. */
  includesHelpers: false;
  /** Path template with {frame:06} placeholder. */
  pathTemplate: string;
}

/** Artifact kind in a shot package. */
export type DirectorShotArtifactKind = "render-pass" | "video" | "audio" | "metadata" | "workflow" | "control-package";

/** MIME type for OpenEXR files. */
export const DIRECTOR_EXR_MIME_TYPE = "image/x-exr";

/** Path template for the float EXR depth artifact. */
export const DIRECTOR_DEPTH_EXR_PATH_TEMPLATE = "passes/depth/frame-{frame:06}.exr";

/** Opt-in dense per-pixel motion flow (float EXR) beside the HSV motion PNG. */
export const DIRECTOR_MOTION_FLOW_EXR_PATH_TEMPLATE = "passes/motion/frame-{frame:06}.exr";

/**
 * Frame-to-frame motion field pass. It is deliberately absent from
 * DEFAULT_DIRECTOR_SHOT_RENDER_PASSES so default package bytes stay unchanged;
 * callers opt in by requesting the "motion" pass explicitly.
 */
export const DIRECTOR_MOTION_RENDER_PASS_DESCRIPTOR: DirectorShotRenderPassDescriptor = {
  id: "motion",
  imageFormat: "png",
  colorSpace: "data",
  bitDepth: 8,
  includesHelpers: false,
  pathTemplate: "passes/motion/frame-{frame:06}.png",
};

/** JSON sidecar with exact per-object vectors, planned like the camera trajectory sidecar. */
export const DIRECTOR_MOTION_VECTORS_PATH_TEMPLATE = "passes/motion/frame-{frame:06}.json";

/**
 * Semantics of a float depth artifact. Values are linear eye-space distances
 * measured along the camera forward axis (not euclidean ray lengths), in scene
 * metres. Pixels with no rendered geometry resolve to the far clipping plane.
 */
export interface DirectorShotDepthSemantics {
  representation: "linear-eye-depth";
  units: "metres";
  axis: "camera-forward";
  background: "far-plane";
  projection: "perspective" | "orthographic";
  nearM: number;
  farM: number;
  /** Effective renderer mode for the packed source values at capture time. */
  reversedDepthBuffer: boolean;
  /** Unpacked from the 32-bit RGBA-packed window depth the pipeline already renders. */
  source: "rgba-packed-window-depth";
}

/** Artifact input before hashing, used during capture. */
export interface DirectorShotPackageArtifactInput {
  /** Stable artifact id. */
  id: string;
  /** Artifact kind. */
  kind: DirectorShotArtifactKind;
  /** Portable relative path inside the package. */
  path: string;
  /** MIME type. */
  mimeType: string;
  /** Raw content. */
  content: string | Uint8Array;
  /** Associated render pass, if this is a render-pass artifact. */
  renderPass?: DirectorShotRenderPassId;
  /** Frame number, for per-frame artifacts. */
  frame?: number;
  /** Present only on auxiliary float-EXR pass artifacts; PNG passes stay untagged. */
  encoding?: "exr";
  colorSpace?: "data";
  /** Depth semantics when this is an EXR depth pass. */
  depthSemantics?: DirectorShotDepthSemantics;
}

/** Artifact after hashing, included in the manifest. */
export interface DirectorShotPackageArtifact {
  /** Stable artifact id. */
  id: string;
  /** Artifact kind. */
  kind: DirectorShotArtifactKind;
  /** Portable relative path inside the package. */
  path: string;
  /** MIME type. */
  mimeType: string;
  /** Content length in bytes. */
  byteLength: number;
  /** SHA-256 hash of the content. */
  sha256: `sha256:${string}`;
  /** Associated render pass. */
  renderPass?: DirectorShotRenderPassId;
  /** Frame number. */
  frame?: number;
  /** EXR encoding flag. */
  encoding?: "exr";
  /** Color space for EXR artifacts. */
  colorSpace?: "data";
  /** Depth semantics for EXR depth artifacts. */
  depthSemantics?: DirectorShotDepthSemantics;
}

/** Deterministic manifest for a shot package. */
export interface DirectorShotPackageManifest {
  /** Schema version. */
  schemaVersion: 1;
  /** Content-addressed package id. */
  packageId: string;
  /** SHA-256 fingerprint of the core manifest. */
  packageFingerprint: `sha256:${string}`;
  /** The shot id. */
  shotId: string;
  /** The shot revision fingerprint. */
  shotRevisionFingerprint: string;
  /** Frame range covered by the package. */
  frameRange: {
    start: number;
    end: number;
    fps: number;
    timebase: {
      rate: string;
      numerator: number;
      denominator: number;
      dropFrame: boolean;
      startTimecode: string;
    };
    timecodeStart: string;
    timecodeEnd: string;
    frameCount: number;
  };
  /** Raster dimensions. */
  raster: {
    width: number;
    height: number;
  };
  /** Render passes included in the package. */
  renderPasses: DirectorShotRenderPassDescriptor[];
  /** Hashed artifacts. */
  artifacts: DirectorShotPackageArtifact[];
  /** Optional AI control package descriptor. */
  controlPackage?: DirectorShotControlPackageDescriptor;
  /** The deterministic ShotIR snapshot. */
  shotIr: DirectorShotIr;
  /** Provenance metadata. */
  provenance: {
    generator: "director";
    contract: "director-shot-package-v1";
    projectVersion: DirectorShotIr["projectVersion"];
  };
}

/** Descriptor for an AI control package embedded in the shot package. */
export interface DirectorShotControlPackageDescriptor {
  /** Contract identifier. */
  contract: "director-ai-control-v1";
  /** The primary frame for the control package. */
  primaryFrame: number;
  /** Path to the ShotIR JSON inside the package. */
  shotIrPath: string;
  /** Path to the camera trajectory JSON. */
  cameraTrajectoryPath: string;
  /** Path to the AI control JSON. */
  aiControlPath: string;
  /** Frame range of the camera trajectory. */
  trajectoryFrameRange: {
    start: number;
    end: number;
    sampleCount: number;
  };
}

/** Options for building a shot package manifest. */
export interface BuildDirectorShotPackageOptions {
  /** Inclusive start frame. */
  frameStart: number;
  /** Inclusive end frame. */
  frameEnd: number;
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Pre-captured artifacts. */
  artifacts?: DirectorShotPackageArtifactInput[];
  /** Render pass descriptors; defaults to the default set. */
  renderPasses?: DirectorShotRenderPassDescriptor[];
  /** Optional AI control package descriptor. */
  controlPackage?: DirectorShotControlPackageDescriptor;
}

const DATA_OR_BLOB_URL = /(?:data|blob):/i;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const SAFE_PATH_SEGMENT = /^(?!\.{1,2}$)[^/\\\0]+$/;

export const DEFAULT_DIRECTOR_SHOT_RENDER_PASSES = defaultRenderPasses as DirectorShotRenderPassDescriptor[];

/** Uniform neutral-material camera render. Opt-in: it is not part of the default data-pass set. */
export const DIRECTOR_CLAY_RENDER_PASS_DESCRIPTOR: DirectorShotRenderPassDescriptor = {
  id: "clay",
  imageFormat: "png",
  colorSpace: "srgb",
  bitDepth: 8,
  includesHelpers: false,
  pathTemplate: "passes/clay/frame-{frame:06}.png",
};

export const DIRECTOR_PBR_RENDER_PASS_DESCRIPTORS: DirectorShotRenderPassDescriptor[] = [
  {
    id: "albedo",
    imageFormat: "png",
    colorSpace: "srgb",
    bitDepth: 8,
    includesHelpers: false,
    pathTemplate: "passes/albedo/frame-{frame:06}.png",
  },
  {
    id: "roughness",
    imageFormat: "png",
    colorSpace: "data",
    bitDepth: 8,
    includesHelpers: false,
    pathTemplate: "passes/roughness/frame-{frame:06}.png",
  },
  {
    id: "metalness",
    imageFormat: "png",
    colorSpace: "data",
    bitDepth: 8,
    includesHelpers: false,
    pathTemplate: "passes/metalness/frame-{frame:06}.png",
  },
  {
    id: "emissive",
    imageFormat: "png",
    colorSpace: "srgb",
    bitDepth: 8,
    includesHelpers: false,
    pathTemplate: "passes/emissive/frame-{frame:06}.png",
  },
  {
    id: "ao",
    imageFormat: "png",
    colorSpace: "data",
    bitDepth: 8,
    includesHelpers: false,
    pathTemplate: "passes/ao/frame-{frame:06}.png",
  },
  {
    id: "shadow",
    imageFormat: "png",
    colorSpace: "data",
    bitDepth: 8,
    includesHelpers: false,
    pathTemplate: "passes/shadow/frame-{frame:06}.png",
  },
];

/**
 * Geometry-derived lineart (white lines on black) composed from the depth and
 * normal passes. Opt-in: it is not part of the default capture set.
 */
export const DIRECTOR_LINEART_RENDER_PASS_DESCRIPTOR: DirectorShotRenderPassDescriptor = {
  id: "lineart",
  imageFormat: "png",
  colorSpace: "data",
  bitDepth: 8,
  includesHelpers: false,
  pathTemplate: "passes/lineart/frame-{frame:06}.png",
};

/**
 * OpenPose (COCO-18) skeleton map rendered from the skinned character rigs.
 * Opt-in: it is not part of the default capture set.
 */
export const DIRECTOR_POSE_RENDER_PASS_DESCRIPTOR: DirectorShotRenderPassDescriptor = {
  id: "pose",
  imageFormat: "png",
  colorSpace: "data",
  bitDepth: 8,
  includesHelpers: false,
  pathTemplate: "passes/pose/frame-{frame:06}.png",
};

/**
 * Category-colored semantic segmentation (character/prop/environment) for
 * ControlNet seg control. Opt-in: it is not part of the default capture set.
 */
export const DIRECTOR_SEMANTIC_RENDER_PASS_DESCRIPTOR: DirectorShotRenderPassDescriptor = {
  id: "semantic",
  imageFormat: "png",
  colorSpace: "data",
  bitDepth: 8,
  includesHelpers: false,
  pathTemplate: "passes/semantic/frame-{frame:06}.png",
};

/** Every known render-pass descriptor, including opt-in passes outside the default set. */
export const DIRECTOR_SHOT_RENDER_PASS_DESCRIPTORS: DirectorShotRenderPassDescriptor[] = [
  ...DEFAULT_DIRECTOR_SHOT_RENDER_PASSES,
  DIRECTOR_CLAY_RENDER_PASS_DESCRIPTOR,
  ...DIRECTOR_PBR_RENDER_PASS_DESCRIPTORS,
  DIRECTOR_LINEART_RENDER_PASS_DESCRIPTOR,
  DIRECTOR_POSE_RENDER_PASS_DESCRIPTOR,
  DIRECTOR_SEMANTIC_RENDER_PASS_DESCRIPTOR,
  DIRECTOR_MOTION_RENDER_PASS_DESCRIPTOR,
];

export const stableArtifactStringify = stableLexicalJson;

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

async function sha256(value: string | Uint8Array): Promise<`sha256:${string}`> {
  const bytes = toBytes(value);
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function assertFrame(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer; received ${String(value)}.`);
  }
}

function assertRasterDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 16_384) {
    throw new Error(`${label} must be an integer between 1 and 16384; received ${String(value)}.`);
  }
}

function assertPortableRelativePath(value: string, label: string): void {
  assertNonEmpty(value, label);
  if (value.startsWith("/") || value.startsWith("\\") || URI_SCHEME.test(value)) {
    throw new Error(`${label} must be a portable relative path; received "${value}".`);
  }
  const segments = value.split("/");
  if (!segments.every((segment) => SAFE_PATH_SEGMENT.test(segment))) {
    throw new Error(`${label} must not contain empty, dot, parent, or backslash segments; received "${value}".`);
  }
}

function assertArtifactEncodingMetadata(artifact: DirectorShotPackageArtifactInput): void {
  if ((artifact.encoding === undefined) !== (artifact.colorSpace === undefined)) {
    throw new Error(`Artifact "${artifact.id}" must declare encoding and colorSpace together.`);
  }
  if (artifact.encoding !== undefined) {
    if (artifact.kind !== "render-pass") {
      throw new Error(`EXR artifact "${artifact.id}" must be a render-pass artifact.`);
    }
    if (artifact.mimeType !== DIRECTOR_EXR_MIME_TYPE) {
      throw new Error(`EXR artifact "${artifact.id}" must use mimeType "${DIRECTOR_EXR_MIME_TYPE}".`);
    }
  }
  if (artifact.depthSemantics !== undefined) {
    if (artifact.encoding !== "exr" || artifact.renderPass !== "depth") {
      throw new Error(`Artifact "${artifact.id}" depthSemantics is only valid on an EXR depth render pass.`);
    }
    const { nearM, farM } = artifact.depthSemantics;
    if (!Number.isFinite(nearM) || !Number.isFinite(farM) || nearM <= 0 || farM <= nearM) {
      throw new Error(`Artifact "${artifact.id}" depthSemantics requires 0 < nearM < farM.`);
    }
  }
}

function normalizeRenderPasses(
  input: DirectorShotRenderPassDescriptor[] | undefined,
): DirectorShotRenderPassDescriptor[] {
  const renderPasses = (input ?? DEFAULT_DIRECTOR_SHOT_RENDER_PASSES).map((item) => ({ ...item }));
  if (!renderPasses.length) throw new Error("Shot package requires at least one render pass.");

  const ids = new Set<DirectorShotRenderPassId>();
  const templates = new Set<string>();
  for (const pass of renderPasses) {
    if (!DIRECTOR_SHOT_RENDER_PASS_IDS.includes(pass.id)) {
      throw new Error(`Unsupported render pass "${String(pass.id)}".`);
    }
    if (ids.has(pass.id)) throw new Error(`Duplicate render pass id "${pass.id}".`);
    assertPortableRelativePath(pass.pathTemplate.replace("{frame:06}", "000000"), `Render pass ${pass.id} path`);
    if (!pass.pathTemplate.includes("{frame:06}")) {
      throw new Error(`Render pass "${pass.id}" pathTemplate must contain {frame:06}.`);
    }
    if (templates.has(pass.pathTemplate)) {
      throw new Error(`Duplicate render pass pathTemplate "${pass.pathTemplate}".`);
    }
    if (pass.includesHelpers !== false) {
      throw new Error(`Render pass "${pass.id}" must exclude editor helpers.`);
    }
    ids.add(pass.id);
    templates.add(pass.pathTemplate);
  }

  return renderPasses.sort((left, right) => compareText(left.id, right.id));
}

async function normalizeArtifacts(
  artifacts: DirectorShotPackageArtifactInput[],
  renderPasses: DirectorShotRenderPassDescriptor[],
  frameStart: number,
  frameEnd: number,
): Promise<DirectorShotPackageArtifact[]> {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const renderPassIds = new Set(renderPasses.map((pass) => pass.id));

  const normalized = await Promise.all(
    artifacts.map(async (artifact) => {
      assertNonEmpty(artifact.id, "Artifact id");
      assertNonEmpty(artifact.mimeType, `Artifact ${artifact.id} mimeType`);
      assertPortableRelativePath(artifact.path, `Artifact ${artifact.id} path`);
      if (ids.has(artifact.id)) throw new Error(`Duplicate artifact id "${artifact.id}".`);
      if (paths.has(artifact.path)) throw new Error(`Duplicate artifact path "${artifact.path}".`);
      ids.add(artifact.id);
      paths.add(artifact.path);

      if (artifact.kind === "render-pass" && !artifact.renderPass) {
        throw new Error(`Render-pass artifact "${artifact.id}" requires renderPass.`);
      }
      if (artifact.renderPass && !renderPassIds.has(artifact.renderPass)) {
        throw new Error(`Artifact "${artifact.id}" references disabled render pass "${artifact.renderPass}".`);
      }
      if (artifact.frame !== undefined) {
        assertFrame(artifact.frame, `Artifact ${artifact.id} frame`);
        if (artifact.frame < frameStart || artifact.frame > frameEnd) {
          throw new Error(`Artifact "${artifact.id}" frame ${artifact.frame} is outside ${frameStart}-${frameEnd}.`);
        }
      }
      assertArtifactEncodingMetadata(artifact);

      const bytes = toBytes(artifact.content);
      return {
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        mimeType: artifact.mimeType,
        byteLength: bytes.byteLength,
        sha256: await sha256(bytes),
        ...(artifact.renderPass ? { renderPass: artifact.renderPass } : {}),
        ...(artifact.frame !== undefined ? { frame: artifact.frame } : {}),
        ...(artifact.encoding !== undefined ? { encoding: artifact.encoding, colorSpace: artifact.colorSpace } : {}),
        ...(artifact.depthSemantics !== undefined ? { depthSemantics: { ...artifact.depthSemantics } } : {}),
      } satisfies DirectorShotPackageArtifact;
    }),
  );

  return normalized.sort((left, right) => compareText(left.id, right.id));
}

function canonicalCopy<T>(value: T): T {
  return JSON.parse(stableArtifactStringify(value)) as T;
}

/**
 * Produces the deterministic, portable control manifest for one shot package.
 * Binary payloads are hashed and deliberately omitted from the returned JSON.
 *
 * @param shotIr - The evaluated shot IR.
 * @param options - Frame range, dimensions, artifacts, and render passes.
 * @returns A validated, content-addressed manifest.
 */
export async function buildDirectorShotPackage(
  shotIr: DirectorShotIr,
  options: BuildDirectorShotPackageOptions,
): Promise<DirectorShotPackageManifest> {
  if (shotIr.schemaVersion !== 1) throw new Error(`Unsupported ShotIR schema version ${String(shotIr.schemaVersion)}.`);
  assertFrame(options.frameStart, "Shot package frameStart");
  assertFrame(options.frameEnd, "Shot package frameEnd");
  if (options.frameEnd < options.frameStart) {
    throw new Error(`Shot package frameEnd ${options.frameEnd} cannot be before frameStart ${options.frameStart}.`);
  }
  if (shotIr.frame < options.frameStart || shotIr.frame > options.frameEnd) {
    throw new Error(`ShotIR frame ${shotIr.frame} is outside package range ${options.frameStart}-${options.frameEnd}.`);
  }
  if (!Number.isFinite(shotIr.fps) || shotIr.fps <= 0) {
    throw new Error(`Shot package fps must be greater than zero; received ${String(shotIr.fps)}.`);
  }
  assertRasterDimension(options.width, "Shot package width");
  assertRasterDimension(options.height, "Shot package height");

  const renderPasses = normalizeRenderPasses(options.renderPasses);
  const artifacts = await normalizeArtifacts(
    options.artifacts ?? [],
    renderPasses,
    options.frameStart,
    options.frameEnd,
  );
  const portableShotIr = canonicalCopy(shotIr);
  const exactTimebase = normalizeDirectorTimebase(
    portableShotIr.timebase
      ? {
          rate: {
            numerator: portableShotIr.timebase.numerator,
            denominator: portableShotIr.timebase.denominator,
          },
          dropFrame: portableShotIr.timebase.dropFrame,
          startTimecode: portableShotIr.timebase.startTimecode,
        }
      : undefined,
    portableShotIr.fps,
  );
  const manifestTimebase = {
    rate: serializeDirectorFrameRate(exactTimebase.rate),
    numerator: exactTimebase.rate.numerator,
    denominator: exactTimebase.rate.denominator,
    dropFrame: exactTimebase.dropFrame,
    startTimecode: exactTimebase.startTimecode,
  };
  const controlPackage = options.controlPackage ? canonicalCopy(options.controlPackage) : undefined;
  if (controlPackage) {
    assertFrame(controlPackage.primaryFrame, "Control package primaryFrame");
    assertFrame(controlPackage.trajectoryFrameRange.start, "Control package trajectory start");
    assertFrame(controlPackage.trajectoryFrameRange.end, "Control package trajectory end");
    if (controlPackage.trajectoryFrameRange.end < controlPackage.trajectoryFrameRange.start) {
      throw new Error("Control package trajectory end cannot be before its start.");
    }
    const expectedSamples = controlPackage.trajectoryFrameRange.end - controlPackage.trajectoryFrameRange.start + 1;
    if (controlPackage.trajectoryFrameRange.sampleCount !== expectedSamples) {
      throw new Error(
        `Control package trajectory sampleCount must be ${expectedSamples}; received ${controlPackage.trajectoryFrameRange.sampleCount}.`,
      );
    }
    assertPortableRelativePath(controlPackage.shotIrPath, "Control package ShotIR path");
    assertPortableRelativePath(controlPackage.cameraTrajectoryPath, "Control package camera trajectory path");
    assertPortableRelativePath(controlPackage.aiControlPath, "Control package AI control path");
  }
  const core = {
    schemaVersion: 1 as const,
    shotId: portableShotIr.id,
    shotRevisionFingerprint: portableShotIr.revisionFingerprint,
    frameRange: {
      start: options.frameStart,
      end: options.frameEnd,
      fps: portableShotIr.fps,
      timebase: manifestTimebase,
      timecodeStart: formatDirectorTimelineTimecode(options.frameStart, exactTimebase),
      timecodeEnd: formatDirectorTimelineTimecode(options.frameEnd, exactTimebase),
      frameCount: options.frameEnd - options.frameStart + 1,
    },
    raster: { width: options.width, height: options.height },
    renderPasses,
    artifacts,
    ...(controlPackage ? { controlPackage } : {}),
    shotIr: portableShotIr,
    provenance: {
      generator: "director" as const,
      contract: "director-shot-package-v1" as const,
      projectVersion: portableShotIr.projectVersion,
    },
  };
  const serialized = stableArtifactStringify(core);
  if (DATA_OR_BLOB_URL.test(serialized)) {
    throw new Error("Shot package manifest cannot contain data: or blob: references.");
  }
  const packageFingerprint = await sha256(serialized);

  return {
    ...core,
    packageId: `director-package:${packageFingerprint.slice("sha256:".length, "sha256:".length + 24)}`,
    packageFingerprint,
  };
}
