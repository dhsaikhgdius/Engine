import { describe, expect, it } from "vitest";
import {
  computeDirectorDenseMotionFlow,
  DIRECTOR_DENSE_MOTION_FLOW_CONTRACT,
  DIRECTOR_DENSE_MOTION_FLOW_SEMANTICS,
  type DirectorDenseMotionFlowField,
} from "../../../../src/comprehensive/editor/render/denseMotionFlow";
import type { DirectorMotionCameraPose } from "../../../../src/comprehensive/editor/render/motionVectorPass";

const WIDTH = 8;
const HEIGHT = 8;

/** Camera 5m back on +Z looking at the origin: right = +x, up = +y on screen. */
function frontCamera(overrides: Partial<DirectorMotionCameraPose> = {}): DirectorMotionCameraPose {
  return {
    position: [0, 0, 5],
    target: [0, 0, 0],
    fovDegrees: 60,
    aspect: 1,
    ...overrides,
  };
}

// One world metre at 5m eye depth, 60deg vertical fov, square raster:
// ndc = (1/5) / tan(30deg), pixels = ndc * 0.5 * WIDTH.
const ONE_METRE_AT_5M_PX = (0.2 / Math.tan(Math.PI / 6)) * 0.5 * WIDTH;

function constantDepth(depthM: number): Float32Array {
  return new Float32Array(WIDTH * HEIGHT).fill(depthM);
}

function flowAt(field: DirectorDenseMotionFlowField, x: number, y: number): [number, number] {
  const pixel = y * WIDTH + x;
  return [field.flow[pixel * 2]!, field.flow[pixel * 2 + 1]!];
}

describe("computeDirectorDenseMotionFlow", () => {
  it("produces the uniform parallax vector for a pure camera truck over constant depth", () => {
    // Camera trucks one metre right between the frames; the world plane sits
    // at 5m eye depth. Static geometry must appear to move one metre left.
    const field = computeDirectorDenseMotionFlow({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 11,
      toFrame: 12,
      fromCamera: frontCamera(),
      toCamera: frontCamera({ position: [1, 0, 5], target: [1, 0, 0] }),
      toDepth: constantDepth(5),
    });

    for (const [x, y] of [
      [0, 0],
      [4, 4],
      [7, 7],
      [2, 6],
    ] as const) {
      const [deltaX, deltaY] = flowAt(field, x, y);
      // The flow buffer stores float32; precision 6 sits above its ~1e-7 ulp.
      expect(deltaX).toBeCloseTo(-ONE_METRE_AT_5M_PX, 6);
      expect(deltaY).toBeCloseTo(0, 8);
    }
    expect(field.metadata.unprojectablePixels).toBe(0);
    expect(field.metadata.objectOverridePixels).toBe(0);
  });

  it("scales translation parallax with 1/depth, so far-plane background barely moves", () => {
    // Same truck, but every pixel carries the empty-background far-plane depth
    // (the float depth capture resolves no-geometry pixels to farM). The
    // reprojected far-plane point yields the correct, much smaller parallax.
    const farM = 100;
    const field = computeDirectorDenseMotionFlow({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 0,
      toFrame: 1,
      fromCamera: frontCamera(),
      toCamera: frontCamera({ position: [1, 0, 5], target: [1, 0, 0] }),
      toDepth: constantDepth(farM),
    });

    const [deltaX, deltaY] = flowAt(field, 4, 4);
    expect(deltaX).toBeCloseTo(-ONE_METRE_AT_5M_PX * (5 / farM), 6);
    expect(deltaY).toBeCloseTo(0, 8);
  });

  it("produces depth-independent flow for rotation-only camera motion", () => {
    // Panning about the camera position: every point along a viewing ray
    // projects to the same FROM pixel, so background at the far plane flows
    // exactly as strongly as near geometry.
    const fromCamera = frontCamera();
    const toCamera = frontCamera({ target: [1, 0, 0] });
    const near = computeDirectorDenseMotionFlow({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 3,
      toFrame: 4,
      fromCamera,
      toCamera,
      toDepth: constantDepth(5),
    });
    const far = computeDirectorDenseMotionFlow({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 3,
      toFrame: 4,
      fromCamera,
      toCamera,
      toDepth: constantDepth(100),
    });

    for (let pixel = 0; pixel < WIDTH * HEIGHT * 2; pixel += 1) {
      expect(near.flow[pixel]!).toBeCloseTo(far.flow[pixel]!, 6);
    }
    // Panning right moves screen content left by a clearly non-zero amount.
    const [deltaX] = flowAt(near, 4, 4);
    expect(deltaX).toBeLessThan(-1);
  });

  it("returns exact zero flow when the FROM and TO cameras are identical", () => {
    const field = computeDirectorDenseMotionFlow({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 0,
      toFrame: 0,
      fromCamera: frontCamera(),
      toCamera: frontCamera(),
      toDepth: constantDepth(42),
    });

    expect(field.flow.every((component) => component === 0)).toBe(true);
    expect(field.metadata.unprojectablePixels).toBe(0);
  });

  it("overrides the reprojection with exact per-object vectors inside silhouettes", () => {
    const objectColor: [number, number, number] = [10, 20, 30];
    const unmappedColor: [number, number, number] = [40, 50, 60];
    const objectIdRgba = new Uint8Array(WIDTH * HEIGHT * 4);
    objectIdRgba.set([...objectColor, 255], 0); // pixel (0, 0): obj-a
    objectIdRgba.set([...objectColor, 255], 4); // pixel (1, 0): obj-a
    objectIdRgba.set([...unmappedColor, 255], 8); // pixel (2, 0): silhouette without a vector

    const field = computeDirectorDenseMotionFlow({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 11,
      toFrame: 12,
      fromCamera: frontCamera(),
      toCamera: frontCamera({ position: [1, 0, 5], target: [1, 0, 0] }),
      toDepth: constantDepth(5),
      objectIdRgba,
      objectIdToRgb: { "obj-a": objectColor },
      objectVectors: [{ objectId: "obj-a", fromPx: [0, 3], toPx: [7, 0], deltaPx: [7, -3] }],
    });

    // Inside the mask the exact object vector wins over camera parallax.
    expect(flowAt(field, 0, 0)).toEqual([7, -3]);
    expect(flowAt(field, 1, 0)).toEqual([7, -3]);
    // A silhouette whose object has no vector keeps the camera-motion flow.
    expect(flowAt(field, 2, 0)[0]).toBeCloseTo(-ONE_METRE_AT_5M_PX, 6);
    // Background pixels (packed zero) keep the camera-motion flow too.
    expect(flowAt(field, 5, 5)[0]).toBeCloseTo(-ONE_METRE_AT_5M_PX, 6);
    expect(field.metadata.objectOverridePixels).toBe(2);
  });

  it("writes zero flow and counts pixels whose world point is behind the FROM camera", () => {
    const field = computeDirectorDenseMotionFlow({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 0,
      toFrame: 1,
      fromCamera: { position: [0, 0, -5], target: [0, 0, -10], fovDegrees: 60, aspect: 1 },
      toCamera: frontCamera(),
      toDepth: constantDepth(5), // world plane z = 0, behind the FROM camera
    });

    expect(field.metadata.unprojectablePixels).toBe(WIDTH * HEIGHT);
    expect(field.flow.every((component) => component === 0)).toBe(true);
  });

  it("echoes the frame pair, cameras, and the portable semantics block", () => {
    const fromCamera = frontCamera();
    const toCamera = frontCamera({ position: [1, 0, 5], target: [1, 0, 0] });
    const field = computeDirectorDenseMotionFlow({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 23,
      toFrame: 24,
      fromCamera,
      toCamera,
      toDepth: constantDepth(5),
    });

    expect(field.metadata).toMatchObject({
      renderPass: "motion",
      width: WIDTH,
      height: HEIGHT,
      pixelFormat: "float32x2",
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: "dense-motion-flow-pixels",
      fromFrame: 23,
      toFrame: 24,
      camera: { from: fromCamera, to: toCamera },
    });
    expect(field.metadata.semantics).toEqual(DIRECTOR_DENSE_MOTION_FLOW_SEMANTICS);
    expect(field.metadata.semantics.contract).toBe(DIRECTOR_DENSE_MOTION_FLOW_CONTRACT);
    expect(field.metadata.semantics.direction).toBe("to-minus-from");
    expect(field.metadata.semantics.channels).toEqual({ R: "delta-x-pixels", G: "delta-y-pixels" });
  });

  it("rejects mismatched buffers, invalid depth values, and invalid cameras", () => {
    expect(() =>
      computeDirectorDenseMotionFlow({
        width: WIDTH,
        height: HEIGHT,
        fromFrame: 0,
        toFrame: 1,
        fromCamera: frontCamera(),
        toCamera: frontCamera(),
        toDepth: new Float32Array(3),
      }),
    ).toThrow(`must contain ${WIDTH * HEIGHT} floats; received 3`);

    expect(() =>
      computeDirectorDenseMotionFlow({
        width: WIDTH,
        height: HEIGHT,
        fromFrame: 0,
        toFrame: 1,
        fromCamera: frontCamera(),
        toCamera: frontCamera(),
        toDepth: constantDepth(5),
        objectIdRgba: new Uint8Array(4),
      }),
    ).toThrow(/object-id buffer/);

    expect(() =>
      computeDirectorDenseMotionFlow({
        width: WIDTH,
        height: HEIGHT,
        fromFrame: 0,
        toFrame: 1,
        fromCamera: frontCamera(),
        toCamera: frontCamera({ position: [1, 0, 5], target: [1, 0, 0] }),
        toDepth: constantDepth(0),
      }),
    ).toThrow("must be a positive metre value");

    expect(() =>
      computeDirectorDenseMotionFlow({
        width: WIDTH,
        height: HEIGHT,
        fromFrame: 0,
        toFrame: 1,
        fromCamera: frontCamera({ fovDegrees: 0 }),
        toCamera: frontCamera(),
        toDepth: constantDepth(5),
      }),
    ).toThrow("fov must be inside (0, 180)");
  });
});
