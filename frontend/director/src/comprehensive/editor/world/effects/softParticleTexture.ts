import { CanvasTexture, DataTexture, type Texture } from "three";

/**
 * Shared soft-particle sprite: one radial-gradient disc plus a few fixed
 * off-center lobes so per-particle rotation is actually visible. Generated
 * once per session from constants only (no randomness, no wall clock), shared
 * by every particle system, and never disposed — it is a single 128x128 RGBA
 * texture. The shader samples only the alpha channel.
 */

const TEXTURE_SIZE = 128;

/** Deterministic accent lobes: x, y, radius (px), alpha. */
const ACCENT_LOBES: readonly [number, number, number, number][] = [
  [84, 52, 26, 0.32],
  [48, 78, 30, 0.26],
  [70, 88, 18, 0.2],
];

let sharedTexture: Texture | null = null;

/**
 * Returns the shared soft-particle sprite texture, creating it once per session.
 *
 * The texture is a 128×128 RGBA radial-gradient disc with a few fixed off-center
 * accent lobes so per-particle rotation is visible. Generated from constants only
 * — no randomness, no wall clock — and shared by every particle system. Never
 * disposed during the session. In headless environments (jsdom) a 1×1 solid
 * fallback pixel keeps the material functional for logic tests.
 *
 * @returns The shared particle sprite texture (or a 1×1 fallback in headless).
 */
export function getSoftParticleTexture(): Texture {
  if (sharedTexture) return sharedTexture;

  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext("2d");

  if (!context) {
    // Headless environments (jsdom) have no 2D context; a solid pixel keeps
    // the material functional for logic tests without visual output.
    const fallback = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    fallback.needsUpdate = true;
    sharedTexture = fallback;
    return fallback;
  }

  const half = TEXTURE_SIZE / 2;
  const disc = context.createRadialGradient(half, half, 0, half, half, half);
  disc.addColorStop(0, "rgba(255,255,255,1)");
  disc.addColorStop(0.35, "rgba(255,255,255,0.72)");
  disc.addColorStop(0.75, "rgba(255,255,255,0.18)");
  disc.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = disc;
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  context.globalCompositeOperation = "lighter";
  for (const [x, y, radius, alpha] of ACCENT_LOBES) {
    const lobe = context.createRadialGradient(x, y, 0, x, y, radius);
    lobe.addColorStop(0, `rgba(255,255,255,${alpha})`);
    lobe.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = lobe;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  const texture = new CanvasTexture(canvas);
  sharedTexture = texture;
  return texture;
}
