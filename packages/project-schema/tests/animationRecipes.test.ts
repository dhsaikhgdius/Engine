import { describe, expect, it } from "vitest";
import type { DirectorTransform } from "../src/directorProject";
import { compileDirectorAnimationRecipe, directorAnimationRecipeInputSchema } from "../src/animationRecipes";
import { evaluateTrajectoryTransform } from "../src/trajectoryMath";

const BASE: DirectorTransform = {
  position: [3, 1, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

describe("Director animation recipes", () => {
  it("compiles a bounded multi-axis orbit into editable frame keyframes", () => {
    const animation = compileDirectorAnimationRecipe({
      baseTransform: BASE,
      frameStart: 10,
      frameEnd: 50,
      recipe: { type: "orbit", axis: "y", center: [0, 1, 0], cycles: 1, face_center: true },
    });

    expect(animation.recipe).toEqual({
      type: "orbit",
      axis: "y",
      center: [0, 1, 0],
      radius: 3,
      cycles: 1,
      clockwise: false,
      faceCenter: true,
    });
    expect(animation.keyframes[0]?.frame).toBe(10);
    expect(animation.keyframes.at(-1)?.frame).toBe(50);
    expect(evaluateTrajectoryTransform(animation, 30)?.position[0]).toBeCloseTo(-3, 5);
  });

  it("compiles a sine wave that returns exactly to its base transform", () => {
    const animation = compileDirectorAnimationRecipe({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 48,
      recipe: { type: "wave", axis: "z", amplitude: 2, cycles: 2 },
    });

    expect(animation.recipe).toMatchObject({ type: "wave", axis: "z", amplitude: 2, cycles: 2 });
    expect(animation.keyframes[0]?.transform?.position).toEqual(BASE.position);
    expect(animation.keyframes.at(-1)?.transform?.position[2]).toBeCloseTo(0, 8);
    expect(animation.keyframes.some((keyframe) => Math.abs(keyframe.transform?.position[2] ?? 0) > 1.9)).toBe(true);
  });

  it("compiles bounce and squash while restoring the exact base scale", () => {
    const animation = compileDirectorAnimationRecipe({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 60,
      recipe: { type: "bounce", height: 2, bounces: 3, squash: true },
    });

    expect(animation.recipe).toEqual({ type: "bounce", height: 2, bounces: 3, squash: true });
    expect(Math.max(...animation.keyframes.map((keyframe) => keyframe.transform?.position[1] ?? 0))).toBeCloseTo(3, 5);
    expect(animation.keyframes.some((keyframe) => keyframe.transform?.scale[1] !== 1)).toBe(true);
    expect(animation.keyframes.at(-1)?.transform?.scale).toEqual(BASE.scale);
  });

  it("caps generated keyframes and rejects unknown recipe fields", () => {
    const animation = compileDirectorAnimationRecipe({
      baseTransform: BASE,
      frameStart: 0,
      frameEnd: 100_000,
      recipe: { type: "wave", cycles: 64 },
    });
    expect(animation.keyframes.length).toBeLessThanOrEqual(257);
    expect(directorAnimationRecipeInputSchema.safeParse({ type: "bounce", unknown: true }).success).toBe(false);
  });
});
