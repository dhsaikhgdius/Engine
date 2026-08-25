import { describe, expect, it } from "vitest";
import type { DirectorCameraShot, DirectorEntityAnimation, DirectorObject } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  evaluateDirectorCameraAtFrame,
  evaluateDirectorObjectAtFrame,
  getDirectorCameraAnimationFrame,
  evaluatePoseValuesAnimation,
  getDirectorTimelineFrameAtElapsedTime,
} from "../../../../src/comprehensive/editor/schema/directorAnimation";

const BASE_TRANSFORM = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function createAnimatedObject(interpolation: "step" | "linear" | "smooth"): DirectorObject {
  return {
    id: "role-1",
    name: "角色",
    kind: "character",
    visible: true,
    locked: false,
    transform: BASE_TRANSFORM,
    characterRig: {
      rigType: "ue4-mannequin",
      posePresetId: "stand",
      controls: { punch: 0, guard: 20 },
    },
    animation: {
      version: 1,
      keyframes: [
        {
          frame: 1,
          interpolation,
          transform: BASE_TRANSFORM,
          poseValues: { punch: 0 },
        },
        {
          frame: 11,
          interpolation: "linear",
          transform: {
            position: [10, 2, -4],
            rotation: [1, 2, 3],
            scale: [2, 3, 4],
          },
          poseValues: { punch: 100 },
        },
      ],
    },
  };
}

describe("director animation evaluation", () => {
  it("advances, loops and ends a timeline from elapsed wall-clock time", () => {
    const timeline = {
      version: 1 as const,
      fps: 24,
      frameStart: 1,
      frameEnd: 48,
      currentFrame: 1,
      loop: true,
    };

    expect(getDirectorTimelineFrameAtElapsedTime(timeline, 1, 500)).toEqual({ frame: 13, ended: false });
    expect(getDirectorTimelineFrameAtElapsedTime(timeline, 40, 500)).toEqual({ frame: 4, ended: false });
    expect(getDirectorTimelineFrameAtElapsedTime({ ...timeline, loop: false }, 40, 500)).toEqual({
      frame: 48,
      ended: true,
    });
  });

  it("linearly interpolates root transforms and individual pose controls without mutating the scene", () => {
    const item = createAnimatedObject("linear");
    const evaluated = evaluateDirectorObjectAtFrame(item, 6);

    expect(evaluated.transform).toEqual({
      position: [5, 1, -2],
      rotation: [0.5, 1, 1.5],
      scale: [1.5, 2, 2.5],
    });
    expect(evaluated.characterRig?.controls).toEqual({ punch: 50, guard: 20 });
    expect(item.transform.position).toEqual([0, 0, 0]);
    expect(item.characterRig?.controls.punch).toBe(0);
  });

  it("preserves rig identity for transform-only playback frames", () => {
    const item = createAnimatedObject("linear");
    item.animation = {
      version: 1,
      keyframes: item.animation!.keyframes.map(({ frame, interpolation, transform }) => ({
        frame,
        interpolation,
        transform,
      })),
    };

    const evaluated = evaluateDirectorObjectAtFrame(item, 6);

    expect(evaluated.characterRig).toBe(item.characterRig);
    expect(evaluated.characterRig?.controls).toBe(item.characterRig?.controls);
    expect(evaluated.transform.position).toEqual([5, 1, -2]);
  });

  it("supports step and smooth interpolation", () => {
    expect(evaluateDirectorObjectAtFrame(createAnimatedObject("step"), 6).transform.position).toEqual([0, 0, 0]);
    expect(evaluateDirectorObjectAtFrame(createAnimatedObject("smooth"), 3.5).transform.position[0]).toBeCloseTo(
      1.5625,
    );
  });

  it("uses a keyframe timing curve for transforms and sparse value channels", () => {
    const item = createAnimatedObject("linear");
    item.animation!.keyframes[0].timingCurve = { x1: 0.42, y1: 0, x2: 1, y2: 1 };
    const evaluated = evaluateDirectorObjectAtFrame(item, 3.5);

    expect(evaluated.transform.position[0]).toBeLessThan(2.5);
    expect(evaluated.characterRig!.controls.punch).toBeLessThan(25);
  });

  it("uses the newly keyed value on an exact frame even after a step segment", () => {
    const item = createAnimatedObject("step");
    item.animation?.keyframes.push({
      frame: 21,
      interpolation: "linear",
      transform: { ...BASE_TRANSFORM, position: [20, 0, 0] },
    });

    expect(evaluateDirectorObjectAtFrame(item, 11).transform.position).toEqual([10, 2, -4]);
  });

  it("holds the first and last keyed values outside the keyed range", () => {
    const item = createAnimatedObject("linear");

    expect(evaluateDirectorObjectAtFrame(item, -100).transform.position).toEqual([0, 0, 0]);
    expect(evaluateDirectorObjectAtFrame(item, 100).transform.position).toEqual([10, 2, -4]);
  });

  it("interpolates sparse pose channels independently while preserving static controls", () => {
    const controls = evaluatePoseValuesAnimation(
      { static: 7 },
      {
        version: 1,
        keyframes: [
          { frame: 1, interpolation: "linear", poseValues: { left: 0 } },
          { frame: 5, interpolation: "linear", poseValues: { right: 20 } },
          { frame: 11, interpolation: "linear", poseValues: { left: 10, right: 80 } },
        ],
      },
      8,
    );

    expect(controls.static).toBe(7);
    expect(controls.left).toBe(7);
    expect(controls.right).toBe(50);
  });

  it("compiles immutable sparse channels once and reuses them across playback frames", () => {
    let poseValueReads = 0;
    const keyframes = [
      { frame: 0, value: 0 },
      { frame: 24, value: 100 },
    ].map(({ frame, value }) => {
      const keyframe = { frame, interpolation: "linear" as const };
      Object.defineProperty(keyframe, "poseValues", {
        enumerable: true,
        get() {
          poseValueReads += 1;
          return { punch: value };
        },
      });
      return keyframe;
    });
    const animation: DirectorEntityAnimation = { version: 1, keyframes };
    Object.freeze(animation.keyframes);
    Object.freeze(animation);

    for (let frame = 0; frame <= 24; frame += 1) {
      evaluatePoseValuesAnimation({}, animation, frame);
    }

    expect(poseValueReads).toBe(2);
    expect(evaluatePoseValuesAnimation({}, animation, 12)).toEqual({ punch: 50 });
    expect(poseValueReads).toBe(2);
  });

  it("preserves duplicate-frame ordering and isolates cached transforms from evaluated output", () => {
    const item = createAnimatedObject("linear");
    item.animation = {
      version: 1,
      keyframes: [
        { frame: 10, interpolation: "linear", transform: { ...BASE_TRANSFORM, position: [2, 0, 0] } },
        { frame: 0, interpolation: "linear", transform: BASE_TRANSFORM },
        { frame: 10, interpolation: "linear", transform: { ...BASE_TRANSFORM, position: [8, 0, 0] } },
        { frame: 20, interpolation: "linear", transform: { ...BASE_TRANSFORM, position: [10, 0, 0] } },
      ],
    };

    const exact = evaluateDirectorObjectAtFrame(item, 10);
    expect(exact.transform.position).toEqual([2, 0, 0]);
    expect(evaluateDirectorObjectAtFrame(item, 15).transform.position).toEqual([9, 0, 0]);

    exact.transform.position[0] = 999;
    expect(evaluateDirectorObjectAtFrame(item, 10).transform.position).toEqual([2, 0, 0]);

    const replacement = {
      ...item,
      animation: {
        ...item.animation,
        keyframes: item.animation.keyframes.map((keyframe) =>
          keyframe.frame === 20
            ? { ...keyframe, transform: { ...keyframe.transform!, position: [20, 0, 0] as [number, number, number] } }
            : keyframe,
        ),
      },
    };
    expect(evaluateDirectorObjectAtFrame(replacement, 15).transform.position).toEqual([14, 0, 0]);
  });

  it("evaluates camera transform, look target and fov together", () => {
    const camera: DirectorCameraShot = {
      id: "cam-1",
      name: "推镜",
      fov: 50,
      transform: BASE_TRANSFORM,
      targetMode: "manual",
      target: [0, 1, 0],
      animation: {
        version: 1,
        keyframes: [
          {
            frame: 1,
            interpolation: "linear",
            transform: BASE_TRANSFORM,
            lookTarget: [0, 1, 0],
            fov: 50,
          },
          {
            frame: 21,
            interpolation: "linear",
            transform: { ...BASE_TRANSFORM, position: [4, 2, 8] },
            lookTarget: [2, 1, 0],
            fov: 30,
          },
        ],
      },
    };

    const evaluated = evaluateDirectorCameraAtFrame(camera, 11);
    expect(evaluated.transform.position).toEqual([2, 1, 4]);
    expect(evaluated.target).toEqual([1, 1, 0]);
    expect(evaluated.fov).toBe(40);
  });

  it("evaluates fallback procedural gait only before the trajectory endpoint and holds the final transform", () => {
    const item = createAnimatedObject("linear");
    item.animation = {
      ...item.animation!,
      enabled: true,
      preset: "line",
      motion: "walk",
      orientToPath: true,
    };

    const moving = evaluateDirectorObjectAtFrame(item, 6, 24);
    const ended = evaluateDirectorObjectAtFrame(item, 11, 24);
    const after = evaluateDirectorObjectAtFrame(item, 99, 24);

    expect(moving.characterRig?.posePresetId).toBe("walk");
    expect(moving.characterRig?.controls["leftHip.pitch"]).not.toBeUndefined();
    expect(ended.characterRig?.controls["leftHip.pitch"]).toBeUndefined();
    expect(after.transform.position).toEqual([10, 2, -4]);
  });

  it("keeps Mixamo trajectory playback on the real clip without writing a gait pose or controls", () => {
    const item = createAnimatedObject("linear");
    item.characterRig = {
      rigType: "mixamo",
      posePresetId: "stand",
      controls: { guard: 20 },
    };
    item.animation = {
      version: 1,
      enabled: true,
      preset: "line",
      motion: "walk",
      orientToPath: true,
      keyframes: item.animation!.keyframes.map(({ frame, interpolation, transform }) => ({
        frame,
        interpolation,
        transform,
      })),
    };

    const moving = evaluateDirectorObjectAtFrame(item, 6, 24);

    expect(moving.transform.position).toEqual([5, 1, -2]);
    expect(moving.characterRig).toBe(item.characterRig);
    expect(moving.characterRig?.posePresetId).toBe("stand");
    expect(moving.characterRig?.controls).toBe(item.characterRig.controls);
    expect(moving.characterRig?.controls["leftHip.pitch"]).toBeUndefined();
    expect(moving.characterRig?.controls["body.offsetY"]).toBeUndefined();
  });

  it("uses exact circle trajectory geometry and path orientation in rendered object frames", () => {
    const item = createAnimatedObject("linear");
    item.animation = {
      ...item.animation!,
      preset: "circle",
      circle: { center: [0, 0, 0], radius: 4, startAngle: 0, clockwise: false },
      orientToPath: true,
      keyframes: [
        { frame: 0, interpolation: "linear", transform: { ...BASE_TRANSFORM, position: [4, 0, 0] } },
        { frame: 24, interpolation: "linear", transform: { ...BASE_TRANSFORM, position: [4, 0, 0] } },
      ],
    };

    const quarter = evaluateDirectorObjectAtFrame(item, 6, 24);
    expect(quarter.transform.position[0]).toBeCloseTo(0, 5);
    expect(quarter.transform.position[2]).toBeCloseTo(4, 5);
    expect(quarter.transform.rotation[1]).toBeCloseTo(-Math.PI / 2, 5);
  });

  it("uses frame-native trajectory evaluation for camera motion", () => {
    const camera: DirectorCameraShot = {
      id: "cam-circle",
      name: "环绕机位",
      fov: 45,
      transform: { ...BASE_TRANSFORM, position: [3, 1, 0] },
      targetMode: "manual",
      target: [0, 1, 0],
      animation: {
        version: 1,
        preset: "circle",
        circle: { center: [0, 1, 0], radius: 3, startAngle: 0, clockwise: false },
        orientToPath: false,
        keyframes: [
          { frame: 0, interpolation: "linear", transform: { ...BASE_TRANSFORM, position: [3, 1, 0] } },
          { frame: 20, interpolation: "linear", transform: { ...BASE_TRANSFORM, position: [3, 1, 0] } },
        ],
      },
    };

    const halfway = evaluateDirectorCameraAtFrame(camera, 10);
    expect(halfway.transform.position[0]).toBeCloseTo(-3, 5);
    expect(halfway.transform.position[1]).toBeCloseTo(1, 5);
    expect(halfway.transform.position[2]).toBeCloseTo(0, 5);
  });

  it("keeps an explicit Still action static after its transform track is disabled", () => {
    const camera: DirectorCameraShot = {
      id: "cam-still",
      name: "静止机位",
      fov: 45,
      transform: BASE_TRANSFORM,
      targetMode: "manual",
      target: [0, 1, 0],
      action: { mode: "still" },
      animation: {
        version: 1,
        enabled: false,
        keyframes: [
          { frame: 0, transform: BASE_TRANSFORM },
          { frame: 24, transform: { ...BASE_TRANSFORM, position: [8, 0, 0] } },
        ],
      },
    };

    expect(evaluateDirectorCameraAtFrame(camera, 12).transform.position).toEqual([0, 0, 0]);
  });

  it("applies Path speed and locks the lens to the selected target", () => {
    const camera: DirectorCameraShot = {
      id: "cam-path",
      name: "路径机位",
      fov: 45,
      transform: BASE_TRANSFORM,
      targetMode: "manual",
      target: [0, 1, 0],
      action: { mode: "path", path: { speed: 2, lockTarget: true, targetObjectId: "role-1" } },
      animation: {
        version: 1,
        keyframes: [
          { frame: 0, interpolation: "linear", transform: BASE_TRANSFORM },
          { frame: 20, interpolation: "linear", transform: { ...BASE_TRANSFORM, position: [10, 0, 0] } },
        ],
      },
    };

    const evaluated = evaluateDirectorCameraAtFrame(camera, 5, { id: "role-1", position: [2, 3, 4] });
    expect(evaluated.transform.position).toEqual([5, 0, 0]);
    expect(evaluated.target).toEqual([2, 3, 4]);
  });

  it("keeps each recorded camera waypoint locked to its own moving subject", () => {
    const camera: DirectorCameraShot = {
      id: "cam-subjects",
      name: "逐点跟拍",
      fov: 45,
      transform: BASE_TRANSFORM,
      targetMode: "manual",
      target: [0, 1, 0],
      animation: {
        version: 1,
        keyframes: [
          { frame: 0, transform: BASE_TRANSFORM, lookTargetObjectId: "role-a" },
          { frame: 24, transform: BASE_TRANSFORM, lookTargetObjectId: "role-b" },
        ],
      },
    };
    const targets = [
      { id: "role-a", position: [1, 2, 3] as [number, number, number] },
      { id: "role-b", position: [8, 4, 2] as [number, number, number] },
    ];

    expect(evaluateDirectorCameraAtFrame(camera, 12, targets).target).toEqual([1, 2, 3]);
    expect(evaluateDirectorCameraAtFrame(camera, 24, targets).target).toEqual([8, 4, 2]);
  });

  it("maps a path timeline frame to its authored camera keyframe frame", () => {
    const camera: DirectorCameraShot = {
      id: "cam-path-frame",
      name: "路径机位",
      transform: BASE_TRANSFORM,
      target: [0, 1, 0],
      targetMode: "manual",
      fov: 45,
      action: { mode: "path", path: { speed: 2, lockTarget: false, targetObjectId: null } },
      animation: {
        version: 1,
        keyframes: [
          { frame: 10, transform: BASE_TRANSFORM },
          { frame: 30, transform: { ...BASE_TRANSFORM, position: [4, 0, 0] } },
        ],
      },
    };

    expect(getDirectorCameraAnimationFrame(camera, 5)).toBe(10);
    expect(getDirectorCameraAnimationFrame(camera, 15)).toBe(20);
    expect(getDirectorCameraAnimationFrame(camera, 30)).toBe(30);
  });

  it("keeps the camera's saved relative framing while following an animated target", () => {
    const camera: DirectorCameraShot = {
      id: "cam-follow",
      name: "跟随机位",
      fov: 45,
      transform: { ...BASE_TRANSFORM, position: [4, 2, -3] },
      targetMode: "manual",
      target: [0, 1, 0],
      action: {
        mode: "follow",
        follow: {
          targetObjectId: "role-1",
          positionOffset: [4, 2, -3],
          targetOffset: [0, 1, 0],
        },
      },
    };

    const evaluated = evaluateDirectorCameraAtFrame(camera, 12, { id: "role-1", position: [6, 0, 5] });
    expect(evaluated.transform.position).toEqual([10, 2, 2]);
    expect(evaluated.target).toEqual([6, 1, 5]);
  });

  it("does not evaluate a disabled animation track", () => {
    const item = createAnimatedObject("linear");
    item.animation = { ...item.animation!, enabled: false };

    expect(evaluateDirectorObjectAtFrame(item, 6)).toBe(item);
  });

  it("returns legacy static entities by reference when no animation exists", () => {
    const item = createAnimatedObject("linear");
    delete item.animation;

    expect(evaluateDirectorObjectAtFrame(item, 20)).toBe(item);
  });
});
