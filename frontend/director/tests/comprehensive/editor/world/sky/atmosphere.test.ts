import { describe, expect, it } from "vitest";
import {
  ATMOSPHERE_SUN_SCALE_BASE,
  chromaticityOf,
  clearAtmosphereCache,
  evaluateSunRadiance,
  getAtmosphereGroundAlbedo,
  kastenYoungAirMass,
  luminanceOf,
  packAtmosphereLutRgba,
  sampleAtmosphereLut,
  SNOW_GROUND_ALBEDO,
  solveAtmosphere,
} from "../../../../../src/comprehensive/editor/world/sky/atmosphere";

describe("Kasten-Young air mass", () => {
  it("is 1 at zenith and stays finite on the horizon", () => {
    expect(kastenYoungAirMass(1)).toBeCloseTo(1, 2);
    expect(kastenYoungAirMass(0)).toBeGreaterThan(20);
    expect(kastenYoungAirMass(0)).toBeLessThanOrEqual(40);
    expect(Number.isFinite(kastenYoungAirMass(-0.2))).toBe(true);
  });
});

describe("evaluateSunRadiance", () => {
  it("reddens and dims as the sun nears the horizon", () => {
    const noon = evaluateSunRadiance([0, 1, 0], ATMOSPHERE_SUN_SCALE_BASE);
    const low = evaluateSunRadiance([0.97, Math.sin((12 * Math.PI) / 180), 0], ATMOSPHERE_SUN_SCALE_BASE);
    expect(low[2] / Math.max(low[0], 1e-6)).toBeLessThan(noon[2] / noon[0]);
    expect(luminanceOf(low)).toBeLessThan(luminanceOf(noon));
    expect(chromaticityOf(noon)[0]).toBeCloseTo(1, 5);
  });
});

describe("solveAtmosphere", () => {
  it("bakes a blue zenith with enough energy to display after ACES", () => {
    const solution = solveAtmosphere({
      sunDir: [0.2, 0.72, -0.66],
      sunScale: ATMOSPHERE_SUN_SCALE_BASE,
      groundAlbedo: [0.22, 0.21, 0.2],
      mieScale: 1,
    });
    const zenithL = luminanceOf(solution.zenithColor);
    const horizonL = luminanceOf(solution.horizonColor);
    expect(solution.zenithColor[2]).toBeGreaterThan(solution.zenithColor[0]);
    expect(zenithL).toBeGreaterThan(0.08);
    expect(horizonL).toBeGreaterThan(0.02);
    expect(solution.skyIrradianceUp[2]).toBeGreaterThan(solution.skyIrradianceUp[0]);
  });

  it("is deterministic and cached for identical inputs", () => {
    clearAtmosphereCache();
    const input = {
      sunDir: [0.15, 0.35, -0.92] as const,
      sunScale: ATMOSPHERE_SUN_SCALE_BASE,
      groundAlbedo: [0.28, 0.32, 0.22] as const,
      mieScale: 1,
    };
    const first = solveAtmosphere(input);
    const second = solveAtmosphere(input);
    expect(second).toBe(first);
    expect(first.lut.length).toBe(first.width * first.height * 3);
  });

  it("puts a blue zenith over a warmer sun-facing horizon at low elevation", () => {
    const solution = solveAtmosphere({
      sunDir: [0.96, Math.sin((14 * Math.PI) / 180), 0.12],
      sunScale: ATMOSPHERE_SUN_SCALE_BASE,
      groundAlbedo: SNOW_GROUND_ALBEDO,
      mieScale: 1,
    });
    expect(solution.zenithColor[2]).toBeGreaterThan(solution.zenithColor[0]);
    expect(solution.horizonColor[0] / Math.max(solution.horizonColor[2], 1e-6)).toBeGreaterThan(
      solution.zenithColor[0] / Math.max(solution.zenithColor[2], 1e-6),
    );
    expect(luminanceOf(solution.skyIrradianceUp)).toBeGreaterThan(0);
  });

  it("bounces more light from snow than from dark ground", () => {
    const sunDir = [0.2, 0.55, -0.8] as const;
    const dirt = solveAtmosphere({
      sunDir,
      sunScale: ATMOSPHERE_SUN_SCALE_BASE,
      groundAlbedo: [0.12, 0.13, 0.1],
      mieScale: 1,
    });
    const snow = solveAtmosphere({
      sunDir,
      sunScale: ATMOSPHERE_SUN_SCALE_BASE,
      groundAlbedo: SNOW_GROUND_ALBEDO,
      mieScale: 1,
    });
    expect(luminanceOf(snow.groundBounce)).toBeGreaterThan(luminanceOf(dirt.groundBounce) * 2);
  });

  it("samples the LUT continuously across the wrap seam", () => {
    const solution = solveAtmosphere({
      sunDir: [0, 0.4, -1],
      sunScale: ATMOSPHERE_SUN_SCALE_BASE,
      groundAlbedo: [0.28, 0.32, 0.22],
      mieScale: 1,
    });
    const left = sampleAtmosphereLut(solution.lut, solution.width, solution.height, [-0.02, 0.4, 1]);
    const right = sampleAtmosphereLut(solution.lut, solution.width, solution.height, [0.02, 0.4, 1]);
    expect(Math.abs(luminanceOf(left) - luminanceOf(right))).toBeLessThan(0.35);
  });
});

describe("packAtmosphereLutRgba", () => {
  it("applies GPU exposure without changing chromaticity", () => {
    const lut = new Float32Array([0.05, 0.1, 0.2]);
    const rgba = packAtmosphereLutRgba(lut, undefined, 4);
    expect(rgba[0]).toBeCloseTo(0.2);
    expect(rgba[1]).toBeCloseTo(0.4);
    expect(rgba[2]).toBeCloseTo(0.8);
    expect(rgba[3]).toBe(1);
  });
});

describe("getAtmosphereGroundAlbedo", () => {
  it("lifts snow weather toward fresh-snow reflectance", () => {
    const snow = getAtmosphereGroundAlbedo({ preset: "snow", intensity: 1, wetness: 0.4, cloudCover: 0.5 });
    const clear = getAtmosphereGroundAlbedo({ preset: "clear", intensity: 0, wetness: 0, cloudCover: 0 });
    expect(luminanceOf(snow)).toBeGreaterThan(luminanceOf(clear));
    expect(snow[2]).toBeGreaterThan(snow[0]);
  });
});
