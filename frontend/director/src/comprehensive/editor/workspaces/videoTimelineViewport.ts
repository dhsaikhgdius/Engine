/**
 * Pure Video Editor timeline zoom helpers shared by the UI and
 * director_creative agent ops (`edit.timeline.set_zoom` / `edit.timeline.fit`).
 */

/** Minimum timeline zoom (matches store clamp and agent schema). */
export const DIRECTOR_TIMELINE_ZOOM_MIN = 0.5;
/** Maximum timeline zoom (matches store clamp and agent schema). */
export const DIRECTOR_TIMELINE_ZOOM_MAX = 4;
/** Timeline horizontal scale at zoom 1, in CSS pixels per second. */
export const DIRECTOR_TIMELINE_BASE_PIXELS_PER_SECOND = 72;
/** Default visible width when agents fit without a live DOM measure (the workspace's minimum timeline width). */
export const DIRECTOR_TIMELINE_FIT_DEFAULT_SURFACE_WIDTH = 960;
/** Gutter subtracted from the surface so the final clip edge is not flush with the scroller. */
export const DIRECTOR_TIMELINE_FIT_GUTTER_PX = 16;

/**
 * Clamps zoom into the shared timeline range.
 *
 * @param zoom - Requested zoom factor.
 * @returns Zoom clamped to {@link DIRECTOR_TIMELINE_ZOOM_MIN}–
 *   {@link DIRECTOR_TIMELINE_ZOOM_MAX}; non-finite input collapses to the
 *   minimum, matching the workspace store clamp.
 */
export function clampDirectorTimelineZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DIRECTOR_TIMELINE_ZOOM_MIN;
  return Math.min(DIRECTOR_TIMELINE_ZOOM_MAX, Math.max(DIRECTOR_TIMELINE_ZOOM_MIN, zoom));
}

/**
 * Zoom that fits a content span into a visible timeline width.
 *
 * @param contentSpanSec - Edited content span in seconds; spans below one
 *   second fit as one second so an almost-empty timeline does not pin the
 *   zoom to the maximum.
 * @param surfaceWidth - Visible timeline width in CSS pixels.
 * @returns The clamped zoom that renders the span into the surface minus the
 *   {@link DIRECTOR_TIMELINE_FIT_GUTTER_PX} gutter.
 */
export function computeDirectorTimelineFitZoom(contentSpanSec: number, surfaceWidth: number): number {
  const span = Math.max(1, Number.isFinite(contentSpanSec) ? contentSpanSec : 0);
  const width = Number.isFinite(surfaceWidth) ? surfaceWidth : DIRECTOR_TIMELINE_FIT_DEFAULT_SURFACE_WIDTH;
  return clampDirectorTimelineZoom(
    (width - DIRECTOR_TIMELINE_FIT_GUTTER_PX) / (span * DIRECTOR_TIMELINE_BASE_PIXELS_PER_SECOND),
  );
}
