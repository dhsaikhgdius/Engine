import { describe, expect, it, vi } from "vitest";
import { runWithTimelineExportRestore } from "../../../../src/comprehensive/editor/runtime/timelineExportLifecycle";

describe("timeline export lifecycle", () => {
  it.each(["success", "failure"] as const)(
    "restores playhead, playing, helper visibility and exporting after %s",
    async (outcome) => {
      const state = { frame: 37, isPlaying: true, helpersHidden: false, exporting: false };
      const restorePlayback = vi.fn((frame: number, isPlaying: boolean) => {
        state.frame = frame;
        state.isPlaying = isPlaying;
      });
      const lifecycle = {
        readSnapshot: () => ({
          frame: state.frame,
          isPlaying: state.isPlaying,
          helpersHidden: state.helpersHidden,
        }),
        setExporting: (exporting: boolean) => {
          state.exporting = exporting;
        },
        setHelpersHidden: (helpersHidden: boolean) => {
          state.helpersHidden = helpersHidden;
        },
        setPlaying: (isPlaying: boolean) => {
          state.isPlaying = isPlaying;
        },
        restorePlayback,
      };
      const work = vi.fn(async () => {
        state.frame = 240;
        expect(state).toMatchObject({ exporting: true, helpersHidden: true, isPlaying: false });
        if (outcome === "failure") throw new Error("encoder failed");
        return "done";
      });

      if (outcome === "failure") {
        await expect(runWithTimelineExportRestore(lifecycle, work)).rejects.toThrow("encoder failed");
      } else {
        await expect(runWithTimelineExportRestore(lifecycle, work)).resolves.toBe("done");
      }
      expect(restorePlayback).toHaveBeenCalledWith(37, true);
      expect(state).toEqual({ frame: 37, isPlaying: true, helpersHidden: false, exporting: false });
    },
  );

  it("stops an automatic IN/OUT export at its OUT frame after success", async () => {
    const state = { frame: 37, isPlaying: true, helpersHidden: false, exporting: false };
    const restorePlayback = vi.fn((frame: number, isPlaying: boolean) => {
      state.frame = frame;
      state.isPlaying = isPlaying;
    });
    const lifecycle = {
      readSnapshot: () => ({
        frame: state.frame,
        isPlaying: state.isPlaying,
        helpersHidden: state.helpersHidden,
      }),
      setExporting: (exporting: boolean) => {
        state.exporting = exporting;
      },
      setHelpersHidden: (helpersHidden: boolean) => {
        state.helpersHidden = helpersHidden;
      },
      setPlaying: (isPlaying: boolean) => {
        state.isPlaying = isPlaying;
      },
      restorePlayback,
    };

    await expect(
      runWithTimelineExportRestore(lifecycle, async () => ({ frameEnd: 72 }), {
        playbackAfterSuccess: (recording) => ({ frame: recording.frameEnd, isPlaying: false }),
      }),
    ).resolves.toEqual({ frameEnd: 72 });

    expect(restorePlayback).toHaveBeenCalledWith(72, false);
    expect(state).toEqual({ frame: 72, isPlaying: false, helpersHidden: false, exporting: false });
  });
});
