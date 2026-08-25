import { describe, expect, it } from "vitest";
import {
  createTimelineRecordingSettings,
  normalizeTimelineRecordingSettings,
} from "../../../../src/comprehensive/editor/timeline/timelineRecording";

describe("timeline recording ranges", () => {
  it("starts the IN/OUT export and the manual recording marker at the timeline start", () => {
    const settings = createTimelineRecordingSettings({ frameStart: 12, frameEnd: 96 });

    expect(settings.exportRange).toEqual({ in: 12, out: 96 });
    expect(settings.manualStart).toBe(12);
  });

  it("clamps dragged export and manual markers into the current timeline", () => {
    const normalized = normalizeTimelineRecordingSettings(
      {
        format: "webm",
        exportRange: { in: 160, out: -4 },
        manualStart: 140,
      },
      { frameStart: 12, frameEnd: 96 },
    );

    expect(normalized).toMatchObject({
      exportRange: { in: 12, out: 96 },
      manualStart: 96,
    });
  });
});
