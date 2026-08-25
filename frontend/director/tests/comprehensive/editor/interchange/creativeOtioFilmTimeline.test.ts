import { describe, expect, it } from "vitest";
import { filmRunSchema, type FilmRun } from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import { buildFilmTimelineOtio, type ClipMediaInfo } from "../../../../../../packages/protocol/src/filmTimelineOtio";
import { importDirectorCreativeTimelineFromOtio } from "../../../../src/comprehensive/editor/interchange/creativeOtio";

/**
 * Round-trip acceptance of the film pipeline's OTIO export by the real Video
 * Editor importer. The builder lives in packages/protocol so the gateway film
 * pipeline and this browser-side check share one implementation; the gateway
 * side (backend/gateway/film/filmTimelineExport.test.ts) covers probing and
 * file export without importing browser runtime modules.
 */

const NTSC_FILM_FPS = 24000 / 1001;

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
            visualDesc: "Keeper at the railing, storm building",
            variationType: "medium",
            ffDesc: "Keeper at the railing",
            lfDesc: "Keeper leaning closer",
            motionDesc: "Handheld drift toward the keeper",
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

describe("film timeline OTIO round-trip", () => {
  it("is accepted by Director's Video Editor OTIO importer", () => {
    const run = makeRun();
    const timeline = buildFilmTimelineOtio({ run, clips: makeClips() });
    const imported = importDirectorCreativeTimelineFromOtio(JSON.stringify(timeline));

    expect(imported.name).toBe(run.id);
    expect(imported.editSettings.fps).toBe(24);
    expect(imported.editTracks).toHaveLength(1);
    expect(imported.editTracks[0]!.kind).toBe("video");

    const clips = imported.editTracks[0]!.clips;
    expect(clips.map((clip) => clip.name)).toEqual(["scene0_shot0", "scene0_shot1", "scene1_shot0"]);
    expect(clips[0]).toMatchObject({ startSec: 0, inSec: 0, durationSec: 5, playbackRate: 1 });
    expect(clips[1]!.startSec).toBe(5);
    expect(clips[1]!.durationSec).toBeCloseTo(121 / NTSC_FILM_FPS, 6);
    // The importer re-quantizes the cursor to the 24 fps timeline rate.
    expect(clips[2]!.startSec).toBeCloseTo(241 / 24, 9);
    expect(clips[2]!.durationSec).toBe(4);

    const targetUrls = imported.mediaReferences.map((reference) => reference.targetUrl).sort();
    expect(targetUrls).toEqual(["scene_0/shots/0/video.mp4", "scene_0/shots/1/video.mp4", "scene_1/shots/0/video.mp4"]);
    for (const reference of imported.mediaReferences) {
      expect(reference.kind).toBe("video");
      expect(reference.offline).toBe(true);
    }
    // Only relink notices are expected; anything else means structure was dropped.
    expect(imported.warnings.length).toBeGreaterThan(0);
    for (const warning of imported.warnings) expect(warning).toContain("relinking");
  });
});
