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
 * Wind coupling: `uWind` carries the MEAN wind velocity (already scaled by
 * `windInfluence`), and the vertex shader integrates the same three gust
 * bands as the CPU model (worldWind.ts) in closed form over each particle's
 * age. A gust therefore bends the trajectory smoothly from the moment it
 * rises instead of teleporting particles already in flight — the artifact
 * the old `uWind * age` constant-wind advection produced.
 *
 * Precipitation occlusion: rain/snow sample the camera-centred world height
 * map in the VERTEX shader and collapse covered drops' footprint to zero
 * (the AC4-style trick from the living-world survey §3.5) — cheaper than a
 * per-fragment discard and equally deterministic, since camera state is
 * per-frame data. A fraction of weather rain renders as ground splash rings
 * (`uSplash`, `uGroundY`) instead of falling streaks.
 *
 * Fire is a two-pass kind: the "fire" ramp is the alpha-blended body (occludes
 * bright backdrops) and "fire-glow" is the additive heat shimmer drawn on top.
 * Both erode a teardrop sprite with scrolling value noise — flipbook-style
 * temporal variation without an authored atlas, pure in `(uTime, hash)` —
 * and shade it on a blackbody-anchored ramp. `uBurn` (from fireSystem.ts)
 * smothers suppressed fires toward dark smolder.
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
 * Sprite atlas channel per variant (see softParticleTexture.ts): the shared
 * 128x128 RGBA texture packs four masks — soft disc (a), flame teardrop (r),
 * snow crystal (g), splash ring (b). Rain blends streak/ring by `vSplash`.
 */
export const EFFECT_SPRITE_MASK_CHANNELS: Record<EffectShaderVariant, string> = {
  fire: "spriteTexel.r",
  "fire-glow": "spriteTexel.r",
  smoke: "spriteTexel.a",
  steam: "spriteTexel.a",
  sparks: "spriteTexel.a",
  fireflies: "spriteTexel.a",
  dust: "spriteTexel.a",
  rain: "mix(spriteTexel.a, spriteTexel.b, vSplash)",
  snow: "spriteTexel.g",
};

/**
 * Shared vertex shader for all particle effect kinds.
 *
 * Evaluates a closed-form analytic trajectory per particle from hashed
 * spawn, velocity, gravity, gust-integrated wind advection, and turbulence —
 * no per-frame CPU attribute writes. Camera-following precipitation wraps
 * positions around uOrigin so the volume stays filled while individual drops
 * remain world-anchored, kills drops under cover via the world height map,
 * and renders a hashed fraction as expanding ground splash rings.
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
uniform float uGustiness;
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
uniform float uUpright;
uniform float uPulse;
uniform float uSplash;
uniform float uGroundY;
uniform vec3 uWrapExtents;
uniform sampler2D uOcclusionMap;
uniform vec3 uOcclusionOrigin;
uniform float uOcclusionSize;
uniform float uOcclusionBlend;

varying vec2 vUv;
varying float vAgeNorm;
varying float vRand;
varying float vFade;
varying float vSplash;
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

// Gust bands mirror worldWind.ts getWorldWindSpeedMps: three incommensurate
// sines modulating the mean speed by up to +/- 0.6 * gustiness.
float windGustSignal(float t) {
  return 0.55 * sin(t * 0.9) + 0.3 * sin(t * 2.33 + 1.7) + 0.15 * sin(t * 5.71 + 4.2);
}

// Antiderivative of windGustSignal: wind displacement is the exact integral
// of the gusting speed over [spawnTime, now], so gusts bend trajectories
// smoothly instead of teleporting particles already in flight.
float windGustIntegral(float t) {
  return -(0.55 / 0.9) * cos(t * 0.9) - (0.3 / 2.33) * cos(t * 2.33 + 1.7) - (0.15 / 5.71) * cos(t * 5.71 + 4.2);
}

${WORLD_HEIGHT_MAP_SAMPLE_GLSL}

void main() {
  float index = aParticleIndex;

  // Per-particle constants: lifetime and phase offset stagger the cycles.
  float lifeRand = hash11(index * 7.313 + uSeed.x);
  float phase = hash11(index * 3.171 + uSeed.y);
  // Splash designation is per-particle (not per-cycle) so the streak/ring
  // split stays frame-stable while scrubbing.
  float splashPick = hash11(index * 5.483 + uSeed.y * 1.37);
  float isSplash = (uSplash > 0.0 && splashPick < uSplash) ? 1.0 : 0.0;
  float lifetime = max(mix(uLifetime.x, uLifetime.y, lifeRand), 0.05);
  // Splash rings live much shorter than the fall cycles they punctuate.
  lifetime = mix(lifetime, max(lifetime * 0.3, 0.05), isSplash);

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

  // Closed-form gusting wind advection: displacement = integral of the
  // gust-modulated wind speed over the particle's age.
  float spawnTime = localTime - age;
  float gustDrift = 0.6 * uGustiness * (windGustIntegral(localTime) - windGustIntegral(spawnTime));
  vec3 windDrift = uWind * (age + gustDrift);

  // Closed-form trajectory: spawn + v*t + 0.5*g*t^2 + wind advection + wiggle.
  vec3 displaced = spawn + velocity * age + 0.5 * uGravity * age * age + windDrift + turbulence;
  // Splash rings hold their hashed ground cell instead of falling.
  displaced = mix(displaced, spawn, isSplash);

  // Camera-following precipitation wraps positions around uOrigin so the
  // volume stays filled while individual drops remain world-anchored.
  vec3 offsetFromOrigin = displaced;
  if (uWrapExtents.x > 0.0) {
    offsetFromOrigin = mod(displaced - uOrigin + 0.5 * uWrapExtents, uWrapExtents) - 0.5 * uWrapExtents;
  }
  vec3 particlePos = uOrigin + offsetFromOrigin;
  particlePos.y = mix(particlePos.y, uGroundY, isSplash);
  vParticleWorld = (modelMatrix * vec4(particlePos, 1.0)).xyz;

  float sizeRand = mix(0.72, 1.35, r6);
  float size = mix(uSize.x, uSize.y, ageNorm) * uSizeScale * sizeRand;
  // Splash rings expand from a droplet hit into a fading ripple.
  size = mix(size, (0.12 + 0.55 * ageNorm) * uSizeScale * sizeRand, isSplash);

  // Precipitation cover: collapse drops under roofs/terrain recorded in the
  // camera-centred height map — a vertex-shader kill (survey §3.5, AC4-style)
  // that costs nothing per fragment. Soft 0.45 m band avoids edge popping.
  if (uOcclusionBlend > 0.001) {
    vec2 hUv = directorWorldHeightMapUv(vParticleWorld, uOcclusionOrigin, uOcclusionSize);
    float inMap = step(0.01, hUv.x) * step(hUv.x, 0.99) * step(0.01, hUv.y) * step(hUv.y, 0.99);
    float occluderY = directorWorldUnpackHeight(texture2D(uOcclusionMap, hUv).r);
    float covered = smoothstep(0.0, 0.45, occluderY - (vParticleWorld.y + ${WORLD_RAIN_OCCLUSION_CLEARANCE_M.toFixed(3)}));
    size *= 1.0 - inMap * uOcclusionBlend * covered;
  }

  vec4 viewCenter = modelViewMatrix * vec4(particlePos, 1.0);
  vec2 corner = position.xy;
  if (isSplash > 0.5) {
    // Ground-aligned ripple quad lying flat on the splash plane.
    vec3 ripple = vec3(corner.x, 0.0, corner.y) * size;
    viewCenter = modelViewMatrix * vec4(particlePos + ripple, 1.0);
  } else if (uStretch > 0.0) {
    // Stretch the quad along the analytic velocity (rain streaks, sparks),
    // slanted by the instantaneous gusting wind.
    vec3 velocityNow = velocity + uGravity * age + uWind * (1.0 + 0.6 * uGustiness * windGustSignal(localTime));
    vec3 velocityView = (modelViewMatrix * vec4(velocityNow, 0.0)).xyz;
    float planar = length(velocityView.xy);
    vec2 axisAlong = planar > 0.001 ? velocityView.xy / planar : vec2(0.0, 1.0);
    vec2 axisAcross = vec2(axisAlong.y, -axisAlong.x);
    viewCenter.xy += axisAcross * (corner.x * size * 0.18) + axisAlong * (corner.y * size * uStretch);
  } else {
    // Upright kinds (fire's teardrop) wobble around the screen-up axis;
    // everything else takes a random per-cycle base rotation. Both add the
    // optional spin over the lifetime.
    float baseAngle = uUpright > 0.0 ? (r7 * 2.0 - 1.0) * uUpright : r7 * TAU;
    float spinAngle = baseAngle + uSpin * age * (r8 * 2.0 - 1.0);
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
  vSplash = isSplash;

  // Fireflies pulse on a per-particle clock; every other kind passes 1.0.
  float pulse = 1.0;
  if (uPulse > 0.0) {
    pulse = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * uPulse * mix(0.7, 1.4, lifeRand) + phase * TAU));
  }
  vFade = pulse * min(uIntensity + 0.35, 1.0);
}
`;

/**
 * Two-octave value noise shared by the volumetric-ish fragment ramps (fire
 * erosion, smoke/steam billows). Pure in its inputs, so scrubbing to the
 * same `uTime` always reproduces the identical frame.
 */
export const EFFECT_NOISE_GLSL = /* glsl */ `
float effectHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Bilinear value noise: cheap ALU-only detail for sprite erosion.
float effectValueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = effectHash21(cell);
  float b = effectHash21(cell + vec2(1.0, 0.0));
  float c = effectHash21(cell + vec2(0.0, 1.0));
  float d = effectHash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/**
 * Blackbody-anchored fire palette (survey §3.2): deep ember red near 1000 K
 * through orange (~1500 K) to a yellow-white core (~2000 K). Shared by the
 * fire body and glow passes so both cool along the same locus.
 */
export const EFFECT_FIRE_BLACKBODY_GLSL = /* glsl */ `
vec3 effectFireBlackbody(float heat) {
  vec3 c = mix(vec3(0.05, 0.03, 0.03), vec3(0.52, 0.09, 0.02), smoothstep(0.0, 0.28, heat));
  c = mix(c, vec3(0.96, 0.38, 0.05), smoothstep(0.28, 0.6, heat));
  c = mix(c, vec3(1.0, 0.78, 0.28), smoothstep(0.6, 0.84, heat));
  return mix(c, vec3(1.0, 0.96, 0.8), smoothstep(0.84, 1.0, heat));
}
`;

/**
 * Per-variant color/alpha ramp over the particle lifetime. Signature:
 * `vec4 effectRamp(float ageN, float rand, float mask)` returning rgb color
 * + FINAL alpha. Ramps may additionally read the varyings (vUv, vSplash) and
 * their declared uniforms (uTime for animated ramps, uBurn for fire) — all
 * deterministic per-frame inputs.
 */
export const EFFECT_FRAGMENT_RAMPS: Record<EffectShaderVariant, string> = {
  fire: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // Alpha-blended flame BODY: the teardrop sprite is eroded by scrolling
  // two-octave value noise — flipbook-style temporal variation without an
  // authored atlas, pure f(uTime, rand) so scrubbing is exact. The ramp
  // occludes the backdrop so fire stays legible on bright scenes.
  float paced = clamp(ageN * (0.72 + 0.56 * rand), 0.0, 1.0);
  vec2 flameUv = vUv * vec2(2.6, 3.4) + vec2(rand * 23.7, rand * 12.9 - uTime * (2.0 + 1.6 * rand));
  float erosion = effectValueNoise(flameUv) * 0.62 + effectValueNoise(flameUv * 2.17 + 7.31) * 0.38;
  float field = mask * (0.5 + 0.5 * erosion);
  // Erosion threshold advances with age: each tongue tears apart as it rises.
  float body = smoothstep(0.06 + 0.5 * paced, 0.36 + 0.5 * paced, field);
  // Blackbody heat: hot young cores cool toward ember red; suppressed (wet)
  // fires smolder darker and greyer via uBurn (see fireSystem.ts).
  float heat = clamp(body * (1.25 - 0.85 * paced) * (0.75 + 0.25 * rand), 0.0, 1.0) * mix(0.55, 1.0, uBurn);
  vec3 color = effectFireBlackbody(heat);
  color = mix(vec3(0.21, 0.2, 0.19), color, mix(0.6, 1.0, uBurn));
  float alpha = smoothstep(0.0, 0.08, ageN) * (1.0 - smoothstep(0.55, 1.0, ageN));
  return vec4(color, alpha * body * 0.9);
}
`,
  "fire-glow": /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // Additive heat GLOW over the body pass: emissive core flicker for dark
  // scenes; legibility on bright scenes comes from the occluding body.
  float flick = 0.72 + 0.28 * sin(uTime * (9.0 + 6.0 * rand) + rand * 51.3);
  float heat = clamp((1.0 - ageN) * mask * (0.8 + 0.4 * rand), 0.0, 1.0) * mix(0.4, 1.0, uBurn);
  vec3 color = effectFireBlackbody(0.55 + 0.45 * heat);
  // The bloom term is gated hard on the sprite core (mask^5) so a dense
  // flame stacks additively without clipping the whole core to white.
  color += vec3(0.65, 0.44, 0.2) * pow(mask, 5.0) * (1.0 - ageN) * flick;
  float alpha = smoothstep(0.0, 0.07, ageN) * (1.0 - smoothstep(0.5, 1.0, ageN));
  float selectedGlow = smoothstep(0.56, 0.86, rand);
  return vec4(color, alpha * mask * 0.22 * selectedGlow * flick * mix(0.35, 1.0, uBurn));
}
`,
  smoke: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // Billowing erosion: slow scrolling noise breaks the disc into lobes that
  // dissipate as the puff ages — volumetric-ish without a raymarch.
  vec2 puffUv = vUv * 2.4 + vec2(rand * 31.7 + uTime * 0.06, rand * 17.3 - uTime * 0.13);
  float billow = effectValueNoise(puffUv) * 0.6 + effectValueNoise(puffUv * 2.31 + 3.7) * 0.4;
  float density = mask * smoothstep(0.18 + 0.45 * ageN, 0.62 + 0.38 * ageN, billow * 0.65 + mask * 0.5);
  // Dense cores self-shadow darker; thin rims read lighter.
  vec3 color = mix(vec3(0.5, 0.5, 0.54), vec3(0.24, 0.24, 0.26), density) * (0.85 + 0.3 * rand);
  float alpha = smoothstep(0.0, 0.2, ageN) * (1.0 - smoothstep(0.55, 1.0, ageN));
  return vec4(color, alpha * density * 0.45);
}
`,
  steam: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // Wispy condensation: finer, faster noise than smoke, bright and quick to
  // dissolve as the plume cools.
  vec2 wispUv = vUv * 3.4 + vec2(rand * 21.3, rand * 9.7 - uTime * 0.55);
  float wisp = effectValueNoise(wispUv) * 0.65 + effectValueNoise(wispUv * 2.4 + 5.1) * 0.35;
  float density = mask * smoothstep(0.25 + 0.5 * ageN, 0.75 + 0.25 * ageN, wisp * 0.7 + mask * 0.45);
  vec3 color = vec3(0.85, 0.88, 0.92);
  float alpha = smoothstep(0.0, 0.15, ageN) * (1.0 - smoothstep(0.4, 1.0, ageN));
  return vec4(color, alpha * density * (0.2 + 0.12 * rand));
}
`,
  sparks: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // White-hot core cooling along the blackbody-ish locus; the leading tip
  // (vUv.y = 1 along the velocity axis) stays hottest.
  vec3 color = mix(vec3(1.0, 0.97, 0.82), vec3(1.0, 0.62, 0.16), smoothstep(0.0, 0.45, ageN));
  color = mix(color, vec3(0.85, 0.25, 0.04), smoothstep(0.45, 0.85, ageN));
  color += vec3(0.3, 0.25, 0.15) * smoothstep(0.6, 1.0, vUv.y) * (1.0 - ageN);
  // Per-spark shimmer as the ember tumbles through the air.
  float flick = 0.72 + 0.28 * sin(uTime * (34.0 + 21.0 * rand) + rand * 61.0);
  float alpha = (1.0 - smoothstep(0.55, 1.0, ageN)) * flick;
  // Mild mask boost: keeps the tiny additive streaks readable on bright scenes.
  return vec4(color, alpha * min(1.0, mask * 1.3));
}
`,
  fireflies: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // Tight bioluminescent core inside a wide soft halo; the pulse itself
  // arrives via vFade from the vertex shader.
  vec3 color = mix(vec3(1.0, 0.86, 0.38), vec3(0.72, 1.0, 0.45), rand);
  float core = pow(mask, 4.0);
  float halo = mask * 0.45;
  float alpha = smoothstep(0.0, 0.12, ageN) * (1.0 - smoothstep(0.82, 1.0, ageN));
  return vec4(color * (0.7 + 0.6 * core), alpha * min(1.0, core * 1.4 + halo));
}
`,
  dust: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  vec3 color = vec3(0.8, 0.75, 0.66);
  // Slow mote shimmer as grains catch and lose the light.
  float shimmer = 0.7 + 0.3 * sin(uTime * (0.6 + 0.9 * rand) + rand * 37.0);
  float alpha = smoothstep(0.0, 0.25, ageN) * (1.0 - smoothstep(0.7, 1.0, ageN));
  return vec4(color, alpha * mask * (0.1 + 0.08 * rand) * shimmer);
}
`,
  rain: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  if (vSplash > 0.5) {
    // Expanding crown ripple where a hashed drop column meets the splash
    // plane; brightest at birth, fading as it grows.
    float fade = (1.0 - ageN) * (1.0 - ageN);
    return vec4(vec3(0.7, 0.79, 0.92), fade * mask * 0.5);
  }
  // Falling streak: the leading tip (vUv.y = 1 along the velocity axis)
  // stays brightest, selling per-drop motion direction.
  vec3 color = mix(vec3(0.56, 0.66, 0.82), vec3(0.84, 0.9, 1.0), smoothstep(0.35, 1.0, vUv.y));
  float head = 0.55 + 0.45 * smoothstep(0.5, 0.95, vUv.y);
  float alpha = smoothstep(0.0, 0.06, ageN) * (1.0 - smoothstep(0.92, 1.0, ageN));
  return vec4(color, alpha * mask * 0.4 * head);
}
`,
  snow: /* glsl */ `
vec4 effectRamp(float ageN, float rand, float mask) {
  // Crystal glint: an occasional specular flash as the flake tumbles.
  float glint = pow(max(0.0, sin(uTime * (1.7 + 2.3 * rand) + rand * 47.1)), 10.0);
  vec3 color = vec3(0.93, 0.95, 1.0) * (1.0 + glint * 0.8);
  float alpha = smoothstep(0.0, 0.08, ageN) * (1.0 - smoothstep(0.85, 1.0, ageN));
  return vec4(color, min(1.0, alpha * mask * (0.72 + 0.2 * rand + 0.4 * glint)));
}
`,
};

/**
 * Scattering-lit variants: non-emissive media whose ramp COLOR is multiplied
 * by the scene light tint. Emissive variants (fire, fire-glow, sparks,
 * fireflies) are excluded so flames and glows keep punching through the dark.
 */
export const SCENE_LIT_EFFECT_VARIANTS: readonly EffectShaderVariant[] = ["smoke", "steam", "dust", "rain", "snow"];

/**
 * Variants whose fragment ramp animates over `uTime` (noise erosion, glints,
 * flicker). Rain and fireflies animate purely through vertex-stage inputs.
 */
export const TIME_ANIMATED_EFFECT_VARIANTS: readonly EffectShaderVariant[] = [
  "fire",
  "fire-glow",
  "smoke",
  "steam",
  "sparks",
  "dust",
  "snow",
];

/** Variants that read the fire weather suppression factor `uBurn`. */
export const BURN_EFFECT_VARIANTS: readonly EffectShaderVariant[] = ["fire", "fire-glow"];

/** Variants whose ramps sample the shared value-noise helpers. */
const NOISE_EFFECT_VARIANTS: readonly EffectShaderVariant[] = ["fire", "fire-glow", "smoke", "steam"];

function buildFragmentShader(variant: EffectShaderVariant): string {
  const sceneLit = SCENE_LIT_EFFECT_VARIANTS.includes(variant);
  const nightBoosted = variant === "fireflies";
  const timeAnimated = TIME_ANIMATED_EFFECT_VARIANTS.includes(variant);
  const burnDriven = BURN_EFFECT_VARIANTS.includes(variant);
  const noisy = NOISE_EFFECT_VARIANTS.includes(variant);
  const fiery = variant === "fire" || variant === "fire-glow";
  const uniformDeclarations = [
    "uniform sampler2D uMap;",
    "uniform vec3 uTint;",
    "uniform float uTintFlag;",
    ...(timeAnimated ? ["uniform float uTime;"] : []),
    ...(burnDriven ? ["uniform float uBurn;"] : []),
    ...(sceneLit ? ["uniform vec3 uSceneLightColor;", "uniform float uSceneLightLevel;"] : []),
    ...(nightBoosted ? ["uniform float uNightBoost;"] : []),
  ].join("\n");
  // Scene light scales COLOR only: alpha stays authored so coverage/occlusion
  // does not change with time of day, only the perceived brightness does.
  const colorStage = sceneLit ? "  color *= uSceneLightColor * uSceneLightLevel;\n" : "";
  const alphaStage = nightBoosted ? "  alpha *= uNightBoost;\n" : "";
  const helpers = `${noisy ? EFFECT_NOISE_GLSL : ""}${fiery ? EFFECT_FIRE_BLACKBODY_GLSL : ""}`;
  return /* glsl */ `
${uniformDeclarations}

varying vec2 vUv;
varying float vAgeNorm;
varying float vRand;
varying float vFade;
varying float vSplash;
varying vec3 vParticleWorld;

#include <fog_pars_fragment>
${helpers}
${EFFECT_FRAGMENT_RAMPS[variant]}

void main() {
  vec4 spriteTexel = texture2D(uMap, vUv);
  float mask = ${EFFECT_SPRITE_MASK_CHANNELS[variant]};
  vec4 ramp = effectRamp(vAgeNorm, vRand, mask);
  vec3 color = mix(ramp.rgb, ramp.rgb * uTint, uTintFlag);
${colorStage}  float alpha = ramp.a * vFade;
${alphaStage}  if (alpha < 0.004) discard;
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
