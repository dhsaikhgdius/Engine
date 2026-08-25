import {
  Color,
  DoubleSide,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type CubeTexture,
  type IUniform,
  type Texture,
} from "three";
import type { DirectorWorldWaterBody } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import { evaluateWorldTimeOfDayHours } from "../worldTime";
import {
  WORLD_HEIGHT_MAP_RESOLUTION,
  WORLD_HEIGHT_MAP_SAMPLE_GLSL,
  createWorldHeightMapSampleUniforms,
} from "../surface/worldHeightMap";
import {
  GERSTNER_SHARED_GLSL,
  WATER_GERSTNER_WAVE_COUNT,
  getGerstnerWaveDirectionRadians,
  type GerstnerWave,
} from "./gerstner";
import {
  WATER_FOAM_CREST_END,
  WATER_FOAM_CREST_START,
  blendFlowDirectionWithWind,
  computeWaterBodyLightLevel,
  computeWaterMicroRippleStrength,
  computeWaterRainAgitation,
  computeWaterSkyReflectionInto,
  computeWaterSunColorInto,
  computeWaterSunDirectionInto,
  computeWaterSunIntensity,
  computeWaterTroughLift,
  computeWindAmplitudeScale,
  computeWindSteepnessScale,
} from "./waterParams";

/**
 * ShaderMaterial for one water body.
 *
 * CPU/GPU split: the CPU owns everything that must be deterministic and
 * queryable (wave spectrum, wind blending, sun position, sky-reflection
 * tints, weather couplings) and ships it as uniforms; the GPU owns
 * per-vertex Gerstner displacement (mirrored from gerstner.ts) and per-pixel
 * shading. Per rendered frame only uniform values change — geometry and
 * material objects are reused.
 *
 * Shading model (fragment stage):
 * - normal = Gerstner vertex normal ⊕ two scrolling trig-noise detail bands
 *   ⊕ wind-scaled micro-ripple noise ⊕ weather-gated rain-pocking noise;
 * - fresnel: Schlick F = F0 + (1 − F0)(1 − N·V)^5 with water F0 = 0.02;
 * - reflection: procedural two-band sky (horizon→zenith by reflected-ray
 *   elevation) from CPU tints, blended toward the shared low-res environment
 *   probe (waterEnvProbe.ts) by uEnvBlend once the probe holds a capture —
 *   uEnvBlend defaults to 0, so the procedural sky stays the guarantee when
 *   no probe refresh has happened (tests, first frame, GL-less environments);
 * - sun specular: Blinn-Phong with a broad rough lobe plus a sharp glint
 *   lobe, tinted by the solar-arc sun color and damped by cloud cover;
 * - crest foam plus a rectangle-edge rim, enhanced by the camera-centred
 *   height map when nearby banks sit at water height (see worldHeightMap.ts).
 */

/** Detail-layer scroll rates (m/s) as multiples of flow speed plus drift. */
const DETAIL_SCROLL_A_FLOW_FACTOR = 0.35;
const DETAIL_SCROLL_A_BASE_MPS = 0.04;
const DETAIL_SCROLL_A_WIND_FACTOR = 0.012;
const DETAIL_SCROLL_B_FLOW_FACTOR = 0.9;
const DETAIL_SCROLL_B_BASE_MPS = 0.11;
const DETAIL_SCROLL_B_WIND_FACTOR = 0.03;

/**
 * Typed uniform block for a {@link WaterSurfaceMaterial}. Every uniform the
 * vertex and fragment shaders reference is declared here so the CPU-side
 * {@link writeWaterFrameUniforms} write path is statically checked.
 */
export interface WaterSurfaceUniforms {
  [uniform: string]: IUniform;
  /** World time in seconds; drives wave phase, detail scroll, and rain re-seeding. */
  uTime: IUniform<number>;
  /** Packed Gerstner-wave direction × wave-number × angular-frequency (half A). */
  uGerstnerWaveA: IUniform<Vector4[]>;
  /** Packed Gerstner-wave amplitude, steepness, steepness limit, phase offset (half B). */
  uGerstnerWaveB: IUniform<Vector4[]>;
  /** Wind-speed-derived amplitude scaler applied to all waves. */
  uGerstnerAmplitudeScale: IUniform<number>;
  /** Wind-speed-derived steepness scaler applied to all waves. */
  uGerstnerSteepnessScale: IUniform<number>;
  /** Normalizer that maps the raw displacement Y to [-1, 1] crest mask. */
  uCrestNormalizer: IUniform<number>;
  /** Vertical lift to keep wave troughs above the opaque ground plane. */
  uTroughLift: IUniform<number>;
  /** Shallow-water colour (near shore / top-down view). */
  uColorShallow: IUniform<Color>;
  /** Deep-water colour (grazing angles / open water). */
  uColorDeep: IUniform<Color>;
  /** Base opacity of the water surface. */
  uOpacity: IUniform<number>;
  /** Foam intensity multiplier from the body authoring controls. */
  uFoamIntensity: IUniform<number>;
  /** World-space sun direction for specular and sky-reflection computation. */
  uSunDirection: IUniform<Vector3>;
  /** Sun specular intensity, already damped by cloud cover. */
  uSunIntensity: IUniform<number>;
  /** Solar-arc tint applied to the sun specular lobes. */
  uSunColor: IUniform<Color>;
  /** Procedural-sky horizon tint (weather- and time-coupled). */
  uSkyHorizonColor: IUniform<Color>;
  /** Procedural-sky zenith tint (weather- and time-coupled). */
  uSkyZenithColor: IUniform<Color>;
  /** Shared low-res environment-probe cube texture; null until the first capture. */
  uEnvMap: IUniform<CubeTexture | null>;
  /** Blend weight between procedural sky (0) and the environment probe (1). */
  uEnvBlend: IUniform<number>;
  /** Ambient body-light level derived from sun elevation and weather. */
  uBodyLight: IUniform<number>;
  /** Wind-driven micro-ripple strength; 0 = glassy calm. */
  uMicroRipple: IUniform<number>;
  /** Rain-pocking agitation strength; 0 = no rain. */
  uRainAgitation: IUniform<number>;
  /** Wind-blended flow direction (unit vector in XZ). */
  uFlowDirection: IUniform<Vector2>;
  /** Scroll rate for detail band A (broad ripples). */
  uDetailScrollA: IUniform<Vector2>;
  /** Scroll rate for detail band B (fine chop). */
  uDetailScrollB: IUniform<Vector2>;
  /** Per-body phase seed that decorrelates noise across water bodies. */
  uDetailPhase: IUniform<number>;
  /** Optional height-map texture for shoreline foam detection. */
  uOcclusionMap: IUniform<Texture | null>;
  /** World-space origin of the height-map coverage area. */
  uOcclusionOrigin: IUniform<Vector3>;
  /** World-space side length of the height-map coverage area. */
  uOcclusionSize: IUniform<number>;
  /** Blend weight for the height-map shoreline foam effect. */
  uOcclusionBlend: IUniform<number>;
}

/** Typed {@link ShaderMaterial} whose uniforms block is narrowed to {@link WaterSurfaceUniforms}. */
export interface WaterSurfaceMaterial extends ShaderMaterial {
  uniforms: WaterSurfaceUniforms;
}

/**
 * Gerstner-displacement vertex shader for water surfaces.
 *
 * Evaluates the wave spectrum in world space so wave directions stay
 * compass-aligned regardless of body rotation. Outputs the displaced world
 * position, wave normal, and a crest mask for the fragment stage.
 */
export const WATER_VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uCrestNormalizer;
uniform float uTroughLift;
${GERSTNER_SHARED_GLSL}
varying vec3 vWorldPosition;
varying vec3 vWaveNormal;
varying float vCrest;
varying vec2 vUv;

void main() {
  // Evaluate in world space so wave directions stay compass-aligned no matter
  // how the body rectangle is rotated or where the SceneRoot group sits.
  vec4 anchorWorld = modelMatrix * vec4(position, 1.0);
  vec3 surfaceOffset;
  vec3 surfaceNormal;
  directorGerstnerEvaluate(anchorWorld.xz, uTime, surfaceOffset, surfaceNormal);
  // uTroughLift keeps wave troughs above the opaque ground plane, which would
  // otherwise depth-reject them (see computeWaterTroughLift in waterParams.ts).
  vec3 displaced = anchorWorld.xyz + surfaceOffset + vec3(0.0, uTroughLift, 0.0);
  vWorldPosition = displaced;
  vWaveNormal = surfaceNormal;
  vCrest = clamp(surfaceOffset.y * uCrestNormalizer, -1.0, 1.0);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(displaced, 1.0);
}
`;

/**
 * Fragment shader for water surfaces.
 *
 * Shading model: Gerstner normal ⊕ detail-band normals ⊕ micro-ripple ⊕ rain
 * pocking → Schlick fresnel → procedural sky reflection blended with the
 * shared environment probe → Blinn-Phong sun specular (broad + sharp lobes) →
 * crest foam streaked along flow → edge-rim foam → height-map shoreline foam.
 */
export const WATER_FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform vec3 uColorShallow;
uniform vec3 uColorDeep;
uniform float uOpacity;
uniform float uFoamIntensity;
uniform vec3 uSunDirection;
uniform float uSunIntensity;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizonColor;
uniform vec3 uSkyZenithColor;
uniform samplerCube uEnvMap;
uniform float uEnvBlend;
uniform float uBodyLight;
uniform float uMicroRipple;
uniform float uRainAgitation;
uniform vec2 uFlowDirection;
uniform vec2 uDetailScrollA;
uniform vec2 uDetailScrollB;
uniform float uDetailPhase;
uniform sampler2D uOcclusionMap;
uniform vec3 uOcclusionOrigin;
uniform float uOcclusionSize;
uniform float uOcclusionBlend;
varying vec3 vWorldPosition;
varying vec3 vWaveNormal;
varying float vCrest;
varying vec2 vUv;

${WORLD_HEIGHT_MAP_SAMPLE_GLSL}

// Deterministic coordinate hash. uDetailPhase decorrelates bodies; the seed
// argument decorrelates the different noise consumers (foam, micro, rain).
float directorWaterHash(vec2 p, float seed) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + uDetailPhase + seed * 269.5) * 43758.5453123);
}

float directorWaterValueNoise(vec2 p, float seed) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = directorWaterHash(cell, seed);
  float b = directorWaterHash(cell + vec2(1.0, 0.0), seed);
  float c = directorWaterHash(cell + vec2(0.0, 1.0), seed);
  float d = directorWaterHash(cell + vec2(1.0, 1.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Value noise with its analytic gradient in one evaluation: (d/dx, d/dy, value).
vec3 directorWaterNoiseGradient(vec2 p, float seed) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = directorWaterHash(cell, seed);
  float b = directorWaterHash(cell + vec2(1.0, 0.0), seed);
  float c = directorWaterHash(cell + vec2(0.0, 1.0), seed);
  float d = directorWaterHash(cell + vec2(1.0, 1.0), seed);
  float value = mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  vec2 gradient = vec2(mix(b - a, d - c, u.y) * du.x, mix(c - a, d - b, u.x) * du.y);
  return vec3(gradient, value);
}

// Detail bands A (broad ripples) and B (fine chop) scrolling along the
// blended flow direction at different rates. Analytic gradients of fixed
// incommensurate sinusoids — no textures, fully deterministic in uTime.
vec2 directorWaterDetailGradient(vec2 p) {
  vec2 pa = p * 1.35 - uDetailScrollA * uTime;
  vec2 pb = p * 3.9 - uDetailScrollB * uTime;
  vec2 gradient = vec2(0.0);
  gradient += vec2(0.86, 0.51) * cos(dot(pa, vec2(0.86, 0.51)) * 2.0 + uDetailPhase) * 2.0;
  gradient += vec2(-0.34, 0.94) * cos(dot(pa, vec2(-0.34, 0.94)) * 2.7 + 1.3) * 2.7;
  gradient += vec2(0.72, -0.69) * cos(dot(pb, vec2(0.72, -0.69)) * 3.1 + 2.1) * 1.8;
  gradient += vec2(-0.58, -0.81) * cos(dot(pb, vec2(-0.58, -0.81)) * 4.3 + 4.9) * 1.5;
  return gradient;
}

// Third band: wind-driven micro ripples (two value-noise octaves) that
// roughen the sheen; strength arrives via uMicroRipple (0 = glassy calm).
vec2 directorWaterMicroGradient(vec2 p) {
  vec2 pm = p * 4.6 - uDetailScrollB * (uTime * 1.7);
  vec2 gradient = directorWaterNoiseGradient(pm, 3.7).xy;
  gradient += directorWaterNoiseGradient(pm * 2.15 + 31.7, 5.1).xy * 0.55;
  return gradient;
}

// Rain agitation: the noise lattice re-seeds ~6×/s and two consecutive
// fields crossfade, so the surface churns in place (rain-pocked sparkle)
// instead of scrolling. Purely uTime-driven — deterministic.
vec2 directorWaterRainGradient(vec2 p) {
  float cellRate = uTime * 6.0;
  float step0 = floor(cellRate);
  float blend = smoothstep(0.0, 1.0, fract(cellRate));
  vec2 pr = p * 6.2;
  vec2 g0 = directorWaterNoiseGradient(pr, 7.9 + step0).xy;
  vec2 g1 = directorWaterNoiseGradient(pr, 8.9 + step0).xy;
  return mix(g0, g1, blend);
}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 baseNormal = normalize(vWaveNormal);
  if (!gl_FrontFacing) baseNormal = -baseNormal;

  // Height-field slopes: detail bands + wind micro ripples + rain pocking.
  vec2 slope = directorWaterDetailGradient(vWorldPosition.xz) * 0.085;
  slope += directorWaterMicroGradient(vWorldPosition.xz) * (0.55 * uMicroRipple);
  slope += directorWaterRainGradient(vWorldPosition.xz) * (0.5 * uRainAgitation);
  vec3 normal = normalize(baseNormal + vec3(-slope.x, 0.0, -slope.y));

  float ndv = clamp(dot(normal, viewDir), 0.0, 1.0);
  float grazing = pow(1.0 - ndv, 3.0);
  // Schlick fresnel with water's F0 = 0.02: ~2% reflection looking straight
  // down, approaching 1 at grazing incidence — the sky term must win there.
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // Real depth reads are unavailable, so viewing angle stands in for depth:
  // looking straight down reads shallow, grazing angles read deep. A floor of
  // 0.22 keeps top-down shots from washing out to pure shallow color.
  float depthMix = clamp(0.22 + 0.78 * grazing, 0.0, 1.0);
  vec3 bodyColor = mix(uColorShallow, uColorDeep, depthMix) * uBodyLight;

  // Procedural sky reflection: horizon tint blended toward the zenith tint by
  // the reflected ray's elevation (no environment map is guaranteed, so the
  // CPU ships solar-arc/weather-coupled tints instead of an env sample).
  vec3 reflectDir = reflect(-viewDir, normal);
  float skyElevation = pow(clamp(reflectDir.y, 0.0, 1.0), 0.6);
  vec3 skyColor = mix(uSkyHorizonColor, uSkyZenithColor, skyElevation);

  // Shared 128px environment probe (waterEnvProbe.ts): real surroundings
  // (buildings, fire, terrain) blended over the procedural sky. uEnvBlend is
  // 0 until the probe's first capture, so the procedural fallback always
  // renders. The cube LOD is biased by the same strengths that roughen the
  // normal, so agitated water reflects a blurrier world; textureCubeLodEXT
  // compiles to textureLod under three's GLSL3 prefix.
  float envLod = 1.0 + uMicroRipple * 2.5 + uRainAgitation * 2.0;
  vec3 envColor = textureCubeLodEXT(uEnvMap, reflectDir, envLod).rgb;
  vec3 reflectionColor = mix(skyColor, envColor, uEnvBlend);

  vec3 color = mix(bodyColor, reflectionColor, fresnel);

  // Sun specular: broad rough Blinn-Phong lobe + sharp glint lobe, tinted by
  // the solar-arc sun color. uSunIntensity already carries cloud damping, so
  // under storm skies the sky reflection dominates and the lobes recede.
  vec3 sunDir = normalize(uSunDirection);
  vec3 halfway = normalize(viewDir + sunDir);
  float ndh = clamp(dot(normal, halfway), 0.0, 1.0);
  float specular = pow(ndh, 42.0) * 0.18 + pow(ndh, 640.0) * 1.5;
  color += uSunColor * specular * uSunIntensity;

  // Crest foam — mirrors evaluateFoamCrestMask() in waterParams.ts through
  // the interpolated constants, streaked by hash noise elongated along flow.
  float crest = clamp(vCrest, 0.0, 1.0);
  float crestMask = smoothstep(${WATER_FOAM_CREST_START.toFixed(3)}, ${WATER_FOAM_CREST_END.toFixed(3)}, crest)
    * clamp(uFoamIntensity, 0.0, 1.0);
  vec2 flowPerp = vec2(-uFlowDirection.y, uFlowDirection.x);
  vec2 foamCoord = vec2(
    dot(vWorldPosition.xz, flowPerp) * 2.2,
    dot(vWorldPosition.xz, uFlowDirection) * 0.55 - dot(uDetailScrollB, uFlowDirection) * uTime
  );
  float streaks = directorWaterValueNoise(foamCoord, 0.0) * 0.65
    + directorWaterValueNoise(foamCoord * 2.7 + 17.0, 0.0) * 0.35;
  float foam = clamp(crestMask * (0.3 + 0.7 * smoothstep(0.35, 0.75, streaks)), 0.0, 1.0);
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 foamColor = mix(vec3(luma), vec3(1.0), 0.72) * (0.85 + 0.3 * streaks);
  color = mix(color, foamColor, foam);

  // Rectangle-edge rim, plus height-map shoreline foam when a bank sits near
  // the waterline just outside the authored bounds. Water itself is excluded
  // from the height pass, so the sample looks at neighbouring solid geometry.
  float edgeDistance = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float rim = (1.0 - smoothstep(0.006, 0.05, edgeDistance)) * clamp(uFoamIntensity, 0.0, 1.0);
  float rimStreak = directorWaterValueNoise(vWorldPosition.xz * 3.1 + uFlowDirection * (uTime * 0.35), 11.0);
  color = mix(color, color * 0.8, rim * 0.4);
  color = mix(color, foamColor, rim * rimStreak * 0.35);

  vec2 shoreUv = directorWorldHeightMapUv(vWorldPosition, uOcclusionOrigin, uOcclusionSize);
  vec2 outward = vUv - vec2(0.5);
  float outwardLen = length(outward);
  outward = outwardLen > 0.001 ? outward / outwardLen : vec2(0.0, 1.0);
  vec2 bankUv = shoreUv + outward * (2.5 / ${WORLD_HEIGHT_MAP_RESOLUTION.toFixed(1)});
  float inMap = step(0.01, bankUv.x) * step(bankUv.x, 0.99) * step(0.01, bankUv.y) * step(bankUv.y, 0.99);
  float bankY = directorWorldUnpackHeight(texture2D(uOcclusionMap, bankUv).r);
  float shoreBand = smoothstep(0.45, 0.04, abs(bankY - vWorldPosition.y));
  float shore = rim * shoreBand * inMap * uOcclusionBlend;
  color = mix(color, foamColor, shore * 0.65);

  float alpha = clamp(uOpacity * (0.8 + 0.2 * grazing) + fresnel * 0.22 + foam * 0.15 + rim * 0.08 + shore * 0.1, 0.0, 1.0);
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function createWaveVectorArray(): Vector4[] {
  const vectors: Vector4[] = [];
  for (let index = 0; index < WATER_GERSTNER_WAVE_COUNT; index += 1) vectors.push(new Vector4());
  return vectors;
}

/**
 * Allocates a fresh {@link WaterSurfaceUniforms} block with sensible defaults.
 * The returned object is mutated in place by the per-frame write path.
 */
export function createWaterSurfaceUniforms(): WaterSurfaceUniforms {
  return {
    uTime: { value: 0 },
    uGerstnerWaveA: { value: createWaveVectorArray() },
    uGerstnerWaveB: { value: createWaveVectorArray() },
    uGerstnerAmplitudeScale: { value: 1 },
    uGerstnerSteepnessScale: { value: 1 },
    uCrestNormalizer: { value: 1 },
    uTroughLift: { value: 0 },
    uColorShallow: { value: new Color("#4fb3c7") },
    uColorDeep: { value: new Color("#04364d") },
    uOpacity: { value: 0.9 },
    uFoamIntensity: { value: 0.5 },
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uSunIntensity: { value: 1 },
    uSunColor: { value: new Color(1, 0.96, 0.88) },
    uSkyHorizonColor: { value: new Color(0.66, 0.74, 0.85) },
    uSkyZenithColor: { value: new Color(0.2, 0.36, 0.6) },
    uEnvMap: { value: null },
    uEnvBlend: { value: 0 },
    uBodyLight: { value: 1 },
    uMicroRipple: { value: 0 },
    uRainAgitation: { value: 0 },
    uFlowDirection: { value: new Vector2(0, 1) },
    uDetailScrollA: { value: new Vector2() },
    uDetailScrollB: { value: new Vector2() },
    uDetailPhase: { value: 0 },
    ...createWorldHeightMapSampleUniforms(),
  };
}

/**
 * Creates a {@link WaterSurfaceMaterial} with the standard water shaders and
 * default uniform values. The material is transparent, double-sided (for
 * underwater and low-angle shots), and depth-write disabled.
 */
export function createWaterSurfaceMaterial(): WaterSurfaceMaterial {
  const material = new ShaderMaterial({
    name: "Director_LivingWorld_WaterSurface",
    uniforms: createWaterSurfaceUniforms(),
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // Underwater and low-angle shots see the back face; the fragment shader
    // flips the normal via gl_FrontFacing.
    side: DoubleSide,
  });
  // ShaderMaterial keeps the uniforms object by reference, so the typed view
  // created above stays authoritative.
  return material as WaterSurfaceMaterial;
}

/**
 * Static per-wave uniform halves: everything that only changes when the wave
 * spectrum is rebuilt (body sliders or world seed). Direction components live
 * in `writeGerstnerWaveDirectionUniforms` because wind re-biases them per frame.
 */
export function writeGerstnerWaveStaticUniforms(uniforms: WaterSurfaceUniforms, waves: readonly GerstnerWave[]): void {
  for (let index = 0; index < WATER_GERSTNER_WAVE_COUNT; index += 1) {
    const wave = waves[index];
    const packedA = uniforms.uGerstnerWaveA.value[index];
    const packedB = uniforms.uGerstnerWaveB.value[index];
    if (!wave) {
      packedA.set(0, 1, 0, 0);
      packedB.set(0, 0, 1, 0);
      continue;
    }
    packedA.z = wave.waveNumber;
    packedA.w = wave.angularFrequency;
    packedB.set(wave.amplitudeM, wave.steepness, wave.steepnessLimit, wave.phaseOffsetRadians);
  }
}

/** Per-frame wave directions: hashed offsets rotated around the wind-blended base. */
export function writeGerstnerWaveDirectionUniforms(
  uniforms: WaterSurfaceUniforms,
  waves: readonly GerstnerWave[],
  baseDirectionRadians: number,
): void {
  for (let index = 0; index < WATER_GERSTNER_WAVE_COUNT; index += 1) {
    const wave = waves[index];
    const packedA = uniforms.uGerstnerWaveA.value[index];
    if (!wave) {
      packedA.x = 0;
      packedA.y = 1;
      continue;
    }
    const direction = getGerstnerWaveDirectionRadians(baseDirectionRadians, wave);
    packedA.x = Math.sin(direction);
    packedA.y = Math.cos(direction);
  }
}

/**
 * Per-frame input bundle consumed by {@link writeWaterFrameUniforms}.
 * Computed once per body per rendered frame by the owning layer.
 */
export interface WaterFrameState {
  /** The living-world frame context (time, weather, wind, seed). */
  context: LivingWorldFrameContext;
  /** The authored water-body descriptor. */
  body: DirectorWorldWaterBody;
  /** The resolved Gerstner wave spectrum for this body. */
  waves: readonly GerstnerWave[];
  /** ΣA of `waves`; cached by the layer so the crest normalizer is one divide. */
  amplitudeSum: number;
  /**
   * Highest occluder under the body, sampled outside the GL pass.
   * Raycasting from `onBeforeRender` would recurse into the renderer.
   */
  occluderHeight: number;
}

/**
 * The complete per-rendered-frame GPU update: pure uniform writes derived
 * from (seed, worldSeconds, wind). No allocations — Vector2/3/4 targets are
 * mutated in place, which keeps demand-mode frames and long play sessions
 * garbage-free.
 */
export function writeWaterFrameUniforms(uniforms: WaterSurfaceUniforms, frame: WaterFrameState): void {
  const { context, body, waves, amplitudeSum } = frame;
  const windX = context.windVector[0];
  const windZ = context.windVector[2];
  const windSpeedMps = Math.hypot(windX, windZ);

  const amplitudeScale = computeWindAmplitudeScale(windSpeedMps);
  const steepnessScale = computeWindSteepnessScale(windSpeedMps);
  const baseDirectionRadians = blendFlowDirectionWithWind(body.flowDirectionDegrees, windX, windZ);

  uniforms.uTime.value = context.worldSeconds;
  uniforms.uGerstnerAmplitudeScale.value = amplitudeScale;
  uniforms.uGerstnerSteepnessScale.value = steepnessScale;
  uniforms.uCrestNormalizer.value = 1 / Math.max(amplitudeSum * amplitudeScale, 0.001);
  uniforms.uTroughLift.value = computeWaterTroughLift(
    body.surface.center[1],
    amplitudeSum * amplitudeScale,
    frame.occluderHeight,
  );
  uniforms.uOpacity.value = body.opacity;
  uniforms.uFoamIntensity.value = body.foamIntensity;

  writeGerstnerWaveDirectionUniforms(uniforms, waves, baseDirectionRadians);

  const flowX = Math.sin(baseDirectionRadians);
  const flowZ = Math.cos(baseDirectionRadians);
  uniforms.uFlowDirection.value.set(flowX, flowZ);

  const scrollA =
    body.flowSpeedMps * DETAIL_SCROLL_A_FLOW_FACTOR +
    DETAIL_SCROLL_A_BASE_MPS +
    windSpeedMps * DETAIL_SCROLL_A_WIND_FACTOR;
  const scrollB =
    body.flowSpeedMps * DETAIL_SCROLL_B_FLOW_FACTOR +
    DETAIL_SCROLL_B_BASE_MPS +
    windSpeedMps * DETAIL_SCROLL_B_WIND_FACTOR;
  uniforms.uDetailScrollA.value.set(flowX * scrollA, flowZ * scrollA);
  uniforms.uDetailScrollB.value.set(flowX * scrollB, flowZ * scrollB);

  const weather = context.settings.weather;
  const hours = evaluateWorldTimeOfDayHours(context.settings.timeOfDay, context.worldSeconds);
  computeWaterSunDirectionInto(uniforms.uSunDirection.value, hours);
  uniforms.uSunIntensity.value = computeWaterSunIntensity(hours, weather.cloudCover);
  computeWaterSunColorInto(uniforms.uSunColor.value, hours);
  computeWaterSkyReflectionInto(uniforms.uSkyHorizonColor.value, uniforms.uSkyZenithColor.value, hours, weather);
  uniforms.uBodyLight.value = computeWaterBodyLightLevel(hours, weather);
  uniforms.uMicroRipple.value = computeWaterMicroRippleStrength(windSpeedMps);
  uniforms.uRainAgitation.value = computeWaterRainAgitation(weather);
}
