import type { PlayerPosition } from "./playerLocomotion";

export type PlayerInteractionCandidate = {
  /** Unique stable identifier for deterministic tie-breaking. */
  id: string;
  /** World-space position of the interactable object. */
  position: PlayerPosition;
  /** Localized prompt text to display in the HUD. */
  prompt: string;
  /** Interaction radius in meters (horizontal-plane distance). */
  radiusM: number;
};

/**
 * Selects one deterministic, nearby interaction in the player's floor plane.
 * When multiple candidates are within range, the nearest wins; ties break on
 * lexical id order for determinism.
 *
 * @param candidates - The set of interactable objects to consider.
 * @param playerPosition - The player's current world-space position.
 * @returns The nearest in-range candidate, or null when none qualify.
 */
export function selectNearestPlayerInteraction(
  candidates: readonly PlayerInteractionCandidate[],
  playerPosition: PlayerPosition,
): PlayerInteractionCandidate | null {
  let selected: PlayerInteractionCandidate | null = null;
  let selectedDistanceSq = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const verticalDistance = Math.abs(candidate.position[1] - playerPosition[1]);
    if (verticalDistance > Math.max(candidate.radiusM, 2)) continue;
    const dx = candidate.position[0] - playerPosition[0];
    const dz = candidate.position[2] - playerPosition[2];
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq > candidate.radiusM * candidate.radiusM) continue;
    if (
      distanceSq < selectedDistanceSq ||
      (distanceSq === selectedDistanceSq && candidate.id.localeCompare(selected?.id ?? "") < 0)
    ) {
      selected = candidate;
      selectedDistanceSq = distanceSq;
    }
  }
  return selected;
}
