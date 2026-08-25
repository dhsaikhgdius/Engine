import { useEffect, useRef } from "react";
import type { DirectorTimeline } from "../schema/directorProject";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { resolveStageAudioClipSourceUrl } from "./stageAudioMediaResolver";
import { useStageViewportAudioEnabled } from "./stageViewportAudio";
import {
  createDirectorStageAudioSource,
  getStageTimelineAudioWindow,
  type DirectorStageAudioSource,
} from "./stageTimelineAudio";

/**
 * Makes stage timeline audio audible during rehearsal playback.
 *
 * v1 is a plain stop-and-reschedule model: starting playback schedules every
 * audible clip portion from the playhead to the effective end, pausing or
 * seeking stops the graph, and a backward playhead jump while playing (loop
 * wrap or scrub during playback) reschedules from the new frame. The Stage
 * sound toggle silences speakers without touching the export mixer.
 *
 * @param params.enabled - False while an export owns the transport; export mixes its own graph.
 * @param params.isPlaying - Whether the timeline transport is active.
 * @param params.timeline - The current timeline containing audio tracks.
 * @param params.endFrame - The effective end frame of the playback range.
 */
export function useStageTimelineAudioRehearsal({
  enabled,
  isPlaying,
  timeline,
  endFrame,
}: {
  /** False while an export owns the transport; export mixes its own graph. */
  enabled: boolean;
  isPlaying: boolean;
  timeline: DirectorTimeline | undefined;
  endFrame: number;
}) {
  const audioTracks = timeline?.audioTracks;
  const fps = timeline?.fps;
  const sessionRef = useRef(0);
  const stageAudioEnabled = useStageViewportAudioEnabled();

  useEffect(() => {
    if (!enabled || !stageAudioEnabled || !isPlaying || !audioTracks?.length || fps === undefined) return;

    const session = sessionRef.current + 1;
    sessionRef.current = session;
    let activeSource: DirectorStageAudioSource | undefined;
    let lastFrame = useTimelineRuntimeStore.getState().playheadFrame;

    const scheduleFromFrame = async (frame: number) => {
      const previous = activeSource;
      activeSource = undefined;
      await previous?.stop();
      if (sessionRef.current !== session) return;
      const entries = getStageTimelineAudioWindow(audioTracks, {
        frameStart: frame,
        frameEnd: endFrame,
        fps,
        resolveSourceUrl: resolveStageAudioClipSourceUrl,
      });
      let source: DirectorStageAudioSource | undefined;
      try {
        source = await createDirectorStageAudioSource(entries, { output: "speakers" });
      } catch {
        return; // Rehearsal keeps playing silently when a source cannot load.
      }
      if (!source) return;
      if (sessionRef.current !== session) {
        await source.stop();
        return;
      }
      activeSource = source;
      await source.start();
    };

    void scheduleFromFrame(lastFrame);
    const unsubscribe = useTimelineRuntimeStore.subscribe((state) => {
      if (state.playheadFrame < lastFrame) void scheduleFromFrame(state.playheadFrame);
      lastFrame = state.playheadFrame;
    });

    return () => {
      sessionRef.current += 1;
      unsubscribe();
      const source = activeSource;
      activeSource = undefined;
      void source?.stop();
    };
  }, [audioTracks, enabled, endFrame, fps, isPlaying, stageAudioEnabled]);
}
