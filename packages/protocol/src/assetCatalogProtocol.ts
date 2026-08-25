import { z } from "zod";

/**
 * Asset Catalog v2: one on-disk manifest shape for every packaged asset
 * library under assets/library/<library>/catalog.v2.json.
 *
 * Design notes:
 * - Field names are snake_case so catalog files can flow into Agent-facing
 *   responses without a rename pass.
 * - URLs are runtime paths served from the Vite publicDir (assets/library),
 *   e.g. "/flick-stage-props/animals/cat.glb".
 * - Optional facts are explicit nulls rather than absent keys so ingest
 *   tooling emits a stable, diffable document.
 */

/** Current schema version for the asset catalog library format. */
export const ASSET_CATALOG_SCHEMA_VERSION = 2;

const catalogString = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Validates an asset identifier: alphanumeric, up to 200 chars, with optional dots, underscores, colons, and dashes. */
export const assetCatalogIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/, "identifier uses letters, digits, dot, underscore, colon, dash");

/** The classification of an asset: character, prop, motion, texture, panorama, or audio. */
export const assetCatalogKindSchema = z.enum(["character", "prop", "motion", "texture", "panorama", "audio"]);

/** Supported file formats that may appear in a catalog entry. */
export const assetCatalogFormatSchema = z.enum([
  "glb",
  "gltf",
  "fbx",
  "obj",
  "vrm",
  "usda",
  "usdz",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "svg",
  "hdr",
  "exr",
  "mp3",
  "wav",
]);

/** A single file entry describing a variant of an asset, with optional size and content hash. */
export const assetCatalogFileSchema = z.strictObject({
  format: assetCatalogFormatSchema,
  url: catalogString(1024),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

const nonNegativeMetres = z.number().nonnegative().finite();

/** Spatial metadata for a 3D asset: bounding box, footprint, height, and ground orientation. */
export const assetCatalogSpatialSchema = z.strictObject({
  /** Axis-aligned bounding box size in metres: [x, y, z]. */
  bounds_m: z.tuple([nonNegativeMetres, nonNegativeMetres, nonNegativeMetres]).nullable(),
  /** Ground footprint in metres: [x, z]. */
  footprint_m: z.tuple([nonNegativeMetres, nonNegativeMetres]).nullable(),
  height_m: nonNegativeMetres.nullable(),
  /** Vertical offset from the authored origin to the ground contact. */
  ground_offset_y: z.number().finite().nullable(),
  /** Facing direction of the model's authored "front" in asset space. */
  front_axis: z.enum(["+x", "-x", "+z", "-z"]).nullable(),
});

/** Rigging metadata describing the skeleton of a character asset. */
export const assetCatalogRigSchema = z.strictObject({
  type: catalogString(64),
  bone_prefix: z.string().max(64).nullable(),
  bone_count: z.number().int().positive().nullable(),
});

/** Motion metadata for an animation asset: duration, frame count, and playback defaults. */
export const assetCatalogMotionSchema = z.strictObject({
  duration_s: z.number().positive().finite(),
  frame_count: z.number().int().positive().nullable(),
  source_fps: z.number().positive().finite().nullable(),
  default_loop: z.enum(["once", "repeat", "ping-pong"]),
  recommended_root_motion: z.enum(["in-place", "authored"]),
});

/** Provenance and licensing metadata for a catalog asset. */
export const assetCatalogSourceSchema = z.strictObject({
  provider: catalogString(200),
  provenance: z.enum(["bundled", "local-mirror", "local-user-supplied", "generated"]),
  source_url: catalogString(1024).nullable(),
  license: catalogString(200).nullable(),
  license_url: catalogString(1024).nullable(),
});

/** Preview thumbnail metadata for a catalog asset. */
export const assetCatalogPreviewSchema = z.strictObject({
  kind: z.enum(["image", "model"]),
  thumbnail_url: catalogString(1024).nullable(),
});

/**
 * A single asset entry in a catalog library.
 *
 * Includes identification, files, spatial/rig/motion metadata, provenance,
 * and a usage hint that tells an Agent when this asset is the right choice.
 */
export const assetCatalogItemSchema = z
  .strictObject({
    id: assetCatalogIdentifierSchema,
    name: catalogString(240),
    name_zh: catalogString(240).nullable(),
    aliases: z.array(catalogString(240)).max(64),
    category: catalogString(64),
    tags: z.array(catalogString(64)).max(32),
    kind: assetCatalogKindSchema,
    files: z.array(assetCatalogFileSchema).min(1).max(8),
    /** Format of the file the runtime should load by default. */
    primary_format: assetCatalogFormatSchema,
    preview: assetCatalogPreviewSchema,
    spatial: assetCatalogSpatialSchema.nullable(),
    rig: assetCatalogRigSchema.nullable(),
    motion: assetCatalogMotionSchema.nullable(),
    source: assetCatalogSourceSchema,
    /** One sentence telling an Agent when this asset is the right choice. */
    usage_hint: z.string().trim().max(500).nullable(),
  })
  .superRefine((item, context) => {
    // primary_format must have a matching file entry, otherwise the runtime has nothing to load.
    if (!item.files.some((file) => file.format === item.primary_format)) {
      context.addIssue({ code: "custom", message: "primary_format has no matching entry in files" });
    }
    // motion-kind items must carry motion metadata so consumers can reason about playback.
    if (item.kind === "motion" && !item.motion) {
      context.addIssue({ code: "custom", message: "motion items must describe motion metadata" });
    }
  });

/**
 * The top-level catalog library document shape.
 *
 * Groups assets under a named library directory with a schema version and
 * optional generator stamp for reproducibility.
 */
export const assetCatalogLibrarySchema = z
  .strictObject({
    schema_version: z.literal(ASSET_CATALOG_SCHEMA_VERSION),
    /** Library directory name under assets/library, e.g. "model-library". */
    library: catalogString(128),
    generator: catalogString(200).nullable(),
    items: z.array(assetCatalogItemSchema),
  })
  .superRefine((catalog, context) => {
    // Duplicate item ids would make lookups ambiguous; the catalog must be unambiguous.
    const seen = new Set<string>();
    for (const item of catalog.items) {
      if (seen.has(item.id)) {
        context.addIssue({ code: "custom", message: `duplicate catalog item id: ${item.id}` });
      }
      seen.add(item.id);
    }
  });

/** A file format supported in a catalog entry. */
export type AssetCatalogFormat = z.infer<typeof assetCatalogFormatSchema>;
/** The classification of a catalog asset. */
export type AssetCatalogKind = z.infer<typeof assetCatalogKindSchema>;
/** A single file variant of a catalog asset. */
export type AssetCatalogFile = z.infer<typeof assetCatalogFileSchema>;
/** Spatial metadata (bounds, footprint, orientation) for a 3D asset. */
export type AssetCatalogSpatial = z.infer<typeof assetCatalogSpatialSchema>;
/** A single asset entry in a catalog library. */
export type AssetCatalogItem = z.infer<typeof assetCatalogItemSchema>;
/** The top-level catalog library document. */
export type AssetCatalogLibrary = z.infer<typeof assetCatalogLibrarySchema>;

/**
 * Flick stage-prop localization and metric metadata overlay stored at
 * assets/library/flick-stage-props/metadata.i18n.json. Keys are
 * "<category>/<fileName>" from the library's catalog.json.
 */
export const flickMetadataOverlayEntrySchema = z.strictObject({
  name_zh: catalogString(240),
  aliases: z.array(catalogString(240)).max(16),
  tags: z.array(catalogString(64)).min(1).max(12),
  spatial: assetCatalogSpatialSchema,
});

/** Top-level structure of the Flick stage-prop metadata overlay. */
export const flickMetadataOverlaySchema = z.strictObject({
  schema_version: z.literal(1),
  generator: catalogString(200),
  items: z.record(z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.glb$/i), flickMetadataOverlayEntrySchema),
});

/** The complete Flick metadata overlay document. */
export type FlickMetadataOverlay = z.infer<typeof flickMetadataOverlaySchema>;
/** A single entry in the Flick metadata overlay, keyed by category/fileName. */
export type FlickMetadataOverlayEntry = z.infer<typeof flickMetadataOverlayEntrySchema>;
