import type { WorldEffectKind } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { WORLD_HEIGHT_MAP_SAMPLE_GLSL, WORLD_RAIN_OCCLUSION_CLEARANCE_M } from "../surface/worldHeightMap";
import { WORLD_EFFECT_KINDS, type EffectRenderPassId } from "./effectPresets";

/**
 * Deterministic GLSL assembly for the stateless particle systems.
 *
 * Every particle is a closed-form function of `(uSeed, aParticleIndex, uTime)`
 * evaluated in the vertex shader: hashed lifetime + phase place the particle
 * in a repeating cycle, and each cycle re-hashes spawn/velocity/size/rotation
 * so respawns never repeat. No CPU stepping, no per-frame attribute writes.
 *
 * Determinism note: the float hash (Dave Hoskins style, no sin/uint) is stable
 * for a given machine + driver, which is what deterministic export requires.
 * Bit-exact equality across GPU vendors is NOT guaranteed and not required;
 * cross-vendor output only needs to match to visual tolerance.
 *
 * Shaders are authored in GLSL1 style (attribute/varying/texture2D); three.js
 * transparently maps them onto the WebGL2 backend. The three fog chunks
 * (`fog_pars_*` / `fog_fragment`) are compiled in but stay inert unless the
 * material opts in via `material.fog` AND the scene carries a fog — three only
 * then defines USE_FOG and refreshes the fog uniforms.
 *
 * Fire is a two-pass kind: the "fire" ramp is the alpha-blended body (occludes
 * bright backdrops) and "fire-glow" is the additive heat shimmer drawn on top.
 *
 * Scene-light coupling: scattering media (SCENE_LIT_EFFECT_VARIANTS) multiply
 * their ramp COLOR — never alpha — by `uSceneLightColor * uSceneLightLevel`,
 * fed per frame from the CPU solar model (see sceneLighting.ts), so smoke
 * reads as a dark silhouette at midnight and rain dims under overcast skies.
 * Emissive variants (fire body/glow, sparks, fireflies) stay unlit; fireflies
 * additionally scale their alpha by `uNightBoost` to glow brighter at night.
 */

export interface EffectShaderSource {
  /** GLSL vertex shader source string. */
  vertexShader: string;
  /** GLSL fragment shader source string (per-variant, with inlined ramps). */
  fragmentShader: string;
}

/** Ramp/table key: every kind plus fire's extra additive glow pass. */
export type EffectShaderVariant = WorldEffectKind | "fire-glow";

/**
 * Shared vertex shader for all particle effect kinds.
 *
 * Evaluates a closed-form analytic trajectory per particle from hashed
 * spawn, velocity, gravity, wind advection, and turbulence — no per-frame
 * CPU attribute writes. Camera-following precipitation wraps positions
 * around uOrigin so the volume stays filled while individual drops remain
 * world-anchored.
 */
export const EFFECT_VERTEX_SHADER = /* glsl */ `
attribute float aParticleIndex;

uniform float uTime;
uniform vec2 uSeed;
uniform vec3 uOrigin;
uniform float uIntensity;
uniform float uSizeScale;
uniform float uSpeedScale;
uniform vec3 uWind;
uniform float uEmitterMode;
uniform vec3 uEmitterExtents;
uniform vec2 uLifetime;
uniform vec3 uVelocityBase;
uniform vec3 uVelocitySpread;
uniform vec3 uGravity;
uniform float uTurbulence;
uniform vec2 uTurbFrequency;
uniform vec2 uSize;
uniform float uSpin;
uniform float uStretch;
uniform float uPulse;
uniform vec3 uWrapExtents;

varying vec2 vUv;
varying float vAgeNorm;
varying float vRand;
varying float vFade;
varying vec3 vParticleWorld;

#include <fog_pars_vertex>

const float TAU = 6.28318530718;

// Float hash without sin(): stable per machine to visual tolerance.
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// Slot-indexed random stream for one (particle, cycle) pair.
float prand(float cycleSeed, float slot) {
  return hash11(cycleSeed * 911.317 + slot * 27.1828);
}

void main() {
  float index = aParticleIndex;

  // Per-particle constants: lifetime and phase offset stagger the cycles.
  float lifeRand = hash11(index * 7.313 + uSeed.x);
  float phase = hash11(index * 3.171 + uSeed.y);
  float lifetime = max(mix(uLifetime.x, uLifetime.y, lifeRand), 0.05);

  // Analytic lifecycle: age loops inside [0, lifetime); cycleIndex reseeds
  // every respawn so no two loops of one particle look identical.
  float localTime = uTime * uSpeedScale;
  float cursor = localTime + phase * lifetime;
  float age = mod(cursor, lifetime);
  float cycleIndex = floor(cursor / lifetime);
  float ageNorm = age / lifetime;

  float particleSeed = hash11(index * 0.6180339887 + uSeed.x + uSeed.y * 0.5);
  float cycleSeed = hash11(particleSeed * 251.113 + cycleIndex * 0.7071067 + uSeed.y);

  float r0 = prand(cycleSeed, 1.0);
  float r1 = prand(cycleSeed, 2.0);
  float r2 = prand(cycleSeed, 3.0);
  float r3 = prand(cycleSeed, 4.0);
  float r4 = prand(cycleSeed, 5.0);
  float r5 = prand(cycleSeed, 6.0);
  float r6 = prand(cycleSeed, 7.0);
  float r7 = prand(cycleSeed, 8.0);
  float r8 = prand(cycleSeed, 9.0);
  float r9 = prand(cycleSeed, 10.0);

  // Spawn position inside the emitter shape (box / sphere / disc).
  vec3 spawn;
  if (uEmitterMode < 0.5) {
    spawn = (vec3(r0, r1, r2) * 2.0 - 1.0) * uEmitterExtents;
  } else if (uEmitterMode < 1.5) {
    float cosTheta = r0 * 2.0 - 1.0;
    float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    float azimuth = r1 * TAU;
    float radius = uEmitterExtents.x * pow(r2, 0.33333333);
    spawn = vec3(sinTheta * cos(azimuth), cosTheta, sinTheta * sin(azimuth)) * radius;
  } else {
    float azimuth = r0 * TAU;
    float radius = uEmitterExtents.x * sqrt(r1);
    spawn = vec3(cos(azimuth) * radius, 0.0, sin(azimuth) * radius);
  }

  vec3 velocity = uVelocityBase + (vec3(r3, r4, r5) * 2.0 - 1.0) * uVelocitySpread;

  // Cheap turbulence: two hashed-phase sine bands per axis, eased in so
  // particles do not wiggle at the spawn point.
  float turbPhaseA = r6 * TAU;
  float turbPhaseB = r7 * TAU;
  float turbGain = uTurbulence * smoothstep(0.0, 0.3, ageNorm);
  vec3 turbulence = vec3(
    sin(age * uTurbFrequency.x + turbPhaseA) + 0.5 * sin(age * uTurbFrequency.y + turbPhaseB),
    sin(age * uTurbFrequency.x * 0.83 + turbPhaseB) + 0.5 * sin(age * uTurbFrequency.y * 1.29 + turbPhaseA),
    cos(age * uTurbFrequency.x * 1.13 + turbPhaseA) + 0.5 * cos(age * uTurbFrequency.y * 0.71 + turbPhaseB)
  ) * turbGain;

  // Closed-form trajectory: spawn + v*t + 0.5*g*t^2 + wind advection + wiggle.
  vec3 displaced = spawn + velocity * age + 0.5 * uGravity * age * age + uWind * age + turbulence;

  // Camera-following precipitation wraps positions around uOrigin so the
  // volume stays filled while individual drops remain world-anchored.
  vec3 offsetFromOrigin = displaced;
  if (uWrapExtents.x > 0.0) {
    offsetFromOrigin = mod(displaced - uOrigin + 0.5 * uWrapExtents, uWrapExtents) - 0.5 * uWrapExtents;
  }
  vec3 particlePos = uOrigin + offsetFromOrigin;
  vParticleWorld = (modelMatrix * vec4(particlePos, 1.0)).xyz;

  float sizeRand = mix(0.72, 1.35, r6);
  float size = mix(uSize.x, uSize.y, ageNorm) * uSizeScale * sizeRand;

  vec4 viewCenter = modelViewMatrix * vec4(particlePos, 1.0);
  vec2 corner = position.xy;
  if (uStretch > 0.0) {
    // Stretch the quad along the analytic velocity (rain streaks, sparks).
    vec3 velocityNow = velocity + uGravity * age + uWind;
    vec3 velocityView = (modelViewMatrix * vec4(velocityNow, 0.0)).xyz;
    float planar = length(velocityView.xy);
    vec2 axisAlong = planar > 0.001 ? velocityView.xy / planar : vec2(0.0, 1.0);
    vec2 axisAcross = vec2(axisAlong.y, -axisAlong.x);
    viewCenter.xy += axisAcross * (corner.x * size * 0.18) + axisAlong * (corner.y * size * uStretch);
  } else {
    // Spherical billboard with per-cycle base rotation plus optional spin.
    float spinAngle = r7 * TAU + uSpin * age * (r8 * 2.0 - 1.0);
    float cosSpin = cos(spinAngle);
    float sinSpin = sin(spinAngle);
    corner = vec2(corner.x * cosSpin - corner.y * sinSpin, corner.x * sinSpin + corner.y * cosSpin);
    viewCenter.xy += corner * size;
  }

  gl_Position = projectionMatrix * viewCenter;

#ifdef USE_FOG
  // three's fog_vertex chunk expects an "mvPosition" local; assign the
  // varying directly from our view-space center instead.
  vFogDepth = -viewCenter.z;
#endif

  vUv = uv;
  vAgeNorm = ageNorm;
  vRand = r9;

  // Fireflies pulse on a per-particle clock; every other kind passes 1.0.
  float pulse = 1.0;
  if (uPulse > 0.0) {
    pulse = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * uPulse * mix(0.7, 1.4, lifeRand) + phase * TAU));
  }
  vFade = pulse * min(uIntensity + 0.35, 1.0);
}
`;

/**
 * Per-variant color/alpha ramp over the particle lifetime. Signature:
 * `vec4 effectRamp(float ageN, float rand, float mask)` returning rgb color
 * + FINAL alpha — each ramp owns how the soft-disc mask shapes its alpha
 * (the fire body widens it, everything else multiplies it straight in).
 */
export const EFFECT_FRAGMENT_RAMPS: Record<EffectShaderVariant, string> = {
  fire: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // Alpha-blended flame BODY: a dark-to-saturated ramp that occludes the
  // backdrop, so fire stays legible on bright scenes where pure additive
  // blending washes out. The additive glow pass layers heat back on top.
  vec3 core = vec3(0.92, 0.5, 0.1);
  vec3 mid = vec3(0.74, 0.2, 0.035);
  vec3 ember = vec3(0.24, 0.05, 0.02);
  // Per-particle ramp pacing: neighbours sit at different points of the same
  // gradient, so a dense stack keeps visible tongues instead of averaging into
  // one flat sheet.
  float paced = clamp(ageN * (0.72 + 0.56 * rand), 0.0, 1.0);
  vec3 color = mix(core, mid, smoothstep(0.06, 0.42, paced));
  color = mix(color, ember, smoothstep(0.42, 0.9, paced));
  color *= 0.68 + 0.3 * rand;
  float alpha = smoothstep(0.0, 0.08, ageN) * (1.0 - smoothstep(0.5, 1.0, ageN));
  // Widened footprint (mask^0.6) keeps the stacked flame core near-opaque.
  return vec4(color, alpha * pow(mask, 0.6) * 0.85);
}
`,
  "fire-glow": /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // Additive heat GLOW over the body pass: emissive shimmer for dark scenes;
  // legibility on bright scenes comes from the occluding body underneath.
  vec3 core = vec3(1.0, 0.93, 0.72);
  vec3 mid = vec3(1.0, 0.5, 0.12);
  vec3 ember = vec3(0.42, 0.07, 0.02);
  vec3 color = mix(core, mid, smoothstep(0.04, 0.4, ageN));
  color = mix(color, ember, smoothstep(0.4, 0.92, ageN));
  // The bloom term is gated hard on the disc centre (mask^5) and the glow pass
  // carries a low alpha: a dense flame stacks additively without clipping the
  // whole core to featureless white.
  color += vec3(0.7, 0.48, 0.22) * pow(mask, 5.0) * (1.0 - ageN) * (0.6 + 0.5 * rand);
  float alpha = smoothstep(0.0, 0.07, ageN) * (1.0 - smoothstep(0.5, 1.0, ageN));
  float selectedGlow = smoothstep(0.56, 0.86, rand);
  return vec4(color, alpha * mask * 0.22 * selectedGlow);
}
`,
  smoke: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  vec3 color = mix(vec3(0.26, 0.26, 0.28), vec3(0.52, 0.52, 0.55), 0.35 * rand + 0.45 * ageN);
  float alpha = smoothstep(0.0, 0.22, ageN) * (1.0 - smoothstep(0.55, 1.0, ageN));
  return vec4(color, alpha * mask * 0.3);
}
`,
  steam: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  vec3 color = vec3(0.82, 0.85, 0.88);
  float alpha = smoothstep(0.0, 0.15, ageN) * (1.0 - smoothstep(0.4, 1.0, ageN));
  return vec4(color, alpha * mask * (0.16 + 0.1 * rand));
}
`,
  sparks: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  vec3 hot = vec3(1.0, 0.92, 0.6);
  vec3 cool = vec3(1.0, 0.45, 0.1);
  vec3 color = mix(hot, cool, smoothstep(0.0, 0.7, ageN));
  float alpha = 1.0 - smoothstep(0.6, 1.0, ageN);
  // Mild mask boost: keeps the tiny additive streaks readable on bright scenes.
  return vec4(color, alpha * min(1.0, mask * 1.25));
}
`,
  fireflies: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  vec3 color = mix(vec3(1.0, 0.85, 0.35), vec3(0.75, 1.0, 0.42), rand);
  float alpha = smoothstep(0.0, 0.12, ageN) * (1.0 - smoothstep(0.82, 1.0, ageN));
  return vec4(color, alpha * min(1.0, mask * 1.2));
}
`,
  dust: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  vec3 color = vec3(0.78, 0.74, 0.66);
  float alpha = smoothstep(0.0, 0.25, ageN) * (1.0 - smoothstep(0.7, 1.0, ageN));
  return vec4(color, alpha * mask * (0.1 + 0.08 * rand));
}
`,
  rain: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  vec3 color = vec3(0.6, 0.71, 0.85);
  float alpha = smoothstep(0.0, 0.06, ageN) * (1.0 - smoothstep(0.92, 1.0, ageN));
  return vec4(color, alpha * mask * 0.32);
}
`,
  snow: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  vec3 color = vec3(0.93, 0.95, 1.0);
  float alpha = smoothstep(0.0, 0.08, ageN) * (1.0 - smoothstep(0.85, 1.0, ageN));
  return vec4(color, alpha * mask * (0.75 + 0.2 * rand));
}
`,
};

/**
 * Scattering-lit variants: non-emissive media whose ramp COLOR is multiplied
 * by the scene light tint. Emissive variants (fire, fire-glow, sparks,
 * fireflies) are excluded so flames and glows keep punching through the dark.
 */
export const SCENE_LIT_EFFECT_VARIANTS: readonly EffectShaderVariant[] = ["smoke", "steam", "dust", "rain", "snow"];

function buildFragmentShader(variant: EffectShaderVariant): string {
  const sceneLit = SCENE_LIT_EFFECT_VARIANTS.includes(variant);
  const nightBoosted = variant === "fireflies";
  const roofOccluded = variant === "rain" || variant === "snow";
  const uniformDeclarations = [
    "uniform sampler2D uMap;",
    "uniform vec3 uTint;",
    "uniform float uTintFlag;",
    ...(sceneLit ? ["uniform vec3 uSceneLightColor;", "uniform float uSceneLightLevel;"] : []),
    ...(nightBoosted ? ["uniform float uNightBoost;"] : []),
    ...(roofOccluded
      ? [
          "uniform sampler2D uOcclusionMap;",
          "uniform vec3 uOcclusionOrigin;",
          "uniform float uOcclusionSize;",
          "uniform float uOcclusionBlend;",
        ]
      : []),
  ].join("\n");
  // Scene light scales COLOR only: alpha stays authored so coverage/occlusion
  // does not change with time of day, only the perceived brightness does.
  const colorStage = sceneLit ? "  color *= uSceneLightColor * uSceneLightLevel;\n" : "";
  const alphaStage = nightBoosted ? "  alpha *= uNightBoost;\n" : "";
  const occlusionHelpers = roofOccluded ? WORLD_HEIGHT_MAP_SAMPLE_GLSL : "";
  const occlusionStage = roofOccluded
    ? /* glsl */ `
  float occlusion = 0.0;
  if (uOcclusionBlend > 0.001) {
    vec2 hUv = directorWorldHeightMapUv(vParticleWorld, uOcclusionOrigin, uOcclusionSize);
    float inMap = step(0.01, hUv.x) * step(hUv.x, 0.99) * step(0.01, hUv.y) * step(hUv.y, 0.99);
    float occluderY = directorWorldUnpackHeight(texture2D(uOcclusionMap, hUv).r);
    occlusion = inMap * uOcclusionBlend * step(vParticleWorld.y + ${WORLD_RAIN_OCCLUSION_CLEARANCE_M.toFixed(3)}, occluderY);
  }
  alpha *= (1.0 - occlusion);
`
    : "";
  return /* glsl */ `
${uniformDeclarations}

varying vec2 vUv;
varying float vAgeNorm;
varying float vRand;
varying float vFade;
varying vec3 vParticleWorld;

#include <fog_pars_fragment>

${EFFECT_FRAGMENT_RAMPS[variant]}
${occlusionHelpers}

void main() {
  float mask = texture2D(uMap, vUv).a;
  vec4 ramp = effectRamp(vAgeNorm, vRand, mask);
  vec3 color = mix(ramp.rgb, ramp.rgb * uTint, uTintFlag);
${colorStage}  float alpha = ramp.a * vFade;
${alphaStage}${occlusionStage}  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha);
  #include <fog_fragment>
}
`;
}

const SHADER_VARIANTS: readonly EffectShaderVariant[] = [...WORLD_EFFECT_KINDS, "fire-glow"];

const SHADER_SOURCES: Record<EffectShaderVariant, EffectShaderSource> = SHADER_VARIANTS.reduce(
  (sources, variant) => {
    sources[variant] = { vertexShader: EFFECT_VERTEX_SHADER, fragmentShader: buildFragmentShader(variant) };
    return sources;
  },
  {} as Record<EffectShaderVariant, EffectShaderSource>,
);

/**
 * Deterministic shader pair per (kind, render pass); same input always
 * returns equal strings. Fire resolves "main"/"fire-body" to the body ramp
 * and "fire-glow" to the additive glow ramp; other kinds ignore the pass.
 */
export function buildEffectShaderSource(kind: WorldEffectKind, pass: EffectRenderPassId = "main"): EffectShaderSource {
  const variant: EffectShaderVariant = pass === "fire-glow" ? "fire-glow" : kind;
  return SHADER_SOURCES[variant];
}
