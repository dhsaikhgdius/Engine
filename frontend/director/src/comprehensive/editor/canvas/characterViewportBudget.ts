import type { CharacterAnimationSampling } from "../performance/performanceProfiles";

/**
 * Distance-based viewport budgets for character-heavy scenes.
 *
 * Skeletal pose sampling and screen-space name labels are the two per-character
 * costs that grow without bound in crowd scenes. Both degrade smoothly with
 * camera distance instead of all at once: far characters re-pose on a coarser
 * timeline stride (their transforms still interpolate every frame, so movement
 * stays smooth), and labels beyond the budget drop farthest-first while the
 * selection always keeps its label.
 */

/** Full-rate pose sampling inside this camera radius. */
export const DIRECTOR_CHARACTER_ANIMATION_LOD_NEAR_M = 20;
/** Between near and far the pose samples every 2nd frame; beyond, every 4th. */
export const DIRECTOR_CHARACTER_ANIMATION_LOD_FAR_M = 45;
/** Label DOM overlays rendered at most for this many characters. */
export const DIRECTOR_VIEWPORT_CHARACTER_LABEL_BUDGET = 40;

/** The number of frames between pose-sampling evaluations for a character. */
export type DirectorCharacterFrameStride = 1 | 2 | 4;

/**
 * Unknown distances (no camera yet, detached scene root) must never degrade
 * quality, so they resolve to the full-rate stride.
 *
 * @param distanceM - Camera distance in metres, or null when unknown.
 * @returns The frame stride for skeletal pose sampling.
 */
export function getDirectorCharacterFrameStride(distanceM: number | null): DirectorCharacterFrameStride {
  if (distanceM === null || !Number.isFinite(distanceM)) return 1;
  if (distanceM < DIRECTOR_CHARACTER_ANIMATION_LOD_NEAR_M) return 1;
  return distanceM < DIRECTOR_CHARACTER_ANIMATION_LOD_FAR_M ? 2 : 4;
}

/**
 * Full sampling is an explicit no-LOD contract, including distant crowds.
 *
 * @param distanceM - Camera distance in metres, or null when unknown.
 * @param sampling - The requested animation sampling mode.
 * @returns The frame stride to use.
 */
export function getDirectorCharacterFrameStrideForMode(
  distanceM: number | null,
  sampling: CharacterAnimationSampling,
): DirectorCharacterFrameStride {
  return sampling === "full" ? 1 : getDirectorCharacterFrameStride(distanceM);
}

/**
 * Snaps a playback frame down onto the stride grid. Consumers key React memo
 * and effect dependencies off the returned value, so a whole stride window
 * collapses into one skeletal sampling pass.
 *
 * @param frame - The current playback frame number.
 * @param stride - The frame stride from `getDirectorCharacterFrameStride`.
 * @returns The quantized frame number.
 */
export function quantizeDirectorCharacterPlaybackFrame(frame: number, stride: DirectorCharacterFrameStride) {
  if (stride <= 1 || !Number.isFinite(frame)) return frame;
  return Math.floor(frame / stride) * stride;
}

/** A candidate for a viewport label overlay, identified by id and distance. */
export interface DirectorViewportLabelCandidate {
  id: string;
  distanceM: number | null;
}

/**
 * Ranks label candidates by camera distance once the budget is exceeded.
 * Returns null while every candidate fits, so typical scenes keep the exact
 * current behavior with zero extra work per label.
 *
 * @param candidates - All label candidates ordered by priority.
 * @param alwaysLabeledIds - IDs that must always be labeled (e.g., selection).
 * @param budget - Maximum number of labels to show.
 * @returns The set of allowed IDs, or null when all candidates fit.
 */
export function selectDirectorViewportLabelIds(
  candidates: readonly DirectorViewportLabelCandidate[],
  alwaysLabeledIds: ReadonlySet<string>,
  budget = DIRECTOR_VIEWPORT_CHARACTER_LABEL_BUDGET,
): ReadonlySet<string> | null {
  if (candidates.length <= budget) return null;

  const allowed = new Set<string>();
  for (const candidate of candidates) {
    if (alwaysLabeledIds.has(candidate.id)) allowed.add(candidate.id);
  }
  const ranked = candidates
    .filter((candidate) => !allowed.has(candidate.id))
    .sort((left, right) => (left.distanceM ?? Infinity) - (right.distanceM ?? Infinity));
  for (const candidate of ranked) {
    if (allowed.size >= budget) break;
    allowed.add(candidate.id);
  }
  return allowed;
}
