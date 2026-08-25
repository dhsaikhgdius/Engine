import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filmRunSchema, type FilmRun } from "../../../../packages/protocol/src/filmPipelineProtocol";
import {
  buildFilmTimelineOtio,
  exportFilmTimeline,
  FILM_TIMELINE_OTIO_CONTRACT_V2,
  parseFfprobeMediaInfo,
  parseFrameRateFraction,
  type ClipMediaInfo,
  type ProbedMediaInfo,
} from "../../film/filmTimelineExport";

// Round-trip acceptance by the real Video Editor OTIO importer is covered in
// frontend/director/src/comprehensive/editor/interchange/creativeOtioFilmTimeline.test.ts,
// which may import browser runtime modules without crossing the server import boundary.

const NTSC_FILM_FPS = 24000 / 1001;

/** Two scenes, three shots; scene 0 shot 1 carries oversized descriptions. */
function makeRun(): FilmRun {
  const now = new Date().toISOString();
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
            visualDesc: "V".repeat(600),
            variationType: "medium",
            ffDesc: "Keeper at the railing",
            lfDesc: "Keeper leaning closer",
            motionDesc: "M".repeat(600),
            audioDesc: "A".repeat(600),
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

function makeClips(): ClipMediaInfo[] {
  // Deliberately shuffled; the builder must order by (sceneIdx, shotIdx).
  return [
    { sceneIdx: 1, shotIdx: 0, videoPath: "scene_1/shots/0/video.mp4", durationSec: 4, fps: 24 },
    {
      sceneIdx: 0,
      shotIdx: 1,
      videoPath: "scene_0/shots/1/video.mp4",
      durationSec: 121 / NTSC_FILM_FPS,
      fps: NTSC_FILM_FPS,
    },
    { sceneIdx: 0, shotIdx: 0, videoPath: "scene_0/shots/0/video.mp4", durationSec: 5, fps: 24 },
  ];
}

describe("parseFrameRateFraction", () => {
  it("parses fractions, plain numbers and rejects unusable rates", () => {
    expect(parseFrameRateFraction("24000/1001")).toBeCloseTo(NTSC_FILM_FPS, 12);
    expect(parseFrameRateFraction("30000/1001")).toBeCloseTo(30000 / 1001, 12);
    expect(parseFrameRateFraction("24/1")).toBe(24);
    expect(parseFrameRateFraction("25")).toBe(25);
    expect(parseFrameRateFraction(" 24000 / 1001 ")).toBeCloseTo(NTSC_FILM_FPS, 12);
    expect(parseFrameRateFraction(30)).toBe(30);
    expect(parseFrameRateFraction("0/0")).toBeNull();
    expect(parseFrameRateFraction("24/0")).toBeNull();
    expect(parseFrameRateFraction("0")).toBeNull();
    expect(parseFrameRateFraction("-24")).toBeNull();
    expect(parseFrameRateFraction("abc")).toBeNull();
    expect(parseFrameRateFraction("")).toBeNull();
    expect(parseFrameRateFraction(null)).toBeNull();
    expect(parseFrameRateFraction(undefined)).toBeNull();
  });
});

describe("parseFfprobeMediaInfo", () => {
  it("prefers the stream duration and keeps the rational frame rate", () => {
    const stdout = JSON.stringify({
      programs: [],
      streams: [{ r_frame_rate: "24000/1001", duration: "5.213542" }],
      format: { duration: "9.900000" },
    });
    const info = parseFfprobeMediaInfo(stdout);
    expect(info.durationSec).toBeCloseTo(5.213542, 9);
    expect(info.fps).toBeCloseTo(NTSC_FILM_FPS, 12);
  });

  it("falls back to the format duration when the stream has none", () => {
    const stdout = JSON.stringify({
      streams: [{ r_frame_rate: "24/1", duration: "N/A" }],
      format: { duration: "6.5" },
    });
    expect(parseFfprobeMediaInfo(stdout)).toEqual({ durationSec: 6.5, fps: 24 });
  });

  it("throws for missing video streams, missing durations and invalid JSON", () => {
    expect(() => parseFfprobeMediaInfo(JSON.stringify({ streams: [], format: { duration: "3" } }), "x.mp4")).toThrow(
      /frame rate.*x\.mp4/,
    );
    expect(() => parseFfprobeMediaInfo(JSON.stringify({ streams: [{ r_frame_rate: "24/1" }], format: {} }))).toThrow(
      /duration/,
    );
    expect(() => parseFfprobeMediaInfo("not json")).toThrow(/JSON/);
  });

  it("keeps legacy stream output free of audio awareness", () => {
    const info = parseFfprobeMediaInfo(
      JSON.stringify({ streams: [{ r_frame_rate: "24/1", duration: "3" }], format: {} }),
    );
    expect(info).toEqual({ durationSec: 3, fps: 24 });
    expect(info.startSec).toBeUndefined();
    expect(info.audio).toBeUndefined();
  });

  it("extracts start times and the first audio stream from codec_type-tagged output", () => {
    const stdout = JSON.stringify({
      streams: [
        { codec_type: "video", r_frame_rate: "24/1", duration: "5.0", start_time: "0.083333" },
        { codec_type: "audio", duration: "4.8", start_time: "0.010000" },
        { codec_type: "audio", duration: "9.9", start_time: "3" },
      ],
      format: { duration: "5.1", start_time: "0.000000" },
    });
    expect(parseFfprobeMediaInfo(stdout)).toEqual({
      durationSec: 5,
      fps: 24,
      startSec: 0.083333,
      audio: { startSec: 0.01, durationSec: 4.8 },
    });
  });

  it("reports audio: null for tagged output without an audio stream and clamps negative starts", () => {
    const stdout = JSON.stringify({
      streams: [{ codec_type: "video", r_frame_rate: "24/1", duration: "5", start_time: "-0.023" }],
      format: { duration: "5" },
    });
    expect(parseFfprobeMediaInfo(stdout)).toEqual({ durationSec: 5, fps: 24, startSec: 0, audio: null });
  });

  it("falls back to the format duration and start for sparse audio streams", () => {
    const stdout = JSON.stringify({
      streams: [
        { codec_type: "video", r_frame_rate: "24/1", duration: "5" },
        { codec_type: "audio", duration: "N/A", start_time: "N/A" },
      ],
      format: { duration: "5.2", start_time: "0.5" },
    });
    expect(parseFfprobeMediaInfo(stdout)).toEqual({
      durationSec: 5,
      fps: 24,
      startSec: 0.5,
      audio: { durationSec: 5.2 },
    });
  });
});

describe("buildFilmTimelineOtio", () => {
  it("builds one video track of ordered full-length clips with director metadata", () => {
    const run = makeRun();
    const timeline = buildFilmTimelineOtio({ run, clips: makeClips() }) as Record<string, any>;

    expect(timeline.OTIO_SCHEMA).toBe("Timeline.1");
    expect(timeline.name).toBe(run.id);
    expect(timeline.global_start_time).toEqual({ OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 });
    expect(timeline.metadata.director.runId).toBe(run.id);
    expect(timeline.tracks.OTIO_SCHEMA).toBe("Stack.1");

    const tracks = timeline.tracks.children as Array<Record<string, any>>;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ OTIO_SCHEMA: "Track.1", kind: "Video" });

    const clips = tracks[0]!.children as Array<Record<string, any>>;
    expect(clips.map((clip) => clip.OTIO_SCHEMA)).toEqual(["Clip.2", "Clip.2", "Clip.2"]);
    expect(clips.map((clip) => clip.name)).toEqual(["scene0_shot0", "scene0_shot1", "scene1_shot0"]);

    expect(clips[0]!.source_range).toEqual({
      OTIO_SCHEMA: "TimeRange.1",
      start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
      duration: { OTIO_SCHEMA: "RationalTime.1", value: 120, rate: 24 },
    });
    expect(clips[1]!.source_range.duration.value).toBe(121);
    expect(clips[1]!.source_range.duration.rate).toBeCloseTo(NTSC_FILM_FPS, 12);
    expect(clips[2]!.source_range.duration).toMatchObject({ value: 96, rate: 24 });

    expect(clips[0]!.media_reference).toMatchObject({
      OTIO_SCHEMA: "ExternalReference.1",
      target_url: "scene_0/shots/0/video.mp4",
    });
    expect(clips[0]!.media_reference.available_range.duration).toMatchObject({ value: 120, rate: 24 });
    expect(clips[0]!.media_reference.metadata.director.kind).toBe("video");

    expect(clips[0]!.metadata.director).toEqual({
      sceneIdx: 0,
      shotIdx: 0,
      camIdx: 3,
      visualDesc: "Lighthouse at dusk",
      motionDesc: "Slow push in",
      audioDesc: "Waves and wind",
    });
    expect(clips[1]!.metadata.director.camIdx).toBe(4);
    expect(clips[1]!.metadata.director.visualDesc).toBe("V".repeat(500));
    expect(clips[1]!.metadata.director.motionDesc).toBe("M".repeat(500));
    expect(clips[1]!.metadata.director.audioDesc).toBe("A".repeat(500));

    const named = buildFilmTimelineOtio({ run, clips: makeClips(), name: "custom cut" });
    expect(named.name).toBe("custom cut");
  });

  it("rejects clips that do not match a shot spec in the run", () => {
    const run = makeRun();
    const orphan: ClipMediaInfo = {
      sceneIdx: 9,
      shotIdx: 0,
      videoPath: "scene_9/shots/0/video.mp4",
      durationSec: 2,
      fps: 24,
    };
    expect(() => buildFilmTimelineOtio({ run, clips: [orphan] })).toThrow(/no shot spec for scene 9 shot 0/);
  });
});

describe("exportFilmTimeline", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createRunDirectory() {
    const dir = await mkdtemp(join(tmpdir(), "director-film-timeline-"));
    tempDirs.push(dir);
    return dir;
  }

  async function writeFakeClip(runDirectory: string, sceneIdx: number, shotIdx: number) {
    const path = join(runDirectory, `scene_${sceneIdx}/shots/${shotIdx}/video.mp4`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fake mp4 bytes");
    return path;
  }

  it("writes timeline.otio and skips shots whose video file is missing", async () => {
    const run = makeRun();
    const runDirectory = await createRunDirectory();
    await writeFakeClip(runDirectory, 0, 0);
    await writeFakeClip(runDirectory, 1, 0);
    // scene 0 shot 1 is intentionally missing.

    const probed: string[] = [];
    const probe = async (videoPath: string) => {
      probed.push(videoPath);
      return { durationSec: 5, fps: 24 };
    };

    const outputPath = await exportFilmTimeline({ run, runDirectory, probe });
    expect(outputPath).toBe(join(runDirectory, "timeline.otio"));
    expect(probed).toEqual([
      join(runDirectory, "scene_0/shots/0/video.mp4"),
      join(runDirectory, "scene_1/shots/0/video.mp4"),
    ]);

    const raw = await readFile(outputPath, "utf8");
    expect(raw.startsWith('{\n  "OTIO_SCHEMA": "Timeline.1"')).toBe(true);
    expect(raw.endsWith("\n")).toBe(true);

    const timeline = JSON.parse(raw) as Record<string, any>;
    const clips = timeline.tracks.children[0].children as Array<Record<string, any>>;
    expect(clips.map((clip) => clip.name)).toEqual(["scene0_shot0", "scene1_shot0"]);
    expect(clips.map((clip) => clip.media_reference.target_url)).toEqual([
      "scene_0/shots/0/video.mp4",
      "scene_1/shots/0/video.mp4",
    ]);

    // Probes without audio awareness keep the v1 document: one track, no
    // markers, no contract string on the timeline metadata.
    expect(timeline.metadata).toEqual({ director: { runId: run.id } });
    expect(timeline.tracks.children).toHaveLength(1);
    for (const clip of clips) {
      expect("markers" in clip).toBe(false);
      expect(clip.source_range.start_time.value).toBe(0);
    }
  });

  it("exports the A1 audio track and shot markers when the probe reports audio details", async () => {
    const run = makeRun();
    const runDirectory = await createRunDirectory();
    await writeFakeClip(runDirectory, 0, 0);
    await writeFakeClip(runDirectory, 0, 1);
    await writeFakeClip(runDirectory, 1, 0);
    const dubbedPath = join(runDirectory, "scene_0/shots/1/video_with_audio.mp4");
    await writeFile(dubbedPath, "fake dubbed mp4 bytes");

    const probeResults = new Map<string, ProbedMediaInfo>([
      // Embedded soundtrack: the audio clip references the video file itself.
      ["scene_0/shots/0/video.mp4", { durationSec: 5, fps: 24, startSec: 0, audio: { startSec: 0, durationSec: 5 } }],
      // Silent raw clip whose dubbed sibling carries the dialogue.
      ["scene_0/shots/1/video.mp4", { durationSec: 5, fps: 24, startSec: 0.5, audio: null }],
      [
        "scene_0/shots/1/video_with_audio.mp4",
        { durationSec: 5.05, fps: 24, startSec: 0, audio: { startSec: 0.25, durationSec: 5.5 } },
      ],
      // Silent shot with no dubbed sibling: becomes a gap on A1.
      ["scene_1/shots/0/video.mp4", { durationSec: 4, fps: 24, startSec: 0, audio: null }],
    ]);
    const probed: string[] = [];
    const probe = async (mediaPath: string) => {
      const relative = mediaPath.slice(runDirectory.length + 1);
      probed.push(relative);
      const info = probeResults.get(relative);
      if (!info) throw new Error(`unexpected probe of ${relative}`);
      return info;
    };
    const warnings: string[] = [];

    const outputPath = await exportFilmTimeline({ run, runDirectory, probe, onWarning: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
    expect(probed).toContain("scene_0/shots/1/video_with_audio.mp4");

    const timeline = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, any>;
    expect(timeline.metadata.director).toEqual({
      contract: FILM_TIMELINE_OTIO_CONTRACT_V2,
      runId: run.id,
      frameRate: { numerator: 24, denominator: 1 },
    });

    const tracks = timeline.tracks.children as Array<Record<string, any>>;
    expect(tracks.map((track) => [track.name, track.kind])).toEqual([
      ["V1", "Video"],
      ["A1", "Audio"],
    ]);

    const videoClips = tracks[0]!.children as Array<Record<string, any>>;
    expect(videoClips).toHaveLength(3);
    for (const clip of videoClips) {
      expect(clip.markers).toHaveLength(1);
      expect(clip.markers[0]).toMatchObject({ OTIO_SCHEMA: "Marker.2", name: clip.name, color: "GREEN" });
      expect(clip.markers[0].metadata.director.runId).toBe(run.id);
    }
    // The nonzero probed start shifts the ranges and the marker together.
    expect(videoClips[1]!.source_range.start_time.value).toBe(12);
    expect(videoClips[1]!.media_reference.available_range.start_time.value).toBe(12);
    expect(videoClips[1]!.markers[0].marked_range).toMatchObject({
      start_time: { value: 12 },
      duration: { value: 0 },
    });
    expect(videoClips[1]!.markers[0].metadata.director).toEqual({ runId: run.id, sceneId: 0, shotId: 1 });

    const audioChildren = tracks[1]!.children as Array<Record<string, any>>;
    expect(audioChildren.map((child) => child.OTIO_SCHEMA)).toEqual(["Clip.2", "Clip.2", "Gap.1"]);
    expect(audioChildren[0]!.media_reference.target_url).toBe("scene_0/shots/0/video.mp4");
    expect(audioChildren[1]!.media_reference.target_url).toBe("scene_0/shots/1/video_with_audio.mp4");
    expect(audioChildren[1]!.media_reference.metadata.director.kind).toBe("audio");
    // source_range mirrors the video clip (120 frames) from the dubbed audio start.
    expect(audioChildren[1]!.source_range.start_time.value).toBe(6);
    expect(audioChildren[1]!.source_range.duration.value).toBe(120);
    expect(audioChildren[1]!.media_reference.available_range.duration.value).toBe(132);
    expect(audioChildren[2]!.source_range.duration.value).toBe(96);
  });

  it("degrades to a video-only export with a warning when the dubbed clip cannot be probed", async () => {
    const run = makeRun();
    const runDirectory = await createRunDirectory();
    await writeFakeClip(runDirectory, 0, 0);
    await writeFile(join(runDirectory, "scene_0/shots/0/video_with_audio.mp4"), "corrupt bytes");
    // Shots 0/1 and 1/0 have no rendered video and are skipped entirely.

    const probe = async (mediaPath: string): Promise<ProbedMediaInfo> => {
      if (mediaPath.endsWith("video_with_audio.mp4")) throw new Error("moov atom not found");
      return { durationSec: 5, fps: 24, startSec: 0, audio: null };
    };
    const warnings: string[] = [];

    const outputPath = await exportFilmTimeline({ run, runDirectory, probe, onWarning: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/scene_0\/shots\/0\/video_with_audio\.mp4/);
    expect(warnings[0]).toMatch(/moov atom not found/);

    const timeline = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, any>;
    // Still the v2 editorial document (markers, contract), just without A1.
    expect(timeline.metadata.director.contract).toBe(FILM_TIMELINE_OTIO_CONTRACT_V2);
    expect(timeline.tracks.children).toHaveLength(1);
    expect(timeline.tracks.children[0].children[0].markers).toHaveLength(1);
  });

  it("falls back to the shot's own soundtrack when the dubbed clip has no audio stream", async () => {
    const run = makeRun();
    const runDirectory = await createRunDirectory();
    await writeFakeClip(runDirectory, 0, 0);
    await writeFile(join(runDirectory, "scene_0/shots/0/video_with_audio.mp4"), "video-only bytes");

    const probe = async (mediaPath: string): Promise<ProbedMediaInfo> => {
      if (mediaPath.endsWith("video_with_audio.mp4")) return { durationSec: 5, fps: 24, startSec: 0, audio: null };
      return { durationSec: 5, fps: 24, startSec: 0, audio: { startSec: 0, durationSec: 4.9 } };
    };
    const warnings: string[] = [];

    const outputPath = await exportFilmTimeline({ run, runDirectory, probe, onWarning: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no decodable audio stream/);

    const timeline = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, any>;
    const tracks = timeline.tracks.children as Array<Record<string, any>>;
    expect(tracks).toHaveLength(2);
    const audioClip = tracks[1]!.children[0] as Record<string, any>;
    expect(audioClip.media_reference.target_url).toBe("scene_0/shots/0/video.mp4");
    expect(audioClip.media_reference.available_range.duration.value).toBe(Math.round(4.9 * 24));
  });

  it("throws when every shot video is missing", async () => {
    const run = makeRun();
    const runDirectory = await createRunDirectory();
    const probe = async () => ({ durationSec: 5, fps: 24 });
    await expect(exportFilmTimeline({ run, runDirectory, probe })).rejects.toThrow(/no rendered shot videos/);
  });

  it("throws when a scene has not been planned into shot specs", async () => {
    const now = new Date().toISOString();
    const run = filmRunSchema.parse({
      version: 1,
      id: "film-timeline-test-0002",
      workflow: "idea-to-film",
      status: "running",
      phase: "render",
      input: { idea: "夜航船" },
      scenes: [{ idx: 0, script: "Unplanned scene" }],
      createdAt: now,
      updatedAt: now,
    });
    const runDirectory = await createRunDirectory();
    const probe = async () => ({ durationSec: 5, fps: 24 });
    await expect(exportFilmTimeline({ run, runDirectory, probe })).rejects.toThrow(/no shot specs/);
  });
});
