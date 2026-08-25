import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorTimeline } from "../../../../src/comprehensive/editor/schema/directorProject";
import { useTimelineRuntimeStore } from "../../../../src/comprehensive/editor/runtime/timelineRuntimeStore";
import { setStageViewportAudioEnabled } from "../../../../src/comprehensive/editor/audio/stageViewportAudio";
import { createDirectorStageAudioSource } from "../../../../src/comprehensive/editor/audio/stageTimelineAudio";
import { useStageTimelineAudioRehearsal } from "../../../../src/comprehensive/editor/audio/useStageTimelineAudioRehearsal";

vi.mock("../../../../src/comprehensive/editor/audio/stageTimelineAudio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/audio/stageTimelineAudio")>();
  return {
    ...actual,
    createDirectorStageAudioSource: vi.fn(),
  };
});

const createSource = vi.mocked(createDirectorStageAudioSource);

const timeline = {
  version: 1,
  fps: 24,
  frameStart: 0,
  frameEnd: 47,
  currentFrame: 0,
  loop: false,
  audioTracks: [
    {
      id: "audio_track_1",
      name: "音频轨 1",
      muted: false,
      clips: [
        {
          id: "audio_clip_1",
          name: "环境声",
          mediaId: "creative-media:audio:abc",
          sourceUrl: "blob:ambience",
          startFrame: 0,
          durationFrames: 48,
          inSec: 0,
          volume: 1,
          fadeInSec: 0,
          fadeOutSec: 0,
          muted: false,
        },
      ],
    },
  ],
} satisfies DirectorTimeline;

function makeSource() {
  return {
    stream: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("useStageTimelineAudioRehearsal stage mute", () => {
  beforeEach(() => {
    createSource.mockReset();
    setStageViewportAudioEnabled(true);
    useTimelineRuntimeStore.getState().reset();
  });

  afterEach(() => {
    setStageViewportAudioEnabled(true);
  });

  it("does not start speaker playback while stage sound is muted", async () => {
    setStageViewportAudioEnabled(false);
    createSource.mockResolvedValue(makeSource());
    renderHook(() => useStageTimelineAudioRehearsal({ enabled: true, endFrame: 47, isPlaying: true, timeline }));
    await Promise.resolve();
    expect(createSource).not.toHaveBeenCalled();
  });

  it("stops an active rehearsal graph when stage sound is turned off", async () => {
    const source = makeSource();
    createSource.mockResolvedValue(source);
    renderHook(() => useStageTimelineAudioRehearsal({ enabled: true, endFrame: 47, isPlaying: true, timeline }));
    await waitFor(() => expect(source.start).toHaveBeenCalledTimes(1));
    act(() => setStageViewportAudioEnabled(false));
    await waitFor(() => expect(source.stop).toHaveBeenCalled());
    expect(createSource).toHaveBeenCalledWith(expect.any(Array), { output: "speakers" });
  });

  it("reschedules speaker playback when stage sound is turned back on during play", async () => {
    const first = makeSource();
    const second = makeSource();
    createSource.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    renderHook(() => useStageTimelineAudioRehearsal({ enabled: true, endFrame: 47, isPlaying: true, timeline }));
    await waitFor(() => expect(first.start).toHaveBeenCalledTimes(1));
    act(() => setStageViewportAudioEnabled(false));
    await waitFor(() => expect(first.stop).toHaveBeenCalled());
    act(() => setStageViewportAudioEnabled(true));
    await waitFor(() => expect(second.start).toHaveBeenCalledTimes(1));
  });
});
