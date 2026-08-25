import { CanvasTexture, DataTexture, type Texture } from "three";

/**
 * Module-cached radial-gradient sprites for the sky layer (cloud puff, sun
 * disc, sun glow). Each texture is generated once per session from constants
 * only — no randomness, no wall clock — shared by every consumer, and never
 * disposed. All sprites are white; tinting happens in materials/shaders.
 */

const TEXTURE_SIZE = 128;

type GradientStop = readonly [offset: number, alpha: number];

function createRadialSpriteTexture(stops: readonly GradientStop[]): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext("2d");

  if (!context) {
    // Headless environments (jsdom) have no 2D context; a solid pixel keeps
    // materials functional for logic tests without visual output.
    const fallback = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    fallback.needsUpdate = true;
    return fallback;
  }

  const half = TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(half, half, 0, half, half, half);
  for (const [offset, alpha] of stops) {
    gradient.addColorStop(offset, `rgba(255,255,255,${alpha})`);
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  return new CanvasTexture(canvas);
}

let cloudSpriteTexture: Texture | null = null;

/** Wide, soft falloff: overlapping quads accumulate into puffy cluster bodies. */
export function getCloudSpriteTexture(): Texture {
  cloudSpriteTexture ??= createRadialSpriteTexture([
    [0, 1],
    [0.4, 0.85],
    [0.72, 0.32],
    [1, 0],
  ]);
  return cloudSpriteTexture;
}

let sunDiscTexture: Texture | null = null;

/** Near-solid core with a tight soft limb, so the disc reads crisp at 0.8°. */
export function getSunDiscTexture(): Texture {
  sunDiscTexture ??= createRadialSpriteTexture([
    [0, 1],
    [0.46, 1],
    [0.6, 0.85],
    [0.78, 0.12],
    [1, 0],
  ]);
  return sunDiscTexture;
}

let sunGlowTexture: Texture | null = null;

/** Long-tailed halo for the wide horizon-glow quad around the disc. */
export function getSunGlowTexture(): Texture {
  sunGlowTexture ??= createRadialSpriteTexture([
    [0, 0.9],
    [0.28, 0.4],
    [0.62, 0.12],
    [1, 0],
  ]);
  return sunGlowTexture;
}
