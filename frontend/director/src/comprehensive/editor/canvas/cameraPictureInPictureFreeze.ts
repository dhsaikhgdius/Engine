import type { WebGLRenderer, WebGLRenderTarget } from "three";
import { getCameraPictureInPictureFreezeLayer } from "./viewportChromeDrag";

/**
 * Flip a WebGL readPixels buffer into canvas ImageData row order.
 * WebGL reads bottom-to-top; canvas ImageData is top-to-bottom.
 *
 * @param source - The raw RGBA pixel buffer from readPixels.
 * @param width - The image width in pixels.
 * @param height - The image height in pixels.
 * @param destination - The target ImageData.data array to write into.
 */
export function blitFlippedRgba(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  destination: Uint8ClampedArray,
) {
  const row = width * 4;
  for (let y = 0; y < height; y += 1) {
    const srcStart = (height - 1 - y) * row;
    destination.set(source.subarray(srcStart, srcStart + row), y * row);
  }
}

/**
 * Copy the last camera-preview FBO onto the overlay freeze layer so a drag can
 * follow the pointer without re-rendering the stage.
 *
 * @param gl - A WebGLRenderer with readRenderTargetPixels capability.
 * @param target - The render target to read from.
 * @returns Whether the freeze layer was successfully updated.
 */
export function copyPictureInPicturePreviewToFreezeCanvas(
  gl: Pick<WebGLRenderer, "readRenderTargetPixels">,
  target: WebGLRenderTarget,
) {
  const layer = getCameraPictureInPictureFreezeLayer();
  const width = target.width;
  const height = target.height;
  if (!layer || width < 2 || height < 2) return false;
  try {
    const pixels = new Uint8Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    const canvas = layer.ownerDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return false;
    const imageData = ctx.createImageData(width, height);
    blitFlippedRgba(pixels, width, height, imageData.data);
    ctx.putImageData(imageData, 0, 0);
    layer.style.backgroundImage = `url(${canvas.toDataURL("image/png")})`;
    layer.style.backgroundSize = "100% 100%";
    return true;
  } catch {
    return false;
  }
}
