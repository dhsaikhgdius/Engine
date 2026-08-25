import { create } from "zustand";

type Vec3 = [number, number, number];
export const MAX_TRAJECTORY_DRAWING_POINTS = 256;

interface DirectorTimelineRuntimeState {
  /**
   * Transient viewport playhead. This is deliberately separate from the
   * persisted project timeline: playback may publish it every animation frame
   * without invalidating the editor shell or writing undo/persistence state.
   */
  playheadFrame: number;
  selectedTrackKey: string | null;
  selectedKeyframeIndex: number | null;
  drawingTrackKey: string | null;
  drawingPoints: Vec3[];
  exporting: boolean;
  helpersHidden: boolean;
  selectTrack: (trackKey: string | null, keyframeIndex?: number | null) => void;
  beginDrawing: (trackKey: string, firstPoint: Vec3) => void;
  addDrawingPoint: (point: Vec3) => void;
  cancelDrawing: () => void;
  setExporting: (exporting: boolean) => void;
  setHelpersHidden: (hidden: boolean) => void;
  setPlayheadFrame: (frame: number) => void;
  reset: () => void;
}

const INITIAL_TIMELINE_RUNTIME_STATE = {
  playheadFrame: 0,
  selectedTrackKey: null,
  selectedKeyframeIndex: null,
  drawingTrackKey: null,
  drawingPoints: [] as Vec3[],
  exporting: false,
  helpersHidden: false,
};

export const useTimelineRuntimeStore = create<DirectorTimelineRuntimeState>((set) => ({
  ...INITIAL_TIMELINE_RUNTIME_STATE,
  selectTrack: (selectedTrackKey, selectedKeyframeIndex = null) => set({ selectedTrackKey, selectedKeyframeIndex }),
  beginDrawing: (drawingTrackKey, firstPoint) =>
    set({
      drawingTrackKey,
      drawingPoints: [[...firstPoint] as Vec3],
      selectedTrackKey: drawingTrackKey,
      selectedKeyframeIndex: null,
    }),
  addDrawingPoint: (point) =>
    set((state) => {
      if (state.drawingPoints.length >= MAX_TRAJECTORY_DRAWING_POINTS) return state;
      const previous = state.drawingPoints[state.drawingPoints.length - 1];
      if (previous && Math.hypot(point[0] - previous[0], point[2] - previous[2]) < 0.05) return state;
      return { drawingPoints: [...state.drawingPoints, [...point] as Vec3] };
    }),
  cancelDrawing: () => set({ drawingTrackKey: null, drawingPoints: [] }),
  setExporting: (exporting) => set({ exporting }),
  setHelpersHidden: (helpersHidden) => set({ helpersHidden }),
  setPlayheadFrame: (playheadFrame) =>
    set((state) => (state.playheadFrame === playheadFrame ? state : { playheadFrame })),
  reset: () => set(INITIAL_TIMELINE_RUNTIME_STATE),
}));
