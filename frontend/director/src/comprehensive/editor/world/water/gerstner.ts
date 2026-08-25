import { worldRandom01, worldStreamId } from "../worldRandom";

/**
 * Deterministic 4-wave Gerstner surface math for Living World water bodies.
 *
 * This module is the single source of truth for the wave formulation. It is
 * consumed twice:
 * - on the CPU by `evaluateGerstnerSurface` (tests today, floating-object
 *   buoyancy queries tomorrow), and
 * - on the GPU through `GERSTNER_SHARED_GLSL`, a hand-mirrored translation
 *   kept in this file, directly below the TypeScript reference, so the two
 *   cannot drift apart unnoticed.
 *
 * PAIRING CONTRACT: any change to the math in `evaluateGerstnerSurface` or
 * `createGerstnerWaveSet`'s derived quantities MUST be mirrored in
 * `GERSTNER_SHARED_GLSL`. Both carry the `DIRECTOR_GERSTNER_FORMULATION_V1`
 * marker; tests assert its presence so a refactor cannot silently drop the
 * GPU half.
 *
 * Determinism: every wave parameter derives from
 * `hashCombine(worldSeed, worldStreamId(bodyId), waveIndex, streamTag)` via
 * `worldRandom01`. No wall-clock, no `Math.random`.
 */

export const GERSTNER_FORMULATION_MARKER = "DIRECTOR_GERSTNER_FORMULATION_V1";

export const WATER_GERSTNER_WAVE_COUNT = 4;

/** Standard gravity; drives the deep-water dispersion relation ω = √(g·k). */
export const GERSTNER_GRAVITY_MPS2 = 9.81;

/**
 * Anti-loop headroom. The classic Gerstner constraint is Q·k·A·N ≤ 1; going
 * right up to 1 produces cusps (zero-length tangents) when phases align, so
 * we keep 8% margin. Exported so tests can assert the loop-safety invariant
 * holds under any wind/weather scaling.
 */
export const GERSTNER_STEEPNESS_LOOP_SAFETY = 0.92;

/** Angular spread (radians) around the base travel direction, per wave. */
const WAVE_DIRECTION_SPREAD_RADIANS = [
  (10 * Math.PI) / 180,
  (26 * Math.PI) / 180,
  (42 * Math.PI) / 180,
  (58 * Math.PI) / 180,
];

/** Hashed wavelength factor ranges: a descending spectrum under the dominant λ. */
const WAVE_LENGTH_FACTOR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0.85, 1.15],
  [0.45, 0.62],
  [0.26, 0.4],
  [0.14, 0.22],
];

/** Relative amplitude weights before hashed jitter + normalization to Σ = 1. */
const WAVE_AMPLITUDE_WEIGHTS = [1, 0.5, 0.28, 0.16];

// Stable per-parameter stream tags (never reorder — would reshuffle all seeds).
const STREAM_DIRECTION = 1;
const STREAM_WAVELENGTH = 2;
const STREAM_AMPLITUDE = 3;
const STREAM_STEEPNESS = 4;
const STREAM_PHASE = 5;

export interface GerstnerWave {
  /** Travel-direction offset (radians) applied to the frame's base direction. */
  directionOffsetRadians: number;
  wavelengthM: number;
  /** Wave number k = 2π/λ (rad/m). */
  waveNumber: number;
  amplitudeM: number;
  /** Base steepness Q before wind scaling and the anti-loop limit. */
  steepness: number;
  /** Per-wave anti-loop bound: effective Q may never exceed limit/amplitudeScale. */
  steepnessLimit: number;
  /** ω = √(g·k) + k·flowSpeed — dispersion keeps still bodies undulating. */
  angularFrequency: number;
  phaseOffsetRadians: number;
}

export interface GerstnerWaveSetInput {
  worldSeed: number;
  bodyId: string;
  /** Peak-to-mean vertical wave height budget (protocol 0..3 metres). */
  waveAmplitude: number;
  /** Dominant wavelength (protocol 0.2..200 metres). */
  waveLengthM: number;
  /** Advection speed along the travel direction (protocol 0..10 m/s). */
  flowSpeedMps: number;
}

export interface GerstnerSurfaceParams {
  waves: readonly GerstnerWave[];
  /** Compass base travel direction (radians; 0 = +Z, clockwise, matches wind). */
  baseDirectionRadians: number;
  /** Wind-coupled amplitude multiplier (1 = authored amplitude). */
  amplitudeScale: number;
  /** Wind-coupled choppiness multiplier applied to per-wave steepness. */
  steepnessScale: number;
}

/** Flat-field sample so callers can reuse one object with zero allocations. */
export interface GerstnerSurfaceSample {
  /** Horizontal displacement along X (world space). */
  offsetX: number;
  /** Vertical displacement (wave height). */
  offsetY: number;
  /** Horizontal displacement along Z (world space). */
  offsetZ: number;
  /** Surface normal X component (unit length). */
  normalX: number;
  /** Surface normal Y component (1 for flat water). */
  normalY: number;
  /** Surface normal Z component (unit length). */
  normalZ: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Deterministic wave spectrum for one body. Direction offsets, wavelength
 * factors, amplitude weights, steepness, and phases are all hashed from
 * (worldSeed, bodyId, waveIndex, parameterTag), so two bodies with identical
 * sliders still read as distinct water, while re-renders and exports always
 * reproduce the same spectrum.
 */
export function createGerstnerWaveSet(input: GerstnerWaveSetInput): GerstnerWave[] {
  const bodyStream = worldStreamId(input.bodyId);
  const seed = input.worldSeed;

  // Jittered amplitude weights, normalized so ΣA equals the authored
  // amplitude exactly — that makes `waveAmplitude` the hard displacement
  // bound (see evaluateGerstnerSurface) and the crest normalizer trivial.
  const rawWeights: number[] = [];
  let weightSum = 0;
  for (let index = 0; index < WATER_GERSTNER_WAVE_COUNT; index += 1) {
    const jitter = 0.85 + 0.3 * worldRandom01(seed, bodyStream, index, STREAM_AMPLITUDE);
    const weight = WAVE_AMPLITUDE_WEIGHTS[index] * jitter;
    rawWeights.push(weight);
    weightSum += weight;
  }

  const waves: GerstnerWave[] = [];
  for (let index = 0; index < WATER_GERSTNER_WAVE_COUNT; index += 1) {
    const directionOffsetRadians =
      (worldRandom01(seed, bodyStream, index, STREAM_DIRECTION) * 2 - 1) * WAVE_DIRECTION_SPREAD_RADIANS[index];

    const [factorMin, factorMax] = WAVE_LENGTH_FACTOR_RANGES[index];
    const lengthFactor =
      factorMin + (factorMax - factorMin) * worldRandom01(seed, bodyStream, index, STREAM_WAVELENGTH);
    const wavelengthM = clamp(input.waveLengthM * lengthFactor, 0.05, 400);
    const waveNumber = (2 * Math.PI) / wavelengthM;

    const amplitudeM = input.waveAmplitude * (rawWeights[index] / weightSum);

    const steepness = 0.55 + 0.3 * worldRandom01(seed, bodyStream, index, STREAM_STEEPNESS);
    const steepnessLimit =
      amplitudeM > 0
        ? Math.min(1, GERSTNER_STEEPNESS_LOOP_SAFETY / (waveNumber * amplitudeM * WATER_GERSTNER_WAVE_COUNT))
        : 1;

    // Deep-water dispersion plus flow advection: still bodies (flow 0) keep
    // the √(g·k) term, so the surface always undulates.
    const angularFrequency = Math.sqrt(GERSTNER_GRAVITY_MPS2 * waveNumber) + waveNumber * input.flowSpeedMps;

    const phaseOffsetRadians = worldRandom01(seed, bodyStream, index, STREAM_PHASE) * Math.PI * 2;

    waves.push({
      directionOffsetRadians,
      wavelengthM,
      waveNumber,
      amplitudeM,
      steepness,
      steepnessLimit,
      angularFrequency,
      phaseOffsetRadians,
    });
  }
  return waves;
}

/** ΣA of the set — the vertical displacement bound before wind scaling. */
export function sumGerstnerAmplitudes(waves: readonly GerstnerWave[]): number {
  let sum = 0;
  for (const wave of waves) sum += wave.amplitudeM;
  return sum;
}

/**
 * Final compass travel direction (radians) of one wave under a base direction.
 *
 * @param baseDirectionRadians - Compass base direction of the wave set.
 * @param wave - The wave whose hashed offset is added.
 * @returns Resolved travel direction in radians.
 */
export function getGerstnerWaveDirectionRadians(baseDirectionRadians: number, wave: GerstnerWave): number {
  return baseDirectionRadians + wave.directionOffsetRadians;
}

/**
 * Effective per-wave steepness: base Q × wind/weather choppiness, capped by
 * the anti-loop limit (rescaled for the amplitude boost) and by 1 so the
 * horizontal swing of a wave never exceeds its own amplitude. This cap is why
 * arbitrary wind × weather scaling can never loop the surface:
 * Q·k·(A·ampScale)·N ≤ GERSTNER_STEEPNESS_LOOP_SAFETY holds by construction.
 * Exported for buoyancy consumers and the ΣQ safety tests.
 * MIRRORED in GERSTNER_SHARED_GLSL.
 */
export function computeEffectiveGerstnerSteepness(
  wave: GerstnerWave,
  amplitudeScale: number,
  steepnessScale: number,
): number {
  return Math.min(Math.min(wave.steepness * steepnessScale, wave.steepnessLimit / Math.max(amplitudeScale, 0.001)), 1);
}

/**
 * CPU reference of the Gerstner sum. (x, z) is the undisplaced grid position
 * in world space; returns the world-space position offset and the exact
 * analytic surface normal (cross product of the parametric tangents).
 *
 * DIRECTOR_GERSTNER_FORMULATION_V1 — keep in lockstep with
 * `GERSTNER_SHARED_GLSL` below.
 *
 * Guarantees relied on by tests and future buoyancy consumers:
 * - |offset| ≤ Σ(amplitude) × amplitudeScale (per-wave |contribution| ≤ A
 *   because effective Q ≤ 1),
 * - normal is unit length,
 * - zero amplitude ⇒ zero offset and normal (0, 1, 0).
 */
export function evaluateGerstnerSurfaceInto(
  out: GerstnerSurfaceSample,
  params: GerstnerSurfaceParams,
  x: number,
  z: number,
  t: number,
): GerstnerSurfaceSample {
  let offsetX = 0;
  let offsetY = 0;
  let offsetZ = 0;
  // Parametric tangents of the undisplaced plane: T = ∂P/∂x, B = ∂P/∂z.
  let tangentX = 1;
  let tangentY = 0;
  let tangentZ = 0;
  let binormalX = 0;
  let binormalY = 0;
  let binormalZ = 1;

  for (const wave of params.waves) {
    const amplitude = wave.amplitudeM * params.amplitudeScale;
    if (amplitude <= 0) continue;
    const q = computeEffectiveGerstnerSteepness(wave, params.amplitudeScale, params.steepnessScale);
    const direction = getGerstnerWaveDirectionRadians(params.baseDirectionRadians, wave);
    const dirX = Math.sin(direction);
    const dirZ = Math.cos(direction);
    const k = wave.waveNumber;
    const phase = k * (dirX * x + dirZ * z) - wave.angularFrequency * t + wave.phaseOffsetRadians;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    const qa = q * amplitude;
    const wa = k * amplitude;

    offsetX += dirX * qa * c;
    offsetY += amplitude * s;
    offsetZ += dirZ * qa * c;

    tangentX -= q * wa * dirX * dirX * s;
    tangentY += wa * dirX * c;
    tangentZ -= q * wa * dirX * dirZ * s;

    binormalX -= q * wa * dirX * dirZ * s;
    binormalY += wa * dirZ * c;
    binormalZ -= q * wa * dirZ * dirZ * s;
  }

  // normal = normalize(cross(binormal, tangent)); flat water ⇒ (0, 1, 0).
  const crossX = binormalY * tangentZ - binormalZ * tangentY;
  const crossY = binormalZ * tangentX - binormalX * tangentZ;
  const crossZ = binormalX * tangentY - binormalY * tangentX;
  const crossLength = Math.hypot(crossX, crossY, crossZ);
  const invLength = crossLength > 0 ? 1 / crossLength : 0;

  out.offsetX = offsetX;
  out.offsetY = offsetY;
  out.offsetZ = offsetZ;
  out.normalX = crossX * invLength;
  out.normalY = crossLength > 0 ? crossY * invLength : 1;
  out.normalZ = crossZ * invLength;
  return out;
}

/** Allocating convenience wrapper around `evaluateGerstnerSurfaceInto`. */
export function evaluateGerstnerSurface(
  params: GerstnerSurfaceParams,
  x: number,
  z: number,
  t: number,
): GerstnerSurfaceSample {
  return evaluateGerstnerSurfaceInto(
    { offsetX: 0, offsetY: 0, offsetZ: 0, normalX: 0, normalY: 1, normalZ: 0 },
    params,
    x,
    z,
    t,
  );
}

/**
 * GPU mirror of `evaluateGerstnerSurfaceInto`.
 *
 * DIRECTOR_GERSTNER_FORMULATION_V1 — this GLSL is the hand-translated twin of
 * the TypeScript reference above. Wave constants arrive packed:
 * - uGerstnerWaveA[i] = (dirX, dirZ, waveNumber k, angularFrequency ω) — the
 *   direction components are resolved on the CPU per frame (base direction ⊕
 *   hashed offset) by `writeGerstnerWaveDirectionUniforms`,
 * - uGerstnerWaveB[i] = (amplitude, baseSteepness, steepnessLimit, phaseOffset).
 */
export const GERSTNER_SHARED_GLSL = /* glsl */ `
// DIRECTOR_GERSTNER_FORMULATION_V1 — GPU mirror of evaluateGerstnerSurfaceInto()
// in gerstner.ts. Keep every formula in lockstep with the TypeScript reference.
uniform vec4 uGerstnerWaveA[${WATER_GERSTNER_WAVE_COUNT}];
uniform vec4 uGerstnerWaveB[${WATER_GERSTNER_WAVE_COUNT}];
uniform float uGerstnerAmplitudeScale;
uniform float uGerstnerSteepnessScale;

void directorGerstnerEvaluate(in vec2 planeXZ, in float time, out vec3 surfaceOffset, out vec3 surfaceNormal) {
  vec3 offset = vec3(0.0);
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  for (int i = 0; i < ${WATER_GERSTNER_WAVE_COUNT}; i += 1) {
    vec4 waveA = uGerstnerWaveA[i];
    vec4 waveB = uGerstnerWaveB[i];
    vec2 dir = waveA.xy;
    float k = waveA.z;
    float amplitude = waveB.x * uGerstnerAmplitudeScale;
    // computeEffectiveGerstnerSteepness(): base Q × choppiness, capped by the
    // rescaled anti-loop limit and by 1.
    float q = min(min(waveB.y * uGerstnerSteepnessScale, waveB.z / max(uGerstnerAmplitudeScale, 0.001)), 1.0);
    float phase = k * dot(dir, planeXZ) - waveA.w * time + waveB.w;
    float c = cos(phase);
    float s = sin(phase);
    float qa = q * amplitude;
    float wa = k * amplitude;

    offset += vec3(dir.x * qa * c, amplitude * s, dir.y * qa * c);
    tangent += vec3(-q * wa * dir.x * dir.x * s, wa * dir.x * c, -q * wa * dir.x * dir.y * s);
    binormal += vec3(-q * wa * dir.x * dir.y * s, wa * dir.y * c, -q * wa * dir.y * dir.y * s);
  }
  surfaceOffset = offset;
  surfaceNormal = normalize(cross(binormal, tangent));
}
`;
