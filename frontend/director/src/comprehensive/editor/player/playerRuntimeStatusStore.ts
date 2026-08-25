import type { PlayerRuntimeStatus } from "./playerLocomotion";

/** Lightweight publish/subscribe store for high-frequency roam telemetry. */
export type PlayerRuntimeStatusStore = {
  /** Returns the latest published status, or null when nothing has been published. */
  getSnapshot: () => PlayerRuntimeStatus | null;
  /** Publishes a new status; no-ops when the value is referentially unchanged. */
  publish: (status: PlayerRuntimeStatus | null) => void;
  /** Registers a listener that fires on every publish. Returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
};

/** Keeps high-frequency roam telemetry out of the full Director canvas tree. */
export function createPlayerRuntimeStatusStore(): PlayerRuntimeStatusStore {
  let snapshot: PlayerRuntimeStatus | null = null;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    publish(status) {
      if (status === snapshot) return;
      snapshot = status;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
