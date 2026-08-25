import {
  CubeCamera,
  LinearMipmapLinearFilter,
  Vector3,
  WebGLCubeRenderTarget,
  type CubeCameraRenderer,
  type CubeTexture,
  type Mesh,
  type Object3D,
} from "three";
import { claimDirectorPrimaryCompositeRenderPass, getDirectorRenderFrameKey } from "../../performance/renderBudget";

/**
 * Shared low-resolution environment probe for water and river surfaces.
 *
 * Water previously reflected only a procedural two-band sky, so nearby scene
 * content (buildings, fire, terrain) never appeared on calm water. This module
 * owns ONE `THREE.CubeCamera` + 128px mipmapped `WebGLCubeRenderTarget` that
 * every water/river material samples through `uEnvMap`/`uEnvBlend`.
 *
 * Lifecycle — `acquireWaterEnvProbe()` / `releaseWaterEnvProbe()` are
 * ref-counted: WaterLayer and RiverLayer surfaces share the same instance and
 * the cube target is disposed when the last surface unmounts. GL resources are
 * created lazily inside the first `handleBeforeRender` (which only ever runs
 * during a real GL pass), so jsdom tests never touch a context.
 *
 * Refresh policy — at most one refresh per displayed composite frame, and
 * only when the quantized world time advanced or its primary render camera
 * moved more than {@link WATER_ENV_PROBE_CAMERA_DELTA_M}. The decision is a
 * pure function of (last refresh mark, current frame input): no wall clocks,
 * no randomness, so a frame's pixels stay a pure function of project state +
 * frame. The refresh happens inside the same frame's render (before the water
 * draw), which keeps offscreen captures with temporary cameras deterministic
 * as well.
 *
 * Cost — a refresh renders the scene into 6 cube faces of
 * {@link WATER_ENV_PROBE_RESOLUTION}² pixels (6 × 128² ≈ 98k pixels plus one
 * mip chain). With the default {@link WATER_ENV_PROBE_TIME_QUANTUM_SECONDS}
 * that is 4 refreshes per second while world time animates, a single refresh
 * after a camera cut, and zero extra renders on idle demand-mode frames.
 * Steady-state per-frame CPU work stays plain uniform writes.
 *
 * While capturing, every registered surface is hidden via its `visible` flag
 * so the probe never captures the water itself; the outer pass is unaffected
 * because its render list was built before `onBeforeRender` fires (the same
 * pattern three's `Reflector` uses).
 */

/** Cube face edge in pixels; 6 faces are re-rendered per refresh. */
export const WATER_ENV_PROBE_RESOLUTION = 128;
/** World-time quantum; a refresh is due whenever `floor(t / quantum)` changes. */
export const WATER_ENV_PROBE_TIME_QUANTUM_SECONDS = 0.25;
/** Camera travel (metres) since the last refresh that forces a new capture. */
export const WATER_ENV_PROBE_CAMERA_DELTA_M = 2;
/** Probe height above the averaged water-surface centers (metres). */
export const WATER_ENV_PROBE_HEIGHT_OFFSET_M = 1.5;
/** `uEnvBlend` once the probe holds a capture; 0 keeps the procedural sky. */
export const WATER_ENV_BLEND_LIVE = 0.55;

const WATER_ENV_PROBE_NEAR_M = 0.1;
const WATER_ENV_PROBE_FAR_M = 2000;

/** Snapshot of the render state the refresh decision is evaluated against. */
export interface WaterEnvProbeRefreshInput {
  /** Director composite-frame key, or Three's render counter outside a composite. */
  renderFrame: number;
  /** Deterministic world clock (`LivingWorldFrameContext.worldSeconds`). */
  worldSeconds: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  cameraRefreshAllowed: boolean;
}

/** Bookkeeping stored after a successful refresh; `null` = never refreshed. */
export interface WaterEnvProbeRefreshMark {
  /** Stable frame key shared by the main, PIP, and quad-view camera passes. */
  renderFrame: number;
  quantizedWorldSeconds: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
}

/**
 * Quantizes world time into discrete refresh buckets so the probe advances at
 * most once per {@link WATER_ENV_PROBE_TIME_QUANTUM_SECONDS} while time animates.
 *
 * @param worldSeconds - Deterministic world clock value.
 * @returns The integer bucket index for the current time quantum.
 */
export function quantizeWaterEnvProbeWorldSeconds(worldSeconds: number): number {
  return Math.floor(worldSeconds / WATER_ENV_PROBE_TIME_QUANTUM_SECONDS);
}

/**
 * Pure refresh decision: refresh when the probe has never captured, else skip
 * within the same rendered frame, else refresh when the quantized world time
 * advanced or the camera moved more than the delta threshold since the last
 * capture. Strictly deterministic in its inputs.
 */
export function shouldRefreshWaterEnvProbe(
  last: WaterEnvProbeRefreshMark | null,
  input: WaterEnvProbeRefreshInput,
): boolean {
  if (last === null) return true;
  if (last.renderFrame === input.renderFrame) return false;
  if (quantizeWaterEnvProbeWorldSeconds(input.worldSeconds) !== last.quantizedWorldSeconds) return true;
  if (!input.cameraRefreshAllowed) return false;
  const deltaX = input.cameraX - last.cameraX;
  const deltaY = input.cameraY - last.cameraY;
  const deltaZ = input.cameraZ - last.cameraZ;
  const cameraDeltaSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
  return cameraDeltaSq > WATER_ENV_PROBE_CAMERA_DELTA_M * WATER_ENV_PROBE_CAMERA_DELTA_M;
}

/**
 * Captures the refresh state snapshot after a successful capture so subsequent
 * {@link shouldRefreshWaterEnvProbe} calls can compare against it.
 *
 * @param input - The render-state input that triggered this refresh.
 * @param renderFrameAfterRefresh - The frame key at the time of capture, stored
 *   so the same frame never re-triggers.
 * @returns A refresh mark to compare against future inputs.
 */
export function createWaterEnvProbeRefreshMark(
  input: WaterEnvProbeRefreshInput,
  renderFrameAfterRefresh: number,
): WaterEnvProbeRefreshMark {
  return {
    renderFrame: renderFrameAfterRefresh,
    quantizedWorldSeconds: quantizeWaterEnvProbeWorldSeconds(input.worldSeconds),
    cameraX: input.cameraX,
    cameraY: input.cameraY,
    cameraZ: input.cameraZ,
  };
}

const CENTER_SCRATCH = new Vector3();

/**
 * Representative capture point: the average of the visible registered
 * surfaces' world-space centers, raised by the height offset. Mesh centers
 * come from the geometry bounding sphere (computed lazily) so spline river
 * ribbons — whose mesh sits at the origin — contribute their true midpoint.
 * Returns false when no visible surface exists (nothing to reflect for).
 */
export function computeWaterEnvProbeAnchorInto(target: Vector3, surfaces: Iterable<Object3D>): boolean {
  let count = 0;
  target.set(0, 0, 0);
  for (const surface of surfaces) {
    if (!surface.visible) continue;
    const mesh = surface as Mesh;
    if (mesh.isMesh === true && mesh.geometry !== undefined) {
      if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere();
      CENTER_SCRATCH.copy(mesh.geometry.boundingSphere!.center);
    } else {
      CENTER_SCRATCH.set(0, 0, 0);
    }
    CENTER_SCRATCH.applyMatrix4(surface.matrixWorld);
    target.add(CENTER_SCRATCH);
    count += 1;
  }
  if (count === 0) return false;
  target.multiplyScalar(1 / count);
  target.y += WATER_ENV_PROBE_HEIGHT_OFFSET_M;
  return true;
}

/**
 * Minimal renderer surface the probe needs: everything `CubeCamera.update`
 * touches plus the monotonic frame counter. `WebGLRenderer` satisfies this
 * structurally; tests can substitute a pure fake.
 */
export interface WaterEnvProbeRenderer extends CubeCameraRenderer {
  info: { render: { frame: number } };
}

/**
 * Lifecycle-managed environment probe that captures a low-resolution cube map
 * of the scene for water and river reflections.
 *
 * Register every surface that should be hidden during captures (so the probe
 * never sees itself) through {@link registerSurface}; call {@link handleBeforeRender}
 * from every water/river mesh's `onBeforeRender`. The probe is ref-counted —
 * create with {@link createWaterEnvProbe} and dispose when done.
 */
export interface WaterEnvProbe {
  /** Adds a surface to hide during captures / average into the anchor; returns its unregister. */
  registerSurface(surface: Object3D): () => void;
  /**
   * Call from every water/river mesh's `onBeforeRender`. The first call of a
   * rendered frame refreshes the capture when the policy demands it; all other
   * calls are cheap guarded no-ops.
   */
  handleBeforeRender(renderer: WaterEnvProbeRenderer, scene: Object3D, camera: Object3D, worldSeconds: number): void;
  /** Cube texture to bind as `uEnvMap`; null until GL resources exist. */
  getTexture(): CubeTexture | null;
  /** `uEnvBlend` value: 0 before the first capture, {@link WATER_ENV_BLEND_LIVE} after. */
  getEnvBlend(): number;
  /** Whether the probe has been disposed; once true, all operations are no-ops. */
  isDisposed(): boolean;
  /** Releases the GL cube render target and clears all registered surfaces. */
  dispose(): void;
}

/**
 * Creates a standalone environment probe instance. GL resources are allocated
 * lazily on the first {@link WaterEnvProbe.handleBeforeRender} call so tests
 * and non-GL environments never touch a context.
 *
 * Callers should prefer {@link acquireWaterEnvProbe} for the shared ref-counted
 * singleton unless a separate probe is explicitly needed.
 */
export function createWaterEnvProbe(): WaterEnvProbe {
  const surfaces = new Set<Object3D>();
  const anchor = new Vector3();
  const savedVisibility: boolean[] = [];
  let lastMark: WaterEnvProbeRefreshMark | null = null;
  let runtime: { cubeCamera: CubeCamera; renderTarget: WebGLCubeRenderTarget } | null = null;
  let refreshing = false;
  let disposed = false;

  function ensureRuntime(): { cubeCamera: CubeCamera; renderTarget: WebGLCubeRenderTarget } {
    if (runtime === null) {
      const renderTarget = new WebGLCubeRenderTarget(WATER_ENV_PROBE_RESOLUTION, {
        generateMipmaps: true,
        minFilter: LinearMipmapLinearFilter,
      });
      renderTarget.texture.name = "director-water-env-probe";
      runtime = {
        cubeCamera: new CubeCamera(WATER_ENV_PROBE_NEAR_M, WATER_ENV_PROBE_FAR_M, renderTarget),
        renderTarget,
      };
    }
    return runtime;
  }

  return {
    registerSurface(surface: Object3D): () => void {
      surfaces.add(surface);
      return () => {
        surfaces.delete(surface);
      };
    },

    handleBeforeRender(renderer: WaterEnvProbeRenderer, scene: Object3D, camera: Object3D, worldSeconds: number): void {
      // `refreshing` also guards re-entrancy in case an unregistered water-like
      // object triggers this while the six cube faces render.
      if (disposed || refreshing) return;
      const cameraWorld = camera.matrixWorld.elements;
      const input: WaterEnvProbeRefreshInput = {
        renderFrame: getDirectorRenderFrameKey(renderer.info),
        worldSeconds,
        cameraX: cameraWorld[12],
        cameraY: cameraWorld[13],
        cameraZ: cameraWorld[14],
        cameraRefreshAllowed: claimDirectorPrimaryCompositeRenderPass(renderer.info),
      };
      if (!shouldRefreshWaterEnvProbe(lastMark, input)) return;
      if (!computeWaterEnvProbeAnchorInto(anchor, surfaces)) return;

      const { cubeCamera } = ensureRuntime();
      refreshing = true;
      savedVisibility.length = 0;
      for (const surface of surfaces) {
        savedVisibility.push(surface.visible);
        surface.visible = false;
      }
      try {
        cubeCamera.position.copy(anchor);
        cubeCamera.update(renderer, scene);
      } finally {
        let index = 0;
        for (const surface of surfaces) {
          surface.visible = savedVisibility[index];
          index += 1;
        }
        refreshing = false;
      }
      lastMark = createWaterEnvProbeRefreshMark(input, getDirectorRenderFrameKey(renderer.info));
    },

    getTexture(): CubeTexture | null {
      return runtime === null ? null : runtime.renderTarget.texture;
    },

    getEnvBlend(): number {
      return lastMark === null ? 0 : WATER_ENV_BLEND_LIVE;
    },

    isDisposed(): boolean {
      return disposed;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (runtime !== null) runtime.renderTarget.dispose();
      runtime = null;
      lastMark = null;
      surfaces.clear();
    },
  };
}

let sharedWaterEnvProbe: WaterEnvProbe | null = null;
let sharedWaterEnvProbeRefCount = 0;

/**
 * Ref-counted access to the module-wide shared probe. Every mounted water or
 * river surface acquires once and releases on unmount; the probe (and its GL
 * cube target) is disposed when the count returns to zero.
 */
export function acquireWaterEnvProbe(): WaterEnvProbe {
  if (sharedWaterEnvProbe === null || sharedWaterEnvProbe.isDisposed()) {
    sharedWaterEnvProbe = createWaterEnvProbe();
    sharedWaterEnvProbeRefCount = 0;
  }
  sharedWaterEnvProbeRefCount += 1;
  return sharedWaterEnvProbe;
}

/**
 * Releases one reference to the shared probe. When the count reaches zero the
 * probe (and its GL cube render target) is disposed.
 */
export function releaseWaterEnvProbe(): void {
  if (sharedWaterEnvProbe === null) return;
  sharedWaterEnvProbeRefCount -= 1;
  if (sharedWaterEnvProbeRefCount <= 0) {
    sharedWaterEnvProbe.dispose();
    sharedWaterEnvProbe = null;
    sharedWaterEnvProbeRefCount = 0;
  }
}
