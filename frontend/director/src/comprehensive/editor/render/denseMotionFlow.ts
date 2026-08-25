import {
  DIRECTOR_MOTION_MIN_FORWARD_DISTANCE,
  getDirectorMotionCameraBasis,
  type DirectorMotionCameraPose,
  type DirectorObjectMotionVector,
} from "./motionVectorPass";

/**
 * Dense per-pixel optical flow for one deterministic frame pair, exported as
 * a float EXR next to the HSV motion PNG.
 *
 * Anchoring and direction (the raster is top-left origin, y down, matching
 * every other capture buffer):
 *
 * - Values live on the TO frame's pixel grid (the captured frame). The vector
 *   stored at pixel p is `deltaPx = toPx - fromPx` with `toPx = p` (sampled at
 *   the pixel centre): "how far did the content visible at p move between the
 *   FROM frame and the TO frame". This matches the per-object
 *   `DirectorObjectMotionVector.deltaPx` convention exactly.
 *
 * Composition rule (explicit, also mirrored in the semantics block):
 *
 * 1. Static geometry and background: the TO-frame linear eye depth is
 *    unprojected through the TO camera to a world point, the point is assumed
 *    static across the pair, and it is reprojected through the FROM camera.
 *    This models the flow caused purely by camera ego-motion.
 * 2. Background pixels: the float depth capture resolves pixels with no
 *    rendered geometry to the far clipping plane
 *    (DirectorShotDepthSemantics.background = "far-plane"), so rule 1
 *    reprojects the far-plane point for them. Camera rotation therefore still
 *    produces full-strength background flow, while camera translation
 *    produces the (near-zero) parallax of a far-plane point — the correct
 *    limit for distant background.
 * 3. Dynamic objects: rule 1 is wrong for objects whose anchors move between
 *    the frames, because the reprojection assumes a static world point.
 *    Inside each object silhouette of the same-frame (TO) object-id raster,
 *    the exact per-object vector replaces the reprojection. Both encodings
 *    share the `toPx - fromPx` direction, so the override is a drop-in.
 */

export const DIRECTOR_DENSE_MOTION_FLOW_CONTRACT = "director-dense-motion-flow-v1" as const;

/**
 * JSON-portable semantics for dataset manifests and sidecars, analogous to
 * DirectorShotDepthSemantics for the depth EXR. Constant across frames: the
 * FROM frame of any captured frame N is max(0, N - 1), and frame 0 pairs with
 * itself (zero flow by construction).
 */
export interface DirectorDenseMotionFlowSemantics {
  contract: typeof DIRECTOR_DENSE_MOTION_FLOW_CONTRACT;
  representation: "dense-screen-space-motion";
  units: "pixels";
  raster: "top-left-origin-y-down";
  anchor: "to-frame-pixel-centers";
  direction: "to-minus-from";
  framePairing: "previous-frame-to-current";
  channels: { R: "delta-x-pixels"; G: "delta-y-pixels" };
  pixelType: "float32";
  staticGeometry: "to-depth-reprojected-through-from-camera";
  background: "far-plane-reprojection";
  dynamicObjects: "object-id-silhouette-vector-override";
  depthSource: "to-frame-linear-eye-depth-metres";
  unprojectable: "zero-flow";
}

export const DIRECTOR_DENSE_MOTION_FLOW_SEMANTICS: DirectorDenseMotionFlowSemantics = {
  contract: DIRECTOR_DENSE_MOTION_FLOW_CONTRACT,
  representation: "dense-screen-space-motion",
  units: "pixels",
  raster: "top-left-origin-y-down",
  anchor: "to-frame-pixel-centers",
  direction: "to-minus-from",
  framePairing: "previous-frame-to-current",
  channels: { R: "delta-x-pixels", G: "delta-y-pixels" },
  pixelType: "float32",
  staticGeometry: "to-depth-reprojected-through-from-camera",
  background: "far-plane-reprojection",
  dynamicObjects: "object-id-silhouette-vector-override",
  depthSource: "to-frame-linear-eye-depth-metres",
  unprojectable: "zero-flow",
};

export interface DirectorDenseMotionFlowMetadata {
  /** The pass identifier, always "motion" for dense flow. */
  renderPass: "motion";
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Two float32 components per pixel, interleaved [dx, dy]. */
  pixelFormat: "float32x2";
  /** Bits per channel (32 for float32). */
  bitsPerChannel: 32;
  /** Pixel rows are stored top-to-bottom. */
  rowOrder: "top-to-bottom";
  /** Data-space encoding, never color-managed. */
  colorSpace: "data";
  /** Encoding identifier for the dense motion flow pixel format. */
  encoding: "dense-motion-flow-pixels";
  /** Editor helpers are always excluded from this pass. */
  helpersExcluded: true;
  /** Source frame index (N-1 for frame N; 0 pairs with itself). */
  fromFrame: number;
  /** Destination frame index. */
  toFrame: number;
  /** Immutable semantics describing the flow representation. */
  semantics: DirectorDenseMotionFlowSemantics;
  /** Camera poses used for the FROM and TO frames. */
  camera: { from: DirectorMotionCameraPose; to: DirectorMotionCameraPose };
  /** Pixels whose static world point is on/behind the FROM camera plane; written as zero flow. */
  unprojectablePixels: number;
  /** Pixels replaced by an exact per-object vector inside an object-id silhouette. */
  objectOverridePixels: number;
}

/** A complete dense motion flow field: the interleaved float32 pixel data and its metadata. */
export interface DirectorDenseMotionFlowField {
  /** Row-major, top-to-bottom; interleaved [dx, dy] screen pixels per raster pixel. */
  flow: Float32Array;
  metadata: DirectorDenseMotionFlowMetadata;
}

export interface ComputeDirectorDenseMotionFlowInput {
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
  /**
   * Linear eye-space depth in metres along the TO camera's forward axis,
   * captured at the TO frame (captureDirectorDepthFloat semantics: row-major
   * top-to-bottom, background resolved to the far plane).
   */
  toDepth: Float32Array;
  /** Same-frame (TO) object-id capture used as the dynamic-object region mask. */
  objectIdRgba?: Uint8Array;
  /** Region-mask colors from that capture's metadata. */
  objectIdToRgb?: Record<string, [number, number, number]>;
  /** Exact per-object vectors (deltaPx = toPx - fromPx) that override the reprojection. */
  objectVectors?: DirectorObjectMotionVector[];
}

function assertRaster(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 16_384) {
    throw new Error(`${label} must be an integer between 1 and 16384; received ${String(value)}.`);
  }
}

function posesAreIdentical(left: DirectorMotionCameraPose, right: DirectorMotionCameraPose): boolean {
  return (
    left.position[0] === right.position[0] &&
    left.position[1] === right.position[1] &&
    left.position[2] === right.position[2] &&
    left.target[0] === right.target[0] &&
    left.target[1] === right.target[1] &&
    left.target[2] === right.target[2] &&
    left.fovDegrees === right.fovDegrees &&
    left.aspect === right.aspect
  );
}

/**
 * Computes the dense flow field described in the module contract. Identical
 * FROM/TO poses short-circuit the reprojection to exact zeros (frame 0 and
 * static cameras produce bit-clean zero background flow instead of
 * floating-point round-trip noise); object silhouette overrides still apply.
 */
export function computeDirectorDenseMotionFlow({
  width,
  height,
  fromFrame,
  toFrame,
  fromCamera,
  toCamera,
  toDepth,
  objectIdRgba,
  objectIdToRgb,
  objectVectors,
}: ComputeDirectorDenseMotionFlowInput): DirectorDenseMotionFlowField {
  assertRaster(width, "Dense motion flow width");
  assertRaster(height, "Dense motion flow height");
  if (toDepth.length !== width * height) {
    throw new Error(`Dense motion flow depth must contain ${width * height} floats; received ${toDepth.length}.`);
  }
  if (objectIdRgba && objectIdRgba.byteLength !== width * height * 4) {
    throw new Error(
      `Dense motion flow object-id buffer is ${objectIdRgba.byteLength} bytes; expected ${width * height * 4}.`,
    );
  }
  // Validate both poses up front even when the short-circuit skips their use.
  const fromBasis = getDirectorMotionCameraBasis(fromCamera);
  const toBasis = getDirectorMotionCameraBasis(toCamera);
  const cameraMoved = !posesAreIdentical(fromCamera, toCamera);

  const overrideByPackedColor = new Map<number, [number, number]>();
  if (objectIdRgba && objectIdToRgb && objectVectors?.length) {
    const vectorById = new Map(objectVectors.map((vector) => [vector.objectId, vector.deltaPx]));
    for (const [objectId, [red, green, blue]] of Object.entries(objectIdToRgb)) {
      const deltaPx = vectorById.get(objectId);
      if (!deltaPx) continue;
      overrideByPackedColor.set((red << 16) | (green << 8) | blue, [deltaPx[0], deltaPx[1]]);
    }
  }

  const flow = new Float32Array(width * height * 2);
  let unprojectablePixels = 0;
  let objectOverridePixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const depth = toDepth[pixel]!;
      if (!Number.isFinite(depth) || depth <= 0) {
        throw new Error(`Dense motion flow depth at pixel (${x}, ${y}) must be a positive metre value.`);
      }

      let deltaX = 0;
      let deltaY = 0;
      if (cameraMoved) {
        // Unproject the TO pixel centre through the TO camera: the linear eye
        // depth is the distance along the forward axis, so the view-plane
        // offsets scale with depth * tan(fov/2).
        const pixelCenterX = x + 0.5;
        const pixelCenterY = y + 0.5;
        const ndcX = (2 * pixelCenterX) / width - 1;
        const ndcY = 1 - (2 * pixelCenterY) / height;
        const viewX = ndcX * toBasis.tanHalfFov * toBasis.aspect * depth;
        const viewY = ndcY * toBasis.tanHalfFov * depth;
        const worldX =
          toBasis.position[0] + toBasis.right[0] * viewX + toBasis.up[0] * viewY + toBasis.forward[0] * depth;
        const worldY =
          toBasis.position[1] + toBasis.right[1] * viewX + toBasis.up[1] * viewY + toBasis.forward[1] * depth;
        const worldZ =
          toBasis.position[2] + toBasis.right[2] * viewX + toBasis.up[2] * viewY + toBasis.forward[2] * depth;

        // Project the (assumed static) world point through the FROM camera;
        // scalar mirror of projectDirectorWorldPointWithBasis.
        const offsetX = worldX - fromBasis.position[0];
        const offsetY = worldY - fromBasis.position[1];
        const offsetZ = worldZ - fromBasis.position[2];
        const zForward =
          offsetX * fromBasis.forward[0] + offsetY * fromBasis.forward[1] + offsetZ * fromBasis.forward[2];
        if (zForward <= DIRECTOR_MOTION_MIN_FORWARD_DISTANCE) {
          unprojectablePixels += 1;
        } else {
          const fromNdcX =
            (offsetX * fromBasis.right[0] + offsetY * fromBasis.right[1] + offsetZ * fromBasis.right[2]) /
            zForward /
            (fromBasis.tanHalfFov * fromBasis.aspect);
          const fromNdcY =
            (offsetX * fromBasis.up[0] + offsetY * fromBasis.up[1] + offsetZ * fromBasis.up[2]) /
            zForward /
            fromBasis.tanHalfFov;
          const fromPxX = (fromNdcX * 0.5 + 0.5) * width;
          const fromPxY = (1 - (fromNdcY * 0.5 + 0.5)) * height;
          deltaX = pixelCenterX - fromPxX;
          deltaY = pixelCenterY - fromPxY;
        }
      }

      if (objectIdRgba && overrideByPackedColor.size) {
        const byteOffset = pixel * 4;
        const packed =
          (objectIdRgba[byteOffset]! << 16) | (objectIdRgba[byteOffset + 1]! << 8) | objectIdRgba[byteOffset + 2]!;
        // Packed 0 is the object-id background clear, never a silhouette.
        const override = packed === 0 ? undefined : overrideByPackedColor.get(packed);
        if (override) {
          deltaX = override[0];
          deltaY = override[1];
          objectOverridePixels += 1;
        }
      }

      flow[pixel * 2] = deltaX;
      flow[pixel * 2 + 1] = deltaY;
    }
  }

  return {
    flow,
    metadata: {
      renderPass: "motion",
      width,
      height,
      pixelFormat: "float32x2",
      bitsPerChannel: 32,
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: "dense-motion-flow-pixels",
      helpersExcluded: true,
      fromFrame,
      toFrame,
      semantics: DIRECTOR_DENSE_MOTION_FLOW_SEMANTICS,
      camera: { from: fromCamera, to: toCamera },
      unprojectablePixels,
      objectOverridePixels,
    },
  };
}
