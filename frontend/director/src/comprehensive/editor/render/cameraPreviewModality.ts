import {
  Box3,
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshNormalMaterial,
  NoBlending,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";
import {
  DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION,
  getDirectorMotionMaxMagnitudePx,
} from "./motionVectorPass";
import {
  captureDirectorObjectBatchColorState,
  clearDirectorObjectBatchColors,
  getDirectorObjectBatchCount,
  isDirectorObjectBatchMesh,
  replaceDirectorObjectBatchColors,
  restoreDirectorObjectBatchColors,
  type DirectorObjectBatchColorState,
} from "../canvas/directorObjectBatch";
import { createDirectorObjectIdColorMap } from "./renderPassCapture";

/**
 * Render modality for the live camera monitor (picture-in-picture inset).
 * - "previz": blocking-stage clay (warm character clay, cool environment clay).
 * - "rgb": authored materials, exactly what a final-color render would show.
 * - "depth": normalized inverse depth (bright = near), MiDaS/ControlNet-style.
 * - "normal": view-space normals as RGB.
 * - "objectid": instance segmentation, one stable color per directorObjectId.
 * - "mask": binary matte, tagged objects white on black.
 * - "motion": optical-flow HSV (hue = screen direction, brightness = magnitude).
 * - "wireframe": light triangle wireframe over a dark background.
 */
export const DIRECTOR_CAMERA_PREVIEW_MODES = [
  "previz",
  "rgb",
  "depth",
  "normal",
  "objectid",
  "mask",
  "motion",
  "wireframe",
] as const;

export type DirectorCameraPreviewMode = (typeof DIRECTOR_CAMERA_PREVIEW_MODES)[number];

/** Type guard that narrows an unknown value to a known camera preview mode. */
export function isDirectorCameraPreviewMode(value: unknown): value is DirectorCameraPreviewMode {
  return DIRECTOR_CAMERA_PREVIEW_MODES.includes(value as DirectorCameraPreviewMode);
}

/**
 * Fallback depth normalization bounds for empty scenes. Populated scenes get a
 * range fitted to the visible set via getDirectorCameraPreviewDepthRange, so
 * the grayscale ramp stays readable for close-ups and aerials alike.
 */
export const DIRECTOR_DEPTH_PREVIEW_NEAR_M = 1;
export const DIRECTOR_DEPTH_PREVIEW_FAR_M = 60;

/** Near and far depth-normalization bounds for the depth preview mode. */
export interface DirectorCameraPreviewDepthRange {
  /** Distance in metres mapped to white (closest). */
  nearM: number;
  /** Distance in metres mapped to black (farthest). */
  farM: number;
}

/** Union of the given objects' world bounds, or null when there is nothing. */
export function computeDirectorCameraPreviewSceneBounds(objects: ReadonlyArray<Object3D>): Box3 | null {
  if (!objects.length) return null;
  const bounds = new Box3();
  for (const object of objects) bounds.expandByObject(object);
  return bounds.isEmpty() ? null : bounds;
}

const rangeCorner = new Vector3();

/**
 * Fits the depth ramp to the distances actually present in shot: white at the
 * nearest visible set geometry, black at the farthest. Relative normalization
 * mirrors how AI depth maps (MiDaS-style) are scaled per image.
 *
 * Corners are projected onto the view direction so geometry behind the camera
 * never inflates the far bound — otherwise long axial shots inside a large set
 * would compress the whole visible corridor into a few bright values.
 */
export function getDirectorCameraPreviewDepthRange(
  cameraPosition: Vector3,
  viewDirection: Vector3,
  sceneBounds: Box3 | null,
): DirectorCameraPreviewDepthRange {
  if (!sceneBounds || sceneBounds.isEmpty()) {
    return { nearM: DIRECTOR_DEPTH_PREVIEW_NEAR_M, farM: DIRECTOR_DEPTH_PREVIEW_FAR_M };
  }
  let nearAlongView = Number.POSITIVE_INFINITY;
  let farAlongView = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    rangeCorner.set(
      (corner & 1) === 0 ? sceneBounds.min.x : sceneBounds.max.x,
      (corner & 2) === 0 ? sceneBounds.min.y : sceneBounds.max.y,
      (corner & 4) === 0 ? sceneBounds.min.z : sceneBounds.max.z,
    );
    const depthAlongView = rangeCorner.sub(cameraPosition).dot(viewDirection);
    if (depthAlongView <= 0) continue;
    nearAlongView = Math.min(nearAlongView, depthAlongView);
    farAlongView = Math.max(farAlongView, depthAlongView);
  }
  if (!Number.isFinite(nearAlongView) || farAlongView <= 0.1) {
    return { nearM: DIRECTOR_DEPTH_PREVIEW_NEAR_M, farM: DIRECTOR_DEPTH_PREVIEW_FAR_M };
  }
  // Inside the set (or box corners partially behind) the closest visible
  // surface can sit right next to the lens, not at the nearest box corner.
  const nearM = sceneBounds.containsPoint(cameraPosition)
    ? Math.min(1, nearAlongView)
    : Math.max(0.1, Math.min(nearAlongView, sceneBounds.distanceToPoint(cameraPosition)));
  const farM = farAlongView;
  if (!(farM > nearM + 0.001)) return { nearM: Math.max(0.1, nearM - 0.5), farM: nearM + 1 };
  return { nearM, farM };
}

const depthVizMaterial = new ShaderMaterial({
  name: "Director_CameraPreview_DepthViz",
  blending: NoBlending,
  side: DoubleSide,
  uniforms: {
    uDepthNear: { value: DIRECTOR_DEPTH_PREVIEW_NEAR_M },
    uDepthFar: { value: DIRECTOR_DEPTH_PREVIEW_FAR_M },
  },
  // The skinning/morph chunks keep animated Mixamo characters correct while
  // this material overrides the whole scene.
  vertexShader: /* glsl */ `
    #include <common>
    #include <batching_pars_vertex>
    #include <skinning_pars_vertex>
    #include <morphtarget_pars_vertex>

    varying float vDirectorViewDepth;

    void main() {
      #include <skinbase_vertex>
      #include <begin_vertex>
      #include <batching_vertex>
      #include <morphtarget_vertex>
      #include <skinning_vertex>
      #include <project_vertex>
      vDirectorViewDepth = -mvPosition.z;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uDepthNear;
    uniform float uDepthFar;

    varying float vDirectorViewDepth;

    void main() {
      float value = clamp((uDepthFar - vDirectorViewDepth) / max(uDepthFar - uDepthNear, 1e-4), 0.0, 1.0);
      gl_FragColor = vec4(vec3(value), 1.0);
    }
  `,
});

const normalVizMaterial = new MeshNormalMaterial({
  blending: NoBlending,
  flatShading: false,
  side: DoubleSide,
});
normalVizMaterial.name = "Director_CameraPreview_NormalViz";
normalVizMaterial.toneMapped = false;

const wireframeVizMaterial = new MeshBasicMaterial({
  color: 0xd8dce3,
  fog: false,
  toneMapped: false,
  wireframe: true,
});
wireframeVizMaterial.name = "Director_CameraPreview_WireframeViz";

const previousViewMatrix = new Matrix4();
const previousProjectionMatrix = new Matrix4();
let previousWorldByObject = new WeakMap<Object3D, Matrix4>();
let motionHistoryReady = false;

const motionVizMaterial = new ShaderMaterial({
  name: "Director_CameraPreview_MotionViz",
  blending: NoBlending,
  side: DoubleSide,
  toneMapped: false,
  uniforms: {
    uPreviousViewMatrix: { value: new Matrix4() },
    uPreviousProjectionMatrix: { value: new Matrix4() },
    uPreviousModelMatrix: { value: new Matrix4() },
    uResolution: { value: new Vector2(1, 1) },
    uMaxMagnitudePx: { value: 1 },
  },
  vertexShader: /* glsl */ `
    #include <common>
    #include <batching_pars_vertex>
    #include <skinning_pars_vertex>
    #include <morphtarget_pars_vertex>

    uniform mat4 uPreviousViewMatrix;
    uniform mat4 uPreviousProjectionMatrix;
    uniform mat4 uPreviousModelMatrix;

    varying vec4 vDirectorCurrentClip;
    varying vec4 vDirectorPreviousClip;

    void main() {
      #include <skinbase_vertex>
      #include <begin_vertex>
      #include <batching_vertex>
      #include <morphtarget_vertex>
      #include <skinning_vertex>
      #include <project_vertex>
      vDirectorCurrentClip = gl_Position;
      vec4 previousLocal = vec4(transformed, 1.0);
      #ifdef USE_BATCHING
        previousLocal = batchingMatrix * previousLocal;
      #endif
      #ifdef USE_INSTANCING
        previousLocal = instanceMatrix * previousLocal;
      #endif
      vDirectorPreviousClip = uPreviousProjectionMatrix * uPreviousViewMatrix * uPreviousModelMatrix * previousLocal;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec2 uResolution;
    uniform float uMaxMagnitudePx;

    varying vec4 vDirectorCurrentClip;
    varying vec4 vDirectorPreviousClip;

    vec3 directorMotionHsvRgb(vec2 deltaPx, float maxMagnitudePx) {
      float magnitude = length(deltaPx);
      if (magnitude <= 0.0) return vec3(0.0);
      float hue = atan(deltaPx.y, deltaPx.x) * 180.0 / 3.141592653589793;
      hue = mod(mod(hue, 360.0) + 360.0, 360.0);
      float value = min(1.0, magnitude / max(maxMagnitudePx, 1e-4));
      float chroma = value;
      float secondary = chroma * (1.0 - abs(mod(hue / 60.0, 2.0) - 1.0));
      float sector = floor(hue / 60.0);
      vec3 rgb = sector < 1.0
        ? vec3(chroma, secondary, 0.0)
        : sector < 2.0
          ? vec3(secondary, chroma, 0.0)
          : sector < 3.0
            ? vec3(0.0, chroma, secondary)
            : sector < 4.0
              ? vec3(0.0, secondary, chroma)
              : sector < 5.0
                ? vec3(secondary, 0.0, chroma)
                : vec3(chroma, 0.0, secondary);
      return rgb + (value - chroma);
    }

    void main() {
      if (vDirectorCurrentClip.w <= 1e-6 || vDirectorPreviousClip.w <= 1e-6) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      vec2 currentNdc = vDirectorCurrentClip.xy / vDirectorCurrentClip.w;
      vec2 previousNdc = vDirectorPreviousClip.xy / vDirectorPreviousClip.w;
      vec2 currentPx = vec2(
        (currentNdc.x * 0.5 + 0.5) * uResolution.x,
        (1.0 - (currentNdc.y * 0.5 + 0.5)) * uResolution.y
      );
      vec2 previousPx = vec2(
        (previousNdc.x * 0.5 + 0.5) * uResolution.x,
        (1.0 - (previousNdc.y * 0.5 + 0.5)) * uResolution.y
      );
      gl_FragColor = vec4(directorMotionHsvRgb(currentPx - previousPx, uMaxMagnitudePx), 1.0);
    }
  `,
});
motionVizMaterial.onBeforeRender = (_renderer, _scene, _camera, _geometry, object) => {
  const previous = previousWorldByObject.get(object);
  motionVizMaterial.uniforms.uPreviousModelMatrix.value.copy(previous ?? object.matrixWorld);
};

/** Discards all accumulated per-object world-matrix history so the next frame starts a fresh pair. */
export function resetDirectorCameraPreviewMotionHistory() {
  previousWorldByObject = new WeakMap();
  motionHistoryReady = false;
}

/**
 * Uploads the current camera state and motion-normalization uniforms to the
 * motion-viz material. On the first frame of a new history window the previous
 * camera matrices are seeded from the current frame so the first pair produces
 * zero flow.
 */
export function updateDirectorCameraPreviewMotionUniforms(
  camera: { matrixWorldInverse: Matrix4; projectionMatrix: Matrix4 },
  width: number,
  height: number,
) {
  motionVizMaterial.uniforms.uResolution.value.set(Math.max(1, width), Math.max(1, height));
  motionVizMaterial.uniforms.uMaxMagnitudePx.value = getDirectorMotionMaxMagnitudePx(
    Math.max(1, width),
    Math.max(1, height),
    DIRECTOR_MOTION_MAGNITUDE_DIAGONAL_FRACTION,
  );
  if (!motionHistoryReady) {
    previousViewMatrix.copy(camera.matrixWorldInverse);
    previousProjectionMatrix.copy(camera.projectionMatrix);
  }
  motionVizMaterial.uniforms.uPreviousViewMatrix.value.copy(previousViewMatrix);
  motionVizMaterial.uniforms.uPreviousProjectionMatrix.value.copy(previousProjectionMatrix);
}

/** Snapshots the current camera and every mesh world matrix so the next frame can compute motion flow. */
export function commitDirectorCameraPreviewMotionHistory(
  camera: { matrixWorldInverse: Matrix4; projectionMatrix: Matrix4 },
  scene: Object3D,
) {
  previousViewMatrix.copy(camera.matrixWorldInverse);
  previousProjectionMatrix.copy(camera.projectionMatrix);
  scene.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    const stored = previousWorldByObject.get(object) ?? new Matrix4();
    stored.copy(object.matrixWorld);
    previousWorldByObject.set(object, stored);
  });
  motionHistoryReady = true;
}

/** Returns the shared scene.overrideMaterial for the given preview mode, or null when none is needed. */
export function getDirectorCameraPreviewOverrideMaterial(mode: DirectorCameraPreviewMode) {
  return mode === "depth"
    ? depthVizMaterial
    : mode === "normal"
      ? normalVizMaterial
      : mode === "motion"
        ? motionVizMaterial
        : mode === "wireframe"
          ? wireframeVizMaterial
          : null;
}

/** Idempotent restore handle returned by preview-modality scope helpers. */
export interface DirectorCameraPreviewModalityScope {
  restore: () => void;
}

/** Modes that recolor meshes one by one instead of using scene.overrideMaterial. */
export type DirectorCameraPreviewSegmentationMode = "objectid" | "mask";

/** Type guard that narrows a preview mode to the two segmentation modes ("objectid" | "mask"). */
export function isDirectorCameraPreviewSegmentationMode(
  mode: DirectorCameraPreviewMode,
): mode is DirectorCameraPreviewSegmentationMode {
  return mode === "objectid" || mode === "mask";
}

/**
 * Temporarily switches the scene to a technical visualization for one
 * camera-preview render. Previz and RGB modes need no override and return
 * null. Depth/normal/motion/wireframe swap scene.overrideMaterial; objectid/mask
 * clear it so the per-mesh segmentation materials (see
 * applyDirectorCameraPreviewSegmentationScope) win. In every technical mode
 * the background and clear color go black so the image reads as data, and
 * everything is restored even if rendering throws.
 */
export function applyDirectorCameraPreviewModalityScope(
  renderer: WebGLRenderer,
  scene: Scene,
  mode: DirectorCameraPreviewMode,
  depthRange?: DirectorCameraPreviewDepthRange,
): DirectorCameraPreviewModalityScope | null {
  const overrideMaterial = getDirectorCameraPreviewOverrideMaterial(mode);
  if (!overrideMaterial && !isDirectorCameraPreviewSegmentationMode(mode)) return null;

  if (mode === "depth" && depthRange) {
    depthVizMaterial.uniforms.uDepthNear.value = depthRange.nearM;
    depthVizMaterial.uniforms.uDepthFar.value = depthRange.farM;
  }

  const originalOverrideMaterial = scene.overrideMaterial;
  const originalBackground: Texture | Color | null = scene.background;
  const originalClearColor = renderer.getClearColor(new Color());
  const originalClearAlpha = renderer.getClearAlpha();

  scene.overrideMaterial = overrideMaterial;
  scene.background = null;
  renderer.setClearColor(0x000000, 1);

  let restored = false;
  return {
    restore: () => {
      if (restored) return;
      restored = true;
      scene.overrideMaterial = originalOverrideMaterial;
      scene.background = originalBackground;
      renderer.setClearColor(originalClearColor, originalClearAlpha);
    },
  };
}

const DIRECTOR_OBJECT_ID_KEY = "directorObjectId";
const DIRECTOR_INSTANCE_OBJECT_IDS_KEY = "directorInstanceObjectIds";

type RenderableMesh = Mesh & { material: Material | Material[] };

export interface DirectorCameraPreviewSegmentationEntry {
  mesh: RenderableMesh;
  /** Nearest ancestor userData.directorObjectId, or null for untagged geometry. */
  objectId: string | null;
  /** Per-instance object IDs from the nearest ancestor userData.directorInstanceObjectIds, when present. */
  instanceObjectIds?: string[];
}

function getNearestDirectorObjectId(object: Object3D): string | null {
  let current: Object3D | null = object;
  while (current) {
    const value = current.userData?.[DIRECTOR_OBJECT_ID_KEY];
    if (typeof value === "string" && value.trim()) return value;
    current = current.parent;
  }
  return null;
}

function getNearestDirectorInstanceObjectIds(object: Object3D): string[] | null {
  let current: Object3D | null = object;
  while (current) {
    const value = current.userData?.[DIRECTOR_INSTANCE_OBJECT_IDS_KEY];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
    current = current.parent;
  }
  return null;
}

/**
 * Indexes every mesh with its owning directorObjectId. Callers should cache
 * the result alongside the other picture-in-picture render indices (refreshed
 * every couple of seconds) instead of re-traversing the scene per frame.
 */
export function collectDirectorCameraPreviewSegmentationEntries(
  scene: Scene,
): DirectorCameraPreviewSegmentationEntry[] {
  const entries: DirectorCameraPreviewSegmentationEntry[] = [];
  scene.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    const instanceObjectIds = getNearestDirectorInstanceObjectIds(object);
    entries.push({
      mesh: object as RenderableMesh,
      objectId: getNearestDirectorObjectId(object),
      ...(instanceObjectIds ? { instanceObjectIds } : {}),
    });
  });
  return entries;
}

function createSegmentationMaterial(color: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    blending: NoBlending,
    color,
    fog: false,
    side: DoubleSide,
    toneMapped: false,
  });
}

// The monitor refreshes up to every frame, so segmentation materials are
// created once and recolored only when the set of object IDs changes.
const segmentationBlackMaterial = createSegmentationMaterial(0x000000);
segmentationBlackMaterial.name = "Director_CameraPreview_SegmentationBlack";
const segmentationWhiteMaterial = createSegmentationMaterial(0xffffff);
const segmentationInstanceMaterial = createSegmentationMaterial(0xffffff);
segmentationInstanceMaterial.vertexColors = true;
segmentationWhiteMaterial.name = "Director_CameraPreview_SegmentationWhite";
const segmentationObjectIdMaterials = new Map<string, MeshBasicMaterial>();
let segmentationObjectIdSignature: string | null = null;

function syncSegmentationObjectIdMaterials(objectIds: readonly string[]) {
  const signature = [...new Set(objectIds)].sort().join("\u0000");
  if (signature === segmentationObjectIdSignature) return;
  segmentationObjectIdSignature = signature;

  const colorMap = createDirectorObjectIdColorMap(objectIds);
  for (const [objectId, material] of segmentationObjectIdMaterials) {
    if (!(objectId in colorMap)) {
      segmentationObjectIdMaterials.delete(objectId);
      material.dispose();
    }
  }
  Object.entries(colorMap).forEach(([objectId, [red, green, blue]]) => {
    let material = segmentationObjectIdMaterials.get(objectId);
    if (!material) {
      material = createSegmentationMaterial(0x000000);
      material.name = `Director_CameraPreview_Segmentation_${objectId}`;
      segmentationObjectIdMaterials.set(objectId, material);
    }
    material.color.setRGB(red / 255, green / 255, blue / 255, SRGBColorSpace);
  });
}

/**
 * Recolors meshes for the segmentation monitor modes:
 * - "objectid": one stable color per directorObjectId (same hashing as the
 *   offline object-id capture pass), untagged geometry black.
 * - "mask": tagged objects white, everything else black.
 * Pair with applyDirectorCameraPreviewModalityScope, which blacks out the
 * background for these modes. Original materials are restored via the
 * returned scope even when rendering throws.
 */
export function applyDirectorCameraPreviewSegmentationScope(
  mode: DirectorCameraPreviewSegmentationMode,
  entries: readonly DirectorCameraPreviewSegmentationEntry[],
): DirectorCameraPreviewModalityScope {
  if (mode === "objectid") {
    syncSegmentationObjectIdMaterials(
      entries.flatMap((entry) => entry.instanceObjectIds ?? (entry.objectId ? [entry.objectId] : [])),
    );
  }

  const changed: Array<{
    mesh: RenderableMesh;
    material: Material | Material[];
    batchColorState?: DirectorObjectBatchColorState;
  }> = [];
  entries.forEach(({ mesh, objectId, instanceObjectIds }) => {
    const batchMesh = isDirectorObjectBatchMesh(mesh) ? mesh : null;
    const hasInstances = Boolean(instanceObjectIds?.length && batchMesh);
    const batchColorState = batchMesh ? captureDirectorObjectBatchColorState(batchMesh) : undefined;
    changed.push({
      mesh,
      material: mesh.material,
      ...(batchColorState ? { batchColorState } : {}),
    });
    if (mode === "objectid" && hasInstances && batchMesh) {
      const colors = Array.from({ length: getDirectorObjectBatchCount(batchMesh) }, (_, index) => {
        const instanceObjectId = instanceObjectIds?.[index];
        return segmentationObjectIdMaterials.get(instanceObjectId ?? "")?.color ?? segmentationBlackMaterial.color;
      });
      replaceDirectorObjectBatchColors(batchMesh, colors);
      mesh.material = segmentationInstanceMaterial;
      return;
    }
    if (batchMesh) clearDirectorObjectBatchColors(batchMesh);
    mesh.material =
      !objectId && !hasInstances
        ? segmentationBlackMaterial
        : mode === "mask"
          ? segmentationWhiteMaterial
          : (segmentationObjectIdMaterials.get(objectId ?? "") ?? segmentationBlackMaterial);
  });

  let restored = false;
  return {
    restore: () => {
      if (restored) return;
      restored = true;
      changed.forEach(({ mesh, material, batchColorState }) => {
        mesh.material = material;
        if (batchColorState && isDirectorObjectBatchMesh(mesh)) {
          restoreDirectorObjectBatchColors(mesh, batchColorState);
        }
      });
    },
  };
}
