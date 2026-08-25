import { describe, expect, it } from "vitest";
import type { DirectorTransform } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  createFramePoseActionAnimation,
  createFrameTrajectoryAnimation,
  evaluateTrajectoryTransform,
  getTrajectoryFrameBounds,
  sampleTrajectoryPositions,
  resampleTrajectoryDrawingPoints,
} from "../../../../src/comprehensive/editor/trajectory/trajectoryMath";

const BASE: DirectorTransform = {
  position: [2, 0, 1],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

describe("frame-native trajectory math", () => {
  it.each(["line", "circle", "rectangle"] as const)("creates and samples %s paths", (preset) => {
    const animation = createFrameTrajectoryAnimation({
      baseTransform: BASE,
      frameStart: 12,
      frameEnd: 60,
      preset,
      motion: "walk",
    });

    expect(getTrajectoryFrameBounds(animation)).toEqual({ firstFrame: 12, lastFrame: 60 });
    expect(animation.keyframes.every((keyframe) => Number.isSafeInteger(keyframe.frame))).toBe(true);
    expect(sampleTrajectoryPositions(animation).length).toBeGreaterThan(2);
    expect(evaluateTrajectoryTransform(animation, 999)?.position).toEqual(
      evaluateTrajectoryTransform(animation, 60)?.position,
    );
  });

  it("uses exact circular geometry and keeps the terminal transform", () => {
    const animation = createFrameTrajectoryAnimation({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 48,
      preset: "circle",
      radius: 2,
      orientToPath: true,
    });

    expect(evaluateTrajectoryTransform(animation, 0)?.position).toEqual(BASE.position);
    expect(evaluateTrajectoryTransform(animation, 24)?.position[0]).toBeCloseTo(-2);
    expect(evaluateTrajectoryTransform(animation, 48)?.position).toEqual(BASE.position);
  });

  it("maps hold waypoints to the existing step interpolation", () => {
    const animation = createFrameTrajectoryAnimation({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 24,
      preset: "custom",
      waypoints: [
        { frame: 0, position: [0, 0, 0], interpolation: "hold" },
        { frame: 24, position: [8, 0, 0] },
      ],
    });

    expect(animation.keyframes[0].interpolation).toBe("step");
    expect(evaluateTrajectoryTransform(animation, 23)?.position).toEqual([0, 0, 0]);
  });

  it("preserves sparse pose data without generating gait keyframes", () => {
    const animation = createFrameTrajectoryAnimation({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 48,
      preset: "line",
      motion: "run",
      existingAnimation: {
        version: 1,
        keyframes: [{ frame: 10, poseValues: { "head.yaw": 12 } }],
      },
    });

    expect(animation.keyframes.find((keyframe) => keyframe.frame === 10)?.poseValues).toEqual({
      "head.yaw": 12,
    });
    expect(animation.keyframes.filter((keyframe) => keyframe.poseValues)).toHaveLength(1);
  });

  it("caps viewport samples for very long tracks", () => {
    const animation = createFrameTrajectoryAnimation({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 100_000,
      preset: "line",
    });
    expect(sampleTrajectoryPositions(animation)).toHaveLength(513);
  });

  it("resamples dense custom drawing points to the available integer frames", () => {
    const points = Array.from({ length: 20 }, (_, index): [number, number, number] => [index, 0, 0]);
    const sampled = resampleTrajectoryDrawingPoints(points, 5);
    expect(sampled).toHaveLength(5);
    expect(sampled[0]).toEqual([0, 0, 0]);
    expect(sampled[sampled.length - 1]).toEqual([19, 0, 0]);
  });

  it("evaluates cubic Bezier handles and retains tangent-based orientation", () => {
    const animation = createFrameTrajectoryAnimation({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 24,
      preset: "custom",
      orientToPath: true,
      waypoints: [
        { frame: 0, position: [0, 0, 0], curve: { out: [0, 0, 4] } },
        { frame: 24, position: [4, 0, 0], curve: { in: [0, 0, 4] } },
      ],
    });

    const midpoint = evaluateTrajectoryTransform(animation, 12);
    expect(midpoint?.position[2]).toBeGreaterThan(2);
    expect(midpoint?.rotation[1]).toBeCloseTo(Math.PI / 2, 4);
  });

  it("applies temporal easing before evaluating a spatial trajectory", () => {
    const animation = createFrameTrajectoryAnimation({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 20,
      preset: "custom",
      waypoints: [
        {
          frame: 0,
          position: [0, 0, 0],
          interpolation: "linear",
          timingCurve: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
        },
        { frame: 20, position: [10, 0, 0] },
      ],
    });

    expect(animation.keyframes[0].timingCurve).toEqual({ x1: 0.42, y1: 0, x2: 1, y2: 1 });
    expect(evaluateTrajectoryTransform(animation, 5)!.position[0]).toBeLessThan(2.5);
  });

  it("writes a duration-bound character action and restores the base pose", () => {
    const animation = createFramePoseActionAnimation({
      basePoseValues: { "head.yaw": 3 },
      frameStart: 12,
      frameEnd: 24,
      presetId: "wave",
      timelineEnd: 48,
    });

    expect(animation.actionPresetId).toBe("wave");
    expect(animation.keyframes.map((keyframe) => keyframe.frame)).toEqual([12, 24, 25]);
    expect(animation.keyframes[0]?.poseValues?.["rightElbow.bend"]).toBeGreaterThan(0);
    expect(animation.keyframes[2]?.poseValues).toEqual({ "head.yaw": 3 });
  });
});
