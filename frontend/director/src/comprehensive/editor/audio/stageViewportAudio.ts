import { useSyncExternalStore } from "react";

/**
 * Editor preference for 3D Stage speaker output: weather bed, roam foley,
 * and timeline rehearsal. Independent of video-editor mute and of export mix.
 */
export const STAGE_VIEWPORT_AUDIO_STORAGE_KEY = "director.ui.stageViewportAudioEnabled";

const listeners = new Set<() => void>();
let enabled = readStoredStageViewportAudioEnabled();

/** Reads the persisted stage audio toggle, defaulting to true when unset. */
function readStoredStageViewportAudioEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(STAGE_VIEWPORT_AUDIO_STORAGE_KEY);
    if (stored === "false") return false;
    if (stored === "true") return true;
    return true;
  } catch {
    return true;
  }
}

/** Persists the stage audio toggle; silently ignores storage failures. */
function persistStageViewportAudioEnabled(next: boolean) {
  try {
    window.localStorage.setItem(STAGE_VIEWPORT_AUDIO_STORAGE_KEY, next ? "true" : "false");
  } catch {
    // Private or embedded contexts can deny storage. The session preference still works.
  }
}

/** Notifies all listeners of a toggle change. */
function emitStageViewportAudio() {
  listeners.forEach((listener) => listener());
}

/** Returns the current stage audio toggle state. */
export function isStageViewportAudioEnabled() {
  return enabled;
}

/** Sets the stage audio toggle, persisting it and notifying listeners. */
export function setStageViewportAudioEnabled(next: boolean) {
  if (enabled === next) return;
  enabled = next;
  persistStageViewportAudioEnabled(next);
  emitStageViewportAudio();
}

/**
 * Subscribes to stage audio toggle changes.
 *
 * @param listener - Callback invoked on every toggle change.
 * @returns Unsubscribe function.
 */
export function subscribeStageViewportAudio(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook that reads the stage audio toggle and re-renders on change. */
export function useStageViewportAudioEnabled() {
  return useSyncExternalStore(subscribeStageViewportAudio, isStageViewportAudioEnabled, () => true);
}
