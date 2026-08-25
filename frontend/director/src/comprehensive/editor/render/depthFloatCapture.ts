import type { Camera, OrthographicCamera, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { DirectorShotDepthSemantics } from "../shot/shotPackage";
import { assertDirectorRenderDimension as assertDimension } from "./renderCaptureUtils";
import { captureDirectorRenderPass } from "./renderPassCapture";

/**
 * Float depth readback for the EXR shot-package path.
 *
 * Chosen semantics: linear eye-space depth in scene metres — the perpendicular
 * distance from the camera plane along its forward (-Z view) axis, NOT the
 * euclidean length of the per-pixel ray. Geometry on the near/far clipping
 * planes decodes to exactly nearM/farM, and pixels with no rendered geometry
 * resolve to the far plane (the conventional "empty depth" for compositing).
 *
 * The source signal is the same 32-bit RGBA-packed window-space depth the
 * existing 8-bit depth PNG pass renders (MeshDepthMaterial + RGBADepthPacking),
 * unpacked on the CPU and linearized with the camera clip range. That keeps
 * ~24+8-bit fixed-point window precision without requiring float render-target
 * support, and guarantees the EXR sees the exact geometry the PNG pass sees.
 */

// three.js packDepthToRGBA fixed-point denominator (2^24).
const PACKED_DEPTH_SCALE = 0x100_0000;

export interface DirectorDepthFloatCaptureInput {
  /** The WebGL renderer to use for the capture. */
  renderer: WebGLRenderer;
  /** The scene containing authored objects. */
  scene: Scene;
  /** Camera whose view and clip planes define the depth range. */
  camera: Camera;
  /** Output raster width in pixels. */
  width: number;
  /** Output raster height in pixels. */
  height: number;
}

export interface DirectorDepthFloatCaptureMetadata {
  /** The pass identifier, always "depth" for float depth. */
  renderPass: "depth";
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Single float32 per pixel. */
  pixelFormat: "float32";
  /** Bits per channel (32 for float32). */
  bitsPerChannel: 32;
  /** Pixel rows are stored top-to-bottom. */
  rowOrder: "top-to-bottom";
  /** Data-space encoding, never color-managed. */
  colorSpace: "data";
  /** Encoding identifier for linear eye-space depth. */
  encoding: "linear-eye-depth";
  /** Editor helpers are always excluded from this pass. */
  helpersExcluded: true;
  /** Immutable semantics describing the depth representation. */
  depthSemantics: DirectorShotDepthSemantics;
}

/** Float-depth capture result: the linear eye-space depth array and its metadata. */
export interface DirectorDepthFloatCaptureResult {
  /** Row-major, top-to-bottom; linear eye-space depth in scene metres. */
  depth: Float32Array;
  metadata: DirectorDepthFloatCaptureMetadata;
}

export interface DirectorWindowDepthLinearization {
  /** Camera projection type: perspective or orthographic. */
  projection: "perspective" | "orthographic";
  /** Near clipping plane distance in metres. */
  nearM: number;
  /** Far clipping plane distance in metres. */
  farM: number;
  /** Effective renderer mode: window depth 1 is the near plane when reversed. */
  reversedDepthBuffer: boolean;
}

function assertClipRange(nearM: number, farM: number): void {
  if (!Number.isFinite(nearM) || !Number.isFinite(farM) || nearM <= 0 || farM <= nearM) {
    throw new Error(`Float depth capture requires 0 < near < far; received near=${nearM}, far=${farM}.`);
  }
}

/**
 * CPU mirror of three.js r18x `unpackRGBAToDepth`: R, G, B carry the high,
 * middle, and low byte of floor(depth * 2^24) and A carries the remaining
 * sub-LSB fraction in 1/255 steps, so packed (255,255,255,255) decodes to
 * exactly 1 and packed (0,0,0,0) to exactly 0.
 */
export function unpackDirectorRgbaDepth(rgba: Uint8Array, width: number, height: number): Float32Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`Packed depth buffer must contain ${width * height * 4} bytes; received ${rgba.length}.`);
  }
  const windowDepth = new Float32Array(width * height);
  for (let pixel = 0; pixel < windowDepth.length; pixel += 1) {
    const byteOffset = pixel * 4;
    const integer = rgba[byteOffset]! * 65_536 + rgba[byteOffset + 1]! * 256 + rgba[byteOffset + 2]!;
    windowDepth[pixel] = (integer + rgba[byteOffset + 3]! / 255) / PACKED_DEPTH_SCALE;
  }
  return windowDepth;
}

/** Inverts three.js `perspectiveDepthToViewZ`/`orthographicDepthToViewZ` into positive metres. */
export function linearizeDirectorWindowDepth(
  windowDepth: Float32Array,
  { projection, nearM, farM, reversedDepthBuffer }: DirectorWindowDepthLinearization,
): Float32Array {
  assertClipRange(nearM, farM);
  const eyeDepth = new Float32Array(windowDepth.length);
  const clipRange = farM - nearM;
  const nearFar = nearM * farM;
  for (let pixel = 0; pixel < windowDepth.length; pixel += 1) {
    const depth = windowDepth[pixel]!;
    if (projection === "orthographic") {
      eyeDepth[pixel] = reversedDepthBuffer ? farM - depth * clipRange : nearM + depth * clipRange;
    } else {
      eyeDepth[pixel] = reversedDepthBuffer
        ? nearFar / (nearM + depth * clipRange)
        : nearFar / (farM - depth * clipRange);
    }
  }
  return eyeDepth;
}

/**
 * Renders the depth pass once and returns full-resolution linear eye-space
 * depth. This is a separate render from the PNG depth pass, so requesting it
 * never changes existing PNG bytes; covered pixels match exactly because the
 * same override material and camera are used.
 */
export function captureDirectorDepthFloat({
  renderer,
  scene,
  camera,
  width,
  height,
}: DirectorDepthFloatCaptureInput): DirectorDepthFloatCaptureResult {
  assertDimension(width, "Render width");
  assertDimension(height, "Render height");

  const projection = (camera as PerspectiveCamera).isPerspectiveCamera
    ? "perspective"
    : (camera as OrthographicCamera).isOrthographicCamera
      ? "orthographic"
      : null;
  if (!projection) throw new Error("Float depth capture requires a perspective or orthographic camera.");
  const clipCamera = camera as PerspectiveCamera | OrthographicCamera;
  const nearM = clipCamera.near;
  const farM = clipCamera.far;
  assertClipRange(nearM, farM);

  // Mock renderers in tests may omit capabilities entirely; treat that as the
  // classic depth buffer, matching three's fallback when EXT_clip_control is missing.
  const capabilities = renderer.capabilities as { reversedDepthBuffer?: boolean } | undefined;
  const reversedDepthBuffer = capabilities?.reversedDepthBuffer === true;
  // With a reversed depth buffer the packed value 0 already decodes to the far
  // plane, so the standard transparent-black clear is correct. A classic depth
  // buffer needs a packed-one (white, opaque) clear for the same
  // "empty pixel = far plane" convention.
  const { rgba } = captureDirectorRenderPass({
    renderer,
    scene,
    camera,
    renderPass: "depth",
    width,
    height,
    technicalPassClearColor: reversedDepthBuffer ? { color: 0x000000, alpha: 0 } : { color: 0xffffff, alpha: 1 },
  });

  const depth = linearizeDirectorWindowDepth(unpackDirectorRgbaDepth(rgba, width, height), {
    projection,
    nearM,
    farM,
    reversedDepthBuffer,
  });

  return {
    depth,
    metadata: {
      renderPass: "depth",
      width,
      height,
      pixelFormat: "float32",
      bitsPerChannel: 32,
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: "linear-eye-depth",
      helpersExcluded: true,
      depthSemantics: {
        representation: "linear-eye-depth",
        units: "metres",
        axis: "camera-forward",
        background: "far-plane",
        projection,
        nearM,
        farM,
        reversedDepthBuffer,
        source: "rgba-packed-window-depth",
      },
    },
  };
}
