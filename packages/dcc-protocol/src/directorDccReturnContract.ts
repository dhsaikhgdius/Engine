import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectRevision";
import {
  directorAnimationEntityTypeSchema,
  directorTransformSchema,
} from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectSchema";
import { DIRECTOR_CAMERA_SENSOR_FORMATS } from "../../../frontend/director/src/comprehensive/editor/schema/directorProject";
import { DIRECTOR_CAMERA_OPTICS_LIMITS } from "../../../frontend/director/src/comprehensive/editor/schema/cameraGeometry";
import { CHARACTER_POSE_CONTROL_KEYS } from "../../../frontend/director/src/comprehensive/editor/schema/poseSchema";
import { strictKind, strictOperation } from "@director/protocol/strictProtocolVariant";
import {
  directorDccFiniteSchema,
  directorDccTransformSchema,
  directorDccVec3Schema,
} from "./directorDccSharedContract";
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

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB hex color");
const wireVec3 = directorDccVec3Schema;
const finiteWire = directorDccFiniteSchema;

/**
 * Camera optics reported by a DCC return package, in the DCC's native units
 * (millimetres and metres — identical on both sides of the wire). Values
 * outside Director's optics limits are baked to the nearest limit at plan
 * build time, with a warning; they are never silently dropped.
 */
export const directorDccReturnCameraOpticsSchema = z
  .strictObject({
    focalLengthMm: finiteWire.positive().max(10_000).optional(),
    apertureFStop: finiteWire.positive().max(1_000).optional(),
    focusDistanceM: finiteWire.positive().max(1_000_000).optional(),
    nearClipM: finiteWire.positive().max(1_000_000).optional(),
    farClipM: finiteWire.positive().max(100_000_000).optional(),
    sensorFormat: z.enum(DIRECTOR_CAMERA_SENSOR_FORMATS).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "camera optics update cannot be empty" });

/**
 * Light properties reported by a DCC return package. Points are wire-space
 * world points (Blender Z-up for Blender packages, canonical Director space
 * for engine packages). `intensity` is already mapped back to Director's
 * 0-100 range by the exporter (deterministic inverse of the stamped
 * watts-per-intensity factor), with clamping reported as a manifest warning.
 */
export const directorDccReturnLightPropertiesSchema = z
  .strictObject({
    position: wireVec3.optional(),
    target: wireVec3.optional(),
    color: hexColor.optional(),
    intensity: finiteWire.min(0).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "light update cannot be empty" });

const poseControlKeySchema = z.enum(CHARACTER_POSE_CONTROL_KEYS);

/**
 * A sample of Director's portable humanoid pose controls. Keys must be
 * portable control keys (a partial record: exporters send the controls they
 * track); unknown keys are rejected at the schema boundary so a DCC-side typo
 * cannot silently produce a no-op pose.
 */
export const directorDccReturnPoseControlsSchema = z
  .partialRecord(poseControlKeySchema, z.number().finite())
  .refine((controls) => Object.keys(controls).length > 0, { message: "pose update cannot be empty" })
  .refine((controls) => Object.keys(controls).length <= CHARACTER_POSE_CONTROL_KEYS.length, {
    message: "pose update exceeds the portable control set",
  });

/**
 * A single change in the DCC return package.
 *
 * - `mesh_replacement`: replace an object's mesh (with optional transform and asset label).
 * - `transform_update`: move an object or camera.
 * - `camera_update`: camera transform and/or optics (focal length, aperture, focus, clipping, sensor format).
 * - `light_update`: properties of a light that kept its Director `director_id`.
 * - `pose_update`: a portable pose-control sample for a Director character binding, with optional root motion.
 * - `object_addition`: a DCC object that gained a fresh `director_id` after the export snapshot.
 *   Import is reviewed and opt-in; Director never auto-imports unmarked DCC objects.
 */
export const directorDccReturnChangeSchema = z.discriminatedUnion("kind", [
  strictKind("mesh_replacement", {
    directorId: nonEmpty.max(200),
    entityType: z.literal("object"),
    meshFile: safeRelativePath,
    transform: directorDccTransformSchema.optional(),
    assetLabel: z.string().trim().min(1).max(240).optional(),
  }),
  strictKind("object_addition", {
    directorId: nonEmpty.max(200),
    entityType: z.literal("object"),
    name: z.string().trim().min(1).max(240),
    meshFile: safeRelativePath,
    transform: directorDccTransformSchema,
    assetLabel: z.string().trim().min(1).max(240).optional(),
  }),
  strictKind("transform_update", {
    directorId: nonEmpty.max(200),
    entityType: directorAnimationEntityTypeSchema,
    transform: directorDccTransformSchema,
  }),
  strictKind("camera_update", {
    directorId: nonEmpty.max(200),
    entityType: z.literal("camera"),
    transform: directorDccTransformSchema.optional(),
    optics: directorDccReturnCameraOpticsSchema.optional(),
  }).superRefine((change, context) => {
    if (!change.transform && !change.optics) {
      context.addIssue({
        code: "custom",
        path: ["optics"],
        message: "camera_update must carry a transform, optics, or both",
      });
    }
  }),
  strictKind("light_update", {
    directorId: nonEmpty.max(200),
    entityType: z.literal("light"),
    properties: directorDccReturnLightPropertiesSchema,
  }),
  strictKind("pose_update", {
    directorId: nonEmpty.max(200),
    entityType: z.literal("object"),
    controls: directorDccReturnPoseControlsSchema,
    /** Character root motion sampled together with the pose, if the root moved. */
    transform: directorDccTransformSchema.optional(),
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
      if (
        (change.kind === "mesh_replacement" || change.kind === "object_addition") &&
        manifest.fileHashes[change.meshFile] === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "meshFile"],
          message: "mesh file must have a manifest SHA-256 entry",
        });
      }
    });
  });

const opticsLimit = (key: keyof typeof DIRECTOR_CAMERA_OPTICS_LIMITS) =>
  z.number().finite().min(DIRECTOR_CAMERA_OPTICS_LIMITS[key].min).max(DIRECTOR_CAMERA_OPTICS_LIMITS[key].max);

/**
 * The Director-side camera optics patch of an import plan, expressed in the
 * exact ranges the Director authoring surface accepts. Plan building bakes
 * out-of-range DCC values to these limits and records a warning.
 */
export const directorDccImportPlanCameraOpticsSchema = z
  .strictObject({
    focal_length_mm: z.number().finite().min(12).max(200).optional(),
    aperture_f_stop: opticsLimit("apertureFStop").optional(),
    focus_distance_m: opticsLimit("focusDistanceM").optional(),
    near_clip_m: opticsLimit("nearClipM").optional(),
    far_clip_m: opticsLimit("farClipM").optional(),
    sensor_format: z.enum(DIRECTOR_CAMERA_SENSOR_FORMATS).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "camera optics patch cannot be empty" });

const directorVec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/** The Director-side light patch of an import plan (Director space and units). */
export const directorDccImportPlanLightPatchSchema = z
  .strictObject({
    color: hexColor.optional(),
    intensity: z.number().finite().min(0).max(100).optional(),
    position: directorVec3Schema.optional(),
    target: directorVec3Schema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "light patch cannot be empty" });

const importPlanOperationSchema = z.discriminatedUnion("op", [
  strictOperation("update_transform", {
    entityType: directorAnimationEntityTypeSchema,
    objectId: nonEmpty.max(200),
    transform: directorTransformSchema,
  }),
  strictOperation("update_camera_optics", {
    objectId: nonEmpty.max(200),
    optics: directorDccImportPlanCameraOpticsSchema,
  }),
  strictOperation("update_light", {
    lightId: nonEmpty.max(200),
    patch: directorDccImportPlanLightPatchSchema,
  }),
  strictOperation("set_character_pose", {
    objectId: nonEmpty.max(200),
    controls: z
      .array(z.strictObject({ control: z.enum(CHARACTER_POSE_CONTROL_KEYS), value: z.number().finite() }))
      .min(1)
      .max(CHARACTER_POSE_CONTROL_KEYS.length)
      .refine((entries) => new Set(entries.map((entry) => entry.control)).size === entries.length, {
        message: "pose controls must be unique",
      }),
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
    assetLabel: nonEmpty.max(240),
    glbPath: safeRelativePath,
    hash: sha256,
    transform: directorTransformSchema,
  }),
  strictOperation("skip", {
    directorId: nonEmpty.max(200),
    reason: nonEmpty.max(1_000),
  }),
  strictOperation("warn", { message: nonEmpty.max(2_000) }),
]);

/**
 * A structured record of one numeric value the plan builder baked to
 * Director's authoring limits. Every clamp is reported here alongside the
 * prose warning (warn-and-omit honesty: adjustments are never silently
 * flattened into the plan), so reviewers and agents can machine-check what
 * the DCC requested versus what Director will apply.
 */
export const directorDccImportPlanAdjustmentSchema = z.strictObject({
  directorId: nonEmpty.max(200),
  /** Plan-side field that was adjusted (e.g. `focal_length_mm`, `intensity`, `pose.spine_bend`). */
  field: nonEmpty.max(120),
  code: z.enum(["baked_to_limit"]),
  /** Value carried by the DCC return package. */
  requested: z.number().finite(),
  /** Value the plan will apply after baking to the limit. */
  applied: z.number().finite(),
  min: z.number().finite(),
  max: z.number().finite(),
});

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
    /** Structured limit bakes; absent on plans from pre-adjustment builders. */
    adjustments: z.array(directorDccImportPlanAdjustmentSchema).max(20_000).default([]),
    conflicts: z
      .array(
        z.strictObject({
          directorId: nonEmpty.max(200),
          code: z.enum([
            "stale_source_revision",
            "unknown_director_id",
            "entity_type_mismatch",
            "duplicate_director_id",
          ]),
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
  /** Number of camera_update changes; optional on pre-optics exporters. */
  cameraCount: z.number().int().nonnegative().optional(),
  /** Number of light_update changes; optional on pre-optics exporters. */
  lightCount: z.number().int().nonnegative().optional(),
  /** Number of pose_update changes; optional on pre-optics exporters. */
  poseCount: z.number().int().nonnegative().optional(),
  /** Number of object_addition changes; optional on pre-addition exporters. */
  additionCount: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string().max(2_000)),
  blenderVersion: nonEmpty.max(200),
});

/** A single change in a DCC return package. */
export type DirectorDccReturnChange = z.infer<typeof directorDccReturnChangeSchema>;

/** Camera optics carried by a `camera_update` return change. */
export type DirectorDccReturnCameraOptics = z.infer<typeof directorDccReturnCameraOpticsSchema>;

/** Light properties carried by a `light_update` return change. */
export type DirectorDccReturnLightProperties = z.infer<typeof directorDccReturnLightPropertiesSchema>;

/** The Director-side camera optics patch of an import plan operation. */
export type DirectorDccImportPlanCameraOptics = z.infer<typeof directorDccImportPlanCameraOpticsSchema>;

/** The Director-side light patch of an import plan operation. */
export type DirectorDccImportPlanLightPatch = z.infer<typeof directorDccImportPlanLightPatchSchema>;

/** A structured limit-bake record inside an import plan. */
export type DirectorDccImportPlanAdjustment = z.infer<typeof directorDccImportPlanAdjustmentSchema>;

/** The full DCC return manifest (v1). */
export type DirectorDccReturnManifestV1 = z.infer<typeof directorDccReturnManifestSchema>;

/** An import plan derived from a DCC return manifest (v1). */
export type DirectorDccImportPlanV1 = z.infer<typeof directorDccImportPlanSchema>;

/** A single operation within a DCC import plan. */
export type DirectorDccImportPlanOperation = DirectorDccImportPlanV1["operations"][number];

/** A summary report after processing a DCC return package (v1). */
export type DirectorDccReturnReportV1 = z.infer<typeof directorDccReturnReportSchema>;
