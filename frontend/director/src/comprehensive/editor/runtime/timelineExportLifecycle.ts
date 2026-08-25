/**
 * Timeline export lifecycle management.
 *
 * Freezes the timeline during export (hides helpers, pauses playback)
 * and restores the prior state on completion or failure.
 *
 * @module director/runtime/timelineExportLifecycle
 */

/** Snapshot of the timeline state taken before an export begins. */
export interface DirectorTimelineExportSnapshot {
  frame: number;
  isPlaying: boolean;
  helpersHidden: boolean;
}

/** Lifecycle hooks for pausing and restoring timeline state during export. */
export interface DirectorTimelineExportLifecycle {
  readSnapshot: () => DirectorTimelineExportSnapshot;
  setExporting: (exporting: boolean) => void;
  setHelpersHidden: (hidden: boolean) => void;
  setPlaying: (playing: boolean) => void;
  restorePlayback: (frame: number, playing: boolean) => void;
}

/** Options for customizing post-export playback restoration. */
export interface DirectorTimelineExportOptions<T> {
  playbackAfterSuccess?: (
    result: T,
    snapshot: DirectorTimelineExportSnapshot,
  ) => Pick<DirectorTimelineExportSnapshot, "frame" | "isPlaying">;
}

/**
 * Run an async export task with timeline state frozen, then restore.
 *
 * @param lifecycle - The timeline lifecycle hooks.
 * @param work - The export task to run.
 * @param options - Optional post-export playback restoration.
 * @returns The result of the export task.
 */
export async function runWithTimelineExportRestore<T>(
  lifecycle: DirectorTimelineExportLifecycle,
  work: () => Promise<T>,
  options: DirectorTimelineExportOptions<T> = {},
) {
  const snapshot = lifecycle.readSnapshot();
  let completed = false;
  lifecycle.setExporting(true);
  lifecycle.setHelpersHidden(true);
  lifecycle.setPlaying(false);
  try {
    const result = await work();
    completed = true;
    const playback = options.playbackAfterSuccess?.(result, snapshot) ?? snapshot;
    lifecycle.restorePlayback(playback.frame, playback.isPlaying);
    return result;
  } finally {
    try {
      if (!completed) lifecycle.restorePlayback(snapshot.frame, snapshot.isPlaying);
    } finally {
      lifecycle.setHelpersHidden(snapshot.helpersHidden);
      lifecycle.setExporting(false);
    }
  }
}
