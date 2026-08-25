import type { DirectorWorldWeather } from "../../schema/directorProject";
import { evaluateSkyWeatherMood } from "./skyWeather";

/**
 * Nishita single-scattering atmosphere shared by the Living World sky dome,
 * directional sun, hemisphere fill, and aerial fog.
 *
 * The integral is too heavy for per-pixel work, so it bakes into a small
 * equirectangular LUT (and 9 SH coefficients) whenever the quantized sun or
 * weather changes. Sun chromaticity uses Kasten-Young air mass so a low sun
 * reddens on the same scale the sky LUT stores radiance in.
 *
 * Ported from the Snowflow demo's atmosphere model (Nishita + isotropic
 * multiple-scattering fill + below-horizon ground bounce), with fewer march
 * steps so the CPU bake stays interactive.
 */

export const ATMOSPHERE_LUT_WIDTH = 64;
export const ATMOSPHERE_LUT_HEIGHT = 32;
export const ATMOSPHERE_SUN_SCALE_BASE = 5.5;

const EARTH_R = 6_360_000;
const ATMOS_R = 6_420_000;
const H_RAYLEIGH = 8_000;
const H_MIE = 1_200;
const BETA_R: readonly [number, number, number] = [5.8e-6, 13.5e-6, 33.1e-6];
const BETA_M = 21e-6;
const MIE_G = 0.76;
const MS_BOOST = 1.5;
const SHADOW_FILL = 0.5;
const VIEW_STEPS = 12;
const LIGHT_STEPS = 4;
const DIST_POWER = 2.5;
const PI = Math.PI;
const FOUR_PI = 4 * PI;
const INV_PI = 1 / PI;
const REC709: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

const TAU_R_WARM: readonly [number, number, number] = [0.0464, 0.108, 0.265];
const TAU_M_WARM = 0.0252;

export const DEFAULT_GROUND_ALBEDO: readonly [number, number, number] = [0.22, 0.21, 0.2];
export const SNOW_GROUND_ALBEDO: readonly [number, number, number] = [0.83, 0.86, 0.91];

const SH_BASIS_SCALE = [
  0.282095, 0.488603, 0.488603, 0.488603, 1.092548, 1.092548, 0.315392, 1.092548, 0.546274,
] as const;

const CACHE_LIMIT = 24;
const atmosphereCache = new Map<string, AtmosphereSolution>();

export interface AtmosphereSolution {
  /** Equirect RGB radiance, row-major, `width * height * 3`. */
  lut: Float32Array;
  /** Horizontal resolution of the equirectangular LUT in texels. */
  width: number;
  /** Vertical resolution of the equirectangular LUT in texels. */
  height: number;
  /** 9 RGB spherical-harmonic coefficients. */
  sh: Float32Array;
  /** Direct solar irradiance at the ground (same units as the sky LUT). */
  sunRadiance: [number, number, number];
  /** Chromaticity of the sun radiance for key-light tinting. */
  sunColor: [number, number, number];
  /** SH irradiance for an up-facing normal, in sky LUT units. */
  skyIrradianceUp: [number, number, number];
  /** Lambertian ground bounce radiance from the albedo solve. */
  groundBounce: [number, number, number];
  /** Sampled radiance at the zenith (straight up). */
  zenithColor: [number, number, number];
  /** Sampled radiance at the horizon toward the sun azimuth. */
  horizonColor: [number, number, number];
  /** Sampled radiance along a shallow up-sun direction, used for aerial fog near colour. */
  aerialNearColor: [number, number, number];
  /** Resolved sun scale applied to the bake, after weather transmission. */
  sunScale: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);

function lerp(from: number, to: number, t: number) {
  return from + (to - from) * t;
}

function lerp3(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Rec.709 perceptual luminance of a linear RGB triplet. */
export function luminanceOf(rgb: readonly [number, number, number]): number {
  return rgb[0] * REC709[0] + rgb[1] * REC709[1] + rgb[2] * REC709[2];
}

/**
 * Chromaticity of a linear RGB triplet: each channel divided by the
 * maximum component, preserving the hue while normalizing brightness.
 *
 * @param rgb - Linear RGB triplet.
 * @returns Normalized chromaticity triplet.
 */
export function chromaticityOf(rgb: readonly [number, number, number]): [number, number, number] {
  const maxComponent = Math.max(rgb[0], rgb[1], rgb[2], 1e-8);
  return [rgb[0] / maxComponent, rgb[1] / maxComponent, rgb[2] / maxComponent];
}

function raySphereFar(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, radius: number): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  return -b + Math.sqrt(discriminant);
}

function phaseRayleigh(mu: number) {
  return (3 / (16 * PI)) * (1 + mu * mu);
}

function phaseMie(mu: number, g: number) {
  const g2 = g * g;
  const numerator = (1 - g2) * (1 + mu * mu);
  const denominator = (2 + g2) * (1 + g2 - 2 * g * mu) ** 1.5;
  return ((3 / (8 * PI)) * numerator) / Math.max(denominator, 1e-12);
}

/**
 * Convert an equirectangular UV coordinate to a unit direction vector.
 * u ∈ [0, 1] maps to azimuth [−π, π]; v ∈ [0, 1] maps to polar angle [0, π].
 *
 * @param u - Horizontal equirectangular coordinate.
 * @param v - Vertical equirectangular coordinate.
 * @returns World-space unit direction.
 */
export function latLongToDir(u: number, v: number): [number, number, number] {
  const phi = (u - 0.5) * 2 * PI;
  const theta = v * PI;
  const st = Math.sin(theta);
  return [st * Math.sin(phi), Math.cos(theta), st * Math.cos(phi)];
}

/**
 * Convert a unit direction vector to equirectangular UV coordinates.
 *
 * @param dx - World-space X component.
 * @param dy - World-space Y component.
 * @param dz - World-space Z component.
 * @returns [u, v] where u ∈ [0, 1] and v ∈ [0, 1].
 */
export function dirToLatLong(dx: number, dy: number, dz: number): [number, number] {
  const u = Math.atan2(dx, dz) / (2 * PI) + 0.5;
  const v = Math.acos(clamp(dy, -1, 1)) / PI;
  return [u, v];
}

/**
 * Kasten-Young optical air mass. Stays finite at the horizon, unlike 1/cos,
 * which is why a 10–15° sun already reads warm without a hand-tuned orange.
 */
export function kastenYoungAirMass(sunDirY: number): number {
  const zenithDeg = (Math.acos(clamp(sunDirY, -1, 1)) * 180) / PI;
  const denom = Math.cos((zenithDeg * PI) / 180) + 0.50572 * Math.max(1e-3, 96.07995 - zenithDeg) ** -1.6364;
  return Math.min(denom > 0 ? 1 / denom : 40, 40);
}

/** Direct solar irradiance at the ground, same units as the sky LUT. */
export function evaluateSunRadiance(
  sunDir: readonly [number, number, number],
  sunScale: number,
  warmth = 1,
): [number, number, number] {
  const airMass = kastenYoungAirMass(sunDir[1]);
  const scale = Math.max(0, sunScale);
  return [
    Math.exp(-(TAU_R_WARM[0] * warmth + TAU_M_WARM) * airMass) * scale,
    Math.exp(-(TAU_R_WARM[1] * warmth + TAU_M_WARM) * airMass) * scale,
    Math.exp(-(TAU_R_WARM[2] * warmth + TAU_M_WARM) * airMass) * scale,
  ];
}

/** How dark a fully wet surface goes relative to its dry albedo. */
export const WET_GROUND_ALBEDO_FACTOR = 0.7;

/**
 * Ground Lambertian albedo for the bounce solve. Snow weather lifts the
 * floor toward fresh snow; rain and storms darken it, and surface wetness
 * darkens every non-snow ground the way a rained-on street reads darker.
 */
export function getAtmosphereGroundAlbedo(weather: DirectorWorldWeather): [number, number, number] {
  const cover = clamp01(weather.cloudCover);
  const intensity = clamp01(weather.intensity);
  const wetness = clamp01(weather.wetness);
  if (weather.preset === "snow") {
    // Wet, melting snow dulls only slightly; fresh snow stays near-white.
    const snowAlbedo = lerp3(DEFAULT_GROUND_ALBEDO, SNOW_GROUND_ALBEDO, lerp(0.72, 1, intensity));
    return lerp3(snowAlbedo, [snowAlbedo[0] * 0.88, snowAlbedo[1] * 0.88, snowAlbedo[2] * 0.88], wetness);
  }
  const wetFactor = lerp(1, WET_GROUND_ALBEDO_FACTOR, wetness);
  let albedo: [number, number, number];
  if (weather.preset === "rain") {
    albedo = lerp3(DEFAULT_GROUND_ALBEDO, [0.12, 0.14, 0.13], lerp(0.45, 0.85, intensity));
  } else if (weather.preset === "storm") {
    albedo = lerp3(DEFAULT_GROUND_ALBEDO, [0.1, 0.11, 0.12], lerp(0.35, 0.8, intensity));
  } else if (weather.preset === "overcast") {
    albedo = lerp3(DEFAULT_GROUND_ALBEDO, [0.22, 0.24, 0.22], lerp(0.4, 0.75, cover));
  } else {
    albedo = [DEFAULT_GROUND_ALBEDO[0], DEFAULT_GROUND_ALBEDO[1], DEFAULT_GROUND_ALBEDO[2]];
  }
  return [albedo[0] * wetFactor, albedo[1] * wetFactor, albedo[2] * wetFactor];
}

/**
 * Extra Mie optical depth from haze / cloud, relative to a clear day.
 *
 * Preset haze scales with weather intensity so the five presets separate
 * clearly (snow < overcast < rain < storm at any matched intensity), and the
 * cover term uses the preset-floored effective cover so an overcast sky is
 * hazy even when the authored cover slider sits low.
 */
export function getAtmosphereMieScale(weather: DirectorWorldWeather): number {
  const intensity = clamp01(weather.intensity);
  const cover = evaluateSkyWeatherMood(weather).effectiveCloudCover;
  const extra =
    weather.preset === "clear"
      ? 0
      : weather.preset === "snow"
        ? 0.9 + 1.0 * intensity
        : weather.preset === "overcast"
          ? 1.5 + 1.3 * intensity
          : weather.preset === "rain"
            ? 1.9 + 1.7 * intensity
            : 3.0 + 2.4 * intensity;
  return 1 + 2.2 * cover + extra;
}

function nishitaSky(
  rayDx: number,
  rayDy: number,
  rayDz: number,
  sunDx: number,
  sunDy: number,
  sunDz: number,
  sunIntensity: number,
  groundBr: number,
  groundBg: number,
  groundBb: number,
  mieScale: number,
): [number, number, number] {
  const originY = EARTH_R + 800;
  const atmosDist = raySphereFar(0, originY, 0, rayDx, rayDy, rayDz, ATMOS_R);
  if (atmosDist < 0) return [0, 0, 0];

  const bIn = originY * rayDy;
  const cIn = originY * originY - EARTH_R * EARTH_R;
  const discr = bIn * bIn - cIn;
  let march = atmosDist;
  let groundDist = -1;
  if (discr > 0) {
    const sqrtDiscr = Math.sqrt(discr);
    const near = -bIn - sqrtDiscr;
    const far = -bIn + sqrtDiscr;
    if (near > 0) march = near;
    if (far > 0) groundDist = far;
  }

  const mu = rayDx * sunDx + rayDy * sunDy + rayDz * sunDz;
  const pr = phaseRayleigh(mu);
  const pm = phaseMie(mu, MIE_G);
  const betaM = BETA_M * mieScale;

  let sumR0 = 0;
  let sumR1 = 0;
  let sumR2 = 0;
  let sumM = 0;
  let shadR0 = 0;
  let shadR1 = 0;
  let shadR2 = 0;
  let shadM = 0;
  let odR = 0;
  let odM = 0;
  let tPrev = 0;

  for (let i = 0; i < VIEW_STEPS; i += 1) {
    const tNext = march * ((i + 1) / VIEW_STEPS) ** DIST_POWER;
    const stepLen = tNext - tPrev;
    const tMid = tPrev + stepLen * 0.5;
    tPrev = tNext;
    const px = rayDx * tMid;
    const py = originY + rayDy * tMid;
    const pz = rayDz * tMid;
    const h = Math.hypot(px, py, pz) - EARTH_R;
    const dR = Math.exp(-h / H_RAYLEIGH) * stepLen;
    const dM = Math.exp(-h / H_MIE) * stepLen;
    odR += dR;
    odM += dM;

    const lightDist = raySphereFar(px, py, pz, sunDx, sunDy, sunDz, ATMOS_R);
    const lStep = lightDist > 0 ? lightDist / LIGHT_STEPS : 0;
    let lR = 0;
    let lM = 0;
    let occluded = lightDist < 0;
    if (!occluded) {
      for (let j = 0; j < LIGHT_STEPS; j += 1) {
        const lt = lStep * (j + 0.5);
        const lx = px + sunDx * lt;
        const ly = py + sunDy * lt;
        const lz = pz + sunDz * lt;
        const lh = Math.hypot(lx, ly, lz) - EARTH_R;
        if (lh < 0) {
          occluded = true;
          break;
        }
        lR += Math.exp(-lh / H_RAYLEIGH) * lStep;
        lM += Math.exp(-lh / H_MIE) * lStep;
      }
    }

    if (occluded) {
      const attenV0 = Math.exp(-(BETA_R[0] * odR + betaM * 1.1 * odM));
      const attenV1 = Math.exp(-(BETA_R[1] * odR + betaM * 1.1 * odM));
      const attenV2 = Math.exp(-(BETA_R[2] * odR + betaM * 1.1 * odM));
      shadR0 += attenV0 * dR;
      shadR1 += attenV1 * dR;
      shadR2 += attenV2 * dR;
      shadM += attenV0 * dM;
      continue;
    }

    const tau0 = BETA_R[0] * (odR + lR) + betaM * 1.1 * (odM + lM);
    const tau1 = BETA_R[1] * (odR + lR) + betaM * 1.1 * (odM + lM);
    const tau2 = BETA_R[2] * (odR + lR) + betaM * 1.1 * (odM + lM);
    sumR0 += Math.exp(-tau0) * dR;
    sumR1 += Math.exp(-tau1) * dR;
    sumR2 += Math.exp(-tau2) * dR;
    sumM += Math.exp(-tau0) * dM;
  }

  const msPhase = 1 / FOUR_PI;
  let col0 =
    sunIntensity * (sumR0 * BETA_R[0] * pr + sumM * betaM * pm) +
    sunIntensity *
      ((sumR0 + shadR0 * SHADOW_FILL) * BETA_R[0] * MS_BOOST + (sumM + shadM * SHADOW_FILL) * betaM * 0.4) *
      msPhase;
  let col1 =
    sunIntensity * (sumR1 * BETA_R[1] * pr + sumM * betaM * pm) +
    sunIntensity *
      ((sumR1 + shadR1 * SHADOW_FILL) * BETA_R[1] * MS_BOOST + (sumM + shadM * SHADOW_FILL) * betaM * 0.4) *
      msPhase;
  let col2 =
    sunIntensity * (sumR2 * BETA_R[2] * pr + sumM * betaM * pm) +
    sunIntensity *
      ((sumR2 + shadR2 * SHADOW_FILL) * BETA_R[2] * MS_BOOST + (sumM + shadM * SHADOW_FILL) * betaM * 0.4) *
      msPhase;

  if (discr > 0 && groundDist > 0) {
    const downT = 1 - smoothstep(-0.03, -0.005, rayDy);
    col0 = lerp(col0, groundBr, downT);
    col1 = lerp(col1, groundBg, downT);
    col2 = lerp(col2, groundBb, downT);
  }

  const grazing = 1 - smoothstep(0, 0.26, Math.abs(rayDy));
  const pale = col0 * 0.3 + col1 * 0.42 + col2 * 0.28;
  const paleMix = grazing * 0.82;
  col0 = lerp(col0, pale * 0.97, paleMix);
  col1 = lerp(col1, pale, paleMix);
  col2 = lerp(col2, pale * 1.06, paleMix);

  return [Math.max(0, col0), Math.max(0, col1), Math.max(0, col2)];
}

function bakeLut(
  sunDir: readonly [number, number, number],
  sunScale: number,
  groundBounce: readonly [number, number, number],
  mieScale: number,
  width: number,
  height: number,
  target: Float32Array,
) {
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const dir = latLongToDir(u, v);
      const rgb = nishitaSky(
        dir[0],
        dir[1],
        dir[2],
        sunDir[0],
        sunDir[1],
        sunDir[2],
        sunScale,
        groundBounce[0],
        groundBounce[1],
        groundBounce[2],
        mieScale,
      );
      const i = (y * width + x) * 3;
      target[i] = rgb[0];
      target[i + 1] = rgb[1];
      target[i + 2] = rgb[2];
    }
  }
}

/**
 * Bilinear sample from the equirectangular atmosphere LUT.
 *
 * @param lut - Flattened RGB radiance data (row-major, `width * height * 3`).
 * @param width - Horizontal LUT resolution.
 * @param height - Vertical LUT resolution.
 * @param dir - World-space unit direction to sample.
 * @returns Interpolated radiance triplet.
 */
export function sampleAtmosphereLut(
  lut: Float32Array,
  width: number,
  height: number,
  dir: readonly [number, number, number],
): [number, number, number] {
  const [u, v] = dirToLatLong(dir[0], dir[1], dir[2]);
  const wrappedU = ((u % 1) + 1) % 1;
  const clampedV = clamp01(v);
  const fx = wrappedU * width - 0.5;
  const fy = clampedV * height - 0.5;
  const x0 = ((Math.floor(fx) % width) + width) % width;
  const x1 = (x0 + 1) % width;
  const y0 = clamp(Math.floor(fy), 0, height - 1);
  const y1 = clamp(y0 + 1, 0, height - 1);
  const tx = fx - Math.floor(fx);
  const ty = fy - Math.floor(fy);
  const i00 = (y0 * width + x0) * 3;
  const i10 = (y0 * width + x1) * 3;
  const i01 = (y1 * width + x0) * 3;
  const i11 = (y1 * width + x1) * 3;
  return [
    lerp(lerp(lut[i00]!, lut[i10]!, tx), lerp(lut[i01]!, lut[i11]!, tx), ty),
    lerp(lerp(lut[i00 + 1]!, lut[i10 + 1]!, tx), lerp(lut[i01 + 1]!, lut[i11 + 1]!, tx), ty),
    lerp(lerp(lut[i00 + 2]!, lut[i10 + 2]!, tx), lerp(lut[i01 + 2]!, lut[i11 + 2]!, tx), ty),
  ];
}

function projectLutToSH(lut: Float32Array, width: number, height: number, sh: Float32Array) {
  sh.fill(0);
  const dOmega = ((2 * PI) / width) * (PI / height);
  const Y = new Float32Array(9);
  for (let y = 0; y < height; y += 1) {
    const theta = ((y + 0.5) / height) * PI;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    const weight = st * dOmega;
    for (let x = 0; x < width; x += 1) {
      const phi = ((x + 0.5) / width - 0.5) * 2 * PI;
      const dx = st * Math.sin(phi);
      const dy = ct;
      const dz = st * Math.cos(phi);
      Y[0] = SH_BASIS_SCALE[0];
      Y[1] = SH_BASIS_SCALE[1] * dy;
      Y[2] = SH_BASIS_SCALE[2] * dz;
      Y[3] = SH_BASIS_SCALE[3] * dx;
      Y[4] = SH_BASIS_SCALE[4] * dx * dy;
      Y[5] = SH_BASIS_SCALE[5] * dy * dz;
      Y[6] = SH_BASIS_SCALE[6] * (3 * dz * dz - 1);
      Y[7] = SH_BASIS_SCALE[7] * dx * dz;
      Y[8] = SH_BASIS_SCALE[8] * (dx * dx - dy * dy);
      const i = (y * width + x) * 3;
      const r = lut[i]! * weight;
      const g = lut[i + 1]! * weight;
      const b = lut[i + 2]! * weight;
      for (let c = 0; c < 9; c += 1) {
        const basis = Y[c]!;
        sh[c * 3] += r * basis;
        sh[c * 3 + 1] += g * basis;
        sh[c * 3 + 2] += b * basis;
      }
    }
  }
}

/** SH irradiance for an up-facing normal. */
export function shIrradianceUp(sh: Float32Array): [number, number, number] {
  return [
    sh[0]! * 0.886227 + sh[3]! * 1.023328 + sh[18]! * -0.247708 + sh[24]! * -0.429043,
    sh[1]! * 0.886227 + sh[4]! * 1.023328 + sh[19]! * -0.247708 + sh[25]! * -0.429043,
    sh[2]! * 0.886227 + sh[5]! * 1.023328 + sh[20]! * -0.247708 + sh[26]! * -0.429043,
  ];
}

function solveGroundBounce(
  sunRadiance: readonly [number, number, number],
  sunDirY: number,
  skyIrradianceUp: readonly [number, number, number],
  albedo: readonly [number, number, number],
): [number, number, number] {
  const cosine = Math.max(0, sunDirY);
  return [
    albedo[0] * (sunRadiance[0] * cosine + Math.max(0, skyIrradianceUp[0])) * INV_PI,
    albedo[1] * (sunRadiance[1] * cosine + Math.max(0, skyIrradianceUp[1])) * INV_PI,
    albedo[2] * (sunRadiance[2] * cosine + Math.max(0, skyIrradianceUp[2])) * INV_PI,
  ];
}

function fillLutBelowHorizon(
  lut: Float32Array,
  width: number,
  height: number,
  bounce: readonly [number, number, number],
) {
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const dirY = Math.cos(v * PI);
    const downT = 1 - smoothstep(-0.03, -0.005, dirY);
    if (downT <= 0) continue;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      lut[i] = lerp(lut[i]!, bounce[0], downT);
      lut[i + 1] = lerp(lut[i + 1]!, bounce[1], downT);
      lut[i + 2] = lerp(lut[i + 2]!, bounce[2], downT);
    }
  }
}

function copyRgb(rgb: readonly [number, number, number]): [number, number, number] {
  return [rgb[0], rgb[1], rgb[2]];
}

function normalizeDir(dir: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  if (!Number.isFinite(length) || length < 1e-8) return [0, 1, 0];
  return [dir[0] / length, dir[1] / length, dir[2] / length];
}

function atmosphereCacheKey(
  sunDir: readonly [number, number, number],
  sunScale: number,
  albedo: readonly [number, number, number],
  mieScale: number,
): string {
  const elevationDeg = Math.round(((Math.asin(clamp(sunDir[1], -1, 1)) * 180) / PI) * 2) / 2;
  const azimuthDeg = Math.round((Math.atan2(sunDir[0], sunDir[2]) * 180) / PI);
  return [
    elevationDeg.toFixed(1),
    azimuthDeg,
    sunScale.toFixed(3),
    mieScale.toFixed(2),
    albedo[0].toFixed(2),
    albedo[1].toFixed(2),
    albedo[2].toFixed(2),
  ].join("|");
}

function rememberSolution(key: string, solution: AtmosphereSolution): AtmosphereSolution {
  if (atmosphereCache.size >= CACHE_LIMIT) {
    const oldest = atmosphereCache.keys().next().value;
    if (oldest) atmosphereCache.delete(oldest);
  }
  atmosphereCache.set(key, solution);
  return solution;
}

/** Discard all cached atmosphere solutions so the next bake is fresh. */
export function clearAtmosphereCache() {
  atmosphereCache.clear();
}

/**
 * Bake or retrieve a cached atmosphere solution for the given inputs.
 * Reuses a prior result when the quantized sun elevation, azimuth, sun scale,
 * mie scale, and ground albedo all match; otherwise runs the full Nishita
 * march, SH projection, and ground-bounce solve.
 *
 * @param input - Sun direction, scale, ground albedo, and Mie scale.
 * @param input.sunDir - Unit direction toward the sun.
 * @param input.sunScale - Sun intensity scale applied to the bake.
 * @param input.groundAlbedo - Lambertian ground albedo for the bounce solve.
 * @param input.mieScale - Mie optical depth multiplier relative to a clear day.
 * @returns The cached or freshly baked atmosphere solution.
 */
export function solveAtmosphere(input: {
  sunDir: readonly [number, number, number];
  sunScale: number;
  groundAlbedo: readonly [number, number, number];
  mieScale: number;
}): AtmosphereSolution {
  const sunDir = normalizeDir(input.sunDir);
  const sunScale = Math.max(0, input.sunScale);
  const mieScale = Math.max(0.2, input.mieScale);
  const albedo = input.groundAlbedo;
  const key = atmosphereCacheKey(sunDir, sunScale, albedo, mieScale);
  const cached = atmosphereCache.get(key);
  if (cached) return cached;

  const width = ATMOSPHERE_LUT_WIDTH;
  const height = ATMOSPHERE_LUT_HEIGHT;
  const lut = new Float32Array(width * height * 3);
  const sh = new Float32Array(27);
  const sunRadiance = evaluateSunRadiance(sunDir, sunScale);
  bakeLut(sunDir, sunScale, [0, 0, 0], mieScale, width, height, lut);
  projectLutToSH(lut, width, height, sh);
  const skyIrradianceUp = shIrradianceUp(sh);
  const groundBounce = solveGroundBounce(sunRadiance, sunDir[1], skyIrradianceUp, albedo);
  fillLutBelowHorizon(lut, width, height, groundBounce);
  projectLutToSH(lut, width, height, sh);
  const skyIrradianceUpFinal = shIrradianceUp(sh);
  const zenithColor = sampleAtmosphereLut(lut, width, height, [0, 1, 0]);
  const sunAzimuth: [number, number, number] = [sunDir[0], 0, sunDir[2]];
  const azimuthLength = Math.hypot(sunAzimuth[0], sunAzimuth[2]);
  const horizonTowardSun: [number, number, number] =
    azimuthLength > 1e-5 ? [sunAzimuth[0] / azimuthLength, 0.02, sunAzimuth[2] / azimuthLength] : [0, 0.02, 1];
  const horizonColor = sampleAtmosphereLut(lut, width, height, horizonTowardSun);
  const aerialNearDir = normalizeDir([sunDir[0] * 0.15, 0.42, sunDir[2] * 0.15]);
  const aerialNearColor = sampleAtmosphereLut(lut, width, height, aerialNearDir);

  return rememberSolution(key, {
    lut,
    width,
    height,
    sh,
    sunRadiance,
    sunColor: chromaticityOf(sunRadiance),
    skyIrradianceUp: skyIrradianceUpFinal,
    groundBounce,
    zenithColor,
    horizonColor,
    aerialNearColor,
    sunScale,
  });
}

/**
 * Pack the RGB LUT into RGBA texels for GPU upload, with an optional gain.
 *
 * @param lut - Flattened RGB radiance data.
 * @param into - Optional pre-allocated RGBA target; a new buffer is allocated when omitted.
 * @param scale - Optional gain multiplier applied to each channel (default 1).
 * @returns The RGBA-packed buffer (either `into` or a new allocation).
 */
export function packAtmosphereLutRgba(lut: Float32Array, into?: Float32Array, scale = 1): Float32Array {
  const texels = lut.length / 3;
  const rgba = into && into.length >= texels * 4 ? into : new Float32Array(texels * 4);
  const gain = Number.isFinite(scale) && scale > 0 ? scale : 1;
  for (let i = 0; i < texels; i += 1) {
    rgba[i * 4] = lut[i * 3]! * gain;
    rgba[i * 4 + 1] = lut[i * 3 + 1]! * gain;
    rgba[i * 4 + 2] = lut[i * 3 + 2]! * gain;
    rgba[i * 4 + 3] = 1;
  }
  return rgba;
}

/**
 * Defensive copy of a linear RGB triplet so callers never alias internal state.
 *
 * @param rgb - The triplet to copy.
 * @returns A new triplet with the same channel values.
 */
export function copyAtmosphereRgb(rgb: readonly [number, number, number]): [number, number, number] {
  return copyRgb(rgb);
}
