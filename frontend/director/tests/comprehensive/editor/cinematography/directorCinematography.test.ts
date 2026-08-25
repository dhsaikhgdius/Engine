import { describe, expect, it } from "vitest";
import {
  createDirectorCinematographyCameraPatch,
  evaluateDirectorCinematography,
  getDirectorCinematographyPreset,
} from "../../../../src/comprehensive/editor/cinematography/directorCinematography";

describe("Director cinematography presets", () => {
  it("creates a complete physical-camera patch and recomputes vertical FOV", () => {
    const patch = createDirectorCinematographyCameraPatch(getDirectorCinematographyPreset("anamorphic-night"));

    expect(patch).toMatchObject({
      focalLengthMm: 50,
      sensorFormat: "super35",
      apertureFStop: 2,
      shutterAngle: 180,
      iso: 1600,
      anamorphicSqueeze: 2,
      aspectRatio: "2.39:1",
      handheldShake: "subtle",
    });
    expect(patch.fov).toBeGreaterThan(0);
    expect(patch.fov).toBeLessThan(45);
  });

  it("reports incompatible anamorphic output, telephoto shake, and high ISO in severity order", () => {
    const issues = evaluateDirectorCinematography({
      focalLengthMm: 100,
      sensorFormat: "fullFrame",
      apertureFStop: 2.8,
      focusDistanceM: 5,
      shutterAngle: 320,
      iso: 6400,
      nearClipM: 0.1,
      farClipM: 1000,
      anamorphicSqueeze: 2,
      aspectRatio: "9:16",
      handheldShake: "strong",
      action: { mode: "follow" },
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      "anamorphic-output-mismatch",
      "telephoto-handheld",
      "motion-smear",
      "high-iso",
    ]);
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("distinguishes blocking focus/clipping mistakes from intentional style guidance", () => {
    const issues = evaluateDirectorCinematography({
      focalLengthMm: 35,
      sensorFormat: "fullFrame",
      apertureFStop: 1.2,
      focusDistanceM: 0.05,
      shutterAngle: 180,
      iso: 800,
      nearClipM: 0.1,
      farClipM: 100,
      anamorphicSqueeze: 1,
      aspectRatio: "2.39:1",
      handheldShake: "off",
      action: { mode: "still" },
    });

    expect(issues[0]).toMatchObject({ code: "focus-before-near-clip", severity: "critical" });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "shallow-focus", severity: "info" }),
        expect.objectContaining({ code: "spherical-scope", severity: "info" }),
      ]),
    );
  });
});
