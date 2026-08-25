import { describe, expect, it } from "vitest";
import { getCatalogDefaultSizeM, getModelLibraryItemSizeM } from "../src/assetSizeCatalog";

describe("getCatalogDefaultSizeM", () => {
  it("prefers fine-grained source-folder defaults over standard categories", () => {
    expect(getCatalogDefaultSizeM({ sourceCategory: "trees", standardCategory: "nature" })).toBe(8);
    expect(getCatalogDefaultSizeM({ sourceCategory: "trains", standardCategory: "vehicles" })).toBe(20);
  });

  it("falls back to the standard category default", () => {
    expect(getCatalogDefaultSizeM({ sourceCategory: "unknown-folder", standardCategory: "animals" })).toBe(0.8);
    expect(getCatalogDefaultSizeM({ standardCategory: "furniture" })).toBe(1.2);
  });

  it("uses per-asset metric bounds before broad category fallbacks", () => {
    expect(
      getCatalogDefaultSizeM({
        sourceCategory: "furniture",
        standardCategory: "furniture",
        fileName: "lounge_sofa_long.glb",
      }),
    ).toBe(2.4);
    expect(
      getCatalogDefaultSizeM({
        sourceCategory: "furniture",
        standardCategory: "furniture",
        fileName: "lamp_round_floor.glb",
      }),
    ).toBe(1.75);
    expect(
      getCatalogDefaultSizeM({
        sourceCategory: "furniture",
        standardCategory: "furniture",
        fileName: "chair.glb",
      }),
    ).toBe(0.94);
    expect(
      getCatalogDefaultSizeM({
        sourceCategory: "animals",
        standardCategory: "animals",
        fileName: "cat.glb",
      }),
    ).toBe(0.6);
    expect(
      getCatalogDefaultSizeM({
        sourceCategory: "animals",
        standardCategory: "animals",
        fileName: "elephant.glb",
      }),
    ).toBe(6.5);
  });

  it("returns undefined for characters and unknown categories", () => {
    expect(getCatalogDefaultSizeM({ kind: "character", standardCategory: "animals" })).toBeUndefined();
    expect(getCatalogDefaultSizeM({ standardCategory: "other" })).toBeUndefined();
    expect(getCatalogDefaultSizeM({})).toBeUndefined();
  });

  it("resolves model library items through their catalog categories", () => {
    expect(
      getModelLibraryItemSizeM({
        kind: "prop",
        catalogCategory: "cars",
        flickCategory: "vehicles",
        fileName: "taxi.glb",
      }),
    ).toBeGreaterThan(4);
    expect(
      getModelLibraryItemSizeM({
        kind: "character",
        catalogCategory: "mixamo",
        flickCategory: "characters",
        fileName: "x-bot.glb",
      }),
    ).toBeUndefined();
  });
});
