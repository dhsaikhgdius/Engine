/**
 * Shared parser for character catalog JSON (generated manifests under
 * assets/library) into validated ModelLibraryItem entries.
 *
 * Catalog files are treated as untrusted input even though they ship with the
 * repo: entries are dropped (never "fixed") when required metadata is missing
 * or malformed, and every asset URL must resolve inside the configured asset
 * root — the URL checks below are the defense against a manifest smuggling
 * path traversal or external fetches into the workbench.
 */
import type { MixamoCharacterMetadata, ModelLibraryItem } from "./modelLibraryCatalog";
import { isRecord } from "@director/protocol/primitives";

/** A raw character catalog entry before parsing and validation. All fields are optional unknowns. */
export type CharacterCatalogEntry = {
  id?: unknown;
  name?: unknown;
  fileName?: unknown;
  modelUrl?: unknown;
  url?: unknown;
  thumbnailUrl?: unknown;
  heightM?: unknown;
  groundOffsetY?: unknown;
  visualCenter?: unknown;
  labelAnchorY?: unknown;
  rig?: unknown;
};

interface CharacterCatalogParserOptions {
  /** URL prefix every accepted asset must live under (e.g. "/assets/library/..."). */
  assetRoot: string;
  modelExtension: RegExp;
  thumbnailExtension: RegExp;
  /** Permit ":" in paths for catalogs whose file names legitimately contain it; off by default because ":" also introduces URL schemes. */
  allowColonInPaths?: boolean;
  /** Require thumbnails to be absolute (already under assetRoot) instead of resolving relative paths. */
  thumbnailRequiresAbsolute?: boolean;
  /** Derive the stable item id; returning null rejects the entry. */
  resolveId: (entry: CharacterCatalogEntry, fileName: string) => string | null;
  /** Optional extra search aliases surfaced to the library UI. */
  aliases?: (id: string, name: string, fileName: string) => string[];
  /**
   * Duplicate resolution: "url-last" lets later manifest entries override
   * earlier ones for the same model URL (regeneration appends fixes), while
   * "id-url-first" keeps the first claim on an id/url and ignores the rest
   * (merged catalogs must not clobber each other).
   */
  deduplicateBy: "url-last" | "id-url-first";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// -0 and 0 compare equal but serialize differently through some JSON paths;
// normalizing keeps catalog output byte-stable across regenerations.
function normalizeFiniteNumber(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

// Only Mixamo-type rigs with a plausible bone budget are accepted; the
// 512-name cap bounds memory for a hostile manifest. Returning null rejects
// the whole entry — a character without a valid rig cannot be animated.
function parseRig(value: unknown): MixamoCharacterMetadata["rig"] | null {
  if (!isRecord(value) || value.type !== "mixamo") return null;
  if (!Number.isInteger(value.boneCount) || (value.boneCount as number) < 1) return null;
  if (value.bonePrefix !== undefined && typeof value.bonePrefix !== "string") return null;
  if (
    value.boneNames !== undefined &&
    (!Array.isArray(value.boneNames) ||
      value.boneNames.length > 512 ||
      !value.boneNames.every((name) => typeof name === "string" && name.length > 0))
  )
    return null;
  return {
    type: "mixamo",
    boneCount: value.boneCount as number,
    ...(typeof value.bonePrefix === "string" && value.bonePrefix.trim() ? { bonePrefix: value.bonePrefix.trim() } : {}),
    ...(Array.isArray(value.boneNames) ? { boneNames: [...value.boneNames] as string[] } : {}),
  };
}

function parseMetadata(entry: CharacterCatalogEntry): MixamoCharacterMetadata | null {
  const center = entry.visualCenter;
  const visualCenter =
    Array.isArray(center) && center.length === 3 && center.every(isFiniteNumber)
      ? (center.map(normalizeFiniteNumber) as [number, number, number])
      : null;
  const rig = parseRig(entry.rig);
  if (
    !isFiniteNumber(entry.heightM) ||
    entry.heightM <= 0 ||
    !isFiniteNumber(entry.groundOffsetY) ||
    !visualCenter ||
    !isFiniteNumber(entry.labelAnchorY) ||
    !rig
  )
    return null;
  return {
    heightM: normalizeFiniteNumber(entry.heightM),
    groundOffsetY: normalizeFiniteNumber(entry.groundOffsetY),
    visualCenter,
    labelAnchorY: normalizeFiniteNumber(entry.labelAnchorY),
    rig,
  };
}

/**
 * Validate and resolve one catalog asset URL. Rejects anything that could
 * escape the asset root or smuggle a different origin: backslashes, query
 * strings, fragments, protocol-relative "//", URL schemes (":" unless
 * explicitly allowed), and — after percent-decoding — "." or ".." path
 * segments. Extension is checked against the resolved URL so a model URL
 * cannot masquerade as a thumbnail.
 */
function localAssetUrl(
  value: unknown,
  extension: RegExp,
  options: CharacterCatalogParserOptions,
  requiresAbsolute = false,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.includes("\\") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes("//") ||
    (!options.allowColonInPaths && trimmed.includes(":")) ||
    (requiresAbsolute && !trimmed.startsWith(options.assetRoot))
  )
    return null;
  const url = trimmed.startsWith("/") ? trimmed : `${options.assetRoot}${trimmed.replace(/^\.\//, "")}`;
  if (!url.startsWith(options.assetRoot) || url.startsWith("//") || !extension.test(url)) return null;
  try {
    if (
      decodeURIComponent(url)
        .split("/")
        .some((segment) => segment === ".." || segment === ".")
    )
      return null;
  } catch {
    return null;
  }
  return url;
}

function fileNameFromUrl(url: string) {
  const encodedName = url.slice(url.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

// All-or-nothing per entry: a character item without a resolvable model,
// thumbnail, AND full metric metadata is dropped, because a partially
// described character would break placement (height/ground offset) or the
// library UI (thumbnail) downstream.
function parseItem(entry: CharacterCatalogEntry, options: CharacterCatalogParserOptions): ModelLibraryItem | null {
  const modelUrl = localAssetUrl(entry.modelUrl ?? entry.url, options.modelExtension, options);
  const thumbnailUrl = localAssetUrl(
    entry.thumbnailUrl,
    options.thumbnailExtension,
    options,
    options.thumbnailRequiresAbsolute,
  );
  const characterMetadata = parseMetadata(entry);
  if (!modelUrl || !thumbnailUrl || !characterMetadata) return null;
  const fileName =
    typeof entry.fileName === "string" && entry.fileName.trim() ? entry.fileName.trim() : fileNameFromUrl(modelUrl);
  if (fileName.includes("/") || fileName.includes("\\") || !options.modelExtension.test(fileName)) return null;
  const name =
    typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : fileName.replace(options.modelExtension, "").replace(/[_-]+/g, " ").trim();
  if (!name) return null;
  const id = options.resolveId(entry, fileName);
  if (!id) return null;
  return {
    ...(options.aliases ? { aliases: options.aliases(id, name, fileName) } : {}),
    assetSource: "library",
    catalogCategory: "characters",
    categoryId: "flick",
    characterMetadata,
    fileName,
    flickCategory: "characters",
    id,
    kind: "character",
    name,
    thumbnailKind: "image",
    thumbnailUrl,
    url: modelUrl,
  };
}

/**
 * Parse a character catalog payload into validated model library items.
 * Each entry is validated for required fields (model URL, thumbnail, metadata),
 * and duplicates are resolved according to the deduplication strategy.
 *
 * @param payload - The raw catalog payload with an `items` array.
 * @param options - Parsing options including asset root, extensions, and deduplication.
 * @returns A sorted array of validated model library items.
 */
export function parseCharacterCatalog(payload: unknown, options: CharacterCatalogParserOptions): ModelLibraryItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  const byUrl = new Map<string, ModelLibraryItem>();
  const byId = new Map<string, ModelLibraryItem>();
  const idByUrl = new Map<string, string>();
  for (const value of payload.items) {
    if (!isRecord(value)) continue;
    const item = parseItem(value, options);
    if (!item) continue;
    if (options.deduplicateBy === "url-last") {
      byUrl.set(item.url, item);
      continue;
    }
    if (byId.has(item.id) || idByUrl.has(item.url)) continue;
    byId.set(item.id, item);
    idByUrl.set(item.url, item.id);
  }
  const items = options.deduplicateBy === "url-last" ? byUrl.values() : byId.values();
  return Array.from(items).sort((left, right) => left.name.localeCompare(right.name));
}
