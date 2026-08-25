import {
  MeshStandardMaterial,
  Vector2,
  type Material,
  type Mesh,
  type Object3D,
  type WebGLProgramParametersWithUniforms,
} from "three";
import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  WORLD_WET_ALBEDO_SCALE_POROSITY_0,
  WORLD_WET_ALBEDO_SCALE_POROSITY_1,
  WORLD_WET_ROUGHNESS_SCALE_POROSITY_0,
  WORLD_WET_ROUGHNESS_SCALE_POROSITY_1,
  computeEffectiveWorldSnowCover,
  computeEffectiveWorldWetness,
  computeWorldPuddleAmount,
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
  /** Low-lying puddle accumulation [0, 1]; placement is seeded spatial noise. */
  uWorldPuddle: { value: number };
  /** World-space horizontal wind direction (unit-length XY). */
  uWorldWindDir: { value: Vector2 };
  /** Wind sway amplitude scale for vegetation. */
  uWorldWindStrength: { value: number };
  /** Authored wind gustiness [0, 1]; scales the travelling gust wave. */
  uWorldWindGust: { value: number };
  /** Authored wind turbulence [0, 1]; drives cross-wind foliage flutter. */
  uWorldWindTurbulence: { value: number };
  /** World seed folded to a small float; offsets every spatial hash. */
  uWorldSeed: { value: number };
  /** World time in seconds for phase-based effects. */
  uWorldTime: { value: number };
}

/** Creates a fresh uniform block initialised with safe zero defaults. */
export function createWorldSurfaceUniforms(): WorldSurfaceUniforms {
  return {
    uWorldWetness: { value: 0 },
    uWorldSnowCover: { value: 0 },
    uWorldPuddle: { value: 0 },
    uWorldWindDir: { value: new Vector2(1, 0) },
    uWorldWindStrength: { value: 0 },
    uWorldWindGust: { value: 0 },
    uWorldWindTurbulence: { value: 0 },
    uWorldSeed: { value: 0 },
    uWorldTime: { value: 0 },
  };
}

/** Optional wind character block for {@link writeWorldSurfaceUniforms}. */
export interface WorldSurfaceWindDetail {
  /** World seed; folded into a float32-exact spatial hash offset. */
  seed: number;
  /** Authored gustiness [0, 1]. */
  gustiness: number;
  /** Authored turbulence [0, 1]. */
  turbulence: number;
}

/**
 * Folds the 32-bit world seed into a small float that is exact in float32,
 * so the GLSL spatial hash sees the same offset on every GPU.
 */
export function foldWorldSurfaceSeed(seed: number): number {
  return (seed >>> 0) % 2048;
}

/**
 * Writes weather and wind state into the shared uniform block each frame.
 * Wind direction is normalised; a zero-length wind vector defaults to (1, 0).
 *
 * @param uniforms - The uniform block to write into.
 * @param weather - Current weather preset and intensity.
 * @param windX - World-space wind X component.
 * @param windZ - World-space wind Z component.
 * @param worldSeconds - Current world time in seconds.
 * @param detail - Optional seed + gust character; omitted keeps zero defaults.
 */
export function writeWorldSurfaceUniforms(
  uniforms: WorldSurfaceUniforms,
  weather: DirectorWorldWeather,
  windX: number,
  windZ: number,
  worldSeconds: number,
  detail?: WorldSurfaceWindDetail,
): void {
  uniforms.uWorldWetness.value = computeEffectiveWorldWetness(weather);
  uniforms.uWorldSnowCover.value = computeEffectiveWorldSnowCover(weather);
  uniforms.uWorldPuddle.value = computeWorldPuddleAmount(weather);
  const speed = Math.hypot(windX, windZ);
  const length = Math.max(speed, 1e-5);
  uniforms.uWorldWindDir.value.set(windX / length, windZ / length);
  uniforms.uWorldWindStrength.value = computeWorldVegetationWindStrength(speed);
  uniforms.uWorldTime.value = worldSeconds;
  if (detail) {
    uniforms.uWorldWindGust.value = Math.min(1, Math.max(0, detail.gustiness));
    uniforms.uWorldWindTurbulence.value = Math.min(1, Math.max(0, detail.turbulence));
    uniforms.uWorldSeed.value = foldWorldSurfaceSeed(detail.seed);
  }
}

// living-world-road- is skipped because TrafficLayer owns the asphalt's
// weather appearance (wet darkening + snow) explicitly; patching it here too
// would apply the wetness model twice. Traffic vehicles stay patchable.
const SKIP_SURFACE_MESH_NAME =
  /transformcontrols|viewport-ground-grid|panorama-backdrop|camera-frustum|frame-trajectory-overlay|drop-preview|living-world-effects|living-world-sky|living-world-water|director-living-world-water|director-water-|living-world-river|living-world-road-|living-world-surface|world-effect-/i;

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
uniform float uWorldWindGust;
uniform float uWorldWindTurbulence;
uniform float uWorldSeed;
uniform float uWorldTime;
varying float vWorldUpDot;
varying vec2 vWorldSurfaceXZ;
`;

/**
 * Fragment uniforms plus the seeded spatial hash shared by puddles and the
 * snow-cover edge. Pure functions of (seed, world coords): never time-random,
 * so still frames and scrubbed exports replay identically.
 */
const WORLD_SURFACE_FRAGMENT_UNIFORMS = /* glsl */ `
uniform float uWorldWetness;
uniform float uWorldSnowCover;
uniform float uWorldPuddle;
uniform float uWorldSeed;
varying float vWorldUpDot;
varying vec2 vWorldSurfaceXZ;
float directorWorldHash21(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794) + uWorldSeed * 0.0173);
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y * 43.5453);
}
float directorWorldValueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = directorWorldHash21(cell);
  float b = directorWorldHash21(cell + vec2(1.0, 0.0));
  float c = directorWorldHash21(cell + vec2(0.0, 1.0));
  float d = directorWorldHash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

const WORLD_SURFACE_NORMAL_CHUNK = /* glsl */ `
vWorldUpDot = inverseTransformDirection(transformedNormal, viewMatrix).y;
`;

/** GLSL chunk that forwards the world-space XZ of the vertex for spatial noise. */
export const WORLD_SURFACE_WORLD_POS_CHUNK = /* glsl */ `
{
  vec4 directorSurfaceWorld = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  directorSurfaceWorld = instanceMatrix * directorSurfaceWorld;
#endif
#ifdef USE_BATCHING
  directorSurfaceWorld = batchingMatrix * directorSurfaceWorld;
#endif
  directorSurfaceWorld = modelMatrix * directorSurfaceWorld;
  vWorldSurfaceXZ = directorSurfaceWorld.xz;
}
`;

/**
 * GLSL chunk that displaces vertices along the FULL wind vector, scaled by
 * height. Three layers: a steady down-wind lean (direction reads in a still
 * frame), a gust wave travelling down-wind (direction reads in motion), and a
 * turbulence-scaled cross-wind flutter. All phases derive from uWorldTime and
 * a seeded per-plant hash of the world anchor — never the wall clock.
 *
 * The lean is authored in WORLD space and pulled back into object space
 * through the transpose of the model (and instance) rotation, so a plant the
 * set dresser rotated 90° still bends down the world wind instead of down
 * its local +X. The pull-back is re-normalised to the world magnitude, so
 * scaled instances sway proportionally to their size, not to scale².
 */
export const WORLD_SURFACE_VEGETATION_SWAY_CHUNK = /* glsl */ `
{
  float height = max(transformed.y, 0.0);
  vec2 anchor = modelMatrix[3].xz;
  mat3 swayFrame = mat3(modelMatrix);
#ifdef USE_INSTANCING
  anchor += instanceMatrix[3].xz;
  swayFrame = swayFrame * mat3(instanceMatrix);
#endif
  float plantPhase = fract(sin(dot(anchor, vec2(127.1, 311.7)) + uWorldSeed * 1.618) * 43758.5453) * 6.2831853;
  float along = dot(anchor, uWorldWindDir);
  float gustWave = sin(uWorldTime * 1.6 - along * 0.35 + plantPhase) * 0.62
    + sin(uWorldTime * 2.31 - along * 0.22 + plantPhase + 1.7) * 0.38;
  float sway = 0.45 + (0.35 + 0.55 * uWorldWindGust) * gustWave;
  vec2 crossDir = vec2(-uWorldWindDir.y, uWorldWindDir.x);
  float flutter = uWorldWindTurbulence
    * (sin(uWorldTime * 6.3 + plantPhase * 3.1 + transformed.y * 2.0) * 0.7
      + sin(uWorldTime * 9.7 + plantPhase * 5.3 + 2.1) * 0.3);
  vec2 swayWorld = uWorldWindDir * sway + crossDir * (flutter * 0.35);
  // v * M multiplies by transpose(M) — the inverse of the rotation part.
  vec3 swayLocal = vec3(swayWorld.x, 0.0, swayWorld.y) * swayFrame;
  float swayLocalLength = length(swayLocal);
  if (swayLocalLength > 1e-6) swayLocal *= length(swayWorld) / swayLocalLength;
  transformed.xyz += swayLocal * (uWorldWindStrength * height * 0.055);
}
`;

/**
 * GLSL chunk that darkens diffuse colour by wetness (porosity model), pools
 * seeded low-lying puddles on near-horizontal faces, and blends snow on
 * upward-facing surfaces with a noise-broken cover edge.
 *
 * Darkening GROWS with porosity (Lagarde): absorbed water darkens porous
 * dielectrics hardest while a metal's albedo, being specular, barely moves.
 * Endpoints live in worldSurfaceResponse next to their TS mirrors.
 */
export const WORLD_SURFACE_COLOR_CHUNK = /* glsl */ `
{
  float wet = clamp(uWorldWetness, 0.0, 1.0);
  float porosity = mix(0.55, 0.08, clamp(metalness, 0.0, 1.0));
  diffuseColor.rgb *= mix(1.0, mix(${WORLD_WET_ALBEDO_SCALE_POROSITY_0.toFixed(2)}, ${WORLD_WET_ALBEDO_SCALE_POROSITY_1.toFixed(2)}, porosity), wet);
  float puddleMask = 1.0;
  float basin = directorWorldValueNoise(vWorldSurfaceXZ * 0.45);
  float puddle = clamp(uWorldPuddle, 0.0, 1.0) * puddleMask
    * smoothstep(0.86, 0.97, vWorldUpDot)
    * smoothstep(0.6, 0.82, basin);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.42 + vec3(0.015, 0.02, 0.028), puddle);
  float snowAmount = clamp(uWorldSnowCover, 0.0, 1.0);
  float snowNoise = directorWorldValueNoise(vWorldSurfaceXZ * 1.7 + 31.7);
  float snow = snowAmount * smoothstep(0.28, 0.72, vWorldUpDot)
    * min(1.0, 0.75 + 0.5 * smoothstep(0.35, 0.75, snowNoise + 0.3 * snowAmount));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.94), min(snow, 1.0) * 0.92);
}
`;

/**
 * GLSL chunk that reduces roughness by wetness (porosity model) and glazes
 * puddles. The water film smooths porous dielectrics into a sheen while
 * metals keep most of their authored microsurface, so the reduction GROWS
 * with porosity — same endpoints as the TS mirror in worldSurfaceResponse.
 */
export const WORLD_SURFACE_ROUGHNESS_CHUNK = /* glsl */ `
{
  float wet = clamp(uWorldWetness, 0.0, 1.0);
  float porosity = mix(0.55, 0.08, clamp(metalnessFactor, 0.0, 1.0));
  roughnessFactor *= mix(1.0, mix(${WORLD_WET_ROUGHNESS_SCALE_POROSITY_0.toFixed(2)}, ${WORLD_WET_ROUGHNESS_SCALE_POROSITY_1.toFixed(2)}, porosity), wet);
  float puddleMask = 1.0;
  float basin = directorWorldValueNoise(vWorldSurfaceXZ * 0.45);
  float puddle = clamp(uWorldPuddle, 0.0, 1.0) * puddleMask
    * smoothstep(0.86, 0.97, vWorldUpDot)
    * smoothstep(0.6, 0.82, basin);
  roughnessFactor = mix(roughnessFactor, 0.04, puddle);
}
`;

/**
 * Injects world-surface GLSL chunks (wetness, snow, puddles, roughness, and
 * optional vegetation sway) into the vertex and fragment shaders. Anchors on
 * standard ShaderLib includes; missing anchors no-op the matching replace.
 *
 * Vegetation variants pin porosity at 0.85 and disable puddles (water films
 * do not pool on leaves).
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
  const beginVertexChunk = vegetation
    ? `#include <begin_vertex>\n${WORLD_SURFACE_VEGETATION_SWAY_CHUNK}\n${WORLD_SURFACE_WORLD_POS_CHUNK}`
    : `#include <begin_vertex>\n${WORLD_SURFACE_WORLD_POS_CHUNK}`;
  const nextVertex = vertexShader
    .replace("#include <common>", `#include <common>\n${WORLD_SURFACE_VERTEX_UNIFORMS}`)
    .replace("#include <defaultnormal_vertex>", `#include <defaultnormal_vertex>\n${WORLD_SURFACE_NORMAL_CHUNK}`)
    .replace("#include <begin_vertex>", beginVertexChunk);
  const colorChunk = vegetation
    ? WORLD_SURFACE_COLOR_CHUNK.replace("mix(0.55, 0.08, clamp(metalness, 0.0, 1.0))", "0.85").replace(
        "float puddleMask = 1.0;",
        "float puddleMask = 0.0;",
      )
    : WORLD_SURFACE_COLOR_CHUNK;
  const roughnessChunk = vegetation
    ? WORLD_SURFACE_ROUGHNESS_CHUNK.replace("mix(0.55, 0.08, clamp(metalnessFactor, 0.0, 1.0))", "0.85").replace(
        "float puddleMask = 1.0;",
        "float puddleMask = 0.0;",
      )
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
    parameters.uniforms.uWorldPuddle = uniforms.uWorldPuddle;
    parameters.uniforms.uWorldWindDir = uniforms.uWorldWindDir;
    parameters.uniforms.uWorldWindStrength = uniforms.uWorldWindStrength;
    parameters.uniforms.uWorldWindGust = uniforms.uWorldWindGust;
    parameters.uniforms.uWorldWindTurbulence = uniforms.uWorldWindTurbulence;
    parameters.uniforms.uWorldSeed = uniforms.uWorldSeed;
    parameters.uniforms.uWorldTime = uniforms.uWorldTime;
    const injected = injectWorldSurfaceShaders(parameters.vertexShader, parameters.fragmentShader, vegetation);
    parameters.vertexShader = injected.vertexShader;
    parameters.fragmentShader = injected.fragmentShader;
  };
  material.customProgramCacheKey = () => {
    const previous = previousCacheKey.call(material);
    return `${previous}|director-world-surface-v2|veg=${vegetation ? 1 : 0}`;
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
