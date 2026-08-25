import type { DirectorProject } from "../schema/directorProject";
import { requestViewportCapture, type ViewportCaptureRequest } from "../io/captureBridge";
import type { ScreenshotResult } from "../io/screenshotExport";
import type { DirectorDepthFloatCaptureResult } from "../render/depthFloatCapture";
import { encodeExrDepth } from "../render/exrEncoder";
import {
  buildDirectorMotionVectorSidecar,
  computeDirectorObjectMotionVectors,
  getDirectorMotionSourceFrames,
  type DirectorMotionCameraPose,
} from "../render/motionVectorPass";
import { buildDirectorShotIr, type DirectorShotIr } from "./shotIr";
import { buildDirectorAiControlArtifacts } from "./aiControlPackage";
import {
  buildDirectorShotPackage,
  DEFAULT_DIRECTOR_SHOT_RENDER_PASSES,
  DIRECTOR_DEPTH_EXR_PATH_TEMPLATE,
  DIRECTOR_EXR_MIME_TYPE,
  DIRECTOR_MOTION_VECTORS_PATH_TEMPLATE,
  DIRECTOR_SHOT_RENDER_PASS_DESCRIPTORS,
  DIRECTOR_SHOT_RENDER_PASS_IDS,
  stableArtifactStringify,
  type DirectorShotPackageManifest,
  type DirectorShotRenderPassId,
} from "./shotPackage";

/** Options for capturing a shot package from the viewport. */
export interface CaptureDirectorShotPackageOptions {
  /** Camera id; defaults to the active camera. */
  cameraId?: string;
  /** Production take id. */
  takeId?: string;
  /** Coverage shot id. */
  coverageShotId?: string;
  /** Frame number; defaults to the timeline current frame. */
  frame?: number;
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Which render passes to capture; defaults to the default set. */
  renderPasses?: DirectorShotRenderPassId[];
  /** Whether to include AI control package artifacts. */
  includeControlPackage?: boolean;
  /**
   * Additionally encode the depth pass as a float OpenEXR artifact (single
   * FLOAT "Z" channel, linear eye-space metres). The 8-bit depth PNG is still
   * produced; leaving this off keeps the package byte-identical to before.
   */
  includeDepthExr?: boolean;
}

/** One captured render pass file in data URL form. */
export interface CapturedDirectorShotPackageFile {
  /** Stable id. */
  id: string;
  /** Portable relative path. */
  path: string;
  /** MIME type. */
  mimeType: "image/png" | "image/x-exr";
  /** The render pass. */
  renderPass: DirectorShotRenderPassId;
  /** The frame number. */
  frame: number;
  /** Base64 data URL. */
  dataUrl: string;
}

/** A complete captured shot package. */
export interface CapturedDirectorShotPackage {
  /** The deterministic manifest. */
  manifest: DirectorShotPackageManifest;
  /** Captured render pass files. */
  files: CapturedDirectorShotPackageFile[];
  /** Text sidecar files (motion vectors, AI control, etc.). */
  sidecars: Array<{ id: string; path: string; mimeType: string; content: string }>;
}

/** Extended viewport capture request with optional float depth readback. */
export interface DirectorShotPackageCaptureRequest extends ViewportCaptureRequest {
  /**
   * Ask the capture handler to also read back float depth for EXR encoding.
   * Handlers that predate float depth ignore the flag; the caller then fails
   * with an explicit error instead of silently omitting the artifact.
   */
  depthFloat?: boolean;
}

/** The result of a single viewport capture, including optional float depth. */
export type DirectorShotPackageCaptureResult = ScreenshotResult & {
  /** Float depth data for EXR encoding, if requested. */
  depthFloat?: DirectorDepthFloatCaptureResult;
};

/** Signature of the capture function used by the package capture pipeline. */
export type DirectorShotPackageCapture = (
  request: DirectorShotPackageCaptureRequest,
) => Promise<DirectorShotPackageCaptureResult[]>;

function decodeBase64DataUrl(dataUrl: string): Uint8Array {
  const match = /^data:image\/png;base64,([a-z\d+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error("Shot package render pass must return a base64 PNG data URL.");
  const binary = atob(match[1]!.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64DataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function normalizeRequestedPasses(input: DirectorShotRenderPassId[] | undefined): DirectorShotRenderPassId[] {
  // Opt-in passes (e.g. lineart) are excluded unless explicitly requested.
  const passes = input?.length ? [...input] : DEFAULT_DIRECTOR_SHOT_RENDER_PASSES.map((pass) => pass.id);
  const unique = new Set<DirectorShotRenderPassId>();
  for (const pass of passes) {
    if (!DIRECTOR_SHOT_RENDER_PASS_IDS.includes(pass)) throw new Error(`Unsupported render pass "${String(pass)}".`);
    if (unique.has(pass)) throw new Error(`Duplicate render pass "${pass}".`);
    unique.add(pass);
  }
  return [...unique];
}

function pathForPass(pass: DirectorShotRenderPassId, frame: number) {
  const descriptor = DIRECTOR_SHOT_RENDER_PASS_DESCRIPTORS.find((candidate) => candidate.id === pass);
  if (!descriptor) throw new Error(`Missing render-pass descriptor for "${pass}".`);
  return descriptor.pathTemplate.replace("{frame:06}", String(frame).padStart(6, "0"));
}

function motionPoseFromShotIr(shotIr: DirectorShotIr, aspect: number): DirectorMotionCameraPose {
  return {
    position: [...shotIr.camera.position],
    target: [...shotIr.camera.target],
    fovDegrees: shotIr.camera.fov,
    aspect,
  };
}

/**
 * Exact per-object motion vectors between frame-1 and the captured frame,
 * derived from the same deterministic evaluators as ShotIR (never estimated
 * from pixels). Frame 0, or a previous frame outside the evaluable range,
 * degrades to zero motion by sampling the captured frame twice.
 */
function buildMotionVectorSidecarContent(
  project: DirectorProject,
  shotIr: DirectorShotIr,
  options: CaptureDirectorShotPackageOptions,
): string {
  const { fromFrame } = getDirectorMotionSourceFrames(shotIr.frame);
  let fromShotIr = shotIr;
  if (fromFrame !== shotIr.frame) {
    try {
      fromShotIr = buildDirectorShotIr(project, {
        cameraId: options.cameraId,
        takeId: options.takeId,
        coverageShotId: options.coverageShotId,
        frame: fromFrame,
      });
    } catch {
      fromShotIr = shotIr;
    }
  }
  const aspect = options.width / options.height;
  const fromCamera = motionPoseFromShotIr(fromShotIr, aspect);
  const toCamera = motionPoseFromShotIr(shotIr, aspect);
  const sidecar = buildDirectorMotionVectorSidecar({
    width: options.width,
    height: options.height,
    fromFrame: fromShotIr.frame,
    toFrame: shotIr.frame,
    fromCamera,
    toCamera,
    vectors: computeDirectorObjectMotionVectors({
      width: options.width,
      height: options.height,
      fromCamera,
      toCamera,
      fromAnchors: fromShotIr.objects.map((object) => ({
        objectId: object.id,
        position: [...object.transform.position],
      })),
      toAnchors: shotIr.objects.map((object) => ({
        objectId: object.id,
        position: [...object.transform.position],
      })),
    }),
  });
  return `${stableArtifactStringify(sidecar)}\n`;
}

/**
 * Captures real browser render-pass bytes for one evaluated frame and builds
 * the deterministic manifest around those bytes. Binary data remains outside
 * the manifest so callers can download or stream it without polluting ShotIR.
 *
 * @param project - The Director project.
 * @param options - Capture options: camera, frame, dimensions, passes.
 * @param capture - The capture function; defaults to the viewport capture bridge.
 * @returns The captured package with manifest, files, and sidecars.
 */
export async function captureDirectorShotPackage(
  project: DirectorProject,
  options: CaptureDirectorShotPackageOptions,
  capture: DirectorShotPackageCapture = requestViewportCapture,
): Promise<CapturedDirectorShotPackage> {
  const passes = normalizeRequestedPasses(options.renderPasses);
  const includeDepthExr = options.includeDepthExr === true;
  if (includeDepthExr && !passes.includes("depth")) {
    throw new Error('EXR depth output requires the "depth" render pass.');
  }
  const shotIr = buildDirectorShotIr(project, {
    cameraId: options.cameraId,
    takeId: options.takeId,
    coverageShotId: options.coverageShotId,
    frame: options.frame,
  });
  const frame = shotIr.frame;
  const frameLabel = String(frame).padStart(6, "0");
  const files: CapturedDirectorShotPackageFile[] = [];
  const artifacts = [];
  const controlArtifacts =
    options.includeControlPackage === false
      ? null
      : buildDirectorAiControlArtifacts(project, shotIr, {
          takeId: options.takeId,
          coverageShotId: options.coverageShotId,
          renderPasses: passes,
          depthExr: includeDepthExr,
        });

  for (const renderPass of passes) {
    const wantsDepthFloat = includeDepthExr && renderPass === "depth";
    const results = await capture({
      preset: "current",
      source: "camera-panel",
      cameraId: shotIr.camera.id,
      cleanPlate: true,
      renderPass,
      width: options.width,
      height: options.height,
      frame,
      ...(wantsDepthFloat ? { depthFloat: true } : {}),
    });
    const result = results[0];
    if (results.length !== 1 || !result) {
      throw new Error(`Render pass "${renderPass}" must return exactly one frame.`);
    }
    const content = decodeBase64DataUrl(result.dataUrl);
    const path = pathForPass(renderPass, frame);
    const id = `${renderPass}-${frameLabel}`;
    files.push({ id, path, mimeType: "image/png", renderPass, frame, dataUrl: result.dataUrl });
    artifacts.push({
      id,
      kind: "render-pass" as const,
      path,
      mimeType: "image/png",
      content,
      renderPass,
      frame,
    });

    if (wantsDepthFloat) {
      const depthFloat = result.depthFloat;
      if (!depthFloat) {
        throw new Error(
          'Render pass "depth" returned no float depth; the active viewport capture handler cannot encode EXR depth.',
        );
      }
      if (depthFloat.metadata.width !== options.width || depthFloat.metadata.height !== options.height) {
        throw new Error(
          `EXR depth raster ${depthFloat.metadata.width}x${depthFloat.metadata.height} must match the requested ${options.width}x${options.height}.`,
        );
      }
      const exrBytes = encodeExrDepth({ width: options.width, height: options.height, data: depthFloat.depth });
      const exrPath = DIRECTOR_DEPTH_EXR_PATH_TEMPLATE.replace("{frame:06}", frameLabel);
      const exrId = `depth-exr-${frameLabel}`;
      files.push({
        id: exrId,
        path: exrPath,
        mimeType: DIRECTOR_EXR_MIME_TYPE,
        renderPass,
        frame,
        dataUrl: encodeBase64DataUrl(exrBytes, DIRECTOR_EXR_MIME_TYPE),
      });
      artifacts.push({
        id: exrId,
        kind: "render-pass" as const,
        path: exrPath,
        mimeType: DIRECTOR_EXR_MIME_TYPE,
        content: exrBytes,
        renderPass,
        frame,
        encoding: "exr" as const,
        colorSpace: "data" as const,
        depthSemantics: depthFloat.metadata.depthSemantics,
      });
    }
  }

  const motionSidecars: Array<{ id: string; path: string; mimeType: string; content: string }> = [];
  if (passes.includes("motion")) {
    const motionSidecar = {
      id: `motion-vectors-${frameLabel}`,
      path: DIRECTOR_MOTION_VECTORS_PATH_TEMPLATE.replace("{frame:06}", frameLabel),
      mimeType: "application/json",
      content: buildMotionVectorSidecarContent(project, shotIr, options),
    };
    motionSidecars.push(motionSidecar);
    artifacts.push({
      ...motionSidecar,
      kind: "metadata" as const,
      renderPass: "motion" as const,
      frame,
    });
  }

  const enabledDescriptors = DIRECTOR_SHOT_RENDER_PASS_DESCRIPTORS.filter((descriptor) =>
    passes.includes(descriptor.id),
  );
  const manifest = await buildDirectorShotPackage(shotIr, {
    frameStart: frame,
    frameEnd: frame,
    width: options.width,
    height: options.height,
    artifacts: [...artifacts, ...(controlArtifacts?.artifacts ?? [])],
    renderPasses: enabledDescriptors,
    ...(controlArtifacts
      ? {
          controlPackage: {
            contract: "director-ai-control-v1",
            primaryFrame: frame,
            shotIrPath: controlArtifacts.control.inputs.shotIr,
            cameraTrajectoryPath: controlArtifacts.control.inputs.cameraTrajectory,
            aiControlPath: "ai/control.json",
            trajectoryFrameRange: {
              start: controlArtifacts.trajectory.frameStart,
              end: controlArtifacts.trajectory.frameEnd,
              sampleCount: controlArtifacts.trajectory.samples.length,
            },
          },
        }
      : {}),
  });

  return { manifest, files, sidecars: [...motionSidecars, ...(controlArtifacts?.textFiles ?? [])] };
}
