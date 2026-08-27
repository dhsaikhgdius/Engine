/**
 * Creative Workspace agent contract executor (`director_creative` operations).
 *
 * This is the browser-side engine behind every Canvas / Video Editor /
 * Gallery / media tool call. It re-exports the shared contract schemas from
 * `@director/agent-engine/creative`, projects the live Zustand workspace and
 * persistent media stores into the snake_case snapshot agents observe, and
 * executes the typed operations against those stores.
 *
 * Operation domains handled by the central switch, in source order:
 * - `gallery.*` — Gallery catalog records, folders, trash, and preferences.
 * - `media.*` — playback preference, proxy attachment, and the async
 *   relink/verify pair that needs durable byte IO.
 * - `canvas.*` — board nodes/edges/sections, viewport, DAG layout, the
 *   script-to-canvas plan, and per-node production configs.
 * - `edit.*` — timeline tracks, clips (add/update/move/split/remove),
 *   ripple range edits, settings, seek, and zoom.
 * - `workspace.*` — mode switching and undo/redo.
 *
 * Shared invariants: every mutation is guarded by the caller's expected
 * snapshot fingerprint (checked by the dispatch wrapper) and an idempotency
 * key whose successful receipt is replayed on retry; failures return typed
 * `CreativeWorkspaceAgentErrorCode`s and never partially apply; and each
 * success receipt embeds a fresh post-mutation snapshot so agents never need
 * a second observe round-trip.
 */
import { z } from "zod";
import { buildScriptToCanvasPlan } from "../comprehensive/editor/assistant/scriptToProductionPipeline";
import { analyzeDirectorCanvasDag, wouldCreateDirectorCanvasCycle } from "../comprehensive/editor/workspaces/canvasDag";
import {
  CANVAS_BOARD_FIT_DEFAULT_PADDING,
  CANVAS_BOARD_FIT_DEFAULT_SURFACE_HEIGHT,
  CANVAS_BOARD_FIT_DEFAULT_SURFACE_WIDTH,
  computeCanvasBoardFitViewport,
  normalizeCanvasBoardViewport,
} from "../comprehensive/editor/workspaces/canvasBoardViewport";
import {
  DIRECTOR_TIMELINE_BASE_PIXELS_PER_SECOND,
  DIRECTOR_TIMELINE_FIT_DEFAULT_SURFACE_WIDTH,
  clampDirectorTimelineZoom,
  computeDirectorTimelineFitZoom,
} from "../comprehensive/editor/workspaces/videoTimelineViewport";
import { getDirectorTimelineContentDuration } from "../comprehensive/editor/workspaces/directorTimelineVideoExport";
import {
  createDefaultDirectorCanvasProductionConfig,
  directorCanvasProductionConfigSchema,
} from "../comprehensive/editor/workspaces/canvasPipelineProtocol";
import {
  DIRECTOR_CLIP_EDGE_EPSILON_SEC,
  findDirectorTransitionPredecessor,
  getDirectorCreativeWorkspaceScope,
  getDirectorEditDuration,
  useDirectorCreativeWorkspaceStore,
  type DirectorBoardEdge,
  type DirectorBoardNode,
  type DirectorBoardNodeKind,
  type DirectorBoardSection,
  type DirectorCreativeWorkspaceState,
  type DirectorCanvasPipelineRun,
  type DirectorEditClip,
  type DirectorEditTrack,
  type DirectorTrackOverwriteSummary,
} from "../comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
  type CreativeMediaKind,
  type PersistentCreativeMediaState,
} from "../comprehensive/editor/media/persistentCreativeMediaStore";
import { relinkDirectorCreativeMedia } from "../comprehensive/editor/workspaces/directorMediaLibrary";
import type {
  DirectorGalleryFolder,
  DirectorGalleryMediaRecord,
} from "../comprehensive/editor/workspaces/directorGallery";
import { stableLexicalJson } from "@director/protocol/stableJson";
import {
  frameRateToNumber,
  normalizeDirectorFrameRate,
  normalizeDirectorTimebase,
  serializeDirectorFrameRate,
  supportsDirectorDropFrame,
} from "../comprehensive/editor/timeline/frameRate";
import { parseSmpteTimecode } from "../comprehensive/editor/timeline/timecode";
import {
  auditCreativeWorkspaceSnapshot,
  type CreativeWorkspaceAuditReceipt,
} from "@director/agent-engine/creative-quality";

import {
  creativeWorkspaceCanvasNodePatchSchema as canvasNodePatchSchema,
  creativeWorkspaceEditClipPatchSchema as editClipPatchSchema,
  creativeWorkspaceCollaborationToolResultSchema,
  describeCreativeWorkspaceTarget,
  creativeWorkspaceInterchangeToolResultSchema,
  creativeWorkspaceMediaDurabilityProbeSchema,
  creativeWorkspaceMediaStorageStanzaSchema,
  creativeWorkspaceMediaVerifyResultSchema,
  creativeWorkspacePipelineToolResultSchema,
  creativeWorkspacePipelineRunSchema,
} from "@director/protocol/creativeWorkspaceProtocol";

import {
  creativeWorkspaceAgentExecutionResultSchema,
  creativeWorkspaceAgentPreviewResultSchema,
  creativeWorkspaceAgentRequestSchema,
  creativeWorkspaceAgentOperationNames,
  creativeWorkspaceAgentOperationSchema,
  creativeWorkspaceAgentSnapshotSchema,
  creativeWorkspaceAgentToolResultSchema,
  creativeWorkspaceAgentCapabilitiesSchema,
  getCreativeWorkspaceAgentCapabilities,
  parseCreativeWorkspaceAgentOperation,
  type CreativeWorkspaceAgentErrorCode,
  type CreativeWorkspaceAgentExecutionResult,
  type CreativeWorkspaceAgentOperation,
  type CreativeWorkspaceAgentOperationId,
  type CreativeWorkspaceAgentParseIssue,
  type CreativeWorkspaceAgentParseResult,
  type CreativeWorkspaceAgentPreviewRequest,
  type CreativeWorkspaceAgentPreviewResult,
  type CreativeWorkspaceAgentRequest,
  type CreativeWorkspaceAgentSnapshot,
  type CreativeWorkspaceAgentToolResult,
} from "@director/agent-engine/creative";

export {
  creativeWorkspaceAgentExecutionResultSchema,
  creativeWorkspaceAgentPreviewResultSchema,
  creativeWorkspaceAgentRequestSchema,
  creativeWorkspaceAgentOperationNames,
  creativeWorkspaceAgentOperationSchema,
  creativeWorkspaceAgentSnapshotSchema,
  creativeWorkspaceAgentToolResultSchema,
  getCreativeWorkspaceAgentCapabilities,
  parseCreativeWorkspaceAgentOperation,
};
export type {
  CreativeWorkspaceAgentErrorCode,
  CreativeWorkspaceAgentExecutionResult,
  CreativeWorkspaceAgentOperation,
  CreativeWorkspaceAgentOperationId,
  CreativeWorkspaceAgentParseIssue,
  CreativeWorkspaceAgentParseResult,
  CreativeWorkspaceAgentPreviewRequest,
  CreativeWorkspaceAgentPreviewResult,
  CreativeWorkspaceAgentRequest,
  CreativeWorkspaceAgentSnapshot,
  CreativeWorkspaceAgentToolResult,
};

/**
 * The state bridge every executor call runs against. The default context
 * binds the live browser stores; parity harnesses and tests substitute their
 * own implementations. Optional members degrade gracefully: hosts without
 * `readBlob` get "unverified" durability probes instead of failures.
 */
export interface CreativeWorkspaceAgentContext {
  workspace: { getState(): DirectorCreativeWorkspaceState };
  media: {
    getState(): PersistentCreativeMediaState;
    attachExistingProxy?(originalId: string, proxyId: string): CreativeMediaAsset | null;
    updatePlaybackPreference?(
      id: string,
      preference: NonNullable<CreativeMediaAsset["playbackPreference"]>,
    ): CreativeMediaAsset | null;
    /** Reads the durable bytes behind a cataloged media id; absent when the host cannot probe. */
    readBlob?(id: string): Promise<Blob | null>;
  };
  getScopeId?(): string;
}

const defaultContext: CreativeWorkspaceAgentContext = {
  workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
  media: {
    getState: () => persistentCreativeMediaLibrary.store.getState(),
    attachExistingProxy: (originalId, proxyId) =>
      persistentCreativeMediaLibrary.attachExistingProxy(originalId, proxyId),
    updatePlaybackPreference: (id, preference) =>
      persistentCreativeMediaLibrary.updatePlaybackPreference(id, preference),
    readBlob: (id) => persistentCreativeMediaLibrary.getBlob(id),
  },
  getScopeId: getDirectorCreativeWorkspaceScope,
};

// ---------------------------------------------------------------------------
// Idempotency: retry receipts keyed by (workspace store, scope, key).
// ---------------------------------------------------------------------------

type CreativeMutationResult = Extract<CreativeWorkspaceAgentToolResult, { op: "execute" | "execute_batch" }>;

type CreativeMutationRequest = Extract<CreativeWorkspaceAgentRequest, { op: "execute" | "execute_batch" }>;
type CreativeMutationSuccessReceipt = {
  signature: string;
  snapshotFingerprintAfter: string;
  result: {
    op: CreativeMutationResult["op"];
    execution: Extract<CreativeMutationResult["execution"], { success: true }>;
  };
};
// Keyed weakly by the workspace store object so receipts follow the store's
// lifetime: a test that builds a fresh context starts with a clean slate, and
// dropping the store frees its receipts without explicit cleanup.
const creativeRetryReceipts = new WeakMap<object, Map<string, CreativeMutationSuccessReceipt>>();

function creativeScopeId(context: CreativeWorkspaceAgentContext) {
  return context.getScopeId?.().trim() || "default";
}

function creativeRetryReceiptKey(context: CreativeWorkspaceAgentContext, key: string) {
  return `${creativeScopeId(context)}\u0000${key}`;
}

function creativeRetryReceiptMap(context: CreativeWorkspaceAgentContext) {
  const owner = context.workspace as object;
  let receipts = creativeRetryReceipts.get(owner);
  if (!receipts) {
    receipts = new Map();
    creativeRetryReceipts.set(owner, receipts);
  }
  return receipts;
}

/**
 * Canonical signature of the mutation intent (everything except the
 * idempotency key and fingerprint guard), so a retried key can be verified to
 * carry the same intent and a reused key with different intent is rejected.
 */
function creativeMutationSignature(input: CreativeMutationRequest) {
  const {
    idempotency_key: _idempotencyKey,
    expected_snapshot_fingerprint: _expectedSnapshotFingerprint,
    ...intent
  } = input;
  return stableLexicalJson(intent);
}

/** Store a successful mutation receipt for replay; the map is FIFO-bounded at 128 entries. */
function rememberCreativeMutation(
  context: CreativeWorkspaceAgentContext,
  key: string,
  signature: string,
  result: CreativeMutationResult,
) {
  const execution = result.execution;
  if (!execution.success) return;
  const receipts = creativeRetryReceiptMap(context);
  receipts.set(creativeRetryReceiptKey(context, key), {
    signature,
    snapshotFingerprintAfter: execution.snapshot.snapshot_fingerprint,
    result: structuredClone({ op: result.op, execution }),
  });
  while (receipts.size > 128) receipts.delete(receipts.keys().next().value!);
}

// ---------------------------------------------------------------------------
// Snapshot projections: camelCase store state → snake_case agent wire shapes.
// ---------------------------------------------------------------------------

function projectBoardNode(node: DirectorBoardNode, zIndex: number) {
  const config = node.productionConfig ? directorCanvasProductionConfigSchema.parse(node.productionConfig) : null;
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    body: node.body,
    media_id: node.mediaId,
    section_id: node.sectionId ?? null,
    z_index: zIndex,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    accent: node.accent,
    production: {
      run_id: node.productionRunId ?? null,
      job_id: node.productionJobId ?? null,
      status: node.productionJobStatus ?? null,
      error: node.productionError ?? null,
      config: config
        ? {
            workflow_id: config.workflowId,
            node_ids: config.nodeIds,
            negative_prompt: config.negativePrompt,
            seed: config.seed,
            duration_seconds: config.durationSeconds,
            fps: config.fps,
            audio_mode: config.audioMode,
            sample_rate: config.sampleRate,
            voice: config.voice,
            language: config.language,
            parameters: config.parameters,
          }
        : null,
      outputs: (node.productionHistory ?? []).map((output) => ({
        run_id: output.runId,
        request_fingerprint: output.requestFingerprint,
        status: output.status,
        job_id: output.jobId,
        artifact_id: output.artifactId,
        media_id: output.mediaId,
        workflow_id: output.workflowId,
        node_id: output.nodeId,
        created_at: output.createdAt,
        error: output.error,
      })),
    },
  };
}

function projectBoardSection(section: DirectorBoardSection) {
  return {
    id: section.id,
    kind: section.kind,
    title: section.title,
    collapsed: section.collapsed,
    x: section.x,
    y: section.y,
    width: section.width,
    height: section.height,
    accent: section.accent,
  };
}

function projectBoardEdge(edge: DirectorBoardEdge) {
  return {
    id: edge.id,
    source_node_id: edge.sourceNodeId,
    target_node_id: edge.targetNodeId,
  };
}

function boardNodeZIndex(nodes: readonly DirectorBoardNode[], nodeId: string): number {
  return nodes.findIndex((candidate) => candidate.id === nodeId);
}

function projectCanvasDag(nodes: readonly DirectorBoardNode[], edges: readonly DirectorBoardEdge[]) {
  const analysis = analyzeDirectorCanvasDag(nodes, edges);
  return {
    valid: analysis.valid,
    roots: analysis.roots,
    leaves: analysis.leaves,
    topological_order: analysis.topologicalOrder,
    parallel_levels: analysis.parallelLevels,
    issues: analysis.issues.map((issue) => ({
      code: issue.code,
      edge_id: issue.edgeId,
      node_ids: issue.nodeIds,
    })),
  };
}

/**
 * Project a Canvas pipeline run into its wire shape, schema-validated so a
 * malformed store entry surfaces here rather than in an agent's tool result.
 * Exported because the semantic pipeline executor reuses the same projection.
 */
export function projectCreativeWorkspacePipelineRun(run: DirectorCanvasPipelineRun) {
  return creativeWorkspacePipelineRunSchema.parse({
    version: run.version,
    id: run.id,
    graph_fingerprint: run.graphFingerprint,
    status: run.status,
    started_at: run.startedAt,
    updated_at: run.updatedAt,
    finished_at: run.finishedAt,
    node_runs: run.nodeRuns.map((nodeRun) => ({
      node_id: nodeRun.nodeId,
      status: nodeRun.status,
      request_fingerprint: nodeRun.requestFingerprint,
      job_id: nodeRun.jobId,
      artifact_id: nodeRun.artifactId,
      media_id: nodeRun.mediaId,
      started_at: nodeRun.startedAt,
      finished_at: nodeRun.finishedAt,
      error: nodeRun.error,
    })),
    error: run.error,
  });
}

function projectEditClip(clip: DirectorEditClip) {
  return {
    id: clip.id,
    media_id: clip.mediaId,
    name: clip.name,
    start_sec: clip.startSec,
    duration_sec: clip.durationSec,
    in_sec: clip.inSec,
    source_duration_sec: clip.sourceDurationSec,
    playback_rate: clip.playbackRate,
    opacity: clip.opacity,
    volume: clip.volume,
    fade_in_sec: clip.fadeInSec,
    fade_out_sec: clip.fadeOutSec,
    transition_in_sec: clip.transitionInSec ?? 0,
    scale: clip.scale,
    position_x: clip.positionX,
    position_y: clip.positionY,
    rotation_deg: clip.rotationDeg,
    fit: clip.fit,
  };
}

function projectEditTrack(track: DirectorEditTrack) {
  return {
    id: track.id,
    name: track.name,
    kind: track.kind,
    muted: track.muted,
    locked: track.locked,
    visible: track.visible,
    clips: track.clips.map(projectEditClip),
  };
}

function projectMediaAsset(asset: CreativeMediaAsset) {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    file_name: asset.fileName,
    mime_type: asset.mimeType,
    size: asset.size,
    created_at: asset.createdAt,
    last_modified: asset.lastModified,
    duration_sec: asset.durationSec,
    width: asset.width,
    height: asset.height,
    source: asset.source,
    available: Boolean(asset.objectUrl),
    waveform_ready: Boolean(asset.waveform),
    proxy_of: asset.proxyOf ?? null,
    playback_preference: asset.playbackPreference ?? "auto",
    proxy_profile: asset.proxyProfile
      ? {
          label: asset.proxyProfile.label,
          width: asset.proxyProfile.width,
          height: asset.proxyProfile.height,
          video_bitrate_kbps: asset.proxyProfile.videoBitrateKbps,
          audio_bitrate_kbps: asset.proxyProfile.audioBitrateKbps,
          codec: asset.proxyProfile.codec,
          created_at: asset.proxyProfile.createdAt,
        }
      : null,
  };
}

function projectGalleryMedia(record: DirectorGalleryMediaRecord) {
  return {
    media_id: record.mediaId,
    rating: record.rating,
    tags: [...record.tags],
    color: record.color,
    custom_name: record.customName,
    notes: record.notes,
    folder_id: record.folderId,
    added_at: record.addedAt,
    trashed_at: record.trashedAt,
  };
}

function projectGalleryFolder(folder: DirectorGalleryFolder) {
  return {
    id: folder.id,
    name: folder.name,
    parent_id: folder.parentId,
    created_at: folder.createdAt,
  };
}

const creativeSnapshotRevisions = new WeakMap<object, { content: string; revision: number }>();

/**
 * Mint the snapshot fingerprint: a monotonically increasing revision per
 * workspace store that only advances when the canonical snapshot content
 * actually changes. Two observes of an unchanged workspace return the same
 * fingerprint, which is what makes the mutation guards meaningful.
 */
function creativeSnapshotRevision(context: CreativeWorkspaceAgentContext, value: unknown) {
  const owner = context.workspace as object;
  const content = stableLexicalJson(value);
  const previous = creativeSnapshotRevisions.get(owner);
  if (previous?.content === content) return `creative-revision:v1:${previous.revision}`;
  const revision = (previous?.revision ?? 0) + 1;
  creativeSnapshotRevisions.set(owner, { content, revision });
  return `creative-revision:v1:${revision}`;
}

/**
 * Build the full creative-workspace snapshot an agent observes: board, edit
 * timeline, selection, media library, gallery, and entity counts, stamped
 * with the content-derived fingerprint that mutation guards check against.
 * Read-only — safe to call at any time, including mid-mutation for receipts.
 */
export function observeCreativeWorkspaceAgentSnapshot(
  context: CreativeWorkspaceAgentContext = defaultContext,
): CreativeWorkspaceAgentSnapshot {
  const workspace = context.workspace.getState();
  const media = context.media.getState();
  const editTimebase = normalizeDirectorTimebase(workspace.editSettings.timebase, workspace.editSettings.fps);
  const clipCount = workspace.editTracks.reduce((total, track) => total + track.clips.length, 0);
  const snapshot: CreativeWorkspaceAgentSnapshot = {
    version: 1,
    snapshot_fingerprint: "creative-revision:v1:0",
    workspace: {
      mode: workspace.mode,
      can_undo: workspace.canUndo,
      can_redo: workspace.canRedo,
    },
    board: {
      nodes: workspace.boardNodes.map((node, zIndex) => projectBoardNode(node, zIndex)),
      edges: workspace.boardEdges.map(projectBoardEdge),
      sections: workspace.boardSections.map(projectBoardSection),
      dag: projectCanvasDag(workspace.boardNodes, workspace.boardEdges),
      pipeline_runs: workspace.boardPipelineRuns.map(projectCreativeWorkspacePipelineRun),
      viewport: { ...workspace.boardViewport },
    },
    edit: {
      tracks: workspace.editTracks.map(projectEditTrack),
      settings: {
        aspect_ratio: workspace.editSettings.aspectRatio,
        fps: frameRateToNumber(editTimebase.rate),
        timebase: {
          rate: serializeDirectorFrameRate(editTimebase.rate),
          numerator: editTimebase.rate.numerator,
          denominator: editTimebase.rate.denominator,
          drop_frame: editTimebase.dropFrame,
          start_timecode: editTimebase.startTimecode,
        },
        snap_enabled: workspace.editSettings.snapEnabled,
        export_quality: workspace.editSettings.exportQuality,
      },
      playhead_sec: workspace.playheadSec,
      timeline_zoom: workspace.timelineZoom,
    },
    selection: {
      board_node_id: workspace.selectedBoardNodeId,
      clip_id: workspace.selectedClipId,
    },
    media: {
      status: media.status,
      storage_mode: media.storageMode,
      warning: media.warning,
      error: media.error,
      assets: media.assets.map(projectMediaAsset),
    },
    gallery: {
      media: workspace.galleryMedia.map(projectGalleryMedia),
      folders: workspace.galleryFolders.map(projectGalleryFolder),
      preferences: {
        view_mode: workspace.galleryPrefs.viewMode,
        sort_by: workspace.galleryPrefs.sortBy,
        sort_direction: workspace.galleryPrefs.sortDirection,
        thumbnail_size: workspace.galleryPrefs.thumbnailSize,
        active_folder_id: workspace.galleryPrefs.activeFolderId,
        include_subfolders: workspace.galleryPrefs.includeSubfolders,
        show_trash: workspace.galleryPrefs.showTrash,
      },
    },
    counts: {
      board_nodes: workspace.boardNodes.length,
      board_edges: workspace.boardEdges.length,
      board_sections: workspace.boardSections.length,
      pipeline_runs: workspace.boardPipelineRuns.length,
      tracks: workspace.editTracks.length,
      clips: clipCount,
      media_assets: media.assets.length,
      gallery_media: workspace.galleryMedia.length,
      gallery_folders: workspace.galleryFolders.length,
    },
  };
  snapshot.snapshot_fingerprint = creativeSnapshotRevision(context, {
    mode: snapshot.workspace.mode,
    board: snapshot.board,
    edit: snapshot.edit,
    playhead_sec: snapshot.edit.playhead_sec,
    selection: snapshot.selection,
    media_state: {
      status: snapshot.media.status,
      storage_mode: snapshot.media.storage_mode,
      warning: snapshot.media.warning,
      error: snapshot.media.error,
    },
    media_assets: snapshot.media.assets,
    gallery: snapshot.gallery,
  });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Execution helpers shared by the operation switch.
// ---------------------------------------------------------------------------

/** Typed failure result for a semantically invalid (but well-formed) operation. */
function semanticFailure(
  operation: CreativeWorkspaceAgentOperationId,
  code: Exclude<CreativeWorkspaceAgentErrorCode, "invalid_input">,
  error: string,
): CreativeWorkspaceAgentExecutionResult {
  return { success: false, operation, code, error };
}

/** Success result carrying a fresh post-mutation snapshot so callers skip a second observe. */
function success(
  operation: CreativeWorkspaceAgentOperationId | "batch",
  message: string,
  result: Record<string, unknown>,
  context: CreativeWorkspaceAgentContext,
): CreativeWorkspaceAgentExecutionResult {
  return { success: true, operation, message, result, snapshot: observeCreativeWorkspaceAgentSnapshot(context) };
}

const EMPTY_OVERWRITE_SUMMARY: DirectorTrackOverwriteSummary = {
  removedClipIds: [],
  trimmedClipIds: [],
  createdClipIds: [],
};

/** Receipt fields shared by edit.clip.add/update/move when overwrite runs. */
function overwritePlacementResult(
  overwrite: boolean,
  summary: DirectorTrackOverwriteSummary = EMPTY_OVERWRITE_SUMMARY,
) {
  if (!overwrite) return { overwrite: false as const };
  return {
    overwrite: true as const,
    removed_clip_ids: summary.removedClipIds,
    trimmed_clip_ids: summary.trimmedClipIds,
    created_clip_ids: summary.createdClipIds,
  };
}

function overwritePlacementMessage(base: string, overwrite: boolean, summary: DirectorTrackOverwriteSummary) {
  if (!overwrite) return base;
  const effects = `${summary.removedClipIds.length} removed, ${summary.trimmedClipIds.length} trimmed, ${summary.createdClipIds.length} created`;
  return `${base} with overwrite placement (${effects}).`;
}

function findClip(state: DirectorCreativeWorkspaceState, clipId: string) {
  for (const track of state.editTracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** Segments shorter than this are absorbed by a ripple edit instead of surviving as unusable slivers. */
const RANGE_REMNANT_SEC = 0.1;

type RangeOperationId = "edit.range.remove" | "edit.range.insert_gap";

/**
 * Resolve the tracks a range edit targets. With no explicit ids the edit
 * silently skips locked tracks; with explicit ids a missing or locked track
 * is a hard typed failure, because the caller named it deliberately.
 */
function resolveRangeTracks(
  operationId: RangeOperationId,
  state: DirectorCreativeWorkspaceState,
  trackIds: readonly string[] | undefined,
): { tracks: DirectorEditTrack[] } | CreativeWorkspaceAgentExecutionResult {
  if (!trackIds?.length) {
    return { tracks: state.editTracks.filter((track) => !track.locked) };
  }
  const tracks: DirectorEditTrack[] = [];
  for (const trackId of trackIds) {
    const track = state.editTracks.find((candidate) => candidate.id === trackId);
    if (!track) return semanticFailure(operationId, "not_found", `Edit track "${trackId}" does not exist.`);
    if (track.locked) return semanticFailure(operationId, "locked", `Edit track "${trackId}" is locked.`);
    tracks.push(track);
  }
  return { tracks };
}

interface RangeRemoveTrackSummary {
  track_id: string;
  removed_clip_ids: string[];
  trimmed_clip_ids: string[];
  shifted_clip_ids: string[];
  created_clip_ids: string[];
}

/**
 * Ripple-delete [fromSec, toSec) from one track: clips fully inside the range
 * are removed, clips straddling an edge are trimmed (or split when both a
 * head and a tail survive), and everything after the range shifts left by the
 * range length. Sliver segments shorter than {@link RANGE_REMNANT_SEC} are
 * absorbed rather than kept as unusable fragments.
 */
function rippleRemoveRangeFromTrack(
  state: DirectorCreativeWorkspaceState,
  track: DirectorEditTrack,
  fromSec: number,
  toSec: number,
): RangeRemoveTrackSummary {
  const shift = toSec - fromSec;
  const summary: RangeRemoveTrackSummary = {
    track_id: track.id,
    removed_clip_ids: [],
    trimmed_clip_ids: [],
    shifted_clip_ids: [],
    created_clip_ids: [],
  };
  for (const clip of [...track.clips].sort((left, right) => left.startSec - right.startSec)) {
    const startSec = clip.startSec;
    const endSec = clip.startSec + clip.durationSec;
    if (endSec <= fromSec + RANGE_REMNANT_SEC / 2) continue;
    if (startSec >= toSec - RANGE_REMNANT_SEC / 2) {
      state.updateClip(clip.id, { startSec: Math.max(0, startSec - shift) });
      summary.shifted_clip_ids.push(clip.id);
      continue;
    }
    const headSec = fromSec - startSec;
    const tailSec = endSec - toSec;
    const keepHead = headSec >= RANGE_REMNANT_SEC;
    const keepTail = tailSec >= RANGE_REMNANT_SEC;
    if (!keepHead && !keepTail) {
      state.removeClip(clip.id);
      summary.removed_clip_ids.push(clip.id);
      continue;
    }
    if (keepHead && keepTail) {
      const tail = state.splitClip(clip.id, fromSec);
      if (!tail) throw new Error(`Edit clip "${clip.id}" could not be split at ${fromSec}s.`);
      state.updateClip(tail.id, {
        startSec: fromSec,
        inSec: tail.inSec + shift * tail.playbackRate,
        durationSec: tailSec,
      });
      summary.created_clip_ids.push(tail.id);
      summary.trimmed_clip_ids.push(clip.id, tail.id);
      continue;
    }
    if (keepHead) {
      state.updateClip(clip.id, { durationSec: headSec });
      summary.trimmed_clip_ids.push(clip.id);
      continue;
    }
    state.updateClip(clip.id, {
      startSec: fromSec,
      inSec: clip.inSec + (toSec - startSec) * clip.playbackRate,
      durationSec: tailSec,
    });
    summary.trimmed_clip_ids.push(clip.id);
    summary.shifted_clip_ids.push(clip.id);
  }
  return summary;
}

interface RangeInsertGapTrackSummary {
  track_id: string;
  split_clip_ids: string[];
  created_clip_ids: string[];
  shifted_clip_ids: string[];
}

/**
 * Ripple-insert a gap at atSec on one track: clips starting at or after the
 * point shift right by the gap length, and a clip straddling the point is
 * split so its tail shifts too (unless a side would be a sliver shorter than
 * {@link RANGE_REMNANT_SEC}, in which case the whole clip shifts or stays).
 */
function rippleInsertGapIntoTrack(
  state: DirectorCreativeWorkspaceState,
  track: DirectorEditTrack,
  atSec: number,
  durationSec: number,
): RangeInsertGapTrackSummary {
  const summary: RangeInsertGapTrackSummary = {
    track_id: track.id,
    split_clip_ids: [],
    created_clip_ids: [],
    shifted_clip_ids: [],
  };
  const shiftIds: string[] = [];
  for (const clip of [...track.clips].sort((left, right) => left.startSec - right.startSec)) {
    const startSec = clip.startSec;
    const endSec = clip.startSec + clip.durationSec;
    if (endSec <= atSec + RANGE_REMNANT_SEC / 2) continue;
    if (startSec >= atSec - RANGE_REMNANT_SEC / 2 && startSec < atSec + RANGE_REMNANT_SEC) {
      shiftIds.push(clip.id);
      continue;
    }
    if (startSec >= atSec) {
      shiftIds.push(clip.id);
      continue;
    }
    const headSec = atSec - startSec;
    const tailSec = endSec - atSec;
    if (headSec < RANGE_REMNANT_SEC) {
      shiftIds.push(clip.id);
      continue;
    }
    if (tailSec < RANGE_REMNANT_SEC) continue;
    const tail = state.splitClip(clip.id, atSec);
    if (!tail) throw new Error(`Edit clip "${clip.id}" could not be split at ${atSec}s.`);
    summary.split_clip_ids.push(clip.id);
    summary.created_clip_ids.push(tail.id);
    shiftIds.push(tail.id);
  }
  for (const clipId of shiftIds) {
    const owner = findClip(state, clipId);
    if (!owner) continue;
    state.updateClip(clipId, { startSec: owner.clip.startSec + durationSec });
    summary.shifted_clip_ids.push(clipId);
  }
  return summary;
}

function expectedTrackKind(kind: CreativeMediaKind): "video" | "audio" {
  return kind === "audio" ? "audio" : "video";
}

/** Title and caption clips use virtual `text:` media ids with no Gallery asset. */
function isVirtualTextMediaId(mediaId: string): boolean {
  return mediaId.startsWith("text:");
}

function findMedia(context: CreativeWorkspaceAgentContext, mediaId: string): CreativeMediaAsset | null {
  return context.media.getState().assets.find((asset) => asset.id === mediaId) ?? null;
}

type CreativeMediaDurabilityProbe = z.infer<typeof creativeWorkspaceMediaDurabilityProbeSchema>;

/** Storage stanza for probed media receipts; memory mode does not survive a reload. */
function creativeMediaStorageStanza(
  context: CreativeWorkspaceAgentContext,
): z.infer<typeof creativeWorkspaceMediaStorageStanzaSchema> {
  const state = context.media.getState();
  return creativeWorkspaceMediaStorageStanzaSchema.parse({
    mode: state.storageMode,
    durable: state.storageMode === "indexeddb",
    warning: state.warning,
  });
}

/**
 * Probes one cataloged media id against the durable backend instead of
 * trusting catalog metadata: bytes are read back and compared to the cataloged
 * size, and hosts that cannot read blobs stamp a typed omit reason.
 */
async function probeCreativeMediaDurability(
  context: CreativeWorkspaceAgentContext,
  mediaId: string,
): Promise<CreativeMediaDurabilityProbe> {
  const asset = findMedia(context, mediaId);
  if (!asset) {
    return {
      media_id: mediaId,
      outcome: "not_cataloged",
      cataloged_bytes: null,
      stored_bytes: null,
      object_url_present: null,
      proxy_of: null,
      omit_reason: null,
      detail: "This id is not in the persistent media library; import or relink it before verifying bytes.",
    };
  }
  const base = {
    media_id: mediaId,
    cataloged_bytes: asset.size,
    object_url_present: Boolean(asset.objectUrl),
    proxy_of: asset.proxyOf ?? null,
  };
  const readBlob = context.media.readBlob;
  if (!readBlob) {
    return {
      ...base,
      outcome: "unverified",
      stored_bytes: null,
      omit_reason: "blob_reader_unavailable",
      detail: "This creative media context cannot read durable blobs; byte presence was not probed.",
    };
  }
  try {
    const blob = await readBlob(mediaId);
    if (!blob) {
      return {
        ...base,
        outcome: "missing_bytes",
        stored_bytes: null,
        omit_reason: null,
        detail: "The durable store returned no bytes for this cataloged id; relink the source file.",
      };
    }
    return {
      ...base,
      outcome: blob.size === asset.size ? "verified" : "size_mismatch",
      stored_bytes: blob.size,
      omit_reason: null,
      detail: null,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "unverified",
      stored_bytes: null,
      omit_reason: "probe_failed",
      detail: `Durable byte probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Count live references to a media id across board nodes and timeline clips. */
function directWorkspaceMediaReferenceCount(state: DirectorCreativeWorkspaceState, mediaId: string): number {
  const boardReferences = state.boardNodes.filter((node) => node.mediaId === mediaId).length;
  const clipReferences = state.editTracks.reduce(
    (total, track) => total + track.clips.filter((clip) => clip.mediaId === mediaId).length,
    0,
  );
  return boardReferences + clipReferences;
}

/**
 * A media id counts as "known" when it has a Gallery record, a cataloged
 * asset, or a live workspace reference — Gallery operations accept any of
 * the three so records can be attached to media the catalog lost track of.
 */
function isKnownGalleryMedia(
  state: DirectorCreativeWorkspaceState,
  context: CreativeWorkspaceAgentContext,
  mediaId: string,
) {
  return (
    state.galleryMedia.some((record) => record.mediaId === mediaId) ||
    context.media.getState().assets.some((asset) => asset.id === mediaId) ||
    directWorkspaceMediaReferenceCount(state, mediaId) > 0
  );
}

function unknownGalleryMediaIds(
  state: DirectorCreativeWorkspaceState,
  context: CreativeWorkspaceAgentContext,
  mediaIds: readonly string[],
) {
  return [...new Set(mediaIds)].filter((mediaId) => !isKnownGalleryMedia(state, context, mediaId));
}

function projectGalleryPreferences(state: DirectorCreativeWorkspaceState) {
  return {
    view_mode: state.galleryPrefs.viewMode,
    sort_by: state.galleryPrefs.sortBy,
    sort_direction: state.galleryPrefs.sortDirection,
    thumbnail_size: state.galleryPrefs.thumbnailSize,
    active_folder_id: state.galleryPrefs.activeFolderId,
    include_subfolders: state.galleryPrefs.includeSubfolders,
    show_trash: state.galleryPrefs.showTrash,
  };
}

/**
 * Validate a board node's media reference against its kind: note/frame nodes
 * may not carry media, media-bearing kinds require an existing asset of the
 * matching kind, and shot nodes are exempt (their media is pipeline-owned).
 * Returns a typed failure, or null when the reference is acceptable.
 */
function validateNodeMedia(
  operation: CreativeWorkspaceAgentOperationId,
  kind: DirectorBoardNodeKind,
  mediaId: string | null,
  context: CreativeWorkspaceAgentContext,
): CreativeWorkspaceAgentExecutionResult | null {
  if (!mediaId || kind === "shot") return null;
  if (kind === "note" || kind === "frame") {
    return semanticFailure(operation, "conflict", `Canvas ${kind} nodes cannot reference media assets.`);
  }
  const asset = findMedia(context, mediaId);
  if (!asset) return semanticFailure(operation, "not_found", `Media asset "${mediaId}" does not exist.`);
  if (asset.kind !== kind) {
    return semanticFailure(
      operation,
      "conflict",
      `Canvas ${kind} node requires ${kind} media, but "${mediaId}" is ${asset.kind}.`,
    );
  }
  return null;
}

/** Map a snake_case node patch to store field names, only carrying keys the caller set. */
function mapNodePatch(patch: z.infer<typeof canvasNodePatchSchema>): Partial<Omit<DirectorBoardNode, "id">> {
  return {
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "media_id") ? { mediaId: patch.media_id ?? null } : {}),
    ...(patch.x !== undefined ? { x: patch.x } : {}),
    ...(patch.y !== undefined ? { y: patch.y } : {}),
    ...(patch.width !== undefined ? { width: patch.width } : {}),
    ...(patch.height !== undefined ? { height: patch.height } : {}),
    ...(patch.accent !== undefined ? { accent: patch.accent } : {}),
  };
}

/** Map a snake_case clip patch to store field names, only carrying keys the caller set. */
function mapClipPatch(patch: z.infer<typeof editClipPatchSchema>): Partial<Omit<DirectorEditClip, "id">> {
  return {
    ...(patch.media_id !== undefined ? { mediaId: patch.media_id } : {}),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.start_sec !== undefined ? { startSec: patch.start_sec } : {}),
    ...(patch.duration_sec !== undefined ? { durationSec: patch.duration_sec } : {}),
    ...(patch.in_sec !== undefined ? { inSec: patch.in_sec } : {}),
    ...(patch.source_duration_sec !== undefined ? { sourceDurationSec: patch.source_duration_sec } : {}),
    ...(patch.playback_rate !== undefined ? { playbackRate: patch.playback_rate } : {}),
    ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}),
    ...(patch.volume !== undefined ? { volume: patch.volume } : {}),
    ...(patch.fade_in_sec !== undefined ? { fadeInSec: patch.fade_in_sec } : {}),
    ...(patch.fade_out_sec !== undefined ? { fadeOutSec: patch.fade_out_sec } : {}),
    ...(patch.transition_in_sec !== undefined ? { transitionInSec: patch.transition_in_sec } : {}),
    ...(patch.scale !== undefined ? { scale: patch.scale } : {}),
    ...(patch.position_x !== undefined ? { positionX: patch.position_x } : {}),
    ...(patch.position_y !== undefined ? { positionY: patch.position_y } : {}),
    ...(patch.rotation_deg !== undefined ? { rotationDeg: patch.rotation_deg } : {}),
    ...(patch.fit !== undefined ? { fit: patch.fit } : {}),
  };
}

/**
 * Execute one typed creative-workspace operation against the live stores.
 *
 * Parses untrusted input first (typed `invalid_input` on failure), then
 * dispatches on the operation id. Synchronous by design — operations needing
 * durable IO (media.relink / media.verify) are rejected here with a pointer
 * to {@link executeCreativeWorkspaceAgentOperationAsync}. Semantic failures
 * (missing entities, locked tracks, kind conflicts, DAG cycles) return typed
 * codes without mutating anything; successes embed a fresh snapshot.
 */
export function executeCreativeWorkspaceAgentOperation(
  input: unknown,
  context: CreativeWorkspaceAgentContext = defaultContext,
): CreativeWorkspaceAgentExecutionResult {
  const parsed = parseCreativeWorkspaceAgentOperation(input);
  if (!parsed.success) {
    return {
      success: false,
      operation: null,
      code: parsed.code,
      error: parsed.error,
      issues: parsed.issues,
    };
  }
  const operation = parsed.operation;
  const state = context.workspace.getState();

  switch (operation.op) {
    // -- Gallery: catalog records, folders, trash lifecycle, preferences. ---
    case "gallery.media.update": {
      if (!isKnownGalleryMedia(state, context, operation.media_id)) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Gallery media "${operation.media_id}" is not cataloged, imported, or referenced by this project.`,
        );
      }
      if (
        operation.patch.folder_id !== undefined &&
        operation.patch.folder_id !== null &&
        !state.galleryFolders.some((folder) => folder.id === operation.patch.folder_id)
      ) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Gallery folder "${operation.patch.folder_id}" does not exist.`,
        );
      }
      state.updateGalleryMedia(operation.media_id, {
        ...(operation.patch.rating !== undefined ? { rating: operation.patch.rating } : {}),
        ...(operation.patch.tags !== undefined ? { tags: operation.patch.tags } : {}),
        ...(operation.patch.color !== undefined ? { color: operation.patch.color } : {}),
        ...(operation.patch.custom_name !== undefined ? { customName: operation.patch.custom_name } : {}),
        ...(operation.patch.notes !== undefined ? { notes: operation.patch.notes } : {}),
        ...(operation.patch.folder_id !== undefined ? { folderId: operation.patch.folder_id } : {}),
        ...(operation.patch.added_at !== undefined ? { addedAt: operation.patch.added_at } : {}),
      });
      const record = context.workspace
        .getState()
        .galleryMedia.find((candidate) => candidate.mediaId === operation.media_id);
      return success(
        operation.op,
        `Updated Gallery metadata for "${operation.media_id}".`,
        { media_id: operation.media_id, record: record ? projectGalleryMedia(record) : null },
        context,
      );
    }
    case "gallery.media.move": {
      const unknownIds = unknownGalleryMediaIds(state, context, operation.media_ids);
      if (unknownIds.length) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Gallery media does not exist: ${unknownIds.map((id) => `"${id}"`).join(", ")}.`,
        );
      }
      if (operation.folder_id && !state.galleryFolders.some((folder) => folder.id === operation.folder_id)) {
        return semanticFailure(operation.op, "not_found", `Gallery folder "${operation.folder_id}" does not exist.`);
      }
      const mediaIds = [...new Set(operation.media_ids)];
      state.moveGalleryMedia(mediaIds, operation.folder_id);
      const records = context.workspace
        .getState()
        .galleryMedia.filter((record) => mediaIds.includes(record.mediaId))
        .map(projectGalleryMedia);
      return success(
        operation.op,
        `Moved ${mediaIds.length} Gallery media item${mediaIds.length === 1 ? "" : "s"}.`,
        { media_ids: mediaIds, folder_id: operation.folder_id, records },
        context,
      );
    }
    case "gallery.media.trash": {
      const unknownIds = unknownGalleryMediaIds(state, context, operation.media_ids);
      if (unknownIds.length) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Gallery media does not exist: ${unknownIds.map((id) => `"${id}"`).join(", ")}.`,
        );
      }
      const mediaIds = [...new Set(operation.media_ids)];
      state.trashGalleryMedia(mediaIds);
      const records = context.workspace
        .getState()
        .galleryMedia.filter((record) => mediaIds.includes(record.mediaId))
        .map(projectGalleryMedia);
      return success(
        operation.op,
        `Moved ${mediaIds.length} Gallery media item${mediaIds.length === 1 ? "" : "s"} to Trash.`,
        { media_ids: mediaIds, records },
        context,
      );
    }
    case "gallery.media.restore": {
      const unknownIds = unknownGalleryMediaIds(state, context, operation.media_ids);
      if (unknownIds.length) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Gallery media does not exist: ${unknownIds.map((id) => `"${id}"`).join(", ")}.`,
        );
      }
      const mediaIds = [...new Set(operation.media_ids)];
      state.restoreGalleryMedia(mediaIds);
      const records = context.workspace
        .getState()
        .galleryMedia.filter((record) => mediaIds.includes(record.mediaId))
        .map(projectGalleryMedia);
      return success(
        operation.op,
        `Restored ${mediaIds.length} Gallery media item${mediaIds.length === 1 ? "" : "s"}.`,
        { media_ids: mediaIds, records },
        context,
      );
    }
    case "gallery.media.purge": {
      const unknownIds = unknownGalleryMediaIds(state, context, operation.media_ids);
      if (unknownIds.length) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Gallery media does not exist: ${unknownIds.map((id) => `"${id}"`).join(", ")}.`,
        );
      }
      const mediaIds = [...new Set(operation.media_ids)];
      const referenced = mediaIds.filter((mediaId) => directWorkspaceMediaReferenceCount(state, mediaId) > 0);
      if (referenced.length) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Cannot permanently delete media still referenced by Canvas/Video: ${referenced.map((id) => `"${id}"`).join(", ")}.`,
        );
      }
      state.purgeGalleryMedia(mediaIds);
      for (const mediaId of mediaIds) {
        void persistentCreativeMediaLibrary.remove(mediaId);
      }
      return success(
        operation.op,
        `Permanently deleted ${mediaIds.length} Gallery media item${mediaIds.length === 1 ? "" : "s"}.`,
        { media_ids: mediaIds, confirm: true },
        context,
      );
    }
    case "gallery.media.rename_many": {
      const unknownIds = unknownGalleryMediaIds(
        state,
        context,
        operation.renames.map((rename) => rename.media_id),
      );
      if (unknownIds.length) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Gallery media does not exist: ${unknownIds.map((id) => `"${id}"`).join(", ")}.`,
        );
      }
      state.beginHistoryBatch();
      try {
        operation.renames.forEach((rename) =>
          state.updateGalleryMedia(rename.media_id, { customName: rename.custom_name }),
        );
        state.endHistoryBatch();
      } catch (error) {
        state.rollbackHistoryBatch();
        return semanticFailure(
          operation.op,
          "operation_rejected",
          `Gallery batch rename failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const renamedIds = operation.renames.map((rename) => rename.media_id);
      const records = context.workspace
        .getState()
        .galleryMedia.filter((record) => renamedIds.includes(record.mediaId))
        .map(projectGalleryMedia);
      return success(
        operation.op,
        `Renamed ${records.length} Gallery media item${records.length === 1 ? "" : "s"}.`,
        { records },
        context,
      );
    }
    case "gallery.folder.add": {
      if (operation.parent_id && !state.galleryFolders.some((folder) => folder.id === operation.parent_id)) {
        return semanticFailure(operation.op, "not_found", `Gallery folder "${operation.parent_id}" does not exist.`);
      }
      const folder = state.createGalleryFolder(operation.name, operation.parent_id ?? null);
      if (!folder) {
        return semanticFailure(
          operation.op,
          state.galleryFolders.length >= 200 ? "capacity" : "conflict",
          state.galleryFolders.length >= 200
            ? "The Gallery has reached its 200-folder limit."
            : `A Gallery folder named "${operation.name}" already exists at that level.`,
        );
      }
      return success(
        operation.op,
        `Created Gallery folder "${folder.name}".`,
        { folder: projectGalleryFolder(folder) },
        context,
      );
    }
    case "gallery.folder.rename": {
      const folder = state.galleryFolders.find((candidate) => candidate.id === operation.folder_id);
      if (!folder)
        return semanticFailure(operation.op, "not_found", `Gallery folder "${operation.folder_id}" does not exist.`);
      state.renameGalleryFolder(folder.id, operation.name);
      const updated = context.workspace.getState().galleryFolders.find((candidate) => candidate.id === folder.id);
      if (!updated || updated.name !== operation.name) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Gallery folder "${operation.name}" conflicts with another folder at that level.`,
        );
      }
      return success(
        operation.op,
        `Renamed Gallery folder to "${updated.name}".`,
        { folder: projectGalleryFolder(updated) },
        context,
      );
    }
    case "gallery.folder.move": {
      const folder = state.galleryFolders.find((candidate) => candidate.id === operation.folder_id);
      if (!folder)
        return semanticFailure(operation.op, "not_found", `Gallery folder "${operation.folder_id}" does not exist.`);
      if (operation.parent_id && !state.galleryFolders.some((candidate) => candidate.id === operation.parent_id)) {
        return semanticFailure(operation.op, "not_found", `Gallery folder "${operation.parent_id}" does not exist.`);
      }
      state.moveGalleryFolder(folder.id, operation.parent_id);
      const updated = context.workspace.getState().galleryFolders.find((candidate) => candidate.id === folder.id);
      if (!updated || updated.parentId !== operation.parent_id) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Gallery folder "${folder.id}" cannot be moved beneath itself or one of its descendants.`,
        );
      }
      return success(
        operation.op,
        `Moved Gallery folder "${updated.name}".`,
        { folder: projectGalleryFolder(updated) },
        context,
      );
    }
    case "gallery.folder.remove": {
      const folder = state.galleryFolders.find((candidate) => candidate.id === operation.folder_id);
      if (!folder)
        return semanticFailure(operation.op, "not_found", `Gallery folder "${operation.folder_id}" does not exist.`);
      state.removeGalleryFolder(folder.id);
      return success(
        operation.op,
        `Removed Gallery folder "${folder.name}" and moved its contents to the parent level.`,
        { removed_id: folder.id },
        context,
      );
    }
    case "gallery.preferences.update": {
      if (
        operation.patch.active_folder_id !== undefined &&
        operation.patch.active_folder_id !== null &&
        !state.galleryFolders.some((folder) => folder.id === operation.patch.active_folder_id)
      ) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Gallery folder "${operation.patch.active_folder_id}" does not exist.`,
        );
      }
      state.updateGalleryPrefs({
        ...(operation.patch.view_mode !== undefined ? { viewMode: operation.patch.view_mode } : {}),
        ...(operation.patch.sort_by !== undefined ? { sortBy: operation.patch.sort_by } : {}),
        ...(operation.patch.sort_direction !== undefined ? { sortDirection: operation.patch.sort_direction } : {}),
        ...(operation.patch.thumbnail_size !== undefined ? { thumbnailSize: operation.patch.thumbnail_size } : {}),
        ...(operation.patch.active_folder_id !== undefined ? { activeFolderId: operation.patch.active_folder_id } : {}),
        ...(operation.patch.include_subfolders !== undefined
          ? { includeSubfolders: operation.patch.include_subfolders }
          : {}),
        ...(operation.patch.show_trash !== undefined ? { showTrash: operation.patch.show_trash } : {}),
      });
      const preferences = projectGalleryPreferences(context.workspace.getState());
      return success(operation.op, "Updated Gallery preferences.", { preferences }, context);
    }
    // -- Media: playback preference, proxies, durable relink/verify. --------
    case "media.playback.update": {
      const media = findMedia(context, operation.media_id);
      if (!media) {
        return semanticFailure(operation.op, "not_found", `Media asset "${operation.media_id}" does not exist.`);
      }
      if (media.proxyOf) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Media asset "${media.id}" is a proxy; playback preference must be set on its original asset.`,
        );
      }
      if (operation.preference === "proxy") {
        const availableProxy = context.media
          .getState()
          .assets.some((asset) => asset.proxyOf === media.id && asset.kind === media.kind && Boolean(asset.objectUrl));
        if (!availableProxy) {
          return semanticFailure(
            operation.op,
            "conflict",
            `Media asset "${media.id}" has no available attached proxy.`,
          );
        }
      }
      if (!context.media.updatePlaybackPreference) {
        return semanticFailure(
          operation.op,
          "operation_rejected",
          "This creative media context cannot persist playback preferences.",
        );
      }
      const previousPreference = media.playbackPreference ?? "auto";
      try {
        context.media.updatePlaybackPreference(media.id, operation.preference);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return semanticFailure(operation.op, "operation_rejected", `Playback preference update failed: ${message}`);
      }
      const updated = findMedia(context, media.id);
      if (!updated || (updated.playbackPreference ?? "auto") !== operation.preference) {
        return semanticFailure(
          operation.op,
          "operation_rejected",
          `Playback preference for media asset "${media.id}" could not be verified after the update.`,
        );
      }
      return success(
        operation.op,
        `Set "${media.name}" playback preference to ${operation.preference}.`,
        {
          media: projectMediaAsset(updated),
          previous_preference: previousPreference,
          changed: previousPreference !== operation.preference,
        },
        context,
      );
    }
    case "media.proxy.attach": {
      const original = findMedia(context, operation.original_media_id);
      if (!original) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Original media asset "${operation.original_media_id}" does not exist.`,
        );
      }
      const proxy = findMedia(context, operation.proxy_media_id);
      if (!proxy) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Proxy media asset "${operation.proxy_media_id}" does not exist.`,
        );
      }
      if (original.proxyOf) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Media asset "${original.id}" is already a proxy and cannot own another proxy.`,
        );
      }
      if (original.kind !== proxy.kind) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Proxy media kind ${proxy.kind} does not match original media kind ${original.kind}.`,
        );
      }
      if (proxy.proxyOf && proxy.proxyOf !== original.id) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Proxy media asset "${proxy.id}" is already attached to original "${proxy.proxyOf}".`,
        );
      }
      const proxyDependents = context.media.getState().assets.filter((asset) => asset.proxyOf === proxy.id);
      if (proxyDependents.length) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Media asset "${proxy.id}" already owns ${proxyDependents.length} proxy asset(s) and cannot become a proxy.`,
        );
      }
      const directReferenceCount = directWorkspaceMediaReferenceCount(state, proxy.id);
      if (proxy.proxyOf !== original.id && directReferenceCount > 0) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Proxy candidate "${proxy.id}" has ${directReferenceCount} direct workspace reference(s); replace those references before attaching it as a proxy.`,
        );
      }
      if (!context.media.attachExistingProxy) {
        return semanticFailure(
          operation.op,
          "operation_rejected",
          "This creative media context cannot persist existing proxy relationships.",
        );
      }
      const previousProxyOf = proxy.proxyOf ?? null;
      try {
        context.media.attachExistingProxy(original.id, proxy.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return semanticFailure(operation.op, "operation_rejected", `Proxy attachment failed: ${message}`);
      }
      const updatedOriginal = findMedia(context, original.id);
      const updatedProxy = findMedia(context, proxy.id);
      if (!updatedOriginal || !updatedProxy || updatedProxy.proxyOf !== updatedOriginal.id) {
        return semanticFailure(
          operation.op,
          "operation_rejected",
          `Proxy relationship "${original.id}" → "${proxy.id}" could not be verified after the update.`,
        );
      }
      return success(
        operation.op,
        `Attached "${proxy.name}" as a proxy for "${original.name}".`,
        {
          original: projectMediaAsset(updatedOriginal),
          proxy: projectMediaAsset(updatedProxy),
          previous_proxy_of: previousProxyOf,
          changed: previousProxyOf !== original.id,
        },
        context,
      );
    }
    case "media.relink": {
      return semanticFailure(
        operation.op,
        "operation_rejected",
        "media.relink requires durable media IO; dispatch it through executeCreativeWorkspaceAgentOperationAsync.",
      );
    }
    case "media.verify": {
      return semanticFailure(
        operation.op,
        "operation_rejected",
        "media.verify reads durable media bytes; dispatch it through executeCreativeWorkspaceAgentOperationAsync.",
      );
    }
    // -- Canvas: board nodes, sections, edges, viewport, DAG, production. ---
    case "canvas.node.add": {
      if (state.boardNodes.length >= 240) {
        return semanticFailure(
          operation.op,
          "capacity",
          "The Canvas has reached its 240-node limit. Remove or consolidate nodes before adding another.",
        );
      }
      const mediaFailure = validateNodeMedia(operation.op, operation.kind, operation.media_id ?? null, context);
      if (mediaFailure) return mediaFailure;
      const node = state.addBoardNode({
        kind: operation.kind,
        title: operation.title,
        body: operation.body,
        mediaId: operation.media_id,
        x: operation.x,
        y: operation.y,
        width: operation.width,
        height: operation.height,
        accent: operation.accent,
      });
      if (!node) {
        return semanticFailure(operation.op, "capacity", "The Canvas cannot accept another node.");
      }
      const after = context.workspace.getState().boardNodes;
      return success(
        operation.op,
        `Added canvas node "${node.title}".`,
        { node: projectBoardNode(node, boardNodeZIndex(after, node.id)) },
        context,
      );
    }
    case "canvas.node.update": {
      const node = state.boardNodes.find((candidate) => candidate.id === operation.node_id);
      if (!node)
        return semanticFailure(operation.op, "not_found", `Canvas node "${operation.node_id}" does not exist.`);
      const nextKind = operation.patch.kind ?? node.kind;
      const nextMediaId = Object.prototype.hasOwnProperty.call(operation.patch, "media_id")
        ? (operation.patch.media_id ?? null)
        : node.mediaId;
      const mediaFailure = validateNodeMedia(operation.op, nextKind, nextMediaId, context);
      if (mediaFailure) return mediaFailure;
      state.updateBoardNode(node.id, mapNodePatch(operation.patch));
      const after = context.workspace.getState().boardNodes;
      const updated = after.find((candidate) => candidate.id === node.id)!;
      return success(
        operation.op,
        `Updated canvas node "${updated.title}".`,
        { node: projectBoardNode(updated, boardNodeZIndex(after, updated.id)) },
        context,
      );
    }
    case "canvas.node.remove": {
      const node = state.boardNodes.find((candidate) => candidate.id === operation.node_id);
      if (!node)
        return semanticFailure(operation.op, "not_found", `Canvas node "${operation.node_id}" does not exist.`);
      state.removeBoardNode(node.id);
      return success(operation.op, `Removed canvas node "${node.title}".`, { removed_id: node.id }, context);
    }
    case "canvas.node.bring_to_front": {
      const index = state.boardNodes.findIndex((candidate) => candidate.id === operation.node_id);
      if (index < 0) {
        return semanticFailure(operation.op, "not_found", `Canvas node "${operation.node_id}" does not exist.`);
      }
      const node = state.boardNodes[index]!;
      const alreadyFront = index === state.boardNodes.length - 1;
      if (!alreadyFront) state.bringBoardNodeToFront(node.id);
      const after = context.workspace.getState().boardNodes;
      const zIndex = boardNodeZIndex(after, node.id);
      return success(
        operation.op,
        alreadyFront
          ? `Canvas node "${node.title}" is already at the front of the board z-order.`
          : `Brought canvas node "${node.title}" to the front of the board z-order.`,
        {
          node: projectBoardNode(after.find((candidate) => candidate.id === node.id) ?? node, zIndex),
          z_index: zIndex,
          previous_z_index: index,
          already_front: alreadyFront,
        },
        context,
      );
    }
    case "canvas.node.send_to_back": {
      const index = state.boardNodes.findIndex((candidate) => candidate.id === operation.node_id);
      if (index < 0) {
        return semanticFailure(operation.op, "not_found", `Canvas node "${operation.node_id}" does not exist.`);
      }
      const node = state.boardNodes[index]!;
      const alreadyBack = index === 0;
      if (!alreadyBack) state.sendBoardNodeToBack(node.id);
      const after = context.workspace.getState().boardNodes;
      const zIndex = boardNodeZIndex(after, node.id);
      return success(
        operation.op,
        alreadyBack
          ? `Canvas node "${node.title}" is already at the back of the board z-order.`
          : `Sent canvas node "${node.title}" to the back of the board z-order.`,
        {
          node: projectBoardNode(after.find((candidate) => candidate.id === node.id) ?? node, zIndex),
          z_index: zIndex,
          previous_z_index: index,
          already_back: alreadyBack,
        },
        context,
      );
    }
    case "canvas.node.assign_section": {
      const node = state.boardNodes.find((candidate) => candidate.id === operation.node_id);
      if (!node) {
        return semanticFailure(operation.op, "not_found", `Canvas node "${operation.node_id}" does not exist.`);
      }
      if (
        operation.section_id !== null &&
        !state.boardSections.some((section) => section.id === operation.section_id)
      ) {
        return semanticFailure(operation.op, "not_found", `Canvas section "${operation.section_id}" does not exist.`);
      }
      const previousSectionId = node.sectionId ?? null;
      const zIndex = boardNodeZIndex(state.boardNodes, node.id);
      if (previousSectionId === operation.section_id) {
        return success(
          operation.op,
          `Canvas node "${node.title}" already has the requested section assignment.`,
          {
            node: projectBoardNode(node, zIndex),
            previous_section_id: previousSectionId,
            section_id: operation.section_id,
            unchanged: true,
          },
          context,
        );
      }
      state.assignBoardNodeSection(node.id, operation.section_id);
      const after = context.workspace.getState().boardNodes;
      const updated = after.find((candidate) => candidate.id === node.id)!;
      return success(
        operation.op,
        operation.section_id
          ? `Assigned canvas node "${node.title}" to section "${operation.section_id}".`
          : `Cleared the section assignment for canvas node "${node.title}".`,
        {
          node: projectBoardNode(updated, boardNodeZIndex(after, updated.id)),
          previous_section_id: previousSectionId,
          section_id: operation.section_id,
          unchanged: false,
        },
        context,
      );
    }
    case "canvas.section.add": {
      if (state.boardSections.length >= 32) {
        return semanticFailure(
          operation.op,
          "capacity",
          "The Canvas has reached its 32-section limit. Remove or consolidate sections before adding another.",
        );
      }
      const section = state.addBoardSection({
        kind: operation.kind,
        title: operation.title,
        x: operation.x,
        y: operation.y,
        width: operation.width,
        height: operation.height,
        accent: operation.accent,
        collapsed: operation.collapsed,
      });
      if (!section) {
        return semanticFailure(operation.op, "capacity", "The Canvas cannot accept another section.");
      }
      return success(
        operation.op,
        `Added canvas section "${section.title}".`,
        { section: projectBoardSection(section) },
        context,
      );
    }
    case "canvas.section.update": {
      const section = state.boardSections.find((candidate) => candidate.id === operation.section_id);
      if (!section) {
        return semanticFailure(operation.op, "not_found", `Canvas section "${operation.section_id}" does not exist.`);
      }
      state.updateBoardSection(section.id, {
        ...(operation.patch.kind === undefined ? {} : { kind: operation.patch.kind }),
        ...(operation.patch.title === undefined ? {} : { title: operation.patch.title }),
        ...(operation.patch.x === undefined ? {} : { x: operation.patch.x }),
        ...(operation.patch.y === undefined ? {} : { y: operation.patch.y }),
        ...(operation.patch.width === undefined ? {} : { width: operation.patch.width }),
        ...(operation.patch.height === undefined ? {} : { height: operation.patch.height }),
        ...(operation.patch.accent === undefined ? {} : { accent: operation.patch.accent }),
        ...(operation.patch.collapsed === undefined ? {} : { collapsed: operation.patch.collapsed }),
      });
      const updated = context.workspace.getState().boardSections.find((candidate) => candidate.id === section.id)!;
      return success(
        operation.op,
        `Updated canvas section "${updated.title}".`,
        { section: projectBoardSection(updated) },
        context,
      );
    }
    case "canvas.section.remove": {
      const section = state.boardSections.find((candidate) => candidate.id === operation.section_id);
      if (!section) {
        return semanticFailure(operation.op, "not_found", `Canvas section "${operation.section_id}" does not exist.`);
      }
      state.removeBoardSection(section.id);
      return success(operation.op, `Removed canvas section "${section.title}".`, { removed_id: section.id }, context);
    }
    case "canvas.board.set_viewport": {
      const previous = { ...state.boardViewport };
      const viewport = normalizeCanvasBoardViewport({
        x: operation.x,
        y: operation.y,
        zoom: operation.zoom,
      });
      const unchanged = previous.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom;
      if (!unchanged) state.setBoardViewport(viewport);
      const after = context.workspace.getState().boardViewport;
      return success(
        operation.op,
        unchanged
          ? "Canvas board viewport already matches the requested pan/zoom."
          : `Set Canvas board viewport to pan (${after.x.toFixed(1)}, ${after.y.toFixed(1)}) at zoom ${after.zoom.toFixed(3)}.`,
        {
          viewport: { ...after },
          previous_viewport: previous,
          unchanged,
        },
        context,
      );
    }
    case "canvas.board.fit_content": {
      const previous = { ...state.boardViewport };
      const surfaceWidth = operation.surface_width ?? CANVAS_BOARD_FIT_DEFAULT_SURFACE_WIDTH;
      const surfaceHeight = operation.surface_height ?? CANVAS_BOARD_FIT_DEFAULT_SURFACE_HEIGHT;
      const padding = operation.padding ?? CANVAS_BOARD_FIT_DEFAULT_PADDING;
      const viewport = computeCanvasBoardFitViewport(
        state.boardNodes.map((node) => ({
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
        })),
        { width: surfaceWidth, height: surfaceHeight },
        { padding },
      );
      const unchanged = previous.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom;
      if (!unchanged) state.setBoardViewport(viewport);
      const after = context.workspace.getState().boardViewport;
      const empty = state.boardNodes.length === 0;
      return success(
        operation.op,
        empty
          ? "Reset Canvas board viewport to identity because the board has no nodes."
          : unchanged
            ? "Canvas board viewport already frames the current nodes."
            : `Fitted ${state.boardNodes.length} Canvas node(s) into a ${surfaceWidth}×${surfaceHeight} surface.`,
        {
          viewport: { ...after },
          previous_viewport: previous,
          surface: { width: surfaceWidth, height: surfaceHeight },
          padding,
          node_count: state.boardNodes.length,
          unchanged,
          reset_to_identity: empty,
        },
        context,
      );
    }
    case "canvas.edge.add": {
      const source = state.boardNodes.find((node) => node.id === operation.source_node_id);
      const target = state.boardNodes.find((node) => node.id === operation.target_node_id);
      if (!source) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Source canvas node "${operation.source_node_id}" does not exist.`,
        );
      }
      if (!target) {
        return semanticFailure(
          operation.op,
          "not_found",
          `Target canvas node "${operation.target_node_id}" does not exist.`,
        );
      }
      const duplicate = state.boardEdges.find(
        (edge) => edge.sourceNodeId === source.id && edge.targetNodeId === target.id,
      );
      if (duplicate) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Canvas edge from "${source.id}" to "${target.id}" already exists.`,
        );
      }
      if (wouldCreateDirectorCanvasCycle(state.boardNodes, state.boardEdges, source.id, target.id)) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Canvas edge from "${source.id}" to "${target.id}" would create a dependency cycle.`,
        );
      }
      const existingIds = new Set(state.boardEdges.map((edge) => edge.id));
      state.addBoardEdge(source.id, target.id);
      const edge = context.workspace.getState().boardEdges.find((candidate) => !existingIds.has(candidate.id));
      if (!edge) return semanticFailure(operation.op, "operation_rejected", "Canvas edge could not be created.");
      return success(
        operation.op,
        `Connected "${source.title}" to "${target.title}".`,
        { edge: projectBoardEdge(edge) },
        context,
      );
    }
    case "canvas.edge.remove": {
      const edge = state.boardEdges.find((candidate) => candidate.id === operation.edge_id);
      if (!edge)
        return semanticFailure(operation.op, "not_found", `Canvas edge "${operation.edge_id}" does not exist.`);
      state.removeBoardEdge(edge.id);
      return success(operation.op, `Removed canvas edge "${edge.id}".`, { removed_id: edge.id }, context);
    }
    case "canvas.dag.layout": {
      const analysis = analyzeDirectorCanvasDag(state.boardNodes, state.boardEdges);
      if (!analysis.valid) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Canvas dependency graph is invalid: ${analysis.issues.map((issue) => issue.code).join(", ")}.`,
        );
      }
      const laidOut = state.layoutBoardDag({
        direction: operation.direction,
        originX: operation.origin_x,
        originY: operation.origin_y,
        layerGap: operation.layer_gap,
        nodeGap: operation.node_gap,
      });
      if (!laidOut) {
        return semanticFailure(operation.op, "operation_rejected", "Canvas DAG could not be laid out.");
      }
      const current = context.workspace.getState();
      return success(
        operation.op,
        `Laid out ${current.boardNodes.length} Canvas nodes in dependency order.`,
        { dag: projectCanvasDag(current.boardNodes, current.boardEdges) },
        context,
      );
    }
    case "canvas.script.apply_plan": {
      const capacity = 240 - state.boardNodes.length;
      if (capacity <= 0) {
        return semanticFailure(
          operation.op,
          "capacity",
          "The Canvas has reached its 240-node limit; the script plan would add no nodes. Remove or consolidate nodes before importing a script.",
        );
      }
      const plan = buildScriptToCanvasPlan(operation.fountain_text);
      const truncatedNodes = plan.nodes.slice(capacity);
      const replacedSectionIds = state.boardSections.map((section) => section.id);
      const nodeIdsBefore = new Set(state.boardNodes.map((node) => node.id));
      state.applyScriptCanvasPlan(plan);
      const after = context.workspace.getState();
      const addedNodes = after.boardNodes.filter((node) => !nodeIdsBefore.has(node.id));
      const omitted = [
        ...plan.omitted,
        ...truncatedNodes.map((node) => ({
          code: "board_capacity",
          subject: `node:${node.beatId}`,
          reason: `Canvas board reached its 240-node limit; shot "${node.title}" was not added (warn-and-omit code: board_capacity).`,
        })),
      ];
      const summary =
        `Applied the Fountain script plan: ${addedNodes.length} storyboard node(s) across ` +
        `${after.boardSections.length} workflow section(s), replacing ${replacedSectionIds.length} previous section(s).`;
      return success(
        operation.op,
        omitted.length ? `${summary} ${omitted.length} item(s) were omitted; see result.omitted.` : summary,
        {
          storyboard_shots: plan.storyboardShotCount,
          nodes_added: addedNodes.length,
          nodes: addedNodes.map((node) => ({
            id: node.id,
            title: node.title,
            section_id: node.sectionId ?? null,
          })),
          sections: after.boardSections.map(projectBoardSection),
          replaced_section_ids: replacedSectionIds,
          omitted,
          warnings: plan.warnings,
        },
        context,
      );
    }
    case "canvas.production.configure": {
      const node = state.boardNodes.find((candidate) => candidate.id === operation.node_id);
      if (!node) {
        return semanticFailure(operation.op, "not_found", `Canvas node "${operation.node_id}" does not exist.`);
      }
      if (node.kind !== "image" && node.kind !== "video" && node.kind !== "audio") {
        return semanticFailure(
          operation.op,
          "conflict",
          `Canvas ${node.kind} node "${node.id}" is contextual and cannot own a generation workflow.`,
        );
      }
      const current = node.productionConfig
        ? directorCanvasProductionConfigSchema.parse(node.productionConfig)
        : createDefaultDirectorCanvasProductionConfig();
      const next = directorCanvasProductionConfigSchema.parse({
        ...current,
        ...(Object.prototype.hasOwnProperty.call(operation.patch, "workflow_id")
          ? { workflowId: operation.patch.workflow_id ?? null }
          : {}),
        ...(operation.patch.node_ids !== undefined ? { nodeIds: operation.patch.node_ids } : {}),
        ...(operation.patch.negative_prompt !== undefined ? { negativePrompt: operation.patch.negative_prompt } : {}),
        ...(operation.patch.seed !== undefined ? { seed: operation.patch.seed } : {}),
        ...(operation.patch.duration_seconds !== undefined
          ? { durationSeconds: operation.patch.duration_seconds }
          : {}),
        ...(operation.patch.fps !== undefined ? { fps: operation.patch.fps } : {}),
        ...(operation.patch.audio_mode !== undefined ? { audioMode: operation.patch.audio_mode } : {}),
        ...(operation.patch.sample_rate !== undefined ? { sampleRate: operation.patch.sample_rate } : {}),
        ...(operation.patch.voice !== undefined ? { voice: operation.patch.voice } : {}),
        ...(operation.patch.language !== undefined ? { language: operation.patch.language } : {}),
        ...(operation.patch.parameters !== undefined ? { parameters: operation.patch.parameters } : {}),
      });
      state.updateBoardNode(node.id, { productionConfig: next });
      const after = context.workspace.getState().boardNodes;
      const updated = after.find((candidate) => candidate.id === node.id)!;
      return success(
        operation.op,
        `Configured production runtime for Canvas node "${updated.title}".`,
        { node: projectBoardNode(updated, boardNodeZIndex(after, updated.id)) },
        context,
      );
    }
    // -- Edit: timeline tracks, clips, ripple range edits, settings. --------
    case "edit.clip.add": {
      const track = state.editTracks.find((candidate) => candidate.id === operation.track_id);
      if (!track)
        return semanticFailure(operation.op, "not_found", `Edit track "${operation.track_id}" does not exist.`);
      if (track.locked) return semanticFailure(operation.op, "locked", `Edit track "${track.id}" is locked.`);
      const virtualText = isVirtualTextMediaId(operation.media_id);
      if (virtualText) {
        if (operation.media_id === "text:" || operation.media_id === "text") {
          return semanticFailure(
            operation.op,
            "conflict",
            'Virtual text media_id must be "text:<id>" or "text:caption:…".',
          );
        }
        if (track.kind !== "video") {
          return semanticFailure(
            operation.op,
            "conflict",
            `Virtual text/caption clips require a video track, but "${track.id}" is ${track.kind}.`,
          );
        }
      }
      const media = virtualText ? null : findMedia(context, operation.media_id);
      if (!virtualText && !media) {
        return semanticFailure(operation.op, "not_found", `Media asset "${operation.media_id}" does not exist.`);
      }
      if (media) {
        const requiredTrackKind = expectedTrackKind(media.kind);
        if (track.kind !== requiredTrackKind) {
          return semanticFailure(
            operation.op,
            "conflict",
            `${media.kind} media requires a ${requiredTrackKind} track, but "${track.id}" is ${track.kind}.`,
          );
        }
      }
      const sourceDurationSec =
        operation.source_duration_sec ?? (virtualText ? 60 * 60 : (media?.durationSec ?? operation.duration_sec));
      const playbackRate = operation.playback_rate ?? 1;
      if (sourceDurationSec < operation.duration_sec * playbackRate) {
        return semanticFailure(operation.op, "conflict", "Clip duration cannot exceed its source duration.");
      }
      const needsFollowUp =
        operation.in_sec !== undefined ||
        operation.opacity !== undefined ||
        operation.volume !== undefined ||
        Boolean(operation.overwrite);
      if (needsFollowUp) state.beginHistoryBatch();
      let clip: ReturnType<typeof state.addClip> = null;
      let overwriteSummary: DirectorTrackOverwriteSummary = EMPTY_OVERWRITE_SUMMARY;
      try {
        clip = state.addClip({
          trackId: track.id,
          mediaId: operation.media_id,
          name: operation.name,
          startSec: operation.start_sec,
          durationSec: operation.duration_sec,
          sourceDurationSec,
          playbackRate,
          fadeInSec: operation.fade_in_sec,
          fadeOutSec: operation.fade_out_sec,
          scale: operation.scale,
          positionX: operation.position_x,
          positionY: operation.position_y,
          rotationDeg: operation.rotation_deg,
          fit: operation.fit,
        });
        if (!clip) {
          return semanticFailure(operation.op, "capacity", `Edit track "${track.id}" cannot accept another clip.`);
        }
        // addClip resets in/opacity/volume; optional add fields patch them back for
        // duplicate-after and other authoring that needs the full clip look.
        if (operation.in_sec !== undefined || operation.opacity !== undefined || operation.volume !== undefined) {
          state.updateClip(clip.id, {
            ...(operation.in_sec !== undefined ? { inSec: operation.in_sec } : {}),
            ...(operation.opacity !== undefined ? { opacity: operation.opacity } : {}),
            ...(operation.volume !== undefined ? { volume: operation.volume } : {}),
          });
        }
        if (operation.overwrite) {
          // Same overwrite-with-trim the Video Editor runs after an explicit drop.
          overwriteSummary = state.commitClipPlacement(clip.id);
        }
      } finally {
        if (needsFollowUp) state.endHistoryBatch();
      }
      const projected = findClip(context.workspace.getState(), clip.id)?.clip ?? clip;
      return success(
        operation.op,
        overwritePlacementMessage(
          `Added clip "${projected.name}" to track "${track.name}"`,
          Boolean(operation.overwrite),
          overwriteSummary,
        ),
        {
          clip: projectEditClip(projected),
          track_id: track.id,
          ...overwritePlacementResult(Boolean(operation.overwrite), overwriteSummary),
          ...(virtualText ? { virtual_text: true } : {}),
        },
        context,
      );
    }
    case "edit.clip.update": {
      const owner = findClip(state, operation.clip_id);
      if (!owner) return semanticFailure(operation.op, "not_found", `Edit clip "${operation.clip_id}" does not exist.`);
      if (owner.track.locked)
        return semanticFailure(operation.op, "locked", `Edit track "${owner.track.id}" is locked.`);
      if (operation.patch.media_id !== undefined) {
        const nextMediaId = operation.patch.media_id;
        if (isVirtualTextMediaId(nextMediaId)) {
          if (nextMediaId === "text:" || nextMediaId === "text") {
            return semanticFailure(
              operation.op,
              "conflict",
              'Virtual text media_id must be "text:<id>" or "text:caption:…".',
            );
          }
          if (owner.track.kind !== "video") {
            return semanticFailure(
              operation.op,
              "conflict",
              `Virtual text/caption clips require a video track, but "${owner.track.id}" is ${owner.track.kind}.`,
            );
          }
        } else {
          const media = findMedia(context, nextMediaId);
          if (!media) {
            return semanticFailure(operation.op, "not_found", `Media asset "${nextMediaId}" does not exist.`);
          }
          if (expectedTrackKind(media.kind) !== owner.track.kind) {
            return semanticFailure(
              operation.op,
              "conflict",
              `${media.kind} media cannot be placed on ${owner.track.kind} track "${owner.track.id}".`,
            );
          }
        }
      }
      const nextSourceDuration = operation.patch.source_duration_sec ?? owner.clip.sourceDurationSec;
      const nextIn = operation.patch.in_sec ?? owner.clip.inSec;
      const nextDuration = operation.patch.duration_sec ?? owner.clip.durationSec;
      const nextPlaybackRate = operation.patch.playback_rate ?? owner.clip.playbackRate;
      const nextFadeIn = operation.patch.fade_in_sec ?? owner.clip.fadeInSec;
      const nextFadeOut = operation.patch.fade_out_sec ?? owner.clip.fadeOutSec;
      if (nextIn + nextDuration * nextPlaybackRate > nextSourceDuration + Number.EPSILON) {
        return semanticFailure(operation.op, "conflict", "Clip in point plus duration cannot exceed source duration.");
      }
      if (nextFadeIn + nextFadeOut > nextDuration + Number.EPSILON) {
        return semanticFailure(operation.op, "conflict", "Clip fade durations cannot exceed clip duration.");
      }
      if (operation.patch.transition_in_sec !== undefined && operation.patch.transition_in_sec > 0) {
        const predecessor = findDirectorTransitionPredecessor(owner.track, owner.clip.id);
        if (!predecessor) {
          return semanticFailure(
            operation.op,
            "conflict",
            `Clip "${owner.clip.id}" has no adjacent same-track predecessor to dissolve from.`,
          );
        }
        const maxTransition = Math.min(nextDuration, predecessor.durationSec);
        if (operation.patch.transition_in_sec > maxTransition + Number.EPSILON) {
          return semanticFailure(
            operation.op,
            "conflict",
            `Clip transition cannot exceed ${maxTransition} seconds (limited by the clip and its predecessor).`,
          );
        }
      }
      if (operation.overwrite) state.beginHistoryBatch();
      let overwriteSummary: DirectorTrackOverwriteSummary = EMPTY_OVERWRITE_SUMMARY;
      try {
        state.updateClip(owner.clip.id, mapClipPatch(operation.patch));
        if (operation.overwrite) {
          overwriteSummary = state.commitClipPlacement(owner.clip.id);
        }
      } finally {
        if (operation.overwrite) state.endHistoryBatch();
      }
      const updated = findClip(context.workspace.getState(), owner.clip.id)?.clip;
      if (!updated) {
        return semanticFailure(
          operation.op,
          "operation_rejected",
          `Edit clip "${operation.clip_id}" was removed by overwrite placement.`,
        );
      }
      return success(
        operation.op,
        overwritePlacementMessage(
          `Updated edit clip "${updated.name}"`,
          Boolean(operation.overwrite),
          overwriteSummary,
        ),
        {
          clip: projectEditClip(updated),
          track_id: owner.track.id,
          ...overwritePlacementResult(Boolean(operation.overwrite), overwriteSummary),
        },
        context,
      );
    }
    case "edit.clip.move": {
      const owner = findClip(state, operation.clip_id);
      if (!owner) return semanticFailure(operation.op, "not_found", `Edit clip "${operation.clip_id}" does not exist.`);
      const destination = state.editTracks.find((track) => track.id === operation.track_id);
      if (!destination)
        return semanticFailure(operation.op, "not_found", `Edit track "${operation.track_id}" does not exist.`);
      if (owner.track.locked)
        return semanticFailure(operation.op, "locked", `Source edit track "${owner.track.id}" is locked.`);
      if (destination.locked)
        return semanticFailure(operation.op, "locked", `Destination edit track "${destination.id}" is locked.`);
      if (owner.track.kind !== destination.kind) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Cannot move a ${owner.track.kind} clip to ${destination.kind} track "${destination.id}".`,
        );
      }
      if (operation.overwrite) state.beginHistoryBatch();
      let overwriteSummary: DirectorTrackOverwriteSummary = EMPTY_OVERWRITE_SUMMARY;
      try {
        state.moveClipToTrack(owner.clip.id, destination.id, operation.start_sec);
        if (operation.overwrite) {
          overwriteSummary = state.commitClipPlacement(owner.clip.id);
        }
      } finally {
        if (operation.overwrite) state.endHistoryBatch();
      }
      const moved = findClip(context.workspace.getState(), owner.clip.id);
      if (!moved || moved.track.id !== destination.id) {
        return semanticFailure(
          operation.op,
          "capacity",
          `Destination edit track "${destination.id}" cannot accept the clip.`,
        );
      }
      return success(
        operation.op,
        overwritePlacementMessage(
          `Moved clip "${owner.clip.name}" to track "${destination.name}"`,
          Boolean(operation.overwrite),
          overwriteSummary,
        ),
        {
          clip: projectEditClip(moved.clip),
          track_id: moved.track.id,
          ...overwritePlacementResult(Boolean(operation.overwrite), overwriteSummary),
        },
        context,
      );
    }
    case "edit.clip.split": {
      const owner = findClip(state, operation.clip_id);
      if (!owner) return semanticFailure(operation.op, "not_found", `Edit clip "${operation.clip_id}" does not exist.`);
      if (owner.track.locked)
        return semanticFailure(operation.op, "locked", `Edit track "${owner.track.id}" is locked.`);
      const offset = operation.at_sec - owner.clip.startSec;
      if (offset < 0.1 || offset > owner.clip.durationSec - 0.1) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Split point must be at least 0.1 seconds inside clip "${owner.clip.id}".`,
        );
      }
      const created = state.splitClip(owner.clip.id, operation.at_sec);
      if (!created)
        return semanticFailure(operation.op, "operation_rejected", `Edit clip "${owner.clip.id}" could not be split.`);
      const first = findClip(context.workspace.getState(), owner.clip.id)!.clip;
      return success(
        operation.op,
        `Split clip "${owner.clip.name}" at ${operation.at_sec}s.`,
        { first: projectEditClip(first), second: projectEditClip(created), track_id: owner.track.id },
        context,
      );
    }
    case "edit.clip.remove": {
      const owner = findClip(state, operation.clip_id);
      if (!owner) return semanticFailure(operation.op, "not_found", `Edit clip "${operation.clip_id}" does not exist.`);
      if (owner.track.locked)
        return semanticFailure(operation.op, "locked", `Edit track "${owner.track.id}" is locked.`);
      if (operation.ripple) {
        // Mirrors rippleRemoveClip: later same-track clips shift earlier by the
        // removed clip's duration; clips starting at or before it stay put.
        const shiftedClipIds = owner.track.clips
          .filter((clip) => clip.startSec > owner.clip.startSec + DIRECTOR_CLIP_EDGE_EPSILON_SEC)
          .map((clip) => clip.id);
        state.rippleRemoveClip(owner.clip.id);
        return success(
          operation.op,
          `Ripple-removed edit clip "${owner.clip.name}"; ${shiftedClipIds.length} later clip${
            shiftedClipIds.length === 1 ? "" : "s"
          } shifted earlier by ${owner.clip.durationSec}s.`,
          {
            removed_id: owner.clip.id,
            track_id: owner.track.id,
            ripple_shift_sec: owner.clip.durationSec,
            shifted_clip_ids: shiftedClipIds,
          },
          context,
        );
      }
      state.removeClip(owner.clip.id);
      return success(
        operation.op,
        `Removed edit clip "${owner.clip.name}".`,
        { removed_id: owner.clip.id, track_id: owner.track.id },
        context,
      );
    }
    case "edit.range.remove": {
      const resolved = resolveRangeTracks(operation.op, state, operation.track_ids);
      if (!("tracks" in resolved)) return resolved;
      // Ripple removal: clips fully inside [from, to] are deleted, boundary
      // clips are trimmed (sub-0.1s remnants are absorbed), a clip spanning
      // the whole range is split around it, and everything after the range
      // shifts left by (to - from). Explicitly listed tracks fail above when
      // locked; with track_ids omitted, locked tracks are skipped and
      // reported. A range that touches no clips still succeeds with an empty
      // summary: the editorial intent ("this span is clear") is idempotent,
      // unlike targeted edit.clip.* mutations that reject unmet preconditions.
      const summary = state.removeTimelineRange(operation.from_sec, operation.to_sec, operation.track_ids);
      const trackIds = resolved.tracks.map((track) => track.id);
      return success(
        operation.op,
        `Ripple-removed ${operation.from_sec}s-${operation.to_sec}s across ${trackIds.length} edit track${
          trackIds.length === 1 ? "" : "s"
        }: ${summary.removedClipIds.length} removed, ${summary.trimmedClipIds.length} trimmed, ${
          summary.shiftedClipIds.length
        } shifted.`,
        {
          from_sec: operation.from_sec,
          to_sec: operation.to_sec,
          ripple_shift_sec: operation.to_sec - operation.from_sec,
          track_ids: trackIds,
          removed_clip_ids: summary.removedClipIds,
          trimmed_clip_ids: summary.trimmedClipIds,
          shifted_clip_ids: summary.shiftedClipIds,
          created_clip_ids: summary.createdClipIds,
          skipped_locked_track_ids: summary.skippedLockedTrackIds,
        },
        context,
      );
    }
    case "edit.range.insert_gap": {
      const resolved = resolveRangeTracks(operation.op, state, operation.track_ids);
      if (!("tracks" in resolved)) return resolved;
      // Ripple gap insertion: every clip starting at or after at_sec shifts
      // right by duration_sec, and a clip straddling at_sec is split there
      // (the store supports splitting) so only its new tail shifts; a clip
      // whose head or tail at the cut would be shorter than 0.1s is shifted
      // wholesale or left in place instead. Locked-track handling and the
      // empty-summary no-op success match edit.range.remove.
      const summary = state.insertTimelineGap(operation.at_sec, operation.duration_sec, operation.track_ids);
      const trackIds = resolved.tracks.map((track) => track.id);
      return success(
        operation.op,
        `Inserted a ${operation.duration_sec}s gap at ${operation.at_sec}s across ${trackIds.length} edit track${
          trackIds.length === 1 ? "" : "s"
        }: ${summary.shiftedClipIds.length} shifted, ${summary.splitClipIds.length} split.`,
        {
          at_sec: operation.at_sec,
          duration_sec: operation.duration_sec,
          track_ids: trackIds,
          shifted_clip_ids: summary.shiftedClipIds,
          split_clip_ids: summary.splitClipIds,
          created_clip_ids: summary.createdClipIds,
          skipped_locked_track_ids: summary.skippedLockedTrackIds,
        },
        context,
      );
    }
    case "edit.track.add": {
      const track = state.addTrack(operation.kind, operation.name);
      if (!track) return semanticFailure(operation.op, "capacity", "The edit timeline has reached its track limit.");
      return success(
        operation.op,
        `Added ${track.kind} track "${track.name}".`,
        { track: projectEditTrack(track) },
        context,
      );
    }
    case "edit.track.update": {
      const track = state.editTracks.find((candidate) => candidate.id === operation.track_id);
      if (!track)
        return semanticFailure(operation.op, "not_found", `Edit track "${operation.track_id}" does not exist.`);
      state.beginHistoryBatch();
      try {
        if (operation.patch.name !== undefined && operation.patch.name !== track.name) {
          state.renameTrack(track.id, operation.patch.name);
        }
        if (operation.patch.muted !== undefined && operation.patch.muted !== track.muted)
          state.toggleTrackMute(track.id);
        if (operation.patch.visible !== undefined && operation.patch.visible !== track.visible) {
          state.toggleTrackVisibility(track.id);
        }
        if (operation.patch.locked !== undefined && operation.patch.locked !== track.locked)
          state.toggleTrackLock(track.id);
      } finally {
        state.endHistoryBatch();
      }
      const updated = context.workspace.getState().editTracks.find((candidate) => candidate.id === track.id)!;
      return success(
        operation.op,
        `Updated edit track "${updated.name}".`,
        { track: projectEditTrack(updated) },
        context,
      );
    }
    case "edit.track.remove": {
      const track = state.editTracks.find((candidate) => candidate.id === operation.track_id);
      if (!track)
        return semanticFailure(operation.op, "not_found", `Edit track "${operation.track_id}" does not exist.`);
      if (track.locked) return semanticFailure(operation.op, "locked", `Edit track "${track.id}" is locked.`);
      if (track.kind === "video" && state.editTracks.filter((candidate) => candidate.kind === "video").length <= 1) {
        return semanticFailure(operation.op, "conflict", "The final video track cannot be removed.");
      }
      state.removeTrack(track.id);
      return success(operation.op, `Removed edit track "${track.name}".`, { removed_id: track.id }, context);
    }
    case "edit.settings.update": {
      const current = normalizeDirectorTimebase(state.editSettings.timebase, state.editSettings.fps);
      const rate = operation.patch.frame_rate
        ? normalizeDirectorFrameRate(operation.patch.frame_rate, current.rate)
        : current.rate;
      if (operation.patch.drop_frame === true && !supportsDirectorDropFrame(rate)) {
        return semanticFailure(
          operation.op,
          "conflict",
          "Drop-frame timecode is only valid for 30000/1001 or 60000/1001 frame rates.",
        );
      }
      const dropFrame = operation.patch.drop_frame ?? (supportsDirectorDropFrame(rate) ? current.dropFrame : false);
      const requestedStart =
        operation.patch.start_timecode ??
        (dropFrame
          ? current.startTimecode.replace(/:(\d{2})$/, ";$1")
          : current.startTimecode.replace(/;(\d{2})$/, ":$1"));
      const parsedStart = parseSmpteTimecode(requestedStart, rate, { dropFrame });
      if (!parsedStart) {
        return semanticFailure(
          operation.op,
          "conflict",
          `Start timecode "${requestedStart}" is invalid for this rate.`,
        );
      }
      state.updateEditSettings({
        ...(operation.patch.aspect_ratio !== undefined ? { aspectRatio: operation.patch.aspect_ratio } : {}),
        fps: frameRateToNumber(rate),
        timebase: { rate, dropFrame, startTimecode: parsedStart.timecode },
        ...(operation.patch.snap_enabled !== undefined ? { snapEnabled: operation.patch.snap_enabled } : {}),
        ...(operation.patch.export_quality !== undefined ? { exportQuality: operation.patch.export_quality } : {}),
      });
      const settings = observeCreativeWorkspaceAgentSnapshot(context).edit.settings;
      return success(operation.op, "Updated professional edit timebase and export settings.", { settings }, context);
    }
    case "edit.seek": {
      state.setPlayhead(operation.seconds);
      return success(
        operation.op,
        `Moved the edit playhead to ${operation.seconds}s.`,
        { playhead_sec: operation.seconds },
        context,
      );
    }
    case "edit.timeline.set_zoom": {
      const previous = state.timelineZoom;
      const zoom = clampDirectorTimelineZoom(operation.zoom);
      const unchanged = previous === zoom;
      if (!unchanged) state.setTimelineZoom(zoom);
      const after = context.workspace.getState().timelineZoom;
      return success(
        operation.op,
        unchanged
          ? "Video timeline zoom already matches the requested scale."
          : `Set the Video timeline zoom to ${after.toFixed(3)} (${Math.round(
              after * DIRECTOR_TIMELINE_BASE_PIXELS_PER_SECOND,
            )} px/s).`,
        { timeline_zoom: after, previous_timeline_zoom: previous, unchanged },
        context,
      );
    }
    case "edit.timeline.fit": {
      const previous = state.timelineZoom;
      const surfaceWidth = operation.surface_width ?? DIRECTOR_TIMELINE_FIT_DEFAULT_SURFACE_WIDTH;
      const mediaKindById = new Map(context.media.getState().assets.map((asset) => [asset.id, { kind: asset.kind }]));
      const contentDuration = getDirectorTimelineContentDuration(state.editTracks, mediaKindById);
      const span = Math.max(1, contentDuration > 0 ? contentDuration : getDirectorEditDuration(state.editTracks));
      const zoom = computeDirectorTimelineFitZoom(span, surfaceWidth);
      const unchanged = previous === zoom;
      if (!unchanged) state.setTimelineZoom(zoom);
      const after = context.workspace.getState().timelineZoom;
      const empty = state.editTracks.every((track) => track.clips.length === 0);
      return success(
        operation.op,
        empty
          ? `Fitted the empty timeline's minimum window into a ${surfaceWidth} px surface.`
          : unchanged
            ? "Video timeline zoom already fits the edited content."
            : `Fitted ${span.toFixed(2)}s of edited content into a ${surfaceWidth} px timeline surface at zoom ${after.toFixed(3)}.`,
        {
          timeline_zoom: after,
          previous_timeline_zoom: previous,
          surface_width: surfaceWidth,
          content_span_sec: span,
          unchanged,
        },
        context,
      );
    }
    // -- Workspace: mode switching and undo/redo. ----------------------------
    case "workspace.switch": {
      state.setMode(operation.workspace);
      return success(
        operation.op,
        `Switched to the ${operation.workspace} workspace.`,
        { workspace: operation.workspace },
        context,
      );
    }
    case "workspace.undo": {
      if (!state.canUndo)
        return semanticFailure(operation.op, "conflict", "There is no creative workspace change to undo.");
      const before = observeCreativeWorkspaceAgentSnapshot(context).snapshot_fingerprint;
      state.undo();
      const after = observeCreativeWorkspaceAgentSnapshot(context);
      if (after.snapshot_fingerprint === before) {
        return semanticFailure(operation.op, "operation_rejected", "Undo did not change the creative workspace.");
      }
      return {
        success: true,
        operation: operation.op,
        message: "Undid the most recent creative workspace change.",
        result: { before_snapshot_fingerprint: before, after_snapshot_fingerprint: after.snapshot_fingerprint },
        snapshot: after,
      };
    }
    case "workspace.redo": {
      if (!state.canRedo)
        return semanticFailure(operation.op, "conflict", "There is no creative workspace change to redo.");
      const before = observeCreativeWorkspaceAgentSnapshot(context).snapshot_fingerprint;
      state.redo();
      const after = observeCreativeWorkspaceAgentSnapshot(context);
      if (after.snapshot_fingerprint === before) {
        return semanticFailure(operation.op, "operation_rejected", "Redo did not change the creative workspace.");
      }
      return {
        success: true,
        operation: operation.op,
        message: "Redid the most recently undone creative workspace change.",
        result: { before_snapshot_fingerprint: before, after_snapshot_fingerprint: after.snapshot_fingerprint },
        snapshot: after,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic batches: @alias references, all-or-nothing history rollback.
// ---------------------------------------------------------------------------

/** Operation fields that may carry a `@alias` reference to an earlier batch step's created entity. */
const BATCH_REFERENCE_FIELDS = [
  "node_id",
  "edge_id",
  "clip_id",
  "track_id",
  "folder_id",
  "parent_id",
  "source_node_id",
  "target_node_id",
  "section_id",
] as const;

/**
 * Substitute `@alias` values in a batch step with the ids produced by earlier
 * steps, then re-validate the resolved operation against the contract schema
 * so substitution can never smuggle in an ill-typed operation.
 */
function resolveBatchOperationReferences(
  operation: CreativeWorkspaceAgentOperation,
  references: Map<string, string>,
): CreativeWorkspaceAgentOperation | { error: string } {
  const resolved = { ...operation } as Record<string, unknown>;
  for (const field of BATCH_REFERENCE_FIELDS) {
    const value = resolved[field];
    if (typeof value !== "string" || !value.startsWith("@")) continue;
    const alias = value.slice(1);
    const targetId = references.get(alias);
    if (!targetId) return { error: `Batch reference "${value}" has not been produced by an earlier step.` };
    resolved[field] = targetId;
  }
  const parsed = creativeWorkspaceAgentOperationSchema.safeParse(resolved);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
        .join("; "),
    };
  }
  return parsed.data;
}

/** The id a `save_as` alias binds to: the first addressable entity a step's result created. */
function primaryCreatedId(execution: Extract<CreativeWorkspaceAgentExecutionResult, { success: true }>): string | null {
  for (const key of ["node", "edge", "clip", "second", "track", "folder"] as const) {
    const entity = execution.result[key];
    if (
      entity &&
      typeof entity === "object" &&
      !Array.isArray(entity) &&
      typeof (entity as { id?: unknown }).id === "string"
    ) {
      return (entity as { id: string }).id;
    }
  }
  return null;
}

/**
 * Execute a multi-step batch atomically inside one history batch: any invalid
 * reference, failed step, or thrown error rolls back every completed mutation
 * and reports which step failed plus what had completed. A rollback that
 * itself fails is surfaced explicitly so the caller knows the workspace state
 * can no longer be trusted without a reload.
 */
function executeCreativeWorkspaceAgentBatch(
  input: Extract<CreativeWorkspaceAgentRequest, { op: "execute_batch" }>,
  context: CreativeWorkspaceAgentContext,
): CreativeWorkspaceAgentExecutionResult {
  const state = context.workspace.getState();
  const references = new Map<string, string>();
  const completedSteps: Array<Record<string, unknown>> = [];
  let activeStepId: string | undefined;
  let batchStarted = false;
  try {
    state.beginHistoryBatch();
    batchStarted = true;
    for (const step of input.steps) {
      activeStepId = step.step_id;
      const resolved = resolveBatchOperationReferences(step.operation, references);
      if ("error" in resolved) {
        context.workspace.getState().rollbackHistoryBatch();
        batchStarted = false;
        return {
          success: false,
          operation: "batch",
          code: "invalid_input",
          error: `Batch step "${step.step_id}" is invalid: ${resolved.error}`,
          result: { failed_step_id: step.step_id, rolled_back: true, completed_steps: completedSteps },
          snapshot: observeCreativeWorkspaceAgentSnapshot(context),
          suggested_next: "Refresh observed ids or fix the @alias reference, then submit the complete batch again.",
        };
      }
      const execution = executeCreativeWorkspaceAgentOperation(resolved, context);
      if (!execution.success) {
        context.workspace.getState().rollbackHistoryBatch();
        batchStarted = false;
        return {
          success: false,
          operation: "batch",
          code: execution.code,
          error: `Batch step "${step.step_id}" failed: ${execution.error}`,
          issues: execution.issues,
          result: {
            failed_step_id: step.step_id,
            failed_operation: resolved.op,
            rolled_back: true,
            completed_steps: completedSteps,
          },
          snapshot: observeCreativeWorkspaceAgentSnapshot(context),
          suggested_next:
            execution.suggested_next ?? "Observe the current workspace, correct the failed step, and retry the batch.",
        };
      }
      let savedId: string | null = null;
      if (step.save_as) {
        savedId = primaryCreatedId(execution);
        if (!savedId) {
          context.workspace.getState().rollbackHistoryBatch();
          batchStarted = false;
          return {
            success: false,
            operation: "batch",
            code: "invalid_input",
            error: `Batch step "${step.step_id}" uses save_as but does not create an addressable entity.`,
            result: { failed_step_id: step.step_id, rolled_back: true, completed_steps: completedSteps },
            snapshot: observeCreativeWorkspaceAgentSnapshot(context),
            suggested_next: "Use save_as only with node, edge, clip, split, track, or Gallery folder creation steps.",
          };
        }
        references.set(step.save_as, savedId);
      }
      completedSteps.push({
        step_id: step.step_id,
        operation: resolved.op,
        ...(step.save_as && savedId ? { saved_as: step.save_as, entity_id: savedId } : {}),
        result: execution.result,
      });
    }
    context.workspace.getState().endHistoryBatch();
    batchStarted = false;
    return success(
      "batch",
      `Applied ${completedSteps.length} creative workspace steps atomically.`,
      { steps: completedSteps, references: Object.fromEntries(references) },
      context,
    );
  } catch (error) {
    let rollbackError: unknown;
    if (batchStarted) {
      try {
        context.workspace.getState().rollbackHistoryBatch();
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError ?? "");
    return {
      success: false,
      operation: "batch",
      code: "operation_rejected",
      error: rollbackError
        ? `Batch step "${activeStepId ?? "unknown"}" threw "${message}", and rollback failed: ${rollbackMessage}`
        : `Batch step "${activeStepId ?? "unknown"}" threw "${message}"; every completed mutation was rolled back.`,
      result: {
        ...(activeStepId ? { failed_step_id: activeStepId } : {}),
        rolled_back: !rollbackError,
        completed_steps: completedSteps,
      },
      suggested_next: rollbackError
        ? "Reload the creative workspace before retrying because rollback could not be confirmed."
        : "Inspect the failing step, then retry the remaining work.",
    };
  }
}

/**
 * Resolve a media.relink source to a File. Inline payloads (utf8/base64) and
 * Gallery media ids resolve in the browser; workspace_path sources need a
 * host-provided file and are rejected here by design.
 */
async function resolveRelinkFile(
  source: Extract<CreativeWorkspaceAgentOperation, { op: "media.relink" }>["source"],
): Promise<File> {
  if (source.kind === "inline") {
    const bytes =
      source.encoding === "utf8"
        ? new TextEncoder().encode(source.payload)
        : (() => {
            const binary = atob(source.payload);
            const out = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
            return out;
          })();
    return new File([bytes], source.file_name?.trim() || "relink.bin", {
      type: "application/octet-stream",
    });
  }
  if (source.kind === "media_id") {
    const blob = await persistentCreativeMediaLibrary.getBlob(source.media_id);
    if (!blob) throw new Error(`Gallery media ${source.media_id} is not available for relink.`);
    const asset = persistentCreativeMediaLibrary.getAsset(source.media_id);
    return new File([blob], asset?.name || `${source.media_id}.bin`, {
      type: blob.type || "application/octet-stream",
    });
  }
  throw new Error("workspace_path media.relink requires a host-provided file; use inline or media_id in the browser.");
}

/**
 * Shared media.relink body for the Agent async wire path and in-process UI file
 * picks. Both resolve to a File, then land on the same catalog rewrite + receipt.
 */
export async function executeCreativeWorkspaceMediaRelinkFile(
  mediaId: string,
  file: File,
  context: CreativeWorkspaceAgentContext = defaultContext,
): Promise<CreativeWorkspaceAgentExecutionResult> {
  const state = context.workspace.getState();
  if (!isKnownGalleryMedia(state, context, mediaId)) {
    return semanticFailure(
      "media.relink",
      "not_found",
      `Gallery media "${mediaId}" is not cataloged, imported, or referenced by this project.`,
    );
  }
  try {
    const expected = findMedia(context, mediaId)?.kind;
    const receipt = await relinkDirectorCreativeMedia(mediaId, file, expected ?? undefined);
    const media = findMedia(context, receipt.newMediaId);
    const durability = creativeWorkspaceMediaDurabilityProbeSchema.parse(
      await probeCreativeMediaDurability(context, receipt.newMediaId),
    );
    return success(
      "media.relink",
      `Relinked media "${mediaId}" to "${receipt.newMediaId}".`,
      {
        old_media_id: receipt.oldMediaId,
        new_media_id: receipt.newMediaId,
        references_updated: receipt.referencesUpdated,
        waveform_ready: receipt.waveformReady,
        media: media ? projectMediaAsset(media) : null,
        storage: creativeMediaStorageStanza(context),
        durability,
      },
      context,
    );
  } catch (error) {
    return semanticFailure(
      "media.relink",
      "operation_rejected",
      `Media relink failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Shared media.verify body: probes each requested id against the durable
 * store so byte and link claims on receipts are measured, not assumed.
 */
export async function executeCreativeWorkspaceMediaVerify(
  operation: Extract<CreativeWorkspaceAgentOperation, { op: "media.verify" }>,
  context: CreativeWorkspaceAgentContext = defaultContext,
): Promise<CreativeWorkspaceAgentExecutionResult> {
  const items: CreativeMediaDurabilityProbe[] = [];
  for (const mediaId of operation.media_ids) {
    items.push(await probeCreativeMediaDurability(context, mediaId));
  }
  const counts = {
    verified: items.filter((item) => item.outcome === "verified").length,
    size_mismatch: items.filter((item) => item.outcome === "size_mismatch").length,
    missing_bytes: items.filter((item) => item.outcome === "missing_bytes").length,
    not_cataloged: items.filter((item) => item.outcome === "not_cataloged").length,
    unverified: items.filter((item) => item.outcome === "unverified").length,
  };
  const result = creativeWorkspaceMediaVerifyResultSchema.parse({
    storage: creativeMediaStorageStanza(context),
    items,
    counts,
  });
  return success(
    "media.verify",
    `Probed durable bytes for ${items.length} media asset(s): ${counts.verified} verified, ${counts.size_mismatch} size mismatch, ${counts.missing_bytes} missing bytes, ${counts.not_cataloged} not cataloged, ${counts.unverified} unverified.`,
    result,
    context,
  );
}

/** Async execute path for operations that need durable media IO (media.relink, media.verify). */
export async function executeCreativeWorkspaceAgentOperationAsync(
  input: unknown,
  context: CreativeWorkspaceAgentContext = defaultContext,
): Promise<CreativeWorkspaceAgentExecutionResult> {
  const parsed = parseCreativeWorkspaceAgentOperation(input);
  if (!parsed.success) {
    return {
      success: false,
      operation: null,
      code: parsed.code,
      error: parsed.error,
      issues: parsed.issues,
    };
  }
  if (parsed.operation.op === "media.verify") {
    return executeCreativeWorkspaceMediaVerify(parsed.operation, context);
  }
  if (parsed.operation.op !== "media.relink") {
    return executeCreativeWorkspaceAgentOperation(parsed.operation, context);
  }
  try {
    const file = await resolveRelinkFile(parsed.operation.source);
    return executeCreativeWorkspaceMediaRelinkFile(parsed.operation.media_id, file, context);
  } catch (error) {
    return semanticFailure(
      "media.relink",
      "operation_rejected",
      `Media relink failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Execute the public observe/execute envelope against the live browser stores.
 *
 * Reads (capabilities / describe / observe / audit) run unguarded. Async-only
 * envelopes (preview, interchange, collaboration, pipeline, media.relink) are
 * rejected here with a typed pointer to their dedicated executor. Mutations
 * enforce the full guard ladder in order: fingerprint present → idempotency
 * key present → retry-receipt replay (same key + same intent) or conflict
 * (same key, different intent) → fingerprint freshness → execute, decorate
 * the receipt with idempotency metadata, and remember it for future retries.
 */
export function executeCreativeWorkspaceAgentRequest(
  input: CreativeWorkspaceAgentRequest,
  context: CreativeWorkspaceAgentContext = defaultContext,
): CreativeWorkspaceAgentToolResult {
  if (input.op === "capabilities") {
    return {
      op: "capabilities",
      capabilities: creativeWorkspaceAgentCapabilitiesSchema.parse(getCreativeWorkspaceAgentCapabilities()),
    };
  }
  if (input.op === "describe") {
    const described = describeCreativeWorkspaceTarget(input.target);
    if (!described.success) throw new Error(described.error);
    return { op: "describe", description: described.result };
  }
  if (input.op === "observe") {
    return { op: "observe", snapshot: observeCreativeWorkspaceAgentSnapshot(context) };
  }
  if (input.op === "audit") {
    const snapshot = observeCreativeWorkspaceAgentSnapshot(context);
    const audit: CreativeWorkspaceAuditReceipt = auditCreativeWorkspaceSnapshot(
      snapshot,
      input.scope,
      input.quality_profile,
    );
    return { op: "audit", audit };
  }
  if (input.op === "preview") {
    const current = observeCreativeWorkspaceAgentSnapshot(context);
    if (!input.expected_snapshot_fingerprint) {
      return {
        op: "preview",
        preview: {
          success: false,
          code: "stale_snapshot",
          error: "Creative preview requires expected_snapshot_fingerprint at the browser execution boundary.",
          expected_snapshot_fingerprint: current.snapshot_fingerprint,
          current_snapshot_fingerprint: current.snapshot_fingerprint,
          suggested_next: "Use the public Agent boundary so it can observe and inject the current guard.",
        },
      };
    }
    return {
      op: "preview",
      preview: {
        success: false,
        code: current.snapshot_fingerprint === input.expected_snapshot_fingerprint ? "render_failed" : "stale_snapshot",
        error:
          current.snapshot_fingerprint === input.expected_snapshot_fingerprint
            ? "Preview rendering is asynchronous; dispatch this request through executeCreativeWorkspaceAgentPreviewRequest."
            : `Creative workspace changed since observe (expected ${input.expected_snapshot_fingerprint}, current ${current.snapshot_fingerprint}).`,
        expected_snapshot_fingerprint: input.expected_snapshot_fingerprint,
        current_snapshot_fingerprint: current.snapshot_fingerprint,
        suggested_next:
          current.snapshot_fingerprint === input.expected_snapshot_fingerprint
            ? "Use the browser preview executor so media can be decoded before returning the PNG."
            : "Observe again and retry preview with the current snapshot_fingerprint.",
      },
    };
  }
  if (input.op === "interchange" || input.op === "collaboration" || input.op === "pipeline") {
    const result = {
      success: false as const,
      action: input.request.action,
      code: "operation_rejected" as const,
      error: `${input.op} execution is asynchronous; dispatch this request through executeCreativeWorkspaceAgentSemanticRequest.`,
      suggested_next: "Use the live browser gateway executor for this exact-target semantic request.",
    };
    return input.op === "interchange"
      ? creativeWorkspaceInterchangeToolResultSchema.parse({ op: "interchange", result })
      : input.op === "collaboration"
        ? creativeWorkspaceCollaborationToolResultSchema.parse({ op: "collaboration", result })
        : creativeWorkspacePipelineToolResultSchema.parse({ op: "pipeline", result });
  }
  const current = observeCreativeWorkspaceAgentSnapshot(context);
  if (!input.expected_snapshot_fingerprint) {
    return {
      op: input.op,
      execution: {
        success: false,
        operation: input.op === "execute" ? input.operation.op : "batch",
        code: "conflict",
        error: "Creative mutations require expected_snapshot_fingerprint at the browser execution boundary.",
        result: { code: "missing_snapshot_guard" },
        snapshot: current,
        suggested_next: "Use the exact-target public Agent boundary so it can observe and inject the current guard.",
      },
    };
  }
  if (!input.idempotency_key) {
    return {
      op: input.op,
      execution: {
        success: false,
        operation: input.op === "execute" ? input.operation.op : "batch",
        code: "conflict",
        error: "Creative mutations require idempotency_key at the browser execution boundary.",
        result: { code: "missing_idempotency_key" },
        snapshot: current,
        suggested_next: "Use the public Agent boundary so it can assign a stable retry key.",
      },
    };
  }
  const signature = creativeMutationSignature(input);
  const scopeId = creativeScopeId(context);
  const receipts = creativeRetryReceiptMap(context);
  const prior = receipts.get(creativeRetryReceiptKey(context, input.idempotency_key));
  if (prior) {
    if (prior.signature !== signature) {
      return {
        op: input.op,
        execution: {
          success: false,
          operation: input.op === "execute" ? input.operation.op : "batch",
          code: "conflict",
          error: `Request key "${input.idempotency_key}" was already used for a different creative intent.`,
          result: { code: "idempotency_key_conflict", idempotency_key: input.idempotency_key, scope_id: scopeId },
          snapshot: current,
          suggested_next: "Use a new request key for a changed intent.",
        },
      };
    }
    const priorExecution = prior.result.execution;
    const replayStale = prior.snapshotFingerprintAfter !== current.snapshot_fingerprint;
    return {
      op: prior.result.op,
      execution: {
        ...structuredClone(priorExecution),
        message: replayStale
          ? `${priorExecution.message} (replayed; this mutation already succeeded and was not re-applied; the workspace changed after that original result)`
          : `${priorExecution.message} (replayed; no duplicate mutation was applied)`,
        result: {
          ...priorExecution.result,
          idempotency: {
            key: input.idempotency_key,
            replayed: true,
            ...(replayStale
              ? {
                  stale: true,
                  original_snapshot_fingerprint: prior.snapshotFingerprintAfter,
                  current_snapshot_fingerprint: current.snapshot_fingerprint,
                }
              : {}),
          },
        },
        snapshot: current,
      },
    };
  }
  if (current.snapshot_fingerprint !== input.expected_snapshot_fingerprint) {
    return {
      op: input.op,
      execution: {
        success: false,
        operation: input.op === "execute" ? input.operation.op : "batch",
        code: "conflict",
        error: `Creative workspace changed since observe (expected ${input.expected_snapshot_fingerprint}, current ${current.snapshot_fingerprint}). Observe again before retrying.`,
        snapshot: current,
        suggested_next:
          "Observe again, rebuild the operation against the current snapshot, and retry with its fingerprint.",
      },
    };
  }
  let result: CreativeMutationResult;
  if (input.op === "execute_batch") {
    result = { op: "execute_batch", execution: executeCreativeWorkspaceAgentBatch(input, context) };
  } else {
    result = {
      op: "execute",
      execution:
        input.operation.op === "media.relink"
          ? ({
              success: false,
              operation: "media.relink",
              code: "operation_rejected",
              error:
                "media.relink requires durable media IO; dispatch it through executeCreativeWorkspaceAgentOperationAsync.",
            } satisfies CreativeWorkspaceAgentExecutionResult)
          : executeCreativeWorkspaceAgentOperation(input.operation, context),
    };
  }
  if (!result.execution.success) return result;
  const decorated: CreativeMutationResult = {
    op: result.op,
    execution: {
      ...result.execution,
      result: { ...result.execution.result, idempotency: { key: input.idempotency_key, replayed: false } },
    },
  };
  rememberCreativeMutation(context, input.idempotency_key, signature, decorated);
  return decorated;
}
