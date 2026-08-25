import { clamp } from "../../../../../../packages/protocol/src/primitives";
import type { DirectorTimelineAudioClip, DirectorTimelineAudioTrack } from "../schema/directorProject";
import { normalizeDirectorFps } from "../timeline/frameTime";

/**
 * Stage timeline audio shared between rehearsal playback and the automatic
 * IN/OUT camera video export. The windowing math is pure so tests can verify
 * frame→second conversion and boundary trimming without an AudioContext; the
 * scheduling graph reuses the proven approach from the Video Editor export
 * (AudioContext(48kHz) → gain fades → MediaStreamDestination, +0.035s origin).
 */

/** One clip portion, normalized to seconds relative to the window origin. */
export interface DirectorStageAudioScheduleEntry {
  /** Stable identity of the source clip in the timeline. */
  clipId: string;
  /** Creative media library asset id backing this clip. */
  mediaId: string;
  /** Display name of the clip. */
  name: string;
  /** Resolved playable URL for the source media. */
  sourceUrl: string;
  /** Offset from the window origin at which the source becomes audible. */
  atSec: number;
  /** Source-side offset, including the advance for clips straddling IN. */
  inSec: number;
  /** Audible duration inside the window. */
  durationSec: number;
  /** Steady gain between the fade ramps. */
  volume: number;
  /** Remaining fade-in inside the window; ramps startVolume → volume. */
  fadeInSec: number;
  /** Gain at the start of the audible portion in this window. */
  startVolume: number;
  /** Fade-out portion inside the window; ramps volume → endVolume. */
  fadeOutSec: number;
  /** Gain at the end of the audible portion in this window. */
  endVolume: number;
}

/** Options that define the time window and frame resolution for audio scheduling. */
export interface DirectorStageAudioWindowOptions {
  /** Inclusive IN frame. */
  frameStart: number;
  /** Inclusive OUT frame; the audible window covers [IN, OUT + 1) frames. */
  frameEnd: number;
  /** Timeline frame rate used for frame-to-second conversion. */
  fps: number;
  /** Resolves a clip to a playable URL; defaults to the persisted sourceUrl. */
  resolveSourceUrl?: (clip: DirectorTimelineAudioClip) => string | null;
}

interface StageAudioClipEnvelope {
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  durationSec: number;
}

/**
 * Computes the gain multiplier at a clip-local time, mirroring
 * getDirectorClipOpacityAtTime for video.
 *
 * @param envelope - Fade envelope parameters for the clip.
 * @param localSec - Time offset within the clip in seconds.
 * @returns Gain multiplier in [0, 1], combining volume and fade ramps.
 */
export function getStageAudioClipGainAt(envelope: StageAudioClipEnvelope, localSec: number) {
  const local = clamp(localSec, 0, envelope.durationSec);
  const fadeIn = envelope.fadeInSec > 0 ? clamp(local / envelope.fadeInSec, 0, 1) : 1;
  const fadeOut = envelope.fadeOutSec > 0 ? clamp((envelope.durationSec - local) / envelope.fadeOutSec, 0, 1) : 1;
  return clamp(envelope.volume, 0, 1) * Math.min(fadeIn, fadeOut);
}

/**
 * Computes the audible clip portions overlapping the inclusive frame range
 * [frameStart, frameEnd]. Placement frames convert to seconds through the
 * timeline fps; offsets in the result are relative to the IN frame so the
 * schedule can start at any transport position or export origin.
 */
export function getStageTimelineAudioWindow(
  tracks: readonly DirectorTimelineAudioTrack[],
  { frameStart, frameEnd, fps, resolveSourceUrl }: DirectorStageAudioWindowOptions,
): DirectorStageAudioScheduleEntry[] {
  const normalizedFps = normalizeDirectorFps(fps);
  const start = Math.max(0, Math.round(Math.min(frameStart, frameEnd)));
  const end = Math.max(start, Math.round(Math.max(frameStart, frameEnd)));
  // The stage export includes the OUT frame for its full display interval
  // (see getDirectorVideoDurationSec), so audio covers [IN, OUT + 1) frames.
  const windowStartSec = start / normalizedFps;
  const windowEndSec = (end + 1) / normalizedFps;

  const entries: DirectorStageAudioScheduleEntry[] = [];
  tracks.forEach((track) => {
    if (track.muted) return;
    track.clips.forEach((clip) => {
      if (clip.muted || clip.volume <= 0) return;
      const sourceUrl = resolveSourceUrl ? resolveSourceUrl(clip) : (clip.sourceUrl ?? null);
      if (!sourceUrl) return;

      const clipStartSec = clip.startFrame / normalizedFps;
      let clipDurationSec = clip.durationFrames / normalizedFps;
      if (clip.sourceDurationSec !== undefined) {
        clipDurationSec = Math.min(clipDurationSec, Math.max(0, clip.sourceDurationSec - clip.inSec));
      }
      const clipEndSec = clipStartSec + clipDurationSec;
      const overlapStartSec = Math.max(clipStartSec, windowStartSec);
      const overlapEndSec = Math.min(clipEndSec, windowEndSec);
      if (overlapEndSec - overlapStartSec <= 1e-9) return;

      const envelope: StageAudioClipEnvelope = {
        volume: clip.volume,
        fadeInSec: clip.fadeInSec,
        fadeOutSec: clip.fadeOutSec,
        durationSec: clipDurationSec,
      };
      const localStartSec = overlapStartSec - clipStartSec;
      const localEndSec = overlapEndSec - clipStartSec;
      const fadeInEndLocalSec = Math.min(clip.fadeInSec, clipDurationSec);
      const fadeOutStartLocalSec = Math.max(0, clipDurationSec - clip.fadeOutSec);

      entries.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        name: clip.name,
        sourceUrl,
        atSec: overlapStartSec - windowStartSec,
        inSec: clip.inSec + localStartSec,
        durationSec: overlapEndSec - overlapStartSec,
        volume: clamp(clip.volume, 0, 1),
        fadeInSec: Math.max(0, fadeInEndLocalSec - localStartSec),
        startVolume: getStageAudioClipGainAt(envelope, localStartSec),
        fadeOutSec: Math.max(0, localEndSec - Math.max(localStartSec, fadeOutStartLocalSec)),
        endVolume: getStageAudioClipGainAt(envelope, localEndSec),
      });
    });
  });
  return entries.sort((left, right) => left.atSec - right.atSec || left.clipId.localeCompare(right.clipId));
}

/** A live WebAudio graph that can be started and stopped. */
export interface DirectorStageAudioSource {
  /** Present for "stream" output; null when playing straight to the speakers. */
  stream: MediaStream | null;
  /** Schedules all sources and starts playback. */
  start: () => Promise<void>;
  /** Stops playback and tears down the graph. */
  stop: () => Promise<void>;
}

/** Options controlling the routing and lifecycle of the audio graph. */
export interface CreateDirectorStageAudioSourceOptions {
  /** "stream" feeds MediaRecorder muxing; "speakers" is rehearsal monitoring. */
  output?: "stream" | "speakers";
  /** Abort signal that cancels decoding and graph construction. */
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Stage audio aborted", "AbortError");
}

/**
 * Builds the WebAudio graph for a prepared schedule. Sources are decoded up
 * front; start() schedules every entry against one +0.035s origin exactly like
 * the Video Editor timeline export, and stop() tears the graph down.
 */
export async function createDirectorStageAudioSource(
  entries: readonly DirectorStageAudioScheduleEntry[],
  { output = "stream", signal }: CreateDirectorStageAudioSourceOptions = {},
): Promise<DirectorStageAudioSource | undefined> {
  if (entries.length === 0) return undefined;
  if (typeof AudioContext === "undefined") {
    // Rehearsal degrades to silent playback; the export must fail loudly
    // rather than deliver a video that silently dropped its audio track.
    if (output === "speakers") return undefined;
    throw new Error("当前浏览器不支持音频混合，无法导出包含声音的视频");
  }

  const context = new AudioContext({ sampleRate: 48_000 });
  const destination = output === "stream" ? context.createMediaStreamDestination() : null;
  const target: AudioNode = destination ?? context.destination;
  const bufferCache = new Map<string, Promise<AudioBuffer>>();
  const loadBuffer = (entry: DirectorStageAudioScheduleEntry) => {
    const cached = bufferCache.get(entry.sourceUrl);
    if (cached) return cached;
    const loading = (async () => {
      throwIfAborted(signal);
      const response = await fetch(entry.sourceUrl);
      if (!response.ok) throw new Error(`${entry.name} 的音频源读取失败 (${response.status})`);
      const encoded = await response.arrayBuffer();
      throwIfAborted(signal);
      try {
        return await context.decodeAudioData(encoded.slice(0));
      } catch {
        throw new Error(`${entry.name} 的音频无法解码`);
      }
    })();
    bufferCache.set(entry.sourceUrl, loading);
    return loading;
  };

  let decoded: Array<{ entry: DirectorStageAudioScheduleEntry; buffer: AudioBuffer }>;
  try {
    decoded = await Promise.all(entries.map(async (entry) => ({ entry, buffer: await loadBuffer(entry) })));
  } catch (error) {
    if (context.state !== "closed") await context.close();
    throw error;
  }

  const scheduled: AudioBufferSourceNode[] = [];
  let started = false;
  let stopped = false;

  return {
    stream: destination?.stream ?? null,
    start: async () => {
      if (started || stopped) return;
      started = true;
      await context.resume();
      const origin = context.currentTime + 0.035;
      decoded.forEach(({ entry, buffer }) => {
        const available = Math.max(0, buffer.duration - entry.inSec);
        const durationSec = Math.min(entry.durationSec, available);
        if (durationSec <= 0) return;
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.connect(gain).connect(target);
        const startAt = origin + entry.atSec;
        const endAt = startAt + durationSec;
        gain.gain.cancelScheduledValues(startAt);
        gain.gain.setValueAtTime(entry.startVolume, startAt);
        if (entry.fadeInSec > 0) {
          gain.gain.linearRampToValueAtTime(entry.volume, Math.min(endAt, startAt + entry.fadeInSec));
        }
        if (entry.fadeOutSec > 0) {
          const fadeOutAt = Math.max(startAt, endAt - entry.fadeOutSec);
          // A window that opens mid-fade-out starts the ramp at startVolume;
          // re-asserting the steady volume there would produce a gain jump.
          if (fadeOutAt > startAt + 1e-9) gain.gain.setValueAtTime(entry.volume, fadeOutAt);
          gain.gain.linearRampToValueAtTime(entry.endVolume, endAt);
        }
        source.start(startAt, entry.inSec, durationSec);
        scheduled.push(source);
      });
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      scheduled.forEach((source) => {
        try {
          source.stop();
        } catch {
          // A source that ended naturally is already detached from the graph.
        }
      });
      destination?.stream.getTracks().forEach((track) => track.stop());
      if (context.state !== "closed") await context.close();
    },
  };
}
