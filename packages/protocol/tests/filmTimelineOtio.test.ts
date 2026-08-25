import { describe, expect, it } from "vitest";
import { filmRunSchema, type FilmRun } from "../src/filmPipelineProtocol";
import {
  buildFilmTimelineOtio,
  FILM_TIMELINE_OTIO_CONTRACT_V2,
  FILM_TIMELINE_RATE,
  type ClipMediaInfo,
} from "../src/filmTimelineOtio";

// Gateway-side probing/export coverage lives in
// backend/gateway/tests/film/filmTimelineExport.test.ts; round-trip acceptance by
// the real Video Editor importer lives in
// frontend/director/tests/comprehensive/editor/interchange/creativeOtioFilmTimeline.test.ts.
// This file pins the emitted OTIO JSON itself: the legacy v1 byte contract
// and the v2 editorial extensions (A1 audio track, markers, ranges, metadata).

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

/** Two scenes, three shots — mirrors the gateway export test fixture. */
function makeRun(): FilmRun {
  const now = "2026-08-13T00:00:00.000Z";
  return filmRunSchema.parse({
    version: 1,
    id: "film-timeline-test-0001",
    workflow: "idea-to-film",
    status: "completed",
    phase: "completed",
    input: { idea: "海边灯塔看守人的一夜" },
    scenes: [
      {
        idx: 0,
        script: "Scene 0 script",
        shotSpecs: [
          {
            idx: 0,
            camIdx: 3,
            visualDesc: "Lighthouse at dusk",
            variationType: "small",
            ffDesc: "Lighthouse still",
            motionDesc: "Slow push in",
            audioDesc: "Waves and wind",
          },
          {
            idx: 1,
            camIdx: 4,
            visualDesc: "Keeper at the railing",
            variationType: "medium",
            ffDesc: "Keeper at the railing",
            lfDesc: "Keeper leaning closer",
            motionDesc: "Handheld drift",
            audioDesc: "[Speaker] Keeper (calm): The light holds.",
          },
        ],
      },
      {
        idx: 1,
        script: "Scene 1 script",
        shotSpecs: [
          {
            idx: 0,
            camIdx: 0,
            visualDesc: "Morning over the sea",
            variationType: "small",
            ffDesc: "Morning still",
            motionDesc: "Static hold",
            audioDesc: "Gulls",
          },
        ],
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
}

function makeLegacyClips(): ClipMediaInfo[] {
  return [
    { sceneIdx: 0, shotIdx: 0, videoPath: "scene_0/shots/0/video.mp4", durationSec: 5, fps: 24 },
    { sceneIdx: 0, shotIdx: 1, videoPath: "scene_0/shots/1/video.mp4", durationSec: 5, fps: 24 },
    { sceneIdx: 1, shotIdx: 0, videoPath: "scene_1/shots/0/video.mp4", durationSec: 4, fps: 24 },
  ];
}

/** Embedded audio, dubbed audio with its own probed times, and a silent shot. */
function makeEditorialClips(): ClipMediaInfo[] {
  return [
    {
      sceneIdx: 0,
      shotIdx: 0,
      videoPath: "scene_0/shots/0/video.mp4",
      durationSec: 5,
      fps: 24,
      startSec: 0,
      audio: { path: "scene_0/shots/0/video.mp4" },
    },
    {
      sceneIdx: 0,
      shotIdx: 1,
      videoPath: "scene_0/shots/1/video.mp4",
      durationSec: 5,
      fps: 24,
      startSec: 0.5,
      audio: { path: "scene_0/shots/1/video_with_audio.mp4", startSec: 0.25, durationSec: 5.5 },
    },
    {
      sceneIdx: 1,
      shotIdx: 0,
      videoPath: "scene_1/shots/0/video.mp4",
      durationSec: 4,
      fps: 24,
      startSec: 0,
      audio: null,
    },
  ];
}

function tracksOf(timeline: Record<string, unknown>) {
  return (timeline.tracks as Record<string, any>).children as Array<Record<string, any>>;
}

describe("buildFilmTimelineOtio v1 compatibility", () => {
  it("keeps the legacy single-track document unchanged when no editorial inputs are provided", () => {
    const run = makeRun();
    const timeline = buildFilmTimelineOtio({ run, clips: makeLegacyClips() }) as Record<string, any>;

    // The v1 contract: no contract string, no frame-rate block, one video track.
    expect(timeline.metadata).toEqual({ director: { runId: run.id } });
    const tracks = tracksOf(timeline);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ OTIO_SCHEMA: "Track.1", name: "V1", kind: "Video" });

    for (const clip of tracks[0]!.children as Array<Record<string, any>>) {
      expect("markers" in clip).toBe(false);
      expect(clip.source_range.start_time).toEqual(rationalTime(0, 24));
      expect(clip.media_reference.available_range.start_time).toEqual(rationalTime(0, 24));
    }
  });

  it("stays byte-identical across invocations for identical inputs", () => {
    const first = JSON.stringify(buildFilmTimelineOtio({ run: makeRun(), clips: makeLegacyClips() }), null, 2);
    const second = JSON.stringify(buildFilmTimelineOtio({ run: makeRun(), clips: makeLegacyClips() }), null, 2);
    expect(second).toBe(first);
  });
});

describe("buildFilmTimelineOtio v2 editorial contract", () => {
  it("stamps the v2 contract and frame rate on the timeline metadata", () => {
    const run = makeRun();
    const timeline = buildFilmTimelineOtio({ run, clips: makeEditorialClips() }) as Record<string, any>;
    expect(timeline.metadata).toEqual({
      director: {
        contract: FILM_TIMELINE_OTIO_CONTRACT_V2,
        runId: run.id,
        frameRate: { numerator: FILM_TIMELINE_RATE, denominator: 1 },
      },
    });
    expect(timeline.global_start_time).toEqual(rationalTime(0, FILM_TIMELINE_RATE));
  });

  it("emits the full editorial video clip: probed ranges plus a GREEN shot marker", () => {
    const run = makeRun();
    const timeline = buildFilmTimelineOtio({ run, clips: makeEditorialClips() }) as Record<string, any>;
    const videoClips = tracksOf(timeline)[0]!.children as Array<Record<string, any>>;

    expect(videoClips[0]).toEqual({
      OTIO_SCHEMA: "Clip.2",
      name: "scene0_shot0",
      source_range: timeRange(0, 120, 24),
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: "scene0_shot0",
        target_url: "scene_0/shots/0/video.mp4",
        available_range: timeRange(0, 120, 24),
        metadata: { director: { kind: "video", name: "scene0_shot0" } },
      },
      markers: [
        {
          OTIO_SCHEMA: "Marker.2",
          name: "scene0_shot0",
          color: "GREEN",
          marked_range: timeRange(0, 0, 24),
          metadata: { director: { runId: run.id, sceneId: 0, shotId: 0 } },
        },
      ],
      metadata: {
        director: {
          sceneIdx: 0,
          shotIdx: 0,
          camIdx: 3,
          visualDesc: "Lighthouse at dusk",
          motionDesc: "Slow push in",
          audioDesc: "Waves and wind",
        },
      },
    });

    // A nonzero probed start shifts source_range, available_range and the marker together.
    const shifted = videoClips[1]!;
    expect(shifted.source_range).toEqual(timeRange(12, 120, 24));
    expect(shifted.media_reference.available_range).toEqual(timeRange(12, 120, 24));
    expect(shifted.markers).toEqual([
      {
        OTIO_SCHEMA: "Marker.2",
        name: "scene0_shot1",
        color: "GREEN",
        marked_range: timeRange(12, 0, 24),
        metadata: { director: { runId: run.id, sceneId: 0, shotId: 1 } },
      },
    ]);
    expect(videoClips[2]!.markers).toHaveLength(1);
  });

  it("mirrors video timing on one A1 audio track, with gaps for silent shots", () => {
    const run = makeRun();
    const timeline = buildFilmTimelineOtio({ run, clips: makeEditorialClips() }) as Record<string, any>;
    const tracks = tracksOf(timeline);
    expect(tracks).toHaveLength(2);
    expect(tracks[1]).toMatchObject({ OTIO_SCHEMA: "Track.1", name: "A1", kind: "Audio" });

    const audioChildren = tracks[1]!.children as Array<Record<string, any>>;
    expect(audioChildren.map((child) => child.OTIO_SCHEMA)).toEqual(["Clip.2", "Clip.2", "Gap.1"]);

    // Embedded audio references the same file as the video clip.
    expect(audioChildren[0]).toEqual({
      OTIO_SCHEMA: "Clip.2",
      name: "scene0_shot0",
      source_range: timeRange(0, 120, 24),
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: "scene0_shot0",
        target_url: "scene_0/shots/0/video.mp4",
        available_range: timeRange(0, 120, 24),
        metadata: { director: { kind: "audio", name: "scene0_shot0" } },
      },
      metadata: { director: { sceneIdx: 0, shotIdx: 0 } },
    });

    // Dubbed audio keeps its own probed start/duration in the available_range
    // while the source_range duration mirrors the video clip 1:1.
    expect(audioChildren[1]).toEqual({
      OTIO_SCHEMA: "Clip.2",
      name: "scene0_shot1",
      source_range: timeRange(6, 120, 24),
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: "scene0_shot1",
        target_url: "scene_0/shots/1/video_with_audio.mp4",
        available_range: timeRange(6, 132, 24),
        metadata: { director: { kind: "audio", name: "scene0_shot1" } },
      },
      metadata: { director: { sceneIdx: 0, shotIdx: 1 } },
    });

    // The silent shot holds its slot so alignment with V1 survives.
    expect(audioChildren[2]).toEqual({
      OTIO_SCHEMA: "Gap.1",
      name: "Gap",
      source_range: timeRange(0, 96, 24),
      metadata: {},
    });
  });

  it("activates v2 without an A1 track when only start times are provided", () => {
    const run = makeRun();
    const clips = makeLegacyClips().map((clip) => ({ ...clip, startSec: 0 }));
    const timeline = buildFilmTimelineOtio({ run, clips }) as Record<string, any>;
    expect(timeline.metadata.director.contract).toBe(FILM_TIMELINE_OTIO_CONTRACT_V2);
    const tracks = tracksOf(timeline);
    expect(tracks).toHaveLength(1);
    for (const clip of tracks[0]!.children as Array<Record<string, any>>) {
      expect(clip.markers).toHaveLength(1);
    }
  });

  it("omits the A1 track when every shot is probed silent", () => {
    const run = makeRun();
    const clips = makeLegacyClips().map((clip) => ({ ...clip, startSec: 0, audio: null }));
    const timeline = buildFilmTimelineOtio({ run, clips }) as Record<string, any>;
    expect(tracksOf(timeline)).toHaveLength(1);
    expect(timeline.metadata.director.contract).toBe(FILM_TIMELINE_OTIO_CONTRACT_V2);
  });

  it("stays byte-identical across invocations for identical editorial inputs", () => {
    const first = JSON.stringify(buildFilmTimelineOtio({ run: makeRun(), clips: makeEditorialClips() }), null, 2);
    const second = JSON.stringify(buildFilmTimelineOtio({ run: makeRun(), clips: makeEditorialClips() }), null, 2);
    expect(second).toBe(first);
  });

  it("rejects invalid probed starts and audio durations", () => {
    const run = makeRun();
    const [first] = makeEditorialClips();
    expect(() => buildFilmTimelineOtio({ run, clips: [{ ...first!, startSec: -1 }] })).toThrow(/invalid media start/);
    expect(() =>
      buildFilmTimelineOtio({ run, clips: [{ ...first!, audio: { path: "a.mp4", durationSec: 0 } }] }),
    ).toThrow(/invalid audio duration/);
    expect(() =>
      buildFilmTimelineOtio({ run, clips: [{ ...first!, audio: { path: "a.mp4", startSec: Number.NaN } }] }),
    ).toThrow(/invalid audio start/);
  });
});
