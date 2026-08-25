import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectRevision";
import {
  directorAnimationEntityTypeSchema,
  directorTransformSchema,
} from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectSchema";
import { strictKind, strictOperation } from "@director/protocol/strictProtocolVariant";
import { directorDccTransformSchema } from "./directorDccSharedContract";
import { directorDccConnectorProviderIdSchema } from "./directorDccEngineSpace";

/** Contract identifier for the DCC return manifest. */
export const DIRECTOR_DCC_RETURN_CONTRACT = "director-dcc-return-v1" as const;

/** Contract identifier for the DCC import plan. */
export const DIRECTOR_DCC_IMPORT_PLAN_CONTRACT = "director-dcc-import-plan-v1" as const;

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 hex");
const safeRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value), {
    message: "path must be relative",
  })
  .refine((value) => !value.includes("\\"), { message: "path must use forward slashes" })
  .refine((value) => value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), {
    message: "path cannot contain empty, dot, or parent segments",
  });

/**
 * A single change in the DCC return package.
 * Supports mesh replacement (with optional transform and asset label) and
 * transform updates for objects and cameras.
 */
export const directorDccReturnChangeSchema = z.discriminatedUnion("kind", [
  strictKind("mesh_replacement", {
    directorId: nonEmpty.max(200),
    entityType: z.literal("object"),
    meshFile: safeRelativePath,
    transform: directorDccTransformSchema.optional(),
    assetLabel: z.string().trim().min(1).max(240).optional(),
  }),
  strictKind("transform_update", {
    directorId: nonEmpty.max(200),
    entityType: directorAnimationEntityTypeSchema,
    transform: directorDccTransformSchema,
  }),
]);

/**
 * Coordinate stanza for Blender-authored return packages: transforms are in
 * Blender's Z-up space and Director converts them on import.
 */
export const directorDccBlenderReturnCoordinateSystemSchema = z.strictObject({
  source: z.literal("right-handed-z-up-negative-z-camera-forward"),
  destination: z.literal("right-handed-y-up-negative-z-forward"),
  unit: z.literal("meter"),
  linearMap: z.literal("(x,y,z)->(x,z,-y)"),
});

/**
 * Coordinate stanza for engine-authored return packages: the Director-authored
 * connector already converted transforms to canonical Director space at the
 * provider boundary, so the wire transforms need no basis change on import.
 */
export const directorDccCanonicalReturnCoordinateSystemSchema = z.strictObject({
  source: z.literal("right-handed-y-up-negative-z-forward"),
  destination: z.literal("right-handed-y-up-negative-z-forward"),
  unit: z.literal("meter"),
  linearMap: z.literal("identity"),
});

/**
 * The manifest for a DCC return package, listing all changes a DCC tool
 * sends back to Director. Duplicate changes for the same entity are rejected.
 *
 * Blender packages (the historical default) declare `blenderVersion` and the
 * Blender Z-up coordinate stanza. Engine packages declare `provider`,
 * `hostVersion`, and the canonical Director-space stanza, because engine
 * connectors convert at the provider boundary.
 */
export const directorDccReturnManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    contract: z.literal(DIRECTOR_DCC_RETURN_CONTRACT),
    packageId: nonEmpty.max(240),
    sourcePackageId: nonEmpty.max(320),
    sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    exportedAt: z.string().datetime({ offset: true }),
    /** Producing connector; omitted on historical Blender packages. */
    provider: directorDccConnectorProviderIdSchema.optional(),
    blenderVersion: nonEmpty.max(200).optional(),
    /** Host application version for engine-authored packages. */
    hostVersion: nonEmpty.max(200).optional(),
    /** Director connector version for engine-authored packages. */
    connectorVersion: nonEmpty.max(60).optional(),
    coordinateSystem: z.union([
      directorDccBlenderReturnCoordinateSystemSchema,
      directorDccCanonicalReturnCoordinateSystemSchema,
    ]),
    changes: z.array(directorDccReturnChangeSchema).max(20_000),
    warnings: z.array(z.string().max(2_000)).max(20_000),
    fileHashes: z.record(safeRelativePath, sha256),
  })
  .superRefine((manifest, context) => {
    const provider = manifest.provider ?? "blender";
    if (provider === "blender") {
      if (!manifest.blenderVersion) {
        context.addIssue({
          code: "custom",
          path: ["blenderVersion"],
          message: "Blender return packages must declare blenderVersion",
        });
      }
      if (manifest.coordinateSystem.source !== "right-handed-z-up-negative-z-camera-forward") {
        context.addIssue({
          code: "custom",
          path: ["coordinateSystem", "source"],
          message: "Blender return packages must use the Blender Z-up coordinate stanza",
        });
      }
    } else {
      if (!manifest.hostVersion) {
        context.addIssue({
          code: "custom",
          path: ["hostVersion"],
          message: `${provider} return packages must declare the host application version`,
        });
      }
      if (manifest.coordinateSystem.source !== "right-handed-y-up-negative-z-forward") {
        context.addIssue({
          code: "custom",
          path: ["coordinateSystem", "source"],
          message: `${provider} connectors must convert transforms to Director canonical space at the provider boundary`,
        });
      }
    }
    const seen = new Set<string>();
    manifest.changes.forEach((change, index) => {
      const key = `${change.entityType}:${change.directorId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "directorId"],
          message: `duplicate return change for ${key}`,
        });
      }
      seen.add(key);
      if (change.kind === "mesh_replacement" && manifest.fileHashes[change.meshFile] === undefined) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "meshFile"],
          message: "mesh file must have a manifest SHA-256 entry",
        });
      }
    });
  });

const importPlanOperationSchema = z.discriminatedUnion("op", [
  strictOperation("update_transform", {
    entityType: directorAnimationEntityTypeSchema,
    objectId: nonEmpty.max(200),
    transform: directorTransformSchema,
  }),
  strictOperation("link_refined_asset", {
    objectId: nonEmpty.max(200),
    assetId: nonEmpty.max(240),
    assetLabel: nonEmpty.max(240),
    glbPath: safeRelativePath,
    hash: sha256,
  }),
  strictOperation("create_prop", {
    objectId: nonEmpty.max(200),
    name: nonEmpty.max(240),
    assetId: nonEmpty.max(240),
    transform: directorTransformSchema,
  }),
  strictOperation("skip", {
    directorId: nonEmpty.max(200),
    reason: nonEmpty.max(1_000),
  }),
  strictOperation("warn", { message: nonEmpty.max(2_000) }),
]);

/**
 * An import plan generated from a DCC return manifest.
 * Contains the concrete operations Director will execute, plus any conflicts
 * that prevent the plan from being ready to apply.
 */
export const directorDccImportPlanSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_DCC_IMPORT_PLAN_CONTRACT),
    ready: z.boolean(),
    packageId: nonEmpty.max(240),
    packageDir: safeRelativePath,
    manifestHash: sha256,
    sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    targetRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    operations: z.array(importPlanOperationSchema).max(40_000),
    conflicts: z
      .array(
        z.strictObject({
          directorId: nonEmpty.max(200),
          code: z.enum(["stale_source_revision", "unknown_director_id", "entity_type_mismatch"]),
          reason: nonEmpty.max(2_000),
        }),
      )
      .max(20_000),
    warnings: z.array(z.string().max(2_000)).max(20_000),
  })
  .superRefine((plan, context) => {
    if (plan.ready && plan.conflicts.length > 0) {
      context.addIssue({ code: "custom", path: ["ready"], message: "ready plans cannot contain conflicts" });
    }
  });

/** A summary report of a DCC return package import. */
export const directorDccReturnReportSchema = z.strictObject({
  ok: z.literal(true),
  contract: z.literal(DIRECTOR_DCC_RETURN_CONTRACT),
  packageId: nonEmpty.max(240),
  manifestPath: nonEmpty.max(2_048),
  changeCount: z.number().int().nonnegative(),
  meshCount: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(2_000)),
  blenderVersion: nonEmpty.max(200),
});

/** A single change in a DCC return package. */
export type DirectorDccReturnChange = z.infer<typeof directorDccReturnChangeSchema>;

/** The full DCC return manifest (v1). */
export type DirectorDccReturnManifestV1 = z.infer<typeof directorDccReturnManifestSchema>;

/** An import plan derived from a DCC return manifest (v1). */
export type DirectorDccImportPlanV1 = z.infer<typeof directorDccImportPlanSchema>;

/** A single operation within a DCC import plan. */
export type DirectorDccImportPlanOperation = DirectorDccImportPlanV1["operations"][number];

/** A summary report after processing a DCC return package (v1). */
export type DirectorDccReturnReportV1 = z.infer<typeof directorDccReturnReportSchema>;
