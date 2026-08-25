import { describe, expect, it } from "vitest";
import type { DirectorEntityAnimation } from "../../../../src/comprehensive/editor/schema/directorProject";
import { getProceduralGaitControls, isProceduralGaitActive } from "../../../../src/comprehensive/editor/trajectory/proceduralGait";

const animation: DirectorEntityAnimation = {
  version: 1,
  enabled: true,
  preset: "line",
  motion: "walk",
  keyframes: [
    {
      frame: 10,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      frame: 34,
      transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ],
};

describe("procedural walk/run", () => {
  it("runs only inside the transform track and stops on the terminal frame", () => {
    expect(isProceduralGaitActive(animation, 9)).toBe(false);
    expect(isProceduralGaitActive(animation, 10)).toBe(true);
    expect(isProceduralGaitActive(animation, 33)).toBe(true);
    expect(isProceduralGaitActive(animation, 34)).toBe(false);
    expect(isProceduralGaitActive(animation, 200)).toBe(false);
  });

  it("does not walk in place across hold segments inside a longer animation", () => {
    const stagedAnimation: DirectorEntityAnimation = {
      ...animation,
      keyframes: [
        { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { frame: 24, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { frame: 48, transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { frame: 72, transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
    };

    expect(isProceduralGaitActive(stagedAnimation, 12)).toBe(false);
    expect(isProceduralGaitActive(stagedAnimation, 24)).toBe(true);
    expect(isProceduralGaitActive(stagedAnimation, 47)).toBe(true);
    expect(isProceduralGaitActive(stagedAnimation, 60)).toBe(false);
  });

  it("evaluates a changing gait without persisting per-frame keys", () => {
    const first = getProceduralGaitControls("walk", 10, 24);
    const second = getProceduralGaitControls("walk", 11, 24);
    const running = getProceduralGaitControls("run", 11, 24);

    expect(first?.["leftHip.pitch"]).not.toBe(second?.["leftHip.pitch"]);
    expect(running?.["body.pitch"]).toBe(7);
    expect(animation.keyframes).toHaveLength(2);
  });
});
