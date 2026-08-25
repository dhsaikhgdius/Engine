import type { FilmRun, ShotSpec } from "./filmPipelineProtocol";

/**
 * Pure OTIO timeline builder for film runs.
 *
 * Lives in the protocol package because both sides consume it: the gateway
 * film pipeline serializes it to `<runDirectory>/timeline.otio`, and the
 * browser Video Editor importer accepts it — which the frontend interchange
 * tests verify against the real importer without crossing the server import
 * boundary.
 *
 * The emitted JSON stays inside the OTIO subset understood by Director's
 * Video Editor importer (`importDirectorCreativeTimelineFromOtio`):
 * Timeline.1 / Stack.1 / Track.1 / Clip.2 / Gap.1 / ExternalReference.1 with
 * RationalTime.1 values converted to seconds using each time's own rate, so
 * per-clip rates may differ from the 24 fps timeline rate. `target_url` is
 * kept verbatim by that importer, so callers should pass run-directory
 * relative paths to keep the timeline valid when the run directory moves.
 *
 * Two contracts share this builder:
 * - v1 (legacy): invocations passing only the original ClipMediaInfo fields
 *   produce the byte-identical single-video-track document shipped before
 *   the editorial extensions existed — no markers, no audio track, timeline
 *   metadata `{ runId }` without a contract string.
 * - v2 (FILM_TIMELINE_OTIO_CONTRACT_V2): activates as soon as any clip
 *   carries the new probe details (`startSec` and/or `audio`, even zero/null
 *   values) and adds per-shot Marker.2 entries (Director's importer ignores
 *   markers; they exist for external NLE handoff), one "A1" audio track
 *   mirroring the video timing 1:1, probed-start-aware source/available
 *   ranges, and the contract + frame-rate block on the timeline metadata.
 *
 * Determinism: objects are built with a fixed key insertion order and
 * callers serialize with plain JSON.stringify, so identical inputs yield
 * byte-identical JSON. The protocol stableJson helper is deliberately not
 * used — its key re-sorting and compact output would break the shipped v1
 * byte contract.
 */

/** Editorial audio source for one shot, probed by the exporter. */
export type ClipAudioInfo = {
  /**
   * Emitted verbatim as the audio clip's `target_url`; equals the shot's
   * videoPath when the audio is embedded in the clip itself (normal OTIO
   * practice), or points at the dubbed sibling file when one exists.
   */
  path: string;
  /** Probed start of the audio media; falls back to the clip's startSec. */
  startSec?: number;
  /** Probed duration of the audio media; falls back to the clip's durationSec. */
  durationSec?: number;
};

export type ClipMediaInfo = {
  sceneIdx: number;
  shotIdx: number;
  /** Emitted verbatim as the clip's `target_url`; relative to the .otio file. */
  videoPath: string;
  durationSec: number;
  fps: number;
  /** Probed media start time in seconds; providing it (even 0) opts into the v2 contract. */
  startSec?: number;
  /** Audio source for the A1 track; null marks a probed-silent shot. Providing it opts into v2. */
  audio?: ClipAudioInfo | null;
};

/** Rate used for timeline-level times; Director's importer falls back to it per clip. */
export const FILM_TIMELINE_RATE = 24;

/**
 * Contract string stamped on v2 timeline metadata. Versioning decision: the
 * contract appears ONLY on v2 documents (editorial inputs present); v1
 * documents keep their original `{ runId }` metadata with no contract field
 * so existing consumers and fixtures observe unchanged bytes.
 */
export const FILM_TIMELINE_OTIO_CONTRACT_V2 = "director-film-timeline-otio-v2";

const DESCRIPTION_LIMIT = 500;

function rationalTime(value: number, rate: number) {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate };
}

function timeRange(start: number, duration: number, rate: number) {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    start_time: rationalTime(start, rate),
    duration: rationalTime(duration, rate),
  };
}

function truncateDescription(value: string) {
  return value.length > DESCRIPTION_LIMIT ? value.slice(0, DESCRIPTION_LIMIT) : value;
}

function assertValidClip(clip: ClipMediaInfo) {
  const label = `Scene ${clip.sceneIdx} shot ${clip.shotIdx}`;
  if (!Number.isFinite(clip.durationSec) || clip.durationSec <= 0 || !Number.isFinite(clip.fps) || clip.fps <= 0) {
    throw new Error(`${label} has invalid media info (durationSec=${clip.durationSec}, fps=${clip.fps})`);
  }
  if (clip.startSec !== undefined && (!Number.isFinite(clip.startSec) || clip.startSec < 0)) {
    throw new Error(`${label} has an invalid media start (startSec=${clip.startSec})`);
  }
  if (clip.audio) {
    if (clip.audio.startSec !== undefined && (!Number.isFinite(clip.audio.startSec) || clip.audio.startSec < 0)) {
      throw new Error(`${label} has an invalid audio start (startSec=${clip.audio.startSec})`);
    }
    if (
      clip.audio.durationSec !== undefined &&
      (!Number.isFinite(clip.audio.durationSec) || clip.audio.durationSec <= 0)
    ) {
      throw new Error(`${label} has an invalid audio duration (durationSec=${clip.audio.durationSec})`);
    }
  }
}

/** Zero-duration Marker.2 at the clip's source start, carrying run/scene/shot identity. */
function shotMarker(runId: string, clip: ClipMediaInfo, clipName: string, startFrames: number) {
  return {
    OTIO_SCHEMA: "Marker.2",
    name: clipName,
    color: "GREEN",
    marked_range: timeRange(startFrames, 0, clip.fps),
    metadata: { director: { runId, sceneId: clip.sceneIdx, shotId: clip.shotIdx } },
  };
}

/** Pure builder for the OTIO JSON (OpenTimelineIO serialization schema).
 *
 * @param input - The film run, ordered clips, and optional timeline name.
 * @returns A plain JSON object ready for `JSON.stringify` into a `.otio` file.
 * @throws When a clip references a shot that has no corresponding ShotSpec.
 */
export function buildFilmTimelineOtio(input: {
  run: FilmRun;
  clips: readonly ClipMediaInfo[];
  name?: string;
}): Record<string, unknown> {
  const specByShot = new Map<string, ShotSpec>();
  for (const scene of input.run.scenes) {
    for (const spec of scene.shotSpecs ?? []) specByShot.set(`${scene.idx}:${spec.idx}`, spec);
  }
  const ordered = [...input.clips].sort(
    (left, right) => left.sceneIdx - right.sceneIdx || left.shotIdx - right.shotIdx,
  );
  // v1 vs v2 is inferred from the input shape instead of a flag so that
  // old-style invocations stay byte-identical while probe-aware callers get
  // the editorial document automatically (see module comment).
  const editorial = ordered.some((clip) => clip.startSec !== undefined || clip.audio !== undefined);
  const videoChildren: Record<string, unknown>[] = [];
  const audioChildren: Record<string, unknown>[] = [];
  let hasAudioClip = false;

  for (const clip of ordered) {
    const spec = specByShot.get(`${clip.sceneIdx}:${clip.shotIdx}`);
    if (!spec) {
      throw new Error(`Run ${input.run.id} has no shot spec for scene ${clip.sceneIdx} shot ${clip.shotIdx}`);
    }
    assertValidClip(clip);
    const durationFrames = Math.max(1, Math.round(clip.durationSec * clip.fps));
    const startFrames = Math.round((clip.startSec ?? 0) * clip.fps);
    const clipName = `scene${clip.sceneIdx}_shot${clip.shotIdx}`;
    videoChildren.push({
      OTIO_SCHEMA: "Clip.2",
      name: clipName,
      source_range: timeRange(startFrames, durationFrames, clip.fps),
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: clipName,
        target_url: clip.videoPath,
        available_range: timeRange(startFrames, durationFrames, clip.fps),
        // Director's importer reads media kind/name from this director block.
        metadata: { director: { kind: "video", name: clipName } },
      },
      ...(editorial ? { markers: [shotMarker(input.run.id, clip, clipName, startFrames)] } : {}),
      metadata: {
        director: {
          sceneIdx: clip.sceneIdx,
          shotIdx: clip.shotIdx,
          camIdx: spec.camIdx,
          visualDesc: truncateDescription(spec.visualDesc),
          motionDesc: truncateDescription(spec.motionDesc),
          audioDesc: truncateDescription(spec.audioDesc),
        },
      },
    });
    if (!editorial) continue;
    if (clip.audio) {
      hasAudioClip = true;
      const audioStartFrames = Math.round((clip.audio.startSec ?? clip.startSec ?? 0) * clip.fps);
      const audioAvailableFrames = Math.max(1, Math.round((clip.audio.durationSec ?? clip.durationSec) * clip.fps));
      audioChildren.push({
        OTIO_SCHEMA: "Clip.2",
        name: clipName,
        // Mirrors the video clip's duration 1:1 so both tracks stay aligned.
        source_range: timeRange(audioStartFrames, durationFrames, clip.fps),
        media_reference: {
          OTIO_SCHEMA: "ExternalReference.1",
          name: clipName,
          target_url: clip.audio.path,
          available_range: timeRange(audioStartFrames, audioAvailableFrames, clip.fps),
          metadata: { director: { kind: "audio", name: clipName } },
        },
        metadata: { director: { sceneIdx: clip.sceneIdx, shotIdx: clip.shotIdx } },
      });
    } else {
      // Silent shots become gaps so later audio clips keep their video alignment.
      audioChildren.push({
        OTIO_SCHEMA: "Gap.1",
        name: "Gap",
        source_range: timeRange(0, durationFrames, clip.fps),
        metadata: {},
      });
    }
  }

  const trackChildren: Record<string, unknown>[] = [
    {
      OTIO_SCHEMA: "Track.1",
      name: "V1",
      kind: "Video",
      metadata: {},
      children: videoChildren,
    },
  ];
  // A gaps-only A1 would be noise, so the track needs at least one real clip.
  if (hasAudioClip) {
    trackChildren.push({
      OTIO_SCHEMA: "Track.1",
      name: "A1",
      kind: "Audio",
      metadata: {},
      children: audioChildren,
    });
  }
  return {
    OTIO_SCHEMA: "Timeline.1",
    // run.id already carries the film- prefix.
    name: input.name ?? input.run.id,
    global_start_time: rationalTime(0, FILM_TIMELINE_RATE),
    metadata: {
      director: editorial
        ? {
            contract: FILM_TIMELINE_OTIO_CONTRACT_V2,
            runId: input.run.id,
            // Same fps source as global_start_time; FILM_TIMELINE_RATE is integral.
            frameRate: { numerator: FILM_TIMELINE_RATE, denominator: 1 },
          }
        : { runId: input.run.id },
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "Film tracks",
      metadata: {},
      children: trackChildren,
    },
  };
}
