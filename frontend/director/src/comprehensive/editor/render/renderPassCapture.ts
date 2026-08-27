/**
 * Offscreen render-pass capture for the Stage: renders the scene into a
 * WebGLRenderTarget under a specific pass (beauty with optional transparent
 * background, depth, normal, object-id, semantic segmentation, …) by
 * temporarily overriding materials, batch colors, tone mapping, and helper
 * visibility, then restoring every mutated renderer/scene state. Pass output
 * feeds dataset export, AI control packages, and shot packages — so the
 * per-pass encodings (e.g. RGBADepthPacking, the semantic palette) are part
 * of the agent-facing contract and must stay stable.
 */
import {
  Camera,
  Color,
  DoubleSide,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshNormalMaterial,
  NearestFilter,
  NoColorSpace,
  NoBlending,
  NoToneMapping,
  RGBAFormat,
  RGBADepthPacking,
  Scene,
  UnsignedByteType,
  WebGLRenderTarget,
  type Material,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from "three";
import {
  captureDirectorObjectBatchColorState,
  clearDirectorObjectBatchColors,
  getDirectorObjectBatchCount,
  isDirectorObjectBatchMesh,
  replaceDirectorObjectBatchColors,
  restoreDirectorObjectBatchColors,
  type DirectorObjectBatchColorState,
} from "../canvas/directorObjectBatch";
import type { DirectorShotRenderPassId } from "../shot/shotPackage";
import {
  DIRECTOR_HIDE_FROM_CAPTURE_KEY,
  suppressDirectorCaptureHelpers,
  suppressDirectorEnvironmentDressing,
  type DirectorCaptureVisibilityScope,
} from "./captureVisibility";
import {
  createDirectorSemanticCategoryColorMap,
  DIRECTOR_SEMANTIC_PALETTE,
  type DirectorSemanticCategory,
} from "./semanticPalette";
import {
  assertDirectorRenderDimension as assertDimension,
  flipDirectorRgbaRowsInPlace as flipRgbaRowsInPlace,
  restoreDirectorRendererState as restoreRendererState,
  snapshotDirectorRendererState as snapshotRendererState,
  unpremultiplyDirectorRgbaInPlace as unpremultiplyRgbaInPlace,
} from "./renderCaptureUtils";
import { applyDirectorPrevizMaterialEntries, type DirectorPrevizMeshEntry } from "./previzMaterialScope";
import { applyDirectorPbrGbufferPass, isDirectorPbrGbufferPass } from "./pbrGbufferPass";

const DIRECTOR_OBJECT_ID_KEY = "directorObjectId";
const DIRECTOR_OBJECT_KIND_KEY = "directorObjectKind";
const DIRECTOR_INSTANCE_OBJECT_IDS_KEY = "directorInstanceObjectIds";
const TRANSPARENT_CAPTURE_MSAA_SAMPLES = 4;

/**
 * Beauty-pass background handling. "composited" is the historical default:
 * the scene background/backdrop and environment dressing render as-is.
 * "transparent" delivers compositor-ready RGBA: alpha-0 clear color, no
 * scene background, and environment dressing hidden so only authored scene
 * content (objects owning a `directorObjectId`) covers pixels.
 */
export type DirectorCaptureBackgroundMode = "composited" | "transparent";

export interface DirectorRenderPassCaptureInput {
  /** The WebGL renderer to use for the capture. */
  renderer: WebGLRenderer;
  /** The scene containing authored objects. */
  scene: Scene;
  /** The camera whose view defines the capture. */
  camera: Camera;
  /** Which render pass to capture (clean, depth, normal, object-id, etc.). */
  renderPass: DirectorShotRenderPassId;
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /**
   * Clear color for data passes. Defaults to transparent black except for the
   * opaque black-and-white mask. The float-depth EXR path overrides it so
   * pixels without geometry unpack to far-plane depth on classic
   * (non-reversed) depth buffers.
   */
  technicalPassClearColor?: { color: number; alpha: number };
  /**
   * Only honored by the clean pass; technical passes already render data on
   * a transparent-black clear and keep environment geometry by design.
   */
  background?: DirectorCaptureBackgroundMode;
}

export interface DirectorRenderPassCaptureMetadata {
  /** Which render pass this metadata describes. */
  renderPass: DirectorShotRenderPassId;
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Always RGBA8 for render-pass captures. */
  pixelFormat: "rgba8";
  /** 8 bits per channel. */
  bitsPerChannel: 8;
  /** Pixel rows are stored top-to-bottom after row-flip. */
  rowOrder: "top-to-bottom";
  /** Whether the pixel data is sRGB or raw data. */
  colorSpace: "srgb" | "data";
  /** "lineart-binary-rgb" is composed by lineartPassCapture, never rendered directly. */
  encoding:
    | "color"
    | "rgba-depth-packed"
    | "view-normal-rgb"
    | "object-id-rgb"
    | "binary-mask-rgb"
    | "base-color-rgb"
    | "roughness-grayscale"
    | "metalness-grayscale"
    | "emissive-rgb"
    | "ambient-occlusion-grayscale"
    | "shadow-matte-grayscale"
    | "semantic-category-rgb"
    | "lineart-binary-rgb";
  helpersExcluded: true;
  /**
   * Present only when a clean pass rendered with a transparent background;
   * the RGBA payload then carries straight (non-premultiplied) alpha.
   */
  background?: "transparent";
  /** Present only for the object-id pass. RGB values are exact unsigned bytes. */
  objectIdToRgb?: Record<string, [number, number, number]>;
  /** Present only for the semantic pass. RGB values are exact unsigned bytes. */
  categoryToRgb?: Record<DirectorSemanticCategory, [number, number, number]>;
}

/** The RGBA pixel payload and its companion metadata for a render pass capture. */
export interface DirectorRenderPassCaptureResult {
  rgba: Uint8Array;
  metadata: DirectorRenderPassCaptureMetadata;
}

type RenderableMesh = Mesh & { material: Material | Material[] };
type OriginalMeshMaterial = {
  mesh: RenderableMesh;
  material: Material | Material[];
  batchColorState?: DirectorObjectBatchColorState;
};

function isCaptureVisible(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible || current.userData?.[DIRECTOR_HIDE_FROM_CAPTURE_KEY]) return false;
    current = current.parent;
  }
  return true;
}

function getCaptureMeshes(scene: Scene): RenderableMesh[] {
  const meshes: RenderableMesh[] = [];
  scene.traverse((object) => {
    if ((object as Mesh).isMesh && isCaptureVisible(object)) meshes.push(object as RenderableMesh);
  });
  return meshes;
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

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isReadableObjectIdColor(packed: number) {
  const red = (packed >>> 16) & 0xff;
  const green = (packed >>> 8) & 0xff;
  const blue = packed & 0xff;
  return red + green + blue >= 192 && Math.max(red, green, blue) >= 96;
}

/** Stable within an ID set, unique for that capture, and never background black. */
export function createDirectorObjectIdColorMap(objectIds: Iterable<string>): Record<string, [number, number, number]> {
  const result: Record<string, [number, number, number]> = {};
  const usedColors = new Set<number>();
  const sortedIds = [...new Set(objectIds)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  sortedIds.forEach((objectId) => {
    let packed = fnv1a32(objectId) & 0xffffff;
    while (!isReadableObjectIdColor(packed) || usedColors.has(packed)) {
      // The odd golden-ratio step visits every 24-bit value before repeating.
      // Skipping low-luminance candidates keeps valid instance colors visually
      // distinct from the reserved black background without sacrificing IDs.
      packed = (packed + 0x9e3779) & 0xffffff;
    }
    usedColors.add(packed);
    result[objectId] = [(packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff];
  });
  return result;
}

type SegmentationSourceMaterial = Material & {
  alphaMap?: Texture | null;
  alphaTest?: number;
  map?: Texture | null;
  opacity?: number;
};

function configureSegmentationAlphaCutout(material: MeshBasicMaterial, source: Material) {
  const authored = source as SegmentationSourceMaterial;
  const alphaTest = authored.alphaTest ?? 0;
  material.alphaTest = alphaTest;
  material.opacity = authored.opacity ?? 1;
  material.side = source.side;
  material.visible = source.visible;
  if (alphaTest <= 0) return;

  material.alphaMap = authored.alphaMap ?? null;
  material.map = authored.map ?? null;
  if (!material.map) return;

  // glTF MASK materials commonly store cutout opacity in baseColorTexture.a.
  // Keep that alpha channel while preventing the authored RGB texture from
  // multiplying the exact object/category color.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      [
        "#ifdef USE_MAP",
        "  vec4 sampledDiffuseColor = texture2D( map, vMapUv );",
        "  diffuseColor.a *= sampledDiffuseColor.a;",
        "#endif",
      ].join("\n"),
    );
  };
  material.customProgramCacheKey = () => "director-segmentation-alpha-map-v1";
}

function createSegmentationMaterial(
  source: Material,
  rgb: readonly [number, number, number],
  disposableMaterials: Material[],
  vertexColors = false,
) {
  const material = new MeshBasicMaterial({
    blending: NoBlending,
    depthTest: true,
    depthWrite: true,
    fog: false,
    side: source.side,
    toneMapped: false,
    vertexColors,
  });
  material.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, LinearSRGBColorSpace);
  configureSegmentationAlphaCutout(material, source);
  disposableMaterials.push(material);
  return material;
}

function replaceMeshMaterials(
  mesh: RenderableMesh,
  create: (source: Material) => MeshBasicMaterial,
): Material | Material[] {
  const original = mesh.material;
  mesh.material = Array.isArray(original) ? original.map(create) : create(original);
  return original;
}

function createTechnicalOverrideMaterial(renderPass: DirectorShotRenderPassId): Material | null {
  if (renderPass === "depth") {
    return new MeshDepthMaterial({
      blending: NoBlending,
      depthPacking: RGBADepthPacking,
      side: DoubleSide,
    });
  }
  if (renderPass === "normal") {
    return new MeshNormalMaterial({
      blending: NoBlending,
      flatShading: false,
      side: DoubleSide,
    });
  }
  return null;
}

function replaceObjectIdMaterials(
  meshes: RenderableMesh[],
  disposableMaterials: Material[],
): {
  objectIdToRgb: Record<string, [number, number, number]>;
  originalMaterials: OriginalMeshMaterial[];
} {
  const meshIds = meshes.map((mesh) => getNearestDirectorObjectId(mesh));
  const instanceObjectIds = meshes.map((mesh) => getNearestDirectorInstanceObjectIds(mesh));
  const objectIdToRgb = createDirectorObjectIdColorMap([
    ...meshIds.filter((value): value is string => Boolean(value)),
    ...instanceObjectIds.flatMap((value) => value ?? []),
  ]);
  const materialCache = new Map<string, MeshBasicMaterial>();
  const materialFor = (source: Material, rgb: readonly [number, number, number], vertexColors = false) => {
    const key = `${source.uuid}:${rgb.join(",")}:${vertexColors ? "instances" : "flat"}`;
    const existing = materialCache.get(key);
    if (existing) return existing;
    const created = createSegmentationMaterial(source, rgb, disposableMaterials, vertexColors);
    materialCache.set(key, created);
    return created;
  };

  const originalMaterials = meshes.map((mesh, index) => {
    const original = mesh.material;
    const objectId = meshIds[index];
    const meshInstanceObjectIds = instanceObjectIds[index];
    if (meshInstanceObjectIds?.length && isDirectorObjectBatchMesh(mesh)) {
      const batchColorState = captureDirectorObjectBatchColorState(mesh);
      const colors = Array.from({ length: getDirectorObjectBatchCount(mesh) }, (_, instanceIndex) => {
        const instanceObjectId = meshInstanceObjectIds[instanceIndex];
        const rgb = objectIdToRgb[instanceObjectId ?? ""] ?? [0, 0, 0];
        return new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, LinearSRGBColorSpace);
      });
      replaceDirectorObjectBatchColors(mesh, colors);
      const source = Array.isArray(original) ? original[0]! : original;
      mesh.material = materialFor(source, [255, 255, 255], true);
      return { mesh, material: original, batchColorState };
    }
    const rgb = objectId ? objectIdToRgb[objectId]! : ([0, 0, 0] as const);
    replaceMeshMaterials(mesh, (source) => materialFor(source, rgb));
    return { mesh, material: original };
  });
  return { objectIdToRgb, originalMaterials };
}

function replaceMaskMaterials(meshes: RenderableMesh[], disposableMaterials: Material[]): OriginalMeshMaterial[] {
  const cache = new Map<string, MeshBasicMaterial>();

  return meshes.map((mesh) => {
    const original = mesh.material;
    const batchMesh = isDirectorObjectBatchMesh(mesh) ? mesh : null;
    const batchColorState = batchMesh ? captureDirectorObjectBatchColorState(batchMesh) : undefined;
    // Scene objects are tagged at their runtime root. Untagged meshes are
    // environment/ground geometry and intentionally remain background black.
    const rgb =
      getNearestDirectorObjectId(mesh) || getNearestDirectorInstanceObjectIds(mesh)?.length
        ? ([255, 255, 255] as const)
        : ([0, 0, 0] as const);
    replaceMeshMaterials(mesh, (source) => {
      const key = `${source.uuid}:${rgb.join(",")}`;
      const existing = cache.get(key);
      if (existing) return existing;
      const created = createSegmentationMaterial(source, rgb, disposableMaterials);
      cache.set(key, created);
      return created;
    });
    if (batchMesh) clearDirectorObjectBatchColors(batchMesh);
    return { mesh, material: original, ...(batchColorState ? { batchColorState } : {}) };
  });
}

function getDirectorSemanticMeshCategory(object: Object3D): Exclude<DirectorSemanticCategory, "background"> {
  let current: Object3D | null = object;
  while (current) {
    const kind = current.userData?.[DIRECTOR_OBJECT_KIND_KEY];
    if (kind === "character" || kind === "prop") return kind;
    current = current.parent;
  }
  // Untagged meshes (and non character/prop kinds such as camera rigs) are
  // environment/ground geometry; empty pixels stay the background clear color.
  return "environment";
}

function replaceSemanticMaterials(meshes: RenderableMesh[], disposableMaterials: Material[]): OriginalMeshMaterial[] {
  const materialByCategory = new Map<string, MeshBasicMaterial>();
  const semanticMaterial = (source: Material, category: DirectorSemanticCategory): MeshBasicMaterial => {
    const key = `${source.uuid}:${category}`;
    const existing = materialByCategory.get(key);
    if (existing) return existing;
    const material = createSegmentationMaterial(source, DIRECTOR_SEMANTIC_PALETTE[category], disposableMaterials);
    materialByCategory.set(key, material);
    return material;
  };

  return meshes.map((mesh) => {
    const original = mesh.material;
    const batchMesh = isDirectorObjectBatchMesh(mesh) ? mesh : null;
    const batchColorState = batchMesh ? captureDirectorObjectBatchColorState(batchMesh) : undefined;
    if (batchMesh) clearDirectorObjectBatchColors(batchMesh);
    const category = getDirectorSemanticMeshCategory(mesh);
    replaceMeshMaterials(mesh, (source) => semanticMaterial(source, category));
    return { mesh, material: original, ...(batchColorState ? { batchColorState } : {}) };
  });
}

function enableMaterialOverrides(meshes: RenderableMesh[]): Array<{ material: Material; allowOverride: boolean }> {
  const originals = new Map<Material, boolean>();
  meshes.forEach((mesh) => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      if (originals.has(material)) return;
      originals.set(material, material.allowOverride);
      material.allowOverride = true;
    });
  });
  return [...originals].map(([material, allowOverride]) => ({ material, allowOverride }));
}

function metadataForPass(
  renderPass: DirectorShotRenderPassId,
  width: number,
  height: number,
  transparentBackground: boolean,
  objectIdToRgb?: Record<string, [number, number, number]>,
  categoryToRgb?: Record<DirectorSemanticCategory, [number, number, number]>,
): DirectorRenderPassCaptureMetadata {
  const encoding: DirectorRenderPassCaptureMetadata["encoding"] =
    renderPass === "depth"
      ? "rgba-depth-packed"
      : renderPass === "normal"
        ? "view-normal-rgb"
        : renderPass === "object-id"
          ? "object-id-rgb"
          : renderPass === "mask"
            ? "binary-mask-rgb"
            : renderPass === "semantic"
              ? "semantic-category-rgb"
              : renderPass === "albedo"
                ? "base-color-rgb"
                : renderPass === "roughness"
                  ? "roughness-grayscale"
                  : renderPass === "metalness"
                    ? "metalness-grayscale"
                    : renderPass === "emissive"
                      ? "emissive-rgb"
                      : renderPass === "ao"
                        ? "ambient-occlusion-grayscale"
                        : renderPass === "shadow"
                          ? "shadow-matte-grayscale"
                          : "color";
  return {
    renderPass,
    width,
    height,
    pixelFormat: "rgba8",
    bitsPerChannel: 8,
    rowOrder: "top-to-bottom",
    colorSpace:
      renderPass === "clean" || renderPass === "clay" || renderPass === "albedo" || renderPass === "emissive"
        ? "srgb"
        : "data",
    encoding,
    helpersExcluded: true,
    ...(transparentBackground ? { background: "transparent" as const } : {}),
    ...(objectIdToRgb ? { objectIdToRgb } : {}),
    ...(categoryToRgb ? { categoryToRgb } : {}),
  };
}

/**
 * Captures one raw RGBA8 render pass. It does not encode PNG bytes; callers own
 * image encoding and must not describe this output as a 16-bit PNG.
 */
export function captureDirectorRenderPass({
  renderer,
  scene,
  camera,
  renderPass,
  width,
  height,
  technicalPassClearColor,
  background,
}: DirectorRenderPassCaptureInput): DirectorRenderPassCaptureResult {
  assertDimension(width, "Render width");
  assertDimension(height, "Render height");
  const transparentBackground = background === "transparent" && renderPass === "clean";
  const displayColorPass = renderPass === "clean" || renderPass === "clay";
  const srgbPass = displayColorPass || renderPass === "albedo" || renderPass === "emissive";

  const rendererState = snapshotRendererState(renderer);
  const originalOverrideMaterial = scene.overrideMaterial;
  const originalBackground = scene.background;
  const renderTarget = new WebGLRenderTarget(width, height, {
    depthBuffer: true,
    format: RGBAFormat,
    magFilter: NearestFilter,
    minFilter: NearestFilter,
    stencilBuffer: false,
    type: UnsignedByteType,
    // MSAA gives authored silhouettes fractional-coverage alpha edges. The
    // composited path keeps 0 samples so its PNG bytes stay byte-identical.
    samples: transparentBackground ? TRANSPARENT_CAPTURE_MSAA_SAMPLES : 0,
  });
  renderTarget.texture.generateMipmaps = false;
  // Display-color PNG bytes are sRGB. Data passes remain exact untagged data
  // so IDs, packed depth, and normal channels are not transformed.
  renderTarget.texture.colorSpace = srgbPass ? renderer.outputColorSpace : NoColorSpace;

  const disposableMaterials: Material[] = [];
  const visibilityScope = suppressDirectorCaptureHelpers(scene);
  const environmentScope: DirectorCaptureVisibilityScope | null = transparentBackground
    ? suppressDirectorEnvironmentDressing(scene)
    : null;
  const originalMaterials: OriginalMeshMaterial[] = [];
  const overrideFlags: Array<{ material: Material; allowOverride: boolean }> = [];
  let objectIdToRgb: Record<string, [number, number, number]> | undefined;
  let categoryToRgb: Record<DirectorSemanticCategory, [number, number, number]> | undefined;
  let clayScope: ReturnType<typeof applyDirectorPrevizMaterialEntries> | null = null;
  let pbrScope: ReturnType<typeof applyDirectorPbrGbufferPass> | null = null;

  try {
    const meshes = getCaptureMeshes(scene);
    const overrideMaterial = createTechnicalOverrideMaterial(renderPass);
    if (overrideMaterial) disposableMaterials.push(overrideMaterial);

    scene.overrideMaterial = overrideMaterial;
    if (!displayColorPass) {
      scene.background = null;
      renderer.outputColorSpace = srgbPass ? rendererState.outputColorSpace : LinearSRGBColorSpace;
      renderer.toneMapping = NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.setClearColor(
        technicalPassClearColor?.color ?? (renderPass === "shadow" ? 0xffffff : 0x000000),
        technicalPassClearColor?.alpha ?? (renderPass === "mask" || renderPass === "shadow" ? 1 : 0),
      );
    } else if (transparentBackground) {
      // Keep sRGB output and the authored tone mapping so scene content
      // matches the composited beauty pass; only empty pixels change.
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    if (overrideMaterial) overrideFlags.push(...enableMaterialOverrides(meshes));
    if (renderPass === "clay") {
      clayScope = applyDirectorPrevizMaterialEntries(
        meshes.map((mesh): DirectorPrevizMeshEntry => ({ mesh })),
        scene,
      );
    }
    if (isDirectorPbrGbufferPass(renderPass)) {
      pbrScope = applyDirectorPbrGbufferPass(meshes, renderPass);
    }
    if (renderPass === "object-id") {
      const replacement = replaceObjectIdMaterials(meshes, disposableMaterials);
      objectIdToRgb = replacement.objectIdToRgb;
      originalMaterials.push(...replacement.originalMaterials);
    }
    if (renderPass === "mask") {
      originalMaterials.push(...replaceMaskMaterials(meshes, disposableMaterials));
    }
    if (renderPass === "semantic") {
      originalMaterials.push(...replaceSemanticMaterials(meshes, disposableMaterials));
      categoryToRgb = createDirectorSemanticCategoryColorMap();
    }

    renderer.autoClear = true;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;
    renderer.autoClearStencil = true;
    renderer.setRenderTarget(renderTarget);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    const rgba = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, rgba);
    flipRgbaRowsInPlace(rgba, width, height);
    if (transparentBackground) unpremultiplyRgbaInPlace(rgba);
    return {
      rgba,
      metadata: metadataForPass(renderPass, width, height, transparentBackground, objectIdToRgb, categoryToRgb),
    };
  } finally {
    try {
      originalMaterials.forEach(({ mesh, material, batchColorState }) => {
        mesh.material = material;
        if (batchColorState && isDirectorObjectBatchMesh(mesh)) {
          restoreDirectorObjectBatchColors(mesh, batchColorState);
        }
      });
      pbrScope?.restore();
      clayScope?.restore();
      overrideFlags.forEach(({ material, allowOverride }) => {
        material.allowOverride = allowOverride;
      });
      environmentScope?.restore();
      visibilityScope.restore();
      scene.overrideMaterial = originalOverrideMaterial;
      scene.background = originalBackground;
    } finally {
      try {
        restoreRendererState(renderer, rendererState);
      } finally {
        disposableMaterials.forEach((material) => material.dispose());
        renderTarget.dispose();
      }
    }
  }
}
