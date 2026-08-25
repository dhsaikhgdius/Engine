import { describe, expect, it } from "vitest";
import {
  clampTimelineFrame,
  createDefaultDirectorFrameTimeline,
  frameToTimeSec,
  isDirectorTimelineFrame,
  MAX_DIRECTOR_TIMELINE_FRAME,
  normalizeDirectorFps,
  timeSecToFrame,
} from "../../../../src/comprehensive/editor/timeline/frameTime";

describe("frame-authoritative time conversion", () => {
  it.each([1, 12, 23, 24, 25, 30, 48, 60, 120, 240])("round-trips integer frames at %i fps", (fps) => {
    for (let frame = 0; frame <= fps * 20; frame += 1) {
      expect(timeSecToFrame(frameToTimeSec(frame, fps), fps)).toBe(frame);
    }
  });

  it("normalizes invalid rates and clamps frame input", () => {
    expect(normalizeDirectorFps(Number.NaN)).toBe(24);
    expect(normalizeDirectorFps(0)).toBe(1);
    expect(normalizeDirectorFps(999)).toBe(240);
    expect(normalizeDirectorFps(30_000 / 1_001)).toBeCloseTo(29.97003, 5);
    expect(clampTimelineFrame(99.8, 12, 48)).toBe(48);
    expect(clampTimelineFrame(-2, 12, 48)).toBe(12);
    expect(isDirectorTimelineFrame(MAX_DIRECTOR_TIMELINE_FRAME)).toBe(true);
    expect(isDirectorTimelineFrame(MAX_DIRECTOR_TIMELINE_FRAME + 1)).toBe(false);
    expect(clampTimelineFrame(MAX_DIRECTOR_TIMELINE_FRAME + 1, 0, MAX_DIRECTOR_TIMELINE_FRAME)).toBe(0);
  });

  it("creates a discoverable frame timeline for genuinely new projects", () => {
    expect(createDefaultDirectorFrameTimeline()).toEqual({
      version: 1,
      fps: 24,
      timebase: {
        rate: { numerator: 24, denominator: 1 },
        dropFrame: false,
        startTimecode: "00:00:00:00",
      },
      frameStart: 0,
      frameEnd: 240,
      currentFrame: 0,
      loop: false,
    });
  });
});
