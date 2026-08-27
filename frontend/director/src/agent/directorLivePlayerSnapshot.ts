/**
 * Live Player Mode snapshot for Agent observe / possession preflight.
 *
 * Player Mode lives in DirectorCanvas React state (not the persisted Director
 * UI document). Canvas publishes here on every enter/exit/set_actor change so
 * `observe { fields:["ui"] }` and the gateway possession gate can read the
 * constrained live actor without parsing session-command receipts.
 */

/**
 * Point-in-time view of live Player Mode: whether it is active and which
 * character the human is possessing (null whenever Player Mode is off).
 */
export type DirectorLivePlayerSnapshot = {
  playerMode: boolean;
  playerActorId: string | null;
};

// Module-level singleton: there is exactly one Stage viewport owner per tab,
// so a plain variable (no store/subscription machinery) is sufficient.
let snapshot: DirectorLivePlayerSnapshot = {
  playerMode: false,
  playerActorId: null,
};

/** Read the last published live Player Mode snapshot. */
export function getDirectorLivePlayerSnapshot(): DirectorLivePlayerSnapshot {
  return snapshot;
}

/**
 * Publish the live Player Mode snapshot from the Stage viewport owner.
 *
 * @param next - Current player_mode and actor id (null when idle).
 */
export function setDirectorLivePlayerSnapshot(next: DirectorLivePlayerSnapshot) {
  snapshot = {
    playerMode: Boolean(next.playerMode),
    playerActorId: next.playerMode && next.playerActorId ? next.playerActorId : null,
  };
}
