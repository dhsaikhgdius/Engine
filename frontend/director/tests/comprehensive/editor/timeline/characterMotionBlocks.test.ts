import { describe, expect, it } from "vitest";
import type { DirectorEntityAnimation } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  createDirectorCharacterMotionBlock,
  getTimelineCharacterMotionBlock,
  insertDirectorCharacterMotionBlock,
  removeDirectorCharacterMotionBlock,
  updateDirectorCharacterMotionBlock,
} from "../../../../src/comprehensive/editor/timeline/characterMotionBlocks";

const EMPTY_ANIMATION: DirectorEntityAnimation = { version: 1, keyframes: [] };

describe("character motion blocks", () => {
  it("inserts, sorts, edits, and removes non-overlapping blocks without replacing animation keyframes", () => {
    const later = createDirectorCharacterMotionBlock({
      id: "motion-later",
      clipId: "wave",
      frameStart: 24,
      frameEnd: 35,
    });
    const earlier = createDirectorCharacterMotionBlock({
      id: "motion-earlier",
      clipId: "walk",
      frameStart: 0,
      frameEnd: 23,
    });
    const withLater = insertDirectorCharacterMotionBlock(EMPTY_ANIMATION, later)!;
    const authored = insertDirectorCharacterMotionBlock(withLater, earlier)!;

    expect(authored.motionBlocks?.map((block) => block.id)).toEqual(["motion-earlier", "motion-later"]);
    expect(authored.keyframes).toEqual([]);
    expect(
      insertDirectorCharacterMotionBlock(
        authored,
        createDirectorCharacterMotionBlock({
          id: "motion-overlap",
          clipId: "run",
          frameStart: 20,
          frameEnd: 28,
        }),
      ),
    ).toBeNull();

    const edited = updateDirectorCharacterMotionBlock(authored, "motion-later", {
      clipId: "clap",
      frameStart: 30,
      frameEnd: 41,
    })!;
    expect(edited.motionBlocks?.[1]).toMatchObject({ clipId: "clap", frameStart: 30, frameEnd: 41 });
    expect(updateDirectorCharacterMotionBlock(edited, "motion-later", { frameStart: 12 })).toBeNull();

    expect(removeDirectorCharacterMotionBlock(edited, "motion-earlier").motionBlocks).toEqual([
      expect.objectContaining({ id: "motion-later" }),
    ]);
  });

  it("resolves only the block under the current frame and applies authored edge fades", () => {
    const animation: DirectorEntityAnimation = {
      version: 1,
      keyframes: [],
      motionBlocks: [
        {
          ...createDirectorCharacterMotionBlock({
            id: "motion-wave",
            clipId: "wave",
            frameStart: 12,
            frameEnd: 35,
          }),
          blendInS: 0.5,
          blendOutS: 0.5,
          weight: 0.8,
        },
      ],
    };

    expect(getTimelineCharacterMotionBlock(animation, 11, 24)).toBeNull();
    expect(getTimelineCharacterMotionBlock(animation, 12, 24)).toMatchObject({
      clipId: "wave",
      startFrame: 12,
      blendInS: 0,
      blendOutS: 0,
      weight: 0.8 / 12,
    });
    expect(getTimelineCharacterMotionBlock(animation, 23, 24)?.weight).toBeCloseTo(0.8);
    expect(getTimelineCharacterMotionBlock(animation, 35, 24)?.weight).toBeCloseTo(0.8 / 12);
    expect(getTimelineCharacterMotionBlock(animation, 36, 24)).toBeNull();
  });
});
