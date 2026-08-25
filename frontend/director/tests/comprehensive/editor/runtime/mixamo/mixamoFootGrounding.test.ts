import { Bone, Group, type Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  applyMixamoFootGrounding,
  createMixamoFootGroundingState,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootGrounding";

describe("Mixamo foot grounding", () => {
  it("reuses one world-position scratch vector across bones and frames", () => {
    const root = new Group();
    const leftFoot = new Bone();
    leftFoot.name = "mixamorigLeftFoot";
    leftFoot.position.set(-0.1, 0.1, 0);
    const rightFoot = new Bone();
    rightFoot.name = "mixamorigRightFoot";
    rightFoot.position.set(0.1, 0.12, 0);
    root.add(leftFoot, rightFoot);

    const scratchTargets: Vector3[] = [];
    for (const bone of [leftFoot, rightFoot]) {
      const getWorldPosition = bone.getWorldPosition.bind(bone);
      vi.spyOn(bone, "getWorldPosition").mockImplementation((target) => {
        scratchTargets.push(target);
        return getWorldPosition(target);
      });
    }

    const state = createMixamoFootGroundingState(root);
    expect(state).not.toBeNull();
    leftFoot.position.y = 0.25;
    rightFoot.position.y = 0.28;
    applyMixamoFootGrounding(root, state, true);
    const firstGroundedY = root.position.y;
    applyMixamoFootGrounding(root, state, true);

    expect(root.position.y).toBeCloseTo(firstGroundedY, 6);
    expect(scratchTargets.length).toBe(6);
    expect(scratchTargets.every((target) => target === scratchTargets[0])).toBe(true);
  });
});
