import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector4,
  WebGLRenderTarget,
  type ColorRepresentation,
  type WebGLRenderer,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { getVerticalFovFromFocalLength } from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import type { DirectorCameraShot } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  calculateDirectorCircleOfConfusionPixels,
  calculateDirectorDepthOfFieldMetrics,
  captureDirectorCinematicDepthFloat,
  captureDirectorCinematicRenderPass,
  createDirectorCinematicRenderSession,
} from "../../../../src/comprehensive/editor/render/cinematicOpticsCapture";

const cameraShot = {
  id: "camera-a",
  name: "Camera A",
  fov: getVerticalFovFromFocalLength(50, "16:9", "fullFrame"),
  focalLengthMm: 50,
  sensorFormat: "fullFrame",
  apertureFStop: 2,
  focusDistanceM: 5,
  nearClipM: 0.1,
  farClipM: 1_000,
  anamorphicSqueeze: 1.8,
  aspectRatio: "16:9",
  transform: { position: [0, 1, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  targetMode: "manual",
  target: [0, 1, 0],
} satisfies DirectorCameraShot;

function createRendererHarness(onRender?: (scene: Scene, call: number) => void) {
  const originalTarget = new WebGLRenderTarget(3, 3);
  let renderTarget: WebGLRenderTarget | null = originalTarget;
  let activeCubeFace = 3;
  let activeMipmapLevel = 2;
  const clearColor = new Color(0x123456);
  let clearAlpha = 0.4;
  let renderCalls = 0;
  const viewport = new Vector4(7, 8, 90, 60);
  const scissor = new Vector4(9, 10, 40, 30);
  let scissorTest = true;
  const renderer = {
    outputColorSpace: SRGBColorSpace,
    toneMapping: ACESFilmicToneMapping,
    toneMappingExposure: 1.7,
    autoClear: false,
    autoClearColor: false,
    autoClearDepth: false,
    autoClearStencil: false,
    getRenderTarget: vi.fn(() => renderTarget),
    getActiveCubeFace: vi.fn(() => activeCubeFace),
    getActiveMipmapLevel: vi.fn(() => activeMipmapLevel),
    setRenderTarget: vi.fn((next: WebGLRenderTarget | null, cubeFace = 0, mipmapLevel = 0) => {
      renderTarget = next;
      activeCubeFace = cubeFace;
      activeMipmapLevel = mipmapLevel;
    }),
    getClearColor: vi.fn((target: Color) => target.copy(clearColor)),
    getClearAlpha: vi.fn(() => clearAlpha),
    setClearColor: vi.fn((value: ColorRepresentation, alpha?: number) => {
      clearColor.set(value);
      if (alpha !== undefined) clearAlpha = alpha;
    }),
    getViewport: vi.fn((target: Vector4) => target.copy(viewport)),
    setViewport: vi.fn((value: Vector4 | number, y?: number, width?: number, height?: number) => {
      if (value instanceof Vector4) viewport.copy(value);
      else viewport.set(value, y!, width!, height!);
    }),
    getScissor: vi.fn((target: Vector4) => target.copy(scissor)),
    setScissor: vi.fn((value: Vector4 | number, y?: number, width?: number, height?: number) => {
      if (value instanceof Vector4) scissor.copy(value);
      else scissor.set(value, y!, width!, height!);
    }),
    getScissorTest: vi.fn(() => scissorTest),
    setScissorTest: vi.fn((value: boolean) => {
      scissorTest = value;
    }),
    clear: vi.fn(),
    render: vi.fn((scene: Scene) => {
      renderCalls += 1;
      onRender?.(scene, renderCalls);
    }),
    readRenderTargetPixels: vi.fn(
      (_target: WebGLRenderTarget, _x: number, _y: number, _width: number, _height: number, buffer: Uint8Array) => {
        buffer.fill(17);
      },
    ),
  } as unknown as WebGLRenderer;

  return {
    renderer,
    state: () => ({
      renderTarget,
      activeCubeFace,
      activeMipmapLevel,
      clearColor: clearColor.getHex(),
      clearAlpha,
      outputColorSpace: renderer.outputColorSpace,
      toneMapping: renderer.toneMapping,
      toneMappingExposure: renderer.toneMappingExposure,
      autoClear: renderer.autoClear,
      autoClearColor: renderer.autoClearColor,
      autoClearDepth: renderer.autoClearDepth,
      autoClearStencil: renderer.autoClearStencil,
      viewport: viewport.toArray(),
      scissor: scissor.toArray(),
      scissorTest,
    }),
  };
}

function createFixture() {
  const scene = new Scene();
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  scene.add(mesh);
  const helper = new Group();
  helper.userData.hideFromViewportCapture = true;
  helper.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  scene.add(helper);
  const camera = new PerspectiveCamera(cameraShot.fov, 16 / 9, 0.1, 1_000);
  camera.updateProjectionMatrix();
  return { scene, mesh, helper, camera };
}

describe("thin-lens depth-of-field metrics", () => {
  it("is sharp on the focus plane and responds physically to aperture and focal length", () => {
    const base = calculateDirectorDepthOfFieldMetrics(cameraShot);
    const focused = calculateDirectorCircleOfConfusionPixels(base, 5, 1_080);
    const foreground = calculateDirectorCircleOfConfusionPixels(base, 2, 1_080);
    const stoppedDown = calculateDirectorCircleOfConfusionPixels({ ...base, apertureFStop: 8 }, 2, 1_080);
    const longerLens = calculateDirectorCircleOfConfusionPixels({ ...base, focalLengthMm: 85 }, 2, 1_080);

    expect(focused).toBeCloseTo(0, 12);
    expect(foreground).toBeGreaterThan(0);
    expect(stoppedDown).toBeLessThan(foreground);
    expect(longerLens).toBeGreaterThan(foreground);
    expect(base.apertureDiameterMm).toBe(25);
  });
});

describe("captureDirectorCinematicRenderPass", () => {
  it("renders color+depth then DOF, hides helpers, applies squeeze, and restores all state", () => {
    const fixture = createFixture();
    const projectionBefore = [...fixture.camera.projectionMatrix.elements];
    const rendererHarness = createRendererHarness((_scene, call) => {
      if (call === 1) {
        expect(fixture.helper.visible).toBe(false);
        expect(fixture.camera.projectionMatrix.elements[0]).toBeLessThan(projectionBefore[0]!);
        expect(fixture.camera.projectionMatrix.elements[0] / fixture.camera.projectionMatrix.elements[5]).toBeCloseTo(
          1 / fixture.camera.aspect,
          10,
        );
      }
    });
    const rendererBefore = rendererHarness.state();

    const result = captureDirectorCinematicRenderPass({
      renderer: rendererHarness.renderer,
      scene: fixture.scene,
      camera: fixture.camera,
      cameraShot,
      renderPass: "clean",
      width: 4,
      height: 2,
      depthOfField: { quality: "high" },
    });

    expect(rendererHarness.renderer.render).toHaveBeenCalledTimes(2);
    expect(result.rgba).toHaveLength(4 * 2 * 4);
    expect(result.metadata.anamorphic).toMatchObject({ applied: true, squeeze: 1.8 });
    expect(result.metadata.depthOfField).toMatchObject({
      applied: true,
      quality: "high",
      sampleCount: 20,
      renderScale: 1,
      depthEncoding: "hardware-perspective-depth",
    });
    expect(fixture.helper.visible).toBe(true);
    expect(fixture.camera.projectionMatrix.elements).toEqual(projectionBefore);
    expect(rendererHarness.state()).toEqual(rendererBefore);
  });

  it("carries straight alpha through the transparent depth-of-field clean pass and hides dressing", () => {
    const fixture = createFixture();
    const owner = new Group();
    owner.userData.directorObjectId = "hero";
    const heroMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    owner.add(heroMesh);
    fixture.scene.add(owner);
    const originalBackground = new Color(0x223344);
    fixture.scene.background = originalBackground;
    const rendererHarness = createRendererHarness((scene, call) => {
      if (call === 1) {
        expect(scene.background).toBeNull();
        expect(rendererHarness.state().clearColor).toBe(0x000000);
        expect(rendererHarness.state().clearAlpha).toBe(0);
        // The untagged fixture mesh is environment dressing; authored
        // content and its helpers-free render stay visible.
        expect(fixture.mesh.visible).toBe(false);
        expect(heroMesh.visible).toBe(true);
        expect(fixture.helper.visible).toBe(false);
      }
    });
    const rendererBefore = rendererHarness.state();

    const result = captureDirectorCinematicRenderPass({
      renderer: rendererHarness.renderer,
      scene: fixture.scene,
      camera: fixture.camera,
      cameraShot,
      renderPass: "clean",
      width: 4,
      height: 2,
      depthOfField: { quality: "high" },
      background: "transparent",
    });

    expect(rendererHarness.renderer.render).toHaveBeenCalledTimes(2);
    expect(result.metadata.background).toBe("transparent");
    expect(result.metadata.depthOfField).toMatchObject({ applied: true, quality: "high" });
    // The harness readback fills every byte with 17: premultiplied
    // (17,17,17,17) un-premultiplies to pure white at coverage 17.
    expect([...result.rgba.subarray(0, 4)]).toEqual([255, 255, 255, 17]);
    expect(fixture.scene.background).toBe(originalBackground);
    expect(fixture.mesh.visible).toBe(true);
    expect(fixture.helper.visible).toBe(true);
    expect(rendererHarness.state()).toEqual(rendererBefore);
  });

  it("offers an explicit low-quality half-resolution path", () => {
    const fixture = createFixture();
    const harness = createRendererHarness();

    const result = captureDirectorCinematicRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera: fixture.camera,
      cameraShot,
      renderPass: "clean",
      width: 8,
      height: 4,
      depthOfField: { quality: "low" },
    });

    expect(result.metadata.depthOfField).toMatchObject({
      applied: true,
      quality: "low",
      sampleCount: 8,
      renderScale: 0.5,
      maxBlurPixels: 12,
    });
  });

  it("cleanly disables DOF and never applies it to technical passes", () => {
    const disabledFixture = createFixture();
    const disabledHarness = createRendererHarness();
    const disabled = captureDirectorCinematicRenderPass({
      renderer: disabledHarness.renderer,
      scene: disabledFixture.scene,
      camera: disabledFixture.camera,
      cameraShot,
      renderPass: "clean",
      width: 2,
      height: 2,
      depthOfField: { quality: "off" },
    });
    expect(disabledHarness.renderer.render).toHaveBeenCalledTimes(1);
    expect(disabled.metadata.depthOfField).toMatchObject({
      applied: false,
      requested: false,
      bypassReason: "disabled",
    });

    const technicalFixture = createFixture();
    const technicalHarness = createRendererHarness();
    const technical = captureDirectorCinematicRenderPass({
      renderer: technicalHarness.renderer,
      scene: technicalFixture.scene,
      camera: technicalFixture.camera,
      cameraShot,
      renderPass: "depth",
      width: 2,
      height: 2,
      depthOfField: { quality: "high" },
    });
    expect(technicalHarness.renderer.render).toHaveBeenCalledTimes(1);
    expect(technical.metadata.depthOfField).toMatchObject({
      applied: false,
      requested: true,
      bypassReason: "technical-pass",
    });
  });

  it("restores helper, renderer, scene, and projection state when the scene render throws", () => {
    const fixture = createFixture();
    const originalOverride = new MeshBasicMaterial({ color: 0xff00ff });
    fixture.scene.overrideMaterial = originalOverride;
    const projectionBefore = [...fixture.camera.projectionMatrix.elements];
    const harness = createRendererHarness(() => {
      throw new Error("GPU interrupted");
    });
    const rendererBefore = harness.state();

    expect(() =>
      captureDirectorCinematicRenderPass({
        renderer: harness.renderer,
        scene: fixture.scene,
        camera: fixture.camera,
        cameraShot,
        renderPass: "clean",
        width: 2,
        height: 2,
        depthOfField: { quality: "high" },
      }),
    ).toThrow("GPU interrupted");

    expect(fixture.helper.visible).toBe(true);
    expect(fixture.scene.overrideMaterial).toBe(originalOverride);
    expect(fixture.camera.projectionMatrix.elements).toEqual(projectionBefore);
    expect(harness.state()).toEqual(rendererBefore);
  });
});

describe("captureDirectorCinematicDepthFloat", () => {
  it("applies the scoped anamorphic squeeze to the float depth render and restores it", () => {
    const fixture = createFixture();
    const projectionBefore = [...fixture.camera.projectionMatrix.elements];
    const harness = createRendererHarness(() => {
      expect(fixture.camera.projectionMatrix.elements[0]).toBeLessThan(projectionBefore[0]!);
      expect(fixture.helper.visible).toBe(false);
    });
    const rendererBefore = harness.state();

    const result = captureDirectorCinematicDepthFloat({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera: fixture.camera,
      cameraShot,
      width: 4,
      height: 2,
    });

    // The harness readback fills every byte with 17; mirror unpack+linearize
    // (classic buffer: the harness renderer exposes no reversed capability).
    const windowDepth = (17 * 65_536 + 17 * 256 + 17 + 17 / 255) / 2 ** 24;
    const expected = (0.1 * 1_000) / (1_000 - windowDepth * (1_000 - 0.1));
    expect(result.depth).toHaveLength(8);
    expect(result.depth[0]).toBeCloseTo(expected, 6);
    expect(result.metadata.anamorphic).toMatchObject({ applied: true, squeeze: 1.8 });
    expect(result.metadata).toMatchObject({
      renderPass: "depth",
      pixelFormat: "float32",
      bitsPerChannel: 32,
      encoding: "linear-eye-depth",
      depthSemantics: {
        representation: "linear-eye-depth",
        projection: "perspective",
        background: "far-plane",
        reversedDepthBuffer: false,
      },
    });
    expect(fixture.camera.projectionMatrix.elements).toEqual(projectionBefore);
    expect(harness.state()).toEqual(rendererBefore);
  });
});

describe("createDirectorCinematicRenderSession", () => {
  it("reuses GPU targets across high/low/off frames and restores the live viewport", () => {
    const fixture = createFixture();
    const harness = createRendererHarness((_scene, call) => {
      if (call === 2 || call === 4) {
        expect(harness.state()).toMatchObject({
          viewport: [7, 8, 90, 60],
          scissor: [9, 10, 40, 30],
          scissorTest: true,
        });
      }
      expect(fixture.helper.visible).toBe(false);
    });
    const rendererBefore = harness.state();
    const targetResize = vi.spyOn(WebGLRenderTarget.prototype, "setSize");
    const session = createDirectorCinematicRenderSession({
      renderer: harness.renderer,
      scene: fixture.scene,
      width: 8,
      height: 4,
    });
    targetResize.mockClear();

    const high = session.renderToCurrentViewport({
      camera: fixture.camera,
      cameraShot,
      depthOfField: { quality: "high" },
    });
    const low = session.renderToCurrentViewport({
      camera: fixture.camera,
      cameraShot,
      depthOfField: { quality: "low" },
    });
    const off = session.renderToCurrentViewport({
      camera: fixture.camera,
      cameraShot,
      depthOfField: { quality: "off" },
    });

    expect(harness.renderer.render).toHaveBeenCalledTimes(5);
    expect(targetResize).not.toHaveBeenCalled();
    expect(high.depthOfField).toMatchObject({ applied: true, sampleCount: 20 });
    expect(low.depthOfField).toMatchObject({ applied: true, sampleCount: 8, renderScale: 0.5 });
    expect(off.depthOfField).toMatchObject({ applied: false, bypassReason: "disabled" });
    expect(fixture.helper.visible).toBe(true);
    expect(harness.state()).toEqual(rendererBefore);

    session.resize(10, 6);
    expect(targetResize).toHaveBeenCalledTimes(2);
    expect(session.width).toBe(10);
    expect(session.height).toBe(6);
    session.dispose();
    session.dispose();
    expect(() => session.renderToCurrentViewport({ camera: fixture.camera, cameraShot })).toThrow("has been disposed");
    targetResize.mockRestore();
  });

  it("renders to a matching caller target and rejects ambiguous output rasters", () => {
    const fixture = createFixture();
    const harness = createRendererHarness();
    const session = createDirectorCinematicRenderSession({
      renderer: harness.renderer,
      scene: fixture.scene,
      width: 4,
      height: 2,
    });
    const output = new WebGLRenderTarget(4, 2);
    const wrongOutput = new WebGLRenderTarget(3, 2);

    const metadata = session.renderToTarget(output, {
      camera: fixture.camera,
      cameraShot,
      depthOfField: { quality: "high" },
    });

    expect(metadata).toMatchObject({ output: "render-target", width: 4, height: 2, helpersExcluded: true });
    expect(() =>
      session.renderToTarget(wrongOutput, {
        camera: fixture.camera,
        cameraShot,
      }),
    ).toThrow("must match the session raster 4x2");
    session.dispose();
    output.dispose();
    wrongOutput.dispose();
  });

  it("restores live renderer, scene, helpers, and projection when a frame throws", () => {
    const fixture = createFixture();
    const projectionBefore = [...fixture.camera.projectionMatrix.elements];
    const harness = createRendererHarness(() => {
      throw new Error("live render failed");
    });
    const rendererBefore = harness.state();
    const session = createDirectorCinematicRenderSession({
      renderer: harness.renderer,
      scene: fixture.scene,
      width: 4,
      height: 2,
    });

    expect(() =>
      session.renderToCurrentViewport({
        camera: fixture.camera,
        cameraShot,
        depthOfField: { quality: "high" },
      }),
    ).toThrow("live render failed");
    expect(fixture.helper.visible).toBe(true);
    expect(fixture.camera.projectionMatrix.elements).toEqual(projectionBefore);
    expect(harness.state()).toEqual(rendererBefore);
    session.dispose();
  });
});
