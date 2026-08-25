/**
 * Frame-to-frame motion vector pass. Director scenes are deterministically
 * evaluable at any frame, so per-object screen-space motion is computed
 * exactly from two evaluated camera/object states instead of being estimated
 * from pixels. The image half of the pass paints each object's displacement
 * vector into its object-id silhouette using the optical-flow HSV convention
 * (hue = direction, brightness = magnitude); the JSON sidecar carries the
 * exact per-object vectors for downstream motion-consistency control.
 */

export const DIRECTOR_MOTION_VECTORS_CONTRACT = "director-motion-vectors-v1" as const;

/** Vector magnitude that saturates the HSV encoding, as a fraction of the image diagonal. */
export const DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION = 0.05;

type Tuple2 = [number, number];
type Tuple3 = [number, number, number];

/** Minimal pinhole look-at pose; enough to reproject any world point exactly. */
export interface DirectorMotionCameraPose {
  /** World-space camera position in metres. */
  position: Tuple3;
  /** World-space look-at target in metres. */
  target: Tuple3;
  /** Vertical field of view in degrees. */
  fovDegrees: number;
  /** Raster aspect ratio (width / height) used for the projection. */
  aspect: number;
}

export interface DirectorMotionObjectAnchor {
  /** Stable object identifier matching the object-id capture. */
  objectId: string;
  /** World-space anchor; the object origin (characters may use the skeleton root). */
  position: Tuple3;
}

export interface DirectorObjectMotionVector {
  /** Stable object identifier. */
  objectId: string;
  /** Pixel position at the previous frame (top-left origin, y down). */
  fromPx: Tuple2;
  /** Pixel position at the current frame. */
  toPx: Tuple2;
  /** toPx - fromPx. */
  deltaPx: Tuple2;
}

export interface DirectorMotionNormalization {
  /** Normalization basis: always the image diagonal. */
  basis: "image-diagonal";
  /** Fraction of the diagonal that maps to full brightness. */
  fraction: number;
  /** fraction * sqrt(width^2 + height^2); the magnitude mapped to full brightness. */
  maxMagnitudePx: number;
}

export interface DirectorMotionVectorPassMetadata {
  /** The pass identifier, always "motion" for the motion vector pass. */
  renderPass: "motion";
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Four 8-bit channels per pixel. */
  pixelFormat: "rgba8";
  /** Bits per channel (8 for RGBA8). */
  bitsPerChannel: 8;
  /** Pixel rows are stored top-to-bottom. */
  rowOrder: "top-to-bottom";
  /** Data-space encoding, never color-managed. */
  colorSpace: "data";
  /** Encoding identifier for the motion HSV visualization. */
  encoding: "motion-hsv-rgb";
  /** Editor helpers are always excluded from this pass. */
  helpersExcluded: true;
  /** Source frame index. */
  fromFrame: number;
  /** Destination frame index. */
  toFrame: number;
  /** Normalization parameters used to map magnitude to brightness. */
  normalization: DirectorMotionNormalization;
  /** Camera poses for both frames. */
  camera: { from: DirectorMotionCameraPose; to: DirectorMotionCameraPose };
  /** Exact per-object screen-space vectors. */
  objectVectors: DirectorObjectMotionVector[];
  /** Region-mask colors from the same-frame object-id capture. */
  objectIdToRgb?: Record<string, [number, number, number]>;
}

/** The RGBA pixel payload and its companion metadata for a motion vector pass. */
export interface DirectorMotionVectorPassResult {
  rgba: Uint8Array;
  metadata: DirectorMotionVectorPassMetadata;
}

export interface DirectorMotionVectorSidecar {
  /** Schema version for forward compatibility. */
  schemaVersion: 1;
  /** Contract identifier linking image and sidecar. */
  contract: typeof DIRECTOR_MOTION_VECTORS_CONTRACT;
  /** Source frame index. */
  fromFrame: number;
  /** Destination frame index. */
  toFrame: number;
  /** Raster dimensions of the companion image. */
  raster: { width: number; height: number };
  /** Encoding of the companion image. */
  encoding: "motion-hsv-rgb";
  /** HSV mapping description for the companion image. */
  hsv: {
    hue: "screen-direction-degrees-atan2(dy,dx)";
    saturation: "constant-1";
    value: "magnitude-over-maxMagnitudePx-clamped";
  };
  /** Normalization parameters. */
  normalization: DirectorMotionNormalization;
  /** Camera poses for both frames. */
  camera: { from: DirectorMotionCameraPose; to: DirectorMotionCameraPose };
  /** Exact per-object vectors. */
  objects: DirectorObjectMotionVector[];
}

function assertRaster(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 16_384) {
    throw new Error(`${label} must be an integer between 1 and 16384; received ${String(value)}.`);
  }
}

function subtract(left: Tuple3, right: Tuple3): Tuple3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: Tuple3, right: Tuple3): Tuple3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: Tuple3, right: Tuple3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function normalize(value: Tuple3): Tuple3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length === 0) throw new Error("Motion pass camera basis vector cannot be zero-length.");
  return [value[0] / length, value[1] / length, value[2] / length];
}

const WORLD_UP: Tuple3 = [0, 1, 0];
export const DIRECTOR_MOTION_MIN_FORWARD_DISTANCE = 1e-6;

/** Orthonormal pinhole frame shared by projection and (dense-flow) unprojection. */
export interface DirectorMotionCameraBasis {
  /** World-space camera position. */
  position: Tuple3;
  /** Unit forward (look) direction. */
  forward: Tuple3;
  /** Unit right direction. */
  right: Tuple3;
  /** Unit up direction. */
  up: Tuple3;
  /** Tangent of half the vertical field of view. */
  tanHalfFov: number;
  /** Raster aspect ratio (width / height). */
  aspect: number;
}

/**
 * Validates the pose and derives its look-at basis. Every projection and
 * unprojection in the motion pipeline must go through this helper so the
 * camera model (up-reference fallback included) can never diverge between
 * the per-object vectors and the dense flow field.
 */
export function getDirectorMotionCameraBasis(camera: DirectorMotionCameraPose): DirectorMotionCameraBasis {
  if (!Number.isFinite(camera.fovDegrees) || camera.fovDegrees <= 0 || camera.fovDegrees >= 180) {
    throw new Error(`Motion pass camera fov must be inside (0, 180); received ${String(camera.fovDegrees)}.`);
  }
  if (!Number.isFinite(camera.aspect) || camera.aspect <= 0) {
    throw new Error(`Motion pass camera aspect must be positive; received ${String(camera.aspect)}.`);
  }
  const forward = normalize(subtract(camera.target, camera.position));
  // Fall back to a stable basis when looking straight up/down the world up axis.
  const upReference: Tuple3 = Math.abs(dot(forward, WORLD_UP)) > 0.9999 ? [0, 0, 1] : WORLD_UP;
  const right = normalize(cross(forward, upReference));
  const up = cross(right, forward);
  return {
    position: [...camera.position],
    forward,
    right,
    up,
    tanHalfFov: Math.tan((camera.fovDegrees * Math.PI) / 360),
    aspect: camera.aspect,
  };
}

/** Projection half of the basis contract; returns null on or behind the camera plane. */
export function projectDirectorWorldPointWithBasis(
  point: Tuple3,
  basis: DirectorMotionCameraBasis,
  width: number,
  height: number,
): Tuple2 | null {
  const offset = subtract(point, basis.position);
  const zForward = dot(offset, basis.forward);
  if (zForward <= DIRECTOR_MOTION_MIN_FORWARD_DISTANCE) return null;
  const ndcX = dot(offset, basis.right) / zForward / (basis.tanHalfFov * basis.aspect);
  const ndcY = dot(offset, basis.up) / zForward / basis.tanHalfFov;
  return [(ndcX * 0.5 + 0.5) * width, (1 - (ndcY * 0.5 + 0.5)) * height];
}

/**
 * Projects one world point through a pinhole look-at camera into raster
 * pixels (top-left origin, y down, matching the capture buffers' row order).
 * Returns null when the point is on or behind the camera plane.
 */
export function projectDirectorWorldPointToPixels(
  point: Tuple3,
  camera: DirectorMotionCameraPose,
  width: number,
  height: number,
): Tuple2 | null {
  assertRaster(width, "Motion pass width");
  assertRaster(height, "Motion pass height");
  return projectDirectorWorldPointWithBasis(point, getDirectorMotionCameraBasis(camera), width, height);
}

export interface ComputeDirectorObjectMotionVectorsInput {
  width: number;
  height: number;
  fromCamera: DirectorMotionCameraPose;
  toCamera: DirectorMotionCameraPose;
  fromAnchors: DirectorMotionObjectAnchor[];
  toAnchors: DirectorMotionObjectAnchor[];
}

/**
 * Exact per-object screen displacement between two evaluated frames. Camera
 * ego-motion is included by construction: a static object seen from a moving
 * camera yields a non-zero (parallax) vector. Objects whose anchor is not
 * projectable in either frame are omitted.
 */
export function computeDirectorObjectMotionVectors({
  width,
  height,
  fromCamera,
  toCamera,
  fromAnchors,
  toAnchors,
}: ComputeDirectorObjectMotionVectorsInput): DirectorObjectMotionVector[] {
  const fromById = new Map(fromAnchors.map((anchor) => [anchor.objectId, anchor]));
  const vectors: DirectorObjectMotionVector[] = [];
  for (const anchor of toAnchors) {
    const previous = fromById.get(anchor.objectId);
    if (!previous) continue;
    const fromPx = projectDirectorWorldPointToPixels(previous.position, fromCamera, width, height);
    const toPx = projectDirectorWorldPointToPixels(anchor.position, toCamera, width, height);
    if (!fromPx || !toPx) continue;
    vectors.push({
      objectId: anchor.objectId,
      fromPx,
      toPx,
      deltaPx: [toPx[0] - fromPx[0], toPx[1] - fromPx[1]],
    });
  }
  return vectors.sort((left, right) => (left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0));
}

/** For frame 0 there is no previous frame; both endpoints evaluate frame 0 (zero vectors). */
export function getDirectorMotionSourceFrames(frame: number): { fromFrame: number; toFrame: number } {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`Motion pass frame must be a non-negative integer; received ${String(frame)}.`);
  }
  return { fromFrame: Math.max(0, frame - 1), toFrame: frame };
}

function hsvToRgbBytes(hueDegrees: number, saturation: number, value: number): [number, number, number] {
  const hue = ((hueDegrees % 360) + 360) % 360;
  const chroma = value * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const sector = Math.floor(hue / 60) % 6;
  const [red, green, blue] =
    sector === 0
      ? [chroma, secondary, 0]
      : sector === 1
        ? [secondary, chroma, 0]
        : sector === 2
          ? [0, chroma, secondary]
          : sector === 3
            ? [0, secondary, chroma]
            : sector === 4
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const minimum = value - chroma;
  return [
    Math.round((red + minimum) * 255),
    Math.round((green + minimum) * 255),
    Math.round((blue + minimum) * 255),
  ];
}

/**
 * Optical-flow HSV convention on screen pixels (y down): hue is the vector
 * direction with rightward motion at 0 degrees (red) rotating through
 * downward = 90 degrees (green range); saturation is constant; brightness is
 * the magnitude normalized against maxMagnitudePx. Zero motion is black.
 */
export function motionVectorToHsvRgb(deltaPx: Tuple2, maxMagnitudePx: number): [number, number, number] {
  if (!Number.isFinite(maxMagnitudePx) || maxMagnitudePx <= 0) {
    throw new Error(`Motion pass maxMagnitudePx must be positive; received ${String(maxMagnitudePx)}.`);
  }
  const magnitude = Math.hypot(deltaPx[0], deltaPx[1]);
  if (magnitude === 0) return [0, 0, 0];
  const hueDegrees = (Math.atan2(deltaPx[1], deltaPx[0]) * 180) / Math.PI;
  return hsvToRgbBytes(hueDegrees, 1, Math.min(1, magnitude / maxMagnitudePx));
}

/** Computes the maximum motion magnitude in pixels for HSV normalization, as a fraction of the image diagonal. */
export function getDirectorMotionMaxMagnitudePx(width: number, height: number, diagonalFraction: number): number {
  if (!Number.isFinite(diagonalFraction) || diagonalFraction <= 0) {
    throw new Error(`Motion pass diagonal fraction must be positive; received ${String(diagonalFraction)}.`);
  }
  return Math.hypot(width, height) * diagonalFraction;
}

export interface ComposeDirectorMotionVectorPassInput {
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Same-frame object-id capture; used purely as the per-object region mask. */
  objectIdRgba: Uint8Array;
  /** Region-mask colors from the object-id capture metadata. */
  objectIdToRgb: Record<string, [number, number, number]>;
  /** Exact per-object screen-space vectors to paint. */
  vectors: DirectorObjectMotionVector[];
  /** Source frame index. */
  fromFrame: number;
  /** Destination frame index. */
  toFrame: number;
  /** Camera pose at the FROM frame. */
  fromCamera: DirectorMotionCameraPose;
  /** Camera pose at the TO frame. */
  toCamera: DirectorMotionCameraPose;
  /** Overrides DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION. */
  magnitudeDiagonalFraction?: number;
}

/**
 * Paints each object's motion color into its object-id silhouette. Pixels
 * outside every object silhouette stay black. Output is raw data-space RGBA8
 * matching the other technical passes (top-to-bottom rows, opaque alpha).
 */
export function composeDirectorMotionVectorPass({
  width,
  height,
  objectIdRgba,
  objectIdToRgb,
  vectors,
  fromFrame,
  toFrame,
  fromCamera,
  toCamera,
  magnitudeDiagonalFraction = DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION,
}: ComposeDirectorMotionVectorPassInput): DirectorMotionVectorPassResult {
  assertRaster(width, "Motion pass width");
  assertRaster(height, "Motion pass height");
  if (objectIdRgba.byteLength !== width * height * 4) {
    throw new Error(`Motion pass object-id buffer is ${objectIdRgba.byteLength} bytes; expected ${width * height * 4}.`);
  }
  const maxMagnitudePx = getDirectorMotionMaxMagnitudePx(width, height, magnitudeDiagonalFraction);

  const colorByPackedId = new Map<number, [number, number, number]>();
  const vectorById = new Map(vectors.map((vector) => [vector.objectId, vector]));
  for (const [objectId, [red, green, blue]] of Object.entries(objectIdToRgb)) {
    const vector = vectorById.get(objectId);
    if (!vector) continue;
    colorByPackedId.set((red << 16) | (green << 8) | blue, motionVectorToHsvRgb(vector.deltaPx, maxMagnitudePx));
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const packed = (objectIdRgba[offset]! << 16) | (objectIdRgba[offset + 1]! << 8) | objectIdRgba[offset + 2]!;
    const color = packed === 0 ? undefined : colorByPackedId.get(packed);
    if (color) {
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
    }
    rgba[offset + 3] = 255;
  }

  return {
    rgba,
    metadata: {
      renderPass: "motion",
      width,
      height,
      pixelFormat: "rgba8",
      bitsPerChannel: 8,
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: "motion-hsv-rgb",
      helpersExcluded: true,
      fromFrame,
      toFrame,
      normalization: {
        basis: "image-diagonal",
        fraction: magnitudeDiagonalFraction,
        maxMagnitudePx,
      },
      camera: { from: fromCamera, to: toCamera },
      objectVectors: vectors,
      objectIdToRgb,
    },
  };
}

export interface BuildDirectorMotionVectorSidecarInput {
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Source frame index. */
  fromFrame: number;
  /** Destination frame index. */
  toFrame: number;
  /** Camera pose at the FROM frame. */
  fromCamera: DirectorMotionCameraPose;
  /** Camera pose at the TO frame. */
  toCamera: DirectorMotionCameraPose;
  /** Exact per-object screen-space vectors. */
  vectors: DirectorObjectMotionVector[];
  /** Overrides DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION. */
  magnitudeDiagonalFraction?: number;
}

/** Portable JSON sidecar carrying the exact vectors the HSV raster encodes. */
export function buildDirectorMotionVectorSidecar({
  width,
  height,
  fromFrame,
  toFrame,
  fromCamera,
  toCamera,
  vectors,
  magnitudeDiagonalFraction = DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION,
}: BuildDirectorMotionVectorSidecarInput): DirectorMotionVectorSidecar {
  assertRaster(width, "Motion sidecar width");
  assertRaster(height, "Motion sidecar height");
  return {
    schemaVersion: 1,
    contract: DIRECTOR_MOTION_VECTORS_CONTRACT,
    fromFrame,
    toFrame,
    raster: { width, height },
    encoding: "motion-hsv-rgb",
    hsv: {
      hue: "screen-direction-degrees-atan2(dy,dx)",
      saturation: "constant-1",
      value: "magnitude-over-maxMagnitudePx-clamped",
    },
    normalization: {
      basis: "image-diagonal",
      fraction: magnitudeDiagonalFraction,
      maxMagnitudePx: getDirectorMotionMaxMagnitudePx(width, height, magnitudeDiagonalFraction),
    },
    camera: { from: fromCamera, to: toCamera },
    objects: vectors,
  };
}
