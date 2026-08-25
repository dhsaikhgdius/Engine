import { describe, expect, it } from "vitest";
import type { DirectorProject, DirectorTimeline } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  duplicateStoryboardShot,
  insertStoryboardShotAtFrame,
  reorderStoryboardShot,
} from "../../../../src/comprehensive/editor/storyboard/directorStoryboard";

const timeline: DirectorTimeline = {
  version: 1,
  fps: 24,
  frameStart: 0,
  frameEnd: 95,
  currentFrame: 0,
  loop: false,
};

function makeProject(): DirectorProject {
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor: "#101010",
      panoramaYaw: 0,
      panoramaRadius: 10,
      showLabels: true,
      snapToGrid: false,
      showGround: true,
      groundOpacity: 1,
      groundHeight: 0,
      timeline,
    },
    assets: [],
    panoramaAssetId: null,
    objects: [],
    cameras: [
      {
        id: "camera-a",
        name: "主机位",
        fov: 50,
        targetMode: "manual",
        target: [0, 0, 0],
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ],
    activeCameraId: "camera-a",
    storyboard: {
      version: 1,
      title: "剪辑测试",
      logline: "测试",
      shots: [
        {
          id: "opening",
          title: "开场",
          cameraId: "camera-a",
          frameStart: 0,
          frameEnd: 47,
          shotSize: "wide",
          movement: "static",
          action: "建立空间",
        },
        {
          id: "reaction",
          title: "反应",
          cameraId: "camera-a",
          frameStart: 48,
          frameEnd: 95,
          shotSize: "medium",
          movement: "pan",
          action: "切换反应",
        },
      ],
    },
  };
}

describe("insertStoryboardShotAtFrame", () => {
  it("splits a clip at the playhead and shifts later clips like an NLE insert edit", () => {
    const result = insertStoryboardShotAtFrame({ project: makeProject(), currentFrame: 24, timeline });
    const shots = result.storyboard.shots;

    expect(result.shot).toMatchObject({ frameStart: 24, frameEnd: 95, cameraId: "camera-a" });
    expect(shots.find((shot) => shot.id === "opening")).toMatchObject({ frameStart: 0, frameEnd: 23 });
    expect(shots.find((shot) => shot.id === "reaction")).toMatchObject({ frameStart: 120, frameEnd: 167 });
    expect(shots.some((shot) => shot.title === "开场 · 后段" && shot.frameStart === 96 && shot.frameEnd === 119)).toBe(
      true,
    );
    expect(result.frameEnd).toBe(167);
  });

  it("reorders cards without changing inclusive shot durations", () => {
    const shots = makeProject().storyboard!.shots;
    const reordered = reorderStoryboardShot(shots, "reaction", "earlier", 0);

    expect(reordered.map((shot) => shot.id)).toEqual(["reaction", "opening"]);
    expect(reordered).toMatchObject([
      { id: "reaction", frameStart: 0, frameEnd: 47 },
      { id: "opening", frameStart: 48, frameEnd: 95 },
    ]);
  });

  it("duplicates a card with a new identity and clears frame-bound thumbnail evidence", () => {
    const shots = structuredClone(makeProject().storyboard!.shots);
    shots[0]!.thumbnail = {
      mediaId: "creative-media:image:test",
      cameraId: "camera-a",
      frame: 0,
      width: 960,
      height: 540,
      capturedAt: "2026-08-07T00:00:00.000Z",
    };
    shots[0]!.rating = 4;
    shots[0]!.notes = "Keep the key light warm.";
    shots[0]!.generation = {
      workflowId: "comfy-workflow-image-main",
      nodeIds: ["node-a"],
      parameters: { "12.cfg": 6.5 },
      outputs: [
        {
          jobId: "generation-job-1",
          kind: "image.generate",
          workflowId: "comfy-workflow-image-main",
          mediaIds: ["creative-media:image:generated"],
          artifactIds: ["artifact-image-1"],
          prompt: "Opening shot",
          negativePrompt: "blur",
          seed: 17,
          promotedAt: "2026-08-07T01:00:00.000Z",
        },
      ],
    };
    const result = duplicateStoryboardShot(shots, "opening", 0);

    expect(result.shots).toHaveLength(3);
    expect(result.shot).toMatchObject({ title: "开场 · 副本", frameStart: 48, frameEnd: 95 });
    expect(result.shot?.id).not.toBe("opening");
    expect(result.shot?.thumbnail).toBeUndefined();
    expect(result.shot).toMatchObject({
      rating: 4,
      notes: "Keep the key light warm.",
      generation: { workflowId: "comfy-workflow-image-main", outputs: [] },
    });
    expect(result.shots[2]).toMatchObject({ id: "reaction", frameStart: 96, frameEnd: 143 });
  });
});
