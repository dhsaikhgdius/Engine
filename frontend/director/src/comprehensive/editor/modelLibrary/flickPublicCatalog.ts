import { getFlickStandardCategory, type ModelLibraryItem } from "./modelLibraryCatalog";

/**
 * This is a public, versioned front-end bundle used only by the local sync
 * command as a directory of the Stage prop URLs Flick exposes to a browser.
 */
/**
 * This is a public, versioned front-end bundle used only by the local sync
 * command as a directory of the Stage prop URLs Flick exposes to a browser.
 */
export const FLICK_PUBLIC_STAGE_CATALOG_URL = "https://flick.art/assets/index-CGAdI8Hc.js";
/** The local mirror of the Flick stage prop catalog. */
export const FLICK_LOCAL_STAGE_CATALOG_URL = "/flick-stage-props/catalog.json";

const PUBLIC_STAGE_PROP_URL = /https:\/\/cdn\.flick\.art\/stage-props\/([^/"'\s]+)\/([^/"'\s]+\.glb)(?:\?[^"'\s]*)?/gi;

function formatComponentName(fileName: string) {
  return fileName
    .replace(/\.glb$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function localThumbnailUrl(category: string, fileName: string) {
  return `/flick-stage-props/thumbnails/${category}/${fileName.replace(/\.glb$/i, "")}.webp`;
}

function sanitizeLocalThumbnailUrl(value: unknown, category: string, fileName: string) {
  if (typeof value !== "string") return localThumbnailUrl(category, fileName);
  const trimmed = value.trim();
  if (!trimmed.startsWith("/flick-stage-props/thumbnails/")) return localThumbnailUrl(category, fileName);
  if (trimmed.includes("..") || trimmed.includes("//", 1)) return localThumbnailUrl(category, fileName);
  return trimmed;
}

function makeItem(category: string, fileName: string): ModelLibraryItem {
  const url = `https://cdn.flick.art/stage-props/${category}/${fileName}`;

  return {
    assetSource: "remote",
    catalogCategory: category,
    categoryId: "flick",
    fileName,
    flickCategory: getFlickStandardCategory(category),
    id: `flick:${category}:${fileName}`,
    kind: "prop",
    name: formatComponentName(fileName),
    thumbnailUrl: localThumbnailUrl(category, fileName),
    thumbnailKind: "image",
    url,
  };
}

function makeLocalItem({
  category,
  fileName,
  sourceUrl,
  thumbnailUrl,
}: {
  category: string;
  fileName: string;
  sourceUrl?: string;
  thumbnailUrl?: string;
}): ModelLibraryItem | null {
  if (!/^[a-z0-9_-]+$/i.test(category) || !/^[a-z0-9_.-]+\.glb$/i.test(fileName)) return null;
  if (sourceUrl && !sourceUrl.startsWith(`https://cdn.flick.art/stage-props/${category}/`)) return null;

  return {
    assetSource: "library",
    catalogCategory: category,
    categoryId: "flick",
    fileName,
    flickCategory: getFlickStandardCategory(category),
    id: `flick:${category}:${fileName}`,
    kind: "prop",
    name: formatComponentName(fileName),
    thumbnailUrl: sanitizeLocalThumbnailUrl(thumbnailUrl, category, fileName),
    thumbnailKind: "image",
    url: `/flick-stage-props/${category}/${fileName}`,
  };
}

/** Parse only canonical public stage-prop URLs and reject every other bundle URL. */
export function parseFlickPublicStageCatalog(bundle: string): ModelLibraryItem[] {
  const matches = bundle.matchAll(PUBLIC_STAGE_PROP_URL);
  const unique = new Map<string, ModelLibraryItem>();

  for (const match of matches) {
    const category = match[1];
    const fileName = match[2];
    if (!category || !fileName) continue;

    const item = makeItem(category, fileName);
    unique.set(item.url, item);
  }

  return Array.from(unique.values()).sort(
    (left, right) => left.catalogCategory!.localeCompare(right.catalogCategory!) || left.name.localeCompare(right.name),
  );
}

/**
 * Extracts the set of unique catalog categories from a list of Flick items.
 *
 * @param items - The model library items.
 * @returns Sorted array of unique category strings.
 */
export function getFlickPublicCatalogCategories(items: ModelLibraryItem[]) {
  return Array.from(
    new Set(items.map((item) => item.catalogCategory).filter((category): category is string => Boolean(category))),
  ).sort((left, right) => left.localeCompare(right));
}

type LocalCatalogPayload = {
  items?: Array<{ category?: unknown; fileName?: unknown; sourceUrl?: unknown; thumbnailUrl?: unknown }>;
};

/** Validate a locally generated catalog before exposing files from the runtime asset root. */
export function parseLocalFlickStageCatalog(payload: unknown): ModelLibraryItem[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as LocalCatalogPayload).items)) return [];

  const unique = new Map<string, ModelLibraryItem>();
  for (const entry of (payload as LocalCatalogPayload).items ?? []) {
    if (typeof entry.category !== "string" || typeof entry.fileName !== "string") continue;
    const item = makeLocalItem({
      category: entry.category,
      fileName: entry.fileName,
      sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : undefined,
      thumbnailUrl: typeof entry.thumbnailUrl === "string" ? entry.thumbnailUrl : undefined,
    });
    if (item) unique.set(item.url, item);
  }

  return Array.from(unique.values()).sort(
    (left, right) => left.catalogCategory!.localeCompare(right.catalogCategory!) || left.name.localeCompare(right.name),
  );
}

let cachedLocalItems: ModelLibraryItem[] | null = null;
let localCatalogInFlight: Promise<ModelLibraryItem[]> | null = null;

/** Load the locally mirrored catalog. No model request is sent to Flick at runtime. */
export async function loadLocalFlickStageCatalog(request: typeof fetch = fetch): Promise<ModelLibraryItem[]> {
  if (cachedLocalItems) return cachedLocalItems;
  if (localCatalogInFlight) return localCatalogInFlight;

  localCatalogInFlight = request(FLICK_LOCAL_STAGE_CATALOG_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`本地 Flick 组件目录未就绪（HTTP ${response.status}）`);

      const items = parseLocalFlickStageCatalog(await response.json());
      if (!items.length) throw new Error("本地 Flick 组件目录中没有可用的 GLB 组件");

      cachedLocalItems = items;
      return items;
    })
    .finally(() => {
      localCatalogInFlight = null;
    });

  return localCatalogInFlight;
}

/** Test hook; production code intentionally keeps a session-level catalog cache. */
export function resetFlickPublicStageCatalogCache() {
  cachedLocalItems = null;
  localCatalogInFlight = null;
}
