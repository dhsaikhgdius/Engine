import type { FlickStandardCategoryId, ModelLibraryItem } from "./modelLibraryCatalog";
import flickMetadataOverlayJson from "../../../assets/library/flick-stage-props/metadata.i18n.json";
import { flickMetadataOverlaySchema } from "@director/protocol/asset-catalog";

/**
 * Fallback real-world sizes for catalog props, in meters (largest bounding-box
 * dimension). Packaged assets use their generated per-item metric bounds;
 * these category values only cover catalog entries without authored bounds.
 */
const STANDARD_CATEGORY_SIZE_M: Partial<Record<Exclude<FlickStandardCategoryId, "all">, number>> = {
  animals: 0.8,
  furniture: 1.2,
  guns: 1,
  weapons: 1.2,
  nature: 6,
  structure: 6,
  vehicles: 4.5,
};

/** Finer-grained defaults keyed by the raw source folder of the catalog. */
const SOURCE_CATEGORY_SIZE_M: Record<string, number> = {
  boats: 12,
  buildings: 15,
  cars: 4.5,
  dungeon: 5,
  houses: 10,
  medieval: 4,
  medievalkit: 4,
  pirate: 8,
  spaceships: 15,
  tanks: 7,
  trains: 20,
  trees: 8,
};

/** Validated localization and metric facts for every mirrored Flick model. */
export const FLICK_PACKAGED_METADATA = flickMetadataOverlaySchema.parse(flickMetadataOverlayJson);

const FLICK_ASSET_SIZE_M = new Map(
  Object.entries(FLICK_PACKAGED_METADATA.items).flatMap(([key, entry]) =>
    entry.spatial.bounds_m ? [[key.toLocaleLowerCase(), Math.max(...entry.spatial.bounds_m)] as const] : [],
  ),
);

/**
 * Looks up the default real-world size in meters for a catalog item.
 *
 * Characters are excluded (they are normalized by rig height, not catalog size).
 * Falls back through exact asset, source category, then standard Flick category.
 *
 * @param input - The item's kind, source category, and standard category.
 * @returns The default size in meters, or undefined if no match is found.
 */
export function getCatalogDefaultSizeM(input: {
  kind?: "character" | "prop" | "scene";
  sourceCategory?: string | null;
  standardCategory?: string | null;
  fileName?: string | null;
}): number | undefined {
  // Characters are normalized by their rig height, never by the size catalog.
  if (input.kind === "character") return undefined;
  const sourceKey = input.sourceCategory?.trim().toLocaleLowerCase();
  const fileKey = input.fileName?.trim().toLocaleLowerCase();
  if (sourceKey && fileKey) {
    const assetSizeM = FLICK_ASSET_SIZE_M.get(`${sourceKey}/${fileKey}`);
    if (assetSizeM !== undefined) return assetSizeM;
  }
  if (sourceKey && SOURCE_CATEGORY_SIZE_M[sourceKey] !== undefined) return SOURCE_CATEGORY_SIZE_M[sourceKey];
  const standardKey = input.standardCategory?.trim().toLocaleLowerCase();
  if (!standardKey) return undefined;
  return STANDARD_CATEGORY_SIZE_M[standardKey as Exclude<FlickStandardCategoryId, "all">];
}

/**
 * Convenience wrapper that looks up the default size for a model library item.
 *
 * @param item - The model library item with kind and category fields.
 * @returns The default size in meters, or undefined.
 */
export function getModelLibraryItemSizeM(
  item: Pick<ModelLibraryItem, "kind" | "catalogCategory" | "flickCategory" | "fileName">,
): number | undefined {
  return getCatalogDefaultSizeM({
    kind: item.kind,
    sourceCategory: item.catalogCategory,
    standardCategory: item.flickCategory,
    fileName: item.fileName,
  });
}
