import {
  Color,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
} from "three";
import {
  captureDirectorObjectBatchColorState,
  clearDirectorObjectBatchColors,
  isDirectorObjectBatchMesh,
  restoreDirectorObjectBatchColors,
  type DirectorObjectBatchColorState,
} from "../canvas/directorObjectBatch";
import { DIRECTOR_PREVIZ_PALETTE } from "@director/project-schema";

type RenderableMesh = Mesh & { material: Material | Material[] };
/** A renderable mesh eligible for the previz clay-material swap. */
export interface DirectorPrevizMeshEntry {
  mesh: RenderableMesh;
}

/** Clay albedo role: characters stay warm so blocking silhouettes read against cool sets. */
export type DirectorPrevizClayRole = "environment" | "character";

const DIRECTOR_OBJECT_KIND_KEY = "directorObjectKind";

function createClayMaterial(role: DirectorPrevizClayRole) {
  const material = new MeshStandardMaterial({
    color: clayColorForRole(role),
    metalness: 0,
    roughness: 0.72,
    // Scene environment (atmosphere LUT / panorama) must not tint clay with
    // sky colour. MeshStandardMaterial still samples `scene.environment` unless
    // intensity is zero and the probe is detached for the pass.
    envMapIntensity: 0,
    fog: false,
    vertexColors: false,
  });
  material.name = role === "character" ? "Director_Previz_HumanClay" : "Director_Previz_Clay";
  installClayStudioShading(material);
  return material;
}

const clayMaterial = createClayMaterial("environment");
const humanClayMaterial = createClayMaterial("character");
const clayBackground = new Color(DIRECTOR_PREVIZ_PALETTE.sky);
const clayVariants = new Map<string, MeshStandardMaterial>([
  [clayVariantKey("environment", FrontSide, 0, 0), clayMaterial],
  [clayVariantKey("character", FrontSide, 0, 0), humanClayMaterial],
]);

type PrevizColorLeakObject = Object3D & {
  isLine?: boolean;
  isPoints?: boolean;
  isSparkRenderer?: boolean;
  isSplatMesh?: boolean;
  isSprite?: boolean;
};

/**
 * Living-world and capture overlays keep authored RGB (and often write depth
 * once swapped onto the shared clay material). Hide them for the clay pass.
 */
const PREVIZ_OVERLAY_NAME =
  /panorama-backdrop|living-world-atmosphere-sky|living-world-clouds|living-world-stars|living-world-effects|director-living-world-water|living-world-river|director-water-|world-effect-/i;

function clayColorForRole(role: DirectorPrevizClayRole) {
  return role === "character" ? DIRECTOR_PREVIZ_PALETTE.human : DIRECTOR_PREVIZ_PALETTE.clay;
}

/**
 * Walks to the nearest authored owner and maps characters onto warm clay.
 * Untagged environment dressing (ground, batches, imported sets) stays cool grey.
 */
export function resolveDirectorPrevizClayRole(object: Object3D): DirectorPrevizClayRole {
  let current: Object3D | null = object;
  while (current) {
    if (current.userData?.[DIRECTOR_OBJECT_KIND_KEY] === "character") return "character";
    current = current.parent;
  }
  return "environment";
}

function clayVariantKey(role: DirectorPrevizClayRole, side: number, factor: number, units: number) {
  return `${role}|${side}|${factor}|${units}`;
}

/**
 * Adds a view-independent sky/ground wrap so volumes still read after IBL is
 * detached. Existing scene lights and shadow maps continue to contribute.
 */
function installClayStudioShading(material: MeshStandardMaterial) {
  material.userData.directorClayStudio = true;
  material.onBeforeCompile = (shader) => {
    if (shader.fragmentShader.includes("DirectorClayStudio")) return;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_fragment_end>",
      [
        "// DirectorClayStudio",
        "irradiance += vec3(0.30) * (0.38 + 0.62 * max(dot(normalize(geometryNormal), vec3(0.0, 1.0, 0.0)), 0.0));",
        "#include <lights_fragment_end>",
      ].join("\n"),
    );
  };
}

function sourceMaterial(mesh: RenderableMesh): Material | null {
  const material = mesh.material;
  if (Array.isArray(material)) return material[0] ?? null;
  return material ?? null;
}

function clayVariantFor(source: Material | null, role: DirectorPrevizClayRole) {
  const side = source?.side ?? FrontSide;
  const polygonOffset = source?.polygonOffset === true;
  const factor = polygonOffset ? (source?.polygonOffsetFactor ?? 0) : 0;
  const units = polygonOffset ? (source?.polygonOffsetUnits ?? 0) : 0;
  const key = clayVariantKey(role, side, factor, units);
  const cached = clayVariants.get(key);
  if (cached) return cached;
  const sourceClay = role === "character" ? humanClayMaterial : clayMaterial;
  const variant = sourceClay.clone();
  variant.name = sourceClay.name;
  variant.side = side;
  variant.polygonOffset = polygonOffset;
  variant.polygonOffsetFactor = factor;
  variant.polygonOffsetUnits = units;
  variant.envMapIntensity = 0;
  installClayStudioShading(variant);
  clayVariants.set(key, variant);
  return variant;
}

function isShaderMaterial(material: Material | undefined) {
  return Boolean(material && (material as Material & { isShaderMaterial?: boolean }).isShaderMaterial);
}

/**
 * Draws that keep authored RGB even after mesh materials are swapped: particles,
 * sprites, gaussian splats, and Spark's extra renderer.
 */
export function isDirectorPrevizColorLeakObject(object: Object3D): boolean {
  const candidate = object as PrevizColorLeakObject;
  return Boolean(
    candidate.isPoints || candidate.isLine || candidate.isSprite || candidate.isSplatMesh || candidate.isSparkRenderer,
  );
}

/** Sky, water, particles, and other custom-shader overlays that must not draw in clay. */
export function isDirectorPrevizOverlayObject(object: Object3D): boolean {
  if (isDirectorPrevizColorLeakObject(object)) return true;
  if (PREVIZ_OVERLAY_NAME.test(object.name)) return true;
  const mesh = object as Mesh;
  if (!mesh.isMesh) return false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some((material) => isShaderMaterial(material as Material));
}

/**
 * Temporarily turns authored assets into a predictable blocking-stage image.
 * Source materials are never mutated and are restored even when rendering
 * throws, so the editor viewport and saved assets retain their full look.
 */
export function applyDirectorPrevizMaterialScope(scene: Scene) {
  return applyDirectorPrevizMaterialEntries(collectDirectorPrevizMeshes(scene), scene);
}

/**
 * Collects every mesh in the scene that is eligible for the previz clay swap,
 * excluding overlay objects (sky, water, particles, custom-shader materials).
 *
 * @param scene - The scene to traverse.
 * @returns Flat list of meshes to recolor with clay materials.
 */
export function collectDirectorPrevizMeshes(scene: Scene) {
  const entries: DirectorPrevizMeshEntry[] = [];
  scene.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    if (isDirectorPrevizOverlayObject(object)) return;
    entries.push({ mesh: object as RenderableMesh });
  });
  return entries;
}

/**
 * Swaps every mesh in the entry list to a neutral clay material and optionally
 * hides overlay objects and replaces the scene background/environment. The
 * returned scope restores everything even when rendering throws.
 *
 * @param entries - The meshes to recolor, typically from `collectDirectorPrevizMeshes`.
 * @param scene - Optional scene to also recolor background/environment and hide overlays.
 * @returns A scope whose `restore()` reverts all materials, visibility, and scene state.
 */
export function applyDirectorPrevizMaterialEntries(entries: readonly DirectorPrevizMeshEntry[], scene?: Scene) {
  const changed: Array<{
    mesh: RenderableMesh;
    material: Material | Material[];
    batchColorState?: DirectorObjectBatchColorState;
  }> = [];
  const hidden: Array<{ object: Object3D; visible: boolean }> = [];
  const originalBackground = scene?.background ?? null;
  const originalEnvironment = scene?.environment ?? null;
  const originalEnvironmentIntensity = scene?.environmentIntensity;
  let restored = false;

  entries.forEach(({ mesh }) => {
    if (isDirectorPrevizOverlayObject(mesh)) return;
    const batchMesh = isDirectorObjectBatchMesh(mesh) ? mesh : null;
    const batchColorState = batchMesh ? captureDirectorObjectBatchColorState(batchMesh) : undefined;
    changed.push({
      mesh,
      material: mesh.material,
      ...(batchColorState ? { batchColorState } : {}),
    });
    if (batchMesh) clearDirectorObjectBatchColors(batchMesh);
    mesh.material = clayVariantFor(sourceMaterial(mesh), resolveDirectorPrevizClayRole(mesh));
  });
  if (scene) {
    scene.background = clayBackground;
    scene.environment = null;
    scene.environmentIntensity = 0;
    scene.traverse((object) => {
      if (!object.visible || !isDirectorPrevizOverlayObject(object)) return;
      hidden.push({ object, visible: object.visible });
      object.visible = false;
    });
  }

  return {
    changedCount: changed.length,
    restore: () => {
      if (restored) return;
      restored = true;
      changed.forEach(({ mesh, material, batchColorState }) => {
        mesh.material = material;
        if (batchColorState && isDirectorObjectBatchMesh(mesh)) {
          restoreDirectorObjectBatchColors(mesh, batchColorState);
        }
      });
      hidden.forEach(({ object, visible }) => {
        object.visible = visible;
      });
      if (scene) {
        scene.background = originalBackground;
        scene.environment = originalEnvironment as Texture | null;
        if (originalEnvironmentIntensity !== undefined) {
          scene.environmentIntensity = originalEnvironmentIntensity;
        }
      }
    },
  };
}
