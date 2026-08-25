import {
  Color,
  DoubleSide,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type CubeTexture,
  type IUniform,
} from "three";
import type { DirectorWorldWaterBody } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import { evaluateWorldTimeOfDayHours } from "../worldTime";
import {
  computeWaterDetailPhase,
  computeWaterRainAgitation,
  computeWaterSkyReflectionInto,
  computeWaterSunColorInto,
  computeWaterSunDirectionInto,
  computeWaterSunIntensity,
  computeWaterTroughLift,
} from "../water/waterParams";

interface RiverUniforms {
  [name: string]: IUniform;
  uTime: IUniform<number>;
  uFlowSpeed: IUniform<number>;
  uWaveAmplitude: IUniform<number>;
  uFoamIntensity: IUniform<number>;
  uOpacity: IUniform<number>;
  uColorShallow: IUniform<Color>;
  uColorDeep: IUniform<Color>;
  uSkyHorizon: IUniform<Color>;
  uSkyZenith: IUniform<Color>;
  uEnvMap: IUniform<CubeTexture | null>;
  uEnvBlend: IUniform<number>;
  uSunDirection: IUniform<Vector3>;
  uSunColor: IUniform<Color>;
  uSunIntensity: IUniform<number>;
  uWindRoughness: IUniform<number>;
  uRainAgitation: IUniform<number>;
  uPhase: IUniform<number>;
  uTroughLift: IUniform<number>;
}

/** Typed {@link ShaderMaterial} whose uniforms block is narrowed to the river uniform set. */
export interface RiverSurfaceMaterial extends ShaderMaterial {
  uniforms: RiverUniforms;
}

/**
 * Vertex-stage peak trough depth as a multiple of `uWaveAmplitude`.
 * Matches `sin * amp * (0.28 + rapid * 0.72) + sin * amp * 0.22` at rapid=1.
 */
export const RIVER_WAVE_TROUGH_FACTOR = 1.22;

/**
 * Returns the lowest Y among the river's control points, or the body center Y
 * when no river points are authored.
 *
 * @param body - The water body descriptor whose river points are inspected.
 * @returns The minimum Y coordinate of the river centerline.
 */
export function riverSurfaceMinY(body: DirectorWorldWaterBody): number {
  const points = body.river?.points;
  if (!points || points.length === 0) return body.surface.center[1];
  let minY = points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    minY = Math.min(minY, points[index][1]);
  }
  return minY;
}

/**
 * Samples the ground height under each river control point and returns the
 * maximum, falling back to a caller-provided height when no sampler is available.
 *
 * Used to determine the highest occluder below the river for trough-lift
 * computation when a height map is available.
 *
 * @param body - The water body descriptor.
 * @param fallbackHeight - Default height when no sampler is provided.
 * @param sampleGroundHeight - Optional function that returns the ground Y at (x, z).
 * @returns The highest ground height found under the river's control points.
 */
export function resolveRiverOccluderHeight(
  body: DirectorWorldWaterBody,
  fallbackHeight: number,
  sampleGroundHeight?: (x: number, z: number) => number | null,
): number {
  let height = fallbackHeight;
  const points = body.river?.points;
  if (!sampleGroundHeight || !points) return height;
  for (const point of points) {
    const hit = sampleGroundHeight(point[0], point[2]);
    if (hit != null && hit > height) height = hit;
  }
  return height;
}

/**
 * Vertex shader for river surfaces.
 *
 * Displaces each vertex vertically with a two-octave sin wave whose amplitude
 * is scaled by the local slope (rapids) and curvature. The displaced position,
 * world normal, tangent, slope, and curvature are passed to the fragment stage.
 */
export const RIVER_VERTEX_SHADER = /* glsl */ `
attribute vec3 aFlowTangent;
attribute float aSlope;
attribute float aCurvature;

uniform float uTime;
uniform float uFlowSpeed;
uniform float uWaveAmplitude;
uniform float uTroughLift;

varying vec2 vRiverUv;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying float vSlope;
varying float vCurvature;

#include <fog_pars_vertex>

void main() {
  float rapid = clamp(aSlope * 2.5 + aCurvature * 0.8, 0.0, 1.0);
  float phase = uv.y * 5.4 - uTime * max(uFlowSpeed, 0.05) * 3.0 + uv.x * 2.2;
  float wave = sin(phase) * uWaveAmplitude * (0.28 + rapid * 0.72);
  wave += sin(phase * 1.73 + uv.x * 7.0) * uWaveAmplitude * 0.22;

  vec3 displaced = position;
  displaced.y += wave + uTroughLift;
  vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
  vec4 mvPosition = viewMatrix * worldPosition;

  vRiverUv = uv;
  vWorldPosition = worldPosition.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vWorldTangent = normalize(mat3(modelMatrix) * aFlowTangent);
  vSlope = aSlope;
  vCurvature = aCurvature;

  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/**
 * Fragment shader for river surfaces.
 *
 * Shading model: travelling sinusoid + value-noise normal perturbation →
 * Schlick fresnel → procedural sky reflection blended with the shared
 * environment probe → Blinn-Phong sun specular (broad + sharp lobes) →
 * bank foam + rapid foam broken up by noise.
 */
export const RIVER_FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform float uFlowSpeed;
uniform float uFoamIntensity;
uniform float uOpacity;
uniform vec3 uColorShallow;
uniform vec3 uColorDeep;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform samplerCube uEnvMap;
uniform float uEnvBlend;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uWindRoughness;
uniform float uRainAgitation;
uniform float uPhase;

varying vec2 vRiverUv;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying float vSlope;
varying float vCurvature;

#include <fog_pars_fragment>

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
}

void main() {
  vec3 baseNormal = normalize(vWorldNormal);
  vec3 tangent = normalize(vWorldTangent);
  vec3 lateral = normalize(cross(baseNormal, tangent));
  float travel = vRiverUv.y - uTime * max(uFlowSpeed, 0.05) * 0.22;

  float bandA = sin(travel * 29.0 + vRiverUv.x * 13.0 + uPhase);
  float bandB = sin(travel * 53.0 - vRiverUv.x * 21.0 + uPhase * 1.7);
  float micro = valueNoise(vec2(vRiverUv.x * 34.0, travel * 19.0) + uPhase) * 2.0 - 1.0;
  float rain = valueNoise(vec2(vRiverUv.x * 91.0, travel * 67.0 + uTime * 2.4));
  float roughness = 0.035 + uWindRoughness * 0.12;
  vec3 normal = normalize(
    baseNormal +
    lateral * (bandA * roughness + micro * roughness * 0.65) +
    tangent * (bandB * roughness * 0.72 + (rain - 0.5) * uRainAgitation * 0.16)
  );

  float bankDistance = min(vRiverUv.x, 1.0 - vRiverUv.x) * 2.0;
  float channelDepth = smoothstep(0.05, 0.72, bankDistance);
  vec3 body = mix(uColorShallow, uColorDeep, channelDepth);

  vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
  float nDotV = max(dot(normal, viewDirection), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - nDotV, 5.0);
  vec3 reflected = reflect(-viewDirection, normal);
  float skyHeight = smoothstep(-0.12, 0.8, reflected.y);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, skyHeight);
  // Shared environment probe (../water/waterEnvProbe.ts) blended over the
  // procedural sky; uEnvBlend stays 0 until the probe's first capture. Cube
  // LOD is biased by the wind/rain strengths that already roughen the normal
  // (textureCubeLodEXT compiles to textureLod under three's GLSL3 prefix).
  float envLod = 1.0 + uWindRoughness * 2.5 + uRainAgitation * 2.0;
  vec3 envColor = textureCubeLodEXT(uEnvMap, reflected, envLod).rgb;
  vec3 reflection = mix(sky, envColor, uEnvBlend);
  vec3 color = mix(body * 0.64, reflection, clamp(0.2 + fresnel * 0.82, 0.0, 0.94));

  vec3 halfVector = normalize(viewDirection + normalize(uSunDirection));
  float broadSpecular = pow(max(dot(normal, halfVector), 0.0), 42.0);
  float sharpGlint = pow(max(dot(normal, halfVector), 0.0), 180.0);
  color += uSunColor * uSunIntensity * (broadSpecular * 0.3 + sharpGlint * 0.75);

  float bankFoam = 1.0 - smoothstep(0.0, 0.13, bankDistance);
  float rapidFoam = clamp(vSlope * 1.8 + vCurvature * 1.25, 0.0, 1.0);
  float foamBreakup = smoothstep(0.38, 0.72, valueNoise(vec2(vRiverUv.x * 17.0, travel * 11.0) + uPhase));
  float foam = clamp((bankFoam * 0.75 + rapidFoam * foamBreakup) * uFoamIntensity, 0.0, 1.0);
  color = mix(color, vec3(0.88, 0.94, 0.96), foam);

  gl_FragColor = vec4(color, uOpacity);
  #include <fog_fragment>
}
`;

/**
 * Creates a {@link RiverSurfaceMaterial} initialized from the body's authored
 * values. The material is transparent, double-sided, depth-write disabled, and
 * includes Three.js fog support.
 *
 * @param body - The authored water-body descriptor.
 * @returns A new material whose uniforms are seeded from the body.
 */
export function createRiverSurfaceMaterial(body: DirectorWorldWaterBody): RiverSurfaceMaterial {
  const material = new ShaderMaterial({
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog),
      uTime: { value: 0 },
      uFlowSpeed: { value: body.flowSpeedMps },
      uWaveAmplitude: { value: body.waveAmplitude },
      uFoamIntensity: { value: body.foamIntensity },
      uOpacity: { value: body.opacity },
      uColorShallow: { value: new Color(body.colorShallow) },
      uColorDeep: { value: new Color(body.colorDeep) },
      uSkyHorizon: { value: new Color() },
      uSkyZenith: { value: new Color() },
      uEnvMap: { value: null },
      uEnvBlend: { value: 0 },
      uSunDirection: { value: new Vector3() },
      uSunColor: { value: new Color() },
      uSunIntensity: { value: 1 },
      uWindRoughness: { value: 0 },
      uRainAgitation: { value: 0 },
      uPhase: { value: 0 },
      uTroughLift: { value: 0 },
    },
    vertexShader: RIVER_VERTEX_SHADER,
    fragmentShader: RIVER_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: true,
  }) as RiverSurfaceMaterial;
  material.name = `director-river-${body.id}`;
  return material;
}

/**
 * Writes per-frame uniform values for a river surface. All writes are in-place
 * mutations of existing Vector/Color objects — no allocations per frame.
 *
 * @param material - The river material whose uniforms are updated.
 * @param body - The authored water-body descriptor.
 * @param context - The living-world frame context (time, weather, wind, seed).
 * @param occluderHeight - The highest ground height under the river for trough-lift
 *   computation; defaults to the context's ground height.
 */
export function writeRiverFrameUniforms(
  material: RiverSurfaceMaterial,
  body: DirectorWorldWaterBody,
  context: LivingWorldFrameContext,
  occluderHeight: number = context.groundHeight,
) {
  const uniforms = material.uniforms;
  const hours = evaluateWorldTimeOfDayHours(context.settings.timeOfDay, context.worldSeconds);
  const windSpeed = Math.hypot(...context.windVector);
  // Weather comes from the evaluated climate (authored block in static mode).
  const climate = context.climate;
  const weather = climate.weather;
  uniforms.uTime.value = context.worldSeconds;
  uniforms.uFlowSpeed.value = body.flowSpeedMps;
  uniforms.uWaveAmplitude.value = body.waveAmplitude;
  uniforms.uFoamIntensity.value = body.foamIntensity;
  uniforms.uOpacity.value = body.opacity;
  uniforms.uColorShallow.value.set(body.colorShallow);
  uniforms.uColorDeep.value.set(body.colorDeep);
  uniforms.uWindRoughness.value = Math.min(1, windSpeed / 9);
  uniforms.uRainAgitation.value = computeWaterRainAgitation(weather, climate);
  uniforms.uPhase.value = computeWaterDetailPhase(context.seed, body.id);
  uniforms.uTroughLift.value = computeWaterTroughLift(
    riverSurfaceMinY(body),
    body.waveAmplitude * RIVER_WAVE_TROUGH_FACTOR,
    occluderHeight,
  );
  computeWaterSkyReflectionInto(uniforms.uSkyHorizon.value, uniforms.uSkyZenith.value, hours, weather, climate);
  computeWaterSunDirectionInto(uniforms.uSunDirection.value, hours);
  computeWaterSunColorInto(uniforms.uSunColor.value, hours);
  uniforms.uSunIntensity.value = computeWaterSunIntensity(hours, weather.cloudCover);
}
