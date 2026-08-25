import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { buildDirectorCameraTrajectory } from "../../../../src/comprehensive/editor/shot/cameraTrajectory";

describe("buildDirectorCameraTrajectory", () => {
  it("samples the canonical evaluated camera over an exact inclusive frame range", () => {
    const project = createDefaultDirectorProject();
    const camera = project.cameras[0]!;
    camera.animation = {
      version: 1,
      enabled: true,
      source: "manual",
      keyframes: [
        {
          frame: 0,
          interpolation: "linear",
          transform: { ...camera.transform, position: [0, 2, 8] },
          lookTarget: [0, 1, 0],
          fov: 40,
        },
        {
          frame: 2,
          interpolation: "linear",
          transform: { ...camera.transform, position: [2, 2, 8] },
          lookTarget: [2, 1, 0],
          fov: 50,
        },
      ],
    };

    const trajectory = buildDirectorCameraTrajectory(project, {
      cameraId: camera.id,
      frameStart: 0,
      frameEnd: 2,
    });

    expect(trajectory.contract).toBe("director-camera-trajectory-v1");
    expect(trajectory.coordinateSystem).toEqual({
      handedness: "right",
      upAxis: "Y",
      forwardAxis: "-Z",
      linearUnit: "meter",
      rotationUnit: "degree",
    });
    expect(trajectory.samples).toHaveLength(3);
    expect(trajectory.samples.map((sample) => sample.frame)).toEqual([0, 1, 2]);
    expect(trajectory.samples[1]?.position[0]).toBeCloseTo(1);
    expect(trajectory.samples[2]?.fov).toBeCloseTo(50);
  });

  it("rejects inverted and unexpectedly large frame ranges", () => {
    const project = createDefaultDirectorProject();
    expect(() => buildDirectorCameraTrajectory(project, { frameStart: 2, frameEnd: 1 })).toThrow(/cannot be before/);
    expect(() => buildDirectorCameraTrajectory(project, { frameStart: 0, frameEnd: 5, maxSamples: 5 })).toThrow(
      /limit is 5/,
    );
  });
});
