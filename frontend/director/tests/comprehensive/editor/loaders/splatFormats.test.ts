import { describe, expect, it } from "vitest";
import {
  DIRECTOR_SPLAT_EXTENSIONS,
  isDirectorSplatAssetFileName,
  isDirectorSplatSequenceManifestFileName,
} from "../../../../src/comprehensive/editor/loaders/splatFormats";

describe("isDirectorSplatAssetFileName", () => {
  it.each(DIRECTOR_SPLAT_EXTENSIONS.map((extension) => [`garden-scan${extension}`]))(
    "accepts %s gaussian splat captures",
    (fileName) => {
      expect(isDirectorSplatAssetFileName(fileName)).toBe(true);
    },
  );

  it("accepts uppercase extensions and padded file names", () => {
    expect(isDirectorSplatAssetFileName("Garden.SPZ")).toBe(true);
    expect(isDirectorSplatAssetFileName("  garden.ply  ")).toBe(true);
  });

  it("accepts 4DGS sequence manifests", () => {
    expect(isDirectorSplatAssetFileName("dance.4dgs.json")).toBe(true);
    expect(isDirectorSplatAssetFileName("Dance.4DGS.JSON")).toBe(true);
  });

  it("rejects triangle mesh and unrelated file names", () => {
    expect(isDirectorSplatAssetFileName("chair.glb")).toBe(false);
    expect(isDirectorSplatAssetFileName("chair.fbx")).toBe(false);
    expect(isDirectorSplatAssetFileName("scene.usd")).toBe(false);
    expect(isDirectorSplatAssetFileName("notes.spz.txt")).toBe(false);
    expect(isDirectorSplatAssetFileName("splat")).toBe(false);
    expect(isDirectorSplatAssetFileName("settings.json")).toBe(false);
  });
});

describe("isDirectorSplatSequenceManifestFileName", () => {
  it("distinguishes sequence manifests from single captures and plain JSON", () => {
    expect(isDirectorSplatSequenceManifestFileName("dance.4dgs.json")).toBe(true);
    expect(isDirectorSplatSequenceManifestFileName("garden.spz")).toBe(false);
    expect(isDirectorSplatSequenceManifestFileName("settings.json")).toBe(false);
  });
});
