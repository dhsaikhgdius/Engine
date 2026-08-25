import { describe, expect, it } from "vitest";
import {
  buildDirectorMotionVectorSidecar,
  composeDirectorMotionVectorPass,
  computeDirectorObjectMotionVectors,
  DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION,
  DIRECTOR_MOTION_VECTORS_CONTRACT,
  getDirectorMotionMaxMagnitudePx,
  getDirectorMotionSourceFrames,
  motionVectorToHsvRgb,
  projectDirectorWorldPointToPixels,
  type DirectorMotionCameraPose,
} from "../../../../src/comprehensive/editor/render/motionVectorPass";

const WIDTH = 200;
const HEIGHT = 200;

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

// One world metre at x, 5m deep, 60deg vertical fov, square raster:
// ndc = (1/5) / tan(30deg), pixels = ndc * 0.5 * 200.
const ONE_METRE_AT_5M_PX = (0.2 / Math.tan(Math.PI / 6)) * 0.5 * WIDTH;

describe("projectDirectorWorldPointToPixels", () => {
  it("projects the look-at target to the raster centre", () => {
    expect(projectDirectorWorldPointToPixels([0, 0, 0], frontCamera(), WIDTH, HEIGHT)).toEqual([100, 100]);
  });

  it("maps +x world offsets to the right and +y offsets upward (y-down pixels)", () => {
    const right = projectDirectorWorldPointToPixels([1, 0, 0], frontCamera(), WIDTH, HEIGHT)!;
    expect(right[0]).toBeCloseTo(100 + ONE_METRE_AT_5M_PX, 10);
    expect(right[1]).toBeCloseTo(100, 10);

    const up = projectDirectorWorldPointToPixels([0, 1, 0], frontCamera(), WIDTH, HEIGHT)!;
    expect(up[0]).toBeCloseTo(100, 10);
    expect(up[1]).toBeCloseTo(100 - ONE_METRE_AT_5M_PX, 10);
  });

  it("returns null for points on or behind the camera plane", () => {
    expect(projectDirectorWorldPointToPixels([0, 0, 10], frontCamera(), WIDTH, HEIGHT)).toBeNull();
  });
});

describe("computeDirectorObjectMotionVectors", () => {
  it("computes the exact displacement for a moving object seen from a static camera", () => {
    const camera = frontCamera();
    const [vector] = computeDirectorObjectMotionVectors({
      width: WIDTH,
      height: HEIGHT,
      fromCamera: camera,
      toCamera: camera,
      fromAnchors: [{ objectId: "obj-a", position: [0, 0, 0] }],
      toAnchors: [{ objectId: "obj-a", position: [1, 0, 0] }],
    });
    expect(vector).toBeDefined();
    expect(vector!.fromPx).toEqual([100, 100]);
    expect(vector!.toPx[0]).toBeCloseTo(100 + ONE_METRE_AT_5M_PX, 10);
    expect(vector!.deltaPx[0]).toBeCloseTo(ONE_METRE_AT_5M_PX, 10);
    expect(vector!.deltaPx[1]).toBeCloseTo(0, 10);
  });

  it("produces a parallax vector for a static object seen from a moving camera", () => {
    const [vector] = computeDirectorObjectMotionVectors({
      width: WIDTH,
      height: HEIGHT,
      fromCamera: frontCamera(),
      // The camera trucks one metre right (target moves with it): the static
      // object must appear to move left by the same screen distance.
      toCamera: frontCamera({ position: [1, 0, 5], target: [1, 0, 0] }),
      fromAnchors: [{ objectId: "obj-a", position: [0, 0, 0] }],
      toAnchors: [{ objectId: "obj-a", position: [0, 0, 0] }],
    });
    expect(vector).toBeDefined();
    expect(vector!.deltaPx[0]).toBeCloseTo(-ONE_METRE_AT_5M_PX, 10);
    expect(vector!.deltaPx[1]).toBeCloseTo(0, 10);
  });

  it("yields zero vectors at frame 0, where both endpoints sample the same frame", () => {
    expect(getDirectorMotionSourceFrames(0)).toEqual({ fromFrame: 0, toFrame: 0 });
    expect(getDirectorMotionSourceFrames(24)).toEqual({ fromFrame: 23, toFrame: 24 });

    const camera = frontCamera();
    const anchors = [{ objectId: "obj-a", position: [1, 2, -3] as [number, number, number] }];
    const [vector] = computeDirectorObjectMotionVectors({
      width: WIDTH,
      height: HEIGHT,
      fromCamera: camera,
      toCamera: camera,
      fromAnchors: anchors,
      toAnchors: anchors,
    });
    expect(vector!.deltaPx).toEqual([0, 0]);
  });

  it("omits objects that are unprojectable in either frame", () => {
    const camera = frontCamera();
    const vectors = computeDirectorObjectMotionVectors({
      width: WIDTH,
      height: HEIGHT,
      fromCamera: camera,
      toCamera: camera,
      fromAnchors: [{ objectId: "behind", position: [0, 0, 10] }],
      toAnchors: [{ objectId: "behind", position: [0, 0, 0] }],
    });
    expect(vectors).toEqual([]);
  });
});

describe("motionVectorToHsvRgb", () => {
  it("encodes rightward motion as red (hue 0)", () => {
    const [red, green, blue] = motionVectorToHsvRgb([10, 0], 100);
    expect(red).toBeGreaterThan(0);
    expect(green).toBe(0);
    expect(blue).toBe(0);
  });

  it("encodes downward screen motion in the green range (hue 90)", () => {
    const [red, green, blue] = motionVectorToHsvRgb([0, 10], 100);
    expect(green).toBeGreaterThan(red);
    expect(blue).toBe(0);
  });

  it("maps magnitude to brightness and clamps at maxMagnitudePx", () => {
    expect(motionVectorToHsvRgb([0, 0], 100)).toEqual([0, 0, 0]);
    expect(motionVectorToHsvRgb([50, 0], 100)).toEqual([128, 0, 0]);
    expect(motionVectorToHsvRgb([100, 0], 100)).toEqual([255, 0, 0]);
    expect(motionVectorToHsvRgb([400, 0], 100)).toEqual([255, 0, 0]);
  });
});

describe("composeDirectorMotionVectorPass", () => {
  it("fills the object-id silhouette with the flow color and leaves everything else black", () => {
    const width = 4;
    const height = 4;
    const objectColor: [number, number, number] = [10, 20, 30];
    const objectIdRgba = new Uint8Array(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      // Pixel 0 stays background black; the rest belong to obj-a.
      if (pixel === 0) continue;
      objectIdRgba.set([...objectColor, 255], pixel * 4);
    }
    const maxMagnitudePx = getDirectorMotionMaxMagnitudePx(width, height, DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION);
    const camera = frontCamera();
    const result = composeDirectorMotionVectorPass({
      width,
      height,
      objectIdRgba,
      objectIdToRgb: { "obj-a": objectColor },
      vectors: [
        {
          objectId: "obj-a",
          fromPx: [0, 0],
          toPx: [maxMagnitudePx, 0],
          deltaPx: [maxMagnitudePx, 0],
        },
      ],
      fromFrame: 11,
      toFrame: 12,
      fromCamera: camera,
      toCamera: camera,
    });

    // Rightward motion at exactly the normalization ceiling: pure red.
    expect([...result.rgba.subarray(4, 8)]).toEqual([255, 0, 0, 255]);
    expect([...result.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(result.metadata).toMatchObject({
      renderPass: "motion",
      encoding: "motion-hsv-rgb",
      colorSpace: "data",
      rowOrder: "top-to-bottom",
      fromFrame: 11,
      toFrame: 12,
      normalization: {
        basis: "image-diagonal",
        fraction: DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION,
        maxMagnitudePx,
      },
    });
    expect(result.metadata.objectVectors).toHaveLength(1);
    expect(result.metadata.camera.from).toEqual(camera);
  });

  it("rejects an object-id buffer that does not match the raster", () => {
    expect(() =>
      composeDirectorMotionVectorPass({
        width: 4,
        height: 4,
        objectIdRgba: new Uint8Array(4),
        objectIdToRgb: {},
        vectors: [],
        fromFrame: 0,
        toFrame: 0,
        fromCamera: frontCamera(),
        toCamera: frontCamera(),
      }),
    ).toThrow(/object-id buffer/);
  });
});

describe("buildDirectorMotionVectorSidecar", () => {
  it("carries per-object vectors plus both frame camera poses", () => {
    const fromCamera = frontCamera();
    const toCamera = frontCamera({ position: [1, 0, 5], target: [1, 0, 0] });
    const vectors = computeDirectorObjectMotionVectors({
      width: WIDTH,
      height: HEIGHT,
      fromCamera,
      toCamera,
      fromAnchors: [{ objectId: "obj-a", position: [0, 0, 0] }],
      toAnchors: [{ objectId: "obj-a", position: [0, 0, 0] }],
    });
    const sidecar = buildDirectorMotionVectorSidecar({
      width: WIDTH,
      height: HEIGHT,
      fromFrame: 23,
      toFrame: 24,
      fromCamera,
      toCamera,
      vectors,
    });

    expect(sidecar.contract).toBe(DIRECTOR_MOTION_VECTORS_CONTRACT);
    expect(sidecar.fromFrame).toBe(23);
    expect(sidecar.toFrame).toBe(24);
    expect(sidecar.camera).toEqual({ from: fromCamera, to: toCamera });
    expect(sidecar.objects).toHaveLength(1);
    expect(sidecar.objects[0]!.objectId).toBe("obj-a");
    expect(sidecar.objects[0]!.deltaPx[0]).toBeCloseTo(-ONE_METRE_AT_5M_PX, 10);
    expect(sidecar.normalization.maxMagnitudePx).toBeCloseTo(
      Math.hypot(WIDTH, HEIGHT) * DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION,
      10,
    );
  });
});
