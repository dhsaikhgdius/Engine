import { describe, expect, it, vi } from "vitest";
import {
  BoxGeometry,
  Camera,
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  WebGLRenderTarget,
  type ColorRepresentation,
  type WebGLRenderer,
} from "three";
import { captureDirectorDepthFloat, linearizeDirectorWindowDepth, unpackDirectorRgbaDepth } from "../../../../src/comprehensive/editor/render/depthFloatCapture";

/** Mirror of three.js r18x packDepthToRGBA at byte level (RGB integer, A sub-LSB fraction). */
function packDepthBytes(depth: number): [number, number, number, number] {
  if (depth <= 0) return [0, 0, 0, 0];
  if (depth >= 1) return [255, 255, 255, 255];
  const scaled = depth * 2 ** 24;
  const integer = Math.floor(scaled);
  return [(integer >>> 16) & 0xff, (integer >>> 8) & 0xff, integer & 0xff, Math.round((scaled - integer) * 255)];
}

/** Forward window depth from a positive eye distance (inverse of the capture linearization). */
function windowDepthFromEye(
  eye: number,
  near: number,
  far: number,
  projection: "perspective" | "orthographic",
  reversed: boolean,
): number {
  if (projection === "orthographic") {
    return reversed ? (far - eye) / (far - near) : (eye - near) / (far - near);
  }
  return reversed ? (near * (far - eye)) / (eye * (far - near)) : (far * (eye - near)) / (eye * (far - near));
}

function createRendererHarness({
  reversedDepthBuffer,
  onRead,
  onRender,
}: {
  reversedDepthBuffer?: boolean;
  onRead?: (buffer: Uint8Array) => void;
  onRender?: () => void;
} = {}) {
  const originalTarget = new WebGLRenderTarget(3, 3);
  let renderTarget: WebGLRenderTarget | null = originalTarget;
  const clearColor = new Color(0x123456);
  let clearAlpha = 0.65;

  const renderer = {
    outputColorSpace: "srgb",
    toneMapping: 4,
    toneMappingExposure: 1.7,
    autoClear: false,
    autoClearColor: false,
    autoClearDepth: false,
    autoClearStencil: false,
    ...(reversedDepthBuffer === undefined ? {} : { capabilities: { reversedDepthBuffer } }),
    getRenderTarget: vi.fn(() => renderTarget),
    getActiveCubeFace: vi.fn(() => 0),
    getActiveMipmapLevel: vi.fn(() => 0),
    setRenderTarget: vi.fn((next: WebGLRenderTarget | null) => {
      renderTarget = next;
    }),
    getClearColor: vi.fn((target: Color) => target.copy(clearColor)),
    getClearAlpha: vi.fn(() => clearAlpha),
    setClearColor: vi.fn((value: ColorRepresentation, alpha?: number) => {
      clearColor.set(value);
      if (alpha !== undefined) clearAlpha = alpha;
    }),
    clear: vi.fn(),
    render: vi.fn(() => onRender?.()),
    readRenderTargetPixels: vi.fn(
      (_target: WebGLRenderTarget, _x: number, _y: number, _width: number, _height: number, buffer: Uint8Array) =>
        onRead?.(buffer),
    ),
  } as unknown as WebGLRenderer;

  return {
    renderer,
    state: () => ({ clearColor: clearColor.getHex(), clearAlpha, renderTarget }),
  };
}

function createScene() {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return scene;
}

describe("unpackDirectorRgbaDepth", () => {
  it("decodes the packed fixed-point exactly at both ends and in between", () => {
    const rgba = new Uint8Array([
      ...packDepthBytes(0),
      ...packDepthBytes(1),
      ...packDepthBytes(0.5),
      ...packDepthBytes(0.123456),
    ]);
    const depth = unpackDirectorRgbaDepth(rgba, 2, 2);
    expect(depth[0]).toBe(0);
    expect(depth[1]).toBe(1);
    expect(depth[2]).toBe(0.5);
    expect(depth[3]).toBeCloseTo(0.123456, 8);
  });

  it("rejects buffers that do not match the raster", () => {
    expect(() => unpackDirectorRgbaDepth(new Uint8Array(15), 2, 2)).toThrow("must contain 16 bytes; received 15");
  });
});

describe("linearizeDirectorWindowDepth", () => {
  it("maps window depth endpoints onto the exact clip planes in all four modes", () => {
    const endpoints = new Float32Array([0, 1]);
    expect([
      ...linearizeDirectorWindowDepth(endpoints, {
        projection: "perspective",
        nearM: 0.1,
        farM: 100,
        reversedDepthBuffer: false,
      }),
    ]).toEqual([Math.fround(0.1), 100]);
    expect([
      ...linearizeDirectorWindowDepth(endpoints, {
        projection: "perspective",
        nearM: 0.1,
        farM: 100,
        reversedDepthBuffer: true,
      }),
    ]).toEqual([100, Math.fround(0.1)]);
    expect([
      ...linearizeDirectorWindowDepth(endpoints, {
        projection: "orthographic",
        nearM: 2,
        farM: 12,
        reversedDepthBuffer: false,
      }),
    ]).toEqual([2, 12]);
    expect([
      ...linearizeDirectorWindowDepth(endpoints, {
        projection: "orthographic",
        nearM: 2,
        farM: 12,
        reversedDepthBuffer: true,
      }),
    ]).toEqual([12, 2]);
  });

  it("rejects invalid clip ranges", () => {
    const depth = new Float32Array([0.5]);
    expect(() =>
      linearizeDirectorWindowDepth(depth, {
        projection: "perspective",
        nearM: 0,
        farM: 10,
        reversedDepthBuffer: false,
      }),
    ).toThrow("0 < near < far");
    expect(() =>
      linearizeDirectorWindowDepth(depth, { projection: "perspective", nearM: 5, farM: 5, reversedDepthBuffer: false }),
    ).toThrow("0 < near < far");
  });
});

describe("captureDirectorDepthFloat", () => {
  it("linearizes reversed-depth packed pixels to eye metres and keeps empty pixels on the far plane", () => {
    const near = 0.1;
    const far = 100;
    const camera = new PerspectiveCamera(50, 1, near, far);
    const eyeTop = [near, 2.5];
    const eyeBottomLeft = 97.3;
    const topRow = eyeTop.flatMap((eye) => packDepthBytes(windowDepthFromEye(eye, near, far, "perspective", true)));
    const bottomRow = [
      ...packDepthBytes(windowDepthFromEye(eyeBottomLeft, near, far, "perspective", true)),
      ...packDepthBytes(0), // cleared background byte pattern under a reversed depth buffer
    ];
    let clearDuringRender: { color: number; alpha: number } | null = null;
    const harness = createRendererHarness({
      reversedDepthBuffer: true,
      onRender: () => {
        clearDuringRender = { color: harness.state().clearColor, alpha: harness.state().clearAlpha };
      },
      onRead: (buffer) => {
        // WebGL readback starts at the bottom row.
        buffer.set([...bottomRow, ...topRow]);
      },
    });
    const stateBefore = harness.state();

    const result = captureDirectorDepthFloat({
      renderer: harness.renderer,
      scene: createScene(),
      camera,
      width: 2,
      height: 2,
    });

    expect(clearDuringRender).toEqual({ color: 0x000000, alpha: 0 });
    expect(result.depth[0]).toBe(Math.fround(near)); // packed one decodes to exactly the near plane
    expect(result.depth[1]).toBeCloseTo(2.5, 3);
    expect(result.depth[2]).toBeCloseTo(97.3, 2);
    expect(result.depth[3]).toBe(far); // empty pixel resolves to exactly the far plane
    expect(harness.state()).toEqual(stateBefore);
    expect(result.metadata).toEqual({
      renderPass: "depth",
      width: 2,
      height: 2,
      pixelFormat: "float32",
      bitsPerChannel: 32,
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: "linear-eye-depth",
      helpersExcluded: true,
      depthSemantics: {
        representation: "linear-eye-depth",
        units: "metres",
        axis: "camera-forward",
        background: "far-plane",
        projection: "perspective",
        nearM: near,
        farM: far,
        reversedDepthBuffer: true,
        source: "rgba-packed-window-depth",
      },
    });
  });

  it("clears classic depth buffers to packed one so empty pixels still land on the far plane", () => {
    const near = 0.5;
    const far = 50;
    const camera = new PerspectiveCamera(50, 1, near, far);
    let clearDuringRender: { color: number; alpha: number } | null = null;
    const harness = createRendererHarness({
      onRender: () => {
        clearDuringRender = { color: harness.state().clearColor, alpha: harness.state().clearAlpha };
      },
      onRead: (buffer) => {
        buffer.set([
          ...packDepthBytes(windowDepthFromEye(7, near, far, "perspective", false)),
          ...packDepthBytes(1), // white clear = classic-buffer background
        ]);
      },
    });
    const stateBefore = harness.state();

    const result = captureDirectorDepthFloat({
      renderer: harness.renderer,
      scene: createScene(),
      camera,
      width: 2,
      height: 1,
    });

    expect(clearDuringRender).toEqual({ color: 0xffffff, alpha: 1 });
    expect(result.depth[0]).toBeCloseTo(7, 3);
    expect(result.depth[1]).toBe(far);
    expect(result.metadata.depthSemantics.reversedDepthBuffer).toBe(false);
    expect(harness.state()).toEqual(stateBefore);
  });

  it("linearizes orthographic cameras with the orthographic transfer function", () => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 2, 12);
    const harness = createRendererHarness({
      reversedDepthBuffer: true,
      onRead: (buffer) => {
        buffer.set([...packDepthBytes(windowDepthFromEye(5, 2, 12, "orthographic", true)), ...packDepthBytes(0)]);
      },
    });

    const result = captureDirectorDepthFloat({
      renderer: harness.renderer,
      scene: createScene(),
      camera,
      width: 2,
      height: 1,
    });

    expect(result.depth[0]).toBeCloseTo(5, 4);
    expect(result.depth[1]).toBe(12);
    expect(result.metadata.depthSemantics).toMatchObject({ projection: "orthographic", nearM: 2, farM: 12 });
  });

  it("validates the camera and clip range before touching the renderer", () => {
    const renderer = {} as WebGLRenderer;
    const scene = createScene();
    expect(() => captureDirectorDepthFloat({ renderer, scene, camera: new Camera(), width: 2, height: 2 })).toThrow(
      "perspective or orthographic camera",
    );
    const badNear = new PerspectiveCamera(50, 1, 0.1, 100);
    badNear.near = 0;
    expect(() => captureDirectorDepthFloat({ renderer, scene, camera: badNear, width: 2, height: 2 })).toThrow(
      "0 < near < far",
    );
    const inverted = new PerspectiveCamera(50, 1, 10, 1);
    expect(() => captureDirectorDepthFloat({ renderer, scene, camera: inverted, width: 2, height: 2 })).toThrow(
      "0 < near < far",
    );
    expect(() =>
      captureDirectorDepthFloat({
        renderer,
        scene,
        camera: new PerspectiveCamera(50, 1, 0.1, 100),
        width: 0,
        height: 2,
      }),
    ).toThrow("Render width must be an integer");
  });
});
