import { create } from "zustand";
import type { ArdyMotionClip } from "./ardyNpz";

/**
 * Viewport-facing state for the ARDY motion preview. The character panel
 * starts/stops previews; the canvas preview layer subscribes and drives the
 * selected character's bones. Exactly one preview can run at a time, and a
 * preview is a non-destructive overlay — stopping restores the rig.
 */

export interface ArdyMotionPreviewState {
  /** Object ID of the character currently previewing, or null when idle. */
  objectId: string | null;
  /** The decoded motion clip being previewed, or null when idle. */
  clip: ArdyMotionClip | null;
  /** Distinguishes consecutive previews of the same object+clip pair. */
  session: number;
  /** Whether the preview is actively playing. */
  playing: boolean;
  /** Start previewing a clip on a character. Replaces any running preview. */
  startPreview: (objectId: string, clip: ArdyMotionClip) => void;
  /** Stop the current preview and restore the character's original pose. */
  stopPreview: () => void;
}

/** Zustand store managing the singleton ARDY motion preview overlay. */
export const useArdyMotionPreviewStore = create<ArdyMotionPreviewState>((set) => ({
  objectId: null,
  clip: null,
  session: 0,
  playing: false,
  startPreview: (objectId, clip) =>
    set((state) => ({ objectId, clip, playing: true, session: state.session + 1 })),
  stopPreview: () => set({ objectId: null, clip: null, playing: false }),
}));
