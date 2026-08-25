import { MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking } from "three";

/**
 * Vertex-shader part articulation for the herd placeholder InstancedMesh.
 *
 * The geometry carries per-vertex part metadata (`aPartId`, `aPartPivot`,
 * `aPartAxis`; see placeholderModels.ts) and the render layer streams two
 * per-instance vec4 attributes (`aPartAngles0/1`, 8 angle slots) computed on
 * the CPU by the pure gait functions in wildlifeGait.ts. The shader itself is
 * intentionally dumb — "rotate (position − pivot) about axis by the selected
 * angle" — so all species/behavior logic stays in unit-testable TypeScript
 * and the whole group remains ONE draw call (plus one shadow draw via the
 * matching depth material).
 *
 * Injection uses the long-stable `common` / `beginnormal_vertex` /
 * `begin_vertex` chunk anchors. If an anchor were ever missing, `replace` is
 * a no-op and the mesh renders rigid instead of crashing (tests pin the
 * anchors against the real three ShaderLib sources).
 */

/** Per-instance angle attribute name for slots 0..3 (vec4). */
export const WILDLIFE_PART_ANGLES_ATTRIBUTE_0 = "aPartAngles0";
/** Per-instance angle attribute name for slots 4..7 (vec4). */
export const WILDLIFE_PART_ANGLES_ATTRIBUTE_1 = "aPartAngles1";

/**
 * GLSL attribute declarations plus helper functions, injected after
 * `#include <common>` in the standard MeshStandardMaterial vertex shader.
 */
export const WILDLIFE_PART_VERTEX_PRELUDE = /* glsl */ `
attribute float aPartId;
attribute vec3 aPartPivot;
attribute vec3 aPartAxis;
attribute vec4 aPartAngles0;
attribute vec4 aPartAngles1;

float wildlifePick4(vec4 v, float id) {
  return mix(mix(v.x, v.y, step(0.5, id)), mix(v.z, v.w, step(2.5, id)), step(1.5, id));
}

float wildlifePartAngleRad() {
  return mix(wildlifePick4(aPartAngles0, aPartId), wildlifePick4(aPartAngles1, aPartId - 4.0), step(3.5, aPartId));
}

vec3 wildlifeRotateAboutAxis(vec3 p, vec3 axis, float angleRad) {
  float c = cos(angleRad);
  float s = sin(angleRad);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}
`;

/**
 * Rotates the vertex position about its part pivot, injected after
 * `#include <begin_vertex>`.
 */
export const WILDLIFE_PART_POSITION_CHUNK = /* glsl */ `
{
  float wildlifePositionAngle = wildlifePartAngleRad();
  transformed = aPartPivot + wildlifeRotateAboutAxis(transformed - aPartPivot, aPartAxis, wildlifePositionAngle);
}
`;

/**
 * Rotates the vertex normal to match the part rotation, injected after
 * `#include <beginnormal_vertex>`.
 */
export const WILDLIFE_PART_NORMAL_CHUNK = /* glsl */ `
{
  float wildlifeNormalAngle = wildlifePartAngleRad();
  objectNormal = wildlifeRotateAboutAxis(objectNormal, aPartAxis, wildlifeNormalAngle);
}
`;

/** Pure string transform so tests can verify the injection without a GL context. */
export function injectWildlifePartVertexShader(vertexShader: string): string {
  return vertexShader
    .replace("#include <common>", `#include <common>\n${WILDLIFE_PART_VERTEX_PRELUDE}`)
    .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\n${WILDLIFE_PART_NORMAL_CHUNK}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${WILDLIFE_PART_POSITION_CHUNK}`);
}

/**
 * Tinted standard material with the part-articulation vertex stage. All herd
 * materials share one program (constant cache key; the tint is a uniform).
 */
export function createWildlifePartMaterial(tintHex: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: tintHex,
    roughness: 0.9,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = injectWildlifePartVertexShader(shader.vertexShader);
  };
  material.customProgramCacheKey = () => "wildlife-part-v1";
  return material;
}

/**
 * Shadow-pass counterpart: without this, animated legs would cast rigid
 * shadows. Assign to `mesh.customDepthMaterial`.
 */
export function createWildlifePartDepthMaterial(): MeshDepthMaterial {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = injectWildlifePartVertexShader(shader.vertexShader);
  };
  material.customProgramCacheKey = () => "wildlife-part-depth-v1";
  return material;
}
