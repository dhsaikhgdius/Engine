import { z } from "zod";
import {
  directorAssetKindSchema,
  directorObjectKindSchema,
  directorProjectSchema,
  directorTransformSchema,
} from "@director/project-schema";
import { DIRECTOR_PLACEMENT_MODES } from "@director/project-schema";
import {
  directorUiStateSchema,
  DIRECTOR_SHOT_RENDER_PASS_IDS,
  directorAgentAssetCategorySchema,
  directorAgentAssetPreviewSchema,
} from "@director/protocol/workbench-ui";
import { asRecord } from "@director/protocol/primitives";
import { blenderAgentOperationNames } from "@director/protocol/blenderLiveProtocol";
import { strictAction, strictOperation } from "@director/protocol/strictProtocolVariant";
import {
  generated3dModeSchema,
  generated3dProviderIdSchema,
  generated3dTopologySchema,
} from "@director/protocol/generated3dProtocol";
import {
  comfyGenerationParametersSchema,
  comfyMediaKindSchema,
  comfyNodeDefinitionSchema,
  comfyPromptProvenanceSchema,
} from "@director/protocol/comfyGenerationProtocol";
import { directorAuthoringActionSchema } from "./directorAuthoring";
import { directorMacroDraftSchema, directorMacroScalarSchema } from "./directorAutomation";

const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);
const jsonPointer = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\/(project|ui)(?:\/|$)/, "path must start with /project or /ui");
const directorProjectRevisionSchema = z.string().trim().min(1).max(240);
const directorIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "idempotency_key must contain only letters, numbers, dot, underscore, colon, or dash",
  );
const productionRevisionSchema = z.number().int().nonnegative();
const productionMutationGuardFields = {
  expected_revision: productionRevisionSchema.optional(),
  idempotency_key: directorIdempotencyKeySchema.optional(),
} as const;
const revisionGuardFields = {
  expected_revision: directorProjectRevisionSchema.optional(),
  unconditional: z.boolean().optional(),
  idempotency_key: directorIdempotencyKeySchema.optional(),
} as const;
const rasterDimensionSchema = z.number().int().min(1).max(4096);
const renderPassesSchema = z
  .array(z.enum(DIRECTOR_SHOT_RENDER_PASS_IDS))
  .min(1)
  .max(DIRECTOR_SHOT_RENDER_PASS_IDS.length);
const optionalRasterFields = {
  width: rasterDimensionSchema.optional(),
  height: rasterDimensionSchema.optional(),
} as const;
const defaultRasterFields = {
  width: rasterDimensionSchema.default(1280),
  height: rasterDimensionSchema.default(720),
} as const;
const optionalRenderPassesField = { render_passes: renderPassesSchema.optional() } as const;

function rasterDimensionsArePaired(value: { width?: number; height?: number }): boolean {
  return (value.width === undefined) === (value.height === undefined);
}

function rasterFitsAgentWire(value: { width?: number; height?: number }): boolean {
  return !value.width || !value.height || value.width * value.height <= 2_073_600;
}

function revisionGuardIsUnambiguous(value: { expected_revision?: string; unconditional?: boolean }): boolean {
  return !(value.expected_revision && value.unconditional === true);
}

const revisionGuardRefinement = {
  message: "expected_revision and unconditional cannot be used together",
  path: ["expected_revision"],
};

export const directorWorkbenchObserveFieldSchema = z.enum([
  "scene",
  "ui",
  "assets",
  "objects",
  "lights",
  "characters",
  "cameras",
  "timeline",
  "storyboard",
  "production",
  "world",
  "counts",
  "graph_issues",
]);

export const directorWorkbenchCatalogIdSchema = z.enum([
  "assets",
  "character_assets",
  "character_motions",
  "project_assets",
]);

/** Agent-facing origin of a live project asset for project_assets filtering. */
export const directorWorkbenchProjectAssetSourceSchema = z.enum(["uploaded", "generated", "library"]);

export const directorProductionCommandSchema = z.discriminatedUnion("action", [
  strictAction("observe", {}),
  strictAction("rename_production", {
    title: nonEmptyText(240),
    ...productionMutationGuardFields,
  }),
  strictAction("create_scene", {
    scene_id: nonEmptyText(160),
    title: nonEmptyText(240),
    activate: z.boolean().default(true),
    ...productionMutationGuardFields,
  }),
  strictAction("duplicate_scene", {
    source_scene_id: nonEmptyText(160),
    scene_id: nonEmptyText(160),
    title: nonEmptyText(240).optional(),
    activate: z.boolean().default(true),
    ...productionMutationGuardFields,
  }).refine((value) => value.source_scene_id !== value.scene_id, {
    message: "source_scene_id and scene_id must be different",
    path: ["scene_id"],
  }),
  strictAction("rename_scene", {
    scene_id: nonEmptyText(160),
    title: nonEmptyText(240),
    ...productionMutationGuardFields,
  }),
  strictAction("activate_scene", {
    scene_id: nonEmptyText(160),
    ...productionMutationGuardFields,
  }),
  strictAction("delete_scene", {
    scene_id: nonEmptyText(160),
    replacement: z
      .strictObject({
        scene_id: nonEmptyText(160),
        title: nonEmptyText(240),
      })
      .optional(),
    ...productionMutationGuardFields,
  }).refine((value) => value.replacement?.scene_id !== value.scene_id, {
    message: "replacement.scene_id must differ from scene_id",
    path: ["replacement", "scene_id"],
  }),
]);

export const directorAuditSuggestedFixSchema = z.strictObject({
  kind: z.literal("author_actions"),
  actions: z.array(directorAuthoringActionSchema).min(1).max(32),
});

export const directorAuditIssueInputSchema = z.strictObject({
  severity: z.enum(["error", "warning", "info"]).optional(),
  code: nonEmptyText(160),
  message: z.string().max(4_000).optional(),
  entity_ids: z.array(nonEmptyText(200)).max(64).optional(),
  suggested_fix: directorAuditSuggestedFixSchema.optional(),
});

export const directorWorkbenchPatchSchema = z.discriminatedUnion("op", [
  strictOperation("add", { path: jsonPointer, value: z.unknown() }),
  strictOperation("replace", { path: jsonPointer, value: z.unknown() }),
  strictOperation("remove", { path: jsonPointer }),
]);

export const directorGenerated3DCommandSchema = z.discriminatedUnion("action", [
  strictAction("providers", {}),
  strictAction("list", { limit: z.number().int().min(1).max(200).default(50) }),
  strictAction("get", { job_id: nonEmptyText(240) }),
  strictAction("submit", {
    mode: generated3dModeSchema,
    provider_id: generated3dProviderIdSchema.optional(),
    name: nonEmptyText(160),
    prompt: nonEmptyText(600),
    negative_prompt: z.string().trim().max(255).optional(),
    source_media_id: nonEmptyText(240).optional(),
    /** Omit to let the gateway estimate a plausible real-world height from the prompt. */
    target_height_m: z.number().finite().min(0.01).max(100).optional(),
    topology: generated3dTopologySchema.default("triangle"),
    target_polygon_count: z.number().int().min(100).max(2_000_000).default(50_000),
    texture: z.boolean().default(true),
    pbr: z.boolean().default(true),
    seed: z.number().int().min(0).max(2_147_483_647).default(0),
    model_version: nonEmptyText(160).optional(),
    idempotency_key: directorIdempotencyKeySchema.optional(),
  })
    .refine((value) => (value.mode === "image-to-3d") === Boolean(value.source_media_id), {
      message: "image-to-3d requires source_media_id; text-to-3d must omit it",
      path: ["source_media_id"],
    })
    .refine((value) => value.texture || !value.pbr, {
      message: "PBR output requires texture=true",
      path: ["pbr"],
    }),
  strictAction("cancel", { job_id: nonEmptyText(240) }),
  strictAction("retry", { job_id: nonEmptyText(240), idempotency_key: directorIdempotencyKeySchema.optional() }),
  strictAction("reconcile", { job_id: nonEmptyText(240) }),
  strictAction("promote", {
    job_id: nonEmptyText(240),
    expected_revision: directorProjectRevisionSchema.optional(),
    idempotency_key: directorIdempotencyKeySchema.optional(),
    add_to_scene: z.boolean().default(true),
    object_id: nonEmptyText(200).optional(),
    transform: directorTransformSchema.optional(),
    placement_mode: z.enum(DIRECTOR_PLACEMENT_MODES).default("grounded"),
  }).superRefine((value, context) => {
    if (!value.add_to_scene && (value.object_id || value.transform)) {
      context.addIssue({
        code: "custom",
        message: "object_id and transform require add_to_scene=true",
        path: ["add_to_scene"],
      });
    }
  }),
]);

export const directorGenerationCommandSchema = z.discriminatedUnion("action", [
  strictAction("nodes", {}),
  strictAction("workflows", { media_kind: comfyMediaKindSchema.optional() }),
  strictAction("list", { limit: z.number().int().min(1).max(200).default(50) }),
  strictAction("get", { job_id: nonEmptyText(240) }),
  strictAction("submit", {
    kind: z.enum(["image.generate", "video.generate", "audio.generate"]),
    workflow_id: nonEmptyText(160),
    prompt: nonEmptyText(12_000),
    negative_prompt: z.string().trim().max(12_000).optional(),
    width: z.number().int().min(64).max(8_192).default(1_024),
    height: z.number().int().min(64).max(8_192).default(1_024),
    seed: z.number().int().min(0).max(2_147_483_647).default(0),
    duration_seconds: z.number().positive().max(600).default(5),
    fps: z.number().positive().max(240).default(24),
    audio_mode: z.enum(["sound-effect", "music", "speech"]).default("sound-effect"),
    sample_rate: z.number().int().min(8_000).max(192_000).default(48_000),
    voice: z.string().trim().min(1).max(240).optional(),
    language: z.string().trim().min(1).max(80).optional(),
    parameters: comfyGenerationParametersSchema.default({}),
    node_ids: z.array(comfyNodeDefinitionSchema.shape.id).max(32).default([]),
    copies: z.number().int().min(1).max(32).default(1),
    seed_strategy: z.enum(["fixed", "increment", "random"]).default("increment"),
    prompt_provenance: comfyPromptProvenanceSchema.default({ source: "manual", editedAfterCompile: false }),
    idempotency_key: directorIdempotencyKeySchema.optional(),
  }).superRefine((value, context) => {
    if (value.kind !== "audio.generate" && (value.voice || value.language)) {
      context.addIssue({
        code: "custom",
        message: "voice and language are only valid for audio.generate",
        path: [value.voice ? "voice" : "language"],
      });
    }
    if (value.kind === "audio.generate" && value.audio_mode !== "speech" && (value.voice || value.language)) {
      context.addIssue({
        code: "custom",
        message: "voice and language require audio_mode=speech",
        path: [value.voice ? "voice" : "language"],
      });
    }
  }),
  strictAction("cancel", { job_id: nonEmptyText(240) }),
  strictAction("retry", { job_id: nonEmptyText(240), idempotency_key: directorIdempotencyKeySchema.optional() }),
  strictAction("reconcile", { job_id: nonEmptyText(240) }),
  strictAction("promote", {
    job_id: nonEmptyText(240),
    artifact_ids: z.array(nonEmptyText(240)).max(64).default([]),
    ensure_waveform: z.boolean().default(true),
  }),
]);

export const directorTranscriptionCommandSchema = z.discriminatedUnion("action", [
  strictAction("capabilities", {}),
  strictAction("list", { limit: z.number().int().min(1).max(200).default(50) }),
  strictAction("get", { job_id: nonEmptyText(240) }),
  strictAction("submit", {
    source_media_id: nonEmptyText(512),
    language: z.string().trim().min(1).max(80).optional(),
    idempotency_key: directorIdempotencyKeySchema.optional(),
  }),
  strictAction("cancel", { job_id: nonEmptyText(240) }),
  strictAction("retry", { job_id: nonEmptyText(240), idempotency_key: directorIdempotencyKeySchema.optional() }),
  strictAction("read", {
    source_media_id: nonEmptyText(512),
    from_seconds: z
      .number()
      .finite()
      .min(0)
      .max(24 * 60 * 60)
      .default(0),
    to_seconds: z
      .number()
      .finite()
      .positive()
      .max(24 * 60 * 60)
      .optional(),
    max_segments: z.number().int().min(1).max(200).default(80),
  }).refine((value) => value.to_seconds === undefined || value.to_seconds > value.from_seconds, {
    message: "to_seconds must be greater than from_seconds",
    path: ["to_seconds"],
  }),
  strictAction("search", {
    source_media_id: nonEmptyText(512),
    query: nonEmptyText(500),
    speaker: z.string().trim().min(1).max(160).optional(),
    from_seconds: z
      .number()
      .finite()
      .min(0)
      .max(24 * 60 * 60)
      .default(0),
    to_seconds: z
      .number()
      .finite()
      .positive()
      .max(24 * 60 * 60)
      .optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }).refine((value) => value.to_seconds === undefined || value.to_seconds > value.from_seconds, {
    message: "to_seconds must be greater than from_seconds",
    path: ["to_seconds"],
  }),
  strictAction("promote", {
    job_id: nonEmptyText(240),
    add_to_timeline: z.boolean().default(false),
    caption_offset_seconds: z
      .number()
      .finite()
      .min(0)
      .max(24 * 60 * 60)
      .default(0),
  }),
]);

export const directorReconstructionCommandSchema = z.discriminatedUnion("action", [
  strictAction("list", { limit: z.number().int().min(1).max(200).default(50) }),
  strictAction("get", { job_id: nonEmptyText(240) }),
  /**
   * Reconstruct a staged capture (Gallery video, or an RGB-D scanner bundle
   * staged through the media-inputs endpoint) into an editable, walkable plan.
   */
  strictAction("submit", {
    /** Gallery media id, or an already staged `…sha256:<hex>` media-input id. */
    source_media_id: nonEmptyText(512),
    /** Omitted: zip sources reconstruct as rgbd-bundle, others as rgb-video. */
    source_kind: z.enum(["rgbd-bundle", "rgb-video"]).optional(),
    max_key_views: z.number().int().min(1).max(12).default(6),
    max_objects: z.number().int().min(1).max(64).default(24),
    prompt: z.string().trim().max(2_000).default(""),
    idempotency_key: directorIdempotencyKeySchema.optional(),
  }),
  strictAction("plan", { job_id: nonEmptyText(240) }),
  strictAction("apply", {
    job_id: nonEmptyText(240),
    mode: z.enum(["append", "replace"]).default("append"),
    include_cameras: z.boolean().default(true),
    include_shell: z.boolean().default(false),
    expected_revision: directorProjectRevisionSchema.optional(),
    idempotency_key: directorIdempotencyKeySchema.optional(),
  }),
  /** Render the stage from one applied capture camera and score it against the keyframe. */
  strictAction("compare", {
    job_id: nonEmptyText(240),
    view_id: nonEmptyText(120).optional(),
    camera_id: nonEmptyText(200).optional(),
    frame: z.number().int().nonnegative().default(0),
  }),
]);

const directorStoryboardExportFields = {
  paper_size: z.enum(["a4", "letter"]).default("a4"),
  orientation: z.enum(["portrait", "landscape"]).default("landscape"),
  columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
  scope: z.enum(["all", "selected"]).default("all"),
  shot_ids: z.array(nonEmptyText(200)).max(500).default([]),
  include_metadata: z.boolean().default(true),
  include_action: z.boolean().default(true),
} as const;

export const directorStoryboardArtifactCommandSchema = z.discriminatedUnion("action", [
  strictAction("capture_thumbnail", {
    shot_id: nonEmptyText(200),
    expected_revision: directorProjectRevisionSchema.optional(),
    idempotency_key: directorIdempotencyKeySchema.optional(),
  }),
  strictAction("capture_missing", {
    expected_revision: directorProjectRevisionSchema.optional(),
    idempotency_key: directorIdempotencyKeySchema.optional(),
  }),
  strictAction("export_pdf", {
    ...directorStoryboardExportFields,
    artifact: z.enum(["pdf", "verification-package"]).default("verification-package"),
    download: z.boolean().default(true),
    expected_revision: directorProjectRevisionSchema.optional(),
    idempotency_key: directorIdempotencyKeySchema.optional(),
  }).refine((value) => value.scope === "all" || value.shot_ids.length > 0, {
    message: "selected storyboard export requires at least one shot_id",
    path: ["shot_ids"],
  }),
]);

export const directorAuthorDeliveryProfileSchema = z
  .strictObject({
    quality_profile: z.enum(["blocking", "cinematic", "video-gen"]).optional(),
    ...optionalRasterFields,
    ...optionalRenderPassesField,
  })
  .refine(rasterDimensionsArePaired, {
    message: "author delivery width and height must be supplied together",
  })
  .refine(rasterFitsAgentWire, {
    message: "author delivery raster cannot exceed 2073600 pixels over the Agent wire",
  });

export const directorAuthorEvidenceProfileSchema = z
  .strictObject({
    kind: z.literal("camera_frame").default("camera_frame"),
    camera_id: nonEmptyText(200).optional(),
    frame: z.number().int().nonnegative().optional(),
    width: rasterDimensionSchema.default(640),
    height: rasterDimensionSchema.default(360),
    depth_of_field: z.boolean().optional(),
  })
  .refine(rasterFitsAgentWire, {
    message: "author evidence raster cannot exceed 2073600 pixels over the Agent wire",
  });

const directorSpatialVec3Schema = directorTransformSchema.shape.position;
export const directorObjectSpatialQuerySchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("frustum"),
    camera_id: nonEmptyText(200).optional(),
  }),
  z
    .strictObject({
      mode: z.literal("aabb"),
      min: directorSpatialVec3Schema,
      max: directorSpatialVec3Schema,
    })
    .refine((value) => value.min.every((minimum, index) => minimum <= value.max[index]), {
      message: "aabb min must not exceed max on any axis",
      path: ["min"],
    }),
  z.strictObject({
    mode: z.literal("radius"),
    center: directorSpatialVec3Schema,
    radius_m: z.number().positive().max(1_000_000),
  }),
  z.strictObject({
    mode: z.literal("nearby"),
    object_id: nonEmptyText(200),
    radius_m: z.number().positive().max(1_000_000),
  }),
]);

/** Actionable shape shown when query_objects is missing a selector or invents filter-only fields. */
const QUERY_OBJECTS_SHAPE_HINT =
  'query_objects requires spatial, name_pattern, or kind. Example {"op":"query_objects","name_pattern":"door"} or {"op":"query_objects","spatial":{"mode":"frustum"}}. Name filter may also be {"op":"query_objects","filter":{"name_pattern":"door"}}';

const DIFF_SHAPE_HINT =
  'diff requires exactly one of since_turn or since_audit. Example {"op":"diff","since_turn":"<turn-id>"} or {"op":"diff","since_audit":"<audit-token>"}. Copy those values from the last successful observe, author, or audit result; do not guess numbers or send {"op":"diff"} alone.';

const INSPECT_ENTITY_NAMES =
  "object, light, camera, asset, catalog_asset, storyboard_shot, performance_take, coverage_sequence, coverage_shot";

const INSPECT_SHAPE_HINT = `inspect requires entity and id. entity is one of ${INSPECT_ENTITY_NAMES}. Example {"op":"inspect","entity":"object","id":"door-1"} or {"op":"inspect","entity":"camera","id":"cam-main"}. Do not treat a spill locator, name, or object_id as entity.`;

export const directorMacroCommandSchema = z.discriminatedUnion("action", [
  strictAction("list", {
    query: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(128).default(50),
  }),
  strictAction("get", { macro_id: nonEmptyText(120) }),
  strictAction("save", { macro: directorMacroDraftSchema, overwrite: z.boolean().default(false) }),
  strictAction("remove", { macro_id: nonEmptyText(120) }),
  strictAction("export", { include_content: z.boolean().default(false) }),
]);

export const directorMemoryCommandSchema = z.discriminatedUnion("action", [
  strictAction("recall", {
    query: z.string().trim().max(500).optional(),
    scope: z.enum(["all", "global", "scene"]).default("all"),
    scene_id: nonEmptyText(200).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }).refine((value) => value.scope !== "scene" || Boolean(value.scene_id), {
    message: "scene-scoped recall requires scene_id",
    path: ["scene_id"],
  }),
  strictAction("pin", {
    memory_id: nonEmptyText(120),
    text: nonEmptyText(4_000),
    category: z.string().trim().min(1).max(80).default("general"),
    tags: z.array(z.string().trim().min(1).max(80)).max(16).default([]),
    scope: z.enum(["global", "scene"]).default("global"),
    scene_id: nonEmptyText(200).optional(),
    overwrite: z.boolean().default(false),
  }).refine((value) => (value.scope === "scene") === Boolean(value.scene_id), {
    message: "scene-scoped memory requires scene_id; global memory must omit it",
    path: ["scene_id"],
  }),
  strictAction("forget", { memory_id: nonEmptyText(120) }),
  strictAction("export", { include_content: z.boolean().default(false) }),
]);

export const directorWorkbenchOperationSchema = z.discriminatedUnion("op", [
  strictOperation("capabilities", {}),
  /**
   * Progressive schema disclosure: returns the JSON Schema of one operation
   * (`target: "capture"`) or one author action (`target: "author.add_object"`).
   * Pure contract reflection; requires no browser tab and no project state.
   */
  strictOperation("describe", { target: nonEmptyText(200) }),
  strictOperation("production", { command: directorProductionCommandSchema }),
  strictOperation("catalog", {
    catalog: directorWorkbenchCatalogIdSchema,
    query: z.string().trim().max(200).optional(),
    asset_id: nonEmptyText(200).optional(),
    category: directorAgentAssetCategorySchema.optional(),
    kind: directorAssetKindSchema.optional(),
    preview_status: directorAgentAssetPreviewSchema.shape.status.optional(),
    /** Only for catalog:"project_assets"; scopes results to one asset origin. */
    asset_source: directorWorkbenchProjectAssetSourceSchema.optional(),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  }).superRefine((value, context) => {
    if (
      value.catalog === "character_motions" &&
      (value.asset_id || value.category || value.kind || value.preview_status)
    ) {
      context.addIssue({
        code: "custom",
        message: "asset_id/category/kind/preview_status are only valid for asset catalogs",
      });
    }
    if (value.catalog === "character_assets" && value.kind && value.kind !== "character") {
      context.addIssue({ code: "custom", message: "character_assets only contains kind=character", path: ["kind"] });
    }
    if (value.asset_source && value.catalog !== "project_assets") {
      context.addIssue({
        code: "custom",
        message: "asset_source is only valid for the project_assets catalog",
        path: ["asset_source"],
      });
    }
    if (value.catalog === "project_assets" && (value.asset_id || value.category || value.preview_status)) {
      context.addIssue({
        code: "custom",
        message: "project_assets supports only query, kind, asset_source, offset, and limit",
      });
    }
  }),
  strictOperation("observe", {
    detail: z.enum(["summary", "full"]).optional(),
    fields: z.array(directorWorkbenchObserveFieldSchema).min(1).max(12).optional(),
    since_revision: directorProjectRevisionSchema.optional(),
    since_turn: nonEmptyText(200).optional(),
    since_audit: nonEmptyText(200).optional(),
    object_mode: z.enum(["flat", "hierarchy"]).optional(),
    max_objects: z.number().int().min(1).max(500).optional(),
    max_changes: z.number().int().min(1).max(500).optional(),
  }).superRefine((value, context) => {
    if ([value.since_revision, value.since_turn, value.since_audit].filter(Boolean).length > 1) {
      context.addIssue({
        code: "custom",
        message: "observe accepts only one of since_revision, since_turn, or since_audit",
      });
    }
    if (value.since_revision && value.object_mode === "hierarchy") {
      context.addIssue({
        code: "custom",
        message: "object_mode=hierarchy is not available for revision deltas",
        path: ["object_mode"],
      });
    }
    if (value.since_revision && value.fields?.includes("ui")) {
      context.addIssue({
        code: "custom",
        message: "since_revision compares persisted project state and cannot include ui",
        path: ["fields"],
      });
    }
    if (value.object_mode === "hierarchy" && value.fields && !value.fields.includes("objects")) {
      context.addIssue({
        code: "custom",
        message: "object_mode=hierarchy requires the objects field",
        path: ["fields"],
      });
    }
  }),
  strictOperation("query_objects", {
    spatial: directorObjectSpatialQuerySchema.optional(),
    name_pattern: nonEmptyText(120).optional(),
    kind: directorObjectKindSchema.optional(),
    include_hidden: z.boolean().default(false),
    max_results: z.number().int().min(1).max(200).default(50),
  }).superRefine((value, context) => {
    if (!value.spatial && !value.name_pattern && !value.kind) {
      context.addIssue({ code: "custom", message: QUERY_OBJECTS_SHAPE_HINT });
    }
  }),
  strictOperation("snapshot", {
    scope: z.enum(["project", "ui", "all"]).optional(),
  }),
  strictOperation("inspect", {
    entity: z.enum([
      "object",
      "light",
      "camera",
      "asset",
      "catalog_asset",
      "storyboard_shot",
      "performance_take",
      "coverage_sequence",
      "coverage_shot",
    ]),
    id: nonEmptyText(200),
  }),
  strictOperation("shot_ir", {
    camera_id: nonEmptyText(200).optional(),
    take_id: nonEmptyText(200).optional(),
    coverage_shot_id: nonEmptyText(200).optional(),
    frame: z.number().int().nonnegative().optional(),
  }),
  strictOperation("generation", { command: directorGenerationCommandSchema }),
  strictOperation("transcription", { command: directorTranscriptionCommandSchema }),
  strictOperation("generated_3d", { command: directorGenerated3DCommandSchema }),
  strictOperation("reconstruction", { command: directorReconstructionCommandSchema }),
  strictOperation("storyboard_artifact", { command: directorStoryboardArtifactCommandSchema }),
  strictOperation("macro", { command: directorMacroCommandSchema }),
  strictOperation("memory", { command: directorMemoryCommandSchema }),
  strictOperation("run_macro", {
    macro_id: nonEmptyText(120),
    parameters: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), directorMacroScalarSchema).default({}),
    camera_id: nonEmptyText(200).optional(),
    subject_id: nonEmptyText(200).optional(),
    delivery: directorAuthorDeliveryProfileSchema.optional(),
    ...revisionGuardFields,
  }).refine(revisionGuardIsUnambiguous, revisionGuardRefinement),
  strictOperation("patch", {
    patches: z.array(directorWorkbenchPatchSchema).min(1).max(128),
    ...revisionGuardFields,
  }).refine(revisionGuardIsUnambiguous, revisionGuardRefinement),
  strictOperation("author", {
    actions: z.array(directorAuthoringActionSchema).min(1).max(128),
    camera_id: nonEmptyText(200).optional(),
    subject_id: nonEmptyText(200).optional(),
    delivery: directorAuthorDeliveryProfileSchema.optional(),
    evidence: directorAuthorEvidenceProfileSchema.optional(),
    ...revisionGuardFields,
  }).refine(revisionGuardIsUnambiguous, revisionGuardRefinement),
  strictOperation("audit", {
    detail: z.enum(["summary", "full"]).optional(),
    camera_id: nonEmptyText(200).optional(),
    subject_id: nonEmptyText(200).optional(),
    include_spatial: z.boolean().optional(),
  }),
  strictOperation("correct", {
    audit_issues: z.array(directorAuditIssueInputSchema).min(1).max(64).optional(),
    audit_token: nonEmptyText(200).optional(),
    ...revisionGuardFields,
  })
    .refine((value) => !(value.audit_issues && value.audit_token), {
      message: "correct accepts audit_issues or audit_token, not both",
    })
    .refine(revisionGuardIsUnambiguous, revisionGuardRefinement),
  strictOperation("diff", {
    since_turn: nonEmptyText(200).optional(),
    since_audit: nonEmptyText(200).optional(),
  }).refine((value) => Boolean(value.since_turn) !== Boolean(value.since_audit), {
    message: DIFF_SHAPE_HINT,
  }),
  strictOperation("trace", {
    turn_id: nonEmptyText(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  strictOperation("replace_project", { project: directorProjectSchema, ...revisionGuardFields }).refine(
    revisionGuardIsUnambiguous,
    revisionGuardRefinement,
  ),
  strictOperation("select", {
    object_ids: z.array(nonEmptyText(200)).max(200).optional(),
    crowd_id: nonEmptyText(200).nullable().optional(),
  }),
  strictOperation("viewport", {
    transform_mode: directorUiStateSchema.shape.transformMode.optional(),
    aspect_ratio: directorUiStateSchema.shape.viewportAspectRatio.optional(),
    layout: directorUiStateSchema.shape.viewportLayout.optional(),
    rule_of_thirds: z.boolean().optional(),
  }).refine(
    (value) =>
      value.transform_mode !== undefined ||
      value.aspect_ratio !== undefined ||
      value.layout !== undefined ||
      value.rule_of_thirds !== undefined,
    { message: "viewport needs transform_mode, aspect_ratio, layout, or rule_of_thirds" },
  ),
  strictOperation("playback", {
    playing: z.boolean().optional(),
    current_frame: z.number().int().nonnegative().optional(),
    active_panel: z.enum(["scene", "timeline"]).optional(),
  }).refine(
    (value) => value.playing !== undefined || value.current_frame !== undefined || value.active_panel !== undefined,
    { message: "playback needs playing, current_frame, or active_panel" },
  ),
  strictOperation("player", {
    action: z.enum([
      "enter",
      "exit",
      "set_actor",
      "teleport",
      "walk_to",
      "interact",
      "enter_vehicle",
      "exit_vehicle",
      "record_start",
      "record_stop",
    ]),
    actor_id: nonEmptyText(200).optional(),
    object_id: nonEmptyText(200).optional(),
    position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  }),
  strictOperation("pilot", {
    action: z.enum(["start", "stop", "set_view", "record_waypoint"]),
    camera_id: nonEmptyText(200).optional(),
    position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
    target: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
    fov: z.number().finite().positive().max(179).optional(),
  }),
  strictOperation("undo", revisionGuardFields).refine(revisionGuardIsUnambiguous, revisionGuardRefinement),
  strictOperation("capture", {
    /** Omitted camera_id captures through the active project camera. */
    camera_id: nonEmptyText(200).optional(),
    frame: z.number().int().nonnegative(),
    render_pass: z.enum(DIRECTOR_SHOT_RENDER_PASS_IDS).optional(),
    clean_plate: z.boolean().optional(),
    /** False bypasses the cinematic depth-of-field pass for a deep-focus render. */
    depth_of_field: z.boolean().optional(),
    expected_revision: directorProjectRevisionSchema.optional(),
    ...optionalRasterFields,
  })
    .refine(rasterDimensionsArePaired, {
      message: "capture width and height must be supplied together",
    })
    .refine(rasterFitsAgentWire, {
      message: "capture raster cannot exceed 2073600 pixels over the Agent wire",
    }),
  strictOperation("shot_package", {
    camera_id: nonEmptyText(200).optional(),
    take_id: nonEmptyText(200).optional(),
    coverage_shot_id: nonEmptyText(200).optional(),
    frame: z.number().int().nonnegative().optional(),
    /** Additionally emit the depth pass as a float32 OpenEXR artifact; requires the depth render pass. */
    include_depth_exr: z.boolean().optional(),
    ...defaultRasterFields,
    ...optionalRenderPassesField,
    expected_revision: directorProjectRevisionSchema.optional(),
  }).refine(rasterFitsAgentWire, {
    message: "shot_package raster cannot exceed 2073600 pixels over the Agent wire",
  }),
  strictOperation("deliver", {
    camera_id: nonEmptyText(200).optional(),
    subject_id: nonEmptyText(200).optional(),
    take_id: nonEmptyText(200).optional(),
    coverage_shot_id: nonEmptyText(200).optional(),
    frame: z.number().int().nonnegative().optional(),
    quality_profile: z.enum(["blocking", "cinematic", "video-gen"]).default("cinematic"),
    /** Additionally emit the depth pass as a float32 OpenEXR artifact; requires the depth render pass. */
    include_depth_exr: z.boolean().optional(),
    ...defaultRasterFields,
    ...optionalRenderPassesField,
    expected_revision: directorProjectRevisionSchema.optional(),
  }).refine(rasterFitsAgentWire, {
    message: "deliver raster cannot exceed 2073600 pixels over the Agent wire",
  }),
]);

export type DirectorWorkbenchOperation = z.infer<typeof directorWorkbenchOperationSchema>;
type DirectorWorkbenchMutationOperation = Extract<
  DirectorWorkbenchOperation,
  { op: "patch" | "author" | "run_macro" | "correct" | "replace_project" | "undo" }
>;
type DirectorWorkbenchGuardedMutationOperation = DirectorWorkbenchMutationOperation &
  ({ expected_revision: string } | { expected_revision?: never; unconditional: true });
export type DirectorGenerationCommand = z.infer<typeof directorGenerationCommandSchema>;
export type DirectorTranscriptionCommand = z.infer<typeof directorTranscriptionCommandSchema>;
export type DirectorGenerated3DCommand = z.infer<typeof directorGenerated3DCommandSchema>;
export type DirectorReconstructionCommand = z.infer<typeof directorReconstructionCommandSchema>;
export type DirectorStoryboardArtifactCommand = z.infer<typeof directorStoryboardArtifactCommandSchema>;
export type DirectorMacroCommand = z.infer<typeof directorMacroCommandSchema>;
export type DirectorMemoryCommand = z.infer<typeof directorMemoryCommandSchema>;
/**
 * Operations accepted by the browser execution core. Public Agent requests
 * are parsed first so the exact-target boundary can add a missing revision
 * guard. An unguarded project mutation never crosses this second boundary.
 * Evidence reads (capture/shot_package/deliver) may omit expected_revision;
 * the executor self-binds them to the project revision current at capture
 * time and reports it back as project_revision.
 */
export type DirectorWorkbenchExecutableOperation =
  Exclude<DirectorWorkbenchOperation, DirectorWorkbenchMutationOperation> | DirectorWorkbenchGuardedMutationOperation;
export type DirectorProductionWorkbenchOperation = Extract<DirectorWorkbenchOperation, { op: "production" }>;
export type DirectorWorkbenchPatch = z.infer<typeof directorWorkbenchPatchSchema>;
export type DirectorAuthorDeliveryProfile = z.infer<typeof directorAuthorDeliveryProfileSchema>;
export type DirectorAuthorEvidenceProfile = z.infer<typeof directorAuthorEvidenceProfileSchema>;
export type DirectorObjectSpatialQuery = z.infer<typeof directorObjectSpatialQuerySchema>;
export type DirectorAuditIssueInput = z.infer<typeof directorAuditIssueInputSchema>;
export type DirectorAuditSuggestedFix = z.infer<typeof directorAuditSuggestedFixSchema>;
export type DirectorWorkbenchObserveField = z.infer<typeof directorWorkbenchObserveFieldSchema>;

export const directorWorkbenchOperationNames = directorWorkbenchOperationSchema.options.map(
  (option) => option.shape.op.value,
);

function fnv1a32(serialized: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Structural fingerprint of the agent-facing workbench contract. A browser tab
 * announces it on hello; the gateway rejects mutations toward tabs whose
 * bundle predates the current contract, instead of letting an older schema
 * silently drop fields it does not know.
 */
export const DIRECTOR_WORKBENCH_CONTRACT_FINGERPRINT = (() => {
  try {
    return fnv1a32(
      JSON.stringify(
        z.toJSONSchema(directorWorkbenchOperationSchema, {
          unrepresentable: "any",
          cycles: "ref",
          reused: "inline",
          io: "input",
        }),
      ),
    );
  } catch {
    // A schema that cannot serialize still fingerprints by its operation list.
    return fnv1a32(directorWorkbenchOperationNames.join(","));
  }
})();

const QUERY_OBJECT_SPATIAL_MODES = new Set(["frustum", "aabb", "radius", "nearby"]);

function liftQueryObjectsAliases(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.op !== "query_objects") return input;
  const next = { ...record };
  const filter = record.filter;
  if (filter && typeof filter === "object" && !Array.isArray(filter)) {
    const lifted = filter as Record<string, unknown>;
    delete next.filter;
    if (next.name_pattern == null && typeof lifted.name_pattern === "string") {
      next.name_pattern = lifted.name_pattern;
    }
    if (next.kind == null && typeof lifted.kind === "string") {
      next.kind = lifted.kind;
    }
  }

  if (next.max_results == null) {
    if (typeof next.max_objects === "number") next.max_results = next.max_objects;
    else if (typeof next.limit === "number") next.max_results = next.limit;
  }
  delete next.max_objects;
  delete next.limit;

  const spatial = asRecord(next.spatial);
  if (spatial && typeof spatial.mode !== "string") {
    for (const mode of QUERY_OBJECT_SPATIAL_MODES) {
      const nested = asRecord(spatial[mode]);
      if (!nested) continue;
      next.spatial = { mode, ...nested };
      break;
    }
  }

  const mode = typeof next.mode === "string" ? next.mode : null;
  if (!next.spatial && mode && QUERY_OBJECT_SPATIAL_MODES.has(mode)) {
    if (mode === "frustum") {
      next.spatial = {
        mode,
        ...(typeof next.camera_id === "string" ? { camera_id: next.camera_id } : {}),
      };
    } else if (mode === "aabb" && Array.isArray(next.min) && Array.isArray(next.max)) {
      next.spatial = { mode, min: next.min, max: next.max };
    } else if (mode === "radius" && Array.isArray(next.center) && typeof next.radius === "number") {
      next.spatial = { mode, center: next.center, radius_m: next.radius };
    } else if (mode === "nearby" && typeof next.object_id === "string" && typeof next.radius === "number") {
      next.spatial = { mode, object_id: next.object_id, radius_m: next.radius };
    }
  } else if (!next.spatial && !mode && typeof next.camera_id === "string") {
    next.spatial = { mode: "frustum", camera_id: next.camera_id };
  }

  if (mode === "name" && next.name_pattern != null) delete next.mode;
  if (next.spatial) {
    delete next.mode;
    delete next.camera_id;
    delete next.min;
    delete next.max;
    delete next.center;
    delete next.radius;
    delete next.object_id;
  }
  return next;
}

const CATALOG_ID_ALIASES = ["target", "catalog_type", "source", "collection"] as const;

function liftCatalogAliases(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.op !== "catalog") return input;
  const next = { ...record };
  const canonical = directorWorkbenchCatalogIdSchema.safeParse(next.catalog);
  if (canonical.success) {
    for (const alias of CATALOG_ID_ALIASES) {
      if (next[alias] === canonical.data) delete next[alias];
    }
    return next;
  }
  for (const alias of CATALOG_ID_ALIASES) {
    const parsed = directorWorkbenchCatalogIdSchema.safeParse(next[alias]);
    if (!parsed.success) continue;
    next.catalog = parsed.data;
    delete next[alias];
    return next;
  }
  if (next.catalog == null && CATALOG_ID_ALIASES.every((alias) => next[alias] == null)) {
    next.catalog = "assets";
  }
  return next;
}

const INSPECT_ID_ALIASES = [
  ["object_id", "object"],
  ["camera_id", "camera"],
  ["light_id", "light"],
  ["asset_id", "asset"],
] as const;

function liftInspectAliases(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.op !== "inspect") return input;
  const next = { ...record };
  for (const [alias, entity] of INSPECT_ID_ALIASES) {
    const value = next[alias];
    delete next[alias];
    if (typeof value !== "string" || !value.trim()) continue;
    if (next.id == null) next.id = value;
    if (next.entity == null) next.entity = entity;
  }
  return next;
}

/** Common author-action names agents send instead of the canonical delete_* actions. */
export const DIRECTOR_AUTHORING_ACTION_ALIASES: Record<string, string> = {
  remove_object: "delete_objects",
  remove_objects: "delete_objects",
  delete_object: "delete_objects",
  remove_light: "delete_lights",
  remove_lights: "delete_lights",
  delete_light: "delete_lights",
  remove_camera: "delete_cameras",
  remove_cameras: "delete_cameras",
  delete_camera: "delete_cameras",
};

const DELETE_ID_FIELDS: Record<string, { canonical: string; aliases: string[] }> = {
  delete_objects: { canonical: "object_ids", aliases: ["ids", "object_id", "id"] },
  delete_lights: { canonical: "light_ids", aliases: ["ids", "light_id", "id"] },
  delete_cameras: { canonical: "camera_ids", aliases: ["ids", "camera_id", "id"] },
};

function asUniqueIdList(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const ids = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim()),
    ),
  ];
  return ids.length ? ids : undefined;
}

function liftDeleteIds(next: Record<string, unknown>, canonical: string, aliases: string[]): void {
  const fromCanonical = asUniqueIdList(next[canonical]);
  if (fromCanonical) next[canonical] = fromCanonical;
  else {
    for (const alias of aliases) {
      const lifted = asUniqueIdList(next[alias]);
      if (lifted) {
        next[canonical] = lifted;
        break;
      }
    }
  }
  for (const alias of aliases) delete next[alias];
}

export function normalizeDirectorWorkbenchInput(input: unknown): unknown {
  return liftWorldAuthoringAliases(liftInspectAliases(liftCatalogAliases(liftQueryObjectsAliases(input))));
}

function liftWorldAuthoringAliases(input: unknown): unknown {
  const record = asRecord(input);
  if (record?.op !== "author" || !Array.isArray(record.actions)) return input;
  return {
    ...record,
    actions: record.actions.map((action) => {
      const item = asRecord(action);
      if (!item) return action;
      const next = { ...item };
      if (typeof next.action === "string") {
        next.action = DIRECTOR_AUTHORING_ACTION_ALIASES[next.action] ?? next.action;
      }
      if (typeof next.action === "string" && next.action in DELETE_ID_FIELDS) {
        const fields = DELETE_ID_FIELDS[next.action];
        liftDeleteIds(next, fields.canonical, fields.aliases);
      }
      if (next.action === "update_world_water_body") {
        if (next.body_id == null && typeof next.water_body_id === "string") next.body_id = next.water_body_id;
        delete next.water_body_id;
      }
      if (next.action === "remove_world_water_bodies") {
        if (next.body_ids == null && Array.isArray(next.water_body_ids)) next.body_ids = next.water_body_ids;
        delete next.water_body_ids;
      }
      if (next.action === "update_world_wildlife_group") {
        if (next.group_id == null && typeof next.wildlife_group_id === "string") next.group_id = next.wildlife_group_id;
        delete next.wildlife_group_id;
      }
      if (next.action === "remove_world_wildlife_groups") {
        if (next.group_ids == null && Array.isArray(next.wildlife_group_ids)) next.group_ids = next.wildlife_group_ids;
        delete next.wildlife_group_ids;
      }
      return next;
    }),
  };
}

function queryObjectsFieldMessage(input: unknown, issue: { code: string; path: PropertyKey[] }): string | null {
  const operation = asRecord(input);
  if (operation?.op !== "query_objects") return null;
  const hasSelector =
    operation.spatial != null ||
    (typeof operation.name_pattern === "string" && operation.name_pattern.trim().length > 0) ||
    (typeof operation.kind === "string" && operation.kind.trim().length > 0);
  if (!hasSelector) return QUERY_OBJECTS_SHAPE_HINT;
  if (
    issue.path[0] === "spatial" &&
    (issue.code === "invalid_type" ||
      issue.code === "invalid_union" ||
      issue.code === "invalid_union_discriminator" ||
      issue.code === "invalid_value")
  ) {
    return 'spatial must be {mode:"frustum"|"aabb"|"radius"|"nearby"}. You may also use only name_pattern or kind, for example {"op":"query_objects","name_pattern":"door"}';
  }
  return null;
}

function inspectFieldMessage(input: unknown): string | null {
  return asRecord(input)?.op === "inspect" ? INSPECT_SHAPE_HINT : null;
}

function diffFieldMessage(input: unknown): string | null {
  return asRecord(input)?.op === "diff" ? DIFF_SHAPE_HINT : null;
}

function missingAuthoringFieldMessage(input: unknown, path: PropertyKey[]) {
  if (path.length !== 3 || path[0] !== "actions" || typeof path[1] !== "number" || typeof path[2] !== "string")
    return null;
  const operation = asRecord(input);
  const actions = Array.isArray(operation?.actions) ? operation.actions : [];
  const action = asRecord(actions[path[1]]);
  const field = path[2];
  if (action && Object.prototype.hasOwnProperty.call(action, field)) return null;
  if (action?.action === "set_scene" && field === "patch") {
    return `actions.${path[1]}.patch is missing; set_scene must include at least one global scene field. If you are not changing background, ground, scene transform, or timeline, delete this set_scene action.`;
  }
  if (action?.action === "update_object" && field === "patch") {
    return `actions.${path[1]}.patch is missing; update_object must name the object fields to update.`;
  }
  if (action?.action === "update_camera" && field === "patch") {
    return `actions.${path[1]}.patch is missing; update_camera must name the camera fields to update.`;
  }
  if (action?.action === "delete_objects" && field === "object_ids") {
    return `actions.${path[1]}.object_ids is missing; delete_objects requires object_ids (remove_object with id is also accepted).`;
  }
  if (action?.action === "delete_lights" && field === "light_ids") {
    return `actions.${path[1]}.light_ids is missing; delete_lights requires light_ids (remove_light with id is also accepted).`;
  }
  if (action?.action === "delete_cameras" && field === "camera_ids") {
    return `actions.${path[1]}.camera_ids is missing; delete_cameras requires camera_ids (remove_camera with id is also accepted).`;
  }
  if (action?.action === "remove_world_water_bodies" && field === "body_ids") {
    return `actions.${path[1]}.body_ids is missing; remove_world_water_bodies requires body_ids (water_body_ids is also accepted).`;
  }
  if (action?.action === "update_world_water_body" && field === "body_id") {
    return `actions.${path[1]}.body_id is missing; update_world_water_body requires body_id (water_body_id is also accepted).`;
  }
  if (action?.action === "update_object" && field === "object_id") {
    return `actions.${path[1]}.object_id is missing; update_object must specify an existing object ID or one created in the same batch.`;
  }
  if (action?.action === "update_camera" && field === "camera_id") {
    return `actions.${path[1]}.camera_id is missing; update_camera must specify an existing camera ID or one created in the same batch.`;
  }
  if (
    action?.action === "set_animation" &&
    (field === "target_id" || field === "target_type" || field === "animation")
  ) {
    return `actions.${path[1]}.${field} is missing; set_animation requires target_type, target_id, and animation together.`;
  }
  if (typeof action?.action === "string") {
    return `actions.${path[1]}.${field} is missing; ${action.action} requires this field.`;
  }
  return null;
}

export const BLENDER_NATIVE_APPLY_HINT =
  'Native Blender modeling uses blender_native, not director_workbench. Call blender_native {"op":"apply","operations":[{"op":"create_blockout","preset":"room","idPrefix":"shell","width":12,"depth":8,"height":4}]} for architecture shells (presets floor/wall/room/corridor/stairs, metres), create_opening for doors/windows, or create_primitive for one volume. Stage instances catalog, project, or generated meshes with author.add_object; it rejects geometry_type assembly. Describe typed Blender ops with blender_native {"op":"describe","target":"create_blockout"}; describe RNA with blender_native {"op":"describe","operator":"mesh.bevel"}.';

export const STAGE_PRIMITIVE_ASSEMBLY_ERROR =
  "director_workbench does not allow assembling a scene from Stage primitives (box/sphere/cylinder/cone/pyramid/torus). Instance catalog assets, model with blender_native (edits sync back to this project), or generate with generated_3d then place. For white-box architecture use blender_native apply create_blockout (presets floor/wall/room/corridor/stairs, metric metres, wallThickness) and cut doors/windows with create_opening; do not fake openings with darker boxes.";

function valueUsesStagePrimitiveGeometry(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(valueUsesStagePrimitiveGeometry);
  const candidate = asRecord(value);
  if (!candidate) return false;
  if (typeof candidate.geometry_type === "string" || typeof candidate.geometryType === "string") return true;
  return Object.values(candidate).some(valueUsesStagePrimitiveGeometry);
}

function stagePrimitiveAssemblyMessage(operation: DirectorWorkbenchOperation): string | null {
  if (operation.op === "author") {
    for (const [index, action] of operation.actions.entries()) {
      if (action.action === "add_object" && action.geometry_type) {
        return `director_workbench input invalid: actions.${index}.geometry_type. ${STAGE_PRIMITIVE_ASSEMBLY_ERROR}`;
      }
      if (
        (action.action === "update_object" || action.action === "batch_update_objects") &&
        typeof action.patch.geometry_type === "string"
      ) {
        return `director_workbench input invalid: actions.${index}.patch.geometry_type. ${STAGE_PRIMITIVE_ASSEMBLY_ERROR}`;
      }
    }
    return null;
  }
  if (operation.op === "replace_project" && valueUsesStagePrimitiveGeometry(operation.project)) {
    return `director_workbench input invalid: project. ${STAGE_PRIMITIVE_ASSEMBLY_ERROR}`;
  }
  if (
    operation.op === "patch" &&
    operation.patches.some(
      (patch) => patch.op !== "remove" && "value" in patch && valueUsesStagePrimitiveGeometry(patch.value),
    )
  ) {
    return `director_workbench input invalid: patches. ${STAGE_PRIMITIVE_ASSEMBLY_ERROR}`;
  }
  return null;
}

const blenderAgentOperationNameSet = new Set<string>(blenderAgentOperationNames);

function blenderNativeMisrouteMessage(input: unknown): string | null {
  const op = asRecord(input)?.op;
  if (typeof op !== "string") return null;
  if (op === "apply" || blenderAgentOperationNameSet.has(op)) {
    return `director_workbench has no "${op}" operation. ${BLENDER_NATIVE_APPLY_HINT}`;
  }
  return null;
}

function unknownAuthoringActionMessage(input: unknown, issue: { code: string; path: PropertyKey[] }): string | null {
  if (issue.path[0] !== "actions" || typeof issue.path[1] !== "number" || issue.path[2] !== "action") {
    return null;
  }
  const operation = asRecord(input);
  const actions = Array.isArray(operation?.actions) ? operation.actions : [];
  const name = asRecord(actions[issue.path[1]])?.action;
  if (typeof name !== "string") return null;
  const aliased = DIRECTOR_AUTHORING_ACTION_ALIASES[name];
  if (aliased) {
    return `actions.${issue.path[1]}.action "${name}" is accepted as ${aliased}. Use object_ids, light_ids, or camera_ids.`;
  }
  return `actions.${issue.path[1]}.action "${name}" is not a valid author action. Deletion uses delete_objects with object_ids (remove_object + id is also accepted). List actions with {"op":"describe","target":"author"}.`;
}

export function parseDirectorWorkbenchInput(
  input: unknown,
): { success: true; operation: DirectorWorkbenchOperation } | { success: false; error: string } {
  const normalized = normalizeDirectorWorkbenchInput(input);
  const misrouted = blenderNativeMisrouteMessage(normalized);
  if (misrouted) return { success: false, error: misrouted };
  const result = directorWorkbenchOperationSchema.safeParse(normalized);
  if (result.success) {
    const assembly = stagePrimitiveAssemblyMessage(result.data);
    if (assembly) return { success: false, error: assembly };
    return { success: true, operation: result.data };
  }
  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "input";
  const missingField = issue ? missingAuthoringFieldMessage(normalized, issue.path) : null;
  if (missingField) return { success: false, error: `director_workbench input invalid: ${missingField}` };
  const queryObjectsHint = issue ? queryObjectsFieldMessage(normalized, issue) : null;
  if (queryObjectsHint) return { success: false, error: `director_workbench input invalid: ${queryObjectsHint}` };
  const inspectHint = inspectFieldMessage(normalized);
  if (inspectHint) return { success: false, error: `director_workbench input invalid: ${inspectHint}` };
  const diffHint = diffFieldMessage(normalized);
  if (diffHint) return { success: false, error: `director_workbench input invalid: ${diffHint}` };
  const unknownAction = issue ? unknownAuthoringActionMessage(normalized, issue) : null;
  if (unknownAction) return { success: false, error: `director_workbench input invalid: ${unknownAction}` };
  if (issue?.code === "unrecognized_keys") {
    const keys = issue.keys.map((key) => `"${key}"`).join(", ");
    const suffix = asRecord(normalized)?.op === "query_objects" ? `. ${QUERY_OBJECTS_SHAPE_HINT}` : "";
    return {
      success: false,
      error: `director_workbench input invalid: ${path} contains unsupported fields ${keys}. Remove them and retry${suffix}`,
    };
  }
  const explanation =
    issue?.code === "invalid_type" ? "incorrect type or missing required field" : (issue?.message ?? "malformed input");
  return { success: false, error: `director_workbench input invalid: ${path} ${explanation}` };
}

export function parseDirectorWorkbenchExecutableInput(
  input: unknown,
): { success: true; operation: DirectorWorkbenchExecutableOperation } | { success: false; error: string } {
  const parsed = parseDirectorWorkbenchInput(input);
  if (!parsed.success) return parsed;
  const operation = parsed.operation;
  if (
    (operation.op === "patch" ||
      operation.op === "author" ||
      operation.op === "run_macro" ||
      operation.op === "correct" ||
      operation.op === "replace_project" ||
      operation.op === "undo") &&
    !operation.expected_revision &&
    !operation.unconditional
  ) {
    return {
      success: false,
      error:
        "director_workbench execution requires expected_revision. Public Agent callers may omit it because the exact-target boundary injects it before dispatch.",
    };
  }
  if (
    operation.op === "generated_3d" &&
    operation.command.action === "promote" &&
    (!operation.command.expected_revision || !operation.command.idempotency_key)
  ) {
    return {
      success: false,
      error:
        "generated_3d promotion requires expected_revision and idempotency_key at the browser execution boundary. Public Agent callers may omit them because the exact-target boundary injects both before dispatch.",
    };
  }
  if (
    operation.op === "reconstruction" &&
    operation.command.action === "apply" &&
    (!operation.command.expected_revision || !operation.command.idempotency_key)
  ) {
    return {
      success: false,
      error:
        "reconstruction apply requires expected_revision and idempotency_key at the browser execution boundary. Public Agent callers may omit them because the exact-target boundary injects both before dispatch.",
    };
  }
  if (
    operation.op === "storyboard_artifact" &&
    (!operation.command.expected_revision || !operation.command.idempotency_key)
  ) {
    return {
      success: false,
      error:
        "storyboard_artifact execution requires expected_revision and idempotency_key at the browser execution boundary. Public Agent callers may omit them because the exact-target boundary injects both before dispatch.",
    };
  }
  if (
    operation.op === "production" &&
    operation.command.action !== "observe" &&
    (operation.command.expected_revision === undefined || !operation.command.idempotency_key)
  ) {
    return {
      success: false,
      error:
        "production mutation execution requires expected_revision and idempotency_key at the browser execution boundary. Public Agent callers may omit them because the exact-target boundary injects both before dispatch.",
    };
  }
  if (
    (operation.op === "generation" ||
      operation.op === "transcription" ||
      operation.op === "generated_3d" ||
      operation.op === "reconstruction") &&
    (operation.command.action === "submit" || operation.command.action === "retry") &&
    !operation.command.idempotency_key
  ) {
    return {
      success: false,
      error:
        "durable job submit/retry requires idempotency_key at the browser execution boundary. Public Agent callers may omit it because the exact-target boundary injects one before dispatch.",
    };
  }
  return { success: true, operation: operation as DirectorWorkbenchExecutableOperation };
}
