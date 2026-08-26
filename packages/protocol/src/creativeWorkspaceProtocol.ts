import { z } from "zod";
import { comfyGenerationParametersSchema } from "./comfyGenerationProtocol";
import { strictAction, strictOperation, strictSuccess, strictSuccessAction, strictType } from "./strictProtocolVariant";

const MAX_TEXT_LENGTH = 4_000;
const MAX_NAME_LENGTH = 200;
const MAX_ID_LENGTH = 240;
const MAX_COORDINATE = 1_000_000;
const MAX_CLIP_DURATION_SEC = 60 * 60;

/** Minimum allowed clip playback rate in the Video Editor. */
export const CREATIVE_WORKSPACE_MIN_CLIP_PLAYBACK_RATE = 0.25;
/** Maximum allowed clip playback rate in the Video Editor. */
export const CREATIVE_WORKSPACE_MAX_CLIP_PLAYBACK_RATE = 4;

const MAX_TIMELINE_SEC = 24 * 60 * 60;
const MAX_CLIP_POSITION_PX = 7_680;
const MAX_CLIP_ROTATION_DEG = 3_600;
const MAX_INTERCHANGE_OBJECT_IDS = 2_048;

/**
 * Transport-only contract for the Canvas and Video Editor agent surface.
 *
 * Keep this module free of browser stores, React, DOM and Node APIs so the
 * gateway, MCP server and browser can validate exactly the same payloads
 * without pulling an editor runtime across the frontend/backend boundary.
 */

/** Validates a workspace-scoped identifier: 1–240 trimmed characters. */
export const creativeWorkspaceIdSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
const nameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);
/** Any finite number, used as a base for bounded numeric schemas. */
export const creativeWorkspaceFiniteNumberSchema = z.number().finite();
const boundedNumber = (minimum: number, maximum: number) =>
  creativeWorkspaceFiniteNumberSchema.min(minimum).max(maximum);
const coordinateSchema = boundedNumber(-MAX_COORDINATE, MAX_COORDINATE);

/** The kind of a Canvas node: shot, image, video, audio, note, or frame. */
export const creativeWorkspaceNodeKindSchema = z.enum(["shot", "image", "video", "audio", "note", "frame"]);

/** The active workspace mode: canvas, stage, or video. The legacy "gallery" value is remapped to "stage". */
export const creativeWorkspaceModeSchema = z.preprocess(
  (value) => (value === "gallery" ? "stage" : value),
  z.enum(["canvas", "stage", "video"]),
);

/** The kind of a Video Editor track: video or audio. */
export const creativeWorkspaceTrackKindSchema = z.enum(["video", "audio"]);

/** How a video clip is fitted to the frame: contain or cover. */
export const creativeWorkspaceFitSchema = z.enum(["contain", "cover"]);

/** Supported aspect ratios for the Video Editor export. */
export const creativeWorkspaceEditAspectRatioSchema = z.enum(["16 / 9", "9 / 16", "1 / 1"]);

/** Export quality preset: preview (fast) or full (production). */
export const creativeWorkspaceEditExportQualitySchema = z.enum(["preview", "full"]);

/** Playback preference for a media item: auto, original, or proxy. */
export const creativeWorkspaceMediaPlaybackPreferenceSchema = z.enum(["auto", "original", "proxy"]);

/** A fingerprint string identifying a snapshot of workspace state, used for optimistic concurrency. */
export const creativeWorkspaceSnapshotFingerprintSchema = z.string().trim().min(1).max(240);

/** Scope of an audit operation: all, canvas, or video. */
export const creativeWorkspaceAuditScopeSchema = z.enum(["all", "canvas", "video"]);

/** Quality profile for audit and production: draft or production. */
export const creativeWorkspaceQualityProfileSchema = z.enum(["draft", "production"]);

/** Payload encoding for interchange exports: utf8 or base64. */
export const creativeWorkspacePayloadEncodingSchema = z.enum(["utf8", "base64"]);

/** The status of a review comment: open or resolved. */
export const creativeWorkspaceReviewStatusSchema = z.enum(["open", "resolved"]);

/** Which workspace to target for a preview operation: auto, canvas, or video. */
export const creativeWorkspacePreviewWorkspaceSchema = z.enum(["auto", "canvas", "video"]);

const batchStepIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const batchReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** Supported interchange formats for export and import. */
export const creativeWorkspaceInterchangeFormatSchema = z.enum([
  "otio",
  "otioz",
  "fountain",
  "gltf",
  "glb",
  "usd",
  "usdz",
  "obj",
  "stl",
]);

/** The workspace that an interchange operation targets: stage or video. */
export const creativeWorkspaceInterchangeWorkspaceSchema = z.enum(["stage", "video"]);

const creativeWorkspaceInterchangeObjectIdsSchema = z
  .array(creativeWorkspaceIdSchema)
  .min(1)
  .max(MAX_INTERCHANGE_OBJECT_IDS)
  .refine((ids) => new Set(ids).size === ids.length, "object_ids must be unique");

/** A semantic guard binding a workspace state fingerprint to a specific kind of operation. */
export const creativeWorkspaceSemanticGuardSchema = z.strictObject({
  kind: z.enum(["stage_project_revision", "creative_snapshot", "collaboration_state"]),
  fingerprint: z.string().trim().min(16).max(240),
});

/** Actions available in the interchange surface: capabilities, export, and import. */
export const creativeWorkspaceInterchangeActionSchema = z.discriminatedUnion("action", [
  strictAction("capabilities", {}),
  strictAction("plan-export", {
    format: creativeWorkspaceInterchangeFormatSchema,
    workspace: creativeWorkspaceInterchangeWorkspaceSchema,
    file_name: z.string().trim().min(1).max(240).optional(),
    object_ids: creativeWorkspaceInterchangeObjectIdsSchema.optional(),
    max_inline_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(8 * 1024 * 1024)
      .default(4 * 1024 * 1024),
  }),
  strictAction("export", {
    plan_id: z.string().regex(/^interchange-plan:v1:[0-9a-f-]{36}$/),
    expected_guard_fingerprint: z.string().trim().min(16).max(240),
  }),
  strictAction("plan-import", {
    format: creativeWorkspaceInterchangeFormatSchema,
    workspace: creativeWorkspaceInterchangeWorkspaceSchema,
    source: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("inline"),
        encoding: creativeWorkspacePayloadEncodingSchema,
        payload: z.string().min(1).max(11_200_000),
        file_name: z.string().trim().min(1).max(240).optional(),
      }),
      z.strictObject({
        kind: z.literal("media_id"),
        media_id: creativeWorkspaceIdSchema,
      }),
      z.strictObject({
        kind: z.literal("workspace_path"),
        path: z.string().trim().min(1).max(1_000),
      }),
    ]),
    max_inline_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(8 * 1024 * 1024)
      .default(4 * 1024 * 1024),
  }),
  strictAction("import", {
    plan_id: z.string().regex(/^interchange-plan:v1:[0-9a-f-]{36}$/),
    expected_guard_fingerprint: z.string().trim().min(16).max(240),
    confirm: z.literal(true),
  }),
]);

/**
 * An anchor for a review comment: a scene, an object within a scene, or a
 * point in time on a track.
 */
export const creativeWorkspaceReviewAnchorSchema = z.discriminatedUnion("type", [
  strictType("scene", { scene_id: creativeWorkspaceIdSchema }),
  strictType("object", {
    scene_id: creativeWorkspaceIdSchema,
    object_id: creativeWorkspaceIdSchema,
  }),
  strictType("time", {
    scene_id: creativeWorkspaceIdSchema,
    frame: z.number().int().min(-1_000_000).max(1_000_000),
    track_id: creativeWorkspaceIdSchema.optional(),
  }),
]);

const collaborationWriteGuardFields = {
  expected_collaboration_fingerprint: creativeWorkspaceSnapshotFingerprintSchema.optional(),
  idempotency_key: idempotencyKeySchema.optional(),
};

/** Actions available in the collaboration surface: observe, comments, versions, and compare. */
export const creativeWorkspaceCollaborationActionSchema = z.discriminatedUnion("action", [
  strictAction("observe", {}),
  strictAction("list-comments", {
    status: creativeWorkspaceReviewStatusSchema.optional(),
    anchor: creativeWorkspaceReviewAnchorSchema.optional(),
  }),
  strictAction("add-comment", {
    anchor: creativeWorkspaceReviewAnchorSchema,
    body: z.string().trim().min(1).max(8_000),
    ...collaborationWriteGuardFields,
  }),
  strictAction("resolve-comment", {
    comment_id: creativeWorkspaceIdSchema,
    ...collaborationWriteGuardFields,
  }),
  strictAction("reopen-comment", {
    comment_id: creativeWorkspaceIdSchema,
    ...collaborationWriteGuardFields,
  }),
  strictAction("update-comment", {
    comment_id: creativeWorkspaceIdSchema,
    body: z.string().trim().min(1).max(8_000),
    ...collaborationWriteGuardFields,
  }),
  strictAction("delete-comment", {
    comment_id: creativeWorkspaceIdSchema,
    confirm: z.literal(true),
    ...collaborationWriteGuardFields,
  }),
  strictAction("list-versions", {}),
  strictAction("compare", {
    before_version_id: creativeWorkspaceIdSchema,
    after_version_id: creativeWorkspaceIdSchema.optional(),
  }),
  strictAction("create-version", {
    name: z.string().trim().min(1).max(240),
    ...collaborationWriteGuardFields,
  }),
  strictAction("restore-version", {
    version_id: creativeWorkspaceIdSchema,
    confirm: z.literal(true),
    ...collaborationWriteGuardFields,
  }),
  strictAction("delete-version", {
    version_id: creativeWorkspaceIdSchema,
    confirm: z.literal(true),
    ...collaborationWriteGuardFields,
  }),
]);

/** Actions available in the Canvas pipeline surface: capabilities, start, status, and cancel. */
export const creativeWorkspacePipelineActionSchema = z.discriminatedUnion("action", [
  strictAction("capabilities", {}),
  strictAction("start", {
    target_node_ids: z
      .array(creativeWorkspaceIdSchema)
      .max(240)
      .refine((values) => new Set(values).size === values.length, "target_node_ids must be unique")
      .default([]),
    force_node_ids: z
      .array(creativeWorkspaceIdSchema)
      .max(240)
      .refine((values) => new Set(values).size === values.length, "force_node_ids must be unique")
      .default([]),
    max_parallel: z.number().int().min(1).max(16).default(4),
    await_completion: z.boolean().default(false),
    expected_snapshot_fingerprint: creativeWorkspaceSnapshotFingerprintSchema.optional(),
    idempotency_key: idempotencyKeySchema.optional(),
  }),
  strictAction("status", { run_id: creativeWorkspaceIdSchema.optional() }),
  strictAction("cancel", { run_id: creativeWorkspaceIdSchema }),
]);

/** Request envelope for interchange operations. */
export const creativeWorkspaceInterchangeRequestSchema = strictOperation("interchange", {
  request: creativeWorkspaceInterchangeActionSchema,
});

/** Request envelope for collaboration operations. */
export const creativeWorkspaceCollaborationRequestSchema = strictOperation("collaboration", {
  request: creativeWorkspaceCollaborationActionSchema,
});

/** Request envelope for pipeline operations. */
export const creativeWorkspacePipelineRequestSchema = strictOperation("pipeline", {
  request: creativeWorkspacePipelineActionSchema,
});

function hasDefinedProperty(value: Record<string, unknown>): boolean {
  return Object.values(value).some((entry) => entry !== undefined);
}

/** Canvas board section / lane kind (workflow stage grouping). */
export const creativeWorkspaceBoardSectionKindSchema = z.enum(["character", "scene", "generation", "final", "custom"]);

const canvasNodePatchFields = {
  kind: creativeWorkspaceNodeKindSchema.optional(),
  title: nameSchema.optional(),
  body: z.string().max(MAX_TEXT_LENGTH).optional(),
  media_id: creativeWorkspaceIdSchema.nullable().optional(),
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
  width: boundedNumber(180, 1_200).optional(),
  height: boundedNumber(120, 900).optional(),
  accent: z.string().trim().min(1).max(80).optional(),
};

/** A partial update to a Canvas node; at least one field must be present. */
export const creativeWorkspaceCanvasNodePatchSchema = z
  .strictObject(canvasNodePatchFields)
  .refine(hasDefinedProperty, "patch must contain at least one field");

const editClipPatchFields = {
  media_id: creativeWorkspaceIdSchema.optional(),
  name: nameSchema.optional(),
  start_sec: boundedNumber(0, MAX_CLIP_DURATION_SEC).optional(),
  duration_sec: boundedNumber(0.1, MAX_CLIP_DURATION_SEC).optional(),
  in_sec: boundedNumber(0, MAX_CLIP_DURATION_SEC).optional(),
  source_duration_sec: boundedNumber(0.1, MAX_CLIP_DURATION_SEC).optional(),
  playback_rate: boundedNumber(
    CREATIVE_WORKSPACE_MIN_CLIP_PLAYBACK_RATE,
    CREATIVE_WORKSPACE_MAX_CLIP_PLAYBACK_RATE,
  ).optional(),
  opacity: boundedNumber(0, 1).optional(),
  volume: boundedNumber(0, 1).optional(),
  fade_in_sec: boundedNumber(0, MAX_CLIP_DURATION_SEC).optional(),
  fade_out_sec: boundedNumber(0, MAX_CLIP_DURATION_SEC).optional(),
  scale: boundedNumber(0.05, 20).optional(),
  position_x: boundedNumber(-MAX_CLIP_POSITION_PX, MAX_CLIP_POSITION_PX).optional(),
  position_y: boundedNumber(-MAX_CLIP_POSITION_PX, MAX_CLIP_POSITION_PX).optional(),
  rotation_deg: boundedNumber(-MAX_CLIP_ROTATION_DEG, MAX_CLIP_ROTATION_DEG).optional(),
  fit: creativeWorkspaceFitSchema.optional(),
  // Cross-dissolve duration into this clip from its same-track predecessor.
  // Values above 0 require an adjacent predecessor clip at execution time.
  transition_in_sec: boundedNumber(0, MAX_CLIP_DURATION_SEC).optional(),
};
const editClipAddOptionalFields = {
  source_duration_sec: editClipPatchFields.source_duration_sec,
  in_sec: editClipPatchFields.in_sec,
  playback_rate: editClipPatchFields.playback_rate,
  opacity: editClipPatchFields.opacity,
  volume: editClipPatchFields.volume,
  fade_in_sec: editClipPatchFields.fade_in_sec,
  fade_out_sec: editClipPatchFields.fade_out_sec,
  scale: editClipPatchFields.scale,
  position_x: editClipPatchFields.position_x,
  position_y: editClipPatchFields.position_y,
  rotation_deg: editClipPatchFields.rotation_deg,
  fit: editClipPatchFields.fit,
  /**
   * When true, after the clip is added the same overwrite-with-trim resolver
   * the Video Editor UI uses (`resolveDirectorTrackOverwrite`) runs on the
   * landed clip: overlapping neighbours are truncated, head-trimmed, split,
   * or removed. Omitted/false keeps today's non-destructive queue placement.
   */
  overwrite: z.boolean().optional(),
};

/** A partial update to a Video Editor clip; at least one field must be present. */
export const creativeWorkspaceEditClipPatchSchema = z
  .strictObject(editClipPatchFields)
  .refine(hasDefinedProperty, "patch must contain at least one field");

const editTrackPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    muted: z.boolean().optional(),
    locked: z.boolean().optional(),
    visible: z.boolean().optional(),
  })
  .refine(hasDefinedProperty, "patch must contain at least one field");

const canvasNodeAddSchema = strictOperation("canvas.node.add", {
  ...canvasNodePatchFields,
  kind: creativeWorkspaceNodeKindSchema,
  title: nameSchema,
  x: coordinateSchema,
  y: coordinateSchema,
});

const canvasNodeUpdateSchema = strictOperation("canvas.node.update", {
  node_id: creativeWorkspaceIdSchema,
  patch: creativeWorkspaceCanvasNodePatchSchema,
});

const canvasNodeRemoveSchema = strictOperation("canvas.node.remove", { node_id: creativeWorkspaceIdSchema });

/** Raise a Canvas board node to the top of the paint/z-order (array tail). Idempotent when already front. */
const canvasNodeBringToFrontSchema = strictOperation("canvas.node.bring_to_front", {
  node_id: creativeWorkspaceIdSchema,
});

const canvasNodeAssignSectionSchema = strictOperation("canvas.node.assign_section", {
  node_id: creativeWorkspaceIdSchema,
  section_id: creativeWorkspaceIdSchema.nullable(),
});

const canvasSectionAddSchema = strictOperation("canvas.section.add", {
  kind: creativeWorkspaceBoardSectionKindSchema.optional(),
  title: nameSchema.optional(),
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
  width: boundedNumber(240, 2_400).optional(),
  height: boundedNumber(180, 1_600).optional(),
  accent: z.string().trim().min(1).max(80).optional(),
  collapsed: z.boolean().optional(),
});

const canvasSectionPatchFields = {
  kind: creativeWorkspaceBoardSectionKindSchema.optional(),
  title: nameSchema.optional(),
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
  width: boundedNumber(240, 2_400).optional(),
  height: boundedNumber(180, 1_600).optional(),
  accent: z.string().trim().min(1).max(80).optional(),
  collapsed: z.boolean().optional(),
};

/** A partial update to a Canvas board section; at least one field must be present. */
export const creativeWorkspaceCanvasSectionPatchSchema = z
  .strictObject(canvasSectionPatchFields)
  .refine(hasDefinedProperty, "patch must contain at least one field");

const canvasSectionUpdateSchema = strictOperation("canvas.section.update", {
  section_id: creativeWorkspaceIdSchema,
  patch: creativeWorkspaceCanvasSectionPatchSchema,
});

const canvasSectionRemoveSchema = strictOperation("canvas.section.remove", {
  section_id: creativeWorkspaceIdSchema,
});

const canvasEdgeAddSchema = strictOperation("canvas.edge.add", {
  source_node_id: creativeWorkspaceIdSchema,
  target_node_id: creativeWorkspaceIdSchema,
}).refine((value) => value.source_node_id !== value.target_node_id, {
  message: "source_node_id and target_node_id must be different",
  path: ["target_node_id"],
});

const canvasEdgeRemoveSchema = strictOperation("canvas.edge.remove", { edge_id: creativeWorkspaceIdSchema });

const canvasDagLayoutSchema = strictOperation("canvas.dag.layout", {
  direction: z.enum(["horizontal", "vertical"]).optional(),
  origin_x: coordinateSchema.optional(),
  origin_y: coordinateSchema.optional(),
  layer_gap: boundedNumber(40, 1_200).optional(),
  node_gap: boundedNumber(20, 800).optional(),
});

/** A partial update to a Canvas production node's configuration; at least one field must be present. */
export const creativeWorkspaceCanvasProductionConfigPatchSchema = z
  .strictObject({
    workflow_id: z.string().trim().min(1).max(160).nullable().optional(),
    node_ids: z
      .array(z.string().trim().min(1).max(80))
      .max(32)
      .refine((values) => new Set(values).size === values.length, "node_ids must be unique")
      .optional(),
    negative_prompt: z.string().trim().max(12_000).optional(),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    duration_seconds: z.number().positive().max(600).optional(),
    fps: z.number().positive().max(240).optional(),
    audio_mode: z.enum(["sound-effect", "music", "speech"]).optional(),
    sample_rate: z.number().int().min(8_000).max(192_000).optional(),
    voice: z.string().trim().max(240).optional(),
    language: z.string().trim().max(80).optional(),
    parameters: comfyGenerationParametersSchema.optional(),
  })
  .refine(hasDefinedProperty, "patch must contain at least one field");

const canvasProductionConfigureSchema = strictOperation("canvas.production.configure", {
  node_id: creativeWorkspaceIdSchema,
  patch: creativeWorkspaceCanvasProductionConfigPatchSchema,
});

const editClipAddSchema = strictOperation("edit.clip.add", {
  track_id: creativeWorkspaceIdSchema,
  media_id: creativeWorkspaceIdSchema,
  name: nameSchema,
  start_sec: boundedNumber(0, MAX_TIMELINE_SEC),
  duration_sec: boundedNumber(0.1, MAX_CLIP_DURATION_SEC),
  ...editClipAddOptionalFields,
}).superRefine((value, context) => {
  // The source must be long enough to cover the clip duration at the chosen playback rate.
  if (
    value.source_duration_sec !== undefined &&
    value.source_duration_sec < value.duration_sec * (value.playback_rate ?? 1)
  ) {
    context.addIssue({
      code: "custom",
      path: ["source_duration_sec"],
      message: "source_duration_sec must cover duration_sec at playback_rate",
    });
  }
  // Fade-in plus fade-out cannot exceed the clip's total duration.
  if ((value.fade_in_sec ?? 0) + (value.fade_out_sec ?? 0) > value.duration_sec) {
    context.addIssue({
      code: "custom",
      path: ["fade_out_sec"],
      message: "fade_in_sec plus fade_out_sec cannot exceed duration_sec",
    });
  }
});

const editClipUpdateSchema = strictOperation("edit.clip.update", {
  clip_id: creativeWorkspaceIdSchema,
  patch: creativeWorkspaceEditClipPatchSchema,
  /**
   * When true, after the patch is applied run `resolveDirectorTrackOverwrite`
   * on the updated clip (same as Video Editor keyboard nudges).
   */
  overwrite: z.boolean().optional(),
});

const editClipMoveSchema = strictOperation("edit.clip.move", {
  clip_id: creativeWorkspaceIdSchema,
  track_id: creativeWorkspaceIdSchema,
  start_sec: boundedNumber(0, MAX_TIMELINE_SEC),
  /**
   * When true, after the move run `resolveDirectorTrackOverwrite` on the
   * landed clip (same as Video Editor drop resolution).
   */
  overwrite: z.boolean().optional(),
});

const editClipSplitSchema = strictOperation("edit.clip.split", {
  clip_id: creativeWorkspaceIdSchema,
  at_sec: boundedNumber(0, MAX_TIMELINE_SEC),
});

const editClipRemoveSchema = strictOperation("edit.clip.remove", {
  clip_id: creativeWorkspaceIdSchema,
  // When true, later clips on the same track ripple earlier to close the gap
  // (the Video Editor's ripple delete). Defaults to a plain lift delete.
  ripple: z.boolean().optional(),
});

const rangeTrackIdsSchema = z
  .array(creativeWorkspaceIdSchema)
  .min(1)
  .max(12)
  .refine((ids) => new Set(ids).size === ids.length, "track_ids must be unique");

const editRangeRemoveSchema = strictOperation("edit.range.remove", {
  from_sec: boundedNumber(0, MAX_TIMELINE_SEC),
  to_sec: boundedNumber(0, MAX_TIMELINE_SEC),
  track_ids: rangeTrackIdsSchema.optional(),
}).refine((value) => value.to_sec >= value.from_sec + 0.1, {
  message: "to_sec must be at least 0.1 seconds after from_sec",
  path: ["to_sec"],
});

const editRangeInsertGapSchema = strictOperation("edit.range.insert_gap", {
  at_sec: boundedNumber(0, MAX_TIMELINE_SEC),
  duration_sec: boundedNumber(0.1, MAX_CLIP_DURATION_SEC),
  track_ids: rangeTrackIdsSchema.optional(),
});

const editTrackAddSchema = strictOperation("edit.track.add", {
  kind: creativeWorkspaceTrackKindSchema,
  name: z.string().trim().min(1).max(120).optional(),
});

const editTrackUpdateSchema = strictOperation("edit.track.update", {
  track_id: creativeWorkspaceIdSchema,
  patch: editTrackPatchSchema,
});

const editTrackRemoveSchema = strictOperation("edit.track.remove", { track_id: creativeWorkspaceIdSchema });

const editSeekSchema = strictOperation("edit.seek", {
  seconds: boundedNumber(0, MAX_TIMELINE_SEC),
});

/** Operation to update Video Editor settings: aspect ratio, frame rate, timecode, and snap. */
export const creativeWorkspaceEditSettingsUpdateSchema = strictOperation("edit.settings.update", {
  patch: z
    .strictObject({
      aspect_ratio: creativeWorkspaceEditAspectRatioSchema.optional(),
      frame_rate: z
        .strictObject({
          numerator: z.number().int().min(1).max(1_000_000),
          denominator: z.number().int().min(1).max(1_000_000),
        })
        .optional(),
      drop_frame: z.boolean().optional(),
      start_timecode: z
        .string()
        .regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/)
        .optional(),
      snap_enabled: z.boolean().optional(),
      export_quality: creativeWorkspaceEditExportQualitySchema.optional(),
    })
    .refine(hasDefinedProperty, "patch must contain at least one field"),
});

/** Operation to update the playback preference for a media item. */
export const creativeWorkspaceMediaPlaybackUpdateSchema = strictOperation("media.playback.update", {
  media_id: creativeWorkspaceIdSchema,
  preference: creativeWorkspaceMediaPlaybackPreferenceSchema,
});

/** Operation to attach a proxy media file to an original media item. */
export const creativeWorkspaceMediaProxyAttachSchema = strictOperation("media.proxy.attach", {
  original_media_id: creativeWorkspaceIdSchema,
  proxy_media_id: creativeWorkspaceIdSchema,
}).refine((value) => value.original_media_id !== value.proxy_media_id, {
  message: "original_media_id and proxy_media_id must be different",
  path: ["proxy_media_id"],
});

/** Label colors available for gallery media items. */
export const creativeWorkspaceGalleryColorSchema = z.enum([
  "none",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
]);

/** View modes for the gallery: grid, masonry, list, or timeline. */
export const creativeWorkspaceGalleryViewModeSchema = z.enum(["grid", "masonry", "list", "timeline"]);

/** Sort keys for the gallery: created date, name, type, rating, or duration. */
export const creativeWorkspaceGallerySortBySchema = z.enum(["created", "name", "type", "rating", "duration"]);

/** Sort direction for the gallery: ascending or descending. */
export const creativeWorkspaceGallerySortDirectionSchema = z.enum(["asc", "desc"]);

const galleryMediaPatchSchema = z
  .strictObject({
    rating: z.number().int().min(0).max(5).optional(),
    tags: z.array(z.string().trim().min(1).max(28)).max(12).optional(),
    color: creativeWorkspaceGalleryColorSchema.optional(),
    custom_name: z.string().trim().min(1).max(240).nullable().optional(),
    notes: z.string().max(8_000).optional(),
    folder_id: creativeWorkspaceIdSchema.nullable().optional(),
    added_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine(hasDefinedProperty, "patch must contain at least one field");

const galleryMediaUpdateSchema = strictOperation("gallery.media.update", {
  media_id: creativeWorkspaceIdSchema,
  patch: galleryMediaPatchSchema,
});

const galleryMediaMoveSchema = strictOperation("gallery.media.move", {
  media_ids: z.array(creativeWorkspaceIdSchema).min(1).max(1_000),
  folder_id: creativeWorkspaceIdSchema.nullable(),
});

const galleryMediaTrashSchema = strictOperation("gallery.media.trash", {
  media_ids: z.array(creativeWorkspaceIdSchema).min(1).max(1_000),
});

const galleryMediaRestoreSchema = strictOperation("gallery.media.restore", {
  media_ids: z.array(creativeWorkspaceIdSchema).min(1).max(1_000),
});

const galleryMediaPurgeSchema = strictOperation("gallery.media.purge", {
  media_ids: z.array(creativeWorkspaceIdSchema).min(1).max(1_000),
  confirm: z.literal(true),
});

const mediaRelinkSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("inline"),
    encoding: creativeWorkspacePayloadEncodingSchema,
    payload: z.string().min(1).max(11_200_000),
    file_name: z.string().trim().min(1).max(240).optional(),
  }),
  z.strictObject({
    kind: z.literal("media_id"),
    media_id: creativeWorkspaceIdSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace_path"),
    path: z.string().trim().min(1).max(1_000),
  }),
]);

const mediaRelinkSchema = strictOperation("media.relink", {
  media_id: creativeWorkspaceIdSchema,
  source: mediaRelinkSourceSchema,
});

const galleryMediaRenameManySchema = strictOperation("gallery.media.rename_many", {
  renames: z
    .array(
      z.strictObject({
        media_id: creativeWorkspaceIdSchema,
        custom_name: z.string().trim().min(1).max(240),
      }),
    )
    .min(1)
    .max(1_000),
}).refine((value) => new Set(value.renames.map((rename) => rename.media_id)).size === value.renames.length, {
  message: "rename media_id values must be unique",
  path: ["renames"],
});

const galleryFolderAddSchema = strictOperation("gallery.folder.add", {
  name: z.string().trim().min(1).max(120),
  parent_id: creativeWorkspaceIdSchema.nullable().optional(),
});

const galleryFolderRenameSchema = strictOperation("gallery.folder.rename", {
  folder_id: creativeWorkspaceIdSchema,
  name: z.string().trim().min(1).max(120),
});

const galleryFolderMoveSchema = strictOperation("gallery.folder.move", {
  folder_id: creativeWorkspaceIdSchema,
  parent_id: creativeWorkspaceIdSchema.nullable(),
});

const galleryFolderRemoveSchema = strictOperation("gallery.folder.remove", {
  folder_id: creativeWorkspaceIdSchema,
});

const galleryPreferencesUpdateSchema = strictOperation("gallery.preferences.update", {
  patch: z
    .strictObject({
      view_mode: creativeWorkspaceGalleryViewModeSchema.optional(),
      sort_by: creativeWorkspaceGallerySortBySchema.optional(),
      sort_direction: creativeWorkspaceGallerySortDirectionSchema.optional(),
      thumbnail_size: z.number().int().min(120).max(360).optional(),
      active_folder_id: creativeWorkspaceIdSchema.nullable().optional(),
      include_subfolders: z.boolean().optional(),
      show_trash: z.boolean().optional(),
    })
    .refine(hasDefinedProperty, "patch must contain at least one field"),
});

const workspaceSwitchSchema = strictOperation("workspace.switch", { workspace: creativeWorkspaceModeSchema });
const workspaceUndoSchema = strictOperation("workspace.undo", {});
const workspaceRedoSchema = strictOperation("workspace.redo", {});

/**
 * The discriminated union of all agent operations across Canvas, Video Editor,
 * Gallery, and workspace surfaces.
 */
export const creativeWorkspaceAgentOperationSchema = z.discriminatedUnion("op", [
  canvasNodeAddSchema,
  canvasNodeUpdateSchema,
  canvasNodeRemoveSchema,
  canvasNodeBringToFrontSchema,
  canvasNodeAssignSectionSchema,
  canvasSectionAddSchema,
  canvasSectionUpdateSchema,
  canvasSectionRemoveSchema,
  canvasEdgeAddSchema,
  canvasEdgeRemoveSchema,
  canvasDagLayoutSchema,
  canvasProductionConfigureSchema,
  editClipAddSchema,
  editClipUpdateSchema,
  editClipMoveSchema,
  editClipSplitSchema,
  editClipRemoveSchema,
  editRangeRemoveSchema,
  editRangeInsertGapSchema,
  editTrackAddSchema,
  editTrackUpdateSchema,
  editTrackRemoveSchema,
  creativeWorkspaceEditSettingsUpdateSchema,
  editSeekSchema,
  creativeWorkspaceMediaPlaybackUpdateSchema,
  creativeWorkspaceMediaProxyAttachSchema,
  galleryMediaUpdateSchema,
  galleryMediaMoveSchema,
  galleryMediaTrashSchema,
  galleryMediaRestoreSchema,
  galleryMediaPurgeSchema,
  galleryMediaRenameManySchema,
  mediaRelinkSchema,
  galleryFolderAddSchema,
  galleryFolderRenameSchema,
  galleryFolderMoveSchema,
  galleryFolderRemoveSchema,
  galleryPreferencesUpdateSchema,
  workspaceSwitchSchema,
  workspaceUndoSchema,
  workspaceRedoSchema,
]);

/** A single agent operation across any workspace surface. */
export type CreativeWorkspaceAgentOperation = z.infer<typeof creativeWorkspaceAgentOperationSchema>;
/** The op identifier string for a creative workspace agent operation. */
export type CreativeWorkspaceAgentOperationId = CreativeWorkspaceAgentOperation["op"];

/** Operations that are excluded from batch execution because they are not history-rollback-safe. */
export const creativeWorkspaceBatchExcludedOperations: readonly CreativeWorkspaceAgentOperationId[] = [
  "edit.seek",
  "media.playback.update",
  "media.proxy.attach",
  "media.relink",
  "gallery.media.purge",
  "workspace.switch",
  "workspace.undo",
  "workspace.redo",
];

const creativeWorkspaceBatchStepSchema = z
  .strictObject({
    step_id: batchStepIdSchema,
    save_as: batchReferenceSchema.optional(),
    operation: creativeWorkspaceAgentOperationSchema,
  })
  .refine(
    (value) => !creativeWorkspaceBatchExcludedOperations.includes(value.operation.op),
    "execute_batch only accepts mutations covered by creative workspace history rollback",
  );

/** Public transport envelope shared by browser, HTTP gateway and MCP. */
export const creativeWorkspaceAgentRequestSchema = z.discriminatedUnion("op", [
  strictOperation("capabilities", {}),
  strictOperation("describe", {
    target: z.string().trim().min(1).max(200),
  }),
  strictOperation("observe", {}),
  creativeWorkspaceInterchangeRequestSchema,
  creativeWorkspaceCollaborationRequestSchema,
  creativeWorkspacePipelineRequestSchema,
  strictOperation("preview", {
    workspace: creativeWorkspacePreviewWorkspaceSchema.default("auto"),
    time_sec: boundedNumber(0, MAX_TIMELINE_SEC).optional(),
    times_sec: z.array(boundedNumber(0, MAX_TIMELINE_SEC)).min(2).max(12).optional(),
    expected_snapshot_fingerprint: creativeWorkspaceSnapshotFingerprintSchema.optional(),
  })
    .refine((value) => value.time_sec === undefined || value.times_sec === undefined, {
      message: "Use either time_sec (single frame) or times_sec (filmstrip), not both",
      path: ["times_sec"],
    })
    .refine((value) => value.times_sec === undefined || value.workspace !== "canvas", {
      message: "times_sec renders Video timeline filmstrips and cannot target the canvas workspace",
      path: ["times_sec"],
    }),
  strictOperation("audit", {
    scope: creativeWorkspaceAuditScopeSchema.default("all"),
    quality_profile: creativeWorkspaceQualityProfileSchema.default("production"),
  }),
  strictOperation("execute", {
    operation: creativeWorkspaceAgentOperationSchema,
    idempotency_key: idempotencyKeySchema.optional(),
    expected_snapshot_fingerprint: creativeWorkspaceSnapshotFingerprintSchema.optional(),
  }),
  strictOperation("execute_batch", {
    idempotency_key: idempotencyKeySchema.optional(),
    expected_snapshot_fingerprint: creativeWorkspaceSnapshotFingerprintSchema.optional(),
    steps: z.array(creativeWorkspaceBatchStepSchema).min(1).max(32),
  })
    .refine((value) => new Set(value.steps.map((step) => step.step_id)).size === value.steps.length, {
      message: "execute_batch step_id values must be unique",
      path: ["steps"],
    })
    .refine(
      (value) => {
        const aliases = value.steps.flatMap((step) => (step.save_as ? [step.save_as] : []));
        return new Set(aliases).size === aliases.length;
      },
      { message: "execute_batch save_as values must be unique", path: ["steps"] },
    ),
]);

/** Exact contract reflection returned for one director_creative operation. */
export const creativeWorkspaceDescribeResultSchema = z.strictObject({
  target: z.string().trim().min(1).max(200),
  kind: z.literal("operation"),
  json_schema: z.unknown(),
  note: z.string().trim().min(1).max(1_000),
});

/** Resolves one director_creative operation to its complete input JSON Schema. */
export function describeCreativeWorkspaceTarget(
  rawTarget: string,
):
  { success: true; result: z.infer<typeof creativeWorkspaceDescribeResultSchema> } | { success: false; error: string } {
  const target = rawTarget.trim();
  const option = creativeWorkspaceAgentRequestSchema.options.find((candidate) => candidate.shape.op.value === target);
  if (!option) {
    const valid = creativeWorkspaceAgentRequestSchema.options.map((candidate) => candidate.shape.op.value).join(", ");
    return {
      success: false,
      error: `Unknown director_creative describe target "${target}". Valid operations: ${valid}.`,
    };
  }
  return {
    success: true,
    result: creativeWorkspaceDescribeResultSchema.parse({
      target,
      kind: "operation",
      json_schema: z.toJSONSchema(option, {
        unrepresentable: "any",
        cycles: "ref",
        reused: "inline",
        io: "input",
      }),
      note: `Send this schema as one director_creative {"op":"${target}",...} request.`,
    }),
  };
}

/** An agent request to any creative workspace surface. */
export type CreativeWorkspaceAgentRequest = z.infer<typeof creativeWorkspaceAgentRequestSchema>;
/** A preview request, targeting either a single frame or a filmstrip. */
export type CreativeWorkspaceAgentPreviewRequest = Extract<CreativeWorkspaceAgentRequest, { op: "preview" }>;
/** An interchange request (export/import). */
export type CreativeWorkspaceInterchangeRequest = Extract<CreativeWorkspaceAgentRequest, { op: "interchange" }>;
/** A collaboration request (comments, versions). */
export type CreativeWorkspaceCollaborationRequest = Extract<CreativeWorkspaceAgentRequest, { op: "collaboration" }>;
/** A pipeline request (start, status, cancel). */
export type CreativeWorkspacePipelineRequest = Extract<CreativeWorkspaceAgentRequest, { op: "pipeline" }>;
/** An anchor for a review comment. */
export type CreativeWorkspaceReviewAnchor = z.infer<typeof creativeWorkspaceReviewAnchorSchema>;

const creativeWorkspaceSemanticFailureSchema = strictSuccess(false, {
  action: z.string().trim().min(1).max(80),
  code: z.enum([
    "unsupported",
    "not_found",
    "stale_guard",
    "capacity",
    "unavailable",
    "invalid_anchor",
    "conflict",
    "operation_rejected",
    "export_failed",
    "import_failed",
    "aborted",
  ]),
  error: z.string().trim().min(1).max(4_000),
  current_guard: creativeWorkspaceSemanticGuardSchema.optional(),
  suggested_next: z.string().trim().min(1).max(1_000),
});

const creativeWorkspacePipelineNodeRunSchema = z.strictObject({
  node_id: creativeWorkspaceIdSchema,
  status: z.enum([
    "pending",
    "running",
    "passthrough",
    "cached",
    "succeeded",
    "failed",
    "blocked",
    "cancelled",
    "stale",
  ]),
  request_fingerprint: creativeWorkspaceSnapshotFingerprintSchema.nullable(),
  job_id: creativeWorkspaceIdSchema.nullable(),
  artifact_id: creativeWorkspaceIdSchema.nullable(),
  media_id: creativeWorkspaceIdSchema.nullable(),
  started_at: z.string().datetime().nullable(),
  finished_at: z.string().datetime().nullable(),
  error: z.string().max(12_000).nullable(),
});

/** The state of a Canvas pipeline run, including per-node status and timing. */
export const creativeWorkspacePipelineRunSchema = z.strictObject({
  version: z.literal(1),
  id: creativeWorkspaceIdSchema,
  graph_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  status: z.enum(["running", "succeeded", "partial", "failed", "cancelled"]),
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
  node_runs: z.array(creativeWorkspacePipelineNodeRunSchema).max(240),
  error: z.string().max(12_000).nullable(),
});

/** The result of a pipeline operation: capabilities, start, status, cancel, or a semantic failure. */
export const creativeWorkspacePipelineResultSchema = z.union([
  strictSuccessAction(true, "capabilities", {
    contract: z.literal("director-canvas-pipeline-agent-v1"),
    actions: z.tuple([z.literal("capabilities"), z.literal("start"), z.literal("status"), z.literal("cancel")]),
    execution: z.literal("topological-levels-with-bounded-parallelism"),
    reference_binding: z.literal("direct-upstream-persistent-images"),
  }),
  strictSuccessAction(true, "start", {
    run: creativeWorkspacePipelineRunSchema,
    idempotency: z.strictObject({ key: idempotencyKeySchema, replayed: z.boolean() }).optional(),
  }),
  strictSuccessAction(true, "status", {
    run: creativeWorkspacePipelineRunSchema,
  }),
  strictSuccessAction(true, "cancel", {
    run: creativeWorkspacePipelineRunSchema,
  }),
  creativeWorkspaceSemanticFailureSchema,
]);

const creativeWorkspaceInterchangeFormatCapabilitySchema = z.strictObject({
  id: creativeWorkspaceInterchangeFormatSchema,
  workspaces: z.array(creativeWorkspaceInterchangeWorkspaceSchema).min(1).max(2),
  payload_encoding: creativeWorkspacePayloadEncodingSchema,
  mime_type: z.string().trim().min(1).max(160),
  extensions: z
    .array(z.string().regex(/^\.[a-z0-9]+$/))
    .min(1)
    .max(3),
});

/**
 * An interchange export plan: describes the format, workspace, object ids,
 * payload encoding, and guard fingerprint for a pending export.
 */
export const creativeWorkspaceInterchangePlanSchema = z.strictObject({
  contract: z.literal("director-interchange-plan-v1"),
  plan_id: z.string().regex(/^interchange-plan:v1:[0-9a-f-]{36}$/),
  format: creativeWorkspaceInterchangeFormatSchema,
  workspace: creativeWorkspaceInterchangeWorkspaceSchema,
  file_name: z.string().trim().min(1).max(240),
  mime_type: z.string().trim().min(1).max(160),
  payload_encoding: creativeWorkspacePayloadEncodingSchema,
  object_ids: creativeWorkspaceInterchangeObjectIdsSchema.nullable(),
  max_inline_bytes: z
    .number()
    .int()
    .min(1_024)
    .max(8 * 1024 * 1024),
  guard: creativeWorkspaceSemanticGuardSchema,
  warnings: z.array(z.string().max(1_000)).max(50),
});

/**
 * An interchange import plan: summarizes a parsed payload ready for atomic commit.
 */
export const creativeWorkspaceInterchangeImportPlanSchema = z.strictObject({
  contract: z.literal("director-interchange-import-plan-v1"),
  plan_id: z.string().regex(/^interchange-plan:v1:[0-9a-f-]{36}$/),
  format: creativeWorkspaceInterchangeFormatSchema,
  workspace: creativeWorkspaceInterchangeWorkspaceSchema,
  file_name: z.string().trim().min(1).max(240),
  source_kind: z.enum(["inline", "media_id", "workspace_path"]),
  byte_length: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1024 * 1024),
  guard: creativeWorkspaceSemanticGuardSchema,
  summary: z.strictObject({
    stage_objects: z.number().int().nonnegative().optional(),
    cameras: z.number().int().nonnegative().optional(),
    video_clips: z.number().int().nonnegative().optional(),
    video_tracks: z.number().int().nonnegative().optional(),
  }),
  warnings: z.array(z.string().max(1_000)).max(50),
});

/** A supported interchange format. */
export type CreativeWorkspaceInterchangeFormat = z.infer<typeof creativeWorkspaceInterchangeFormatSchema>;
/** The workspace targeted by an interchange operation. */
export type CreativeWorkspaceInterchangeWorkspace = z.infer<typeof creativeWorkspaceInterchangeWorkspaceSchema>;
/** A semantic guard binding a workspace state fingerprint to an operation kind. */
export type CreativeWorkspaceSemanticGuard = z.infer<typeof creativeWorkspaceSemanticGuardSchema>;
/** An interchange export plan with a branded plan_id. */
export type CreativeWorkspaceInterchangePlan = Omit<
  z.infer<typeof creativeWorkspaceInterchangePlanSchema>,
  "plan_id"
> & { plan_id: `interchange-plan:v1:${string}` };
/** An interchange import plan with a branded plan_id. */
export type CreativeWorkspaceInterchangeImportPlan = Omit<
  z.infer<typeof creativeWorkspaceInterchangeImportPlanSchema>,
  "plan_id"
> & { plan_id: `interchange-plan:v1:${string}` };

const creativeWorkspaceInterchangeReceiptSchema = z.strictObject({
  contract: z.literal("director-interchange-export-v1"),
  receipt_id: z.string().regex(/^interchange-receipt:v1:[0-9a-f-]{36}$/),
  plan_id: z.string().regex(/^interchange-plan:v1:[0-9a-f-]{36}$/),
  format: creativeWorkspaceInterchangeFormatSchema,
  workspace: creativeWorkspaceInterchangeWorkspaceSchema,
  file_name: z.string().trim().min(1).max(240),
  mime_type: z.string().trim().min(1).max(160),
  payload_encoding: creativeWorkspacePayloadEncodingSchema,
  byte_length: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1024 * 1024),
  guard: creativeWorkspaceSemanticGuardSchema,
  payload: z.string().max(11_200_000),
  warnings: z.array(z.string().max(1_000)).max(50),
});

const creativeWorkspaceInterchangeImportReceiptSchema = z.strictObject({
  contract: z.literal("director-interchange-import-v1"),
  receipt_id: z.string().regex(/^interchange-receipt:v1:[0-9a-f-]{36}$/),
  plan_id: z.string().regex(/^interchange-plan:v1:[0-9a-f-]{36}$/),
  format: creativeWorkspaceInterchangeFormatSchema,
  workspace: creativeWorkspaceInterchangeWorkspaceSchema,
  file_name: z.string().trim().min(1).max(240),
  before_guard: creativeWorkspaceSemanticGuardSchema,
  after_guard: creativeWorkspaceSemanticGuardSchema,
  warnings: z.array(z.string().max(1_000)).max(50),
});

/** The result of an interchange operation: capabilities, export/import plans, or a semantic failure. */
export const creativeWorkspaceInterchangeResultSchema = z.union([
  strictSuccessAction(true, "capabilities", {
    contract: z.literal("director-interchange-agent-v1"),
    formats: z.array(creativeWorkspaceInterchangeFormatCapabilitySchema).min(1),
    actions: z.tuple([
      z.literal("capabilities"),
      z.literal("plan-export"),
      z.literal("export"),
      z.literal("plan-import"),
      z.literal("import"),
    ]),
    import_mode: z.literal("agent-transfer"),
    max_inline_bytes: z.literal(8 * 1024 * 1024),
  }),
  strictSuccessAction(true, "plan-export", {
    plan: creativeWorkspaceInterchangePlanSchema,
  }),
  strictSuccessAction(true, "export", {
    receipt: creativeWorkspaceInterchangeReceiptSchema,
  }),
  strictSuccessAction(true, "plan-import", {
    plan: creativeWorkspaceInterchangeImportPlanSchema,
  }),
  strictSuccessAction(true, "import", {
    receipt: creativeWorkspaceInterchangeImportReceiptSchema,
  }),
  creativeWorkspaceSemanticFailureSchema,
]);

const creativeWorkspaceCollaboratorSchema = z.strictObject({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});

const creativeWorkspaceReviewCommentSchema = z.strictObject({
  id: creativeWorkspaceIdSchema,
  anchor: creativeWorkspaceReviewAnchorSchema,
  author: creativeWorkspaceCollaboratorSchema,
  body: z.string().trim().min(1).max(8_000),
  status: creativeWorkspaceReviewStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  resolved_at: z.string().datetime().optional(),
  resolved_by: creativeWorkspaceCollaboratorSchema.optional(),
});

const creativeWorkspaceVersionMetadataSchema = z.strictObject({
  id: creativeWorkspaceIdSchema,
  name: z.string().trim().min(1).max(240),
  author: creativeWorkspaceCollaboratorSchema,
  created_at: z.string().datetime(),
});

const creativeWorkspaceVersionComparisonSchema = z.strictObject({
  before_version_id: creativeWorkspaceIdSchema,
  after_version_id: creativeWorkspaceIdSchema.nullable(),
  changes: z
    .array(
      z.strictObject({
        path: z.string().max(1_000),
        kind: z.enum(["added", "removed", "changed"]),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
      }),
    )
    .max(2_000),
  truncated: z.boolean(),
  summary: z.strictObject({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    stage_objects_before: z.number().int().nonnegative(),
    stage_objects_after: z.number().int().nonnegative(),
    cameras_before: z.number().int().nonnegative(),
    cameras_after: z.number().int().nonnegative(),
    canvas_nodes_before: z.number().int().nonnegative(),
    canvas_nodes_after: z.number().int().nonnegative(),
    video_clips_before: z.number().int().nonnegative(),
    video_clips_after: z.number().int().nonnegative(),
  }),
});

const creativeWorkspaceCollaborationStateSchema = z.strictObject({
  contract: z.literal("director-collaboration-agent-v1"),
  room_id: creativeWorkspaceIdSchema,
  ready: z.boolean(),
  collaboration_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  shared_project_revision: z.string().trim().min(1).max(240).nullable(),
  agent_identity: creativeWorkspaceCollaboratorSchema,
  participant_count: z.number().int().nonnegative(),
  comment_count: z.number().int().nonnegative(),
  version_count: z.number().int().nonnegative(),
});

const creativeWorkspaceCollaborationReceiptSchema = z.strictObject({
  contract: z.literal("director-collaboration-comment-v1"),
  receipt_id: z.string().regex(/^collaboration-receipt:v1:[0-9a-f-]{36}$/),
  before_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  after_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  comment: creativeWorkspaceReviewCommentSchema,
  idempotency: z.strictObject({ key: idempotencyKeySchema, replayed: z.boolean() }).optional(),
});

const creativeWorkspaceCollaborationVersionReceiptSchema = z.strictObject({
  contract: z.literal("director-collaboration-version-v1"),
  receipt_id: z.string().regex(/^collaboration-receipt:v1:[0-9a-f-]{36}$/),
  before_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  after_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  version: creativeWorkspaceVersionMetadataSchema.nullable(),
  version_id: creativeWorkspaceIdSchema.optional(),
  idempotency: z.strictObject({ key: idempotencyKeySchema, replayed: z.boolean() }).optional(),
});

const creativeWorkspaceCollaborationDeleteCommentReceiptSchema = z.strictObject({
  contract: z.literal("director-collaboration-comment-delete-v1"),
  receipt_id: z.string().regex(/^collaboration-receipt:v1:[0-9a-f-]{36}$/),
  before_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  after_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  comment_id: creativeWorkspaceIdSchema,
  idempotency: z.strictObject({ key: idempotencyKeySchema, replayed: z.boolean() }).optional(),
});

/** The result of a collaboration operation: observe, comments, versions, compare, or a failure. */
export const creativeWorkspaceCollaborationResultSchema = z.union([
  strictSuccessAction(true, "observe", {
    state: creativeWorkspaceCollaborationStateSchema,
  }),
  strictSuccessAction(true, "list-comments", {
    collaboration_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
    comments: z.array(creativeWorkspaceReviewCommentSchema).max(2_000),
  }),
  strictSuccessAction(true, "add-comment", {
    receipt: creativeWorkspaceCollaborationReceiptSchema,
  }),
  strictSuccessAction(true, "resolve-comment", {
    receipt: creativeWorkspaceCollaborationReceiptSchema,
  }),
  strictSuccessAction(true, "reopen-comment", {
    receipt: creativeWorkspaceCollaborationReceiptSchema,
  }),
  strictSuccessAction(true, "update-comment", {
    receipt: creativeWorkspaceCollaborationReceiptSchema,
  }),
  strictSuccessAction(true, "delete-comment", {
    receipt: creativeWorkspaceCollaborationDeleteCommentReceiptSchema,
  }),
  strictSuccessAction(true, "list-versions", {
    collaboration_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
    versions: z.array(creativeWorkspaceVersionMetadataSchema).max(2_000),
  }),
  strictSuccessAction(true, "compare", {
    collaboration_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
    comparison: creativeWorkspaceVersionComparisonSchema,
  }),
  strictSuccessAction(true, "create-version", {
    receipt: creativeWorkspaceCollaborationVersionReceiptSchema,
  }),
  strictSuccessAction(true, "restore-version", {
    receipt: creativeWorkspaceCollaborationVersionReceiptSchema,
  }),
  strictSuccessAction(true, "delete-version", {
    receipt: creativeWorkspaceCollaborationVersionReceiptSchema,
  }),
  creativeWorkspaceSemanticFailureSchema,
]);

/** Tool result envelope for interchange operations. */
export const creativeWorkspaceInterchangeToolResultSchema = strictOperation("interchange", {
  result: creativeWorkspaceInterchangeResultSchema,
});

/** Tool result envelope for collaboration operations. */
export const creativeWorkspaceCollaborationToolResultSchema = strictOperation("collaboration", {
  result: creativeWorkspaceCollaborationResultSchema,
});

/** Tool result envelope for pipeline operations. */
export const creativeWorkspacePipelineToolResultSchema = strictOperation("pipeline", {
  result: creativeWorkspacePipelineResultSchema,
});

/** An interchange tool result. */
export type CreativeWorkspaceInterchangeToolResult = z.infer<typeof creativeWorkspaceInterchangeToolResultSchema>;
/** A collaboration tool result. */
export type CreativeWorkspaceCollaborationToolResult = z.infer<typeof creativeWorkspaceCollaborationToolResultSchema>;
/** A pipeline tool result. */
export type CreativeWorkspacePipelineToolResult = z.infer<typeof creativeWorkspacePipelineToolResultSchema>;

/** Exact operation names used by MCP help, API harnesses and planner prompts. */
export const creativeWorkspaceAgentOperationNames = creativeWorkspaceAgentOperationSchema.options.map(
  (schema) => schema.shape.op.value,
) as CreativeWorkspaceAgentOperationId[];
