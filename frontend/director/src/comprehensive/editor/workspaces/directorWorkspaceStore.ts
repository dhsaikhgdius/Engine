import { create } from "zustand";
import { z } from "zod";
import { dismissDirectorNotification, notifyDirector } from "../../app/notifications/directorNotificationStore";
import { finiteNumberOr, isRecord } from "../../../../../../packages/protocol/src/primitives";
import {
  creativeWorkspaceEditAspectRatioSchema as editAspectRatioSchema,
  creativeWorkspaceEditExportQualitySchema as editExportQualitySchema,
  creativeWorkspaceFitSchema as editClipFitSchema,
  creativeWorkspaceModeSchema as workspaceModeSchema,
  creativeWorkspaceNodeKindSchema as boardNodeKindSchema,
  creativeWorkspaceTrackKindSchema as videoTrackKindSchema,
} from "../../../../../../packages/protocol/src/creativeWorkspaceProtocol";
import type { ScriptToCanvasPlan } from "../assistant/scriptToProductionPipeline";
import { createDefaultDirectorTimebase, frameRateToNumber, normalizeDirectorTimebase } from "../timeline/frameRate";
import {
  boardSectionSchema,
  createBoardSectionId,
  resolveSectionForNode,
  type DirectorBoardSection,
} from "./canvasSections";
import { normalizeCanvasBoardViewport } from "./canvasBoardViewport";
import {
  layoutDirectorCanvasDag,
  wouldCreateDirectorCanvasCycle,
  type DirectorCanvasDagLayoutOptions,
} from "./canvasDag";
import {
  DIRECTOR_CANVAS_NODE_OUTPUT_HISTORY_LIMIT,
  DIRECTOR_CANVAS_PIPELINE_HISTORY_LIMIT,
  directorCanvasNodeOutputSchema,
  directorCanvasPipelineRunSchema,
  directorCanvasProductionConfigSchema,
  type DirectorCanvasNodeOutput,
  type DirectorCanvasPipelineRun,
} from "./canvasPipelineProtocol";
import {
  createDefaultDirectorGalleryMediaRecord,
  createDefaultDirectorGalleryState,
  DIRECTOR_GALLERY_MAX_FOLDERS,
  DIRECTOR_GALLERY_MAX_MEDIA_RECORDS,
  directorGalleryFolderSchema,
  directorGalleryMediaRecordSchema,
  directorGalleryPrefsSchema,
  isDefaultDirectorGalleryMediaRecord,
  normalizeDirectorGalleryMediaRecord,
  normalizeDirectorGalleryState,
  type DirectorGalleryFolder,
  type DirectorGalleryMediaRecord,
  type DirectorGalleryPrefs,
} from "./directorGallery";

/** A workflow partition on the Canvas board that groups related nodes. */
export type { DirectorBoardSection };
/** Gallery types: folder hierarchy node, media metadata record, and UI preferences. */
export type { DirectorGalleryFolder, DirectorGalleryMediaRecord, DirectorGalleryPrefs };

/** Active workspace panel: stage, canvas, video-editor, or gallery. */
export type DirectorWorkspaceMode = z.infer<typeof workspaceModeSchema>;
/** Semantic kind of a Canvas board node (shot, image, video, audio, note, frame). */
export type DirectorBoardNodeKind = z.infer<typeof boardNodeKindSchema>;
/** Media track kind: video or audio. */
export type DirectorVideoTrackKind = z.infer<typeof videoTrackKindSchema>;
/** Output aspect ratio for the video editor (e.g. "16 / 9", "9 / 16"). */
export type DirectorEditAspectRatio = z.infer<typeof editAspectRatioSchema>;
/** Export quality preset for the video editor. */
export type DirectorEditExportQuality = z.infer<typeof editExportQualitySchema>;
/** Aggregate settings for the video editor: aspect ratio, fps, timebase, snap, export quality. */
export type DirectorEditSettings = z.infer<typeof editSettingsSchema>;
/** A single node on the Canvas board with position, kind, metadata, and optional production state. */
export type DirectorBoardNode = z.infer<typeof boardNodeSchema>;
/** Persisted workspace-level preferences. */
export type DirectorWorkspacePrefs = z.infer<typeof workspacePrefsSchema>;
/** A directed edge connecting two Canvas board nodes. */
export type DirectorBoardEdge = z.infer<typeof boardEdgeSchema>;
/** Canvas board viewport state: pan offset and zoom. */
export type DirectorBoardViewport = z.infer<typeof boardViewportSchema>;
/** A single clip on a video editor track. */
export type DirectorEditClip = z.infer<typeof editClipSchema>;
/** A named track in the video editor with an ordered list of clips. */
export type DirectorEditTrack = z.infer<typeof editTrackSchema>;
/** Serialized output records from Canvas pipeline runs. */
export type { DirectorCanvasNodeOutput, DirectorCanvasPipelineRun };

type LegacyDirectorEditClip = Omit<
  DirectorEditClip,
  "playbackRate" | "fadeInSec" | "fadeOutSec" | "scale" | "positionX" | "positionY" | "rotationDeg" | "fit"
> &
  Partial<
    Pick<
      DirectorEditClip,
      "playbackRate" | "fadeInSec" | "fadeOutSec" | "scale" | "positionX" | "positionY" | "rotationDeg" | "fit"
    >
  >;

type LegacyDirectorEditTrack = Omit<DirectorEditTrack, "visible" | "clips"> & {
  visible?: boolean;
  clips: LegacyDirectorEditClip[];
};

interface AddBoardNodeInput {
  kind: DirectorBoardNodeKind;
  title: string;
  body?: string;
  mediaId?: string | null;
  x: number;
  y: number;
  width?: number;
  height?: number;
  accent?: string;
}

type DirectorBoardNodeProductionPatch = Partial<
  Pick<DirectorBoardNode, "mediaId" | "productionJobId" | "productionJobStatus" | "productionRunId" | "productionError">
>;

interface AddClipInput {
  trackId: string;
  mediaId: string;
  name: string;
  startSec: number;
  durationSec: number;
  sourceDurationSec?: number;
  playbackRate?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  scale?: number;
  positionX?: number;
  positionY?: number;
  rotationDeg?: number;
  fit?: "contain" | "cover";
  transitionInSec?: number;
}

/** Summary of neighbour clips affected by overwrite-with-trim placement. */
export interface DirectorTrackOverwriteSummary {
  /** Neighbours fully covered (or left as sub-minimum remnants) and dropped. */
  removedClipIds: string[];
  /** Neighbours that kept their id but changed start/duration/in/fades. */
  trimmedClipIds: string[];
  /** New clip ids allocated for the trailing half of a spanning split. */
  createdClipIds: string[];
}

const EMPTY_TRACK_OVERWRITE_SUMMARY: DirectorTrackOverwriteSummary = {
  removedClipIds: [],
  trimmedClipIds: [],
  createdClipIds: [],
};

/** Summary of clips affected by a timeline range removal operation. */
export interface DirectorTimelineRangeRemovalSummary {
  /** IDs of clips fully removed by the operation. */
  removedClipIds: string[];
  /** IDs of clips that were trimmed but not removed. */
  trimmedClipIds: string[];
  /** IDs of clips shifted earlier in time to close the gap. */
  shiftedClipIds: string[];
  /** IDs of new clips created by splitting a straddling clip. */
  createdClipIds: string[];
  /** IDs of locked tracks that were skipped. */
  skippedLockedTrackIds: string[];
}

/** Summary of clips affected by a timeline gap insertion operation. */
export interface DirectorTimelineGapInsertionSummary {
  /** IDs of clips shifted later in time to make room. */
  shiftedClipIds: string[];
  /** IDs of clips that were split at the insertion point. */
  splitClipIds: string[];
  /** IDs of new tail clips created by splitting. */
  createdClipIds: string[];
  /** IDs of locked tracks that were skipped. */
  skippedLockedTrackIds: string[];
}

/**
 * Complete Zustand state shape for the Director creative workspace — the
 * Canvas board, Video Editor timeline, Gallery, and their supporting data.
 *
 * Every mutation method records undo history automatically (unless the
 * operation is a no-op) and schedules a debounced localStorage persistence
 * write for the active scope.
 */
export interface DirectorCreativeWorkspaceState {
  /** Currently active workspace panel. */
  mode: DirectorWorkspaceMode;
  /** All nodes on the Canvas board. */
  boardNodes: DirectorBoardNode[];
  /** All directed edges between Canvas board nodes. */
  boardEdges: DirectorBoardEdge[];
  /** Workflow sections that group board nodes. */
  boardSections: DirectorBoardSection[];
  /** Historical pipeline run records on the Canvas board. */
  boardPipelineRuns: DirectorCanvasPipelineRun[];
  /** Current Canvas board viewport (pan offset and zoom). */
  boardViewport: DirectorBoardViewport;
  /** Persisted workspace-level preferences. */
  workspacePrefs: DirectorWorkspacePrefs;
  /** Currently selected board node id, or null. */
  selectedBoardNodeId: string | null;
  /** All tracks in the video editor timeline. */
  editTracks: DirectorEditTrack[];
  /** Aggregate editor settings (aspect ratio, fps, timebase, snap, quality). */
  editSettings: DirectorEditSettings;
  /** Currently selected clip id, or null. */
  selectedClipId: string | null;
  /** Current playhead position in seconds. */
  playheadSec: number;
  /** Current timeline zoom level (0.5–4). */
  timelineZoom: number;
  /** Gallery media metadata records. */
  galleryMedia: DirectorGalleryMediaRecord[];
  /** Gallery folder hierarchy. */
  galleryFolders: DirectorGalleryFolder[];
  /** Gallery UI preferences. */
  galleryPrefs: DirectorGalleryPrefs;
  /** Whether an undo operation is available. */
  canUndo: boolean;
  /** Whether a redo operation is available. */
  canRedo: boolean;

  /** Switch the active workspace panel. */
  setMode: (mode: DirectorWorkspaceMode) => void;
  /** Add a node to the Canvas board. Returns the new node or null at capacity. */
  addBoardNode: (input: AddBoardNodeInput) => DirectorBoardNode | null;
  /** Update mutable fields of an existing board node. */
  updateBoardNode: (nodeId: string, patch: Partial<Omit<DirectorBoardNode, "id">>) => void;
  /** Update production-related fields on a board node without recording undo history. */
  updateBoardNodeProduction: (nodeId: string, patch: DirectorBoardNodeProductionPatch) => void;
  /** Append a production output record to a board node's history. */
  appendBoardNodeProductionOutput: (nodeId: string, output: DirectorCanvasNodeOutput) => void;
  /** Insert or replace a pipeline run in the board's run history. */
  upsertBoardPipelineRun: (run: DirectorCanvasPipelineRun) => void;
  /** Move a board node to the end of the render order (on top). */
  bringBoardNodeToFront: (nodeId: string) => void;
  /** Move a board node to the start of the render order (behind every other node). */
  sendBoardNodeToBack: (nodeId: string) => void;
  /** Remove a board node and all edges incident to it. */
  removeBoardNode: (nodeId: string) => void;
  /** Set the selected board node. Pass null to deselect. */
  selectBoardNode: (nodeId: string | null) => void;
  /** Set the Canvas board viewport (pan and zoom). */
  setBoardViewport: (viewport: DirectorBoardViewport) => void;
  /** Add a workflow section to the board. Returns the new section or null at capacity. */
  addBoardSection: (input?: Partial<Omit<DirectorBoardSection, "id">>) => DirectorBoardSection | null;
  /** Update mutable fields of an existing board section. */
  updateBoardSection: (sectionId: string, patch: Partial<Omit<DirectorBoardSection, "id">>) => void;
  /** Toggle the collapsed/expanded state of a board section. */
  toggleBoardSectionCollapsed: (sectionId: string) => void;
  /** Remove a board section. Nodes in the section are orphaned (sectionId set to null). */
  removeBoardSection: (sectionId: string) => void;
  /** Assign a board node to a section, or remove its section assignment. */
  assignBoardNodeSection: (nodeId: string, sectionId: string | null) => void;
  /** Update workspace-level preferences. */
  updateWorkspacePrefs: (patch: Partial<DirectorWorkspacePrefs>) => void;
  /** Apply a script-to-canvas plan: create sections and nodes from the plan. */
  applyScriptCanvasPlan: (plan: ScriptToCanvasPlan) => void;
  /** Add a directed edge between two board nodes. Returns false if the edge would create a cycle or duplicate. */
  addBoardEdge: (sourceNodeId: string, targetNodeId: string) => boolean;
  /** Remove a board edge by id. */
  removeBoardEdge: (edgeId: string) => void;
  /** Auto-layout the board DAG. Returns false if the DAG is invalid. */
  layoutBoardDag: (options?: DirectorCanvasDagLayoutOptions) => boolean;
  /** Add a clip to a track. Returns the new clip or null if the track is locked or at capacity. */
  addClip: (input: AddClipInput) => DirectorEditClip | null;
  /** Update mutable fields of an existing clip. */
  updateClip: (clipId: string, patch: Partial<Omit<DirectorEditClip, "id">>) => void;
  /** Set the cross-dissolve transition duration for a clip. */
  setClipTransition: (clipId: string, seconds: number) => void;
  /** Move a clip to a different track and/or start time. */
  moveClipToTrack: (clipId: string, trackId: string, startSec: number) => void;
  /** Split a clip at a given time. Returns the new right-half clip or null. */
  splitClip: (clipId: string, atSec: number) => DirectorEditClip | null;
  /** Remove a clip from its track. */
  removeClip: (clipId: string) => void;
  /**
   * Resolve overwrite conflicts after a clip lands on a track. Returns the
   * same removed/trimmed/created id lists Agents see on overwrite receipts.
   */
  commitClipPlacement: (clipId: string) => DirectorTrackOverwriteSummary;
  /** Remove a clip and ripple all later clips on the same track earlier. */
  rippleRemoveClip: (clipId: string) => void;
  /** Remove a time range across one or more tracks, rippling later clips. */
  removeTimelineRange: (
    fromSec: number,
    toSec: number,
    trackIds?: readonly string[],
  ) => DirectorTimelineRangeRemovalSummary;
  /** Insert a gap across one or more tracks, splitting straddling clips and shifting later ones. */
  insertTimelineGap: (
    atSec: number,
    durationSec: number,
    trackIds?: readonly string[],
  ) => DirectorTimelineGapInsertionSummary;
  /** Set the selected clip. Pass null to deselect. */
  selectClip: (clipId: string | null) => void;
  /** Set the playhead position in seconds. */
  setPlayhead: (seconds: number) => void;
  /** Set the timeline zoom level. */
  setTimelineZoom: (zoom: number) => void;
  /** Toggle the mute flag on a track. */
  toggleTrackMute: (trackId: string) => void;
  /** Toggle the lock flag on a track. */
  toggleTrackLock: (trackId: string) => void;
  /** Toggle the visibility flag on a track. */
  toggleTrackVisibility: (trackId: string) => void;
  /** Add a new track. Returns the new track or null at capacity. */
  addTrack: (kind: DirectorVideoTrackKind, name?: string) => DirectorEditTrack | null;
  /** Remove a track (refuses to remove the last video track). */
  removeTrack: (trackId: string) => void;
  /** Rename a track. */
  renameTrack: (trackId: string, name: string) => void;
  /** Update editor-wide settings. */
  updateEditSettings: (patch: Partial<DirectorEditSettings>) => void;
  /** Update or create a gallery media record. */
  updateGalleryMedia: (mediaId: string, patch: Partial<Omit<DirectorGalleryMediaRecord, "mediaId">>) => void;
  /** Replace the entire gallery media collection. */
  replaceGalleryMedia: (records: DirectorGalleryMediaRecord[]) => void;
  /** Move one or more gallery media records to a folder. */
  moveGalleryMedia: (mediaIds: readonly string[], folderId: string | null) => void;
  /** Mark one or more gallery media records as trashed. */
  trashGalleryMedia: (mediaIds: readonly string[], trashedAt?: string) => void;
  /** Restore one or more trashed gallery media records. */
  restoreGalleryMedia: (mediaIds: readonly string[]) => void;
  /** Permanently remove one or more gallery media records. */
  purgeGalleryMedia: (mediaIds: readonly string[]) => void;
  /** Create a new gallery folder. Returns the folder or null at capacity or on name conflict. */
  createGalleryFolder: (name: string, parentId?: string | null) => DirectorGalleryFolder | null;
  /** Rename a gallery folder. */
  renameGalleryFolder: (folderId: string, name: string) => void;
  /** Move a gallery folder to a new parent. */
  moveGalleryFolder: (folderId: string, parentId: string | null) => void;
  /** Remove a gallery folder, reparenting children and media to the folder's parent. */
  removeGalleryFolder: (folderId: string) => void;
  /** Update gallery UI preferences. */
  updateGalleryPrefs: (patch: Partial<DirectorGalleryPrefs>) => void;
  /**
   * Load a serialized workspace snapshot, replacing the current state.
   *
   * @returns true if the payload contained at least one recognized slice.
   */
  loadCreativeWorkspace: (serialized: string) => boolean;
  /** Begin an undo history batch. Mutations are coalesced until endHistoryBatch. */
  beginHistoryBatch: () => void;
  /** End an undo history batch and commit the batch as a single undo entry. */
  endHistoryBatch: () => void;
  /** Roll back to the state captured at the matching beginHistoryBatch call. */
  rollbackHistoryBatch: () => void;
  /** Undo the last recorded mutation. */
  undo: () => void;
  /** Redo the last undone mutation. */
  redo: () => void;
  /** Reset all workspaces to their initial default state. */
  resetCreativeWorkspaces: () => void;
}

const SCOPED_STORAGE_PREFIX = "director.creative-workspaces.v2";
const LEGACY_GLOBAL_V2_STORAGE_KEY = "director.creative-workspaces.v2";
const LEGACY_GLOBAL_V1_STORAGE_KEY = "director.creative-workspaces.v1";
const MAX_BOARD_NODES = 240;
const MAX_BOARD_SECTIONS = 32;
const MAX_TRACK_CLIPS = 400;
const MAX_TRACKS = 12;
const MAX_CLIP_DURATION_SEC = 60 * 60 * 24;
const MIN_CLIP_DURATION_SEC = 0.1;
// Clips whose edges differ by no more than this are treated as merely
// touching, so drag snaps and float error never trigger overwrite trims.
export const DIRECTOR_CLIP_EDGE_EPSILON_SEC = 1e-6;
const CLIP_EDGE_EPSILON = DIRECTOR_CLIP_EDGE_EPSILON_SEC;
// Frame snapping leaves adjacent clips up to a frame-ish gap apart, so
// cross-dissolve adjacency uses a looser tolerance than overwrite trims.
/**
 * Maximum gap (in seconds) between two clips' edges for them to be considered
 * adjacent for cross-dissolve transitions. Frame snapping can leave small gaps
 * that this tolerance absorbs.
 */
export const DIRECTOR_CLIP_TRANSITION_EDGE_TOLERANCE_SEC = 1e-3;
const MIN_CLIP_PLAYBACK_RATE = 0.25;
const MAX_CLIP_PLAYBACK_RATE = 4;
const MAX_CLIP_POSITION_PX = 7680;
const MAX_CLIP_ROTATION_DEG = 3600;
const MIN_CLIP_SCALE = 0.05;
const MAX_CLIP_SCALE = 20;

const DEFAULT_EDIT_SETTINGS: DirectorEditSettings = {
  aspectRatio: "16 / 9",
  fps: 24,
  timebase: createDefaultDirectorTimebase(),
  snapEnabled: true,
  exportQuality: "preview",
};

const finiteNumber = z.number().finite();
const legacyBoardNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["shot", "image", "video", "note", "frame"]),
  title: z.string(),
  body: z.string(),
  mediaId: z.string().nullable(),
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.min(180).max(1200),
  height: finiteNumber.min(120).max(900),
  accent: z.string(),
});
const boardNodeSchema = legacyBoardNodeSchema.extend({
  kind: boardNodeKindSchema,
  sectionId: z.string().nullable().optional(),
  productionJobId: z.string().nullable().optional(),
  productionJobStatus: z.string().nullable().optional(),
  productionRunId: z.string().nullable().optional(),
  productionError: z.string().max(12_000).nullable().optional(),
  productionConfig: directorCanvasProductionConfigSchema.nullable().optional(),
  productionHistory: z.array(directorCanvasNodeOutputSchema).max(DIRECTOR_CANVAS_NODE_OUTPUT_HISTORY_LIMIT).optional(),
});
const boardEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
});
const boardViewportSchema = z.object({
  x: finiteNumber,
  y: finiteNumber,
  zoom: finiteNumber.min(0.1).max(2.5),
});
const editClipBaseShape = {
  id: z.string().min(1),
  mediaId: z.string().min(1),
  name: z.string(),
  startSec: finiteNumber.min(0),
  durationSec: finiteNumber.min(0.1).max(MAX_CLIP_DURATION_SEC),
  inSec: finiteNumber.min(0),
  sourceDurationSec: finiteNumber.min(0.1),
  opacity: finiteNumber.min(0).max(1),
  volume: finiteNumber.min(0).max(1),
};
// Out-of-range clip timing is repaired by normalizeClip on load instead of
// rejecting the document, so the schema only guards shape and finiteness.
const legacyEditClipSchema = z.object(editClipBaseShape);
const editClipSchema = z.object({
  ...editClipBaseShape,
  playbackRate: finiteNumber.min(MIN_CLIP_PLAYBACK_RATE).max(MAX_CLIP_PLAYBACK_RATE).default(1),
  fadeInSec: finiteNumber.min(0).max(MAX_CLIP_DURATION_SEC),
  fadeOutSec: finiteNumber.min(0).max(MAX_CLIP_DURATION_SEC),
  scale: finiteNumber.min(MIN_CLIP_SCALE).max(MAX_CLIP_SCALE),
  positionX: finiteNumber.min(-MAX_CLIP_POSITION_PX).max(MAX_CLIP_POSITION_PX),
  positionY: finiteNumber.min(-MAX_CLIP_POSITION_PX).max(MAX_CLIP_POSITION_PX),
  rotationDeg: finiteNumber.min(-MAX_CLIP_ROTATION_DEG).max(MAX_CLIP_ROTATION_DEG),
  fit: editClipFitSchema,
  // Optional (not defaulted) keeps the inferred clip type additive for
  // existing consumers; normalizeClip resolves the missing field to 0.
  transitionInSec: finiteNumber.min(0).max(MAX_CLIP_DURATION_SEC).optional(),
});
const editTrackBaseShape = {
  id: z.string().min(1),
  name: z.string(),
  kind: videoTrackKindSchema,
  muted: z.boolean(),
  locked: z.boolean(),
};
const legacyEditTrackSchema = z.object({
  ...editTrackBaseShape,
  clips: z.array(legacyEditClipSchema).max(MAX_TRACK_CLIPS),
});
const editTrackSchema = z.object({
  ...editTrackBaseShape,
  visible: z.boolean(),
  clips: z.array(editClipSchema).max(MAX_TRACK_CLIPS),
});
const editTrackShellSchema = z.object({ ...editTrackBaseShape, visible: z.boolean().optional() });
const editSettingsSchema = z.object({
  aspectRatio: editAspectRatioSchema,
  fps: finiteNumber.min(1).max(240),
  timebase: z
    .object({
      rate: z.object({
        numerator: z.number().int().min(1).max(1_000_000),
        denominator: z.number().int().min(1).max(1_000_000),
      }),
      dropFrame: z.boolean(),
      startTimecode: z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/),
    })
    .optional(),
  snapEnabled: z.boolean(),
  exportQuality: editExportQualitySchema,
});
const persistedStateBaseShape = {
  mode: z.preprocess(
    (value) => (value === "cpe" || value === "gallery" ? "stage" : value),
    workspaceModeSchema.optional(),
  ),
  boardEdges: z
    .array(boardEdgeSchema)
    .max(MAX_BOARD_NODES * 2)
    .optional(),
  boardViewport: boardViewportSchema.optional(),
  playheadSec: finiteNumber.min(0).optional(),
  timelineZoom: finiteNumber.min(0.5).max(4).optional(),
};
const persistedCreativeWorkspaceV1Schema = z.object({
  version: z.literal(1),
  state: z.object({
    ...persistedStateBaseShape,
    boardNodes: z.array(legacyBoardNodeSchema).max(MAX_BOARD_NODES).optional(),
    editTracks: z.array(legacyEditTrackSchema).max(MAX_TRACKS).optional(),
  }),
});
const workspacePrefsSchema = z.object({
  autoSendToTimeline: z.boolean(),
});
const persistedStateV2Shape = {
  ...persistedStateBaseShape,
  boardNodes: z.array(boardNodeSchema).max(MAX_BOARD_NODES).optional(),
  editTracks: z.array(editTrackSchema).max(MAX_TRACKS).optional(),
  editSettings: editSettingsSchema.optional(),
};
const persistedCreativeWorkspaceV2Schema = z.object({
  version: z.literal(2),
  state: z.object(persistedStateV2Shape),
});
const persistedStateV3Shape = {
  ...persistedStateV2Shape,
  boardSections: z.array(boardSectionSchema).max(MAX_BOARD_SECTIONS).optional(),
  workspacePrefs: workspacePrefsSchema.optional(),
};
const persistedCreativeWorkspaceV3Schema = z.object({
  version: z.literal(3),
  state: z.object(persistedStateV3Shape),
});
const persistedCreativeWorkspaceV4Schema = z.object({
  version: z.literal(4),
  state: z.object({
    ...persistedStateV3Shape,
    boardPipelineRuns: z.array(directorCanvasPipelineRunSchema).max(DIRECTOR_CANVAS_PIPELINE_HISTORY_LIMIT).optional(),
    galleryMedia: z.array(directorGalleryMediaRecordSchema).max(DIRECTOR_GALLERY_MAX_MEDIA_RECORDS).optional(),
    galleryFolders: z.array(directorGalleryFolderSchema).max(DIRECTOR_GALLERY_MAX_FOLDERS).optional(),
    galleryPrefs: directorGalleryPrefsSchema.optional(),
  }),
});
const persistedCreativeWorkspaceSchema = z.discriminatedUnion("version", [
  persistedCreativeWorkspaceV1Schema,
  persistedCreativeWorkspaceV2Schema,
  persistedCreativeWorkspaceV3Schema,
  persistedCreativeWorkspaceV4Schema,
]);

const DEFAULT_TRACKS: DirectorEditTrack[] = [
  { id: "video-1", name: "视频 1", kind: "video", muted: false, locked: false, visible: true, clips: [] },
  { id: "video-2", name: "视频 2", kind: "video", muted: false, locked: false, visible: true, clips: [] },
  { id: "audio-1", name: "音频 1", kind: "audio", muted: false, locked: false, visible: true, clips: [] },
];

const DEFAULT_WORKSPACE_PREFS: DirectorWorkspacePrefs = {
  autoSendToTimeline: false,
};

function createDefaultBoardSectionsAndNodes() {
  return { boardSections: [] as DirectorBoardSection[], boardNodes: [] as DirectorBoardNode[] };
}

interface CreativeHistorySnapshot {
  boardNodes: DirectorBoardNode[];
  boardEdges: DirectorBoardEdge[];
  boardSections: DirectorBoardSection[];
  workspacePrefs: DirectorWorkspacePrefs;
  editTracks: DirectorEditTrack[];
  editSettings: DirectorEditSettings;
  galleryMedia: DirectorGalleryMediaRecord[];
  galleryFolders: DirectorGalleryFolder[];
  galleryPrefs: DirectorGalleryPrefs;
  selectedBoardNodeId: string | null;
  selectedClipId: string | null;
}

const MAX_HISTORY_ENTRIES = 80;
let historyPast: CreativeHistorySnapshot[] = [];
let historyFuture: CreativeHistorySnapshot[] = [];
let historyBatchDepth = 0;
let historyBatchStart: CreativeHistorySnapshot | null = null;

function cloneTracks(tracks: ReadonlyArray<DirectorEditTrack | LegacyDirectorEditTrack> = DEFAULT_TRACKS) {
  return tracks.map(normalizeTrack);
}

function historySnapshot(
  state: Pick<
    DirectorCreativeWorkspaceState,
    | "boardNodes"
    | "boardEdges"
    | "boardSections"
    | "workspacePrefs"
    | "editTracks"
    | "editSettings"
    | "galleryMedia"
    | "galleryFolders"
    | "galleryPrefs"
    | "selectedBoardNodeId"
    | "selectedClipId"
  >,
) {
  return {
    boardNodes: state.boardNodes.map((node) => ({ ...node })),
    boardEdges: state.boardEdges.map((edge) => ({ ...edge })),
    boardSections: state.boardSections.map((section) => ({ ...section })),
    workspacePrefs: { ...state.workspacePrefs },
    editTracks: cloneTracks(state.editTracks),
    editSettings: { ...state.editSettings },
    galleryMedia: state.galleryMedia.map((record) => ({ ...record, tags: [...record.tags] })),
    galleryFolders: state.galleryFolders.map((folder) => ({ ...folder })),
    galleryPrefs: { ...state.galleryPrefs },
    selectedBoardNodeId: state.selectedBoardNodeId,
    selectedClipId: state.selectedClipId,
  };
}

function sameHistorySnapshot(left: CreativeHistorySnapshot, right: CreativeHistorySnapshot) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordHistoryBefore(state: DirectorCreativeWorkspaceState) {
  if (historyBatchDepth > 0) {
    historyBatchStart ??= historySnapshot(state);
    return { canUndo: state.canUndo, canRedo: state.canRedo };
  }
  const snapshot = historySnapshot(state);
  historyPast = [...historyPast, snapshot].slice(-MAX_HISTORY_ENTRIES);
  historyFuture = [];
  return { canUndo: true, canRedo: false };
}

function withHistory<Patch extends Partial<DirectorCreativeWorkspaceState>>(
  state: DirectorCreativeWorkspaceState,
  patch: Patch,
) {
  return { ...recordHistoryBefore(state), ...patch };
}

function createId(prefix: string) {
  if (typeof globalThis.crypto?.randomUUID === "function") return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeClipFades(fadeInSec: number, fadeOutSec: number, durationSec: number) {
  let fadeIn = clamp(fadeInSec, 0, MAX_CLIP_DURATION_SEC);
  let fadeOut = clamp(fadeOutSec, 0, MAX_CLIP_DURATION_SEC);
  const total = fadeIn + fadeOut;
  if (total > durationSec && total > 0) {
    const ratio = durationSec / total;
    fadeIn *= ratio;
    fadeOut *= ratio;
  }
  return { fadeInSec: fadeIn, fadeOutSec: fadeOut };
}

function normalizeClip(clip: DirectorEditClip | LegacyDirectorEditClip): DirectorEditClip {
  const sourceDurationSec = clamp(clip.sourceDurationSec, 0.1, MAX_CLIP_DURATION_SEC);
  // Cap the rate so a 0.1s minimum duration still fits inside the source,
  // keeping inSec + durationSec * playbackRate <= sourceDurationSec after clamping.
  const playbackRate = clamp(
    clip.playbackRate ?? 1,
    MIN_CLIP_PLAYBACK_RATE,
    Math.min(MAX_CLIP_PLAYBACK_RATE, sourceDurationSec / 0.1),
  );
  const inSec = clamp(clip.inSec, 0, Math.max(0, sourceDurationSec - 0.1 * playbackRate));
  const durationSec = clamp(clip.durationSec, 0.1, Math.max(0.1, (sourceDurationSec - inSec) / playbackRate));
  const fades = normalizeClipFades(clip.fadeInSec ?? 0, clip.fadeOutSec ?? 0, durationSec);
  return {
    ...clip,
    startSec: Number.isFinite(clip.startSec) ? Math.max(0, clip.startSec) : 0,
    durationSec,
    inSec,
    sourceDurationSec,
    playbackRate,
    opacity: clamp(clip.opacity, 0, 1),
    volume: clamp(clip.volume, 0, 1),
    ...fades,
    transitionInSec: clamp(clip.transitionInSec ?? 0, 0, durationSec),
    scale: clamp(clip.scale ?? 1, MIN_CLIP_SCALE, MAX_CLIP_SCALE),
    positionX: clamp(clip.positionX ?? 0, -MAX_CLIP_POSITION_PX, MAX_CLIP_POSITION_PX),
    positionY: clamp(clip.positionY ?? 0, -MAX_CLIP_POSITION_PX, MAX_CLIP_POSITION_PX),
    rotationDeg: clamp(clip.rotationDeg ?? 0, -MAX_CLIP_ROTATION_DEG, MAX_CLIP_ROTATION_DEG),
    fit: clip.fit === "cover" ? "cover" : "contain",
  };
}

/**
 * Overwrite-style conflict resolution after a clip lands on a track: the
 * landed clip stays untouched while every other clip overlapping
 * [landedStart, landedEnd) is truncated, head-trimmed, split in two, or
 * removed. Segments shorter than the 0.1s minimum are dropped instead of
 * leaving fragments. Returns null when nothing overlaps (or the landed clip
 * is missing) so callers can skip recording undo history.
 */
export function resolveDirectorTrackOverwrite(
  clips: readonly DirectorEditClip[],
  landedClipId: string,
): DirectorEditClip[] | null {
  const landed = clips.find((clip) => clip.id === landedClipId);
  if (!landed) return null;
  const landedStart = landed.startSec;
  const landedEnd = landed.startSec + landed.durationSec;
  let changed = false;
  const resolved: DirectorEditClip[] = [];
  for (const clip of clips) {
    if (clip.id === landedClipId) {
      resolved.push(clip);
      continue;
    }
    const clipStart = clip.startSec;
    const clipEnd = clip.startSec + clip.durationSec;
    if (Math.min(clipEnd, landedEnd) - Math.max(clipStart, landedStart) <= CLIP_EDGE_EPSILON) {
      resolved.push(clip);
      continue;
    }
    changed = true;
    const startsBefore = clipStart < landedStart - CLIP_EDGE_EPSILON;
    const endsAfter = clipEnd > landedEnd + CLIP_EDGE_EPSILON;
    if (startsBefore) {
      const leadingDuration = landedStart - clipStart;
      if (leadingDuration >= MIN_CLIP_DURATION_SEC - CLIP_EDGE_EPSILON) {
        // A split drops the left piece's fade-out at the fresh cut; a plain
        // tail truncation keeps it and lets normalizeClipFades shrink it.
        resolved.push(
          normalizeClip(
            endsAfter
              ? { ...clip, durationSec: leadingDuration, fadeOutSec: 0 }
              : { ...clip, durationSec: leadingDuration },
          ),
        );
      }
    }
    if (endsAfter) {
      const trailingDuration = clipEnd - landedEnd;
      if (trailingDuration >= MIN_CLIP_DURATION_SEC - CLIP_EDGE_EPSILON) {
        resolved.push(
          normalizeClip({
            ...clip,
            // The right half of a split is a new clip; a pure head trim keeps
            // its identity (matching splitClip's fade-in semantics either way).
            id: startsBefore ? createId("edit-clip") : clip.id,
            startSec: landedEnd,
            inSec: clip.inSec + (landedEnd - clipStart) * clip.playbackRate,
            durationSec: trailingDuration,
            fadeInSec: 0,
          }),
        );
      }
    }
  }
  return changed ? resolved : null;
}

/**
 * Diff pre/post overwrite clip lists into the same removed/trimmed/created
 * id bags `edit.clip.*` overwrite receipts expose. Pass `null` for `after`
 * when `resolveDirectorTrackOverwrite` reported no change.
 */
export function summarizeDirectorTrackOverwrite(
  before: readonly DirectorEditClip[],
  after: readonly DirectorEditClip[] | null,
  landedClipId: string,
): DirectorTrackOverwriteSummary {
  if (!after) return { ...EMPTY_TRACK_OVERWRITE_SUMMARY };
  const beforeById = new Map(before.map((clip) => [clip.id, clip]));
  const afterById = new Map(after.map((clip) => [clip.id, clip]));
  const removedClipIds: string[] = [];
  const trimmedClipIds: string[] = [];
  const createdClipIds: string[] = [];
  for (const [id, clip] of beforeById) {
    if (id === landedClipId) continue;
    const next = afterById.get(id);
    if (!next) {
      removedClipIds.push(id);
      continue;
    }
    if (
      next.startSec !== clip.startSec ||
      next.durationSec !== clip.durationSec ||
      next.inSec !== clip.inSec ||
      next.fadeInSec !== clip.fadeInSec ||
      next.fadeOutSec !== clip.fadeOutSec
    ) {
      trimmedClipIds.push(id);
    }
  }
  for (const id of afterById.keys()) {
    if (id !== landedClipId && !beforeById.has(id)) createdClipIds.push(id);
  }
  return { removedClipIds, trimmedClipIds, createdClipIds };
}

/**
 * Resolve the same-track clip a cross dissolve enters from: the clip whose
 * end edge touches this clip's start within the frame-snap tolerance
 * (1e-3s). Returns null when the clip has no adjacent predecessor.
 */
export function findDirectorTransitionPredecessor(track: DirectorEditTrack, clipId: string): DirectorEditClip | null {
  const clip = track.clips.find((item) => item.id === clipId);
  if (!clip) return null;
  return (
    track.clips
      .filter(
        (item) =>
          item.id !== clipId &&
          Math.abs(item.startSec + item.durationSec - clip.startSec) <= DIRECTOR_CLIP_TRANSITION_EDGE_TOLERANCE_SEC,
      )
      .sort((left, right) => left.startSec - right.startSec)
      .at(-1) ?? null
  );
}

function normalizeTrack(track: DirectorEditTrack | LegacyDirectorEditTrack): DirectorEditTrack {
  return {
    ...track,
    visible: track.visible ?? true,
    clips: track.clips.slice(0, MAX_TRACK_CLIPS).map(normalizeClip),
  };
}

function ensureVideoTrack(tracks: ReadonlyArray<DirectorEditTrack | LegacyDirectorEditTrack>) {
  const normalized = tracks.slice(0, MAX_TRACKS).map(normalizeTrack);
  if (normalized.some((track) => track.kind === "video")) return normalized;
  if (normalized.length >= MAX_TRACKS) normalized.pop();
  const usedIds = new Set(normalized.map((track) => track.id));
  let suffix = 1;
  while (usedIds.has(`video-${suffix}`)) suffix += 1;
  normalized.push({
    id: `video-${suffix}`,
    name: `视频 ${suffix}`,
    kind: "video",
    muted: false,
    locked: false,
    visible: true,
    clips: [],
  });
  return normalized;
}

function normalizeEditSettings(
  settings: Partial<DirectorEditSettings> | undefined,
  fallback: DirectorEditSettings = DEFAULT_EDIT_SETTINGS,
): DirectorEditSettings {
  const timebase = normalizeDirectorTimebase(settings?.timebase, settings?.fps ?? fallback.fps);
  return {
    aspectRatio: editAspectRatioSchema.catch(fallback.aspectRatio).parse(settings?.aspectRatio),
    fps: frameRateToNumber(timebase.rate),
    timebase,
    snapEnabled: typeof settings?.snapEnabled === "boolean" ? settings.snapEnabled : fallback.snapEnabled,
    exportQuality: editExportQualitySchema.catch(fallback.exportQuality).parse(settings?.exportQuality),
  };
}

function normalizeWorkspacePrefs(
  prefs: Partial<DirectorWorkspacePrefs> | undefined,
  fallback: DirectorWorkspacePrefs = DEFAULT_WORKSPACE_PREFS,
): DirectorWorkspacePrefs {
  return {
    autoSendToTimeline:
      typeof prefs?.autoSendToTimeline === "boolean" ? prefs.autoSendToTimeline : fallback.autoSendToTimeline,
  };
}

function normalizeBoardNode(node: DirectorBoardNode, sections: readonly DirectorBoardSection[]): DirectorBoardNode {
  return {
    ...node,
    sectionId: resolveSectionForNode(node, sections),
    productionJobId: node.productionJobId ?? null,
    productionJobStatus: node.productionJobStatus ?? null,
    productionRunId: node.productionRunId ?? null,
    productionError: node.productionError ?? null,
    productionConfig: node.productionConfig ? directorCanvasProductionConfigSchema.parse(node.productionConfig) : null,
    productionHistory: (node.productionHistory ?? []).slice(-DIRECTOR_CANVAS_NODE_OUTPUT_HISTORY_LIMIT),
  };
}

function normalizeBoardNodesWithSections(nodes: DirectorBoardNode[], sections: readonly DirectorBoardSection[]) {
  return nodes.map((node) => normalizeBoardNode(node, sections));
}

function initialState() {
  const { boardSections, boardNodes } = createDefaultBoardSectionsAndNodes();
  const gallery = createDefaultDirectorGalleryState();
  return {
    mode: "stage" as DirectorWorkspaceMode,
    boardNodes,
    boardEdges: [] as DirectorBoardEdge[],
    boardSections,
    boardPipelineRuns: [] as DirectorCanvasPipelineRun[],
    boardViewport: { x: 0, y: 0, zoom: 1 },
    workspacePrefs: { ...DEFAULT_WORKSPACE_PREFS },
    selectedBoardNodeId: null as string | null,
    editTracks: cloneTracks(),
    editSettings: { ...DEFAULT_EDIT_SETTINGS },
    selectedClipId: null as string | null,
    playheadSec: 0,
    timelineZoom: 1,
    ...gallery,
    canUndo: false,
    canRedo: false,
  };
}

/** localStorage key prefix for backing up corrupt workspace documents before recovery. */
export const DIRECTOR_WORKSPACE_RECOVERY_KEY_PREFIX = "director.creative-workspaces.recovery.";

function backupCorruptCreativeWorkspaceDocument(serialized: string | null) {
  if (typeof window === "undefined" || serialized === null) return null;
  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const existingKey = storage.key(index);
      if (
        existingKey?.startsWith(DIRECTOR_WORKSPACE_RECOVERY_KEY_PREFIX) &&
        storage.getItem(existingKey) === serialized
      ) {
        return existingKey;
      }
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const key = `${DIRECTOR_WORKSPACE_RECOVERY_KEY_PREFIX}${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    storage.setItem(key, serialized);
    console.warn(`[Director] 创意工作区持久化文档校验失败，原始内容已备份到 ${key}`);
    return key;
  } catch {
    return null;
  }
}

interface PersistedWorkspaceSlices {
  mode?: DirectorWorkspaceMode;
  boardNodes?: DirectorBoardNode[];
  boardEdges?: DirectorBoardEdge[];
  boardSections?: DirectorBoardSection[];
  boardPipelineRuns?: DirectorCanvasPipelineRun[];
  boardViewport?: DirectorBoardViewport;
  workspacePrefs?: DirectorWorkspacePrefs;
  editTracks?: Array<DirectorEditTrack | LegacyDirectorEditTrack>;
  editSettings?: DirectorEditSettings;
  galleryMedia?: DirectorGalleryMediaRecord[];
  galleryFolders?: DirectorGalleryFolder[];
  galleryPrefs?: DirectorGalleryPrefs;
  playheadSec?: number;
  timelineZoom?: number;
}

function collectPersistedWorkspaceSlices(
  state: z.infer<typeof persistedCreativeWorkspaceSchema>["state"],
): PersistedWorkspaceSlices {
  return {
    mode: state.mode,
    boardNodes: state.boardNodes,
    boardEdges: state.boardEdges,
    boardViewport: state.boardViewport,
    playheadSec: state.playheadSec,
    timelineZoom: state.timelineZoom,
    editTracks: state.editTracks,
    editSettings: "editSettings" in state ? state.editSettings : undefined,
    boardSections: "boardSections" in state ? state.boardSections : undefined,
    workspacePrefs: "workspacePrefs" in state ? state.workspacePrefs : undefined,
    boardPipelineRuns: "boardPipelineRuns" in state ? state.boardPipelineRuns : undefined,
    galleryMedia: "galleryMedia" in state ? state.galleryMedia : undefined,
    galleryFolders: "galleryFolders" in state ? state.galleryFolders : undefined,
    galleryPrefs: "galleryPrefs" in state ? state.galleryPrefs : undefined,
  };
}

function warnDroppedWorkspaceSlice(slice: string) {
  console.warn(`[Director] 工作区持久化切片“${slice}”损坏，已回退默认值`);
}

function recoverScalarSlice<T>(slice: string, value: unknown, schema: z.ZodType<T>): T | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  warnDroppedWorkspaceSlice(slice);
  return undefined;
}

function recoverArraySlice<T>(
  slice: string,
  value: unknown,
  maxItems: number,
  recoverItem: (item: unknown) => T | null,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warnDroppedWorkspaceSlice(slice);
    return undefined;
  }
  const kept: T[] = [];
  for (const item of value.slice(0, maxItems)) {
    const recovered = recoverItem(item);
    if (recovered !== null) kept.push(recovered);
  }
  const dropped = value.length - kept.length;
  if (dropped > 0) console.warn(`[Director] 工作区持久化切片“${slice}”跳过 ${dropped} 个损坏条目`);
  return kept;
}

function schemaItemRecovery<T>(schema: z.ZodType<T>) {
  return (item: unknown): T | null => {
    const parsed = schema.safeParse(item);
    return parsed.success ? parsed.data : null;
  };
}

function recoverEditClipItem(item: unknown): DirectorEditClip | LegacyDirectorEditClip | null {
  const modern = editClipSchema.safeParse(item);
  if (modern.success) return modern.data;
  const legacy = legacyEditClipSchema.safeParse(item);
  return legacy.success ? legacy.data : null;
}

function recoverEditTrackItem(item: unknown): DirectorEditTrack | LegacyDirectorEditTrack | null {
  if (!isRecord(item) || !Array.isArray(item.clips)) return null;
  const shell = editTrackShellSchema.safeParse(item);
  if (!shell.success) return null;
  const clips =
    recoverArraySlice(`editTracks.${shell.data.id}.clips`, item.clips, MAX_TRACK_CLIPS, recoverEditClipItem) ?? [];
  return { ...shell.data, clips };
}

function recoverPersistedWorkspaceSlices(document: unknown): PersistedWorkspaceSlices {
  if (!isRecord(document) || !isRecord(document.state)) {
    console.warn("[Director] 创意工作区持久化文档无法识别，已回退默认工作区");
    return {};
  }
  const state = document.state;
  return {
    mode: recoverScalarSlice("mode", state.mode, persistedStateBaseShape.mode),
    boardNodes: recoverArraySlice("boardNodes", state.boardNodes, MAX_BOARD_NODES, schemaItemRecovery(boardNodeSchema)),
    boardEdges: recoverArraySlice(
      "boardEdges",
      state.boardEdges,
      MAX_BOARD_NODES * 2,
      schemaItemRecovery(boardEdgeSchema),
    ),
    boardSections: recoverArraySlice(
      "boardSections",
      state.boardSections,
      MAX_BOARD_SECTIONS,
      schemaItemRecovery(boardSectionSchema),
    ),
    boardPipelineRuns: recoverArraySlice(
      "boardPipelineRuns",
      Array.isArray(state.boardPipelineRuns)
        ? state.boardPipelineRuns.slice(-DIRECTOR_CANVAS_PIPELINE_HISTORY_LIMIT)
        : state.boardPipelineRuns,
      DIRECTOR_CANVAS_PIPELINE_HISTORY_LIMIT,
      schemaItemRecovery(directorCanvasPipelineRunSchema),
    ),
    boardViewport: recoverScalarSlice("boardViewport", state.boardViewport, boardViewportSchema),
    workspacePrefs: recoverScalarSlice("workspacePrefs", state.workspacePrefs, workspacePrefsSchema),
    editTracks: recoverArraySlice("editTracks", state.editTracks, MAX_TRACKS, recoverEditTrackItem),
    editSettings: recoverScalarSlice("editSettings", state.editSettings, editSettingsSchema),
    galleryMedia: recoverArraySlice(
      "galleryMedia",
      state.galleryMedia,
      DIRECTOR_GALLERY_MAX_MEDIA_RECORDS,
      schemaItemRecovery(directorGalleryMediaRecordSchema),
    ),
    galleryFolders: recoverArraySlice(
      "galleryFolders",
      state.galleryFolders,
      DIRECTOR_GALLERY_MAX_FOLDERS,
      schemaItemRecovery(directorGalleryFolderSchema),
    ),
    galleryPrefs: recoverScalarSlice("galleryPrefs", state.galleryPrefs, directorGalleryPrefsSchema),
    playheadSec: recoverScalarSlice("playheadSec", state.playheadSec, finiteNumber.min(0)),
    timelineZoom: recoverScalarSlice("timelineZoom", state.timelineZoom, finiteNumber.min(0.5).max(4)),
  };
}

function applyPersistedWorkspaceSlices(slices: PersistedWorkspaceSlices): Partial<ReturnType<typeof initialState>> {
  const result: Partial<ReturnType<typeof initialState>> = {};
  if (slices.mode !== undefined) result.mode = slices.mode;
  if (slices.boardSections !== undefined) {
    result.boardSections = slices.boardSections.map((section) => ({ ...section }));
  }
  if (slices.workspacePrefs !== undefined) {
    result.workspacePrefs = normalizeWorkspacePrefs(slices.workspacePrefs);
  }
  if (slices.galleryMedia !== undefined || slices.galleryFolders !== undefined || slices.galleryPrefs !== undefined) {
    Object.assign(
      result,
      normalizeDirectorGalleryState({
        galleryMedia: slices.galleryMedia,
        galleryFolders: slices.galleryFolders,
        galleryPrefs: slices.galleryPrefs,
      }),
    );
  }
  // Older documents did not contain workflow sections. Keep that absence
  // deterministic instead of inventing per-client UUIDs during migration;
  // script import creates explicit preset sections when the user asks for them.
  const sections = result.boardSections ?? [];
  if (slices.boardNodes !== undefined) {
    result.boardNodes = normalizeBoardNodesWithSections(
      slices.boardNodes.map((node) => ({ ...node })),
      sections,
    );
    const nodeIds = new Set(result.boardNodes.map((node) => node.id));
    if (slices.boardEdges !== undefined) {
      result.boardEdges = slices.boardEdges
        .filter((edge) => edge.sourceNodeId !== edge.targetNodeId)
        .filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId))
        .map((edge) => ({ ...edge }));
    }
  }
  if (slices.boardViewport !== undefined) result.boardViewport = { ...slices.boardViewport };
  if (slices.boardPipelineRuns !== undefined) {
    result.boardPipelineRuns = slices.boardPipelineRuns
      .map((run) => structuredClone(run))
      .slice(-DIRECTOR_CANVAS_PIPELINE_HISTORY_LIMIT);
  }
  if (slices.editTracks !== undefined) result.editTracks = ensureVideoTrack(slices.editTracks);
  if (slices.editSettings !== undefined) result.editSettings = normalizeEditSettings(slices.editSettings);
  if (slices.playheadSec !== undefined) result.playheadSec = slices.playheadSec;
  if (slices.timelineZoom !== undefined) result.timelineZoom = slices.timelineZoom;
  return result;
}

/**
 * Parse a serialized workspace document (v1–v4) into a partial state slice.
 *
 * Corrupt or unrecognized payloads are backed up to localStorage and return
 * an empty object so the caller falls back to defaults without losing data.
 *
 * @param serialized - The JSON string from localStorage, or null.
 * @returns A partial initial-state shape with the recognized slices applied.
 */
export function parseDirectorCreativeWorkspacePersistedState(
  serialized: string | null,
): Partial<ReturnType<typeof initialState>> {
  if (serialized === null) return {};
  let document: unknown = null;
  try {
    document = JSON.parse(serialized);
  } catch {
    backupCorruptCreativeWorkspaceDocument(serialized);
    return {};
  }
  try {
    const parsed = persistedCreativeWorkspaceSchema.safeParse(document);
    if (parsed.success) return applyPersistedWorkspaceSlices(collectPersistedWorkspaceSlices(parsed.data.state));
    backupCorruptCreativeWorkspaceDocument(serialized);
    return applyPersistedWorkspaceSlices(recoverPersistedWorkspaceSlices(document));
  } catch {
    backupCorruptCreativeWorkspaceDocument(serialized);
    return {};
  }
}

/**
 * Serialize the current workspace state into a v4 JSON document suitable for
 * localStorage persistence.
 *
 * @param state - The workspace state slices to serialize.
 * @returns A JSON string with version 4 schema.
 */
export function serializeDirectorCreativeWorkspacePersistedState(
  state: Pick<
    DirectorCreativeWorkspaceState,
    | "mode"
    | "boardNodes"
    | "boardEdges"
    | "boardSections"
    | "boardPipelineRuns"
    | "boardViewport"
    | "workspacePrefs"
    | "editTracks"
    | "editSettings"
    | "galleryMedia"
    | "galleryFolders"
    | "galleryPrefs"
    | "playheadSec"
    | "timelineZoom"
  >,
) {
  return JSON.stringify({
    version: 4,
    state: {
      mode: state.mode,
      boardNodes: state.boardNodes,
      boardEdges: state.boardEdges,
      boardSections: state.boardSections,
      boardPipelineRuns: state.boardPipelineRuns.slice(-DIRECTOR_CANVAS_PIPELINE_HISTORY_LIMIT),
      boardViewport: state.boardViewport,
      workspacePrefs: normalizeWorkspacePrefs(state.workspacePrefs),
      editTracks: cloneTracks(state.editTracks),
      editSettings: normalizeEditSettings(state.editSettings),
      ...normalizeDirectorGalleryState({
        galleryMedia: state.galleryMedia,
        galleryFolders: state.galleryFolders,
        galleryPrefs: state.galleryPrefs,
      }),
      playheadSec: Number.isFinite(state.playheadSec) ? Math.max(0, state.playheadSec) : 0,
      timelineZoom: clamp(state.timelineZoom, 0.5, 4),
    },
  });
}

function normalizeWorkspaceScope(scopeId: string) {
  const trimmed = scopeId.trim();
  if (!trimmed) return "local";
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 128);
  return safe || "local";
}

function storageKeyForScope(scopeId: string) {
  return `${SCOPED_STORAGE_PREFIX}.${scopeId}`;
}

let activeWorkspaceScope = "local";
const workspaceScopeListeners = new Set<(scopeId: string) => void>();
let didAttemptLegacyLocalMigration = false;
let loadedLegacyLocalAtStartup = false;

/** Return the active workspace persistence scope id (defaults to "local"). */
export function getDirectorCreativeWorkspaceScope() {
  return activeWorkspaceScope;
}

/**
 * Subscribe to the normalized persistence scope rather than inferring it from
 * a workspace state replacement. Agent target leases use this as part of
 * their identity, so listeners run only after the new scope has been fully
 * restored.
 */
export function subscribeDirectorCreativeWorkspaceScope(listener: (scopeId: string) => void) {
  workspaceScopeListeners.add(listener);
  return () => workspaceScopeListeners.delete(listener);
}

function readPersistedWorkspaceScope(scopeId: string) {
  if (typeof window === "undefined") return {};
  const mayMigrateLegacy = scopeId === "local" && !didAttemptLegacyLocalMigration;
  if (scopeId === "local") didAttemptLegacyLocalMigration = true;
  const scoped = window.localStorage.getItem(storageKeyForScope(scopeId));
  if (scoped !== null) return parseDirectorCreativeWorkspacePersistedState(scoped);
  if (!mayMigrateLegacy) return {};
  const legacy =
    window.localStorage.getItem(LEGACY_GLOBAL_V2_STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_GLOBAL_V1_STORAGE_KEY);
  if (legacy === null) return {};
  const migrated = parseDirectorCreativeWorkspacePersistedState(legacy);
  loadedLegacyLocalAtStartup = Object.keys(migrated).length > 0;
  return migrated;
}

const persisted = readPersistedWorkspaceScope(activeWorkspaceScope);

function toggleTrackFlag(
  state: DirectorCreativeWorkspaceState,
  trackId: string,
  field: "muted" | "locked" | "visible",
) {
  const track = state.editTracks.find((item) => item.id === trackId);
  if (!track) return state;
  const current = field === "visible" ? (track.visible ?? true) : track[field];
  return withHistory(state, {
    editTracks: state.editTracks.map((item) => (item.id === trackId ? { ...item, [field]: !current } : item)),
  });
}

function galleryFolderWouldCycle(folders: readonly DirectorGalleryFolder[], folderId: string, parentId: string | null) {
  if (!parentId) return false;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const visited = new Set<string>();
  let currentId: string | null = parentId;
  while (currentId) {
    if (currentId === folderId || visited.has(currentId)) return true;
    visited.add(currentId);
    currentId = byId.get(currentId)?.parentId ?? null;
  }
  return false;
}

function patchGalleryMediaCollection(
  records: readonly DirectorGalleryMediaRecord[],
  mediaIds: ReadonlySet<string>,
  folders: readonly DirectorGalleryFolder[],
  patch: (record: DirectorGalleryMediaRecord) => DirectorGalleryMediaRecord,
) {
  const validFolderIds = new Set(folders.map((folder) => folder.id));
  const recordsById = new Map(records.map((record) => [record.mediaId, record]));
  mediaIds.forEach((mediaId) => {
    const normalizedId = mediaId.trim().slice(0, 512);
    if (!normalizedId) return;
    const current = recordsById.get(normalizedId) ?? createDefaultDirectorGalleryMediaRecord(normalizedId);
    const next = normalizeDirectorGalleryMediaRecord(patch({ ...current, tags: [...current.tags] }), validFolderIds);
    if (isDefaultDirectorGalleryMediaRecord(next)) recordsById.delete(normalizedId);
    else recordsById.set(normalizedId, next);
  });
  return [...recordsById.values()].slice(0, DIRECTOR_GALLERY_MAX_MEDIA_RECORDS);
}

function galleryPatchCatalogsMedia(patch: Partial<Omit<DirectorGalleryMediaRecord, "mediaId">>) {
  return (
    (patch.rating ?? 0) > 0 ||
    Boolean(patch.tags?.length) ||
    (patch.color !== undefined && patch.color !== "none") ||
    Boolean(patch.customName) ||
    Boolean(patch.notes?.trim()) ||
    Boolean(patch.folderId) ||
    Boolean(patch.trashedAt)
  );
}

/**
 * The singleton Zustand store for the Director creative workspace.
 *
 * Holds Canvas board state, Video Editor timeline, Gallery, and undo history.
 * On creation, it hydrates from the scoped localStorage key. Every mutation
 * schedules a debounced persistence write to the active scope.
 */
export const useDirectorCreativeWorkspaceStore = create<DirectorCreativeWorkspaceState>((set, get) => ({
  ...initialState(),
  ...persisted,
  setMode: (mode) => set({ mode }),
  addBoardNode: (input) => {
    if (get().boardNodes.length >= MAX_BOARD_NODES) return null;
    const sections = get().boardSections;
    const draft: DirectorBoardNode = {
      id: createId("board-node"),
      kind: input.kind,
      title: input.title.trim() || "未命名节点",
      body: input.body ?? "",
      mediaId: input.mediaId ?? null,
      x: Math.round(Number.isFinite(input.x) ? input.x : 0),
      y: Math.round(Number.isFinite(input.y) ? input.y : 0),
      width: clamp(input.width ?? (input.kind === "frame" ? 680 : input.kind === "note" ? 280 : 320), 180, 1200),
      height: clamp(input.height ?? (input.kind === "frame" ? 420 : input.kind === "note" ? 156 : 220), 120, 900),
      accent:
        input.accent ??
        (input.kind === "video"
          ? "#d96d83"
          : input.kind === "audio"
            ? "#4da58c"
            : input.kind === "note"
              ? "#c9a35f"
              : input.kind === "frame"
                ? "#7fae94"
                : "#45b3d6"),
      productionJobId: null,
      productionJobStatus: null,
      productionRunId: null,
      productionError: null,
      productionConfig: null,
      productionHistory: [],
    };
    const node = normalizeBoardNode(draft, sections);
    set((state) => {
      if (state.boardNodes.length >= MAX_BOARD_NODES) return state;
      return withHistory(state, {
        boardNodes: [...state.boardNodes, node],
        selectedBoardNodeId: node.id,
      });
    });
    return get().boardNodes.some((candidate) => candidate.id === node.id) ? node : null;
  },
  updateBoardNode: (nodeId, patch) =>
    set((state) => {
      if (!state.boardNodes.some((node) => node.id === nodeId)) return state;
      return withHistory(state, {
        boardNodes: state.boardNodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                ...patch,
                x: finiteNumberOr(patch.x, node.x),
                y: finiteNumberOr(patch.y, node.y),
                width: patch.width === undefined ? node.width : clamp(patch.width, 180, 1200),
                height: patch.height === undefined ? node.height : clamp(patch.height, 120, 900),
              }
            : node,
        ),
      });
    }),
  updateBoardNodeProduction: (nodeId, patch) =>
    set((state) => {
      if (!state.boardNodes.some((node) => node.id === nodeId)) return state;
      return {
        boardNodes: state.boardNodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
      };
    }),
  appendBoardNodeProductionOutput: (nodeId, output) => {
    const parsed = directorCanvasNodeOutputSchema.parse(output);
    set((state) => {
      if (!state.boardNodes.some((node) => node.id === nodeId)) return state;
      return {
        boardNodes: state.boardNodes.map((node) => {
          if (node.id !== nodeId) return node;
          const history = (node.productionHistory ?? []).filter(
            (entry) =>
              entry.runId !== parsed.runId ||
              entry.jobId !== parsed.jobId ||
              entry.requestFingerprint !== parsed.requestFingerprint,
          );
          return {
            ...node,
            productionHistory: [...history, parsed].slice(-DIRECTOR_CANVAS_NODE_OUTPUT_HISTORY_LIMIT),
          };
        }),
      };
    });
  },
  upsertBoardPipelineRun: (run) => {
    const parsed = directorCanvasPipelineRunSchema.parse(run);
    set((state) => ({
      boardPipelineRuns: [...state.boardPipelineRuns.filter((candidate) => candidate.id !== parsed.id), parsed].slice(
        -DIRECTOR_CANVAS_PIPELINE_HISTORY_LIMIT,
      ),
    }));
  },
  bringBoardNodeToFront: (nodeId) =>
    set((state) => {
      const index = state.boardNodes.findIndex((node) => node.id === nodeId);
      if (index < 0 || index === state.boardNodes.length - 1) return state;
      const node = state.boardNodes[index]!;
      return withHistory(state, {
        boardNodes: [...state.boardNodes.slice(0, index), ...state.boardNodes.slice(index + 1), node],
      });
    }),
  sendBoardNodeToBack: (nodeId) =>
    set((state) => {
      const index = state.boardNodes.findIndex((node) => node.id === nodeId);
      if (index < 0 || index === 0) return state;
      const node = state.boardNodes[index]!;
      return withHistory(state, {
        boardNodes: [node, ...state.boardNodes.slice(0, index), ...state.boardNodes.slice(index + 1)],
      });
    }),
  removeBoardNode: (nodeId) =>
    set((state) => {
      if (!state.boardNodes.some((node) => node.id === nodeId)) return state;
      return withHistory(state, {
        boardNodes: state.boardNodes.filter((node) => node.id !== nodeId),
        boardEdges: state.boardEdges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId),
        selectedBoardNodeId: state.selectedBoardNodeId === nodeId ? null : state.selectedBoardNodeId,
      });
    }),
  selectBoardNode: (selectedBoardNodeId) => set({ selectedBoardNodeId }),
  setBoardViewport: (viewport) => set({ boardViewport: normalizeCanvasBoardViewport(viewport) }),
  addBoardSection: (input) => {
    if (get().boardSections.length >= MAX_BOARD_SECTIONS) return null;
    const section: DirectorBoardSection = {
      id: createBoardSectionId(),
      kind: input?.kind ?? "custom",
      title: input?.title?.trim() || "新分区",
      collapsed: input?.collapsed ?? false,
      x: Math.round(Number.isFinite(input?.x ?? NaN) ? input!.x! : 80),
      y: Math.round(Number.isFinite(input?.y ?? NaN) ? input!.y! : 80),
      width: clamp(input?.width ?? 720, 240, 2400),
      height: clamp(input?.height ?? 420, 180, 1600),
      accent: input?.accent ?? "#45b3d6",
    };
    set((state) => {
      if (state.boardSections.length >= MAX_BOARD_SECTIONS) return state;
      return withHistory(state, {
        boardSections: [...state.boardSections, section],
      });
    });
    return get().boardSections.some((candidate) => candidate.id === section.id) ? section : null;
  },
  updateBoardSection: (sectionId, patch) =>
    set((state) => {
      if (!state.boardSections.some((section) => section.id === sectionId)) return state;
      return withHistory(state, {
        boardSections: state.boardSections.map((section) =>
          section.id === sectionId
            ? {
                ...section,
                ...patch,
                title: patch.title === undefined ? section.title : patch.title.trim() || section.title,
                x: finiteNumberOr(patch.x, section.x),
                y: finiteNumberOr(patch.y, section.y),
                width: patch.width === undefined ? section.width : clamp(patch.width, 240, 2400),
                height: patch.height === undefined ? section.height : clamp(patch.height, 180, 1600),
              }
            : section,
        ),
      });
    }),
  toggleBoardSectionCollapsed: (sectionId) =>
    set((state) => {
      const section = state.boardSections.find((item) => item.id === sectionId);
      if (!section) return state;
      return withHistory(state, {
        boardSections: state.boardSections.map((item) =>
          item.id === sectionId ? { ...item, collapsed: !item.collapsed } : item,
        ),
      });
    }),
  removeBoardSection: (sectionId) =>
    set((state) => {
      if (!state.boardSections.some((section) => section.id === sectionId)) return state;
      return withHistory(state, {
        boardSections: state.boardSections.filter((section) => section.id !== sectionId),
        boardNodes: state.boardNodes.map((node) =>
          node.sectionId === sectionId ? { ...node, sectionId: null } : node,
        ),
      });
    }),
  assignBoardNodeSection: (nodeId, sectionId) =>
    set((state) => {
      if (!state.boardNodes.some((node) => node.id === nodeId)) return state;
      if (sectionId !== null && !state.boardSections.some((section) => section.id === sectionId)) return state;
      const node = state.boardNodes.find((item) => item.id === nodeId);
      if (!node || node.sectionId === sectionId) return state;
      return withHistory(state, {
        boardNodes: state.boardNodes.map((item) => (item.id === nodeId ? { ...item, sectionId } : item)),
      });
    }),
  updateWorkspacePrefs: (patch) =>
    set((state) => {
      const workspacePrefs = normalizeWorkspacePrefs({ ...state.workspacePrefs, ...patch });
      if (workspacePrefs.autoSendToTimeline === state.workspacePrefs.autoSendToTimeline) return state;
      return withHistory(state, { workspacePrefs });
    }),
  applyScriptCanvasPlan: (plan) =>
    set((state) => {
      const remainingCapacity = MAX_BOARD_NODES - state.boardNodes.length;
      const nodesToAdd = plan.nodes.slice(0, Math.max(0, remainingCapacity)).map((node) =>
        normalizeBoardNode(
          {
            ...node,
            id: createId("board-node"),
            productionRunId: null,
            productionError: null,
            productionConfig: null,
            productionHistory: [],
          },
          plan.sections,
        ),
      );
      return withHistory(state, {
        boardSections: plan.sections.map((section) => ({ ...section })),
        boardNodes: [...state.boardNodes, ...nodesToAdd],
      });
    }),
  addBoardEdge: (sourceNodeId, targetNodeId) => {
    if (sourceNodeId === targetNodeId) return false;
    const { boardEdges, boardNodes } = get();
    if (!boardNodes.some((node) => node.id === sourceNodeId) || !boardNodes.some((node) => node.id === targetNodeId)) {
      return false;
    }
    if (boardEdges.some((edge) => edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId))
      return false;
    if (wouldCreateDirectorCanvasCycle(boardNodes, boardEdges, sourceNodeId, targetNodeId)) return false;
    set((state) =>
      withHistory(state, {
        boardEdges: [...state.boardEdges, { id: createId("board-edge"), sourceNodeId, targetNodeId }],
      }),
    );
    return true;
  },
  removeBoardEdge: (edgeId) =>
    set((state) => {
      if (!state.boardEdges.some((edge) => edge.id === edgeId)) return state;
      return withHistory(state, {
        boardEdges: state.boardEdges.filter((edge) => edge.id !== edgeId),
      });
    }),
  layoutBoardDag: (options) => {
    const state = get();
    const layout = layoutDirectorCanvasDag(state.boardNodes, state.boardEdges, options);
    if (!layout.analysis.valid || layout.positions.size !== state.boardNodes.length) return false;
    const changed = state.boardNodes.some((node) => {
      const position = layout.positions.get(node.id);
      return position && (position.x !== node.x || position.y !== node.y);
    });
    if (!changed) return true;
    set((current) =>
      withHistory(current, {
        boardNodes: current.boardNodes.map((node) => {
          const position = layout.positions.get(node.id);
          return position ? { ...node, ...position } : node;
        }),
      }),
    );
    return true;
  },
  addClip: (input) => {
    const track = get().editTracks.find((item) => item.id === input.trackId);
    if (!track || track.locked || track.clips.length >= MAX_TRACK_CLIPS) return null;
    const playbackRate = clamp(input.playbackRate ?? 1, MIN_CLIP_PLAYBACK_RATE, MAX_CLIP_PLAYBACK_RATE);
    const duration = clamp(input.durationSec, 0.1, MAX_CLIP_DURATION_SEC);
    const sourceDuration = clamp(
      input.sourceDurationSec ?? duration * playbackRate,
      duration * playbackRate,
      MAX_CLIP_DURATION_SEC,
    );
    const fades = normalizeClipFades(input.fadeInSec ?? 0, input.fadeOutSec ?? 0, duration);
    const clip = normalizeClip({
      id: createId("edit-clip"),
      mediaId: input.mediaId,
      name: input.name.trim() || "未命名剪辑",
      startSec: Number.isFinite(input.startSec) ? Math.max(0, input.startSec) : 0,
      durationSec: duration,
      inSec: 0,
      sourceDurationSec: sourceDuration,
      playbackRate,
      opacity: 1,
      volume: 1,
      ...fades,
      transitionInSec: input.transitionInSec ?? 0,
      scale: input.scale ?? 1,
      positionX: input.positionX ?? 0,
      positionY: input.positionY ?? 0,
      rotationDeg: input.rotationDeg ?? 0,
      fit: input.fit ?? "contain",
    });
    set((state) =>
      withHistory(state, {
        editTracks: state.editTracks.map((item) =>
          item.id === input.trackId ? { ...item, clips: [...item.clips, clip] } : item,
        ),
        selectedClipId: clip.id,
        playheadSec: clip.startSec,
      }),
    );
    return clip;
  },
  updateClip: (clipId, patch) =>
    set((state) => {
      const owner = state.editTracks.find((track) => track.clips.some((clip) => clip.id === clipId));
      if (!owner || owner.locked) return state;
      return withHistory(state, {
        editTracks: state.editTracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => {
            if (clip.id !== clipId || track.locked) return clip;
            const current = normalizeClip(clip);
            const nextSourceDuration = clamp(
              finiteNumberOr(patch.sourceDurationSec, current.sourceDurationSec),
              0.1,
              MAX_CLIP_DURATION_SEC,
            );
            const nextIn = clamp(finiteNumberOr(patch.inSec, current.inSec), 0, Math.max(0, nextSourceDuration - 0.1));
            const nextPlaybackRate = clamp(
              finiteNumberOr(patch.playbackRate, current.playbackRate),
              MIN_CLIP_PLAYBACK_RATE,
              MAX_CLIP_PLAYBACK_RATE,
            );
            const nextDuration = clamp(
              finiteNumberOr(patch.durationSec, current.durationSec),
              0.1,
              Math.max(0.1, (nextSourceDuration - nextIn) / nextPlaybackRate),
            );
            const fades = normalizeClipFades(
              finiteNumberOr(patch.fadeInSec, current.fadeInSec ?? 0),
              finiteNumberOr(patch.fadeOutSec, current.fadeOutSec ?? 0),
              nextDuration,
            );
            return {
              ...current,
              ...patch,
              startSec: Math.max(0, finiteNumberOr(patch.startSec, current.startSec)),
              durationSec: nextDuration,
              inSec: nextIn,
              sourceDurationSec: nextSourceDuration,
              playbackRate: nextPlaybackRate,
              opacity: clamp(finiteNumberOr(patch.opacity, current.opacity), 0, 1),
              volume: clamp(finiteNumberOr(patch.volume, current.volume), 0, 1),
              ...fades,
              transitionInSec: clamp(
                finiteNumberOr(patch.transitionInSec, current.transitionInSec ?? 0),
                0,
                nextDuration,
              ),
              scale: clamp(finiteNumberOr(patch.scale, current.scale ?? 1), MIN_CLIP_SCALE, MAX_CLIP_SCALE),
              positionX: clamp(
                finiteNumberOr(patch.positionX, current.positionX ?? 0),
                -MAX_CLIP_POSITION_PX,
                MAX_CLIP_POSITION_PX,
              ),
              positionY: clamp(
                finiteNumberOr(patch.positionY, current.positionY ?? 0),
                -MAX_CLIP_POSITION_PX,
                MAX_CLIP_POSITION_PX,
              ),
              rotationDeg: clamp(
                finiteNumberOr(patch.rotationDeg, current.rotationDeg ?? 0),
                -MAX_CLIP_ROTATION_DEG,
                MAX_CLIP_ROTATION_DEG,
              ),
              fit: patch.fit === "cover" || patch.fit === "contain" ? patch.fit : current.fit,
            };
          }),
        })),
      });
    }),
  setClipTransition: (clipId, seconds) =>
    set((state) => {
      const owner = state.editTracks.find((track) => track.clips.some((clip) => clip.id === clipId));
      const clip = owner?.clips.find((item) => item.id === clipId);
      if (!owner || owner.locked || !clip) return state;
      const predecessor = findDirectorTransitionPredecessor(owner, clipId);
      if (!predecessor && Number.isFinite(seconds) && seconds > 0) return state;
      const next = predecessor ? clamp(seconds, 0, Math.min(clip.durationSec, predecessor.durationSec)) : 0;
      if (next === (clip.transitionInSec ?? 0)) return state;
      return withHistory(state, {
        editTracks: state.editTracks.map((track) =>
          track.id === owner.id
            ? {
                ...track,
                clips: track.clips.map((item) =>
                  item.id === clipId ? normalizeClip({ ...item, transitionInSec: next }) : item,
                ),
              }
            : track,
        ),
      });
    }),
  moveClipToTrack: (clipId, trackId, startSec) => {
    const state = get();
    const destination = state.editTracks.find((track) => track.id === trackId);
    if (!destination || destination.locked || destination.clips.length >= MAX_TRACK_CLIPS) return;
    const sourceTrack = state.editTracks.find((track) => track.clips.some((clip) => clip.id === clipId));
    const moving = sourceTrack?.clips.find((clip) => clip.id === clipId);
    if (!moving || !sourceTrack || sourceTrack.locked || sourceTrack.kind !== destination.kind) return;
    const moved = {
      ...moving,
      startSec: Number.isFinite(startSec) ? Math.max(0, startSec) : moving.startSec,
    };
    set((current) =>
      withHistory(current, {
        editTracks: state.editTracks.map((track) => ({
          ...track,
          clips: [...track.clips.filter((clip) => clip.id !== clipId), ...(track.id === trackId ? [moved] : [])],
        })),
      }),
    );
  },
  splitClip: (clipId, atSec) => {
    const state = get();
    const owner = state.editTracks.find((track) => track.clips.some((clip) => clip.id === clipId));
    const storedSource = owner?.clips.find((clip) => clip.id === clipId);
    if (!owner || owner.locked || !storedSource) return null;
    const source = normalizeClip(storedSource);
    const offset = atSec - source.startSec;
    if (offset < 0.1 || offset > source.durationSec - 0.1) return null;
    const created = normalizeClip({
      ...source,
      id: createId("edit-clip"),
      startSec: atSec,
      durationSec: source.durationSec - offset,
      inSec: source.inSec + offset * source.playbackRate,
      fadeInSec: 0,
      fadeOutSec: source.fadeOutSec ?? 0,
      // The cut point is not a transition point; only the left half keeps
      // dissolving in from the clip that preceded the original.
      transitionInSec: 0,
    });
    const editTracks = state.editTracks.map((track) => ({
      ...track,
      clips: track.clips.flatMap((clip) => {
        if (clip.id !== clipId) return [clip];
        return [normalizeClip({ ...source, durationSec: offset, fadeOutSec: 0 }), created];
      }),
    }));
    set((current) => withHistory(current, { editTracks, selectedClipId: created.id }));
    return created;
  },
  removeClip: (clipId) =>
    set((state) => {
      const owner = state.editTracks.find((track) => track.clips.some((clip) => clip.id === clipId));
      if (!owner || owner.locked) return state;
      return withHistory(state, {
        editTracks: state.editTracks.map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => clip.id !== clipId),
        })),
        selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
      });
    }),
  commitClipPlacement: (clipId) => {
    let summary: DirectorTrackOverwriteSummary = { ...EMPTY_TRACK_OVERWRITE_SUMMARY };
    set((state) => {
      const owner = state.editTracks.find((track) => track.clips.some((clip) => clip.id === clipId));
      if (!owner || owner.locked) return state;
      const resolved = resolveDirectorTrackOverwrite(owner.clips, clipId);
      if (!resolved) return state;
      summary = summarizeDirectorTrackOverwrite(owner.clips, resolved, clipId);
      const keptClipIds = new Set(resolved.map((clip) => clip.id));
      const selectionRemoved =
        state.selectedClipId !== null &&
        !keptClipIds.has(state.selectedClipId) &&
        owner.clips.some((clip) => clip.id === state.selectedClipId);
      return withHistory(state, {
        editTracks: state.editTracks.map((track) => (track.id === owner.id ? { ...track, clips: resolved } : track)),
        selectedClipId: selectionRemoved ? null : state.selectedClipId,
      });
    });
    return summary;
  },
  rippleRemoveClip: (clipId) =>
    set((state) => {
      const owner = state.editTracks.find((track) => track.clips.some((clip) => clip.id === clipId));
      const removed = owner?.clips.find((clip) => clip.id === clipId);
      if (!owner || owner.locked || !removed) return state;
      return withHistory(state, {
        editTracks: state.editTracks.map((track) =>
          track.id === owner.id
            ? {
                ...track,
                clips: track.clips
                  .filter((clip) => clip.id !== clipId)
                  .map((clip) =>
                    clip.startSec > removed.startSec + CLIP_EDGE_EPSILON
                      ? normalizeClip({ ...clip, startSec: Math.max(0, clip.startSec - removed.durationSec) })
                      : clip,
                  ),
              }
            : track,
        ),
        selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
      });
    }),
  removeTimelineRange: (fromSec, toSec, trackIds) => {
    const summary: DirectorTimelineRangeRemovalSummary = {
      removedClipIds: [],
      trimmedClipIds: [],
      shiftedClipIds: [],
      createdClipIds: [],
      skippedLockedTrackIds: [],
    };
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) return summary;
    const shiftSec = toSec - fromSec;
    const targetIds = trackIds?.length ? new Set(trackIds) : null;
    const state = get();
    const removedClipIds = new Set<string>();
    let changed = false;
    const editTracks = state.editTracks.map((track) => {
      if (targetIds && !targetIds.has(track.id)) return track;
      if (track.locked) {
        summary.skippedLockedTrackIds.push(track.id);
        return track;
      }
      const clips: DirectorEditClip[] = [];
      for (const clip of track.clips) {
        const clipStart = clip.startSec;
        const clipEnd = clip.startSec + clip.durationSec;
        if (clipEnd <= fromSec + CLIP_EDGE_EPSILON) {
          clips.push(clip);
          continue;
        }
        if (clipStart >= toSec - CLIP_EDGE_EPSILON) {
          clips.push(normalizeClip({ ...clip, startSec: Math.max(0, clipStart - shiftSec) }));
          summary.shiftedClipIds.push(clip.id);
          changed = true;
          continue;
        }
        changed = true;
        const headSec = fromSec - clipStart;
        const tailSec = clipEnd - toSec;
        // Surviving pieces shorter than the 0.1s clip minimum are absorbed by
        // the ripple instead of being kept as unusable slivers.
        const keepHead = headSec >= MIN_CLIP_DURATION_SEC - CLIP_EDGE_EPSILON;
        const keepTail = tailSec >= MIN_CLIP_DURATION_SEC - CLIP_EDGE_EPSILON;
        if (!keepHead && !keepTail) {
          removedClipIds.add(clip.id);
          summary.removedClipIds.push(clip.id);
          continue;
        }
        if (keepHead) {
          // A middle removal is a fresh cut, so the head drops its fade-out
          // (mirroring splitClip); a plain tail trim keeps it and lets
          // normalizeClipFades shrink it.
          clips.push(
            normalizeClip(
              keepTail ? { ...clip, durationSec: headSec, fadeOutSec: 0 } : { ...clip, durationSec: headSec },
            ),
          );
          summary.trimmedClipIds.push(clip.id);
        }
        if (keepTail) {
          const tail = normalizeClip({
            ...clip,
            id: keepHead ? createId("edit-clip") : clip.id,
            startSec: fromSec,
            inSec: clip.inSec + (toSec - clipStart) * clip.playbackRate,
            durationSec: tailSec,
            // The tail starts at a fresh cut, matching splitClip's semantics.
            fadeInSec: 0,
            transitionInSec: 0,
          });
          clips.push(tail);
          if (keepHead) {
            summary.createdClipIds.push(tail.id);
          } else {
            summary.trimmedClipIds.push(clip.id);
            summary.shiftedClipIds.push(clip.id);
          }
        }
      }
      return { ...track, clips };
    });
    if (!changed) return summary;
    set((current) =>
      withHistory(current, {
        editTracks,
        selectedClipId:
          current.selectedClipId && removedClipIds.has(current.selectedClipId) ? null : current.selectedClipId,
      }),
    );
    return summary;
  },
  insertTimelineGap: (atSec, durationSec, trackIds) => {
    const summary: DirectorTimelineGapInsertionSummary = {
      shiftedClipIds: [],
      splitClipIds: [],
      createdClipIds: [],
      skippedLockedTrackIds: [],
    };
    if (!Number.isFinite(atSec) || !Number.isFinite(durationSec) || durationSec <= 0) return summary;
    const targetIds = trackIds?.length ? new Set(trackIds) : null;
    const state = get();
    let changed = false;
    const editTracks = state.editTracks.map((track) => {
      if (targetIds && !targetIds.has(track.id)) return track;
      if (track.locked) {
        summary.skippedLockedTrackIds.push(track.id);
        return track;
      }
      const clips: DirectorEditClip[] = [];
      for (const clip of track.clips) {
        const clipStart = clip.startSec;
        const clipEnd = clip.startSec + clip.durationSec;
        if (clipEnd <= atSec + CLIP_EDGE_EPSILON) {
          clips.push(clip);
          continue;
        }
        const headSec = atSec - clipStart;
        const tailSec = clipEnd - atSec;
        if (headSec < MIN_CLIP_DURATION_SEC) {
          // Starts at the gap point (or a sub-minimum sliver before it that
          // could not survive a split): the whole clip moves right.
          clips.push(normalizeClip({ ...clip, startSec: clipStart + durationSec }));
          summary.shiftedClipIds.push(clip.id);
          changed = true;
          continue;
        }
        if (tailSec < MIN_CLIP_DURATION_SEC) {
          // Ends in a sub-minimum sliver past the gap point: treated as
          // ending at the point, so the clip stays put.
          clips.push(clip);
          continue;
        }
        // Straddling clip: split at the gap point (fade and transition
        // semantics mirror splitClip) and shift only the new tail right.
        const tail = normalizeClip({
          ...clip,
          id: createId("edit-clip"),
          startSec: atSec + durationSec,
          inSec: clip.inSec + headSec * clip.playbackRate,
          durationSec: tailSec,
          fadeInSec: 0,
          transitionInSec: 0,
        });
        clips.push(normalizeClip({ ...clip, durationSec: headSec, fadeOutSec: 0 }), tail);
        summary.splitClipIds.push(clip.id);
        summary.createdClipIds.push(tail.id);
        summary.shiftedClipIds.push(tail.id);
        changed = true;
      }
      return { ...track, clips };
    });
    if (!changed) return summary;
    set((current) => withHistory(current, { editTracks }));
    return summary;
  },
  selectClip: (selectedClipId) => set({ selectedClipId }),
  setPlayhead: (playheadSec) =>
    set((state) => ({ playheadSec: Number.isFinite(playheadSec) ? Math.max(0, playheadSec) : state.playheadSec })),
  setTimelineZoom: (timelineZoom) => set({ timelineZoom: clamp(timelineZoom, 0.5, 4) }),
  toggleTrackMute: (trackId) => set((state) => toggleTrackFlag(state, trackId, "muted")),
  toggleTrackLock: (trackId) => set((state) => toggleTrackFlag(state, trackId, "locked")),
  toggleTrackVisibility: (trackId) => set((state) => toggleTrackFlag(state, trackId, "visible")),
  addTrack: (kind, name) => {
    const state = get();
    if (state.editTracks.length >= MAX_TRACKS) return null;
    const usedIds = new Set(state.editTracks.map((track) => track.id));
    let suffix = 1;
    while (usedIds.has(`${kind}-${suffix}`)) suffix += 1;
    const track: DirectorEditTrack = {
      id: `${kind}-${suffix}`,
      name: name?.trim() || `${kind === "video" ? "视频" : "音频"} ${suffix}`,
      kind,
      muted: false,
      locked: false,
      visible: true,
      clips: [],
    };
    set((current) =>
      withHistory(current, {
        editTracks: [...current.editTracks, track],
      }),
    );
    return track;
  },
  removeTrack: (trackId) =>
    set((state) => {
      const track = state.editTracks.find((item) => item.id === trackId);
      if (!track) return state;
      if (track.kind === "video" && state.editTracks.filter((item) => item.kind === "video").length <= 1) {
        return state;
      }
      const removedClipIds = new Set(track.clips.map((clip) => clip.id));
      return withHistory(state, {
        editTracks: state.editTracks.filter((item) => item.id !== trackId),
        selectedClipId: state.selectedClipId && removedClipIds.has(state.selectedClipId) ? null : state.selectedClipId,
      });
    }),
  renameTrack: (trackId, name) =>
    set((state) => {
      const nextName = name.trim().slice(0, 120);
      const track = state.editTracks.find((item) => item.id === trackId);
      if (!track || !nextName || track.name === nextName) return state;
      return withHistory(state, {
        editTracks: state.editTracks.map((item) => (item.id === trackId ? { ...item, name: nextName } : item)),
      });
    }),
  updateEditSettings: (patch) =>
    set((state) => {
      const merged = { ...state.editSettings, ...patch };
      if (patch.fps !== undefined && patch.timebase === undefined) {
        const currentTimebase = normalizeDirectorTimebase(state.editSettings.timebase, state.editSettings.fps);
        const rate = normalizeDirectorTimebase(undefined, patch.fps).rate;
        const dropFrame =
          currentTimebase.dropFrame &&
          ((rate.numerator === 30_000 && rate.denominator === 1_001) ||
            (rate.numerator === 60_000 && rate.denominator === 1_001));
        merged.timebase = {
          rate,
          dropFrame,
          startTimecode: dropFrame
            ? currentTimebase.startTimecode.replace(/:(\d{2})$/, ";$1")
            : currentTimebase.startTimecode.replace(/;(\d{2})$/, ":$1"),
        };
      }
      const editSettings = normalizeEditSettings(merged, state.editSettings);
      if (
        editSettings.aspectRatio === state.editSettings.aspectRatio &&
        editSettings.fps === state.editSettings.fps &&
        JSON.stringify(editSettings.timebase) === JSON.stringify(state.editSettings.timebase) &&
        editSettings.snapEnabled === state.editSettings.snapEnabled &&
        editSettings.exportQuality === state.editSettings.exportQuality
      ) {
        return state;
      }
      return withHistory(state, { editSettings });
    }),
  updateGalleryMedia: (mediaId, patch) =>
    set((state) => {
      const normalizedId = mediaId.trim().slice(0, 512);
      if (!normalizedId) return state;
      const catalogedAt = galleryPatchCatalogsMedia(patch) ? new Date().toISOString() : null;
      const next = patchGalleryMediaCollection(
        state.galleryMedia,
        new Set([normalizedId]),
        state.galleryFolders,
        (record) => ({
          ...record,
          ...patch,
          mediaId: normalizedId,
          addedAt: patch.addedAt !== undefined ? patch.addedAt : (record.addedAt ?? (catalogedAt ? catalogedAt : null)),
        }),
      );
      if (JSON.stringify(next) === JSON.stringify(state.galleryMedia)) return state;
      return withHistory(state, { galleryMedia: next });
    }),
  replaceGalleryMedia: (records) =>
    set((state) => {
      const normalized = normalizeDirectorGalleryState({
        galleryMedia: records,
        galleryFolders: state.galleryFolders,
        galleryPrefs: state.galleryPrefs,
      }).galleryMedia;
      if (JSON.stringify(normalized) === JSON.stringify(state.galleryMedia)) return state;
      return withHistory(state, { galleryMedia: normalized });
    }),
  moveGalleryMedia: (mediaIds, folderId) =>
    set((state) => {
      const resolvedFolderId =
        folderId && state.galleryFolders.some((folder) => folder.id === folderId) ? folderId : null;
      const ids = new Set(mediaIds.map((id) => id.trim()).filter(Boolean));
      if (!ids.size) return state;
      const catalogedAt = resolvedFolderId ? new Date().toISOString() : null;
      const galleryMedia = patchGalleryMediaCollection(state.galleryMedia, ids, state.galleryFolders, (record) => ({
        ...record,
        folderId: resolvedFolderId,
        addedAt: record.addedAt ?? catalogedAt,
      }));
      if (JSON.stringify(galleryMedia) === JSON.stringify(state.galleryMedia)) return state;
      return withHistory(state, { galleryMedia });
    }),
  trashGalleryMedia: (mediaIds, trashedAt = new Date().toISOString()) =>
    set((state) => {
      const ids = new Set(mediaIds.map((id) => id.trim()).filter(Boolean));
      if (!ids.size) return state;
      const safeTimestamp = Number.isNaN(Date.parse(trashedAt))
        ? new Date().toISOString()
        : new Date(trashedAt).toISOString();
      const galleryMedia = patchGalleryMediaCollection(state.galleryMedia, ids, state.galleryFolders, (record) => ({
        ...record,
        addedAt: record.addedAt ?? safeTimestamp,
        trashedAt: safeTimestamp,
      }));
      return withHistory(state, { galleryMedia });
    }),
  restoreGalleryMedia: (mediaIds) =>
    set((state) => {
      const ids = new Set(mediaIds.map((id) => id.trim()).filter(Boolean));
      if (!ids.size) return state;
      const galleryMedia = patchGalleryMediaCollection(state.galleryMedia, ids, state.galleryFolders, (record) => ({
        ...record,
        trashedAt: null,
      }));
      return withHistory(state, { galleryMedia });
    }),
  purgeGalleryMedia: (mediaIds) =>
    set((state) => {
      const ids = new Set(mediaIds);
      const galleryMedia = state.galleryMedia.filter((record) => !ids.has(record.mediaId));
      if (galleryMedia.length === state.galleryMedia.length) return state;
      return withHistory(state, { galleryMedia });
    }),
  createGalleryFolder: (name, parentId = null) => {
    const state = get();
    if (state.galleryFolders.length >= DIRECTOR_GALLERY_MAX_FOLDERS) return null;
    const nextName = name.trim().slice(0, 120);
    if (!nextName) return null;
    const resolvedParentId =
      parentId && state.galleryFolders.some((folder) => folder.id === parentId) ? parentId : null;
    if (
      state.galleryFolders.some(
        (folder) =>
          folder.parentId === resolvedParentId &&
          folder.name.localeCompare(nextName, undefined, { sensitivity: "accent" }) === 0,
      )
    ) {
      return null;
    }
    const folder: DirectorGalleryFolder = {
      id: createId("gallery-folder"),
      name: nextName,
      parentId: resolvedParentId,
      createdAt: new Date().toISOString(),
    };
    set((current) => withHistory(current, { galleryFolders: [...current.galleryFolders, folder] }));
    return folder;
  },
  renameGalleryFolder: (folderId, name) =>
    set((state) => {
      const folder = state.galleryFolders.find((candidate) => candidate.id === folderId);
      const nextName = name.trim().slice(0, 120);
      if (!folder || !nextName || folder.name === nextName) return state;
      if (
        state.galleryFolders.some(
          (candidate) =>
            candidate.id !== folderId &&
            candidate.parentId === folder.parentId &&
            candidate.name.localeCompare(nextName, undefined, { sensitivity: "accent" }) === 0,
        )
      ) {
        return state;
      }
      return withHistory(state, {
        galleryFolders: state.galleryFolders.map((candidate) =>
          candidate.id === folderId ? { ...candidate, name: nextName } : candidate,
        ),
      });
    }),
  moveGalleryFolder: (folderId, parentId) =>
    set((state) => {
      const folder = state.galleryFolders.find((candidate) => candidate.id === folderId);
      const resolvedParentId =
        parentId && state.galleryFolders.some((candidate) => candidate.id === parentId) ? parentId : null;
      if (
        !folder ||
        folder.parentId === resolvedParentId ||
        galleryFolderWouldCycle(state.galleryFolders, folderId, resolvedParentId)
      ) {
        return state;
      }
      return withHistory(state, {
        galleryFolders: state.galleryFolders.map((candidate) =>
          candidate.id === folderId ? { ...candidate, parentId: resolvedParentId } : candidate,
        ),
      });
    }),
  removeGalleryFolder: (folderId) =>
    set((state) => {
      const folder = state.galleryFolders.find((candidate) => candidate.id === folderId);
      if (!folder) return state;
      return withHistory(state, {
        galleryFolders: state.galleryFolders
          .filter((candidate) => candidate.id !== folderId)
          .map((candidate) =>
            candidate.parentId === folderId ? { ...candidate, parentId: folder.parentId } : candidate,
          ),
        galleryMedia: state.galleryMedia.map((record) =>
          record.folderId === folderId ? { ...record, folderId: folder.parentId } : record,
        ),
        galleryPrefs:
          state.galleryPrefs.activeFolderId === folderId
            ? { ...state.galleryPrefs, activeFolderId: folder.parentId }
            : state.galleryPrefs,
      });
    }),
  updateGalleryPrefs: (patch) =>
    set((state) => {
      const galleryPrefs = normalizeDirectorGalleryState({
        galleryMedia: state.galleryMedia,
        galleryFolders: state.galleryFolders,
        galleryPrefs: { ...state.galleryPrefs, ...patch },
      }).galleryPrefs;
      if (JSON.stringify(galleryPrefs) === JSON.stringify(state.galleryPrefs)) return state;
      return withHistory(state, { galleryPrefs });
    }),
  loadCreativeWorkspace: (serialized) => {
    const restored = parseDirectorCreativeWorkspacePersistedState(serialized);
    if (Object.keys(restored).length === 0) return false;
    historyPast = [];
    historyFuture = [];
    historyBatchDepth = 0;
    historyBatchStart = null;
    set({ ...initialState(), ...restored, canUndo: false, canRedo: false });
    return true;
  },
  beginHistoryBatch: () => {
    historyBatchDepth += 1;
    if (historyBatchDepth === 1) historyBatchStart = historySnapshot(get());
  },
  endHistoryBatch: () => {
    if (historyBatchDepth <= 0) return;
    historyBatchDepth -= 1;
    if (historyBatchDepth > 0) return;
    const start = historyBatchStart;
    historyBatchStart = null;
    if (!start || sameHistorySnapshot(start, historySnapshot(get()))) return;
    historyPast = [...historyPast, start].slice(-MAX_HISTORY_ENTRIES);
    historyFuture = [];
    set({ canUndo: true, canRedo: false });
  },
  rollbackHistoryBatch: () => {
    const start = historyBatchStart;
    historyBatchDepth = 0;
    historyBatchStart = null;
    if (!start) return;
    set(() => ({
      ...historySnapshot(start),
      canUndo: historyPast.length > 0,
      canRedo: historyFuture.length > 0,
    }));
  },
  undo: () => {
    const previous = historyPast.at(-1);
    if (!previous) return;
    historyPast = historyPast.slice(0, -1);
    historyFuture = [...historyFuture, historySnapshot(get())].slice(-MAX_HISTORY_ENTRIES);
    set(() => ({
      ...historySnapshot(previous),
      canUndo: historyPast.length > 0,
      canRedo: true,
    }));
  },
  redo: () => {
    const next = historyFuture.at(-1);
    if (!next) return;
    historyFuture = historyFuture.slice(0, -1);
    historyPast = [...historyPast, historySnapshot(get())].slice(-MAX_HISTORY_ENTRIES);
    set(() => ({
      ...historySnapshot(next),
      canUndo: true,
      canRedo: historyFuture.length > 0,
    }));
  },
  resetCreativeWorkspaces: () => {
    historyPast = [];
    historyFuture = [];
    historyBatchDepth = 0;
    historyBatchStart = null;
    set(initialState());
  },
}));

interface PendingPersistedWorkspaceState {
  scopeId: string;
  /** When set, flush writes this exact payload. When omitted, serialize lazily on flush. */
  serialized?: string;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistedState: PendingPersistedWorkspaceState | null = null;
let suppressScopedPersistence = false;
const lastPersistedStateByScope = new Map<string, string>();

function cancelPersistTimer() {
  if (persistTimer === null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

const WORKSPACE_PERSIST_FAILURE_NOTICE_THRESHOLD = 3;
let workspacePersistFailureStreak = 0;

function resolvePendingSerialized(pending: PendingPersistedWorkspaceState): string | null {
  if (pending.serialized !== undefined) return pending.serialized;
  // Lazy path: only serialize while the dirty scope is still active so we never
  // persist the wrong project document after a scope switch.
  if (pending.scopeId !== activeWorkspaceScope) return null;
  return serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());
}

function flushPendingPersistedState() {
  if (typeof window === "undefined" || !pendingPersistedState) return;
  const pending = pendingPersistedState;
  const serialized = resolvePendingSerialized(pending);
  if (serialized === null) {
    if (pendingPersistedState === pending) pendingPersistedState = null;
    return;
  }
  if (lastPersistedStateByScope.get(pending.scopeId) === serialized) {
    if (pendingPersistedState === pending) pendingPersistedState = null;
    return;
  }
  try {
    window.localStorage.setItem(storageKeyForScope(pending.scopeId), serialized);
    lastPersistedStateByScope.set(pending.scopeId, serialized);
    if (pendingPersistedState === pending) pendingPersistedState = null;
    if (workspacePersistFailureStreak >= WORKSPACE_PERSIST_FAILURE_NOTICE_THRESHOLD) {
      dismissDirectorNotification("workspace-store-persist-failed");
    }
    workspacePersistFailureStreak = 0;
  } catch {
    // The editor remains usable when private mode or storage quotas block
    // persistence, but repeated failures must reach the user.
    workspacePersistFailureStreak += 1;
    if (workspacePersistFailureStreak >= WORKSPACE_PERSIST_FAILURE_NOTICE_THRESHOLD) {
      notifyDirector({
        key: "workspace-store-persist-failed",
        severity: "warning",
        title: "画布与剪辑工作区未能自动保存到本地",
        detail: "浏览器本地存储连续写入失败（可能是存储空间已满或处于隐私模式）。建议立即导出工程文件备份。",
      });
    }
  }
}

/**
 * Mark the active scope dirty and debounce the localStorage write.
 * Serialization runs only when the timer fires (or on explicit flush), so
 * high-frequency store notifications stay cheap.
 */
function schedulePersistedState(_state: DirectorCreativeWorkspaceState) {
  const alreadyQueuedForScope =
    pendingPersistedState?.scopeId === activeWorkspaceScope && pendingPersistedState.serialized === undefined;
  pendingPersistedState = { scopeId: activeWorkspaceScope };
  if (alreadyQueuedForScope && persistTimer !== null) return;
  cancelPersistTimer();
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPendingPersistedState();
  }, 600);
}

/**
 * Switch the active workspace persistence scope.
 *
 * Flushes any pending writes for the current scope, then loads (or creates)
 * the workspace for the new scope. All scope listeners are notified after the
 * new state is fully restored.
 *
 * @param scopeId - The new scope identifier (normalized to alphanumeric + ._-).
 */
export function setDirectorCreativeWorkspaceScope(scopeId: string) {
  const nextScope = normalizeWorkspaceScope(scopeId);
  if (nextScope === activeWorkspaceScope) return;

  cancelPersistTimer();
  if (typeof window !== "undefined") {
    pendingPersistedState = {
      scopeId: activeWorkspaceScope,
      serialized: serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState()),
    };
    flushPendingPersistedState();
  }
  // Never allow a failed or already-queued write from the old scope to follow the active key.
  pendingPersistedState = null;
  activeWorkspaceScope = nextScope;

  const restored = readPersistedWorkspaceScope(nextScope);
  historyPast = [];
  historyFuture = [];
  historyBatchDepth = 0;
  historyBatchStart = null;
  suppressScopedPersistence = true;
  try {
    useDirectorCreativeWorkspaceStore.setState({
      ...initialState(),
      ...restored,
      selectedBoardNodeId: null,
      selectedClipId: null,
      canUndo: false,
      canRedo: false,
    });
  } finally {
    suppressScopedPersistence = false;
  }
  [...workspaceScopeListeners].forEach((listener) => listener(activeWorkspaceScope));
}

if (typeof window !== "undefined") {
  if (loadedLegacyLocalAtStartup) {
    try {
      const migrated = serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());
      window.localStorage.setItem(storageKeyForScope("local"), migrated);
      lastPersistedStateByScope.set("local", migrated);
    } catch {
      // Migration can be retried by the next ordinary state mutation.
    }
  }
  useDirectorCreativeWorkspaceStore.subscribe((state) => {
    if (!suppressScopedPersistence) schedulePersistedState(state);
  });
  window.addEventListener("pagehide", () => {
    cancelPersistTimer();
    pendingPersistedState = {
      scopeId: activeWorkspaceScope,
      serialized: serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState()),
    };
    flushPendingPersistedState();
  });
}

/**
 * Compute the total timeline duration from a set of tracks.
 *
 * Returns the end time of the latest clip across all tracks, or a minimum of
 * 5 seconds for an empty timeline.
 *
 * @param tracks - The tracks to scan.
 * @returns The timeline duration in seconds, rounded up to the nearest integer.
 */
export function getDirectorEditDuration(tracks: DirectorEditTrack[]) {
  // Match Flick's useful empty-timeline window while still expanding to the
  // final clip edge as soon as content is present.
  let duration = 5;
  tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      duration = Math.max(duration, clip.startSec + clip.durationSec);
    });
  });
  return Math.ceil(duration);
}

/**
 * Find a clip and its owning track by clip id.
 *
 * @param tracks - The tracks to search.
 * @param clipId - The clip id to find, or null.
 * @returns A { track, clip } pair, or null if not found or clipId is null.
 */
export function findDirectorEditClip(
  tracks: DirectorEditTrack[],
  clipId: string | null,
): { track: DirectorEditTrack; clip: DirectorEditClip } | null {
  if (!clipId) return null;
  for (const track of tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** Custom dataTransfer type for in-app Gallery-to-Timeline drag operations. */
export const DIRECTOR_MEDIA_DRAG_TYPE = "application/x-director-media-id";

// Browsers keep DataTransfer.getData() empty until drop ("protected mode"),
// so in-app drags also register the dragged media id here. Consumers read it
// during dragover to validate targets, then fall back to getData() on drop.
let activeMediaDragSessionId: string | null = null;

/**
 * Register a media id as the payload of the current in-app drag session.
 *
 * Browsers keep DataTransfer.getData() empty until drop, so this side-channel
 * lets dragover handlers validate targets before the drop event fires.
 *
 * @param mediaId - The media id being dragged.
 */
export function beginDirectorMediaDragSession(mediaId: string) {
  activeMediaDragSessionId = mediaId;
}

/** Clear the active in-app media drag session. */
export function endDirectorMediaDragSession() {
  activeMediaDragSessionId = null;
}

/** Return the media id of the active in-app drag session, or null. */
export function getDirectorMediaDragSessionId() {
  return activeMediaDragSessionId;
}
