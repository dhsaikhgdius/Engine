/** Minimum allowed fps value. */
export const MIN_DIRECTOR_FPS = 1;
/** Maximum allowed fps value. */
export const MAX_DIRECTOR_FPS = 240;
// A scene can span about 99 years at 24 fps. This remains a JavaScript-safe
// integer while making the timeline effectively unbounded for real projects.
/** Maximum allowed timeline frame number. */
export const MAX_DIRECTOR_TIMELINE_FRAME = 75_000_000_000;

/**
 * Checks whether a value is a valid timeline frame.
 *
 * @param value - The value to check.
 * @returns True if the value is a safe non-negative integer within bounds.
 */
export function isDirectorTimelineFrame(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DIRECTOR_TIMELINE_FRAME;
}

/** Creates a default timeline: 24 fps, frames 0-240. */
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
 * Normalizes an fps value to the valid range [1, 240], rounded to microsecond precision.
 *
 * @param value - The raw fps value.
 * @param fallback - Default fps when the value is not finite.
 * @returns The normalized fps.
 */
export function normalizeDirectorFps(value: number, fallback = 24) {
  if (!Number.isFinite(value)) return normalizeDirectorFps(fallback, 24);
  const clamped = Math.min(MAX_DIRECTOR_FPS, Math.max(MIN_DIRECTOR_FPS, value));
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

/**
 * Converts a frame number to elapsed seconds at the given frame rate.
 *
 * @param frame - The frame number.
 * @param fps - The frame rate.
 * @returns Elapsed time in seconds.
 */
export function frameToTimeSec(frame: number, fps: DirectorFrameRateInput) {
  return frameToTimeSecAtRate(frame, fps);
}

/**
 * Converts elapsed seconds to the nearest frame at the given frame rate.
 *
 * @param timeSec - Elapsed time in seconds.
 * @param fps - The frame rate.
 * @returns The nearest frame number.
 */
export function timeSecToFrame(timeSec: number, fps: DirectorFrameRateInput) {
  return timeSecToFrameAtRate(timeSec, fps);
}

export function frameToTimeSecAtRate(frame: number, rate: DirectorFrameRateInput) {
  return (
    Math.round((Math.round(frame) / frameRateToNumber(normalizeDirectorFrameRate(rate))) * 1_000_000_000) /
    1_000_000_000
  );
}

export function timeSecToFrameAtRate(timeSec: number, rate: DirectorFrameRateInput) {
  if (!Number.isFinite(timeSec)) return 0;
  return Math.round(timeSec * frameRateToNumber(normalizeDirectorFrameRate(rate)));
}

/**
 * Clamps a frame number to the given bounds, normalizing invalid bounds.
 *
 * @param frame - The frame to clamp.
 * @param frameStart - The lower bound.
 * @param frameEnd - The upper bound.
 * @returns The clamped frame.
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
 * Formats a frame number as elapsed seconds with millisecond precision.
 *
 * @param frame - The frame number.
 * @param fps - The frame rate.
 * @returns A string like "1.500".
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
