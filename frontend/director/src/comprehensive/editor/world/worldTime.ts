import type { DirectorWorldTimeOfDay } from "../schema/directorProject";
import { normalizeDirectorFps } from "../timeline/frameTime";

/**
 * Living World time base.
 *
 * All world systems evaluate against `worldSeconds`, which is derived from the
 * timeline playhead. Deterministic frame export and timeline scrubbing render
 * arbitrary frames in any order, so nothing here may read wall-clock time.
 */
/**
 * Converts a timeline frame number to world seconds using the project frame rate.
 *
 * @param frame - The timeline frame number.
 * @param fps - The project frame rate (frames per second).
 * @returns World seconds elapsed at the given frame.
 */
export function getWorldSecondsForFrame(frame: number, fps: number): number {
  const safeFps = normalizeDirectorFps(fps);
  const safeFrame = Number.isFinite(frame) ? frame : 0;
  return safeFrame / safeFps;
}

/** Solar hours in [0, 24) at `worldSeconds`, honoring fixed vs. cycling day modes. */
export function evaluateWorldTimeOfDayHours(timeOfDay: DirectorWorldTimeOfDay, worldSeconds: number): number {
  if (timeOfDay.mode === "fixed") return ((timeOfDay.hours % 24) + 24) % 24;
  const cycleSeconds = Math.max(timeOfDay.cycleMinutes, 0.5) * 60;
  const hours = timeOfDay.hours + (worldSeconds / cycleSeconds) * 24;
  return ((hours % 24) + 24) % 24;
}
