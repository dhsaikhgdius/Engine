import { z } from "zod";
import { directorProjectSchema } from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectSchema";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectRevision";
import { directorDccPortableExchangeFormatSchema, directorDccProviderIdSchema } from "./directorDccProviderContract";

/** Contract identifier for the DCC exchange package manifest. */
export const DIRECTOR_DCC_EXCHANGE_PACKAGE_CONTRACT = "director-dcc-exchange-package-v1" as const;

/** Contract identifier for the DCC exchange package result. */
export const DIRECTOR_DCC_EXCHANGE_RESULT_CONTRACT = "director-dcc-exchange-result-v1" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const exchangeMimeTypeByFormat = {
  glb: "model/gltf-binary",
  usda: "model/vnd.usda",
} as const satisfies Record<z.infer<typeof directorDccPortableExchangeFormatSchema>, string>;

function duplicateEntries(values: readonly string[]) {
  const seen = new Set<string>();
  return values.flatMap((value, index) => {
    if (seen.has(value)) return [{ index, value }];
    seen.add(value);
    return [];
  });
}

const safeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    { message: "path must be a safe package-relative path" },
  );

/** A single exchange artifact (glb or usda) produced by the DCC export. */
export const directorDccExchangeArtifactSchema = z.strictObject({
  format: directorDccPortableExchangeFormatSchema,
  fileName: z.string().trim().min(1).max(240),
  path: z.string().trim().min(1).max(2_048),
  mimeType: z.enum(["model/gltf-binary", "model/vnd.usda"]),
  sha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
});

/** A single asset file bundled inside an exchange package. */
export const directorDccExchangeAssetSchema = z.strictObject({
  assetRefId: z.string().trim().min(1).max(240),
  fileName: z.string().trim().min(1).max(240),
  path: z.string().trim().min(1).max(2_048),
  relativePath: safeRelativePathSchema,
  sha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
});

/**
 * The manifest for a DCC exchange package, carrying the full project snapshot
 * plus references to all exported format artifacts and bundled assets.
 * Validates referential integrity across project entities, formats, and assets.
 */
export const directorDccExchangePackageManifestSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_DCC_EXCHANGE_PACKAGE_CONTRACT),
    packageId: z.string().uuid(),
    provider: directorDccProviderIdSchema,
    sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    createdAt: z.string().datetime(),
    coordinateSystem: z.strictObject({
      linearUnit: z.literal("meter"),
      metersPerUnit: z.literal(1),
      upAxis: z.literal("Y"),
      handedness: z.literal("right"),
      cameraForward: z.literal("-Z"),
    }),
    project: directorProjectSchema,
    formats: z.array(
      z.strictObject({
        format: directorDccPortableExchangeFormatSchema,
        relativePath: safeRelativePathSchema,
        sha256: sha256Schema,
        byteLength: z.number().int().nonnegative(),
      }),
    ),
    assets: z.array(
      z.strictObject({
        assetRefId: z.string().trim().min(1).max(240),
        relativePath: safeRelativePathSchema,
        sha256: sha256Schema,
        byteLength: z.number().int().nonnegative(),
      }),
    ),
    warnings: z.array(z.string()),
  })
  .superRefine((manifest, context) => {
    const { project } = manifest;
    const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
    const cameraIds = new Set(project.cameras.map((camera) => camera.id));

    for (const [collection, values] of [
      ["assets", project.assets.map((asset) => asset.id)],
      ["objects", project.objects.map((object) => object.id)],
      ["cameras", project.cameras.map((camera) => camera.id)],
    ] as const) {
      for (const duplicate of duplicateEntries(values)) {
        context.addIssue({
          code: "custom",
          path: ["project", collection, duplicate.index, "id"],
          message: `${collection} contains duplicate id "${duplicate.value}"`,
        });
      }
    }

    project.objects.forEach((object, index) => {
      if (!object.assetRefId) {
        if (object.kind === "character") {
          context.addIssue({
            code: "custom",
            path: ["project", "objects", index, "assetRefId"],
            message: `character object "${object.id}" must reference a character model asset`,
          });
        }
        return;
      }

      const asset = assetsById.get(object.assetRefId);
      if (!asset) {
        context.addIssue({
          code: "custom",
          path: ["project", "objects", index, "assetRefId"],
          message: `object assetRefId "${object.assetRefId}" does not exist`,
        });
        return;
      }
      if (object.kind === "character" && (asset.kind !== "character" || asset.sourceType !== "model")) {
        context.addIssue({
          code: "custom",
          path: ["project", "objects", index, "assetRefId"],
          message: `character assetRefId "${object.assetRefId}" must resolve to a character model`,
        });
      }
    });

    if (project.activeCameraId && !cameraIds.has(project.activeCameraId)) {
      context.addIssue({
        code: "custom",
        path: ["project", "activeCameraId"],
        message: `activeCameraId "${project.activeCameraId}" does not exist`,
      });
    }
    if (project.panoramaAssetId) {
      const panoramaAsset = assetsById.get(project.panoramaAssetId);
      if (!panoramaAsset) {
        context.addIssue({
          code: "custom",
          path: ["project", "panoramaAssetId"],
          message: `panoramaAssetId "${project.panoramaAssetId}" does not exist`,
        });
      } else if (panoramaAsset.kind !== "panorama" || panoramaAsset.sourceType !== "image") {
        context.addIssue({
          code: "custom",
          path: ["project", "panoramaAssetId"],
          message: `panoramaAssetId "${project.panoramaAssetId}" must resolve to a panorama image asset`,
        });
      }
    }

    for (const duplicate of duplicateEntries(manifest.formats.map((artifact) => artifact.format))) {
      context.addIssue({
        code: "custom",
        path: ["formats", duplicate.index, "format"],
        message: `formats contains duplicate format "${duplicate.value}"`,
      });
    }
    for (const duplicate of duplicateEntries(manifest.assets.map((asset) => asset.assetRefId))) {
      context.addIssue({
        code: "custom",
        path: ["assets", duplicate.index, "assetRefId"],
        message: `assets contains duplicate assetRefId "${duplicate.value}"`,
      });
    }

    const packagePaths = [
      ...manifest.formats.map((artifact, index) => ({
        section: "formats" as const,
        index,
        value: artifact.relativePath,
      })),
      ...manifest.assets.map((asset, index) => ({ section: "assets" as const, index, value: asset.relativePath })),
    ];
    const firstPathOwner = new Map<string, (typeof packagePaths)[number]>();
    packagePaths.forEach((entry) => {
      const previous = firstPathOwner.get(entry.value);
      if (previous) {
        context.addIssue({
          code: "custom",
          path: [entry.section, entry.index, "relativePath"],
          message: `package relativePath "${entry.value}" is already used by ${previous.section}[${previous.index}]`,
        });
      } else {
        firstPathOwner.set(entry.value, entry);
      }
    });

    manifest.assets.forEach((asset, index) => {
      if (!assetsById.has(asset.assetRefId)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "assetRefId"],
          message: `package assetRefId "${asset.assetRefId}" does not exist in project.assets`,
        });
      }
    });
  });

/**
 * The result of a DCC export job, listing all produced artifacts and assets
 * with their SHA-256 hashes for integrity verification.
 */
export const directorDccExchangePackageResultSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_DCC_EXCHANGE_RESULT_CONTRACT),
    jobId: z.string().uuid(),
    provider: directorDccProviderIdSchema,
    packagePath: z.string().trim().min(1).max(2_048),
    manifestPath: z.string().trim().min(1).max(2_048),
    manifestSha256: sha256Schema,
    packageDigest: sha256Schema,
    sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    formats: z.array(directorDccExchangeArtifactSchema),
    assets: z.array(directorDccExchangeAssetSchema),
    warnings: z.array(z.string()),
  })
  .superRefine((result, context) => {
    for (const duplicate of duplicateEntries(result.formats.map((artifact) => artifact.format))) {
      context.addIssue({
        code: "custom",
        path: ["formats", duplicate.index, "format"],
        message: `formats contains duplicate format "${duplicate.value}"`,
      });
    }
    for (const duplicate of duplicateEntries(result.formats.map((artifact) => artifact.path))) {
      context.addIssue({
        code: "custom",
        path: ["formats", duplicate.index, "path"],
        message: `formats contains duplicate path "${duplicate.value}"`,
      });
    }
    for (const duplicate of duplicateEntries(result.assets.map((asset) => asset.assetRefId))) {
      context.addIssue({
        code: "custom",
        path: ["assets", duplicate.index, "assetRefId"],
        message: `assets contains duplicate assetRefId "${duplicate.value}"`,
      });
    }
    for (const duplicate of duplicateEntries(result.assets.map((asset) => asset.relativePath))) {
      context.addIssue({
        code: "custom",
        path: ["assets", duplicate.index, "relativePath"],
        message: `assets contains duplicate relativePath "${duplicate.value}"`,
      });
    }

    const outputPaths = [
      ...result.formats.map((artifact, index) => ({ section: "formats" as const, index, value: artifact.path })),
      ...result.assets.map((asset, index) => ({ section: "assets" as const, index, value: asset.path })),
    ];
    const firstPathOwner = new Map<string, (typeof outputPaths)[number]>();
    outputPaths.forEach((entry) => {
      const previous = firstPathOwner.get(entry.value);
      if (previous) {
        context.addIssue({
          code: "custom",
          path: [entry.section, entry.index, "path"],
          message: `output path "${entry.value}" is already used by ${previous.section}[${previous.index}]`,
        });
      } else {
        firstPathOwner.set(entry.value, entry);
      }
    });

    result.formats.forEach((artifact, index) => {
      const expected = exchangeMimeTypeByFormat[artifact.format];
      if (artifact.mimeType !== expected) {
        context.addIssue({
          code: "custom",
          path: ["formats", index, "mimeType"],
          message: `${artifact.format} artifacts must use MIME type ${expected}`,
        });
      }
    });
  });

/** An exchange package manifest (v1). */
export type DirectorDccExchangePackageManifest = z.infer<typeof directorDccExchangePackageManifestSchema>;

/** The result of an exchange package export job (v1). */
export type DirectorDccExchangePackageResult = z.infer<typeof directorDccExchangePackageResultSchema>;
