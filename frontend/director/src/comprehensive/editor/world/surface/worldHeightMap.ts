import {
  Color,
  DataTexture,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type IUniform,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";

/**
 * Camera-centred top-down height map for rain occlusion and water shoreline.
 *
 * AC4-style: a small ortho capture looking straight down around the render
 * camera. Rain drops whose world Y sits under an occluder (roof, eave) fade
 * out; water fragments near a bank pick up extra foam. Packed into 8-bit
 * RGBA so the target is universally sampleable; unpack is linear in
 * {@link WORLD_HEIGHT_MAP_Y_MIN}..{@link WORLD_HEIGHT_MAP_Y_MAX}.
 *
 * Each render camera owns a small cached target, so the editor, PIP, quad
 * views, and captures never overwrite one another. A camera refreshes only
 * when quantized world time advances or that camera moves. Nested
 * `renderer.render` is guarded so the height pass cannot recurse into itself
 * via a water/rain onBeforeRender.
 *
 * The ortho camera looks down −Y with `up = (0, 0, −1)` so look-at is not
 * degenerate. UV mapping of a world XZ point is therefore:
 * `u = (x − origin.x) / size + 0.5`, `v = 0.5 − (z − origin.z) / size`.
 */

/** Width and height of the orthographic height-map render target in pixels. */
export const WORLD_HEIGHT_MAP_RESOLUTION = 128;
/** Side length of the orthographic capture frustum in world metres. */
export const WORLD_HEIGHT_MAP_SIZE_M = 48;
/** Distance the ortho camera sits above the render camera (metres). */
export const WORLD_HEIGHT_MAP_ABOVE_CAMERA_M = 36;
/** Distance the ortho camera looks below the render camera (metres). */
export const WORLD_HEIGHT_MAP_BELOW_CAMERA_M = 24;
/** Minimum world Y that the height map can represent. */
export const WORLD_HEIGHT_MAP_Y_MIN = -20;
/** Maximum world Y that the height map can represent. */
export const WORLD_HEIGHT_MAP_Y_MAX = 80;
/** Minimum time between height-map refreshes in world seconds. */
export const WORLD_HEIGHT_MAP_TIME_QUANTUM_SECONDS = 0.25;
/** Camera must move more than this distance (metres) to trigger a refresh. */
export const WORLD_HEIGHT_MAP_CAMERA_DELTA_M = 1.5;
/** Drops this far under an occluder (metres) are treated as covered. */
export const WORLD_RAIN_OCCLUSION_CLEARANCE_M = 0.12;

const HEIGHT_SPAN = WORLD_HEIGHT_MAP_Y_MAX - WORLD_HEIGHT_MAP_Y_MIN;

const LIVING_WORLD_NAME_MARKER = "living-world-";
const HEIGHT_MAP_SKIP_NAME =
  /transformcontrols|viewport-ground-grid|panorama-backdrop|camera-frustum|frame-trajectory-overlay|drop-preview/i;

/**
 * Packs a world-space Y coordinate into the [0, 1] range for the height-map
 * render target, clamping to the configured min/max.
 *
 * @param y - World-space Y coordinate.
 * @returns Normalised height in [0, 1].
 */
export function packWorldHeight(y: number): number {
  return Math.min(1, Math.max(0, (y - WORLD_HEIGHT_MAP_Y_MIN) / HEIGHT_SPAN));
}

/**
 * Unpacks a normalised height value back to world-space Y.
 *
 * @param packed - Normalised height in [0, 1].
 * @returns World-space Y coordinate.
 */
export function unpackWorldHeight(packed: number): number {
  return packed * HEIGHT_SPAN + WORLD_HEIGHT_MAP_Y_MIN;
}

/**
 * Computes UV coordinates for sampling the height map from a world XZ position.
 * Maps `origin` to the texture centre and `size` to the full texture extent.
 *
 * @param worldX - World-space X of the sample point.
 * @param worldZ - World-space Z of the sample point.
 * @param originX - World-space X of the height-map origin.
 * @param originZ - World-space Z of the height-map origin.
 * @param size - World-space side length of the height-map capture.
 * @returns UV coordinates in [0, 1]².
 */
export function worldHeightMapUv(
  worldX: number,
  worldZ: number,
  originX: number,
  originZ: number,
  size: number,
): { u: number; v: number } {
  return {
    u: (worldX - originX) / size + 0.5,
    v: 0.5 - (worldZ - originZ) / size,
  };
}

/** GLSL helpers shared by rain fragments and water shoreline. */
export const WORLD_HEIGHT_MAP_SAMPLE_GLSL = /* glsl */ `
vec2 directorWorldHeightMapUv(vec3 worldPos, vec3 origin, float size) {
  return vec2((worldPos.x - origin.x) / size + 0.5, 0.5 - (worldPos.z - origin.z) / size);
}
float directorWorldUnpackHeight(float packed) {
  return packed * ${HEIGHT_SPAN.toFixed(1)} + ${WORLD_HEIGHT_MAP_Y_MIN.toFixed(1)};
}
`;

/** Groups that must stay out of the height pass (particles, sky, water, herds). */
export function isWorldHeightMapOverlayName(name: string): boolean {
  return (
    name.includes(LIVING_WORLD_NAME_MARKER) ||
    name.startsWith("director-living-world-water") ||
    name.startsWith("director-water-") ||
    name.startsWith("world-effect-")
  );
}

/**
 * Returns true when an object should be hidden during the height-map capture
 * pass — overlays, water, particles, herds, and editor controls.
 *
 * @param object - The three.js Object3D to check.
 * @returns Whether the object should be excluded from the height map.
 */
export function shouldHideObjectFromWorldHeightMap(object: Object3D): boolean {
  return isWorldHeightMapOverlayName(object.name) || HEIGHT_MAP_SKIP_NAME.test(object.name);
}

/** Input data that drives a height-map refresh decision. */
export interface WorldHeightMapRefreshInput {
  /** Current renderer frame number. */
  renderFrame: number;
  /** Current world time in seconds. */
  worldSeconds: number;
  /** Render camera world X. */
  cameraX: number;
  /** Render camera world Y. */
  cameraY: number;
  /** Render camera world Z. */
  cameraZ: number;
}

/** Snapshot of the last height-map refresh state for dirty-checking. */
export interface WorldHeightMapRefreshMark {
  /** Renderer frame number when the last refresh completed. */
  renderFrame: number;
  /** Quantized world time at the last refresh. */
  quantizedWorldSeconds: number;
  /** Camera world X at the last refresh. */
  cameraX: number;
  /** Camera world Y at the last refresh. */
  cameraY: number;
  /** Camera world Z at the last refresh. */
  cameraZ: number;
}

/**
 * Quantizes world seconds by the time quantum so minor time drift
 * does not trigger unnecessary height-map refreshes.
 *
 * @param worldSeconds - Current world time in seconds.
 * @returns Quantized world time bucket.
 */
export function quantizeWorldHeightMapWorldSeconds(worldSeconds: number): number {
  return Math.floor(worldSeconds / WORLD_HEIGHT_MAP_TIME_QUANTUM_SECONDS);
}

/**
 * Determines whether the height map needs a refresh based on time, frame,
 * and camera movement deltas.
 *
 * @param last - The previous refresh mark, or null if never refreshed.
 * @param input - The current refresh input state.
 * @returns true if a refresh is needed.
 */
export function shouldRefreshWorldHeightMap(
  last: WorldHeightMapRefreshMark | null,
  input: WorldHeightMapRefreshInput,
): boolean {
  if (last === null) return true;
  if (last.renderFrame === input.renderFrame) return false;
  if (quantizeWorldHeightMapWorldSeconds(input.worldSeconds) !== last.quantizedWorldSeconds) return true;
  const dx = input.cameraX - last.cameraX;
  const dy = input.cameraY - last.cameraY;
  const dz = input.cameraZ - last.cameraZ;
  return dx * dx + dy * dy + dz * dz > WORLD_HEIGHT_MAP_CAMERA_DELTA_M * WORLD_HEIGHT_MAP_CAMERA_DELTA_M;
}

/**
 * Creates a refresh mark snapshot from the current input, recording the frame
 * after the refresh completes so the next check skips the same frame.
 *
 * @param input - The refresh input that triggered this capture.
 * @param renderFrameAfterRefresh - The renderer frame after the capture pass.
 * @returns A new refresh mark to compare against on the next frame.
 */
export function createWorldHeightMapRefreshMark(
  input: WorldHeightMapRefreshInput,
  renderFrameAfterRefresh: number,
): WorldHeightMapRefreshMark {
  return {
    renderFrame: renderFrameAfterRefresh,
    quantizedWorldSeconds: quantizeWorldHeightMapWorldSeconds(input.worldSeconds),
    cameraX: input.cameraX,
    cameraY: input.cameraY,
    cameraZ: input.cameraZ,
  };
}

/** Uniforms injected into shaders that sample the height map for rain occlusion and water shoreline. */
export interface WorldHeightMapSampleUniforms {
  /** The height-map texture; falls back to a 1×1 black dummy when unavailable. */
  uOcclusionMap: IUniform<Texture | null>;
  /** World-space origin of the height-map capture frustum. */
  uOcclusionOrigin: IUniform<Vector3>;
  /** World-space side length of the height-map capture. */
  uOcclusionSize: IUniform<number>;
  /** Blend factor for cross-fading the height map in/out. */
  uOcclusionBlend: IUniform<number>;
}

let dummyTexture: DataTexture | null = null;

/** 1×1 black fallback so shaders can always bind a sampler. */
export function getWorldHeightMapDummyTexture(): DataTexture {
  if (dummyTexture === null) {
    dummyTexture = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    dummyTexture.needsUpdate = true;
    dummyTexture.name = "director-world-height-map-dummy";
  }
  return dummyTexture;
}

/**
 * Binds a height-map instance into the given uniform block, or falls back to
 * the 1×1 dummy texture with blend at 0 when the map is unavailable.
 *
 * @param uniforms - The uniform block to write into.
 * @param map - The current height map, or null.
 */
export function bindWorldHeightMapUniforms(uniforms: WorldHeightMapSampleUniforms, map: WorldHeightMap | null): void {
  const texture = map?.getTexture() ?? null;
  if (map && texture && map.getBlend() > 0) {
    uniforms.uOcclusionMap.value = texture;
    map.getOrigin(uniforms.uOcclusionOrigin.value);
    uniforms.uOcclusionSize.value = map.getSize();
    uniforms.uOcclusionBlend.value = map.getBlend();
    return;
  }
  uniforms.uOcclusionMap.value = getWorldHeightMapDummyTexture();
  uniforms.uOcclusionBlend.value = 0;
}

/** Creates a fresh uniform block for height-map sampling, initialised with safe defaults. */
export function createWorldHeightMapSampleUniforms(): WorldHeightMapSampleUniforms {
  return {
    uOcclusionMap: { value: getWorldHeightMapDummyTexture() },
    uOcclusionOrigin: { value: new Vector3() },
    uOcclusionSize: { value: WORLD_HEIGHT_MAP_SIZE_M },
    uOcclusionBlend: { value: 0 },
  };
}

function createHeightOverrideMaterial(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    fog: false,
    toneMapped: false,
  });
  material.name = "Director_LivingWorld_HeightMap";
  material.onBeforeCompile = (parameters) => {
    parameters.vertexShader = injectWorldHeightMapVertexShader(parameters.vertexShader);
    parameters.fragmentShader = WORLD_HEIGHT_MAP_FRAGMENT_SHADER;
  };
  material.customProgramCacheKey = () => "director-world-height-map-v1";
  return material;
}

/** Pure string transform so tests can pin ShaderLib.basic anchors. */
export function injectWorldHeightMapVertexShader(vertexShader: string): string {
  return vertexShader.replace("#include <common>", "#include <common>\nvarying float vWorldY;").replace(
    "#include <project_vertex>",
    `#include <project_vertex>
vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;
#ifdef USE_INSTANCING
vWorldY = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).y;
#endif
#ifdef USE_BATCHING
vWorldY = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).y;
#endif
`,
  );
}

/** Fragment shader that writes packed world-space height into the RGB channels. */
export const WORLD_HEIGHT_MAP_FRAGMENT_SHADER = /* glsl */ `
varying float vWorldY;
void main() {
  float packed = clamp((vWorldY - (${WORLD_HEIGHT_MAP_Y_MIN.toFixed(1)})) / ${HEIGHT_SPAN.toFixed(1)}, 0.0, 1.0);
  gl_FragColor = vec4(packed, packed, packed, 1.0);
}
`;

/**
 * Per-scene height-map resource that captures top-down geometry height
 * around the render camera for rain occlusion and water shoreline effects.
 *
 * Each camera gets its own cached view; the map refreshes lazily based on
 * time and camera movement deltas.
 */
export interface WorldHeightMap {
  /**
   * Called before the main render pass; decides whether to refresh the
   * height map for the given camera and world time.
   */
  handleBeforeRender(renderer: WebGLRenderer, scene: Scene, camera: Camera, worldSeconds: number): void;
  /** Returns the current height-map texture, or null if not yet captured. */
  getTexture(): Texture | null;
  /** Returns the blend factor (0 or 1) for cross-fading the map. */
  getBlend(): number;
  /** Writes the world-space origin of the current capture into the target vector. */
  getOrigin(target: Vector3): Vector3;
  /** Returns the world-space side length of the capture frustum. */
  getSize(): number;
  /** Returns true after dispose() has been called. */
  isDisposed(): boolean;
  /** Releases all GPU resources and marks this instance as disposed. */
  dispose(): void;
}

interface HeightMapRuntime {
  target: WebGLRenderTarget;
  ortho: OrthographicCamera;
  material: Material;
}

interface HeightMapViewState {
  origin: Vector3;
  lastMark: WorldHeightMapRefreshMark | null;
  runtime: HeightMapRuntime | null;
}

const CAMERA_SCRATCH = new Vector3();
const CLEAR_COLOR = new Color(0x000000);

let shared: WorldHeightMap | null = null;
let retainCount = 0;

/**
 * Acquires a reference to the shared height-map singleton, creating it
 * lazily or re-creating it if the previous instance was disposed.
 * Callers must pair every acquire with a {@link releaseWorldHeightMap}.
 *
 * @returns The shared height-map instance.
 */
export function acquireWorldHeightMap(): WorldHeightMap {
  if (shared === null || shared.isDisposed()) shared = createWorldHeightMap();
  retainCount += 1;
  return shared;
}

/**
 * Releases one reference to the shared height map. When the reference count
 * reaches zero the singleton is disposed and its GPU resources freed.
 */
export function releaseWorldHeightMap(): void {
  retainCount = Math.max(0, retainCount - 1);
  if (retainCount === 0 && shared !== null) {
    shared.dispose();
    shared = null;
  }
}

/**
 * Creates a new height-map instance with per-camera cached views.
 *
 * Each camera gets its own WeakMap entry so the editor, PIP, quad views,
 * and captures never overwrite one another. The capture pass re-uses a
 * single override material and hides overlay objects during capture.
 *
 * Prefer {@link acquireWorldHeightMap} for the shared singleton.
 */
export function createWorldHeightMap(): WorldHeightMap {
  const views = new WeakMap<Camera, HeightMapViewState>();
  const runtimes = new Set<HeightMapRuntime>();
  let activeView: HeightMapViewState | null = null;
  let refreshing = false;
  let disposed = false;

  function getView(camera: Camera): HeightMapViewState {
    let view = views.get(camera);
    if (view === undefined) {
      view = { origin: new Vector3(), lastMark: null, runtime: null };
      views.set(camera, view);
    }
    return view;
  }

  function ensureRuntime(view: HeightMapViewState): HeightMapRuntime {
    if (view.runtime === null) {
      const half = WORLD_HEIGHT_MAP_SIZE_M * 0.5;
      const ortho = new OrthographicCamera(-half, half, half, -half, 0.5, 200);
      ortho.name = "director-world-height-map-camera";
      // Looking straight down, default up=(0,1,0) is parallel to the look
      // axis and three's lookAt orthonormalization collapses. −Z up maps
      // camera +X → world +X and camera +Y → world −Z (see worldHeightMapUv).
      ortho.up.set(0, 0, -1);
      view.runtime = {
        target: new WebGLRenderTarget(WORLD_HEIGHT_MAP_RESOLUTION, WORLD_HEIGHT_MAP_RESOLUTION, {
          format: RGBAFormat,
          type: UnsignedByteType,
          magFilter: NearestFilter,
          minFilter: NearestFilter,
          generateMipmaps: false,
          depthBuffer: true,
          stencilBuffer: false,
        }),
        ortho,
        material: createHeightOverrideMaterial(),
      };
      view.runtime.target.texture.name = "director-world-height-map";
      view.runtime.target.texture.generateMipmaps = false;
      view.runtime.target.texture.flipY = false;
      runtimes.add(view.runtime);
    }
    return view.runtime;
  }

  return {
    handleBeforeRender(renderer, scene, camera, worldSeconds) {
      if (disposed || refreshing) return;
      const view = getView(camera);
      activeView = view;
      CAMERA_SCRATCH.setFromMatrixPosition(camera.matrixWorld);
      const input: WorldHeightMapRefreshInput = {
        renderFrame: renderer.info.render.frame,
        worldSeconds,
        cameraX: CAMERA_SCRATCH.x,
        cameraY: CAMERA_SCRATCH.y,
        cameraZ: CAMERA_SCRATCH.z,
      };
      if (!shouldRefreshWorldHeightMap(view.lastMark, input)) return;

      const { target, ortho, material } = ensureRuntime(view);
      view.origin.set(CAMERA_SCRATCH.x, CAMERA_SCRATCH.y, CAMERA_SCRATCH.z);
      ortho.position.set(CAMERA_SCRATCH.x, CAMERA_SCRATCH.y + WORLD_HEIGHT_MAP_ABOVE_CAMERA_M, CAMERA_SCRATCH.z);
      ortho.up.set(0, 0, -1);
      ortho.lookAt(CAMERA_SCRATCH.x, CAMERA_SCRATCH.y, CAMERA_SCRATCH.z);
      ortho.near = 0.5;
      ortho.far = WORLD_HEIGHT_MAP_ABOVE_CAMERA_M + WORLD_HEIGHT_MAP_BELOW_CAMERA_M;
      ortho.updateProjectionMatrix();
      ortho.updateMatrixWorld(true);

      const hidden: Object3D[] = [];
      scene.traverse((object) => {
        if (object.visible && shouldHideObjectFromWorldHeightMap(object)) {
          object.visible = false;
          hidden.push(object);
        }
      });

      const previousOverride = scene.overrideMaterial;
      const previousTarget = renderer.getRenderTarget();
      const previousAutoClear = renderer.autoClear;
      renderer.getClearColor(CLEAR_COLOR);
      const previousAlpha = renderer.getClearAlpha();

      refreshing = true;
      scene.overrideMaterial = material;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = true;
      renderer.render(scene, ortho);
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(CLEAR_COLOR, previousAlpha);
      renderer.autoClear = previousAutoClear;
      scene.overrideMaterial = previousOverride;
      refreshing = false;

      for (const object of hidden) object.visible = true;

      view.lastMark = createWorldHeightMapRefreshMark(input, renderer.info.render.frame);
    },

    getTexture() {
      return activeView?.runtime?.target.texture ?? null;
    },

    getBlend() {
      return activeView?.lastMark === null || activeView === null ? 0 : 1;
    },

    getOrigin(target: Vector3) {
      return activeView === null ? target.set(0, 0, 0) : target.copy(activeView.origin);
    },

    getSize() {
      return WORLD_HEIGHT_MAP_SIZE_M;
    },

    isDisposed() {
      return disposed;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      activeView = null;
      for (const runtime of runtimes) {
        runtime.target.dispose();
        runtime.material.dispose();
      }
      runtimes.clear();
    },
  };
}
