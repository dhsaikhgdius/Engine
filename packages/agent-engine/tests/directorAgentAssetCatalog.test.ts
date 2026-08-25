import { describe, expect, it } from "vitest";
import { assetCatalogItemSchema, flickMetadataOverlaySchema } from "@director/protocol/asset-catalog";
import {
  convertAssetCatalogV2Item,
  DIRECTOR_AGENT_ASSET_CATALOG,
  directorAgentAssetCatalogItemSchema,
  findDirectorAgentCatalogAssetsByClaim,
  getDirectorAgentCatalogAsset,
  mergeFlickMetadataOverlay,
} from "../src/directorAgentAssetCatalog";

describe("Director Agent asset catalog", () => {
  it("exposes all packaged models with unique stable ids and truthful preview state", () => {
    // 108 Mixamo characters + 1426 flick props + 6 model-library v2 props.
    expect(DIRECTOR_AGENT_ASSET_CATALOG).toHaveLength(1540);
    expect(new Set(DIRECTOR_AGENT_ASSET_CATALOG.map((item) => item.id)).size).toBe(1540);
    expect(DIRECTOR_AGENT_ASSET_CATALOG.filter((item) => item.kind === "character")).toHaveLength(108);
    expect(DIRECTOR_AGENT_ASSET_CATALOG.filter((item) => item.preview.status === "ready")).toHaveLength(1540);
    expect(DIRECTOR_AGENT_ASSET_CATALOG.filter((item) => item.preview.status === "runtime")).toHaveLength(0);
    expect(
      DIRECTOR_AGENT_ASSET_CATALOG.every((item) => directorAgentAssetCatalogItemSchema.safeParse(item).success),
    ).toBe(true);
  });

  it("carries bilingual naming, tags, and spatial metadata on every item", () => {
    expect(
      DIRECTOR_AGENT_ASSET_CATALOG.every((item) => "name_zh" in item && Array.isArray(item.tags) && "spatial" in item),
    ).toBe(true);
    const characters = DIRECTOR_AGENT_ASSET_CATALOG.filter((item) => item.kind === "character");
    const props = DIRECTOR_AGENT_ASSET_CATALOG.filter((item) => item.kind === "prop");
    expect(
      characters.every(
        (item) =>
          item.tags.includes("character") &&
          item.tags.includes("mixamo") &&
          (item.spatial?.height_m ?? 0) > 0 &&
          typeof item.spatial?.ground_offset_y === "number",
      ),
    ).toBe(true);
    expect(
      props.every(
        (item) =>
          item.spatial?.bounds_m?.every((value) => value >= 0) &&
          Math.max(...item.spatial.bounds_m) > 0 &&
          item.asset.realWorldSizeM === Math.max(...item.spatial.bounds_m) &&
          item.asset.localBoundsM?.min[1] === 0 &&
          item.asset.localBoundsM?.max[1] === item.spatial.bounds_m[1],
      ),
    ).toBe(true);
    expect(getDirectorAgentCatalogAsset("mixamo:x-bot")).toMatchObject({
      name_zh: null,
      tags: ["character", "mixamo"],
      spatial: { height_m: 1.78, bounds_m: null, footprint_m: null, front_axis: null },
    });
    // Flick props are localized and metrically calibrated through the generated
    // metadata overlay wired at module init.
    expect(getDirectorAgentCatalogAsset("flick:animals:cat.glb")).toMatchObject({
      name_zh: "猫",
      aliases: expect.arrayContaining(["猫咪", "小猫", "cat"]),
      tags: expect.arrayContaining(["animals", "animal", "cat", "pet", "feline"]),
      spatial: {
        bounds_m: expect.arrayContaining([0.6]),
        height_m: expect.any(Number),
        ground_offset_y: expect.any(Number),
      },
    });
    expect(getDirectorAgentCatalogAsset("model-library:atm")).toMatchObject({
      name_zh: "自动取款机",
      category: "structure",
      source: { provider: "Director built-in model library", provenance: "bundled" },
    });
  });

  it("resolves exact assets without guessing ids", () => {
    expect(getDirectorAgentCatalogAsset("mixamo:x-bot")).toMatchObject({
      kind: "character",
      category: "characters",
      aliases: expect.arrayContaining(["XBot", "Human", "人物"]),
      preview: { status: "ready", kind: "image" },
      asset: {
        url: "/mixamo-characters/models/x-bot.glb",
        characterMetadata: { heightM: 1.78, rig: { type: "mixamo", boneCount: 65 } },
      },
      source: { provider: "Adobe Mixamo", provenance: "local-user-supplied" },
    });
    expect(getDirectorAgentCatalogAsset("flick:animals:cat.glb")).toMatchObject({
      kind: "prop",
      category: "animals",
      thumbnail_url: "/flick-stage-props/thumbnails/animals/cat.webp",
      preview: {
        status: "ready",
        kind: "image",
        url: "/flick-stage-props/thumbnails/animals/cat.webp",
        source_model_url: "/flick-stage-props/animals/cat.glb",
      },
      asset: { url: "/flick-stage-props/animals/cat.glb" },
    });
    expect(getDirectorAgentCatalogAsset("flick:furniture:lounge_sofa_long.glb")).toMatchObject({
      asset: { realWorldSizeM: 2.4, sizeSource: "catalog" },
    });
    expect(getDirectorAgentCatalogAsset("flick:animals:elephant.glb")).toMatchObject({
      asset: { realWorldSizeM: 6.5, sizeSource: "catalog" },
    });
    expect(getDirectorAgentCatalogAsset("flick:animals:not-real.glb")).toBeNull();
    expect(findDirectorAgentCatalogAssetsByClaim("XBot").map((item) => item.id)).toEqual(["mixamo:x-bot"]);
  });

  it("converts an Asset Catalog v2 model item into an author-ready agent item", () => {
    const v2Item = assetCatalogItemSchema.parse({
      id: "model-library:atm",
      name: "ATM",
      name_zh: "自动取款机",
      aliases: ["取款机", "cash machine"],
      category: "structure",
      tags: ["street", "machine"],
      kind: "prop",
      files: [
        { format: "glb", url: "/model-library/structures/atm.glb", bytes: 12345, sha256: null },
        { format: "fbx", url: "/model-library/structures/atm.fbx", bytes: 23456, sha256: null },
      ],
      primary_format: "glb",
      preview: { kind: "image", thumbnail_url: "/model-library/thumbnails/structures/atm.webp" },
      spatial: { bounds_m: [0.8, 2, 0.6], footprint_m: [0.8, 0.6], height_m: 2, ground_offset_y: 0, front_axis: "+z" },
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
    });

    const converted = convertAssetCatalogV2Item("model-library", v2Item);
    expect(converted).not.toBeNull();
    expect(directorAgentAssetCatalogItemSchema.parse(converted)).toEqual(converted);
    expect(converted).toMatchObject({
      id: "model-library:atm",
      name: "ATM",
      name_zh: "自动取款机",
      kind: "prop",
      category: "structure",
      source_category: "model-library/structure",
      file_name: "atm.glb",
      aliases: ["取款机", "cash machine"],
      tags: ["street", "machine"],
      spatial: { bounds_m: [0.8, 2, 0.6], height_m: 2, ground_offset_y: 0, front_axis: "+z" },
      model_url: "/model-library/structures/atm.glb",
      thumbnail_url: "/model-library/thumbnails/structures/atm.webp",
      preview: {
        status: "ready",
        kind: "image",
        url: "/model-library/thumbnails/structures/atm.webp",
        thumbnail_url: "/model-library/thumbnails/structures/atm.webp",
        source_model_url: "/model-library/structures/atm.glb",
      },
      asset: {
        id: "model-library:atm",
        kind: "prop",
        sourceType: "model",
        fileName: "atm.glb",
        name: "ATM",
        url: "/model-library/structures/atm.glb",
        assetSource: "library",
        localBoundsM: { min: [-0.4, 0, -0.3], max: [0.4, 2, 0.3] },
      },
      authoring: {
        object_id: "catalog-instance-model-library:atm",
        actions: [
          { action: "upsert_asset", asset: { id: "model-library:atm" } },
          {
            action: "add_object",
            id: "catalog-instance-model-library:atm",
            name: "ATM",
            kind: "prop",
            asset_id: "model-library:atm",
            placement_mode: "grounded",
          },
        ],
      },
      source: { provider: "Director built-in model library", provenance: "bundled", source_url: null },
    });
  });

  it("converts v2 characters with runtime previews and skips non-model kinds", () => {
    const v2Character = assetCatalogItemSchema.parse({
      id: "hero-pack:knight",
      name: "Knight",
      name_zh: "骑士",
      aliases: [],
      category: "hero",
      tags: ["character"],
      kind: "character",
      files: [{ format: "glb", url: "/hero-pack/knight.glb", bytes: null, sha256: null }],
      primary_format: "glb",
      preview: { kind: "model", thumbnail_url: null },
      spatial: { bounds_m: null, footprint_m: null, height_m: 1.9, ground_offset_y: 0, front_axis: "+z" },
      rig: { type: "mixamo", bone_prefix: "mixamorig", bone_count: 65 },
      motion: null,
      source: { provider: "Hero pack", provenance: "local-mirror", source_url: null, license: null, license_url: null },
      usage_hint: null,
    });
    expect(convertAssetCatalogV2Item("hero-pack", v2Character)).toMatchObject({
      kind: "character",
      category: "characters",
      name_zh: "骑士",
      preview: {
        status: "runtime",
        kind: "model",
        url: "/hero-pack/knight.glb",
        thumbnail_url: null,
        source_model_url: "/hero-pack/knight.glb",
      },
      authoring: {
        actions: [
          { action: "upsert_asset" },
          { action: "add_object", character_source: "asset", placement_mode: "grounded" },
        ],
      },
    });

    const v2Motion = assetCatalogItemSchema.parse({
      id: "motion-pack:walk",
      name: "Walk",
      name_zh: null,
      aliases: [],
      category: "locomotion",
      tags: [],
      kind: "motion",
      files: [{ format: "fbx", url: "/motion-pack/walk.fbx", bytes: null, sha256: null }],
      primary_format: "fbx",
      preview: { kind: "image", thumbnail_url: null },
      spatial: null,
      rig: null,
      motion: {
        duration_s: 1.2,
        frame_count: 36,
        source_fps: 30,
        default_loop: "repeat",
        recommended_root_motion: "in-place",
      },
      source: { provider: "Motion pack", provenance: "bundled", source_url: null, license: null, license_url: null },
      usage_hint: null,
    });
    expect(convertAssetCatalogV2Item("motion-pack", v2Motion)).toBeNull();
  });

  it("merges the flick i18n overlay into matching items and leaves the rest untouched", () => {
    const overlay = flickMetadataOverlaySchema.parse({
      schema_version: 1,
      generator: "tools/scripts/generate-flick-metadata.mjs",
      items: {
        "animals/cat.glb": {
          name_zh: "猫",
          aliases: ["猫咪", "小猫"],
          tags: ["动物", "宠物"],
          spatial: {
            bounds_m: [0.6, 0.42, 0.22],
            footprint_m: [0.6, 0.22],
            height_m: 0.42,
            ground_offset_y: 0,
            front_axis: null,
          },
        },
      },
    });
    // Strip the shipped localization first so the fixture overlay's effect is
    // observable in isolation.
    const cat = directorAgentAssetCatalogItemSchema.parse({
      ...getDirectorAgentCatalogAsset("flick:animals:cat.glb")!,
      name_zh: null,
      aliases: [],
      tags: [],
    });
    const bear = getDirectorAgentCatalogAsset("flick:animals:brown_bear.glb")!;
    const xBot = getDirectorAgentCatalogAsset("mixamo:x-bot")!;

    const merged = mergeFlickMetadataOverlay([cat, bear, xBot], overlay);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({
      id: "flick:animals:cat.glb",
      name_zh: "猫",
      aliases: ["猫咪", "小猫"],
      tags: ["动物", "宠物"],
      spatial: { bounds_m: [0.6, 0.42, 0.22] },
      asset: {
        realWorldSizeM: 0.6,
        sizeSource: "catalog",
        localBoundsM: { min: [-0.3, 0, -0.11], max: [0.3, 0.42, 0.11] },
      },
    });
    expect(directorAgentAssetCatalogItemSchema.parse(merged[0])).toEqual(merged[0]);
    expect(merged[1]).toBe(bear);
    expect(merged[2]).toBe(xBot);
  });
});
