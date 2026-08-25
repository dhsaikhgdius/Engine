/** Minimum supported frames-per-second for timeline display. */
export const MIN_DIRECTOR_FPS = 1;
/** Maximum supported frames-per-second for timeline display. */
export const MAX_DIRECTOR_FPS = 240;
// A scene can span about 99 years at 24 fps. This remains a JavaScript-safe
// integer while making the timeline effectively unbounded for real projects.
export const MAX_DIRECTOR_TIMELINE_FRAME = 75_000_000_000;

/**
 * Validates that a value is a valid timeline frame number.
 *
 * A valid frame is a non-negative safe integer within the supported range.
 *
 * @param value - The frame number to validate.
 * @returns True when the value is a valid timeline frame.
 */
export function isDirectorTimelineFrame(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DIRECTOR_TIMELINE_FRAME;
}

/**
 * Creates a default frame timeline with 24 fps, 240 frames, starting at frame 0.
 *
 * @returns A fresh default frame timeline object.
 */
export function createDefaultDirectorFrameTimeline() {
  return {
    version: 1 as const,
    fps: 24,
    timebase: createDefaultDirectorTimebase(),
    frameStart: 0,
    frameEnd: 240,
    currentFrame: 0,
    loop: false,
  };
}

/**
 * Clamps and rounds a fps value to the supported range with microsecond precision.
 *
 * Non-finite values fall back to the provided fallback (default 24).
 *
 * @param value - The raw fps value to normalize.
 * @param fallback - Fallback fps when the value is non-finite.
 * @returns A clamped fps value rounded to 6 decimal places.
 */
export function normalizeDirectorFps(value: number, fallback = 24) {
  if (!Number.isFinite(value)) return normalizeDirectorFps(fallback, 24);
  const clamped = Math.min(MAX_DIRECTOR_FPS, Math.max(MIN_DIRECTOR_FPS, value));
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

/**
 * Converts a frame number to time in seconds at the given frame rate.
 *
 * @param frame - The frame number to convert.
 * @param fps - The frame rate to use for the conversion.
 * @returns The equivalent time in seconds.
 */
export function frameToTimeSec(frame: number, fps: DirectorFrameRateInput) {
  return frameToTimeSecAtRate(frame, fps);
}

/**
 * Converts time in seconds to a frame number at the given frame rate.
 *
 * @param timeSec - The time in seconds to convert.
 * @param fps - The frame rate to use for the conversion.
 * @returns The nearest frame number, rounded.
 */
export function timeSecToFrame(timeSec: number, fps: DirectorFrameRateInput) {
  return timeSecToFrameAtRate(timeSec, fps);
}

/**
 * Converts a frame number to time in seconds, with nanosecond output precision.
 *
 * @param frame - The frame number to convert.
 * @param rate - The frame rate as any supported input.
 * @returns The equivalent time in seconds, rounded to nanosecond precision.
 */
export function frameToTimeSecAtRate(frame: number, rate: DirectorFrameRateInput) {
  return (
    Math.round((Math.round(frame) / frameRateToNumber(normalizeDirectorFrameRate(rate))) * 1_000_000_000) /
    1_000_000_000
  );
}

/**
 * Converts time in seconds to the nearest frame number.
 *
 * Non-finite time values return frame 0.
 *
 * @param timeSec - The time in seconds to convert.
 * @param rate - The frame rate as any supported input.
 * @returns The nearest integer frame number.
 */
export function timeSecToFrameAtRate(timeSec: number, rate: DirectorFrameRateInput) {
  if (!Number.isFinite(timeSec)) return 0;
  return Math.round(timeSec * frameRateToNumber(normalizeDirectorFrameRate(rate)));
}

/**
 * Clamps a frame number to the valid range defined by start and end bounds.
 *
 * Non-finite bounds are replaced with safe defaults; start and end are ordered
 * so that the range is always non-empty.
 *
 * @param frame - The frame number to clamp.
 * @param frameStart - The inclusive lower bound.
 * @param frameEnd - The inclusive upper bound.
 * @returns The frame clamped to [frameStart, frameEnd].
 */
export function clampTimelineFrame(frame: number, frameStart: number, frameEnd: number) {
  const normalizeBound = (value: number, fallback: number) => {
    if (!Number.isFinite(value)) return fallback;
    const rounded = Math.round(value);
    return isDirectorTimelineFrame(rounded) ? rounded : fallback;
  };
  const normalizedStart = normalizeBound(frameStart, 0);
  const normalizedEnd = normalizeBound(frameEnd, normalizedStart);
  const start = Math.round(Math.min(normalizedStart, normalizedEnd));
  const end = Math.round(Math.max(normalizedStart, normalizedEnd));
  const candidate = normalizeBound(frame, start);
  return Math.min(end, Math.max(start, candidate));
}

/**
 * Formats a frame number as a time string with millisecond precision.
 *
 * @param frame - The frame number to format.
 * @param fps - The frame rate to use for the conversion.
 * @returns A time string in seconds with 3 decimal places, e.g. "1.500".
 */
export function formatFrameTime(frame: number, fps: number) {
  return frameToTimeSec(frame, fps).toFixed(3);
}
import {
  createDefaultDirectorTimebase,
  frameRateToNumber,
  normalizeDirectorFrameRate,
  type DirectorFrameRateInput,
} from "./frameRate";
