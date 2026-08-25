import type { LinearCastingRuntime } from "./linearCastingRuntime";

let runtime: LinearCastingRuntime | null = null;
const listeners = new Set<() => void>();

/**
 * Sets the active runtime reference that the HUD layer reads to render
 * casting state. Notifies all subscribers so the HUD re-renders.
 *
 * @param next - The new runtime instance, or `null` to clear.
 */
export function setLinearCastingHudRuntime(next: LinearCastingRuntime | null) {
  runtime = next;
  for (const listener of listeners) listener();
}

/**
 * Returns the currently active linear casting runtime for HUD consumption.
 *
 * @returns The runtime instance, or `null` when no session is active.
 */
export function getLinearCastingHudRuntime() {
  return runtime;
}

/**
 * Subscribes to runtime changes so the HUD can react to session lifecycle events.
 *
 * @param listener - A zero-argument callback invoked whenever the runtime changes.
 * @returns An unsubscribe function that removes the listener.
 */
export function subscribeLinearCastingHudRuntime(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
