import mixamoCharacterCatalogJson from "../../../../../../assets/library/mixamo-characters/catalog.json";
import { normalizeAssetCatalogClaim } from "../../../../../../packages/protocol/src/primitives";
import type { DirectorAssetRef, DirectorProject } from "../schema/directorProject";
import { parseCharacterCatalog, type CharacterCatalogEntry } from "./characterCatalogParser";
import type { ModelLibraryItem } from "./modelLibraryCatalog";

export const MIXAMO_CHARACTER_CATALOG_URL = "/mixamo-characters/catalog.json";
/** The fallback character asset ID used when a binding is broken. */
export const DEFAULT_MIXAMO_CHARACTER_ASSET_ID = "mixamo:x-bot";
const MIXAMO_ASSET_ROOT = "/mixamo-characters/";
const MODEL_EXTENSION = /\.glb$/i;
const THUMBNAIL_EXTENSION = /\.(?:avif|jpe?g|png|svg|webp)$/i;

function characterAliases(id: string, name: string, fileName: string) {
  const aliases = [name.replace(/\s+/g, ""), fileName.replace(MODEL_EXTENSION, ""), `Mixamo ${name}`];
  if (id === DEFAULT_MIXAMO_CHARACTER_ASSET_ID) {
    aliases.push("XBot", "Human", "Person", "Character", "人物", "角色", "默认人物", "默认角色");
  }
  return [...new Set(aliases)];
}

/** Parse the generated local package without trusting manifest paths or geometry metadata. */
export function parseLocalMixamoCharacterCatalog(payload: unknown): ModelLibraryItem[] {
  return parseCharacterCatalog(payload, {
    assetRoot: MIXAMO_ASSET_ROOT,
    modelExtension: MODEL_EXTENSION,
    thumbnailExtension: THUMBNAIL_EXTENSION,
    deduplicateBy: "id-url-first",
    resolveId: (entry: CharacterCatalogEntry) => {
      const requestedId = typeof entry.id === "string" ? entry.id.trim() : "";
      return /^mixamo:[a-z0-9][a-z0-9-]*$/.test(requestedId) ? requestedId : null;
    },
    aliases: characterAliases,
  });
}

/**
 * Canonical packaged-character registry. UI cards, Agent discovery and project
 * migration all derive from this exact frozen list rather than rebuilding
 * subtly different identities.
 */
export const MIXAMO_CHARACTER_CATALOG: readonly ModelLibraryItem[] = Object.freeze(
  parseLocalMixamoCharacterCatalog(mixamoCharacterCatalogJson),
);

const catalogItemById = new Map(MIXAMO_CHARACTER_CATALOG.map((item) => [item.id, item]));
const catalogItemByUrl = new Map(MIXAMO_CHARACTER_CATALOG.map((item) => [item.url, item]));
const catalogItemsByClaim = new Map<string, ModelLibraryItem[]>();

MIXAMO_CHARACTER_CATALOG.forEach((item) => {
  new Set([item.id, item.name, item.fileName, ...(item.aliases ?? [])]).forEach((claim) => {
    const normalized = normalizeAssetCatalogClaim(claim);
    if (!normalized) return;
    const matches = catalogItemsByClaim.get(normalized) ?? [];
    matches.push(item);
    catalogItemsByClaim.set(normalized, matches);
  });
});

/**
 * Looks up a Mixamo character catalog item by its stable ID.
 *
 * @param assetId - The catalog item ID (e.g. `"mixamo:x-bot"`).
 * @returns The catalog item or null if not found.
 */
export function getMixamoCharacterCatalogItem(assetId: string) {
  return catalogItemById.get(assetId) ?? null;
}

/**
 * Looks up a Mixamo character catalog item by its model URL.
 *
 * @param modelUrl - The full model URL.
 * @returns The catalog item or null if not found.
 */
export function getMixamoCharacterCatalogItemByUrl(modelUrl: string) {
  return catalogItemByUrl.get(modelUrl) ?? null;
}

/** Exact, punctuation-insensitive matching only. This never guesses by substring. */
export function findMixamoCharacterCatalogItemsByClaim(nameOrId: string) {
  const normalized = normalizeAssetCatalogClaim(nameOrId);
  return normalized ? [...(catalogItemsByClaim.get(normalized) ?? [])] : [];
}

/**
 * Returns the default Mixamo character catalog item (X Bot).
 *
 * @returns The default character item.
 * @throws If the default character is missing from the catalog.
 */
export function getDefaultMixamoCharacterCatalogItem() {
  const item = getMixamoCharacterCatalogItem(DEFAULT_MIXAMO_CHARACTER_ASSET_ID);
  if (!item) throw new Error(`Default Mixamo character ${DEFAULT_MIXAMO_CHARACTER_ASSET_ID} is missing.`);
  return item;
}

/**
 * Creates a Director asset reference from a Mixamo character catalog item.
 *
 * @param item - The catalog item (must be a character with metadata).
 * @returns A validated asset reference ready for insertion into a project.
 * @throws If the item is not a complete character with metadata.
 */
export function createMixamoCharacterAssetRef(item: ModelLibraryItem): DirectorAssetRef {
  if (item.kind !== "character" || !item.characterMetadata || item.assetSource !== "library") {
    throw new Error(`Character catalog item ${item.id} is incomplete.`);
  }
  return {
    id: item.id,
    kind: "character",
    sourceType: "model",
    fileName: item.fileName,
    name: item.name,
    url: item.url,
    assetSource: "library",
    characterMetadata: structuredClone(item.characterMetadata),
  };
}

/**
 * Creates an asset reference for the default Mixamo character (X Bot).
 *
 * @returns The default character asset reference.
 */
export function getDefaultMixamoCharacterAssetRef() {
  return createMixamoCharacterAssetRef(getDefaultMixamoCharacterCatalogItem());
}

/**
 * Character-only referential integrity used at import, persistence and Agent
 * boundaries. Field drift against the packaged catalog is handled by migration
 * rewrites, so only structurally broken bindings surface as issues here.
 */
export function getDirectorCharacterAssetBindingIssues(project: DirectorProject) {
  const issues: string[] = [];
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  project.objects.forEach((object) => {
    if (object.kind !== "character") return;
    if (!object.assetRefId) {
      issues.push(`${object.id} is a character without assetRefId`);
      return;
    }
    const asset = assetsById.get(object.assetRefId);
    if (!asset) {
      issues.push(`${object.id}.assetRefId "${object.assetRefId}" does not exist`);
      return;
    }
    if (asset.kind !== "character" || asset.sourceType !== "model") {
      issues.push(`${object.id}.assetRefId "${object.assetRefId}" is not a character model`);
      return;
    }
    if (object.characterSource !== "asset") {
      issues.push(`${object.id}.characterSource must be "asset"`);
    }
    const catalogItem = getMixamoCharacterCatalogItem(asset.id) ?? getMixamoCharacterCatalogItemByUrl(asset.url);
    if ((asset.assetSource === "library" || asset.url.startsWith(MIXAMO_ASSET_ROOT)) && !catalogItem) {
      issues.push(`${object.id}.assetRefId "${asset.id}" is not in the packaged Mixamo catalog`);
    }
  });
  return issues;
}

export interface DirectorCharacterBindingRepairResult {
  project: DirectorProject;
  repairs: string[];
}

/** Rebinds structurally broken character bindings to the default packaged character instead of rejecting the load. */
export function repairDirectorCharacterAssetBindings(project: DirectorProject): DirectorCharacterBindingRepairResult {
  const repairs: string[] = [];
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  let assets = project.assets;

  const ensureDefaultAssetId = () => {
    const defaultId = DEFAULT_MIXAMO_CHARACTER_ASSET_ID;
    const existing = assetsById.get(defaultId);
    if (!existing || existing.kind !== "character" || existing.sourceType !== "model") {
      const defaultRef = getDefaultMixamoCharacterAssetRef();
      assets = existing
        ? assets.map((asset) => (asset.id === defaultId ? defaultRef : asset))
        : [...assets, defaultRef];
      assetsById.set(defaultId, defaultRef);
    }
    return defaultId;
  };

  let objectsChanged = false;
  const objects = project.objects.map((object) => {
    if (object.kind !== "character") return object;
    const asset = object.assetRefId ? assetsById.get(object.assetRefId) : undefined;
    const invalidKind = asset ? asset.kind !== "character" || asset.sourceType !== "model" : false;
    const missingFromCatalog = asset
      ? (asset.assetSource === "library" || asset.url.startsWith(MIXAMO_ASSET_ROOT)) &&
        !getMixamoCharacterCatalogItem(asset.id) &&
        !getMixamoCharacterCatalogItemByUrl(asset.url)
      : false;

    let next = object;
    if (!asset || invalidKind || missingFromCatalog) {
      const defaultId = ensureDefaultAssetId();
      const reason = !object.assetRefId
        ? "缺少 assetRefId"
        : !asset
          ? `引用的资产 ${object.assetRefId} 不存在`
          : invalidKind
            ? `引用的资产 ${object.assetRefId} 不是角色模型`
            : `引用的资产 ${object.assetRefId} 不在打包角色目录中`;
      repairs.push(`角色 ${object.id} ${reason}，已改绑默认角色 ${defaultId}`);
      next = { ...next, assetRefId: defaultId, characterSource: "asset" };
    } else if (object.characterSource !== "asset") {
      repairs.push(`角色 ${object.id} 的 characterSource 已修正为 "asset"`);
      next = { ...next, characterSource: "asset" };
    }
    if (next !== object) objectsChanged = true;
    return next;
  });

  if (!objectsChanged && assets === project.assets) return { project, repairs };
  return { project: { ...project, assets, objects }, repairs };
}

let cachedItems: ModelLibraryItem[] | null = null;
let catalogInFlight: Promise<ModelLibraryItem[]> | null = null;

/** Load the converted Mixamo character package once per browser session. */
export async function loadLocalMixamoCharacterCatalog(request?: typeof fetch): Promise<ModelLibraryItem[]> {
  if (cachedItems) return cachedItems;
  if (catalogInFlight) return catalogInFlight;

  if (!request) {
    cachedItems = [...MIXAMO_CHARACTER_CATALOG];
    return cachedItems;
  }

  catalogInFlight = request(MIXAMO_CHARACTER_CATALOG_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`本地 Mixamo 人物目录未就绪（HTTP ${response.status}）`);

      const items = parseLocalMixamoCharacterCatalog(await response.json());
      if (!items.length) throw new Error("本地 Mixamo 人物目录中没有可用角色");

      cachedItems = items;
      return items;
    })
    .finally(() => {
      catalogInFlight = null;
    });

  return catalogInFlight;
}

/** Test hook; production keeps one validated catalog instance for the session. */
export function resetLocalMixamoCharacterCatalogCache() {
  cachedItems = null;
  catalogInFlight = null;
}
