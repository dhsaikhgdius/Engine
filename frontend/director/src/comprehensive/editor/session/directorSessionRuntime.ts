import { useSyncExternalStore } from "react";

/** Live connection state for a backend service. */
export type DirectorConnectionState = "connected" | "connecting" | "disconnected";
/** Codex CLI availability state as reported by the gateway. */
export type CodexConnectionState = "ready" | "not-logged-in" | "missing" | "unavailable" | "unknown";

/**
 * Lightweight, synchronous snapshot of the Director session runtime.
 *
 * This store is deliberately external to React — it is updated by the
 * Agent gateway WebSocket and the creative workspace store, and read
 * through `useSyncExternalStore` so React always sees a consistent
 * snapshot without subscribing to every internal state change.
 */
export interface DirectorSessionRuntimeState {
  /** Stable identifier for this browser tab's session. */
  instanceId: string;
  /** The currently loaded scene identifier. */
  sceneId: string;
  /** Monotonic project revision, or null before the first load. */
  revision: number | null;
  /** Whether the project has unsaved changes. */
  dirty: boolean;
  /** Revision conflict message, or null when in sync. */
  conflict: string | null;
  /** ComfyUI backend connection state. */
  comfyui: DirectorConnectionState;
  /** Gateway WebSocket connection state. */
  gateway: DirectorConnectionState;
  /** MCP server connection state. */
  mcp: DirectorConnectionState;
  /** Codex CLI availability. */
  codex: CodexConnectionState;
}

const EMPTY_STATE: DirectorSessionRuntimeState = Object.freeze({
  instanceId: "",
  sceneId: "",
  revision: null,
  dirty: false,
  conflict: null,
  comfyui: "disconnected",
  gateway: "disconnected",
  mcp: "disconnected",
  codex: "unknown",
});

let state: DirectorSessionRuntimeState = EMPTY_STATE;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Returns the current frozen snapshot of the session runtime.
 *
 * @returns The current immutable state.
 */
export function getDirectorSessionRuntime(): DirectorSessionRuntimeState {
  return state;
}

/**
 * Applies a partial update to the session runtime state.
 *
 * The update is a no-op when every field is already equal (shallow
 * reference-equal comparison). On change, the returned state is frozen
 * and all registered listeners are notified.
 *
 * @param patch - Partial state to merge into the current snapshot.
 * @returns The new frozen state, or the existing state on no-op.
 */
export function updateDirectorSessionRuntime(patch: Partial<DirectorSessionRuntimeState>): DirectorSessionRuntimeState {
  const next = { ...state, ...patch };
  if (
    next.instanceId === state.instanceId &&
    next.sceneId === state.sceneId &&
    next.revision === state.revision &&
    next.dirty === state.dirty &&
    next.conflict === state.conflict &&
    next.comfyui === state.comfyui &&
    next.gateway === state.gateway &&
    next.mcp === state.mcp &&
    next.codex === state.codex
  ) {
    return state;
  }
  state = Object.freeze(next);
  emit();
  return state;
}

/**
 * Resets the session runtime to its initial empty state.
 *
 * Idempotent — a no-op when already at the empty state.
 */
export function resetDirectorSessionRuntime() {
  if (state === EMPTY_STATE) return;
  state = EMPTY_STATE;
  emit();
}

/**
 * Subscribes a listener for session runtime changes.
 *
 * @param listener - Called synchronously on every state change.
 * @returns An unsubscribe function.
 */
export function subscribeDirectorSessionRuntime(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * React hook that selects a derived value from the session runtime snapshot.
 *
 * Uses `useSyncExternalStore` so React re-renders only when the selected
 * value changes, not on every unrelated state update.
 *
 * @param selector - Pure function that extracts a value from the snapshot.
 * @returns The selected value, stable across re-renders when unchanged.
 */
export function useDirectorSessionRuntime<T>(selector: (snapshot: DirectorSessionRuntimeState) => T): T {
  const snapshot = useSyncExternalStore(
    subscribeDirectorSessionRuntime,
    getDirectorSessionRuntime,
    getDirectorSessionRuntime,
  );
  return selector(snapshot);
}
