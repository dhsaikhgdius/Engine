type LinearCastingSession = {
  enabled: boolean;
  paused: boolean;
};

const listeners = new Set<() => void>();
let snapshot: LinearCastingSession = {
  enabled: true,
  paused: false,
};

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Returns the current linear casting session snapshot. The returned object is
 * a live reference that should be treated as read-only.
 *
 * @returns The current session state.
 */
export function getLinearCastingSession() {
  return snapshot;
}

/**
 * Subscribes to session state changes. The listener fires whenever the session
 * is enabled, disabled, paused, or resumed.
 *
 * @param listener - A zero-argument callback invoked on every state change.
 * @returns An unsubscribe function that removes the listener.
 */
export function subscribeLinearCastingSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Enables or disables the linear casting session. No-ops when the value is
 * unchanged to avoid unnecessary re-renders.
 *
 * @param enabled - `true` to enable the session, `false` to disable it.
 */
export function setLinearCastingEnabled(enabled: boolean) {
  if (snapshot.enabled === enabled) return;
  snapshot = { ...snapshot, enabled };
  notify();
}

/**
 * Pauses or resumes the linear casting session. A paused session still advances
 * cooldowns but freezes ability effects. No-ops when the value is unchanged.
 *
 * @param paused - `true` to pause, `false` to resume.
 */
export function setLinearCastingPaused(paused: boolean) {
  if (snapshot.paused === paused) return;
  snapshot = { ...snapshot, paused };
  notify();
}

/**
 * Toggles the paused state of the linear casting session.
 */
export function toggleLinearCastingPaused() {
  setLinearCastingPaused(!snapshot.paused);
}
