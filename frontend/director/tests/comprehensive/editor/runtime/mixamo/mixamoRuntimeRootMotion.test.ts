import { AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";
import { stripPhysicalRuntimeRootTranslation } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoRuntimeRootMotion";

describe("physical runtime root-motion ownership", () => {
  it("pins every root translation axis to rest without changing the source clip or rotation performance", () => {
    const clip = new AnimationClip("runtime-jump", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 0.5, 1], [1, 2, 3, 2, 5, 4, 4, 2.5, 8]),
      new QuaternionKeyframeTrack("Hips.quaternion", [0, 1], [0, 0, 0, 1, 0, 0.3826834, 0, 0.9238795]),
      new VectorKeyframeTrack("LeftHand.position", [0, 1], [0, 0, 0, 0.2, 0.1, 0]),
    ]);
    const originalRootValues = Array.from(clip.tracks[0]!.values);
    const originalRotationValues = Array.from(clip.tracks[1]!.values);
    const originalHandValues = Array.from(clip.tracks[2]!.values);

    const stripped = stripPhysicalRuntimeRootTranslation({
      clip,
      rootBoneName: "Hips",
      restPosition: [0, 1.25, 0],
    });

    expect(stripped).not.toBe(clip);
    expect(Array.from(stripped.tracks[0]!.values)).toEqual([0, 1.25, 0, 0, 1.25, 0, 0, 1.25, 0]);
    expect(Array.from(stripped.tracks[1]!.values)).toEqual(originalRotationValues);
    expect(Array.from(stripped.tracks[2]!.values)).toEqual(originalHandValues);
    expect(Array.from(clip.tracks[0]!.values)).toEqual(originalRootValues);
    expect(stripped.duration).toBe(clip.duration);
  });

  it("leaves clips without the resolved root-position track untouched", () => {
    const clip = new AnimationClip("gesture", 1, [
      new QuaternionKeyframeTrack("Hips.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);

    expect(
      stripPhysicalRuntimeRootTranslation({
        clip,
        rootBoneName: "Hips",
        restPosition: [0, 1, 0],
      }),
    ).toBe(clip);
  });
});
