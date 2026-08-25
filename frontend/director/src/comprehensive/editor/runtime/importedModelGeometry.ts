import { Box3, Vector3, type Object3D } from "three";

export const DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE = 2;

export type ImportedModelLocalBounds = {
  min: [number, number, number];
  max: [number, number, number];
};

/**
 * Shared viewport/export normalization for generic imported prop and scene
 * models. Character assets use their rig-specific height normalization.
 *
 * When the asset carries a real-world size in meters, the model is scaled so
 * its largest bounding-box dimension matches that metric size, keeping the
 * whole stage on one consistent scale. Legacy assets without a metric size
 * keep the historic display normalization (largest dimension = targetMaxSize).
 */
export function getImportedModelNormalization(
  bounds: Box3,
  targetMaxSize = DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE,
  mode: "auto" | "preserve" = "auto",
  grounded = false,
  realWorldSizeM?: number,
) {
  if (bounds.isEmpty()) {
    return {
      center: [0, 0, 0] as [number, number, number],
      position: [0, 0, 0] as [number, number, number],
      scale: 1,
    };
  }

  const size = new Vector3();
  const center = new Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  if (mode === "preserve") {
    const groundOffsetY = grounded ? -bounds.min.y : 0;
    return {
      center: [center.x, center.y + groundOffsetY, center.z] as [number, number, number],
      position: [0, groundOffsetY, 0] as [number, number, number],
      scale: 1,
    };
  }

  const metricTarget =
    realWorldSizeM !== undefined && Number.isFinite(realWorldSizeM) && realWorldSizeM > 0 ? realWorldSizeM : null;
  const maxSize = Math.max(size.x, size.y, size.z);
  const scale = Number.isFinite(maxSize) && maxSize > 0 ? (metricTarget ?? targetMaxSize) / maxSize : 1;

  return {
    center: [0, 0, 0] as [number, number, number],
    position: [-center.x * scale, -bounds.min.y * scale, -center.z * scale] as [number, number, number],
    scale,
  };
}

/** Converts source geometry bounds into the exact local space rendered by Director. */
export function getNormalizedImportedModelLocalBounds(
  bounds: Box3,
  normalization: { position: [number, number, number]; scale: number },
): ImportedModelLocalBounds | null {
  if (bounds.isEmpty()) return null;
  const { position, scale } = normalization;
  return {
    min: [bounds.min.x * scale + position[0], bounds.min.y * scale + position[1], bounds.min.z * scale + position[2]],
    max: [bounds.max.x * scale + position[0], bounds.max.y * scale + position[1], bounds.max.z * scale + position[2]],
  };
}

export function getPreciseImportedModelBounds(object: Object3D) {
  object.updateMatrixWorld(true);
  return new Box3().setFromObject(object, true);
}
