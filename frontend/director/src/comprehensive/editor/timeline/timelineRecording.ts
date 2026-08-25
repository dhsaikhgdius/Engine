import { clampTimelineFrame } from "./frameTime";

/** The lifecycle status of a timeline recording session. */
export type DirectorTimelineRecordingStatus = "idle" | "preparing" | "recording" | "paused" | "finalizing";
/** Actions that can transition the recording state machine. */
export type DirectorTimelineRecordingAction = "start" | "resume" | "pause" | "stop";

/** Settings for a timeline recording export. */
export interface DirectorTimelineRecordingSettings {
  /** Output format. */
  format: "auto" | "webm" | "mp4";
  /** IN/OUT frame range for the export. */
  exportRange: {
    in: number;
    out: number;
  };
  /** Frame where manual recording starts. */
  manualStart: number;
}

/** The timeline frame bounds for clamping recording settings. */
export interface TimelineRecordingBounds {
  /** First frame of the timeline. */
  frameStart: number;
  /** Last frame of the timeline. */
  frameEnd: number;
}

/**
 * Creates default recording settings covering the full timeline range.
 *
 * @param bounds - The timeline frame bounds.
 * @returns Default settings with the export range covering the full timeline.
 */
export function createTimelineRecordingSettings({
  frameStart,
  frameEnd,
}: TimelineRecordingBounds): DirectorTimelineRecordingSettings {
  const start = Math.min(frameStart, frameEnd);
  const end = Math.max(frameStart, frameEnd);
  return {
    format: "auto",
    exportRange: { in: start, out: end },
    manualStart: start,
  };
}

/**
 * Normalizes recording settings to stay within the timeline bounds.
 *
 * @param settings - The current settings.
 * @param bounds - The timeline frame bounds.
 * @returns Settings with all frame values clamped to bounds.
 */
export function normalizeTimelineRecordingSettings(
  settings: DirectorTimelineRecordingSettings,
  { frameStart, frameEnd }: TimelineRecordingBounds,
): DirectorTimelineRecordingSettings {
  const start = Math.min(frameStart, frameEnd);
  const end = Math.max(frameStart, frameEnd);
  const exportIn = clampTimelineFrame(settings.exportRange.in, start, end);
  const exportOut = clampTimelineFrame(settings.exportRange.out, start, end);
  return {
    ...settings,
    exportRange: {
      in: Math.min(exportIn, exportOut),
      out: Math.max(exportIn, exportOut),
    },
    manualStart: clampTimelineFrame(settings.manualStart, start, end),
  };
}
