import { describe, expect, it } from "vitest";
import { evaluateDirectorCameraAtFrame } from "../../../../src/comprehensive/editor/schema/directorAnimation";
import {
  DEFAULT_DIRECTOR_CAMERA_ACTION,
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getCameraRigPositionFromViewSnapshot,
  getCameraViewSnapshotFromShot,
  getVerticalFovFromFocalLength,
} from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import type { DirectorCameraShot } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  buildDirectorCameraMove,
  classifyDirectorCameraMove,
  interpolateDirectorCameraFraming,
  type DirectorCameraFraming,
} from "../../../../src/comprehensive/editor/trajectory/cameraMoveAuthoring";

const TARGET: [number, number, number] = [0, 1, 0];

function framing(
  frame: number,
  position: [number, number, number],
  focalLengthMm = 35,
  target: [number, number, number] = TARGET,
): DirectorCameraFraming {
  return {
    frame,
    position,
    target,
    focalLengthMm,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

function cameraForMove(from: DirectorCameraFraming): DirectorCameraShot {
  const fov = getVerticalFovFromFocalLength(
    from.focalLengthMm,
    DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
    DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  );
  return {
    id: "camera-move",
    name: "Camera move",
    action: DEFAULT_DIRECTOR_CAMERA_ACTION,
    aspectRatio: DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
    sensorFormat: DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
    focalLengthMm: from.focalLengthMm,
    fov,
    transform: {
      position: getCameraRigPositionFromViewSnapshot({ position: from.position, target: from.target, fov }),
      rotation: [...from.rotation],
      scale: [...from.scale],
    },
    targetMode: "manual",
    target: [...from.target],
  };
}

describe("camera move authoring", () => {
  it("interpolates an orbit around the subject instead of cutting through it", () => {
    const from = framing(0, [0, 2, 5]);
    const to = framing(24, [5, 2, 0]);

    const midpoint = interpolateDirectorCameraFraming(from, to, 0.5);

    expect(midpoint.position[0]).toBeCloseTo(Math.sqrt(12.5), 5);
    expect(midpoint.position[2]).toBeCloseTo(Math.sqrt(12.5), 5);
    expect(Math.hypot(midpoint.position[0], midpoint.position[1] - 1, midpoint.position[2])).toBeCloseTo(
      Math.sqrt(26),
      5,
    );
  });

  it("takes the shortest angular path across the rear axis", () => {
    const radius = 5;
    const degrees = (value: number) => (value * Math.PI) / 180;
    const from = framing(0, [Math.sin(degrees(170)) * radius, 1, Math.cos(degrees(170)) * radius]);
    const to = framing(24, [Math.sin(degrees(-170)) * radius, 1, Math.cos(degrees(-170)) * radius]);

    const midpoint = interpolateDirectorCameraFraming(from, to, 0.5);

    expect(midpoint.position[0]).toBeCloseTo(0, 5);
    expect(midpoint.position[2]).toBeCloseTo(-radius, 5);
  });

  it.each([
    ["zoom-in", framing(0, [0, 1, 8], 35), framing(24, [0, 1, 8], 70)],
    ["push-in", framing(0, [0, 1, 10], 50), framing(24, [0, 1, 5], 50)],
    ["pull-out", framing(0, [0, 1, 5], 50), framing(24, [0, 1, 10], 50)],
    ["dolly-zoom", framing(0, [0, 1, 10], 70), framing(24, [0, 1, 5], 35)],
    ["orbit", framing(0, [0, 2, 5], 35), framing(24, [5, 2, 0], 35)],
    ["pan", framing(0, [0, 2, 5], 35, [0, 1, 0]), framing(24, [0, 2, 5], 35, [4, 1, 0])],
  ] as const)("classifies %s from measured camera geometry", (kind, from, to) => {
    expect(classifyDirectorCameraMove(from, to).kind).toBe(kind);
  });

  it("builds a frame-authoritative move and preserves keys outside its interval", () => {
    const from = framing(12, [0, 2, 5], 35);
    const to = framing(36, [5, 2, 0], 70);
    const camera = cameraForMove(from);
    const beforeKey = {
      frame: 4,
      interpolation: "linear" as const,
      transform: camera.transform,
      lookTarget: camera.target,
      fov: camera.fov,
    };
    const afterKey = { ...beforeKey, frame: 48 };

    const result = buildDirectorCameraMove({
      from,
      to,
      aspectRatio: DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
      sensorFormat: DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
      existingAnimation: { version: 1, enabled: true, source: "manual", keyframes: [beforeKey, afterKey] },
    });

    expect(result.animation.keyframes[0]?.frame).toBe(4);
    expect(result.animation.keyframes.at(-1)?.frame).toBe(48);
    expect(result.animation.keyframes.filter((keyframe) => keyframe.frame >= 12 && keyframe.frame <= 36).length).toBe(
      5,
    );
    expect(new Set(result.animation.keyframes.map((keyframe) => keyframe.frame)).size).toBe(
      result.animation.keyframes.length,
    );

    const authoredCamera: DirectorCameraShot = {
      ...camera,
      action: { mode: "transform" },
      animation: result.animation,
    };
    const midpoint = getCameraViewSnapshotFromShot(evaluateDirectorCameraAtFrame(authoredCamera, 24));

    expect(midpoint.position[0]).toBeCloseTo(Math.sqrt(12.5), 4);
    expect(midpoint.position[2]).toBeCloseTo(Math.sqrt(12.5), 4);
    expect(midpoint.fov).toBeCloseTo(
      getVerticalFovFromFocalLength(52.5, DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO, DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT),
      4,
    );
  });
});
