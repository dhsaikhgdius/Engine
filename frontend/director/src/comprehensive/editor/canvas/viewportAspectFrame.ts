import { getViewportAspectRatioValue, type ViewportAspectRatio } from "@director/protocol/workbench-ui";

/** Padding (px) on each side of the aspect-ratio frame. */
export const FRAME_SIDE_PADDING = 40;
/** Padding (px) at the top of the aspect-ratio frame. */
export const FRAME_TOP_PADDING = 40;

/** Safe-area insets that reduce the available frame area. */
export interface ViewportSafeAreaInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The computed position and size of the aspect-ratio frame within the viewport. */
export interface ViewportFrameRect {
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Fits a rectangle of the given aspect ratio within the viewport, respecting
 * padding and safe-area insets. The frame is centered in the available area.
 *
 * @param width - The viewport width in px.
 * @param height - The viewport height in px.
 * @param ratio - The desired aspect ratio (width / height).
 * @param bottomPadding - Additional bottom padding in px.
 * @param safeAreaInsets - Safe-area insets to subtract from each edge.
 * @returns The frame rectangle.
 */
export function fitFrameWithinViewport(
  width: number,
  height: number,
  ratio: number,
  bottomPadding: number,
  safeAreaInsets: ViewportSafeAreaInsets = { left: 0, right: 0, top: 0, bottom: 0 },
): ViewportFrameRect {
  const safeLeft = FRAME_SIDE_PADDING + safeAreaInsets.left;
  const safeTop = FRAME_TOP_PADDING + safeAreaInsets.top;
  const safeRight = Math.max(width - FRAME_SIDE_PADDING - safeAreaInsets.right, safeLeft);
  const safeBottom = Math.max(height - Math.max(bottomPadding, FRAME_TOP_PADDING) - safeAreaInsets.bottom, safeTop);
  const safeWidth = Math.max(safeRight - safeLeft, 0);
  const safeHeight = Math.max(safeBottom - safeTop, 0);

  if (safeWidth === 0 || safeHeight === 0) {
    return {
      width: 0,
      height: 0,
      left: (safeLeft + safeRight) / 2,
      top: (safeTop + safeBottom) / 2,
    };
  }

  const safeRatio = safeWidth / safeHeight;
  const frameWidth = ratio >= safeRatio ? safeWidth : safeHeight * ratio;
  const frameHeight = ratio >= safeRatio ? safeWidth / ratio : safeHeight;

  return {
    width: frameWidth,
    height: frameHeight,
    left: safeLeft + (safeWidth - frameWidth) / 2,
    top: safeTop + (safeHeight - frameHeight) / 2,
  };
}

/**
 * Resolves a named aspect ratio and fits the corresponding frame within the viewport.
 * Returns null when the ratio cannot be resolved (e.g., "free").
 *
 * @param ratio - The named aspect ratio.
 * @param width - The viewport width in px.
 * @param height - The viewport height in px.
 * @param bottomPadding - Additional bottom padding in px.
 * @param safeAreaInsets - Safe-area insets to subtract from each edge.
 * @returns The frame rectangle, or null when the ratio is unresolvable.
 */
export function getViewportAspectFrameRect(
  ratio: ViewportAspectRatio,
  width: number,
  height: number,
  bottomPadding: number = FRAME_TOP_PADDING,
  safeAreaInsets: ViewportSafeAreaInsets = { left: 0, right: 0, top: 0, bottom: 0 },
) {
  const ratioValue = getViewportAspectRatioValue(ratio);
  if (!ratioValue) return null;

  return fitFrameWithinViewport(width, height, ratioValue, bottomPadding, safeAreaInsets);
}
