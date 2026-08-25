import { describe, expect, it } from "vitest";
import {
  composeDirectorLineartPass,
  composeDirectorLineartRgba,
  decodeDirectorViewNormals,
  detectDirectorDepthEdges,
  detectDirectorNormalEdges,
  DIRECTOR_LINEART_DEFAULT_THRESHOLDS,
  unpackDirectorRgbaDepth,
} from "../../../../src/comprehensive/editor/render/lineartPassCapture";

/** Mirrors the three.js packDepthToRGBA shader (RGBADepthPacking). */
function packDepthToRgbaBytes(depth: number): [number, number, number, number] {
  const packFactors = [256 * 256 * 256, 256 * 256, 256] as const;
  const fract = (value: number) => value - Math.floor(value);
  const raw = [fract(depth * packFactors[0]), fract(depth * packFactors[1]), fract(depth * packFactors[2]), depth];
  const adjusted = [raw[0]!, raw[1]! - raw[0]! / 256, raw[2]! - raw[1]! / 256, raw[3]! - raw[2]! / 256];
  return adjusted.map((value) => Math.min(255, Math.max(0, Math.round(value * 256)))) as [
    number,
    number,
    number,
    number,
  ];
}

function buildDepthRgba(depths: number[][]): { rgba: Uint8Array; width: number; height: number } {
  const height = depths.length;
  const width = depths[0]!.length;
  const rgba = new Uint8Array(width * height * 4);
  depths.flat().forEach((depth, pixel) => {
    rgba.set(packDepthToRgbaBytes(depth), pixel * 4);
  });
  return { rgba, width, height };
}

function encodeNormalBytes([x, y, z]: [number, number, number]): [number, number, number, number] {
  const toByte = (component: number) => Math.round(((component + 1) / 2) * 255);
  return [toByte(x), toByte(y), toByte(z), 255];
}

function buildNormalRgba(normals: Array<Array<[number, number, number]>>): {
  rgba: Uint8Array;
  width: number;
  height: number;
} {
  const height = normals.length;
  const width = normals[0]!.length;
  const rgba = new Uint8Array(width * height * 4);
  normals.flat().forEach((normal, pixel) => {
    rgba.set(encodeNormalBytes(normal), pixel * 4);
  });
  return { rgba, width, height };
}

function grid<T>(width: number, height: number, fill: (x: number, y: number) => T): T[][] {
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => fill(x, y)));
}

const FLAT_NORMAL: [number, number, number] = [0, 0, 1];

describe("unpackDirectorRgbaDepth", () => {
  it("round-trips packed depth values within 8-bit packing precision", () => {
    const values = [0, 0.125, 0.5, 0.73, 0.999];
    const { rgba, width, height } = buildDepthRgba([values]);
    const depth = unpackDirectorRgbaDepth(rgba, width, height);
    values.forEach((value, index) => {
      expect(Math.abs(depth[index]! - value)).toBeLessThan(0.001);
    });
  });

  it("rejects buffers that do not match the raster", () => {
    expect(() => unpackDirectorRgbaDepth(new Uint8Array(8), 2, 2)).toThrow(/does not match/);
  });
});

describe("decodeDirectorViewNormals", () => {
  it("decodes encoded unit vectors", () => {
    const { rgba, width, height } = buildNormalRgba([[[1, 0, 0], [0, 0, 1]]]);
    const normals = decodeDirectorViewNormals(rgba, width, height);
    expect(normals[0]).toBeCloseTo(1, 1);
    expect(normals[5]).toBeCloseTo(1, 1);
  });
});

describe("detectDirectorDepthEdges", () => {
  it("finds no edges in a flat depth field", () => {
    const depth = new Float32Array(6 * 4).fill(0.5);
    const edges = detectDirectorDepthEdges(depth, 6, 4);
    expect(edges.every((value) => value === 0)).toBe(true);
  });

  it("marks a depth step as an edge", () => {
    const width = 8;
    const height = 4;
    const depth = new Float32Array(
      grid(width, height, (x) => (x < width / 2 ? 0.3 : 0.6)).flat(),
    );
    const edges = detectDirectorDepthEdges(depth, width, height);
    const row = Array.from(edges.slice(0, width));
    expect(row[3]).toBe(1);
    expect(row[4]).toBe(1);
    expect(row[0]).toBe(0);
    expect(row[width - 1]).toBe(0);
  });

  it("suppresses small far-field steps via the depth-adaptive threshold", () => {
    const width = 8;
    const height = 4;
    const stepField = (base: number) =>
      new Float32Array(grid(width, height, (x) => (x < width / 2 ? base : base + 0.01)).flat());
    // 0.01 step at depth ~0.95 stays under 0.005 * (1 + 5 * 0.95) ≈ 0.029.
    expect(detectDirectorDepthEdges(stepField(0.95), width, height).every((value) => value === 0)).toBe(true);
    // The same step near the camera exceeds 0.005 * (1 + 5 * 0.01) ≈ 0.00525.
    expect(detectDirectorDepthEdges(stepField(0.01), width, height).some((value) => value === 1)).toBe(true);
  });
});

describe("detectDirectorNormalEdges", () => {
  it("finds no edges on a constant normal field", () => {
    const { rgba, width, height } = buildNormalRgba(grid(6, 4, () => FLAT_NORMAL));
    const normals = decodeDirectorViewNormals(rgba, width, height);
    const edges = detectDirectorNormalEdges(normals, width, height);
    expect(edges.every((value) => value === 0)).toBe(true);
  });

  it("marks the crease where two faces meet", () => {
    const width = 8;
    const height = 4;
    const { rgba } = buildNormalRgba(grid(width, height, (x) => (x < width / 2 ? FLAT_NORMAL : [1, 0, 0])));
    const normals = decodeDirectorViewNormals(rgba, width, height);
    const edges = detectDirectorNormalEdges(normals, width, height);
    for (let y = 0; y < height; y += 1) {
      const row = Array.from(edges.slice(y * width, (y + 1) * width));
      expect(row[width / 2 - 1]).toBe(1);
      expect(row[0]).toBe(0);
      expect(row[width - 1]).toBe(0);
    }
  });
});

describe("composeDirectorLineartPass", () => {
  const width = 8;
  const height = 6;

  it("produces black output for flat depth and flat normals", () => {
    const depth = buildDepthRgba(grid(width, height, () => 0.5));
    const normal = buildNormalRgba(grid(width, height, () => FLAT_NORMAL));
    const result = composeDirectorLineartPass({
      depth: { rgba: depth.rgba, metadata: { width, height, encoding: "rgba-depth-packed" } },
      normal: { rgba: normal.rgba, metadata: { width, height, encoding: "view-normal-rgb" } },
    });
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      expect(result.rgba[pixel * 4]).toBe(0);
      expect(result.rgba[pixel * 4 + 3]).toBe(255);
    }
    expect(result.metadata).toMatchObject({
      renderPass: "lineart",
      width,
      height,
      pixelFormat: "rgba8",
      bitsPerChannel: 8,
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: "lineart-binary-rgb",
      helpersExcluded: true,
      thresholds: DIRECTOR_LINEART_DEFAULT_THRESHOLDS,
    });
  });

  it("draws white lines at depth steps and normal creases, strictly binary", () => {
    // Depth step at x = 4, normal crease at y = 3.
    const depth = buildDepthRgba(grid(width, height, (x) => (x < 4 ? 0.3 : 0.6)));
    const normal = buildNormalRgba(grid(width, height, (_x, y) => (y < 3 ? FLAT_NORMAL : [0, 1, 0])));
    const result = composeDirectorLineartPass({
      depth: { rgba: depth.rgba, metadata: { width, height, encoding: "rgba-depth-packed" } },
      normal: { rgba: normal.rgba, metadata: { width, height, encoding: "view-normal-rgb" } },
    });

    const pixel = (x: number, y: number) => result.rgba[(y * width + x) * 4]!;
    // Depth edge columns around the step.
    expect(pixel(3, 0)).toBe(255);
    expect(pixel(4, 0)).toBe(255);
    // Normal crease row above the fold.
    expect(pixel(0, 2)).toBe(255);
    expect(pixel(7, 2)).toBe(255);
    // Interior of flat regions stays black.
    expect(pixel(0, 0)).toBe(0);
    expect(pixel(7, 5)).toBe(0);

    for (let index = 0; index < result.rgba.length; index += 4) {
      const value = result.rgba[index]!;
      expect(value === 0 || value === 255).toBe(true);
      expect(result.rgba[index + 1]).toBe(value);
      expect(result.rgba[index + 2]).toBe(value);
      expect(result.rgba[index + 3]).toBe(255);
    }
  });

  it("rejects mismatched rasters and wrong encodings", () => {
    const depth = buildDepthRgba(grid(4, 4, () => 0.5));
    const normal = buildNormalRgba(grid(4, 4, () => FLAT_NORMAL));
    expect(() =>
      composeDirectorLineartPass({
        depth: { rgba: depth.rgba, metadata: { width: 4, height: 4, encoding: "color" } },
        normal: { rgba: normal.rgba, metadata: { width: 4, height: 4, encoding: "view-normal-rgb" } },
      }),
    ).toThrow(/rgba-depth-packed/);
    expect(() =>
      composeDirectorLineartPass({
        depth: { rgba: depth.rgba, metadata: { width: 4, height: 4, encoding: "rgba-depth-packed" } },
        normal: { rgba: normal.rgba, metadata: { width: 8, height: 2, encoding: "view-normal-rgb" } },
      }),
    ).toThrow(/does not match/);
  });
});

describe("composeDirectorLineartRgba", () => {
  it("unions both masks", () => {
    const depthEdges = Uint8Array.from([1, 0, 0, 0]);
    const normalEdges = Uint8Array.from([0, 0, 1, 0]);
    const rgba = composeDirectorLineartRgba(depthEdges, normalEdges, 2, 2);
    expect(Array.from(rgba)).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  });
});
