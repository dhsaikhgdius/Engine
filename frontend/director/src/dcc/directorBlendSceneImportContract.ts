import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../comprehensive/editor/schema/directorProjectRevision";
import { directorTransformSchema } from "../comprehensive/editor/schema/directorProjectSchema";
import { directorCameraAspectRatioSchema } from "../../../../packages/protocol/src/directorCameraProtocol";
import { strictOperation } from "../../../../packages/protocol/src/strictProtocolVariant";
import { directorDccTransformSchema } from "./directorDccSharedContract";

/**
 * Blender → Director scene import vocabulary: the manifest the Blender
 * connector exports from a .blend file, the reviewable import plan the
 * gateway derives from it, and the selection the human confirms before
 * anything is applied to the project. Nothing in this contract mutates the
 * Director project directly — the plan is evidence for a guarded import.
 */

/** Contract identifier for the Blender → Director scene manifest. */
export const DIRECTOR_BLEND_SCENE_CONTRACT = "director-blend-scene-v1" as const;
/** Contract identifier for the Blender scene import plan. */
export const DIRECTOR_BLEND_SCENE_IMPORT_PLAN_CONTRACT = "director-blend-scene-import-plan-v1" as const;

const nonEmpty = z.string().trim().min(1);
const finite = z.number().finite();
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

const blendCameraSchema = z.strictObject({
  sourceId: nonEmpty.max(240),
  name: nonEmpty.max(240),
  transform: directorDccTransformSchema,
  focalLengthMm: finite.min(1).max(2_000),
  sensorWidthMm: finite.positive().max(1_000),
  sensorHeightMm: finite.positive().max(1_000),
  sensorFit: z.enum(["auto", "horizontal", "vertical"]),
  renderAspectRatio: finite.positive().max(20),
  verticalFovDegrees: finite.positive().max(179),
  apertureFStop: finite.positive().max(256),
  focusDistanceM: finite.positive().max(1_000_000),
  nearClipM: finite.positive().max(100_000),
  farClipM: finite.positive().max(10_000_000),
});

/**
 * Blender scene manifest schema.
 *
 * Describes a `.blend` file's contents — cameras, timeline, coordinate
 * system, and scene metadata — so the Director gateway can plan an import
 * without executing Blender.
 */
export const directorBlendSceneManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    contract: z.literal(DIRECTOR_BLEND_SCENE_CONTRACT),
    packageId: nonEmpty.max(240),
    exportedAt: z.string().datetime({ offset: true }),
    blenderVersion: nonEmpty.max(200),
    source: z.strictObject({
      fileName: nonEmpty.max(512),
      sha256,
      sizeBytes: z.number().int().positive().max(2_147_483_648),
    }),
    coordinateSystem: z.strictObject({
      source: z.literal("right-handed-z-up-negative-z-camera-forward"),
      destination: z.literal("right-handed-y-up-negative-z-forward"),
      unit: z.literal("meter"),
      linearMap: z.literal("(x,y,z)->(x,z,-y)"),
    }),
    timeline: z.strictObject({
      frameStart: finite,
      frameEnd: finite,
      currentFrame: finite,
      fps: finite.positive().max(1_000),
      timebase: z.strictObject({
        rate: z.strictObject({
          numerator: z.number().int().positive().max(1_000_000),
          denominator: z.number().int().positive().max(1_000_000),
        }),
      }),
    }),
    scene: z.strictObject({
      name: nonEmpty.max(240),
      bundleFile: safeRelativePath.nullable(),
      objectCount: z.number().int().nonnegative().max(1_000_000),
      meshCount: z.number().int().nonnegative().max(1_000_000),
      materialCount: z.number().int().nonnegative().max(1_000_000),
      actionCount: z.number().int().nonnegative().max(1_000_000),
    }),
    cameras: z.array(blendCameraSchema).max(512),
    unsupported: z
      .array(
        z.strictObject({
          kind: nonEmpty.max(120),
          name: nonEmpty.max(240),
          reason: nonEmpty.max(2_000),
        }),
      )
      .max(20_000),
    warnings: z.array(z.string().max(2_000)).max(20_000),
    fileHashes: z.record(safeRelativePath, sha256),
  })
  .superRefine((manifest, context) => {
    if (manifest.scene.bundleFile && manifest.fileHashes[manifest.scene.bundleFile] === undefined) {
      context.addIssue({
        code: "custom",
        path: ["scene", "bundleFile"],
        message: "scene bundle must have a manifest SHA-256 entry",
      });
    }
    if (manifest.scene.objectCount > 0 && !manifest.scene.bundleFile) {
      context.addIssue({
        code: "custom",
        path: ["scene", "bundleFile"],
        message: "a scene with renderable objects must provide a GLB bundle",
      });
    }
    const sourceIds = new Set<string>();
    manifest.cameras.forEach((camera, index) => {
      if (sourceIds.has(camera.sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["cameras", index, "sourceId"],
          message: "duplicate camera sourceId",
        });
      }
      sourceIds.add(camera.sourceId);
      if (camera.farClipM <= camera.nearClipM) {
        context.addIssue({
          code: "custom",
          path: ["cameras", index, "farClipM"],
          message: "far clip must exceed near clip",
        });
      }
    });
  });

const importOperationSchema = z.discriminatedUnion("op", [
  strictOperation("create_scene_asset", {
    assetId: nonEmpty.max(240),
    label: nonEmpty.max(240),
    glbPath: safeRelativePath,
    hash: sha256,
  }),
  strictOperation("create_scene_object", {
    objectId: nonEmpty.max(240),
    name: nonEmpty.max(240),
    assetId: nonEmpty.max(240),
    transform: directorTransformSchema,
  }),
  strictOperation("create_camera", {
    sourceId: nonEmpty.max(240),
    cameraId: nonEmpty.max(240),
    objectId: nonEmpty.max(240),
    name: nonEmpty.max(240),
    position: z.tuple([finite, finite, finite]),
    target: z.tuple([finite, finite, finite]),
    focalLengthMm: finite.min(12).max(200),
    sensorFormat: z.enum(["super16", "super35", "fullFrame", "imax65"]),
    apertureFStop: finite.min(0.7).max(64),
    focusDistanceM: finite.min(0.01).max(10_000),
    nearClipM: finite.min(0.001).max(100),
    farClipM: finite.min(1).max(1_000_000),
    aspectRatio: directorCameraAspectRatioSchema,
  }),
  strictOperation("skip", { sourceId: nonEmpty.max(240), reason: nonEmpty.max(2_000) }),
  strictOperation("warn", { message: nonEmpty.max(2_000) }),
]);

/** User-facing selection for which Blender scene elements to import. */
export const directorBlendSceneImportSelectionSchema = z.strictObject({
  includeScene: z.boolean(),
  cameraSourceIds: z.array(nonEmpty.max(240)).max(512),
});

/** Typed warn-and-omit codes for Blender scene data an import plan leaves behind. */
export const DIRECTOR_BLEND_SCENE_OMITTED_CODES = [
  "unsupported_object",
  "hierarchy_flattened",
  "animation_actions",
  "camera_roll_lens_shift",
] as const;

/**
 * Typed warn-and-omit record for Blender scene data the import plan leaves
 * behind. Free-text `warnings` stay for humans; agents should read this array
 * (mirrors the DCC return plan `omittedOptics` / `omittedAdditions`).
 *
 * - `unsupported_object`: the extractor skipped a datablock it cannot export (`kind` carries the Blender type).
 * - `hierarchy_flattened`: the scene imports as one flattened Director scene object; per-object edits need the stable-ID round trip.
 * - `animation_actions`: Blender actions stay embedded in the GLB and are not mapped onto Director's editable timeline.
 * - `camera_roll_lens_shift`: camera roll and lens shift cannot be expressed by Director's target-based camera model.
 */
export const directorBlendSceneOmittedSchema = z.strictObject({
  sourceId: nonEmpty.max(240),
  /** Blender datablock kind for `unsupported_object` records. */
  kind: nonEmpty.max(120).optional(),
  code: z.enum(DIRECTOR_BLEND_SCENE_OMITTED_CODES),
  reason: nonEmpty.max(2_000),
});

/** A validated Blender scene import omitted record. */
export type DirectorBlendSceneOmitted = z.infer<typeof directorBlendSceneOmittedSchema>;

/** A typed warn-and-omit code on a Blender scene import plan. */
export type DirectorBlendSceneOmittedCode = DirectorBlendSceneOmitted["code"];

/**
 * Blender scene import plan schema.
 *
 * Produced by the gateway after reconciling a Blender manifest against the
 * current Director project. Contains a sequence of atomic operations that
 * can be applied to import the scene.
 */
export const directorBlendSceneImportPlanSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_BLEND_SCENE_IMPORT_PLAN_CONTRACT),
    planId: safeRelativePath,
    ready: z.boolean(),
    packageId: nonEmpty.max(240),
    packageDir: safeRelativePath,
    manifestHash: sha256,
    targetRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    selection: directorBlendSceneImportSelectionSchema,
    operations: z.array(importOperationSchema).max(2_000),
    conflicts: z
      .array(
        z.strictObject({
          sourceId: nonEmpty.max(240),
          code: z.enum(["id_collision", "empty_selection", "unsupported_scene"]),
          reason: nonEmpty.max(2_000),
        }),
      )
      .max(2_000),
    warnings: z.array(z.string().max(2_000)).max(20_000),
    /**
     * Count of typed omitted records. Optional for plans persisted before
     * typed omits; when omitted is present, length must equal this count.
     */
    omittedCount: z.number().int().nonnegative().max(100_000).optional(),
    /**
     * Typed warn-and-omit records for Blender scene data the plan leaves
     * behind. Optional for older stored plans; when present, length must
     * equal omittedCount. The cap covers the manifest `unsupported` cap plus
     * per-camera and per-scene records.
     */
    omitted: z.array(directorBlendSceneOmittedSchema).max(21_000).optional(),
  })
  .superRefine((plan, context) => {
    if (plan.ready && plan.conflicts.length > 0) {
      context.addIssue({ code: "custom", path: ["ready"], message: "ready plans cannot contain conflicts" });
    }
    if (new Set(plan.selection.cameraSourceIds).size !== plan.selection.cameraSourceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["selection", "cameraSourceIds"],
        message: "camera selection must be unique",
      });
    }
    if (plan.omitted !== undefined) {
      if (plan.omittedCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["omittedCount"],
          message: "omittedCount is required when omitted is present",
        });
      } else if (plan.omitted.length !== plan.omittedCount) {
        context.addIssue({
          code: "custom",
          path: ["omitted"],
          message: "omitted length must equal omittedCount",
        });
      }
    }
  });

/** Inferred type for a validated Blender scene manifest (v1). */
export type DirectorBlendSceneManifestV1 = z.infer<typeof directorBlendSceneManifestSchema>;
/** Inferred type for a Blender scene import selection. */
export type DirectorBlendSceneImportSelection = z.infer<typeof directorBlendSceneImportSelectionSchema>;
/** Inferred type for a validated Blender scene import plan (v1). */
export type DirectorBlendSceneImportPlanV1 = z.infer<typeof directorBlendSceneImportPlanSchema>;
/** A single operation within a Blender scene import plan. */
export type DirectorBlendSceneImportOperation = DirectorBlendSceneImportPlanV1["operations"][number];
