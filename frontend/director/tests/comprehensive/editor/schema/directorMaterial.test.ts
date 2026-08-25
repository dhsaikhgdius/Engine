import { describe, expect, it } from "vitest";
import {
  mergeDirectorPbrMaterial,
  resolveDirectorPbrMaterial,
} from "../../../../src/comprehensive/editor/schema/directorMaterial";

describe("Director PBR material", () => {
  it("keeps legacy object colors while supplying deterministic PBR defaults", () => {
    expect(resolveDirectorPbrMaterial({ color: "#123456" })).toMatchObject({
      baseColor: "#123456",
      metalness: 0.02,
      roughness: 0.68,
      opacity: 1,
      side: "front",
    });
  });

  it("merges texture slots without dropping existing bindings", () => {
    expect(
      mergeDirectorPbrMaterial(
        { roughness: 0.3, textures: { baseColorMapAssetId: "texture_base" } },
        { metalness: 0.8, textures: { normalMapAssetId: "texture_normal" } },
      ),
    ).toEqual({
      roughness: 0.3,
      metalness: 0.8,
      textures: { baseColorMapAssetId: "texture_base", normalMapAssetId: "texture_normal" },
    });
  });
});
