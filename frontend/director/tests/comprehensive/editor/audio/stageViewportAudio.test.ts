import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  STAGE_VIEWPORT_AUDIO_STORAGE_KEY,
  isStageViewportAudioEnabled,
  setStageViewportAudioEnabled,
  useStageViewportAudioEnabled,
} from "../../../../src/comprehensive/editor/audio/stageViewportAudio";

describe("stage viewport audio preference", () => {
  afterEach(() => {
    setStageViewportAudioEnabled(true);
    window.localStorage.removeItem(STAGE_VIEWPORT_AUDIO_STORAGE_KEY);
  });

  it("defaults to enabled and persists the mute choice", () => {
    expect(isStageViewportAudioEnabled()).toBe(true);
    setStageViewportAudioEnabled(false);
    expect(isStageViewportAudioEnabled()).toBe(false);
    expect(window.localStorage.getItem(STAGE_VIEWPORT_AUDIO_STORAGE_KEY)).toBe("false");
    setStageViewportAudioEnabled(true);
    expect(window.localStorage.getItem(STAGE_VIEWPORT_AUDIO_STORAGE_KEY)).toBe("true");
  });

  it("notifies subscribers when the preference changes", () => {
    const { result } = renderHook(() => useStageViewportAudioEnabled());
    expect(result.current).toBe(true);
    act(() => setStageViewportAudioEnabled(false));
    expect(result.current).toBe(false);
  });
});
