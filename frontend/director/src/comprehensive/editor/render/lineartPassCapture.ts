import type { DirectorRenderPassCaptureMetadata } from "./renderPassCapture";

export const DIRECTOR_LINEART_ENCODING = "lineart-binary-rgb" as const;

export interface DirectorLineartThresholds {
  /**
   * Minimum packed-window-depth step (0..1) treated as an edge at depth 0.
   * The Sobel gradient magnitude is normalised so this reads as a depth step.
   */
  depthBase: number;
  /**
   * Linearly grows the depth threshold with the centre pixel depth so distant
   * geometry (where packed window depth is compressed) does not produce noise.
   * Effective threshold: depthBase * (1 + depthDistanceScale * depth).
   */
  depthDistanceScale: number;
  /**
   * Minimum dot product between neighbouring view-space normals. A crease
   * whose neighbouring normals disagree more than this becomes a line.
   */
  normalDot: number;
}

export const DIRECTOR_LINEART_DEFAULT_THRESHOLDS: DirectorLineartThresholds = {
  depthBase: 0.005,
  depthDistanceScale: 5,
  normalDot: 0.85,
};

/** Metadata for a lineart pass, which is always composed from depth and normal sources rather than rendered directly. */
export interface DirectorLineartPassCaptureMetadata extends DirectorRenderPassCaptureMetadata {
  renderPass: "lineart";
  colorSpace: "data";
  encoding: typeof DIRECTOR_LINEART_ENCODING;
  /** The edge-detection thresholds used for this composition. */
  thresholds: DirectorLineartThresholds;
}

/** The RGBA pixel payload and its companion metadata for a composed lineart pass. */
export interface DirectorLineartPassCaptureResult {
  rgba: Uint8Array;
  metadata: DirectorLineartPassCaptureMetadata;
}

export interface DirectorLineartSourcePass {
  /** RGBA8 pixel data for this source pass. */
  rgba: Uint8Array;
  /** Subset of render-pass metadata needed for lineart composition. */
  metadata: Pick<DirectorRenderPassCaptureMetadata, "width" | "height" | "encoding">;
}

export interface ComposeDirectorLineartPassInput {
  /** Same-frame depth pass captured with RGBADepthPacking (rgba-depth-packed). */
  depth: DirectorLineartSourcePass;
  /** Same-frame normal pass captured with MeshNormalMaterial (view-normal-rgb). */
  normal: DirectorLineartSourcePass;
  /** Optional edge-detection thresholds; merged with the defaults. */
  thresholds?: Partial<DirectorLineartThresholds>;
}

function assertRaster(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Lineart raster must have positive integer dimensions; received ${width}x${height}.`);
  }
}

function assertRgbaLength(rgba: Uint8Array, width: number, height: number, label: string): void {
  if (rgba.length !== width * height * 4) {
    throw new Error(`${label} RGBA byte length ${rgba.length} does not match ${width}x${height}.`);
  }
}

// Inverse of three.js packDepthToRGBA (RGBADepthPacking): alpha carries the
// coarse value, r/g/b refine it, everything scaled by UnpackDownscale 255/256.
const UNPACK_DOWNSCALE = 255 / 256;
const UNPACK_FACTORS = [
  UNPACK_DOWNSCALE / (256 * 256 * 256),
  UNPACK_DOWNSCALE / (256 * 256),
  UNPACK_DOWNSCALE / 256,
  UNPACK_DOWNSCALE,
] as const;

/** Unpacks an RGBADepthPacking buffer into 0..1 window-depth floats. */
export function unpackDirectorRgbaDepth(rgba: Uint8Array, width: number, height: number): Float32Array {
  assertRaster(width, height);
  assertRgbaLength(rgba, width, height, "Depth pass");
  const depth = new Float32Array(width * height);
  for (let pixel = 0; pixel < depth.length; pixel += 1) {
    const offset = pixel * 4;
    depth[pixel] =
      (rgba[offset]! / 255) * UNPACK_FACTORS[0] +
      (rgba[offset + 1]! / 255) * UNPACK_FACTORS[1] +
      (rgba[offset + 2]! / 255) * UNPACK_FACTORS[2] +
      (rgba[offset + 3]! / 255) * UNPACK_FACTORS[3];
  }
  return depth;
}

/** Decodes a view-normal RGB buffer into unit vectors, 3 floats per pixel. */
export function decodeDirectorViewNormals(rgba: Uint8Array, width: number, height: number): Float32Array {
  assertRaster(width, height);
  assertRgbaLength(rgba, width, height, "Normal pass");
  const normals = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const x = (rgba[offset]! / 255) * 2 - 1;
    const y = (rgba[offset + 1]! / 255) * 2 - 1;
    const z = (rgba[offset + 2]! / 255) * 2 - 1;
    const length = Math.hypot(x, y, z);
    const target = pixel * 3;
    if (length < 1e-6) {
      normals[target] = 0;
      normals[target + 1] = 0;
      normals[target + 2] = 1;
    } else {
      normals[target] = x / length;
      normals[target + 1] = y / length;
      normals[target + 2] = z / length;
    }
  }
  return normals;
}

/**
 * Marks depth discontinuities with a Sobel operator whose gradient magnitude
 * is normalised to a per-pixel depth step, using a depth-adaptive threshold.
 */
export function detectDirectorDepthEdges(
  depth: Float32Array,
  width: number,
  height: number,
  thresholds: Pick<DirectorLineartThresholds, "depthBase" | "depthDistanceScale"> = DIRECTOR_LINEART_DEFAULT_THRESHOLDS,
): Uint8Array {
  assertRaster(width, height);
  if (depth.length !== width * height) {
    throw new Error(`Depth buffer length ${depth.length} does not match ${width}x${height}.`);
  }
  const edges = new Uint8Array(width * height);
  const sample = (x: number, y: number): number =>
    depth[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gradientX =
        sample(x + 1, y - 1) +
        2 * sample(x + 1, y) +
        sample(x + 1, y + 1) -
        sample(x - 1, y - 1) -
        2 * sample(x - 1, y) -
        sample(x - 1, y + 1);
      const gradientY =
        sample(x - 1, y + 1) +
        2 * sample(x, y + 1) +
        sample(x + 1, y + 1) -
        sample(x - 1, y - 1) -
        2 * sample(x, y - 1) -
        sample(x + 1, y - 1);
      // A unit step produces a Sobel magnitude of 4, so /4 reads as depth step.
      const magnitude = Math.hypot(gradientX, gradientY) / 4;
      const centre = sample(x, y);
      const threshold = thresholds.depthBase * (1 + thresholds.depthDistanceScale * centre);
      if (magnitude > threshold) edges[y * width + x] = 1;
    }
  }
  return edges;
}

/** Marks creases where a pixel's normal diverges from its right/down neighbour. */
export function detectDirectorNormalEdges(
  normals: Float32Array,
  width: number,
  height: number,
  normalDotThreshold: number = DIRECTOR_LINEART_DEFAULT_THRESHOLDS.normalDot,
): Uint8Array {
  assertRaster(width, height);
  if (normals.length !== width * height * 3) {
    throw new Error(`Normal buffer length ${normals.length} does not match ${width}x${height}.`);
  }
  const edges = new Uint8Array(width * height);
  const dot = (a: number, b: number): number =>
    normals[a * 3]! * normals[b * 3]! + normals[a * 3 + 1]! * normals[b * 3 + 1]! + normals[a * 3 + 2]! * normals[b * 3 + 2]!;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (x + 1 < width && dot(pixel, pixel + 1) < normalDotThreshold) {
        edges[pixel] = 1;
        continue;
      }
      if (y + 1 < height && dot(pixel, pixel + width) < normalDotThreshold) {
        edges[pixel] = 1;
      }
    }
  }
  return edges;
}

/** Unions both edge masks into a binary white-lines-on-black RGBA8 raster. */
export function composeDirectorLineartRgba(
  depthEdges: Uint8Array,
  normalEdges: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  assertRaster(width, height);
  const pixelCount = width * height;
  if (depthEdges.length !== pixelCount || normalEdges.length !== pixelCount) {
    throw new Error(`Edge masks must both contain ${pixelCount} pixels.`);
  }
  const rgba = new Uint8Array(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const value = depthEdges[pixel]! || normalEdges[pixel]! ? 255 : 0;
    const offset = pixel * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

/**
 * Derives a clean geometry lineart pass (white lines on black, ControlNet
 * lineart/scribble ready) from the same-frame depth and normal captures.
 */
export function composeDirectorLineartPass({
  depth,
  normal,
  thresholds,
}: ComposeDirectorLineartPassInput): DirectorLineartPassCaptureResult {
  if (depth.metadata.encoding !== "rgba-depth-packed") {
    throw new Error(`Lineart requires an rgba-depth-packed depth pass; received "${depth.metadata.encoding}".`);
  }
  if (normal.metadata.encoding !== "view-normal-rgb") {
    throw new Error(`Lineart requires a view-normal-rgb normal pass; received "${normal.metadata.encoding}".`);
  }
  const { width, height } = depth.metadata;
  if (normal.metadata.width !== width || normal.metadata.height !== height) {
    throw new Error(
      `Lineart depth raster ${width}x${height} does not match normal raster ${normal.metadata.width}x${normal.metadata.height}.`,
    );
  }
  const resolved: DirectorLineartThresholds = { ...DIRECTOR_LINEART_DEFAULT_THRESHOLDS, ...thresholds };
  const depthValues = unpackDirectorRgbaDepth(depth.rgba, width, height);
  const normalVectors = decodeDirectorViewNormals(normal.rgba, width, height);
  const rgba = composeDirectorLineartRgba(
    detectDirectorDepthEdges(depthValues, width, height, resolved),
    detectDirectorNormalEdges(normalVectors, width, height, resolved.normalDot),
    width,
    height,
  );
  return {
    rgba,
    metadata: {
      renderPass: "lineart",
      width,
      height,
      pixelFormat: "rgba8",
      bitsPerChannel: 8,
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: DIRECTOR_LINEART_ENCODING,
      helpersExcluded: true,
      thresholds: resolved,
    },
  };
}
