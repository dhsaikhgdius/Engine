import { beforeEach, expect, it } from "vitest";
import { MAX_TRAJECTORY_DRAWING_POINTS, useTimelineRuntimeStore } from "../../../../src/comprehensive/editor/runtime/timelineRuntimeStore";

beforeEach(() => useTimelineRuntimeStore.getState().reset());

it("keeps drawing/export state transient and bounds custom path input", () => {
  const runtime = useTimelineRuntimeStore.getState();
  runtime.beginDrawing("object:role", [0, 0, 0]);
  for (let index = 1; index < MAX_TRAJECTORY_DRAWING_POINTS + 20; index += 1) {
    useTimelineRuntimeStore.getState().addDrawingPoint([index, 0, 0]);
  }
  expect(useTimelineRuntimeStore.getState().drawingPoints).toHaveLength(MAX_TRAJECTORY_DRAWING_POINTS);
  const points = useTimelineRuntimeStore.getState().drawingPoints;
  expect(points[points.length - 1]).toEqual([MAX_TRAJECTORY_DRAWING_POINTS - 1, 0, 0]);
  runtime.setExporting(true);
  runtime.setHelpersHidden(true);
  runtime.reset();
  expect(useTimelineRuntimeStore.getState()).toMatchObject({
    drawingPoints: [],
    exporting: false,
    helpersHidden: false,
    playheadFrame: 0,
  });
});

it("publishes playhead frames independently and suppresses duplicate ticks", () => {
  const observed: number[] = [];
  const unsubscribe = useTimelineRuntimeStore.subscribe((state, previous) => {
    if (state.playheadFrame !== previous.playheadFrame) observed.push(state.playheadFrame);
  });

  useTimelineRuntimeStore.getState().setPlayheadFrame(24);
  useTimelineRuntimeStore.getState().setPlayheadFrame(24);
  useTimelineRuntimeStore.getState().setPlayheadFrame(36);
  unsubscribe();

  expect(observed).toEqual([24, 36]);
});
