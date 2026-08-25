import { Color, type WebGLRenderer, type WebGLRenderTarget } from "three";

const MAX_RENDER_DIMENSION = 16_384;

/** Snapshot of mutable WebGL renderer state for save/restore across capture passes. */
export interface DirectorRendererStateSnapshot {
  /** Currently bound render target, or null for the default framebuffer. */
  renderTarget: WebGLRenderTarget | null;
  /** Active cube face of the bound render target. */
  activeCubeFace: number;
  /** Active mipmap level of the bound render target. */
  activeMipmapLevel: number;
  /** Current clear color. */
  clearColor: Color;
  /** Current clear alpha. */
  clearAlpha: number;
  /** Renderer output color space string. */
  outputColorSpace: string;
  /** Current tone mapping mode. */
  toneMapping: WebGLRenderer["toneMapping"];
  /** Current tone mapping exposure. */
  toneMappingExposure: number;
  /** Whether auto-clear is enabled. */
  autoClear: boolean;
  /** Whether auto-clear of the color buffer is enabled. */
  autoClearColor: boolean;
  /** Whether auto-clear of the depth buffer is enabled. */
  autoClearDepth: boolean;
  /** Whether auto-clear of the stencil buffer is enabled. */
  autoClearStencil: boolean;
}

/**
 * Validates that a render dimension is a positive integer ≤ 16384.
 *
 * @param value - The dimension to validate.
 * @param label - Human-readable label for the error message.
 */
export function assertDirectorRenderDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RENDER_DIMENSION) {
    throw new Error(`${label} must be an integer between 1 and ${MAX_RENDER_DIMENSION}; received ${String(value)}.`);
  }
}

/**
 * Captures a snapshot of mutable renderer state so a capture pass can
 * temporarily reconfigure it and restore it afterwards.
 *
 * @param renderer - The WebGL renderer to snapshot.
 * @returns A snapshot of the current renderer state.
 */
export function snapshotDirectorRendererState(renderer: WebGLRenderer): DirectorRendererStateSnapshot {
  return {
    renderTarget: renderer.getRenderTarget(),
    activeCubeFace: renderer.getActiveCubeFace(),
    activeMipmapLevel: renderer.getActiveMipmapLevel(),
    clearColor: renderer.getClearColor(new Color()).clone(),
    clearAlpha: renderer.getClearAlpha(),
    outputColorSpace: renderer.outputColorSpace,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    autoClear: renderer.autoClear,
    autoClearColor: renderer.autoClearColor,
    autoClearDepth: renderer.autoClearDepth,
    autoClearStencil: renderer.autoClearStencil,
  };
}

/**
 * Restores renderer state from a snapshot taken by `snapshotDirectorRendererState`.
 *
 * @param renderer - The WebGL renderer to restore.
 * @param state - The snapshot to restore from.
 */
export function restoreDirectorRendererState(renderer: WebGLRenderer, state: DirectorRendererStateSnapshot): void {
  renderer.outputColorSpace = state.outputColorSpace;
  renderer.toneMapping = state.toneMapping;
  renderer.toneMappingExposure = state.toneMappingExposure;
  renderer.autoClear = state.autoClear;
  renderer.autoClearColor = state.autoClearColor;
  renderer.autoClearDepth = state.autoClearDepth;
  renderer.autoClearStencil = state.autoClearStencil;
  renderer.setClearColor(state.clearColor, state.clearAlpha);
  renderer.setRenderTarget(state.renderTarget, state.activeCubeFace, state.activeMipmapLevel);
}

/**
 * Converts read-back render-target pixels to straight (non-premultiplied)
 * alpha for PNG delivery. Rendering over a fully transparent clear color with
 * three's default "over" blending — and any MSAA resolve or weighted DoF
 * gather on top — yields premultiplied color; PNG consumers expect straight
 * RGBA, so semi-transparent pixels are divided by their coverage. Opaque and
 * fully empty pixels pass through untouched.
 */
export function unpremultiplyDirectorRgbaInPlace(rgba: Uint8Array): void {
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const alpha = rgba[offset + 3]!;
    if (alpha === 0 || alpha === 255) continue;
    rgba[offset] = Math.min(255, Math.round((rgba[offset]! * 255) / alpha));
    rgba[offset + 1] = Math.min(255, Math.round((rgba[offset + 1]! * 255) / alpha));
    rgba[offset + 2] = Math.min(255, Math.round((rgba[offset + 2]! * 255) / alpha));
  }
}

/**
 * Flips an RGBA8 buffer in-place from bottom-to-top row order to top-to-bottom.
 * The buffer is mutated; allocate a copy beforehand if the original is needed.
 *
 * @param rgba - The RGBA pixel buffer (width × height × 4 bytes).
 * @param width - Raster width in pixels.
 * @param height - Raster height in pixels.
 */
export function flipDirectorRgbaRowsInPlace(rgba: Uint8Array, width: number, height: number): void {
  const rowLength = width * 4;
  const row = new Uint8Array(rowLength);
  for (let top = 0; top < Math.floor(height / 2); top += 1) {
    const bottom = height - top - 1;
    const topOffset = top * rowLength;
    const bottomOffset = bottom * rowLength;
    row.set(rgba.subarray(topOffset, topOffset + rowLength));
    rgba.copyWithin(topOffset, bottomOffset, bottomOffset + rowLength);
    rgba.set(row, bottomOffset);
  }
}
