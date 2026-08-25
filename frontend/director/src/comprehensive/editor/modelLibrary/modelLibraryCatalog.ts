import type { DirectorAssetSource, MixamoCharacterMetadata } from "../schema/directorProject";
import flickSourceCategories from "./flickSourceCategories.json";
import flickNativeItems from "./flickNativeItems.json";
import flickStandardCategories from "./flickStandardCategories.json";

export type { MixamoCharacterMetadata } from "../schema/directorProject";

/** The public Stage category vocabulary shown by Flick's component browser. */
/** The public Stage category vocabulary shown by Flick's component browser. */
export type FlickStandardCategoryId = keyof typeof flickStandardCategories;
/** The list of standard Flick categories with their display labels. */
export const FLICK_STANDARD_CATEGORIES = Object.entries(flickStandardCategories).map(([id, label]) => ({
  id: id as FlickStandardCategoryId,
  label,
}));

/** Native Stage operations that create objects directly rather than downloading GLBs. */
export type FlickNativeAction = "add-human" | "add-camera" | "add-cube" | "add-sphere";

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
 * Maps a raw source-folder category string to its standard Flick UI category.
 *
 * @param sourceCategory - The raw source folder name.
 * @returns The standard Flick category ID, defaulting to `"other"`.
 */
export function getFlickStandardCategory(sourceCategory: string): Exclude<FlickStandardCategoryId, "all"> {
  return FLICK_SOURCE_CATEGORY_MAP[sourceCategory.toLocaleLowerCase()] ?? "other";
}

/** Shared category/search filtering keeps both model-library surfaces consistent. */
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

/** Core/basic entries are native Stage operations rather than downloaded GLBs. */
export function getFlickNativeModelLibraryItems(): ModelLibraryItem[] {
  return structuredClone(flickNativeItems) as ModelLibraryItem[];
}
