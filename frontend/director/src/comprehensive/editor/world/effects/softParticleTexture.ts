import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, UnsignedByteType, type Texture } from "three";

/**
 * Shared effect sprite atlas: ONE 128x128 RGBA texture whose four channels
 * carry four different particle masks, so every kind can read a distinct
 * silhouette without a second texture bind or a per-kind atlas:
 *
 * - `a` — soft radial disc with fixed accent lobes (smoke, steam, dust,
 *   sparks, fireflies, rain streaks). The accent lobes keep per-particle
 *   rotation visible, matching the legacy single-channel sprite.
 * - `r` — flame tongue: a metaball teardrop, dense at the base and feathered
 *   toward the tip at v = 1, eroded further by fragment-shader noise.
 * - `g` — six-armed snow crystal with side branchlets and a soft core.
 * - `b` — splash crown: a thin expanding ring for rain ground ripples.
 *
 * The atlas is computed analytically in JS (no canvas, no gradients), so the
 * byte payload is identical across machines and testable in jsdom. Generated
 * once per session from constants only — no randomness, no wall clock — and
 * never disposed. Channel selection lives in effectShaders.ts
 * (`EFFECT_SPRITE_MASK_CHANNELS`).
 */

/** Square atlas edge in pixels; power of two so mipmaps stay clean. */
export const EFFECT_SPRITE_TEXTURE_SIZE = 128;

/** Deterministic accent lobes in UV space: u, v, radius, alpha. */
const ACCENT_LOBES_UV: readonly [number, number, number, number][] = [
  [0.656, 0.406, 0.203, 0.32],
  [0.375, 0.609, 0.234, 0.26],
  [0.547, 0.688, 0.141, 0.2],
];

/** Flame spine metaballs bottom-to-top: u offset from centre, v, radius. */
const FLAME_SPINE: readonly [number, number, number][] = [
  [0.0, 0.14, 0.2],
  [0.012, 0.27, 0.18],
  [-0.014, 0.4, 0.155],
  [0.016, 0.53, 0.13],
  [-0.012, 0.65, 0.105],
  [0.008, 0.77, 0.075],
  [0.0, 0.87, 0.048],
];

/** Snow crystal geometry: arm length, base half-width, branch parameters. */
const FLAKE_ARM_LENGTH = 0.42;
const FLAKE_ARM_WIDTH = 0.03;
const FLAKE_BRANCH_START = 0.24;
const FLAKE_BRANCH_LENGTH = 0.11;
const FLAKE_BRANCH_WIDTH = 0.016;
const FLAKE_CORE_RADIUS = 0.07;

/** Splash crown ring: centre radius and gaussian half-width in UV space. */
const SPLASH_RING_RADIUS = 0.33;
const SPLASH_RING_WIDTH = 0.06;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Legacy soft disc: piecewise radial falloff plus fixed accent lobes. */
function discMask(u: number, v: number): number {
  const t = Math.min(1, Math.hypot(u - 0.5, v - 0.5) / 0.5);
  let alpha: number;
  if (t < 0.35) alpha = 1 + ((0.72 - 1) * t) / 0.35;
  else if (t < 0.75) alpha = 0.72 + ((0.18 - 0.72) * (t - 0.35)) / 0.4;
  else alpha = 0.18 * (1 - (t - 0.75) / 0.25);
  for (const [lobeU, lobeV, lobeR, lobeA] of ACCENT_LOBES_UV) {
    const distance = Math.hypot(u - lobeU, v - lobeV);
    if (distance < lobeR) alpha += lobeA * (1 - distance / lobeR);
  }
  return clamp01(alpha);
}

/** Flame tongue: metaball field over the spine, dense base, feathered tip. */
function flameMask(u: number, v: number): number {
  let field = 0;
  for (const [offsetU, spineV, radius] of FLAME_SPINE) {
    const distance = Math.hypot(u - 0.5 - offsetU, v - spineV) / radius;
    if (distance < 1) field += (1 - distance) * (1 - distance);
  }
  // Fade the base so the quad's bottom edge never shows a hard cut.
  return clamp01(smoothstep(0.1, 0.8, field)) * smoothstep(0, 0.07, v);
}

/** One tapered ray from `origin` along `(dirU, dirV)`: 1 at the spine, 0 outside. */
function armField(
  u: number,
  v: number,
  originU: number,
  originV: number,
  dirU: number,
  dirV: number,
  length: number,
  width: number,
): number {
  const relU = u - originU;
  const relV = v - originV;
  const along = relU * dirU + relV * dirV;
  if (along < 0 || along > length) return 0;
  const across = Math.abs(relU * dirV - relV * dirU);
  const taper = width * (1 - (0.75 * along) / length) + 0.006;
  return clamp01(1 - across / taper) * smoothstep(length, length * 0.82, along);
}

/** Six-armed snow crystal with side branchlets and a soft hexagonal core. */
function flakeMask(u: number, v: number): number {
  let best = clamp01(1 - Math.hypot(u - 0.5, v - 0.5) / FLAKE_CORE_RADIUS);
  for (let arm = 0; arm < 6; arm += 1) {
    const angle = (arm * Math.PI) / 3;
    const dirU = Math.cos(angle);
    const dirV = Math.sin(angle);
    best = Math.max(best, armField(u, v, 0.5, 0.5, dirU, dirV, FLAKE_ARM_LENGTH, FLAKE_ARM_WIDTH));
    // Two branchlets forking at +/-60 degrees partway along each arm.
    const forkU = 0.5 + dirU * FLAKE_BRANCH_START;
    const forkV = 0.5 + dirV * FLAKE_BRANCH_START;
    for (const side of [-1, 1]) {
      const branchAngle = angle + (side * Math.PI) / 3;
      best = Math.max(
        best,
        armField(u, v, forkU, forkV, Math.cos(branchAngle), Math.sin(branchAngle), FLAKE_BRANCH_LENGTH, FLAKE_BRANCH_WIDTH),
      );
    }
  }
  return best;
}

/** Splash crown: gaussian ring band that the vertex shader expands over life. */
function ringMask(u: number, v: number): number {
  const distance = Math.hypot(u - 0.5, v - 0.5);
  const band = (distance - SPLASH_RING_RADIUS) / SPLASH_RING_WIDTH;
  return clamp01(Math.exp(-band * band));
}

/**
 * Builds the raw RGBA atlas payload. Pure function of module constants: two
 * calls return byte-identical arrays on every machine, which is what lets
 * the determinism tests pin the sprite without a GL context.
 *
 * Row 0 maps to v = 0 (mask "up" is v = 1), matching DataTexture's default
 * `flipY = false` upload orientation.
 */
export function buildEffectSpriteAtlasData(): Uint8Array {
  const size = EFFECT_SPRITE_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  let offset = 0;
  for (let row = 0; row < size; row += 1) {
    const v = (row + 0.5) / size;
    for (let column = 0; column < size; column += 1) {
      const u = (column + 0.5) / size;
      data[offset] = Math.round(flameMask(u, v) * 255);
      data[offset + 1] = Math.round(flakeMask(u, v) * 255);
      data[offset + 2] = Math.round(ringMask(u, v) * 255);
      data[offset + 3] = Math.round(discMask(u, v) * 255);
      offset += 4;
    }
  }
  return data;
}

let sharedTexture: Texture | null = null;

/**
 * Returns the shared sprite atlas texture, creating it once per session.
 *
 * Built from {@link buildEffectSpriteAtlasData} — analytic, seedless, and
 * wall-clock-free — and shared by every particle system. Never disposed
 * during the session.
 *
 * @returns The shared 128x128 RGBA sprite atlas.
 */
export function getSoftParticleTexture(): Texture {
  if (sharedTexture) return sharedTexture;
  const texture = new DataTexture(
    buildEffectSpriteAtlasData(),
    EFFECT_SPRITE_TEXTURE_SIZE,
    EFFECT_SPRITE_TEXTURE_SIZE,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  texture.name = "director-effect-sprite-atlas";
  sharedTexture = texture;
  return texture;
}
