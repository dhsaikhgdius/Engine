const PANORAMA_FORWARD_ALIGNMENT_DEGREES = 90;
const PANORAMA_GROUND_OPACITY_CAP = 0.1;

/**
 * Converts a panorama yaw angle to the rotation (in radians) needed to align
 * the panorama with the forward direction of the scene.
 *
 * @param yaw - The panorama yaw angle in degrees.
 * @returns The rotation in radians.
 */
export function getPanoramaRotationRadians(yaw: number) {
  return ((yaw + PANORAMA_FORWARD_ALIGNMENT_DEGREES) * Math.PI) / 180;
}

/**
 * Caps the ground opacity when a panorama is active, so the ground plane
 * doesn't visually compete with the panoramic background.
 *
 * @param baseOpacity - The ground material's base opacity.
 * @param hasPanorama - Whether a panorama is currently active.
 * @returns The effective opacity, capped at 0.1 when a panorama is active.
 */
export function getEffectiveGroundOpacity(baseOpacity: number, hasPanorama: boolean) {
  if (!hasPanorama) return baseOpacity;
  return Math.min(baseOpacity, PANORAMA_GROUND_OPACITY_CAP);
}
