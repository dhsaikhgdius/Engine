import type { DirectorAssetSource, MixamoCharacterMetadata } from "@director/project-schema";
import flickSourceCategories from "./flickSourceCategories.json";
import flickNativeItems from "./flickNativeItems.json";
import flickStandardCategories from "./flickStandardCategories.json";

export type { MixamoCharacterMetadata } from "@director/project-schema";

/** The public Stage category vocabulary shown by Flick's component browser. */
export type FlickStandardCategoryId = keyof typeof flickStandardCategories;

/** All standard Flick categories with their labels. */
export const FLICK_STANDARD_CATEGORIES = Object.entries(flickStandardCategories).map(([id, label]) => ({
  id: id as FlickStandardCategoryId,
  label,
}));

/** Native operations that Flick can perform without loading a GLB. */
export type FlickNativeAction = "add-human" | "add-camera" | "add-cube" | "add-sphere";

/** A single item in the model library, used by Flick's component browser and Agent resolution. */
export type ModelLibraryItem = {
  /** Exact, locale-aware claims shared by UI search and Agent resolution. */
  aliases?: readonly string[];
  assetSource?: DirectorAssetSource;
  /** All browser entries are Flick Stage entries. */
  categoryId: "flick";
  /** Raw source-folder category retained for provenance and search. */
  catalogCategory?: string;
  fileName: string;
  /** Flick's public UI category, distinct from the raw source folder. */
  flickCategory: Exclude<FlickStandardCategoryId, "all">;
  id: string;
  kind?: "character" | "prop" | "scene";
  /** Offline-computed placement and rig information for packaged Mixamo characters. */
  characterMetadata?: MixamoCharacterMetadata;
  name: string;
  nativeAction?: FlickNativeAction;
  /** Optional thumbnail image URL (SVG/PNG/WebP) for the card preview. */
  thumbnailUrl?: string;
  /** Local Flick entries use the GLB itself as the source for the card cover. */
  thumbnailKind?: "image" | "model";
  url: string;
};

const FLICK_SOURCE_CATEGORY_MAP = flickSourceCategories as Record<string, Exclude<FlickStandardCategoryId, "all">>;

/**
 * Map a raw source-folder category name to a Flick standard category.
 *
 * @param sourceCategory - The raw source category string.
 * @returns The corresponding Flick standard category, defaulting to "other".
 */
export function getFlickStandardCategory(sourceCategory: string): Exclude<FlickStandardCategoryId, "all"> {
  return FLICK_SOURCE_CATEGORY_MAP[sourceCategory.toLocaleLowerCase()] ?? "other";
}

/**
 * Filter model library items by category and search query.
 * Deduplicates by ID, ensuring Core Human and the characters-tab X Bot
 * always render as a single card.
 *
 * @param items - The items to filter.
 * @param categoryId - The Flick category to filter by ("all" shows everything).
 * @param query - The search query (matched against name, fileName, catalogCategory, and aliases).
 * @returns Filtered items with duplicates removed by ID.
 */
export function filterModelLibraryItems(
  items: readonly ModelLibraryItem[],
  categoryId: FlickStandardCategoryId,
  query: string,
): ModelLibraryItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const matching = items.filter((item) => {
    if (categoryId !== "all" && item.flickCategory !== categoryId) return false;
    if (!normalizedQuery) return true;

    return `${item.name} ${item.fileName} ${item.catalogCategory ?? ""} ${(item.aliases ?? []).join(" ")}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  // Core Human and the characters-tab X Bot intentionally share one catalog
  // identity. Never render duplicate React cards for the same authorable asset.
  return [...new Map(matching.map((item) => [item.id, item])).values()];
}

/**
 * Get the core/basic Flick entries that are native Stage operations
 * rather than downloaded GLBs.
 *
 * @returns A deep-cloned array of native model library items.
 */
export function getFlickNativeModelLibraryItems(): ModelLibraryItem[] {
  return structuredClone(flickNativeItems) as ModelLibraryItem[];
}
