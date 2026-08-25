import type { GeometryPrimitiveType } from "./directorProject";

/**
 * Local-space dimensions and pivot for a Director primitive geometry.
 *
 * Every primitive uses a floor pivot, so the authored transform position
 * sits at the bottom of the shape rather than its visual centre.
 */
export interface PrimitiveGeometryMetrics {
  /** Local-space dimensions before the owning Director transform is applied. */
  size: readonly [number, number, number];
  /** Local-space center. Every primitive uses a floor pivot at local Y = 0. */
  center: readonly [number, number, number];
}

/**
 * Single source of truth for Director primitive geometry.
 *
 * A primitive transform position is its floor pivot, not its visual centre.
 * For box/sphere/cylinder/cone/pyramid, transform.scale therefore maps to
 * exact width/height/depth in Director world units. A torus uses X/Z as its
 * outer diameter and Y as a multiplier for the canonical 0.25-unit thickness.
 */
export const DIRECTOR_PRIMITIVE_METRICS: Record<GeometryPrimitiveType, PrimitiveGeometryMetrics> = {
  box: { size: [1, 1, 1], center: [0, 0.5, 0] },
  sphere: { size: [1, 1, 1], center: [0, 0.5, 0] },
  cylinder: { size: [1, 1, 1], center: [0, 0.5, 0] },
  torus: { size: [1, 0.25, 1], center: [0, 0.125, 0] },
  cone: { size: [1, 1, 1], center: [0, 0.5, 0] },
  pyramid: { size: [1, 1, 1], center: [0, 0.5, 0] },
};

/**
 * Returns the canonical local-space metrics for a Director primitive type.
 *
 * @param type - The primitive geometry type to look up.
 * @returns The metrics record for that primitive, including its unit size and
 *  floor-pivoted center.
 */
export function getDirectorPrimitiveMetrics(type: GeometryPrimitiveType) {
  return DIRECTOR_PRIMITIVE_METRICS[type];
}
