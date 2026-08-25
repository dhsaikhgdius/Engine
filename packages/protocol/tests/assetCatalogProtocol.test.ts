import { describe, expect, it } from "vitest";
import { assetCatalogItemSchema, assetCatalogLibrarySchema, flickMetadataOverlaySchema } from "../src/assetCatalogProtocol";

const validItem = {
  id: "model-library:atm",
  name: "ATM",
  name_zh: "自动取款机",
  aliases: ["取款机", "cash machine"],
  category: "structure",
  tags: ["street", "machine"],
  kind: "prop",
  files: [
    {
      format: "fbx",
      url: "/model-library/便利生活/ATM_low.fbx",
      bytes: 12345,
      sha256: "a".repeat(64).replace(/a/g, "0"),
    },
  ],
  primary_format: "fbx",
  preview: { kind: "image", thumbnail_url: null },
  spatial: {
    bounds_m: [0.8, 2, 0.6],
    footprint_m: [0.8, 0.6],
    height_m: 2,
    ground_offset_y: 0,
    front_axis: "+z",
  },
  rig: null,
  motion: null,
  source: {
    provider: "Director built-in model library",
    provenance: "bundled",
    source_url: null,
    license: "CC0-1.0",
    license_url: null,
  },
  usage_hint: "Street furniture for urban blocking.",
} as const;

describe("asset catalog v2 protocol", () => {
  it("accepts a complete catalog item", () => {
    expect(assetCatalogItemSchema.parse(validItem).id).toBe("model-library:atm");
  });

  it("rejects a primary format that is not present in files", () => {
    expect(assetCatalogItemSchema.safeParse({ ...validItem, primary_format: "glb" }).success).toBe(false);
  });

  it("requires motion metadata on motion items", () => {
    expect(assetCatalogItemSchema.safeParse({ ...validItem, kind: "motion" }).success).toBe(false);
  });

  it("rejects duplicate item ids within one library", () => {
    const catalog = {
      schema_version: 2,
      library: "model-library",
      generator: "tools/scripts/asset-ingest.ts",
      items: [validItem, validItem],
    };
    expect(assetCatalogLibrarySchema.safeParse(catalog).success).toBe(false);
  });

  it("validates the flick localization overlay shape", () => {
    const overlay = {
      schema_version: 1,
      generator: "tools/scripts/generate-flick-metadata.mjs",
      items: {
        "animals/cat.glb": {
          name_zh: "猫",
          aliases: ["猫咪"],
          tags: ["animal", "pet"],
          spatial: {
            bounds_m: [0.6, 0.42, 0.22],
            footprint_m: [0.6, 0.22],
            height_m: 0.42,
            ground_offset_y: 0,
            front_axis: null,
          },
        },
      },
    };
    expect(flickMetadataOverlaySchema.parse(overlay).items["animals/cat.glb"].name_zh).toBe("猫");
    expect(
      flickMetadataOverlaySchema.safeParse({
        ...overlay,
        items: {
          "animals/cat": {
            name_zh: "猫",
            aliases: [],
            tags: ["animal"],
            spatial: overlay.items["animals/cat.glb"].spatial,
          },
        },
      }).success,
    ).toBe(false);
  });
});
