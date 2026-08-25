import { OrthographicCamera, PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import {
  configureBlenderStageCamera,
  getBlenderCameraProjection,
  getBlenderCameraViewSnapshot,
  type BlenderCameraViewSnapshot,
} from "../../../../src/comprehensive/editor/canvas/blenderCamera";

const perspectiveView: BlenderCameraViewSnapshot = {
  aspectRatio: 2,
  clipEnd: 400,
  clipStart: 0.1,
  focalLengthMm: 50,
  fov: 22.619864948,
  orthographicScale: 6,
  position: [1, 2, 3],
  projectionType: "PERSPECTIVE",
  sensorFit: "HORIZONTAL",
  sensorHeightMm: 20,
  sensorWidthMm: 40,
  shiftX: 0.1,
  shiftY: -0.25,
  target: [1, 2, 2],
};

describe("Blender camera projection", () => {
  it("keeps Blender physical optics in the live camera view snapshot", () => {
    const snapshot = getBlenderCameraViewSnapshot(
      {
        active: true,
        clipEnd: 750,
        clipStart: 0.05,
        focalLengthMm: 36,
        id: "camera-a",
        name: "Camera",
        orthographicScale: 6,
        position: [1, 2, 3],
        projectionType: "PERSPECTIVE",
        rotation: [0, 0, 0],
        sensorFit: "HORIZONTAL",
        sensorHeightMm: 24,
        sensorWidthMm: 36,
        shiftX: 0.12,
        shiftY: -0.08,
      },
      16 / 9,
    );

    expect(snapshot).toMatchObject({
      aspectRatio: 16 / 9,
      clipEnd: 750,
      clipStart: 0.05,
      focalLengthMm: 36,
      orthographicScale: 6,
      position: [1, 2, 3],
      projectionType: "PERSPECTIVE",
      sensorFit: "HORIZONTAL",
      sensorHeightMm: 24,
      sensorWidthMm: 36,
      shiftX: 0.12,
      shiftY: -0.08,
      target: [1, 2, 2],
    });
    expect(snapshot.fov).toBeCloseTo(31.417, 3);
  });

  it("matches Blender horizontal sensor fit and lens shift for perspective framing", () => {
    const projection = getBlenderCameraProjection(perspectiveView, 2);
    expect(projection).toMatchObject({ projectionType: "PERSPECTIVE", aspectRatio: 2 });
    if (projection.projectionType !== "PERSPECTIVE") throw new Error("Expected perspective projection");
    expect(projection.fov).toBeCloseTo(22.619864948, 8);
    expect(projection.view.offsetX).toBeCloseTo(0.1, 8);
    expect(projection.view.offsetY).toBeCloseTo(0.5, 8);

    const camera = configureBlenderStageCamera(new PerspectiveCamera(), perspectiveView, 2);
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(400);
    expect(camera.fov).toBeCloseTo(22.619864948, 8);
    expect(camera.aspect).toBe(2);
    expect(camera.view?.offsetX).toBeCloseTo(0.1, 8);
    expect(camera.view?.offsetY).toBeCloseTo(0.5, 8);
    expect(camera.position.toArray()).toEqual([1, 2, 3]);
  });

  it("uses Blender orthographic scale, vertical fit, shift, and clipping", () => {
    const view: BlenderCameraViewSnapshot = {
      ...perspectiveView,
      aspectRatio: 0.5,
      clipEnd: 900,
      clipStart: 0.25,
      projectionType: "ORTHOGRAPHIC",
      sensorFit: "VERTICAL",
      shiftX: 0.2,
      shiftY: -0.1,
    };
    const projection = getBlenderCameraProjection(view, 0.5);
    expect(projection).toMatchObject({ projectionType: "ORTHOGRAPHIC", far: 900, near: 0.25 });
    if (projection.projectionType !== "ORTHOGRAPHIC") throw new Error("Expected orthographic projection");
    expect(projection.left).toBeCloseTo(-0.3, 8);
    expect(projection.right).toBeCloseTo(2.7, 8);
    expect(projection.top).toBeCloseTo(2.4, 8);
    expect(projection.bottom).toBeCloseTo(-3.6, 8);

    const camera = configureBlenderStageCamera(new OrthographicCamera(), view, 0.5);
    expect(camera.left).toBeCloseTo(-0.3, 8);
    expect(camera.right).toBeCloseTo(2.7, 8);
    expect(camera.top).toBeCloseTo(2.4, 8);
    expect(camera.bottom).toBeCloseTo(-3.6, 8);
    expect(camera.near).toBe(0.25);
    expect(camera.far).toBe(900);
  });

  it("recomputes Blender AUTO fit for the capture aspect without changing the camera kind", () => {
    const view: BlenderCameraViewSnapshot = {
      ...perspectiveView,
      projectionType: "ORTHOGRAPHIC",
      sensorFit: "AUTO",
      shiftX: 0,
      shiftY: 0,
    };
    const camera = configureBlenderStageCamera(new OrthographicCamera(), view, 2);
    expect(camera.isOrthographicCamera).toBe(true);
    expect(camera.right - camera.left).toBeCloseTo(6, 8);
    expect(camera.top - camera.bottom).toBeCloseTo(3, 8);

    configureBlenderStageCamera(camera, view, 0.5);
    expect(camera.isOrthographicCamera).toBe(true);
    expect(camera.right - camera.left).toBeCloseTo(3, 8);
    expect(camera.top - camera.bottom).toBeCloseTo(6, 8);
  });
});
