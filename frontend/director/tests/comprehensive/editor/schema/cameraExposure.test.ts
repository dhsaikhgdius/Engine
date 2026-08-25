import { describe, expect, it } from "vitest";
import {
  DIRECTOR_RENDERER_EXPOSURE_MULTIPLIER_LIMITS,
  calculateDirectorCameraExposure,
} from "../../../../src/comprehensive/editor/schema/cameraExposure";

describe("calculateDirectorCameraExposure", () => {
  it("uses the Director camera default as the neutral renderer exposure", () => {
    const exposure = calculateDirectorCameraExposure({
      apertureFStop: 2.8,
      iso: 800,
      shutterAngle: 180,
    });

    expect(exposure).toMatchObject({
      apertureFStop: 2.8,
      iso: 800,
      shutterAngle: 180,
      fps: 24,
      rendererExposureMultiplier: 1,
    });
    expect(exposure.shutterSeconds).toBeCloseTo(1 / 48, 12);
    expect(exposure.ev100).toBeCloseTo(Math.log2(2.8 ** 2 * 48 * (100 / 800)), 12);
  });

  it("responds predictably to ISO, aperture, shutter angle, and frame rate", () => {
    const iso1600 = calculateDirectorCameraExposure({ apertureFStop: 2.8, iso: 1_600, shutterAngle: 180 }, 24);
    expect(iso1600).toMatchObject({
      rendererExposureMultiplier: 2,
    });
    expect(iso1600.ev100).toBeCloseTo(
      calculateDirectorCameraExposure({ apertureFStop: 2.8, iso: 800, shutterAngle: 180 }, 24).ev100 - 1,
      12,
    );
    expect(
      calculateDirectorCameraExposure({ apertureFStop: 2.8, iso: 800, shutterAngle: 360 }, 24)
        .rendererExposureMultiplier,
    ).toBeCloseTo(2, 12);
    expect(
      calculateDirectorCameraExposure({ apertureFStop: 2.8, iso: 800, shutterAngle: 180 }, 48)
        .rendererExposureMultiplier,
    ).toBeCloseTo(0.5, 12);
    expect(
      calculateDirectorCameraExposure({ apertureFStop: 4, iso: 800, shutterAngle: 180 }, 24).rendererExposureMultiplier,
    ).toBeCloseTo(2.8 ** 2 / 4 ** 2, 12);
  });

  it("normalizes invalid inputs and clamps extreme multipliers to finite bounds", () => {
    const normalized = calculateDirectorCameraExposure(
      {
        apertureFStop: Number.NaN,
        iso: Number.POSITIVE_INFINITY,
        shutterAngle: Number.NaN,
      },
      Number.NaN,
    );
    expect(normalized).toMatchObject({
      apertureFStop: 2.8,
      iso: 800,
      shutterAngle: 180,
      fps: 24,
      rendererExposureMultiplier: 1,
    });
    expect(Number.isFinite(normalized.shutterSeconds)).toBe(true);
    expect(Number.isFinite(normalized.ev100)).toBe(true);

    const brightest = calculateDirectorCameraExposure({ apertureFStop: 0.7, iso: 102_400, shutterAngle: 360 }, 1);
    const darkest = calculateDirectorCameraExposure({ apertureFStop: 64, iso: 25, shutterAngle: 1 }, 240);
    expect(brightest.rendererExposureMultiplier).toBe(DIRECTOR_RENDERER_EXPOSURE_MULTIPLIER_LIMITS.max);
    expect(darkest.rendererExposureMultiplier).toBe(DIRECTOR_RENDERER_EXPOSURE_MULTIPLIER_LIMITS.min);
    expect(Number.isFinite(brightest.ev100)).toBe(true);
    expect(Number.isFinite(darkest.ev100)).toBe(true);
  });

  it("preserves professional fractional rates and clamps out-of-range values through the timeline contract", () => {
    expect(calculateDirectorCameraExposure({}, 23.976).fps).toBe(23.976);
    expect(calculateDirectorCameraExposure({}, 24_000 / 1_001).fps).toBe(23.976024);
    expect(calculateDirectorCameraExposure({}, 0).fps).toBe(1);
    expect(calculateDirectorCameraExposure({}, 9_999).fps).toBe(240);
  });
});
