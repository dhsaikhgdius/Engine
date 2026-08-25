import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  getDirectorFrameTracks,
  getDirectorTrackTargetForObject,
  getEffectiveTimelineEndFrame,
  updateAnimationKeyframe,
} from "../../../../src/comprehensive/editor/timeline/frameTimeline";

describe("frame timeline track catalog", () => {
  it("resolves character and linked camera owners without a second timeline model", () => {
    const project = createDefaultDirectorProject();
    const character = getDirectorTrackTargetForObject(project, "char_default_a");
    const camera = getDirectorTrackTargetForObject(project, "cam_object_1");

    expect(character).toMatchObject({ ownerType: "object", kind: "character" });
    expect(camera).toMatchObject({ ownerType: "camera", ownerId: "cam_1", kind: "camera" });
  });

  it("uses the longest enabled entity keyframe as the effective endpoint", () => {
    const project = createDefaultDirectorProject();
    project.scene.timeline = {
      version: 1,
      fps: 24,
      frameStart: 0,
      frameEnd: 120,
      currentFrame: 0,
      loop: false,
    };
    project.objects[0].animation = {
      version: 1,
      keyframes: [{ frame: 0 }, { frame: 72 }],
    };
    project.cameras[0].animation = {
      version: 1,
      enabled: false,
      keyframes: [{ frame: 110 }],
    };

    expect(getDirectorFrameTracks(project)).toHaveLength(2);
    expect(getEffectiveTimelineEndFrame(project)).toBe(72);
  });

  it("keeps the authored timeline range when an animation only has a start keyframe", () => {
    const project = createDefaultDirectorProject();
    project.scene.timeline = {
      version: 1,
      fps: 24,
      frameStart: 0,
      frameEnd: 120,
      currentFrame: 0,
      loop: false,
    };
    project.cameras[0].animation = {
      version: 1,
      enabled: true,
      keyframes: [{ frame: 0 }],
    };

    expect(getEffectiveTimelineEndFrame(project)).toBe(120);
  });

  it("keeps an explicit empty track in the timeline without inventing animation keyframes", () => {
    const project = createDefaultDirectorProject();
    project.scene.timeline!.trackKeys = ["object:char_default_a"];

    expect(getDirectorFrameTracks(project)).toMatchObject([
      { key: "object:char_default_a", kind: "character", animation: undefined },
    ]);
    expect(project.objects[0].animation).toBeUndefined();
  });

  it("keeps motion-only character tracks visible and includes their last frame in the effective range", () => {
    const project = createDefaultDirectorProject();
    project.scene.timeline = {
      version: 1,
      fps: 24,
      frameStart: 0,
      frameEnd: 120,
      currentFrame: 0,
      loop: false,
    };
    project.objects[0].animation = {
      version: 1,
      keyframes: [],
      motionBlocks: [
        {
          id: "motion-wave",
          clipId: "wave",
          enabled: true,
          frameStart: 12,
          frameEnd: 72,
          loop: "once",
          speed: 1,
          weight: 1,
          blendInS: 0.12,
          blendOutS: 0.12,
          rootMotion: "in-place",
        },
      ],
    };

    expect(getDirectorFrameTracks(project)).toEqual([
      expect.objectContaining({ key: "object:char_default_a", kind: "character" }),
    ]);
    expect(getEffectiveTimelineEndFrame(project)).toBe(72);
  });

  it("keeps drag commits integer and inside the scene range", () => {
    const animation = updateAnimationKeyframe(
      { version: 1, keyframes: [{ frame: 10 }, { frame: 20 }] },
      1,
      { frame: 100.7 },
      0,
      48,
    );
    expect(animation.keyframes.map((keyframe) => keyframe.frame)).toEqual([10, 48]);
  });
});
