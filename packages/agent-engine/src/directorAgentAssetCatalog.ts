/**
 * The Agent-facing asset catalog served by `director_workbench`
 * `op:"catalog"`.
 *
 * Merges the packaged asset libraries (Flick stage props, the model-library
 * v2 catalog, and Mixamo characters) into one queryable list where every
 * item carries ready-made authoring actions: an `upsert_asset` +
 * `add_object` pair whose ids are refined to match the catalog identity, so
 * an agent can instance any browsable asset without hand-assembling the
 * asset reference. Catalog JSON is validated at module load; identity
 * mismatches between an item and its authoring actions fail the import
 * rather than producing an asset that cannot be placed.
 *
 * Claim-based lookup ({@link findDirectorAgentCatalogAssetsByClaim}) is the
 * reverse direction: given an agent's free-text asset claim it returns the
 * catalog items that actually satisfy it, which the authoring executor uses
 * to verify `asset_id` claims.
 *
 * @module directorAgentAssetCatalog
 */

import { z } from "zod";
import flickStageCatalogJson from "../../../assets/library/flick-stage-props/catalog.json";
import modelLibraryCatalogV2Json from "../../../assets/library/model-library/catalog.v2.json";
import { normalizeAssetCatalogClaim } from "@director/protocol/primitives";
import {
  assetCatalogLibrarySchema,
  assetCatalogSpatialSchema,
  type AssetCatalogItem,
  type AssetCatalogLibrary,
  type AssetCatalogSpatial,
  type FlickMetadataOverlay,
} from "@director/protocol/asset-catalog";
import {
  directorAgentAssetCategorySchema,
  directorAgentAssetPreviewSchema,
  type DirectorAgentAssetCategory,
} from "@director/protocol/workbench-ui";
import { FLICK_PACKAGED_METADATA, getCatalogDefaultSizeM } from "@director/dcc-interchange";
import { getFlickStandardCategory } from "@director/dcc-interchange";
import {
  createMixamoCharacterAssetRef,
  findMixamoCharacterCatalogItemsByClaim,
  getMixamoCharacterCatalogItem,
  MIXAMO_CHARACTER_CATALOG,
} from "@director/dcc-interchange";
import type { DirectorAssetRef, DirectorObjectKind } from "@director/project-schema";
import { directorAssetKindSchema, directorAssetRefSchema } from "@director/project-schema";
import { strictAction } from "@director/protocol/strict-variant";

const catalogText = z.string().trim().min(1).max(240);
const flickCategory = z.string().regex(/^[A-Za-z0-9_-]+$/);
const flickModelFileName = z.string().regex(/^[A-Za-z0-9_.-]+\.glb$/i);

const localFlickStageCatalogSchema = z.strictObject({
  sourceUrl: z.string().url().startsWith("https://flick.art/assets/"),
  items: z
    .array(
      z
        .strictObject({
          category: flickCategory,
          fileName: flickModelFileName,
          sourceUrl: z.string().url(),
          thumbnailUrl: z.string().startsWith("/flick-stage-props/thumbnails/"),
        })
        .superRefine((item, context) => {
          const sourcePrefix = `https://cdn.flick.art/stage-props/${item.category}/`;
          if (item.sourceUrl !== `${sourcePrefix}${item.fileName}`) {
            context.addIssue({ code: "custom", message: "sourceUrl does not match category/fileName" });
          }
          const expectedThumbnail = `/flick-stage-props/thumbnails/${item.category}/${item.fileName.replace(/\.glb$/i, ".webp")}`;
          if (item.thumbnailUrl !== expectedThumbnail) {
            context.addIssue({ code: "custom", message: "thumbnailUrl does not match category/fileName" });
          }
        }),
    )
    .min(1),
});

const authoringActionSchema = z.union([
  strictAction("upsert_asset", { asset: directorAssetRefSchema }),
  strictAction("add_object", {
    id: catalogText,
    name: catalogText,
    kind: directorAssetKindSchema,
    asset_id: catalogText,
    character_source: z.literal("asset").optional(),
    placement_mode: z.literal("grounded"),
  }),
]);

/** A single asset in the Agent-facing asset catalog, with authoring actions. */
export const directorAgentAssetCatalogItemSchema = z
  .strictObject({
    id: catalogText,
    name: catalogText,
    name_zh: catalogText.nullable().default(null),
    kind: directorAssetKindSchema,
    category: directorAgentAssetCategorySchema,
    source_category: catalogText,
    file_name: catalogText,
    aliases: z.array(catalogText).max(32),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
    /** Asset Catalog v2 spatial facts (metric bounds/height/ground offset). */
    spatial: assetCatalogSpatialSchema.nullable().default(null),
    model_url: z.string().min(1),
    thumbnail_url: z.string().min(1).nullable(),
    preview: directorAgentAssetPreviewSchema,
    asset: directorAssetRefSchema,
    authoring: z.strictObject({
      object_id: catalogText,
      actions: z.tuple([authoringActionSchema, authoringActionSchema]),
    }),
    source: z.strictObject({
      provider: catalogText,
      provenance: z.enum(["local-user-supplied", "local-mirror", "bundled", "generated"]),
      source_url: z.string().min(1).nullable(),
    }),
  })
  .superRefine((item, context) => {
    if (item.asset.id !== item.id || item.asset.kind !== item.kind || item.asset.url !== item.model_url) {
      context.addIssue({ code: "custom", message: "catalog identity differs from authorable asset" });
    }
    const [upsert, add] = item.authoring.actions;
    if (
      upsert.action !== "upsert_asset" ||
      add.action !== "add_object" ||
      upsert.asset.id !== item.id ||
      add.asset_id !== item.id ||
      add.id !== item.authoring.object_id ||
      (item.kind === "character" && add.character_source !== "asset") ||
      (item.kind !== "character" && add.character_source !== undefined)
    ) {
      context.addIssue({ code: "custom", message: "authoring actions do not target this catalog asset" });
    }
  });

/** A single item in the Agent-facing asset catalog. */
export type DirectorAgentAssetCatalogItem = z.infer<typeof directorAgentAssetCatalogItemSchema>;
export type { DirectorAgentAssetCategory } from "@director/protocol/workbench-ui";
export { directorAgentAssetCategorySchema, directorAgentAssetPreviewSchema } from "@director/protocol/workbench-ui";

function displayName(fileName: string) {
  return fileName
    .replace(/\.glb$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function recommendedObjectId(assetId: string) {
  return `catalog-instance-${assetId}`.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 200);
}

function localBoundsFromCatalogSpatial(spatial: AssetCatalogSpatial | null) {
  const bounds = spatial?.bounds_m;
  if (!bounds || bounds.every((value) => value === 0)) return undefined;
  const [width, height, depth] = bounds;
  return {
    min: [-width / 2, 0, -depth / 2] as [number, number, number],
    max: [width / 2, height, depth / 2] as [number, number, number],
  };
}

function authoringFor(asset: DirectorAssetRef, name: string, kind: DirectorObjectKind) {
  const objectId = recommendedObjectId(asset.id);
  return {
    object_id: objectId,
    actions: [
      { action: "upsert_asset" as const, asset },
      {
        action: "add_object" as const,
        id: objectId,
        name,
        kind,
        asset_id: asset.id,
        ...(kind === "character" ? { character_source: "asset" as const } : {}),
        placement_mode: "grounded" as const,
      },
    ] as const,
  };
}

const parsedFlickCatalog = localFlickStageCatalogSchema.parse(flickStageCatalogJson);

const packagedCharacters = MIXAMO_CHARACTER_CATALOG.map((item) => {
  if (!item.characterMetadata || !item.thumbnailUrl) {
    throw new Error(`Validated Mixamo catalog item ${item.id} is missing character metadata or thumbnail`);
  }
  const asset = directorAssetRefSchema.parse(createMixamoCharacterAssetRef(item));
  return directorAgentAssetCatalogItemSchema.parse({
    id: item.id,
    name: item.name,
    name_zh: null,
    kind: "character",
    category: "characters",
    source_category: "mixamo",
    file_name: item.fileName,
    aliases: [...(item.aliases ?? [])],
    tags: ["character", "mixamo"],
    spatial: {
      bounds_m: null,
      footprint_m: null,
      height_m: item.characterMetadata.heightM,
      ground_offset_y: item.characterMetadata.groundOffsetY,
      front_axis: null,
    },
    model_url: item.url,
    thumbnail_url: item.thumbnailUrl,
    preview: {
      status: "ready",
      kind: "image",
      url: item.thumbnailUrl,
      thumbnail_url: item.thumbnailUrl,
      source_model_url: item.url,
    },
    asset,
    authoring: authoringFor(asset, item.name, "character"),
    source: {
      provider: "Adobe Mixamo",
      provenance: "local-user-supplied",
      source_url: null,
    },
  });
});

const packagedProps = parsedFlickCatalog.items.map((item) => {
  const id = `flick:${item.category}:${item.fileName}`;
  const name = displayName(item.fileName);
  const modelUrl = `/flick-stage-props/${item.category}/${item.fileName}`;
  const catalogSizeM = getCatalogDefaultSizeM({
    kind: "prop",
    sourceCategory: item.category,
    standardCategory: getFlickStandardCategory(item.category),
    fileName: item.fileName,
  });
  const asset = directorAssetRefSchema.parse({
    id,
    kind: "prop",
    sourceType: "model",
    fileName: item.fileName,
    name,
    url: modelUrl,
    assetSource: "library",
    ...(catalogSizeM === undefined ? {} : { realWorldSizeM: catalogSizeM, sizeSource: "catalog" }),
  });
  return directorAgentAssetCatalogItemSchema.parse({
    id,
    name,
    // The generated flick i18n overlay fills name_zh/aliases/tags at wiring
    // time through mergeFlickMetadataOverlay below.
    name_zh: null,
    kind: "prop",
    category: getFlickStandardCategory(item.category),
    source_category: item.category,
    file_name: item.fileName,
    aliases: [],
    tags: [],
    spatial: null,
    model_url: modelUrl,
    thumbnail_url: item.thumbnailUrl,
    preview: {
      status: "ready",
      kind: "image",
      url: item.thumbnailUrl,
      thumbnail_url: item.thumbnailUrl,
      source_model_url: modelUrl,
    },
    asset,
    authoring: authoringFor(asset, name, "prop"),
    source: {
      provider: "Flick public Stage catalog",
      provenance: "local-mirror",
      source_url: item.sourceUrl,
    },
  });
});

function catalogFileNameFromUrl(url: string) {
  const encoded = url.slice(url.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function agentCategoryForV2Item(item: AssetCatalogItem): DirectorAgentAssetCategory {
  if (item.kind === "character") return "characters";
  const direct = directorAgentAssetCategorySchema.safeParse(item.category.toLocaleLowerCase());
  if (direct.success) return direct.data;
  const mapped = directorAgentAssetCategorySchema.safeParse(getFlickStandardCategory(item.category));
  return mapped.success ? mapped.data : "other";
}

/**
 * Maps one Asset Catalog v2 item onto the Agent catalog shape. Only model
 * kinds (character/prop) are authorable today; motion/texture/panorama/audio
 * items return null and stay out of the Agent asset catalog.
 */
export function convertAssetCatalogV2Item(
  libraryDir: string,
  item: AssetCatalogItem,
): DirectorAgentAssetCatalogItem | null {
  if (item.kind !== "character" && item.kind !== "prop") return null;
  // assetCatalogItemSchema guarantees a file matching primary_format exists.
  const modelFile = item.files.find((file) => file.format === item.primary_format)!;
  const modelUrl = modelFile.url;
  const fileName = catalogFileNameFromUrl(modelUrl);
  const thumbnailUrl = item.preview.thumbnail_url;
  // Authored metric bounds are the most reliable size source; fall back to
  // category defaults so every catalog prop lands at a plausible real scale.
  const authoredSizeM = item.spatial?.bounds_m ? Math.max(...item.spatial.bounds_m) : (item.spatial?.height_m ?? null);
  const catalogSizeM =
    item.kind === "prop"
      ? authoredSizeM && authoredSizeM > 0
        ? authoredSizeM
        : getCatalogDefaultSizeM({
            kind: item.kind,
            sourceCategory: item.category,
            standardCategory: agentCategoryForV2Item(item),
            fileName,
          })
      : undefined;
  const localBoundsM = localBoundsFromCatalogSpatial(item.spatial);
  const asset = directorAssetRefSchema.parse({
    id: item.id,
    kind: item.kind,
    sourceType: "model",
    fileName,
    name: item.name,
    url: modelUrl,
    assetSource: "library",
    ...(localBoundsM === undefined ? {} : { localBoundsM }),
    ...(catalogSizeM === undefined ? {} : { realWorldSizeM: catalogSizeM, sizeSource: "catalog" }),
  });
  return directorAgentAssetCatalogItemSchema.parse({
    id: item.id,
    name: item.name,
    name_zh: item.name_zh,
    kind: item.kind,
    category: agentCategoryForV2Item(item),
    source_category: `${libraryDir}/${item.category}`,
    file_name: fileName,
    aliases: [...item.aliases].slice(0, 32),
    tags: [...item.tags],
    spatial: item.spatial,
    model_url: modelUrl,
    thumbnail_url: thumbnailUrl,
    preview: thumbnailUrl
      ? { status: "ready", kind: "image", url: thumbnailUrl, thumbnail_url: thumbnailUrl, source_model_url: modelUrl }
      : { status: "runtime", kind: "model", url: modelUrl, thumbnail_url: null, source_model_url: modelUrl },
    asset,
    authoring: authoringFor(asset, item.name, item.kind),
    source: {
      provider: item.source.provider,
      provenance: item.source.provenance,
      source_url: item.source.source_url,
    },
  });
}

export interface DirectorAgentV2CatalogRegistration {
  /** Library directory name under assets/library, e.g. "model-library". */
  library: string;
  catalog: AssetCatalogLibrary;
}

/**
 * Asset Catalog v2 registration point. The integrator imports each generated
 * assets/library/<library>/catalog.v2.json, validates it with
 * assetCatalogLibrarySchema.parse, and lists it here, e.g.
 * `{ library: "model-library", catalog: assetCatalogLibrarySchema.parse(modelLibraryCatalogV2Json) }`.
 * Aggregation, deterministic sorting, and the id/claim indexes below pick the
 * items up without further code.
 */
export const DIRECTOR_AGENT_V2_LIBRARIES: readonly DirectorAgentV2CatalogRegistration[] = [
  // director-characters/catalog.v2.json stays unregistered for now: the
  // character asset binding invariant (getDirectorCharacterAssetBindingIssues)
  // only accepts packaged Mixamo characters, so v2 characters would author
  // objects that immediately fail that audit.
  { library: "model-library", catalog: assetCatalogLibrarySchema.parse(modelLibraryCatalogV2Json) },
];

/**
 * Flick localization and metric metadata registration point. The integrator imports the
 * generated assets/library/flick-stage-props/metadata.i18n.json, validates it
 * with flickMetadataOverlaySchema.parse, and assigns it here.
 */
export const DIRECTOR_AGENT_FLICK_METADATA_OVERLAY: FlickMetadataOverlay | null = FLICK_PACKAGED_METADATA;

/**
 * Pure merge of the generated Flick metadata overlay into built Agent catalog
 * items. Overlay entries are keyed "<source_category>/<file_name>"; items
 * without a matching entry are returned untouched.
 */
export function mergeFlickMetadataOverlay(
  items: readonly DirectorAgentAssetCatalogItem[],
  overlay: FlickMetadataOverlay,
): DirectorAgentAssetCatalogItem[] {
  return items.map((item) => {
    const entry = overlay.items[`${item.source_category}/${item.file_name}`];
    if (!entry) return item;
    const catalogSizeM = entry.spatial.bounds_m
      ? Math.max(...entry.spatial.bounds_m)
      : (entry.spatial.height_m ?? item.asset.realWorldSizeM);
    const localBoundsM = localBoundsFromCatalogSpatial(entry.spatial);
    const asset =
      catalogSizeM === undefined && localBoundsM === undefined
        ? item.asset
        : directorAssetRefSchema.parse({
            ...item.asset,
            ...(catalogSizeM === undefined ? {} : { realWorldSizeM: catalogSizeM, sizeSource: "catalog" as const }),
            ...(localBoundsM === undefined ? {} : { localBoundsM }),
          });
    return directorAgentAssetCatalogItemSchema.parse({
      ...item,
      name_zh: entry.name_zh,
      aliases: [...new Set([...item.aliases, ...entry.aliases])].slice(0, 32),
      tags: [...new Set([...item.tags, ...entry.tags])].slice(0, 32),
      spatial: entry.spatial,
      asset,
      authoring: authoringFor(asset, item.name, item.kind),
    });
  });
}

const localizedPackagedProps = DIRECTOR_AGENT_FLICK_METADATA_OVERLAY
  ? mergeFlickMetadataOverlay(packagedProps, DIRECTOR_AGENT_FLICK_METADATA_OVERLAY)
  : packagedProps;

const packagedV2Items = DIRECTOR_AGENT_V2_LIBRARIES.flatMap(({ library, catalog }) =>
  catalog.items.flatMap((item) => {
    const converted = convertAssetCatalogV2Item(library, item);
    return converted ? [converted] : [];
  }),
);

/**
 * Agent-facing SSOT for every packaged 3D model. It is deterministic and is
 * built from the same generated manifests that back the local model library.
 */
export const DIRECTOR_AGENT_ASSET_CATALOG: readonly DirectorAgentAssetCatalogItem[] = Object.freeze(
  [...packagedCharacters, ...localizedPackagedProps, ...packagedV2Items].sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  ),
);

{
  const seen = new Set<string>();
  for (const item of DIRECTOR_AGENT_ASSET_CATALOG) {
    if (seen.has(item.id)) {
      throw new Error(`Director agent asset catalog item id "${item.id}" is duplicated across registered libraries`);
    }
    seen.add(item.id);
  }
}

const assetById = new Map(DIRECTOR_AGENT_ASSET_CATALOG.map((item) => [item.id, item]));

const catalogAssetsByClaim = new Map<string, DirectorAgentAssetCatalogItem[]>();
DIRECTOR_AGENT_ASSET_CATALOG.forEach((item) => {
  const aliases = new Set([
    item.name,
    item.file_name,
    item.id,
    ...(item.name_zh ? [item.name_zh] : []),
    ...item.aliases,
  ]);
  aliases.forEach((alias) => {
    const normalized = normalizeAssetCatalogClaim(alias);
    if (!normalized) return;
    const matches = catalogAssetsByClaim.get(normalized) ?? [];
    matches.push(item);
    catalogAssetsByClaim.set(normalized, matches);
  });
});

/**
 * Looks up a single asset by its catalog id.
 *
 * Also checks the Mixamo character catalog for indirect matches.
 *
 * @param assetId - The catalog asset id to look up.
 * @returns The catalog item or null if not found.
 */
export function getDirectorAgentCatalogAsset(assetId: string) {
  const character = getMixamoCharacterCatalogItem(assetId);
  if (character) return assetById.get(character.id) ?? null;
  return assetById.get(assetId) ?? null;
}

/**
 * Searches the Agent asset catalog by claim (name, alias, or id).
 *
 * Matching is exact and punctuation-insensitive; never guesses by substring.
 * Also checks the Mixamo character catalog for indirect matches.
 *
 * @param nameOrId - The claim string to search for.
 * @returns Matching catalog items (may be empty).
 */
export function findDirectorAgentCatalogAssetsByClaim(nameOrId: string) {
  const normalized = normalizeAssetCatalogClaim(nameOrId);
  if (!normalized) return [];
  const direct = catalogAssetsByClaim.get(normalized) ?? [];
  const characterIds = new Set(findMixamoCharacterCatalogItemsByClaim(nameOrId).map((item) => item.id));
  return [
    ...new Map(
      [...direct, ...[...characterIds].flatMap((id) => (assetById.get(id) ? [assetById.get(id)!] : []))].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  ];
}
