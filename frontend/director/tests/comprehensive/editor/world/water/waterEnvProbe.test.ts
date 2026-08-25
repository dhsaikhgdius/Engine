import { describe, expect, it } from "vitest";
import {
  LinearMipmapLinearFilter,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLCoordinateSystem,
} from "three";
import {
  WATER_ENV_BLEND_LIVE,
  WATER_ENV_PROBE_CAMERA_DELTA_M,
  WATER_ENV_PROBE_HEIGHT_OFFSET_M,
  WATER_ENV_PROBE_TIME_QUANTUM_SECONDS,
  acquireWaterEnvProbe,
  computeWaterEnvProbeAnchorInto,
  createWaterEnvProbe,
  createWaterEnvProbeRefreshMark,
  quantizeWaterEnvProbeWorldSeconds,
  releaseWaterEnvProbe,
  shouldRefreshWaterEnvProbe,
  type WaterEnvProbeRefreshInput,
  type WaterEnvProbeRenderer,
} from "../../../../../src/comprehensive/editor/world/water/waterEnvProbe";
import { beginDirectorCompositeRendererInfoPass } from "../../../../../src/comprehensive/editor/performance/renderBudget";

function createRefreshInput(overrides: Partial<WaterEnvProbeRefreshInput> = {}): WaterEnvProbeRefreshInput {
  return {
    renderFrame: 10,
    worldSeconds: 1,
    cameraX: 0,
    cameraY: 5,
    cameraZ: 20,
    cameraRefreshAllowed: true,
    ...overrides,
  };
}

/**
 * Pure stand-in for WebGLRenderer covering exactly what the probe touches:
 * the CubeCamera.update surface plus the monotonic frame counter. Mirrors the
 * real renderer by advancing `info.render.frame` on every render() call, so
 * the six nested cube-face renders bump the counter like they do live.
 */
interface FakeRenderer extends WaterEnvProbeRenderer {
  info: WaterEnvProbeRenderer["info"] & {
    autoReset: boolean;
    reset: () => void;
  };
  renderCalls: number;
  reversedDepthBuffer: boolean;
  /** Simulates the outer pass start (WebGLRenderer.render advances the counter). */
  beginFrame(): void;
}

function createFakeRenderer(onFaceRender?: () => void): FakeRenderer {
  const fake: FakeRenderer = {
    renderCalls: 0,
    reversedDepthBuffer: false,
    coordinateSystem: WebGLCoordinateSystem,
    info: { autoReset: true, render: { frame: 0 }, reset: () => {} },
    xr: { enabled: false },
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget: () => {},
    render: () => {
      fake.info.render.frame += 1;
      fake.renderCalls += 1;
      onFaceRender?.();
    },
    beginFrame: () => {
      fake.info.render.frame += 1;
    },
  };
  return fake;
}

function createSurfaceMesh(position: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(new PlaneGeometry(10, 10));
  mesh.position.set(position[0], position[1], position[2]);
  mesh.updateMatrixWorld();
  return mesh;
}

function createViewCamera(x = 0, y = 5, z = 20): PerspectiveCamera {
  const camera = new PerspectiveCamera();
  camera.position.set(x, y, z);
  camera.updateMatrixWorld();
  return camera;
}

describe("env probe refresh policy", () => {
  it("quantizes world seconds onto the refresh quantum", () => {
    expect(quantizeWaterEnvProbeWorldSeconds(0)).toBe(0);
    expect(quantizeWaterEnvProbeWorldSeconds(WATER_ENV_PROBE_TIME_QUANTUM_SECONDS * 0.999)).toBe(0);
    expect(quantizeWaterEnvProbeWorldSeconds(WATER_ENV_PROBE_TIME_QUANTUM_SECONDS)).toBe(1);
    expect(quantizeWaterEnvProbeWorldSeconds(WATER_ENV_PROBE_TIME_QUANTUM_SECONDS * 3)).toBe(3);
  });

  it("always refreshes before the first capture", () => {
    expect(shouldRefreshWaterEnvProbe(null, createRefreshInput())).toBe(true);
  });

  it("refreshes at most once per rendered frame regardless of other changes", () => {
    const mark = createWaterEnvProbeRefreshMark(createRefreshInput(), 16);
    const sameFrame = createRefreshInput({ renderFrame: 16, worldSeconds: 99, cameraX: 100 });
    expect(shouldRefreshWaterEnvProbe(mark, sameFrame)).toBe(false);
  });

  it("refreshes when the quantized world time advances", () => {
    const mark = createWaterEnvProbeRefreshMark(createRefreshInput(), 16);
    const withinQuantum = createRefreshInput({
      renderFrame: 17,
      worldSeconds: 1 + WATER_ENV_PROBE_TIME_QUANTUM_SECONDS * 0.5,
    });
    const pastQuantum = createRefreshInput({ renderFrame: 17, worldSeconds: 1 + WATER_ENV_PROBE_TIME_QUANTUM_SECONDS });
    expect(shouldRefreshWaterEnvProbe(mark, withinQuantum)).toBe(false);
    expect(shouldRefreshWaterEnvProbe(mark, pastQuantum)).toBe(true);
  });

  it("refreshes only when the camera moves strictly beyond the delta threshold", () => {
    const mark = createWaterEnvProbeRefreshMark(createRefreshInput(), 16);
    const atThreshold = createRefreshInput({ renderFrame: 17, cameraX: WATER_ENV_PROBE_CAMERA_DELTA_M });
    const beyondThreshold = createRefreshInput({ renderFrame: 17, cameraX: WATER_ENV_PROBE_CAMERA_DELTA_M + 0.01 });
    const diagonal = createRefreshInput({ renderFrame: 17, cameraX: 1.5, cameraY: 5 + 1.5 });
    expect(shouldRefreshWaterEnvProbe(mark, atThreshold)).toBe(false);
    expect(shouldRefreshWaterEnvProbe(mark, beyondThreshold)).toBe(true);
    expect(shouldRefreshWaterEnvProbe(mark, diagonal)).toBe(true);
    expect(shouldRefreshWaterEnvProbe(mark, { ...beyondThreshold, cameraRefreshAllowed: false })).toBe(false);
  });

  it("stores the post-refresh frame and quantized time in the mark", () => {
    const mark = createWaterEnvProbeRefreshMark(createRefreshInput({ worldSeconds: 0.9 }), 42);
    expect(mark.renderFrame).toBe(42);
    expect(mark.quantizedWorldSeconds).toBe(quantizeWaterEnvProbeWorldSeconds(0.9));
    expect(mark.cameraX).toBe(0);
    expect(mark.cameraY).toBe(5);
    expect(mark.cameraZ).toBe(20);
  });
});

describe("env probe anchor", () => {
  it("averages visible surface centers and raises the anchor", () => {
    const target = new Vector3();
    const meshA = createSurfaceMesh([0, 1, 0]);
    const meshB = createSurfaceMesh([10, 3, 20]);
    expect(computeWaterEnvProbeAnchorInto(target, [meshA, meshB])).toBe(true);
    expect(target.x).toBeCloseTo(5, 10);
    expect(target.y).toBeCloseTo(2 + WATER_ENV_PROBE_HEIGHT_OFFSET_M, 10);
    expect(target.z).toBeCloseTo(10, 10);
  });

  it("uses the geometry bounding-sphere center for origin-anchored ribbons", () => {
    const geometry = new PlaneGeometry(4, 4);
    geometry.translate(8, 0, -12);
    const mesh = new Mesh(geometry);
    mesh.updateMatrixWorld();
    const target = new Vector3();
    expect(computeWaterEnvProbeAnchorInto(target, [mesh])).toBe(true);
    expect(target.x).toBeCloseTo(8, 10);
    expect(target.y).toBeCloseTo(WATER_ENV_PROBE_HEIGHT_OFFSET_M, 10);
    expect(target.z).toBeCloseTo(-12, 10);
  });

  it("ignores invisible surfaces and reports when none contribute", () => {
    const hidden = createSurfaceMesh([5, 0, 5]);
    hidden.visible = false;
    const target = new Vector3();
    expect(computeWaterEnvProbeAnchorInto(target, [hidden])).toBe(false);
    expect(computeWaterEnvProbeAnchorInto(target, [])).toBe(false);
  });
});

describe("env probe capture flow", () => {
  it("stays procedural before the first capture", () => {
    const probe = createWaterEnvProbe();
    expect(probe.getTexture()).toBeNull();
    expect(probe.getEnvBlend()).toBe(0);
    probe.dispose();
  });

  it("captures six faces, hiding registered surfaces only during the capture", () => {
    const probe = createWaterEnvProbe();
    const mesh = createSurfaceMesh([4, 0.2, -6]);
    const visibilityDuringCapture: boolean[] = [];
    const renderer = createFakeRenderer(() => visibilityDuringCapture.push(mesh.visible));
    probe.registerSurface(mesh);

    renderer.beginFrame();
    probe.handleBeforeRender(renderer, new Scene(), createViewCamera(), 0);

    expect(renderer.renderCalls).toBe(6);
    expect(visibilityDuringCapture).toEqual([false, false, false, false, false, false]);
    expect(mesh.visible).toBe(true);
    expect(probe.getEnvBlend()).toBe(WATER_ENV_BLEND_LIVE);
    expect(probe.getTexture()).not.toBeNull();
    expect(probe.getTexture()!.generateMipmaps).toBe(true);
    expect(probe.getTexture()!.minFilter).toBe(LinearMipmapLinearFilter);
    probe.dispose();
  });

  it("guards sibling surfaces in the same outer frame after the nested renders", () => {
    const probe = createWaterEnvProbe();
    const renderer = createFakeRenderer();
    const scene = new Scene();
    const camera = createViewCamera();
    probe.registerSurface(createSurfaceMesh([0, 0, 0]));

    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, camera, 0);
    expect(renderer.renderCalls).toBe(6);
    // Second surface of the same pass: the six face renders advanced the frame
    // counter, but the mark stored the post-refresh value, so this is a no-op.
    probe.handleBeforeRender(renderer, scene, camera, 0);
    expect(renderer.renderCalls).toBe(6);
    probe.dispose();
  });

  it("captures only once when a composite frame renders through two cameras", () => {
    const probe = createWaterEnvProbe();
    const renderer = createFakeRenderer();
    const scene = new Scene();
    const editorCamera = createViewCamera();
    const previewCamera = createViewCamera(100, 20, -80);
    probe.registerSurface(createSurfaceMesh([0, 0, 0]));

    const restore = beginDirectorCompositeRendererInfoPass(renderer.info);
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, editorCamera, 0);
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, previewCamera, 0);

    expect(renderer.renderCalls).toBe(6);
    restore();

    const restoreNextFrame = beginDirectorCompositeRendererInfoPass(renderer.info);
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, editorCamera, 0);
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, previewCamera, 0);

    expect(renderer.renderCalls).toBe(6);
    restoreNextFrame();
    probe.dispose();
  });

  it("skips static frames, then refreshes on quantized time or camera travel", () => {
    const probe = createWaterEnvProbe();
    const renderer = createFakeRenderer();
    const scene = new Scene();
    const camera = createViewCamera();
    probe.registerSurface(createSurfaceMesh([0, 0, 0]));

    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, camera, 0);
    expect(renderer.renderCalls).toBe(6);
    const capturedTexture = probe.getTexture();

    // Same quantum, camera still: an idle demand-mode frame costs nothing.
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, camera, WATER_ENV_PROBE_TIME_QUANTUM_SECONDS * 0.4);
    expect(renderer.renderCalls).toBe(6);

    // World time crossed the quantum: refresh into the SAME texture object.
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, camera, WATER_ENV_PROBE_TIME_QUANTUM_SECONDS);
    expect(renderer.renderCalls).toBe(12);
    expect(probe.getTexture()).toBe(capturedTexture);

    // Camera moved exactly the threshold: not strictly beyond, no refresh.
    camera.position.x += WATER_ENV_PROBE_CAMERA_DELTA_M;
    camera.updateMatrixWorld();
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, camera, WATER_ENV_PROBE_TIME_QUANTUM_SECONDS);
    expect(renderer.renderCalls).toBe(12);

    // Camera clearly beyond the threshold since the last capture: refresh.
    camera.position.x += 0.5;
    camera.updateMatrixWorld();
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, camera, WATER_ENV_PROBE_TIME_QUANTUM_SECONDS);
    expect(renderer.renderCalls).toBe(18);
    probe.dispose();
  });

  it("does nothing without a registered visible surface", () => {
    const probe = createWaterEnvProbe();
    const renderer = createFakeRenderer();
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, new Scene(), createViewCamera(), 0);
    expect(renderer.renderCalls).toBe(0);
    expect(probe.getEnvBlend()).toBe(0);
    probe.dispose();
  });

  it("stops refreshing after the last surface unregisters or the probe disposes", () => {
    const probe = createWaterEnvProbe();
    const renderer = createFakeRenderer();
    const scene = new Scene();
    const camera = createViewCamera();
    const unregister = probe.registerSurface(createSurfaceMesh([0, 0, 0]));

    unregister();
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, camera, 0);
    expect(renderer.renderCalls).toBe(0);

    probe.registerSurface(createSurfaceMesh([0, 0, 0]));
    probe.dispose();
    expect(probe.isDisposed()).toBe(true);
    renderer.beginFrame();
    probe.handleBeforeRender(renderer, scene, camera, WATER_ENV_PROBE_TIME_QUANTUM_SECONDS * 5);
    expect(renderer.renderCalls).toBe(0);
    expect(probe.getEnvBlend()).toBe(0);
  });
});

describe("shared probe lifecycle", () => {
  it("publishes the live blend constant the materials rely on", () => {
    expect(WATER_ENV_BLEND_LIVE).toBeCloseTo(0.55, 10);
  });

  it("shares one instance across acquires and disposes with the last release", () => {
    const first = acquireWaterEnvProbe();
    const second = acquireWaterEnvProbe();
    expect(second).toBe(first);

    releaseWaterEnvProbe();
    expect(first.isDisposed()).toBe(false);
    releaseWaterEnvProbe();
    expect(first.isDisposed()).toBe(true);

    const third = acquireWaterEnvProbe();
    expect(third).not.toBe(first);
    expect(third.isDisposed()).toBe(false);
    releaseWaterEnvProbe();
    expect(third.isDisposed()).toBe(true);
  });
});
