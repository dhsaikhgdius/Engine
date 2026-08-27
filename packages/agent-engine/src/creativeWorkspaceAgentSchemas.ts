/**
 * `director_creative` agent-facing schemas: snapshot projection, execution
 * results, capabilities, and preview contracts.
 *
 * The creative workspace (Canvas production DAG, Video Editor, Gallery,
 * media library) lives in browser Zustand stores; agents never touch those
 * stores directly. Instead the browser projects its state into the
 * snake_case snapshot validated by
 * {@link creativeWorkspaceAgentSnapshotSchema}, and every mutation flows
 * back as an execution result validated here. The request/operation grammar
 * itself lives in `@director/protocol/creativeWorkspaceProtocol` and is
 * re-exported; this module owns the shapes that cross the browser/gateway
 * boundary at runtime.
 *
 * Invariants:
 * - Every snapshot carries a `snapshot_fingerprint`; mutating ops must echo
 *   it, and a stale fingerprint is a typed `conflict` failure — never a
 *   silent overwrite.
 * - All schemas are strict: unknown keys are rejected with a corrective
 *   message ({@link parseCreativeWorkspaceAgentOperation}) so agents learn
 *   the exact field to remove.
 * - The capabilities payload is data (`creativeWorkspaceAgentCapabilities
 *   .json`) validated against {@link creativeWorkspaceAgentCapabilitiesSchema}
 *   at read time, so the advertised vocabulary can never drift from the
 *   schema that documents it.
 * - Collection sizes are bounded (nodes, edges, clips, media, …) so a
 *   snapshot can always fit a tool-result payload.
 *
 * @module creativeWorkspaceAgentSchemas
 */

import { z } from "zod";
import creativeWorkspaceAgentCapabilities from "./creativeWorkspaceAgentCapabilities.json";
import { creativeWorkspaceAuditReceiptSchema } from "./creativeWorkspaceAgentQuality";
import { comfyGenerationParametersSchema } from "@director/protocol/comfy-generation";
import {
  CREATIVE_WORKSPACE_MAX_CLIP_PLAYBACK_RATE as MAX_CLIP_PLAYBACK_RATE,
  CREATIVE_WORKSPACE_MIN_CLIP_PLAYBACK_RATE as MIN_CLIP_PLAYBACK_RATE,
  creativeWorkspaceAgentOperationNames,
  creativeWorkspaceAgentOperationSchema,
  creativeWorkspaceAgentRequestSchema,
  creativeWorkspaceAuditScopeSchema,
  creativeWorkspaceBatchExcludedOperations,
  creativeWorkspaceCollaborationToolResultSchema,
  creativeWorkspaceDescribeResultSchema,
  creativeWorkspaceCanvasNodePatchSchema as canvasNodePatchSchema,
  creativeWorkspaceEditClipPatchSchema as editClipPatchSchema,
  creativeWorkspaceEditAspectRatioSchema as editAspectRatioSchema,
  creativeWorkspaceEditExportQualitySchema as editExportQualitySchema,
  creativeWorkspaceEditSettingsUpdateSchema as editSettingsUpdateSchema,
  creativeWorkspaceFiniteNumberSchema as finiteNumber,
  creativeWorkspaceFitSchema as fitSchema,
  creativeWorkspaceGalleryColorSchema as galleryColorSchema,
  creativeWorkspaceGallerySortBySchema as gallerySortBySchema,
  creativeWorkspaceGallerySortDirectionSchema as gallerySortDirectionSchema,
  creativeWorkspaceGalleryViewModeSchema as galleryViewModeSchema,
  creativeWorkspaceIdSchema as idSchema,
  creativeWorkspaceMediaPlaybackPreferenceSchema as mediaPlaybackPreferenceSchema,
  creativeWorkspaceMediaPlaybackUpdateSchema as mediaPlaybackUpdateSchema,
  creativeWorkspaceMediaProxyAttachSchema as mediaProxyAttachSchema,
  creativeWorkspaceMediaVerifySchema as mediaVerifySchema,
  creativeWorkspaceModeSchema as workspaceModeSchema,
  creativeWorkspaceNodeKindSchema as nodeKindSchema,
  creativeWorkspaceSnapshotFingerprintSchema as snapshotFingerprintSchema,
  creativeWorkspaceInterchangeToolResultSchema,
  creativeWorkspaceInterchangeFormatSchema as interchangeFormatSchema,
  creativeWorkspacePipelineToolResultSchema,
  creativeWorkspacePipelineRunSchema,
  creativeWorkspaceQualityProfileSchema,
  creativeWorkspacePreviewWorkspaceSchema,
  creativeWorkspaceTrackKindSchema as trackKindSchema,
  type CreativeWorkspaceAgentOperation,
  type CreativeWorkspaceAgentOperationId,
  type CreativeWorkspaceAgentPreviewRequest,
  type CreativeWorkspaceAgentRequest,
} from "@director/protocol/creativeWorkspaceProtocol";
import { strictKind, strictOperation, strictSuccess } from "@director/protocol/strictProtocolVariant";

// ---------------------------------------------------------------------------
// Request grammar re-exports (canonical definitions live in the protocol
// package; re-exported here so agent-engine consumers have one import path).
// ---------------------------------------------------------------------------

export {
  creativeWorkspaceAgentOperationNames,
  creativeWorkspaceAgentOperationSchema,
  creativeWorkspaceAgentRequestSchema,
};
export type {
  CreativeWorkspaceAgentOperation,
  CreativeWorkspaceAgentOperationId,
  CreativeWorkspaceAgentPreviewRequest,
  CreativeWorkspaceAgentRequest,
};

// ---------------------------------------------------------------------------
// Typed failure vocabulary and parse results.
// ---------------------------------------------------------------------------

/**
 * Typed failure classes for creative operations. `conflict` specifically
 * means the snapshot fingerprint guard failed (state moved under the agent);
 * `operation_rejected` means the input was valid but the workspace refused
 * the semantics (e.g. removing a node with live pipeline outputs).
 */
export type CreativeWorkspaceAgentErrorCode =
  "invalid_input" | "not_found" | "locked" | "conflict" | "capacity" | "operation_rejected";

/** One Zod issue projected into a dotted path plus corrective message. */
export interface CreativeWorkspaceAgentParseIssue {
  path: string;
  message: string;
}

/** Result of parsing an operation: the typed operation, or per-path issues. */
export type CreativeWorkspaceAgentParseResult =
  | { success: true; operation: CreativeWorkspaceAgentOperation }
  | {
      success: false;
      code: "invalid_input";
      error: string;
      issues: CreativeWorkspaceAgentParseIssue[];
    };

// ---------------------------------------------------------------------------
// Projected snapshot building blocks. Each `projected*` schema is the
// agent-facing (snake_case) shape of one browser store slice; the browser is
// responsible for projecting into these shapes, and the gateway re-validates
// on receipt so a drifting projection fails loudly at the boundary.
// ---------------------------------------------------------------------------

const projectedCanvasProductionConfigSchema = z.strictObject({
  workflow_id: z.string().nullable(),
  node_ids: z.array(z.string()).max(32),
  negative_prompt: z.string(),
  seed: z.number().int().nonnegative(),
  duration_seconds: z.number().positive(),
  fps: z.number().positive(),
  audio_mode: z.enum(["sound-effect", "music", "speech"]),
  sample_rate: z.number().int().positive(),
  voice: z.string(),
  language: z.string(),
  parameters: comfyGenerationParametersSchema.default({}),
});

const projectedCanvasProductionOutputSchema = z.strictObject({
  run_id: z.string(),
  request_fingerprint: snapshotFingerprintSchema,
  status: z.enum(["succeeded", "failed", "cancelled", "stale"]),
  job_id: z.string().nullable(),
  artifact_id: z.string().nullable(),
  media_id: z.string().nullable(),
  workflow_id: z.string().nullable(),
  node_id: z.string().nullable(),
  created_at: z.string().datetime(),
  error: z.string().nullable(),
});

const projectedBoardNodeSchema = z.strictObject({
  id: idSchema,
  kind: nodeKindSchema,
  title: z.string(),
  body: z.string(),
  media_id: z.string().nullable(),
  section_id: z.string().nullable(),
  z_index: z.number().int().nonnegative(),
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  accent: z.string(),
  production: z.strictObject({
    run_id: z.string().nullable(),
    job_id: z.string().nullable(),
    status: z.string().nullable(),
    error: z.string().nullable(),
    config: projectedCanvasProductionConfigSchema.nullable(),
    outputs: z.array(projectedCanvasProductionOutputSchema).max(32),
  }),
});

const projectedBoardSectionSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["character", "scene", "generation", "final", "custom"]),
  title: z.string(),
  collapsed: z.boolean(),
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  accent: z.string(),
});

const projectedBoardEdgeSchema = z.strictObject({
  id: idSchema,
  source_node_id: idSchema,
  target_node_id: idSchema,
});

// Precomputed DAG analysis of the Canvas board (published with every
// snapshot) so agents can reason about ordering and parallelism without
// re-deriving graph structure from raw edges.
const projectedCanvasDagSchema = z.strictObject({
  valid: z.boolean(),
  roots: z.array(idSchema).max(240),
  leaves: z.array(idSchema).max(240),
  topological_order: z.array(idSchema).max(240),
  parallel_levels: z.array(z.array(idSchema).max(240)).max(240),
  issues: z
    .array(
      z.strictObject({
        code: z.enum(["dangling_source", "dangling_target", "self_edge", "duplicate_edge", "cycle"]),
        edge_id: z.string().nullable(),
        node_ids: z.array(z.string().min(1)).max(240),
      }),
    )
    .max(2_000),
});

const projectedEditClipSchema = z.strictObject({
  id: idSchema,
  media_id: idSchema,
  name: z.string(),
  start_sec: finiteNumber.nonnegative(),
  duration_sec: finiteNumber.positive(),
  in_sec: finiteNumber.nonnegative(),
  source_duration_sec: finiteNumber.positive(),
  playback_rate: finiteNumber.min(MIN_CLIP_PLAYBACK_RATE).max(MAX_CLIP_PLAYBACK_RATE),
  opacity: finiteNumber.min(0).max(1),
  volume: finiteNumber.min(0).max(1),
  fade_in_sec: finiteNumber.nonnegative(),
  fade_out_sec: finiteNumber.nonnegative(),
  // Defaulted so snapshots serialized before transitions were projected keep validating.
  transition_in_sec: finiteNumber.nonnegative().default(0),
  scale: finiteNumber.positive(),
  position_x: finiteNumber,
  position_y: finiteNumber,
  rotation_deg: finiteNumber,
  fit: fitSchema,
});

const projectedEditTrackSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  kind: trackKindSchema,
  muted: z.boolean(),
  locked: z.boolean(),
  visible: z.boolean(),
  clips: z.array(projectedEditClipSchema).max(400),
});

const projectedMediaAssetSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["image", "video", "audio"]),
  name: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  size: finiteNumber.nonnegative(),
  created_at: z.string(),
  last_modified: finiteNumber.nullable(),
  duration_sec: finiteNumber.positive().nullable(),
  width: finiteNumber.positive().nullable(),
  height: finiteNumber.positive().nullable(),
  source: z.string().nullable(),
  available: z.boolean(),
  waveform_ready: z.boolean(),
  proxy_of: z.string().nullable(),
  playback_preference: mediaPlaybackPreferenceSchema,
  proxy_profile: z
    .strictObject({
      label: z.string(),
      width: finiteNumber.positive().nullable(),
      height: finiteNumber.positive().nullable(),
      video_bitrate_kbps: finiteNumber.nonnegative().nullable(),
      audio_bitrate_kbps: finiteNumber.nonnegative().nullable(),
      codec: z.string().nullable(),
      created_at: z.string(),
    })
    .nullable(),
});

const projectedGalleryMediaSchema = z.strictObject({
  media_id: idSchema,
  rating: z.number().int().min(0).max(5),
  tags: z.array(z.string().max(28)).max(12),
  color: galleryColorSchema,
  custom_name: z.string().nullable(),
  notes: z.string(),
  folder_id: idSchema.nullable(),
  added_at: z.string().nullable(),
  trashed_at: z.string().nullable(),
});

const projectedGalleryFolderSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  parent_id: idSchema.nullable(),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// The full observe snapshot.
// ---------------------------------------------------------------------------

/**
 * Runtime contract for snapshots crossing the browser/gateway boundary.
 * The `snapshot_fingerprint` is the concurrency guard every mutating
 * `director_creative` call must echo; `counts` mirror the collection sizes
 * so agents can gauge scale before requesting full collections.
 */
export const creativeWorkspaceAgentSnapshotSchema = z.strictObject({
  version: z.literal(1),
  snapshot_fingerprint: snapshotFingerprintSchema,
  workspace: z.strictObject({ mode: workspaceModeSchema, can_undo: z.boolean(), can_redo: z.boolean() }),
  board: z.strictObject({
    nodes: z.array(projectedBoardNodeSchema).max(240),
    edges: z.array(projectedBoardEdgeSchema).max(2_000),
    sections: z.array(projectedBoardSectionSchema).max(32),
    dag: projectedCanvasDagSchema,
    pipeline_runs: z.array(creativeWorkspacePipelineRunSchema).max(40),
    viewport: z.strictObject({ x: finiteNumber, y: finiteNumber, zoom: finiteNumber.positive() }),
  }),
  edit: z.strictObject({
    tracks: z.array(projectedEditTrackSchema).max(12),
    settings: z.strictObject({
      aspect_ratio: editAspectRatioSchema,
      fps: finiteNumber.min(1).max(240),
      timebase: z.strictObject({
        rate: z.string().regex(/^\d+\/\d+$/),
        numerator: z.number().int().min(1).max(1_000_000),
        denominator: z.number().int().min(1).max(1_000_000),
        drop_frame: z.boolean(),
        start_timecode: z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/),
      }),
      snap_enabled: z.boolean(),
      export_quality: editExportQualitySchema,
    }),
    playhead_sec: finiteNumber.nonnegative(),
    timeline_zoom: finiteNumber.positive(),
  }),
  selection: z.strictObject({ board_node_id: z.string().nullable(), clip_id: z.string().nullable() }),
  media: z.strictObject({
    status: z.enum(["idle", "hydrating", "ready", "error"]),
    storage_mode: z.enum(["indexeddb", "memory"]),
    warning: z.string().nullable(),
    error: z.string().nullable(),
    assets: z.array(projectedMediaAssetSchema).max(10_000),
  }),
  gallery: z.strictObject({
    media: z.array(projectedGalleryMediaSchema).max(5_000),
    folders: z.array(projectedGalleryFolderSchema).max(200),
    preferences: z.strictObject({
      view_mode: galleryViewModeSchema,
      sort_by: gallerySortBySchema,
      sort_direction: gallerySortDirectionSchema,
      thumbnail_size: z.number().int().min(120).max(360),
      active_folder_id: idSchema.nullable(),
      include_subfolders: z.boolean(),
      show_trash: z.boolean(),
    }),
  }),
  counts: z.strictObject({
    board_nodes: z.number().int().nonnegative(),
    board_edges: z.number().int().nonnegative(),
    board_sections: z.number().int().nonnegative(),
    pipeline_runs: z.number().int().nonnegative(),
    tracks: z.number().int().nonnegative(),
    clips: z.number().int().nonnegative(),
    media_assets: z.number().int().nonnegative(),
    gallery_media: z.number().int().nonnegative(),
    gallery_folders: z.number().int().nonnegative(),
  }),
});

type ParsedCreativeWorkspaceAgentSnapshot = z.infer<typeof creativeWorkspaceAgentSnapshotSchema>;
/** Snapshot type with the fingerprint widened to `string` for producers. */
export type CreativeWorkspaceAgentSnapshot = Omit<ParsedCreativeWorkspaceAgentSnapshot, "snapshot_fingerprint"> & {
  snapshot_fingerprint: string;
};

// ---------------------------------------------------------------------------
// Execution results. Success always carries the post-mutation snapshot so
// the agent's next decision is grounded in current state; failure carries a
// typed code, optional issues, and often a `suggested_next` corrective call.
// ---------------------------------------------------------------------------

/** Discriminated execution outcome for `execute` / `execute_batch`. */
export type CreativeWorkspaceAgentExecutionResult =
  | {
      success: true;
      operation: CreativeWorkspaceAgentOperationId | "batch";
      message: string;
      result: Record<string, unknown>;
      snapshot: CreativeWorkspaceAgentSnapshot;
    }
  | {
      success: false;
      operation: CreativeWorkspaceAgentOperationId | "batch" | null;
      code: CreativeWorkspaceAgentErrorCode;
      error: string;
      issues?: CreativeWorkspaceAgentParseIssue[];
      result?: Record<string, unknown>;
      snapshot?: CreativeWorkspaceAgentSnapshot;
      suggested_next?: string;
    };

const creativeWorkspaceAgentExecutionSuccessSchema = strictSuccess(true, {
  operation: z.string().min(1).max(120),
  message: z.string().max(4_000),
  result: z.record(z.string(), z.unknown()),
  snapshot: creativeWorkspaceAgentSnapshotSchema,
});

const creativeWorkspaceAgentExecutionFailureSchema = strictSuccess(false, {
  operation: z.string().min(1).max(120).nullable(),
  code: z.enum(["invalid_input", "not_found", "locked", "conflict", "capacity", "operation_rejected"]),
  error: z.string().max(4_000),
  issues: z
    .array(z.strictObject({ path: z.string(), message: z.string() }))
    .max(100)
    .optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  snapshot: creativeWorkspaceAgentSnapshotSchema.optional(),
  suggested_next: z.string().max(1_000).optional(),
});

/** Wire validation of the execution result union (success and failure arms). */
export const creativeWorkspaceAgentExecutionResultSchema = z.discriminatedUnion("success", [
  creativeWorkspaceAgentExecutionSuccessSchema,
  creativeWorkspaceAgentExecutionFailureSchema,
]);

// ---------------------------------------------------------------------------
// Capabilities. This is the canonical vocabulary channel for
// `director_creative`: everything an agent may assume about limits,
// concurrency guards, batch semantics, DAG/editorial/gallery contracts,
// interchange, collaboration, and pipelines is declared here, with the
// values themselves in creativeWorkspaceAgentCapabilities.json. Literal
// types pin contract facts (guard names, operation ids, defaults) so a JSON
// edit that contradicts the schema fails at capabilities time.
// ---------------------------------------------------------------------------

/** Strict shape of the `director_creative` capabilities payload. */
export const creativeWorkspaceAgentCapabilitiesSchema = z.strictObject({
  version: z.literal(2),
  tool: z.literal("director_creative"),
  request_ops: z.array(
    z.enum([
      "capabilities",
      "describe",
      "observe",
      "execute",
      "execute_batch",
      "audit",
      "preview",
      "interchange",
      "collaboration",
      "pipeline",
    ]),
  ),
  operation_ids: z.array(z.string()),
  limits: z.strictObject({
    board_nodes: z.number().int().positive(),
    board_edges: z.number().int().positive(),
    board_sections: z.number().int().positive(),
    tracks: z.number().int().positive(),
    clips_per_track: z.number().int().positive(),
    batch_steps: z.number().int().positive(),
    gallery_media: z.number().int().positive(),
    gallery_folders: z.number().int().positive(),
  }),
  concurrency: z.strictObject({
    guard: z.literal("snapshot_fingerprint"),
    required_for: z.array(z.enum(["execute", "execute_batch", "preview", "pipeline.start"])),
  }),
  batch: z.strictObject({
    atomic: z.literal(true),
    reference_syntax: z.literal("@alias"),
    excluded_operations: z.array(z.string()),
  }),
  canvas_dag: z.strictObject({
    edge_contract: z.string(),
    analysis: z.tuple([
      z.literal("topological_order"),
      z.literal("parallel_levels"),
      z.literal("roots"),
      z.literal("leaves"),
      z.literal("cycle_path"),
      z.literal("issues"),
    ]),
    layout_operation: z.literal("canvas.dag.layout"),
    layout_directions: z.tuple([z.literal("horizontal"), z.literal("vertical")]),
    layout_contract: z.string(),
    z_order_operations: z.tuple([
      z.literal("canvas.node.bring_to_front"),
      z.literal("canvas.node.send_to_back"),
    ]),
    z_order_observe_field: z.literal("board.nodes[].z_index"),
    z_order_contract: z.string(),
    section_operations: z.tuple([
      z.literal("canvas.section.add"),
      z.literal("canvas.section.update"),
      z.literal("canvas.section.remove"),
      z.literal("canvas.node.assign_section"),
    ]),
    section_contract: z.string(),
    viewport_operations: z.tuple([z.literal("canvas.board.set_viewport"), z.literal("canvas.board.fit_content")]),
    viewport_observe_path: z.literal("board.viewport"),
    viewport_zoom_range: z.tuple([z.literal(0.1), z.literal(2.5)]),
    viewport_fit_defaults: z.strictObject({
      surface_width: z.literal(1_280),
      surface_height: z.literal(800),
      padding: z.literal(120),
      max_zoom: z.literal(1.35),
    }),
    viewport_contract: z.string(),
    script_operation: z.literal("canvas.script.apply_plan"),
    script_contract: z.string(),
    execution_boundary: z.string(),
  }),
  preview: z.strictObject({
    workspaces: z.array(creativeWorkspacePreviewWorkspaceSchema),
    format: z.literal("image/png"),
    clean_frame: z.literal(true),
    mutates_playhead: z.literal(false),
    auto_resolution: z.string(),
    time_semantics: z.string(),
    concurrency_semantics: z.string(),
  }),
  editorial: z.strictObject({
    timebase: z.strictObject({
      source_of_truth: z.literal("edit.settings.timebase"),
      observe_path: z.literal("edit.settings.timebase"),
      update_operation: z.literal("edit.settings.update"),
      rate_contract: z.string(),
      drop_frame_rates: z.tuple([z.literal("30000/1001"), z.literal("60000/1001")]),
      timecode_contract: z.string(),
      example: editSettingsUpdateSchema,
    }),
    timeline_viewport: z.strictObject({
      observe_path: z.literal("edit.timeline_zoom"),
      set_zoom_operation: z.literal("edit.timeline.set_zoom"),
      fit_operation: z.literal("edit.timeline.fit"),
      zoom_range: z.tuple([z.literal(0.5), z.literal(4)]),
      base_pixels_per_second: z.literal(72),
      fit_defaults: z.strictObject({
        surface_width: z.literal(960),
        gutter: z.literal(16),
      }),
      viewport_contract: z.string(),
    }),
    clip_overwrite: z.strictObject({
      operations: z.tuple([
        z.literal("edit.clip.add"),
        z.literal("edit.clip.update"),
        z.literal("edit.clip.move"),
      ]),
      flag: z.literal("overwrite"),
      resolver: z.literal("resolveDirectorTrackOverwrite"),
      receipt_fields: z.tuple([
        z.literal("removed_clip_ids"),
        z.literal("trimmed_clip_ids"),
        z.literal("created_clip_ids"),
      ]),
      overwrite_contract: z.string(),
    }),
    media: z.strictObject({
      observe_path: z.literal("media.assets"),
      observable_fields: z.tuple([
        z.literal("available"),
        z.literal("waveform_ready"),
        z.literal("proxy_of"),
        z.literal("playback_preference"),
        z.literal("proxy_profile"),
      ]),
      attach_proxy_operation: z.literal("media.proxy.attach"),
      set_playback_operation: z.literal("media.playback.update"),
      attach_proxy_example: mediaProxyAttachSchema,
      set_playback_example: mediaPlaybackUpdateSchema,
      offline_relink: z.strictObject({
        supported: z.literal(true),
        execution_surface: z.literal("director_creative media.relink plus Assets panel file picker"),
        director_creative_operation: z.literal("media.relink"),
        reason: z.string(),
      }),
      verify_bytes: z.strictObject({
        director_creative_operation: z.literal("media.verify"),
        example: mediaVerifySchema,
        outcomes: z.tuple([
          z.literal("verified"),
          z.literal("size_mismatch"),
          z.literal("missing_bytes"),
          z.literal("not_cataloged"),
          z.literal("unverified"),
        ]),
        reason: z.string(),
      }),
    }),
    gallery: z.strictObject({
      observe_path: z.literal("gallery"),
      media_operations: z.tuple([
        z.literal("gallery.media.update"),
        z.literal("gallery.media.move"),
        z.literal("gallery.media.trash"),
        z.literal("gallery.media.restore"),
        z.literal("gallery.media.rename_many"),
        z.literal("gallery.media.purge"),
      ]),
      folder_operations: z.tuple([
        z.literal("gallery.folder.add"),
        z.literal("gallery.folder.rename"),
        z.literal("gallery.folder.move"),
        z.literal("gallery.folder.remove"),
      ]),
      preferences_operation: z.literal("gallery.preferences.update"),
      permanent_delete: z.literal("gallery.media.purge"),
      reason: z.string(),
    }),
  }),
  interchange: z.strictObject({
    formats: z.array(
      z.strictObject({
        id: interchangeFormatSchema,
        extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).min(1),
        payload: z.enum(["text", "binary"]),
        scope: z.string(),
      }),
    ),
    directions: z.tuple([z.literal("import"), z.literal("export")]),
    preserves: z.array(z.string()).min(1),
    execution_surface: z.literal("director_creative interchange plus DirectorInterchangeMenu"),
    director_creative_operation: z.literal("interchange"),
    agent_actions: z.tuple([
      z.literal("capabilities"),
      z.literal("plan-export"),
      z.literal("export"),
      z.literal("plan-import"),
      z.literal("import"),
    ]),
    agent_directions: z.tuple([z.literal("export"), z.literal("import")]),
    import_mode: z.literal("agent-transfer"),
    agent_transfer: z.string(),
    reason: z.string(),
  }),
  collaboration: z.strictObject({
    engine: z.literal("Yjs"),
    capabilities: z.array(z.string()).min(1),
    execution_surface: z.literal("director_creative collaboration plus DirectorCollaborationPanel"),
    director_creative_operations: z.tuple([
      z.literal("observe"),
      z.literal("list-comments"),
      z.literal("add-comment"),
      z.literal("resolve-comment"),
      z.literal("reopen-comment"),
      z.literal("update-comment"),
      z.literal("delete-comment"),
      z.literal("list-versions"),
      z.literal("compare"),
      z.literal("create-version"),
      z.literal("restore-version"),
      z.literal("delete-version"),
    ]),
    agent_transfer: z.string(),
    concurrency_guard: z.literal("collaboration_fingerprint"),
    reason: z.string(),
  }),
  pipeline: z.strictObject({
    observe_path: z.literal("board.pipeline_runs"),
    request_op: z.literal("pipeline"),
    configure_operation: z.literal("canvas.production.configure"),
    actions: z.tuple([z.literal("capabilities"), z.literal("start"), z.literal("status"), z.literal("cancel")]),
    execution: z.literal("topological-levels-with-bounded-parallelism"),
    failure_semantics: z.string(),
  }),
  recommended_loop: z.array(z.string()),
});

/**
 * Build the validated capabilities payload. Operation ids and batch
 * exclusions are injected from the live operation registry rather than
 * duplicated in the JSON, so the advertised list is always the parseable
 * list. Throws if the JSON drifts from the schema.
 */
export function getCreativeWorkspaceAgentCapabilities() {
  return creativeWorkspaceAgentCapabilitiesSchema.parse({
    ...creativeWorkspaceAgentCapabilities,
    operation_ids: [...creativeWorkspaceAgentOperationNames],
    batch: {
      ...creativeWorkspaceAgentCapabilities.batch,
      excluded_operations: [...creativeWorkspaceBatchExcludedOperations],
    },
  });
}

// ---------------------------------------------------------------------------
// Preview captures. `op:"preview"` renders a clean PNG frame of the Canvas
// board or Video Editor at the agent's requested state; the capture embeds
// the snapshot fingerprint it was rendered from, and a fingerprint mismatch
// returns a typed `stale_snapshot` failure instead of a misleading image.
// ---------------------------------------------------------------------------

const creativeWorkspacePreviewBoundsSchema = z.strictObject({
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.nonnegative(),
  height: finiteNumber.nonnegative(),
});

const creativeWorkspaceCanvasPreviewMetadataSchema = strictKind("canvas_board", {
  node_count: z.number().int().nonnegative(),
  edge_count: z.number().int().nonnegative(),
  media_thumbnail_count: z.number().int().nonnegative(),
  world_bounds: creativeWorkspacePreviewBoundsSchema,
  render_scale: finiteNumber.positive(),
});

const creativeWorkspaceVideoPreviewMetadataSchema = strictKind("video_frame", {
  time_sec: finiteNumber.nonnegative(),
  fps: finiteNumber.positive(),
  aspect_ratio: editAspectRatioSchema,
  active_layer_count: z.number().int().nonnegative(),
  active_clip_ids: z.array(idSchema),
});

const creativeWorkspacePreviewMetadataSchema = z.discriminatedUnion("kind", [
  creativeWorkspaceCanvasPreviewMetadataSchema,
  creativeWorkspaceVideoPreviewMetadataSchema,
]);

const creativeWorkspacePreviewCaptureSchema = strictSuccess(true, {
  workspace: z.enum(["canvas", "video"]),
  snapshot_fingerprint: snapshotFingerprintSchema,
  mime_type: z.literal("image/png"),
  data_url: z
    .string()
    .max(16_800_000)
    .refine((value) => value.startsWith("data:image/png"), "Expected PNG data URL"),
  width: z.number().int().positive().max(3_840),
  height: z.number().int().positive().max(3_840),
  clean_frame: z.literal(true),
  helpers_included: z.literal(false),
  metadata: creativeWorkspacePreviewMetadataSchema,
});

const creativeWorkspacePreviewFailureSchema = strictSuccess(false, {
  code: z.enum(["stale_snapshot", "render_failed", "aborted"]),
  error: z.string().max(4_000),
  expected_snapshot_fingerprint: snapshotFingerprintSchema,
  current_snapshot_fingerprint: snapshotFingerprintSchema.optional(),
  suggested_next: z.string().max(1_000),
});

/** Preview outcome: a clean-frame PNG capture, or a typed render/staleness failure. */
export const creativeWorkspaceAgentPreviewResultSchema = z.discriminatedUnion("success", [
  creativeWorkspacePreviewCaptureSchema,
  creativeWorkspacePreviewFailureSchema,
]);
export type CreativeWorkspaceAgentPreviewResult = z.infer<typeof creativeWorkspaceAgentPreviewResultSchema>;

// ---------------------------------------------------------------------------
// Tool result envelope: one discriminated union over every request op, so
// transports (MCP, HTTP, DSH plugin) can validate any director_creative
// response with a single schema.
// ---------------------------------------------------------------------------

/** Complete `director_creative` tool result union, discriminated by `op`. */
export const creativeWorkspaceAgentToolResultSchema = z.discriminatedUnion("op", [
  strictOperation("capabilities", { capabilities: creativeWorkspaceAgentCapabilitiesSchema }),
  strictOperation("describe", { description: creativeWorkspaceDescribeResultSchema }),
  strictOperation("observe", { snapshot: creativeWorkspaceAgentSnapshotSchema }),
  strictOperation("execute", { execution: creativeWorkspaceAgentExecutionResultSchema }),
  strictOperation("execute_batch", { execution: creativeWorkspaceAgentExecutionResultSchema }),
  strictOperation("audit", { audit: creativeWorkspaceAuditReceiptSchema }),
  strictOperation("preview", { preview: creativeWorkspaceAgentPreviewResultSchema }),
  creativeWorkspaceInterchangeToolResultSchema,
  creativeWorkspaceCollaborationToolResultSchema,
  creativeWorkspacePipelineToolResultSchema,
]);

export type CreativeWorkspaceAgentToolResult = z.infer<typeof creativeWorkspaceAgentToolResultSchema>;

// Rejection messages must carry the corrective call: name the exact
// unrecognized keys instead of Zod's generic message.
function creativeParseIssueMessage(issue: z.ZodError["issues"][number]): string {
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((key) => `"${key}"`).join(", ");
    return `has unrecognized key(s) ${keys}; remove them and retry`;
  }
  return issue.message;
}

/**
 * Parse an untrusted operation payload into the typed operation union.
 * Failures return dotted-path issues plus a single aggregated error string
 * suitable for a tool rejection message.
 */
export function parseCreativeWorkspaceAgentOperation(input: unknown): CreativeWorkspaceAgentParseResult {
  const parsed = creativeWorkspaceAgentOperationSchema.safeParse(input);
  if (parsed.success) return { success: true, operation: parsed.data };
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.map(String).join(".") : "$",
    message: creativeParseIssueMessage(issue),
  }));
  return {
    success: false,
    code: "invalid_input",
    error: `Invalid creative workspace operation: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    issues,
  };
}

/** Schema-valid empty snapshot for transport tests that must not touch Zustand. */
export function createEmptyCreativeWorkspaceAgentSnapshot(): CreativeWorkspaceAgentSnapshot {
  return creativeWorkspaceAgentSnapshotSchema.parse({
    version: 1,
    snapshot_fingerprint: "creative-revision:v1:fixture",
    workspace: { mode: "canvas", can_undo: false, can_redo: false },
    board: {
      nodes: [],
      edges: [],
      sections: [],
      dag: { valid: true, roots: [], leaves: [], topological_order: [], parallel_levels: [], issues: [] },
      pipeline_runs: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    edit: {
      tracks: [],
      settings: {
        aspect_ratio: "16 / 9",
        fps: 24,
        timebase: {
          rate: "24/1",
          numerator: 24,
          denominator: 1,
          drop_frame: false,
          start_timecode: "00:00:00:00",
        },
        snap_enabled: true,
        export_quality: "preview",
      },
      playhead_sec: 0,
      timeline_zoom: 1,
    },
    selection: { board_node_id: null, clip_id: null },
    media: { status: "idle", storage_mode: "memory", warning: null, error: null, assets: [] },
    gallery: {
      media: [],
      folders: [],
      preferences: {
        view_mode: "grid",
        sort_by: "created",
        sort_direction: "desc",
        thumbnail_size: 160,
        active_folder_id: null,
        include_subfolders: false,
        show_trash: false,
      },
    },
    counts: {
      board_nodes: 0,
      board_edges: 0,
      board_sections: 0,
      pipeline_runs: 0,
      tracks: 0,
      clips: 0,
      media_assets: 0,
      gallery_media: 0,
      gallery_folders: 0,
    },
  });
}
