const MINIMUM_PERSPECTIVE_FOV = 0.1;
const MAXIMUM_PERSPECTIVE_FOV = 179.9;

/**
 * Preserve the director view's world-units-per-screen-pixel while a Blender-style
 * editor region changes height. This reveals or crops the surrounding scene
 * instead of auto-fitting or stretching the existing view.
 *
 * @param baseFov - The current vertical FOV in degrees.
 * @param baseHeight - The current viewport height in logical pixels.
 * @param nextHeight - The new viewport height in logical pixels.
 * @returns The adjusted vertical FOV in degrees that preserves pixel scale.
 */
export function getBlenderViewportFov(baseFov: number, baseHeight: number, nextHeight: number) {
  if (!Number.isFinite(baseFov) || !Number.isFinite(baseHeight) || !Number.isFinite(nextHeight)) {
    return baseFov;
  }

  const safeBaseHeight = Math.max(baseHeight, 1);
  const safeNextHeight = Math.max(nextHeight, 1);
  const halfBaseFovRadians =
    (Math.max(MINIMUM_PERSPECTIVE_FOV, Math.min(MAXIMUM_PERSPECTIVE_FOV, baseFov)) * Math.PI) / 360;
  const scaledHalfFovRadians = Math.atan(Math.tan(halfBaseFovRadians) * (safeNextHeight / safeBaseHeight));
  return Math.max(MINIMUM_PERSPECTIVE_FOV, Math.min(MAXIMUM_PERSPECTIVE_FOV, (scaledHalfFovRadians * 360) / Math.PI));
}
