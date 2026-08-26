/**
 * Pure Canvas board pan/zoom helpers shared by the UI and director_creative
 * agent ops (`canvas.board.set_viewport` / `canvas.board.fit_content`).
 */

/** Minimum board zoom (matches store clamp and agent schema). */
export const CANVAS_BOARD_VIEWPORT_ZOOM_MIN = 0.1;
/** Maximum board zoom (matches store clamp and agent schema). */
export const CANVAS_BOARD_VIEWPORT_ZOOM_MAX = 2.5;
/** Default surface width when agents fit without a live DOM measure. */
export const CANVAS_BOARD_FIT_DEFAULT_SURFACE_WIDTH = 1_280;
/** Default surface height when agents fit without a live DOM measure. */
export const CANVAS_BOARD_FIT_DEFAULT_SURFACE_HEIGHT = 800;
/** Default inset subtracted from the surface before framing node bounds. */
export const CANVAS_BOARD_FIT_DEFAULT_PADDING = 120;
/** Cap on fit zoom so a single node does not fill the entire surface. */
export const CANVAS_BOARD_FIT_MAX_ZOOM = 1.35;

/** Board pan/zoom state projected on observe as `board.viewport`. */
export type CanvasBoardViewport = {
  x: number;
  y: number;
  zoom: number;
};

/** Minimal node box used when fitting content. */
export type CanvasBoardFitNode = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Clamps zoom into the shared Canvas board range.
 *
 * @param zoom - Requested zoom factor.
 * @returns Zoom clamped to {@link CANVAS_BOARD_VIEWPORT_ZOOM_MIN}–
 *   {@link CANVAS_BOARD_VIEWPORT_ZOOM_MAX}, or `1` when non-finite.
 */
export function clampCanvasBoardZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(CANVAS_BOARD_VIEWPORT_ZOOM_MAX, Math.max(CANVAS_BOARD_VIEWPORT_ZOOM_MIN, zoom));
}

/**
 * Normalizes a viewport write: finite pan, clamped zoom.
 *
 * @param viewport - Requested pan/zoom.
 * @returns A store-safe viewport.
 */
export function normalizeCanvasBoardViewport(viewport: CanvasBoardViewport): CanvasBoardViewport {
  return {
    x: Number.isFinite(viewport.x) ? viewport.x : 0,
    y: Number.isFinite(viewport.y) ? viewport.y : 0,
    zoom: clampCanvasBoardZoom(viewport.zoom),
  };
}

/**
 * Frames every node into a surface rectangle. Empty boards (or non-positive
 * surfaces) reset to identity `{ x: 0, y: 0, zoom: 1 }`.
 *
 * @param nodes - Board nodes to frame.
 * @param surface - Visible surface size in CSS pixels.
 * @param options - Optional padding and max zoom overrides.
 * @returns The viewport that centers the node bounds in the surface.
 */
export function computeCanvasBoardFitViewport(
  nodes: readonly CanvasBoardFitNode[],
  surface: { width: number; height: number },
  options: { padding?: number; maxZoom?: number } = {},
): CanvasBoardViewport {
  const padding = options.padding ?? CANVAS_BOARD_FIT_DEFAULT_PADDING;
  const maxZoom = options.maxZoom ?? CANVAS_BOARD_FIT_MAX_ZOOM;
  if (!nodes.length || !(surface.width > 0) || !(surface.height > 0)) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const usableWidth = Math.max(1, surface.width - padding);
  const usableHeight = Math.max(1, surface.height - padding);
  const zoom = clampCanvasBoardZoom(Math.min(maxZoom, usableWidth / contentWidth, usableHeight / contentHeight));
  return {
    x: (surface.width - contentWidth * zoom) / 2 - minX * zoom,
    y: (surface.height - contentHeight * zoom) / 2 - minY * zoom,
    zoom,
  };
}
