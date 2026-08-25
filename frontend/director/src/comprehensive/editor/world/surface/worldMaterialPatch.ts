import {
  MeshStandardMaterial,
  Vector2,
  type Material,
  type Mesh,
  type Object3D,
  type WebGLProgramParametersWithUniforms,
} from "three";
import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { WorldClimateState } from "../worldClimate";
import {
  computeClimateSnowCover,
  computeClimateSurfaceWetness,
  computeEffectiveWorldSnowCover,
  computeEffectiveWorldWetness,
  computeWorldVegetationWindStrength,
  isWorldVegetationName,
} from "./worldSurfaceResponse";

/**
 * Lagarde-style wetness + upward-face snow + vegetation wind sway, injected
 * into MeshStandardMaterial / MeshPhysicalMaterial via onBeforeCompile.
 *
 * Two program variants (vegetation 0/1) share one uniform object so every
 * patched mesh sees the same weather/wind state. Existing compiles (wildlife
 * part articulation) are chained, not replaced. ShaderMaterials (water,
 * particles, sky) are skipped.
 *
 * Anchors: `#include <common>`, `<defaultnormal_vertex>`, `<begin_vertex>`,
 * `<color_fragment>`, `<metalnessmap_fragment>`.
 * Tests pin them against ShaderLib.standard. Missing anchors no-op the
 * matching replace instead of crashing.
 */

const PATCH_USERDATA_KEY = "directorWorldSurfacePatch";
const DIRECTOR_OBJECT_NAME = /^director-object-(.+)$/;

/** Uniforms shared across all surface-patched materials for wetness, snow, and wind sway. */
export interface WorldSurfaceUniforms {
  /** Surface wetness factor [0, 1]; darkens and reduces roughness. */
  uWorldWetness: { value: number };
  /** Upward-face snow cover factor [0, 1]; blends to white. */
  uWorldSnowCover: { value: number };
  /** World-space horizontal wind direction (unit-length XY). */
  uWorldWindDir: { value: Vector2 };
  /** Wind sway amplitude scale for vegetation. */
  uWorldWindStrength: { value: number };
  /** World time in seconds for phase-based effects. */
  uWorldTime: { value: number };
}

/** Creates a fresh uniform block initialised with safe zero defaults. */
export function createWorldSurfaceUniforms(): WorldSurfaceUniforms {
  return {
    uWorldWetness: { value: 0 },
    uWorldSnowCover: { value: 0 },
    uWorldWindDir: { value: new Vector2(1, 0) },
    uWorldWindStrength: { value: 0 },
    uWorldTime: { value: 0 },
  };
}

/**
 * Writes weather and wind state into the shared uniform block each frame.
 * Wind direction is normalised; a zero-length wind vector defaults to (1, 0).
 *
 * @param uniforms - The uniform block to write into.
 * @param weather - Current weather preset and intensity.
 * @param windX - World-space wind X component (climate wind gain included).
 * @param windZ - World-space wind Z component (climate wind gain included).
 * @param worldSeconds - Current world time in seconds.
 * @param climate - Optional evaluated climate; evolving mode reads the
 *   integrated wetness and continuous snow cover instead of the preset gate.
 */
export function writeWorldSurfaceUniforms(
  uniforms: WorldSurfaceUniforms,
  weather: DirectorWorldWeather,
  windX: number,
  windZ: number,
  worldSeconds: number,
  climate?: WorldClimateState,
): void {
  if (climate?.evolving) {
    uniforms.uWorldWetness.value = computeClimateSurfaceWetness(climate);
    uniforms.uWorldSnowCover.value = computeClimateSnowCover(climate);
  } else {
    uniforms.uWorldWetness.value = computeEffectiveWorldWetness(weather);
    uniforms.uWorldSnowCover.value = computeEffectiveWorldSnowCover(weather);
  }
  const speed = Math.hypot(windX, windZ);
  const length = Math.max(speed, 1e-5);
  uniforms.uWorldWindDir.value.set(windX / length, windZ / length);
  uniforms.uWorldWindStrength.value = computeWorldVegetationWindStrength(speed);
  uniforms.uWorldTime.value = worldSeconds;
}

const SKIP_SURFACE_MESH_NAME =
  /transformcontrols|viewport-ground-grid|panorama-backdrop|camera-frustum|frame-trajectory-overlay|drop-preview|living-world-effects|living-world-sky|living-world-water|director-living-world-water|director-water-|living-world-river|living-world-surface|world-effect-/i;

/**
 * Returns true when a mesh should be excluded from surface patching —
 * editor controls, sky, water, particles, and other non-surface objects.
 *
 * @param object - The three.js Object3D to check.
 * @returns Whether this mesh should be skipped.
 */
export function shouldSkipWorldSurfaceMesh(object: Object3D): boolean {
  return SKIP_SURFACE_MESH_NAME.test(object.name);
}

/**
 * Determines whether a mesh should receive vegetation wind sway by checking
 * its name, instance ids, and ancestor chain against the vegetation id set.
 *
 * @param object - The mesh to check.
 * @param vegetationIds - Set of project object ids marked as vegetation.
 * @returns true if this mesh should sway in the wind.
 */
export function isWorldVegetationMesh(object: Object3D, vegetationIds: ReadonlySet<string>): boolean {
  if (isWorldVegetationName(object.name)) return true;
  const instanceIds = object.userData?.directorInstanceObjectIds;
  if (Array.isArray(instanceIds)) {
    for (const id of instanceIds) {
      if (typeof id === "string" && vegetationIds.has(id)) return true;
    }
  }
  let current: Object3D | null = object;
  while (current) {
    const match = DIRECTOR_OBJECT_NAME.exec(current.name);
    if (match?.[1] && vegetationIds.has(match[1])) return true;
    if (isWorldVegetationName(current.name)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Type guard that returns true for materials the surface patcher can inject
 * into — MeshStandardMaterial and its subclasses. ShaderMaterial and other
 * custom materials are excluded.
 *
 * @param material - The material to check.
 * @returns true if the material is a MeshStandardMaterial.
 */
export function isWorldSurfacePatchableMaterial(material: Material): material is MeshStandardMaterial {
  return material instanceof MeshStandardMaterial;
}

const WORLD_SURFACE_VERTEX_UNIFORMS = /* glsl */ `
uniform float uWorldWetness;
uniform float uWorldSnowCover;
uniform vec2 uWorldWindDir;
uniform float uWorldWindStrength;
uniform float uWorldTime;
varying float vWorldUpDot;
`;

const WORLD_SURFACE_FRAGMENT_UNIFORMS = /* glsl */ `
uniform float uWorldWetness;
uniform float uWorldSnowCover;
varying float vWorldUpDot;
`;

const WORLD_SURFACE_NORMAL_CHUNK = /* glsl */ `
vWorldUpDot = inverseTransformDirection(transformedNormal, viewMatrix).y;
`;

/** GLSL chunk that displaces vertex XZ by wind direction and strength, scaled by height. */
export const WORLD_SURFACE_VEGETATION_SWAY_CHUNK = /* glsl */ `
{
  float height = max(transformed.y, 0.0);
  float phase = uWorldTime * 1.6 + modelMatrix[3][0] * 0.21 + modelMatrix[3][2] * 0.19;
#ifdef USE_INSTANCING
  phase += instanceMatrix[3][0] * 0.21 + instanceMatrix[3][2] * 0.19;
#endif
  float gust = sin(phase) * 0.62 + sin(phase * 2.31 + 1.7) * 0.38;
  transformed.xz += uWorldWindDir * (uWorldWindStrength * height * 0.055 * gust);
}
`;

/** GLSL chunk that darkens diffuse colour by wetness and blends snow on upward-facing surfaces. */
export const WORLD_SURFACE_COLOR_CHUNK = /* glsl */ `
{
  float wet = clamp(uWorldWetness, 0.0, 1.0);
  float porosity = mix(0.55, 0.08, clamp(metalness, 0.0, 1.0));
  diffuseColor.rgb *= mix(1.0, mix(0.55, 0.78, porosity), wet);
  float snow = clamp(uWorldSnowCover, 0.0, 1.0) * smoothstep(0.28, 0.72, vWorldUpDot);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.94), snow * 0.92);
}
`;

/** GLSL chunk that reduces roughness based on wetness and metalness (porosity model). */
export const WORLD_SURFACE_ROUGHNESS_CHUNK = /* glsl */ `
{
  float wet = clamp(uWorldWetness, 0.0, 1.0);
  float porosity = mix(0.55, 0.08, clamp(metalnessFactor, 0.0, 1.0));
  roughnessFactor *= mix(1.0, mix(0.22, 0.42, porosity), wet);
}
`;

/**
 * Injects world-surface GLSL chunks (wetness, snow, roughness, and optional
 * vegetation sway) into the vertex and fragment shaders. Anchors on standard
 * ShaderLib includes; missing anchors no-op the matching replace.
 *
 * @param vertexShader - The original vertex shader source.
 * @param fragmentShader - The original fragment shader source.
 * @param vegetation - Whether to inject the vegetation sway chunk.
 * @returns The modified vertex and fragment shader sources.
 */
export function injectWorldSurfaceShaders(
  vertexShader: string,
  fragmentShader: string,
  vegetation: boolean,
): { vertexShader: string; fragmentShader: string } {
  let nextVertex = vertexShader
    .replace("#include <common>", `#include <common>\n${WORLD_SURFACE_VERTEX_UNIFORMS}`)
    .replace("#include <defaultnormal_vertex>", `#include <defaultnormal_vertex>\n${WORLD_SURFACE_NORMAL_CHUNK}`);
  if (vegetation) {
    nextVertex = nextVertex.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>\n${WORLD_SURFACE_VEGETATION_SWAY_CHUNK}`,
    );
  }
  const colorChunk = vegetation
    ? WORLD_SURFACE_COLOR_CHUNK.replace("mix(0.55, 0.08, clamp(metalness, 0.0, 1.0))", "0.85")
    : WORLD_SURFACE_COLOR_CHUNK;
  const roughnessChunk = vegetation
    ? WORLD_SURFACE_ROUGHNESS_CHUNK.replace("mix(0.55, 0.08, clamp(metalnessFactor, 0.0, 1.0))", "0.85")
    : WORLD_SURFACE_ROUGHNESS_CHUNK;
  const nextFragment = fragmentShader
    .replace("#include <common>", `#include <common>\n${WORLD_SURFACE_FRAGMENT_UNIFORMS}`)
    .replace("#include <color_fragment>", `#include <color_fragment>\n${colorChunk}`)
    .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>\n${roughnessChunk}`);
  return { vertexShader: nextVertex, fragmentShader: nextFragment };
}

interface PatchRecord {
  vegetation: boolean;
  previousOnBeforeCompile: Material["onBeforeCompile"];
  previousCacheKey: Material["customProgramCacheKey"];
}

/**
 * Patches a MeshStandardMaterial with world-surface shader injections
 * (wetness, snow, roughness, and optional vegetation sway). Existing
 * onBeforeCompile chains are preserved; already-patched materials with the
 * same variant are no-ops.
 *
 * @param material - The material to patch; non-Standard materials are skipped.
 * @param uniforms - The shared uniform block to inject.
 * @param vegetation - Whether to add vegetation wind sway.
 */
export function patchWorldSurfaceMaterial(
  material: Material,
  uniforms: WorldSurfaceUniforms,
  vegetation: boolean,
): void {
  if (!isWorldSurfacePatchableMaterial(material)) return;
  const existing = material.userData[PATCH_USERDATA_KEY] as PatchRecord | undefined;
  if (existing && existing.vegetation === vegetation) return;
  if (existing) restoreWorldSurfaceMaterial(material);

  const previousOnBeforeCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;

  material.onBeforeCompile = (parameters: WebGLProgramParametersWithUniforms, renderer) => {
    previousOnBeforeCompile.call(material, parameters, renderer);
    parameters.uniforms.uWorldWetness = uniforms.uWorldWetness;
    parameters.uniforms.uWorldSnowCover = uniforms.uWorldSnowCover;
    parameters.uniforms.uWorldWindDir = uniforms.uWorldWindDir;
    parameters.uniforms.uWorldWindStrength = uniforms.uWorldWindStrength;
    parameters.uniforms.uWorldTime = uniforms.uWorldTime;
    const injected = injectWorldSurfaceShaders(parameters.vertexShader, parameters.fragmentShader, vegetation);
    parameters.vertexShader = injected.vertexShader;
    parameters.fragmentShader = injected.fragmentShader;
  };
  material.customProgramCacheKey = () => {
    const previous = previousCacheKey.call(material);
    return `${previous}|director-world-surface-v1|veg=${vegetation ? 1 : 0}`;
  };
  material.needsUpdate = true;
  material.userData[PATCH_USERDATA_KEY] = {
    vegetation,
    previousOnBeforeCompile,
    previousCacheKey,
  } satisfies PatchRecord;
}

/**
 * Restores a material's original onBeforeCompile and cache key, reversing a
 * previous {@link patchWorldSurfaceMaterial} call. No-op if not patched.
 *
 * @param material - The material to restore.
 */
export function restoreWorldSurfaceMaterial(material: Material): void {
  const existing = material.userData[PATCH_USERDATA_KEY] as PatchRecord | undefined;
  if (!existing) return;
  material.onBeforeCompile = existing.previousOnBeforeCompile;
  material.customProgramCacheKey = existing.previousCacheKey;
  delete material.userData[PATCH_USERDATA_KEY];
  material.needsUpdate = true;
}

/**
 * Restores every material in the iterable that was previously patched by
 * {@link patchWorldSurfaceMaterial}.
 *
 * @param materials - The materials to restore.
 */
export function restorePatchedWorldSurfaceMaterials(materials: Iterable<Material>): void {
  for (const material of materials) restoreWorldSurfaceMaterial(material);
}

function isMesh(object: Object3D): object is Mesh {
  return (object as Mesh).isMesh === true;
}

/** Walk the scene once; already-patched materials with the same variant no-op. */
export function syncWorldSurfaceMaterials(
  root: Object3D,
  uniforms: WorldSurfaceUniforms,
  vegetationIds: ReadonlySet<string>,
  patched: Set<Material>,
): void {
  root.traverse((object) => {
    if (!isMesh(object) || shouldSkipWorldSurfaceMesh(object)) return;
    const vegetation = isWorldVegetationMesh(object, vegetationIds);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material || !isWorldSurfacePatchableMaterial(material)) continue;
      patchWorldSurfaceMaterial(material, uniforms, vegetation);
      patched.add(material);
    }
  });
}
