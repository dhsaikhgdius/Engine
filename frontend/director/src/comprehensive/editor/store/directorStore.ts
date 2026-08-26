import { create } from "zustand";
import { Color, Euler, Matrix4, Quaternion, SRGBColorSpace, Vector3 } from "three";
import { dismissDirectorNotification, notifyDirector } from "../../app/notifications/directorNotificationStore";
import { clamp, replaceTupleAxis } from "../../../../../../packages/protocol/src/primitives";
import type { BlenderLiveSceneSnapshot } from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { MANNEQUIN_POSE_PRESETS } from "../presets/mannequinPosePresets";
import { GEOMETRY_PRIMITIVE_OPTIONS } from "../schema/directorProject";
import {
  directorAssetRefSchema,
  repairDirectorProjectReferences,
  safeParseDirectorProject,
  safeParseDirectorProjectStructural,
} from "../schema/directorProjectSchema";
import type { DirectorUiState, TransformMode } from "@director/protocol/workbench-ui";
import {
  createDefaultDirectorProduction,
  getDirectorProductionIssues,
  migrateDirectorProduction,
  reconcileDirectorProduction,
} from "../schema/directorProduction";
import { persistProductionGraphIdentities } from "../productionGraph/productionGraphMigration";
import type {
  DirectorAssetRef,
  DirectorAssetSource,
  DirectorCameraAction,
  CharacterBodyType,
  DirectorAssetKind,
  DirectorCameraCapture,
  DirectorCameraShot,
  DirectorCharacterIkEffector,
  DirectorCharacterIkTarget,
  DirectorCharacterMotionState,
  DirectorEntityAnimation,
  DirectorLight,
  DirectorLightType,
  DirectorMaterialTextureSlot,
  DirectorNativeScene,
  DirectorObject,
  DirectorObjectLayer,
  DirectorPbrMaterial,
  DirectorProject,
  DirectorReferenceBinding,
  DirectorSceneAnchor,
  DirectorSceneAnnotation,
  DirectorSceneMeasurement,
  DirectorStoryboard,
  DirectorTimeline,
  DirectorTimelineAudioClip,
  DirectorTimelineAudioTrack,
  DirectorTransform,
  DirectorVehicleProfile,
  DirectorWorld,
  DirectorWorldRoad,
  DirectorWorldEffect,
  DirectorWorldTimeOfDay,
  DirectorWorldWaterBody,
  DirectorWorldWeather,
  DirectorWorldWildlifeGroup,
  DirectorWorldWind,
  GeometryPrimitiveType,
  MixamoCharacterMetadata,
  PanoramaProjectionMode,
  SceneSettings,
  ViewMode,
} from "../schema/directorProject";
import {
  createDefaultDirectorWorld,
  DIRECTOR_WORLD_MAX_EFFECTS,
  DIRECTOR_WORLD_MAX_ROADS,
  DIRECTOR_WORLD_MAX_WATER_BODIES,
  DIRECTOR_WORLD_MAX_WILDLIFE_GROUPS,
} from "../../../../../../packages/protocol/src/worldSystemsProtocol";

/** A partial patch for updating world system settings (wind, time, weather, etc.). */
export interface DirectorWorldSettingsPatch {
  enabled?: boolean;
  seed?: number;
  wind?: Partial<DirectorWorldWind>;
  timeOfDay?: Partial<DirectorWorldTimeOfDay>;
  weather?: Partial<DirectorWorldWeather>;
}
import { createDefaultDirectorLights, createDirectorLight } from "@director/project-schema";
import { mergeDirectorPbrMaterial } from "../schema/directorMaterial";
import { clampCharacterPoseControlValue, isCharacterPoseControlKey, type PosePresetId } from "../schema/poseSchema";
import { getDirectorObjectFocusTarget } from "../schema/cameraTarget";
import { FLICK_HUMAN_DEFAULT_COLOR } from "../schema/flickHumanAppearance";
import { DIRECTOR_PREVIZ_PALETTE } from "@director/project-schema";
import { DEFAULT_CHARACTER_BODY_TYPE, normalizeBodyType } from "../runtime/mannequin/bodyTypes";
import { DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE } from "../runtime/importedModelGeometry";
import { applyBlenderRuntimeOperations } from "../runtime/blenderRuntimeTransactions";
import {
  DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
  DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_ACTION,
  DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
  DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
  DEFAULT_DIRECTOR_CAMERA_ISO,
  DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
  DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
  getFocalLengthFromVerticalFov,
  getCameraRigPositionFromViewSnapshot,
  getVerticalFovFromFocalLength,
  normalizeDirectorCameraAction,
  normalizeDirectorCameraOptics,
} from "../schema/cameraGeometry";
import type { ViewportAspectRatio } from "@director/protocol/workbench-ui";
import {
  createMixamoCharacterAssetRef,
  getDefaultMixamoCharacterAssetRef,
  getDirectorCharacterAssetBindingIssues,
  getMixamoCharacterCatalogItem,
  getMixamoCharacterCatalogItemByUrl,
  repairDirectorCharacterAssetBindings,
} from "../modelLibrary/mixamoCharacterCatalog";
import { backfillDirectorAssetMetricScale } from "./directorScaleMigration";
import { serializeProject } from "../io/exportProjectJson";
import { normalizeDirectorViewportLayout, type DirectorViewportLayout } from "@director/protocol/workbench-ui";
import { isDirectorObjectEffectivelyLocked } from "../schema/objectLayers";
import { createDefaultDirectorFrameTimeline } from "../timeline/frameTime";
import {
  DEFAULT_CAMERA_PILOT_BANK_STRENGTH,
  DEFAULT_CAMERA_PILOT_INERTIA,
  DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING,
  DEFAULT_VIEWPORT_MOVE_SPEED,
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  normalizeCameraPilotFeel,
  normalizeViewportMoveSpeed,
  normalizeViewportSensitivity,
  normalizeViewportCharacterMoveSpeed,
  DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
} from "../schema/viewportNavigation";

import { createDefaultDirectorProject as createCanonicalDefaultDirectorProject } from "@director/agent-engine/default-project";
import { isDirectorCharacterMotionId } from "@director/agent-engine/character-motions";
import {
  DIRECTOR_DUPLICATE_POSITION_OFFSET_M,
  getDirectorDuplicateObjectId,
  type DirectorAuthoringAction,
} from "@director/agent-engine/authoring";
import {
  compileDirectorDeleteObjectActions,
  dispatchDirectorAuthoringActions,
} from "../../../agent/dispatchDirectorAuthoringActions";
import {
  compileDirectorPasteClipboardActions,
  compileDirectorSceneUpdateAction,
  compileDirectorWorldSettingsAction,
} from "../../../agent/compileDirectorUiAuthoringActions";

/** Input shape for importing an asset into the Director catalog. */
export interface ImportedAssetInput {
  /** Canonical catalog id. Local user imports omit this and receive asset_N. */
  id?: string;
  /** The kind of asset (character, prop, panorama, audio, etc.). */
  kind: DirectorAssetKind;
  /** Human-readable display name. */
  name: string;
  /** Original file name, preserved for provenance. */
  fileName: string;
  /** URL to the asset resource. */
  url: string;
  /** Source type (model, image, audio, etc.). */
  sourceType?: DirectorAssetRef["sourceType"];
  /** Whether to also add a scene object from this asset. */
  addToScene?: boolean;
  /** Where the asset was sourced from. */
  assetSource?: DirectorAssetSource;
  /** Projection mode for panorama assets. */
  projectionMode?: PanoramaProjectionMode;
  /** Character metadata for Mixamo characters. */
  characterMetadata?: MixamoCharacterMetadata;
  /** Optional thumbnail URL. */
  thumbnailUrl?: DirectorAssetRef["thumbnailUrl"];
  /** Model normalization policy. */
  modelNormalization?: DirectorAssetRef["modelNormalization"];
  /** Real-world size in meters for metric normalization. */
  realWorldSizeM?: DirectorAssetRef["realWorldSizeM"];
  /** Where the real-world size value came from. */
  sizeSource?: DirectorAssetRef["sizeSource"];
  /** Generation provenance for AI-generated assets. */
  generation?: DirectorAssetRef["generation"];
  /** 4D Gaussian splatting sequence metadata. */
  splatSequence?: DirectorAssetRef["splatSequence"];
}

/** Input shape for adding an audio clip to the stage timeline. */
export interface TimelineAudioClipInput {
  /** Durable creative media id. */
  mediaId: string;
  /** Human-readable clip name. */
  name: string;
  /** Direct source URL fallback. */
  sourceUrl?: string;
  /** Defaults to the current playhead frame. */
  startFrame?: number;
  /** Clip duration in frames. */
  durationFrames: number;
  /** Cached source duration for offline trimming. */
  sourceDurationSec?: number;
}

/** Snapshot of a camera's field of view, position, and target. */
export interface CameraShotSnapshot {
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

/** Parameters for creating a crowd of characters. */
export interface CrowdCharactersInput {
  /** Body type for all characters in the crowd. */
  bodyType?: CharacterBodyType;
  /** Number of rows in the grid. */
  rows: number;
  /** Number of columns in the grid. */
  columns: number;
  /** Spacing between characters in meters. */
  spacing: number;
}

/** A transform update for a single object. */
export interface DirectorObjectTransformUpdate {
  id: string;
  transform: DirectorTransform;
}

/** Options for constructing the initial Director state. */
export interface DirectorStateOptions {
  /** Whether to include locally persisted assets. */
  includePersistedLocalAssets?: boolean;
  /** Whether to include the locally persisted scene. */
  includePersistedScene?: boolean;
  /** Scoped persistence id for multi-instance isolation. */
  persistenceScopeId?: string | null;
}

/** The full persisted Director state: project data plus UI state. */
export interface DirectorState extends DirectorUiState {
  project: DirectorProject;
}

/** A clipboard entry containing a copied object and optionally its camera. */
export interface DirectorClipboardEntry {
  object: DirectorObject;
  camera?: DirectorCameraShot;
}

/**
 * Live health of browser localStorage persistence for the Stage scene.
 * Failed writes (quota exceeded, private mode) flip `status` to "failed" so
 * the UI can distinguish a safely saved project from a tab-only project at
 * risk of loss; the next successful write flips it back to "ok".
 */
export interface DirectorPersistenceHealth {
  status: "ok" | "failed";
  /** Number of consecutive failed writes; reset to 0 by a successful write. */
  consecutiveFailures: number;
  /** Epoch ms of the most recent failed write, or null when none failed yet. */
  lastFailureAt: number | null;
  /** Error message from the most recent failed write, or null. */
  lastError: string | null;
}

interface DirectorInternalState {
  clipboard: DirectorClipboardEntry[];
  clipboardPasteCount: number;
  undoStack: DirectorState[];
  redoStack: DirectorState[];
  historyUndoStack: DirectorHistoryEntry[];
  historyRedoStack: DirectorHistoryEntry[];
  historyBusy: boolean;
  pendingBlenderSyncs: PendingBlenderSync[];
  undoBatchDepth: number;
  undoBatchSnapshot: DirectorState | null;
  undoBatchHasTrackedChanges: boolean;
  persistenceHealth: DirectorPersistenceHealth;
}

type DirectorHistoryEntry =
  { domain: "director"; state: DirectorState } | { domain: "blender"; projectId: string; sceneEpoch: string };

type PendingBlenderSync = {
  sceneEpoch: string;
  revision: number;
  origin: "director-projection" | "history-replay";
};

/** The complete set of mutating actions available on the Director store. */
export interface DirectorActions {
  setViewMode: (mode: ViewMode) => void;
  setTransformMode: (mode: TransformMode) => void;
  setViewportAspectRatio: (ratio: ViewportAspectRatio) => void;
  setViewportLayout: (layout: DirectorViewportLayout) => void;
  toggleViewportLayout: () => void;
  setViewportRuleOfThirdsEnabled: (enabled: boolean) => void;
  toggleViewportPanelsCollapsed: () => void;
  setViewportPanelsCollapsed: (collapsed: boolean) => void;
  setViewportRotateSensitivity: (sensitivity: number) => void;
  setViewportZoomSensitivity: (sensitivity: number) => void;
  setViewportMoveSpeed: (speed: number) => void;
  setViewportCharacterMoveSpeed: (speed: number) => void;
  setViewportPilotInertia: (amount: number) => void;
  setViewportPilotLookSmoothing: (amount: number) => void;
  setViewportPilotBankStrength: (amount: number) => void;
  resetViewportNavigation: () => void;
  ensureNativeSceneBinding: () => string;
  prepareBlenderSync: (sync: PendingBlenderSync) => void;
  syncBlenderScene: (snapshot: BlenderLiveSceneSnapshot) => void;
  selectObject: (id: string | null) => void;
  selectObjects: (ids: string[]) => void;
  selectCrowd: (crowdId: string | null) => void;
  toggleObjectSelection: (id: string) => void;
  openSceneInspector: () => void;
  updateScene: (patch: Partial<SceneSettings>) => void;
  updateWorldSettings: (patch: DirectorWorldSettingsPatch) => void;
  /** Returns false when a new entry would exceed the protocol collection limit. */
  upsertWorldEffect: (effect: DirectorWorldEffect) => boolean;
  removeWorldEffects: (effectIds: string[]) => number;
  upsertWorldWaterBody: (body: DirectorWorldWaterBody) => boolean;
  removeWorldWaterBodies: (bodyIds: string[]) => number;
  upsertWorldWildlifeGroup: (group: DirectorWorldWildlifeGroup) => boolean;
  removeWorldWildlifeGroups: (groupIds: string[]) => number;
  upsertWorldRoad: (road: DirectorWorldRoad) => boolean;
  removeWorldRoads: (roadIds: string[]) => number;
  updateStoryboard: (storyboard: DirectorStoryboard) => void;
  removePanoramaAsset: () => void;
  removeImportedAsset: (assetId: string) => void;
  updateObjectTransform: (id: string, patch: Partial<DirectorTransform>) => void;
  updateObjectTransforms: (updates: DirectorObjectTransformUpdate[]) => void;
  batchUpdateObjects: (ids: string[], patch: DirectorObjectBatchPatch) => number;
  resetObjectTransforms: (ids: string[], components?: Array<"position" | "rotation" | "scale">) => number;
  alignObjects: (ids: string[], axis: DirectorObjectEditAxis, mode: DirectorObjectAlignMode) => number;
  distributeObjects: (ids: string[], axis: DirectorObjectEditAxis) => number;
  isolateObjects: (ids: string[]) => number;
  showAllObjects: () => number;
  setObjectPivot: (id: string, pivot: [number, number, number] | null) => boolean;
  toggleObjectInteraction: (id: string) => boolean;
  addSceneAnnotation: (input: { text: string; anchor: DirectorSceneAnchor; color?: string }) => string | null;
  updateSceneAnnotation: (id: string, patch: Partial<Omit<DirectorSceneAnnotation, "id" | "createdAt">>) => boolean;
  removeSceneAnnotation: (id: string) => boolean;
  addSceneMeasurement: (input: {
    start: DirectorSceneAnchor;
    end: DirectorSceneAnchor;
    label?: string;
    color?: string;
  }) => string | null;
  updateSceneMeasurement: (id: string, patch: Partial<Omit<DirectorSceneMeasurement, "id" | "createdAt">>) => boolean;
  removeSceneMeasurement: (id: string) => boolean;
  setObjectLayerState: (id: string, patch: Partial<Pick<DirectorObjectLayer, "visible" | "locked">>) => boolean;
  moveObjectLayer: (id: string, direction: "up" | "down") => boolean;
  dropObjectToGround: (id: string) => void;
  setObjectAnimation: (id: string, animation: DirectorEntityAnimation | undefined) => void;
  updateCrowdTransform: (crowdId: string, patch: Partial<DirectorTransform>) => void;
  dropCrowdToGround: (crowdId: string) => void;
  updateObjectName: (id: string, name: string) => void;
  updateObjectReferenceBindings: (id: string, bindings: DirectorReferenceBinding[]) => void;
  updateCrowdLabel: (crowdId: string, label: string) => void;
  /** Creates an editable transform parent without conflating it with object lists or asset bindings. */
  createCompositeObject: (ids: string[], label?: string) => string | null;
  addObjectsToComposite: (ids: string[], parentObjectId: string) => void;
  removeObjectsFromComposite: (ids: string[]) => void;
  createObjectList: (ids: string[], label: string) => string | null;
  addObjectsToObjectList: (ids: string[], objectListId: string) => void;
  removeObjectsFromObjectList: (ids: string[]) => void;
  updateObjectListLabel: (objectListId: string, label: string) => void;
  updateObjectColor: (id: string, color: string) => void;
  updateObjectMaterial: (id: string, patch: Partial<DirectorPbrMaterial> | null) => void;
  /** Attaches, replaces, or removes (null) the drivable-vehicle capability of an object. */
  setObjectVehicleProfile: (id: string, profile: DirectorVehicleProfile | null) => void;
  updateObjectMaterialTexture: (id: string, slot: DirectorMaterialTextureSlot, assetId: string | null) => void;
  updateCrowdColor: (crowdId: string, color: string) => void;
  addLight: (type: DirectorLightType) => string;
  updateLight: (id: string, patch: Partial<Omit<DirectorLight, "id">>) => void;
  removeLight: (id: string) => void;
  updateCharacterBodyType: (id: string, bodyType: CharacterBodyType) => void;
  updateUniformScale: (id: string, scale: number) => void;
  updateCrowdUniformScale: (crowdId: string, scale: number) => void;
  /** Adds an asset to the Director catalog and returns its stable asset ID. */
  addImportedAsset: (input: ImportedAssetInput) => string;
  /** Sets or clears a model asset's real-world size in meters (metric normalization). */
  setAssetRealWorldSize: (assetId: string, sizeM: number | null, source?: "catalog" | "user" | "estimated") => void;
  /** Records renderer- or Blender-measured local geometry bounds without creating a user undo step. */
  setObjectMeasuredLocalBounds: (objectId: string, bounds: DirectorObject["localBoundsM"]) => void;
  addObjectFromAsset: (assetId: string) => string | null;
  addPresetCharacter: (bodyType?: CharacterBodyType, color?: string) => void;
  addCrowdCharacters: (input: CrowdCharactersInput) => string[];
  addGeometryPrimitive: (geometryType: GeometryPrimitiveType) => void;
  addCameraShot: (snapshot?: CameraShotSnapshot) => string;
  deleteSelectedObject: () => void;
  deleteObjects: (ids: string[]) => void;
  toggleObjectVisible: (id: string) => void;
  toggleObjectLocked: (id: string) => void;
  applyPosePreset: (id: string, presetId: PosePresetId) => void;
  applyCrowdPosePreset: (crowdId: string, presetId: PosePresetId) => void;
  updatePoseControl: (id: string, key: string, value: number) => void;
  updateCrowdPoseControl: (crowdId: string, key: string, value: number) => void;
  setCharacterMotion: (id: string, motion: DirectorCharacterMotionState | undefined) => void;
  setCrowdCharacterMotion: (crowdId: string, motion: DirectorCharacterMotionState | undefined) => void;
  setCharacterIkEffector: (
    id: string,
    effector: DirectorCharacterIkEffector,
    target: DirectorCharacterIkTarget,
  ) => void;
  setCrowdCharacterIkEffector: (
    crowdId: string,
    effector: DirectorCharacterIkEffector,
    target: DirectorCharacterIkTarget,
  ) => void;
  clearCharacterIkEffector: (id: string, effector: DirectorCharacterIkEffector) => void;
  clearCrowdCharacterIkEffector: (crowdId: string, effector: DirectorCharacterIkEffector) => void;
  setActiveCamera: (cameraId: string) => void;
  addCameraCaptures: (cameraId: string | null | undefined, dataUrls: string[]) => void;
  updateCamera: (
    cameraId: string,
    patch: Partial<DirectorCameraShot> & {
      transform?: DirectorTransform;
      target?: [number, number, number];
    },
  ) => void;
  setCameraAnimation: (cameraId: string, animation: DirectorEntityAnimation | undefined) => void;
  /** Returns the new clip id, or null when the audio track/clip limits are hit. */
  addTimelineAudioClip: (input: TimelineAudioClipInput) => string | null;
  updateTimelineAudioClip: (
    clipId: string,
    patch: Partial<Omit<DirectorTimelineAudioClip, "id" | "mediaId">>,
  ) => boolean;
  moveTimelineAudioClip: (clipId: string, startFrame: number) => boolean;
  removeTimelineAudioClip: (clipId: string) => boolean;
  setTimelineAudioTrackMuted: (trackId: string, muted: boolean) => boolean;
  beginUndoBatch: () => void;
  endUndoBatch: () => void;
  copySelectedObjects: () => void;
  pasteClipboardObjects: () => void;
  undo: () => void;
  redo: () => void;
  openScopedScene: (scopeId: string | null | undefined) => void;
  replaceProject: (project: DirectorProject) => void;
  applyAuthoredProject: (project: DirectorProject) => void;
  saveLatestSnapshot: () => void;
  restoreLatestSnapshot: () => void;
}

/** Axis for object editing operations. */
export type DirectorObjectEditAxis = "x" | "y" | "z";
/** Alignment mode for distributing objects. */
export type DirectorObjectAlignMode = "min" | "center" | "max";
/** A batch patch applied to multiple objects at once. */
export interface DirectorObjectBatchPatch {
  visible?: boolean;
  locked?: boolean;
  layer?: string | null;
  transform?: Partial<DirectorTransform>;
  color?: string;
  material?: Partial<DirectorPbrMaterial> | null;
}

type DirectorRuntimeState = DirectorState & DirectorInternalState;

/** The complete Director store type: runtime state plus all actions. */
export type DirectorStore = DirectorRuntimeState & DirectorActions;

const DEFAULT_SCENE: SceneSettings = {
  scale: 1,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  backgroundColor: DIRECTOR_PREVIZ_PALETTE.sky,
  panoramaYaw: 0,
  panoramaRadius: 60,
  showLabels: false,
  snapToGrid: false,
  showGround: true,
  groundOpacity: 0,
  groundHeight: 0,
  fog: {
    enabled: false,
    mode: "linear",
    color: DIRECTOR_PREVIZ_PALETTE.sky,
    near: 10,
    far: 80,
    density: 0.02,
  },
  environment: {
    enabled: false,
    usePanorama: true,
    intensity: 0.5,
    rotation: [0, 0, 0],
  },
  objectLayers: [{ id: "default", visible: true, locked: false }],
  annotations: [],
  measurements: [],
  timeline: createDefaultDirectorFrameTimeline(),
};

const CHARACTER_COLOR_PALETTE = [
  "#4F8EF7",
  "#E0524D",
  "#E91E63",
  "#F2A900",
  "#9C4DCC",
  "#12B886",
  "#00B8D9",
  "#FF7A45",
];
const LEGACY_AUTOMATIC_CHARACTER_BLUE = "#4f8ef7";
const GEOMETRY_PRIMITIVE_COLOR = "#d7e7ff";
const ADDED_MODEL_WORLD_SPACING = 1.25;
// Shared with the Agent authoring engine so UI paste and duplicate_objects
// land the same duplicate positions.
const COPY_PASTE_POSITION_OFFSET = DIRECTOR_DUPLICATE_POSITION_OFFSET_M;
const UNDO_STACK_LIMIT = 80;
const LOCAL_MODEL_LIBRARY_STORAGE_KEY = "storyai-3d-director-local-model-library";
const DIRECTOR_SCENE_STORAGE_KEY = "storyai-3d-director-desk-demo";
const DIRECTOR_SCENE_STORAGE_KEY_PREFIX = `${DIRECTOR_SCENE_STORAGE_KEY}:`;
const DEFAULT_UI_STATE: DirectorUiState = {
  viewMode: "director",
  selectedObjectId: null,
  selectedObjectIds: [],
  selectedCrowdId: null,
  directorInspectorMode: "auto",
  transformMode: "translate",
  viewportAspectRatio: "auto",
  viewportLayout: "single",
  viewportRuleOfThirdsEnabled: false,
  viewportPanelsCollapsed: false,
  viewportRotateSensitivity: DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  viewportZoomSensitivity: DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  viewportMoveSpeed: DEFAULT_VIEWPORT_MOVE_SPEED,
  viewportCharacterMoveSpeed: DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
  viewportPilotInertia: DEFAULT_CAMERA_PILOT_INERTIA,
  viewportPilotLookSmoothing: DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING,
  viewportPilotBankStrength: DEFAULT_CAMERA_PILOT_BANK_STRENGTH,
};

function normalizeDirectorScenePersistenceScopeId(scopeId: string | null | undefined) {
  return typeof scopeId === "string" ? scopeId.trim() : "";
}

function getInitialDirectorScenePersistenceScopeId() {
  if (typeof window === "undefined") return null;

  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeDirectorScenePersistenceScopeId(params.get("instanceId")) || null;
  } catch {
    return null;
  }
}

let directorScenePersistenceScopeId: string | null = getInitialDirectorScenePersistenceScopeId();
const DIRECTOR_PERSIST_DEBOUNCE_MS = 1_000;

let pendingDirectorPersistence: { state: DirectorState; storageKey: string } | null = null;
let directorPersistenceTimer: ReturnType<typeof setTimeout> | null = null;

function getDirectorSceneStorageKey(scopeId: string | null | undefined = directorScenePersistenceScopeId) {
  const normalizedScopeId = normalizeDirectorScenePersistenceScopeId(scopeId);
  return normalizedScopeId ? `${DIRECTOR_SCENE_STORAGE_KEY_PREFIX}${normalizedScopeId}` : DIRECTOR_SCENE_STORAGE_KEY;
}

function setDirectorScenePersistenceScopeId(scopeId: string | null | undefined) {
  const normalizedScopeId = normalizeDirectorScenePersistenceScopeId(scopeId);
  directorScenePersistenceScopeId = normalizedScopeId || null;
}

function createTransform(
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): DirectorTransform {
  return { position, rotation, scale };
}

function roundTransformValue(value: number) {
  return Number(value.toFixed(6));
}

function roundTransformTuple(values: [number, number, number]): [number, number, number] {
  return values.map((value) => roundTransformValue(value)) as [number, number, number];
}

function formatSceneItemName(prefix: "角色" | "机位", index: number) {
  return `${prefix}${String(index).padStart(2, "0")}`;
}

function getNextSequentialId(existingIds: string[], prefix: string, minimumIndex = 1) {
  let maxIndex = minimumIndex - 1;

  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;

    const suffix = id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;

    maxIndex = Math.max(maxIndex, Number.parseInt(suffix, 10));
  }

  return `${prefix}${maxIndex + 1}`;
}

function isLocalModelLibraryAsset(asset: DirectorAssetRef) {
  return (
    asset.sourceType === "model" &&
    asset.kind !== "panorama" &&
    (asset.assetSource === "local" || asset.assetSource === "generated")
  );
}

function getLocalStorageSafe() {
  if (typeof localStorage === "undefined") return null;

  return localStorage;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Restore structural sharing after a whole-document rebuild (structuredClone
 * or JSON round trip): every subtree that is deep-equal to the previous
 * document keeps the previous reference. Store subscribers selecting an
 * untouched branch (assets, cameras, production, ...) then see an identical
 * reference and skip re-rendering when an authored edit changed something else.
 */
function reuseUnchangedJsonReferences<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let reusedAll = previous.length === next.length;
    const merged = next.map((item, index) => {
      const reused = reuseUnchangedJsonReferences(previous[index], item);
      if (!Object.is(reused, previous[index])) reusedAll = false;
      return reused;
    });
    return (reusedAll ? previous : merged) as T;
  }
  if (isPlainJsonObject(previous) && isPlainJsonObject(next)) {
    const nextKeys = Object.keys(next);
    let reusedAll = Object.keys(previous).length === nextKeys.length;
    const merged: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const reused = reuseUnchangedJsonReferences(previous[key], next[key]);
      merged[key] = reused;
      if (!Object.is(reused, previous[key])) reusedAll = false;
    }
    return (reusedAll ? previous : merged) as T;
  }
  return next;
}

function readPersistedLocalModelAssets() {
  const storage = getLocalStorageSafe();
  if (!storage) return [];

  try {
    const snapshot = storage.getItem(LOCAL_MODEL_LIBRARY_STORAGE_KEY);
    if (!snapshot) return [];

    const parsed = JSON.parse(snapshot);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((asset) => {
      const result = directorAssetRefSchema.safeParse(asset);
      return result.success && isLocalModelLibraryAsset(result.data as DirectorAssetRef)
        ? [result.data as DirectorAssetRef]
        : [];
    });
  } catch {
    return [];
  }
}

function writePersistedLocalModelAssets(assets: DirectorAssetRef[]) {
  const storage = getLocalStorageSafe();
  if (!storage) return;

  try {
    storage.setItem(LOCAL_MODEL_LIBRARY_STORAGE_KEY, JSON.stringify(assets.filter(isLocalModelLibraryAsset)));
  } catch {
    // Local model files can exceed browser storage limits; keep the current scene usable if persistence fails.
  }
}

function persistLocalModelAsset(asset: DirectorAssetRef) {
  if (!isLocalModelLibraryAsset(asset)) return;

  const persistedAssets = readPersistedLocalModelAssets().filter((item) => item.id !== asset.id);
  writePersistedLocalModelAssets([...persistedAssets, asset]);
}

function removePersistedLocalModelAsset(assetId: string) {
  writePersistedLocalModelAssets(readPersistedLocalModelAssets().filter((asset) => asset.id !== assetId));
}

function withPersistedLocalAssets(project: DirectorProject, includePersistedLocalAssets = false): DirectorProject {
  if (!includePersistedLocalAssets) return project;

  const persistedAssets = readPersistedLocalModelAssets();
  if (!persistedAssets.length) return project;

  const existingAssetIds = new Set(project.assets.map((asset) => asset.id));

  return {
    ...project,
    assets: [...project.assets, ...persistedAssets.filter((asset) => !existingAssetIds.has(asset.id))],
  };
}

/**
 * Early model-library builds created `obj_*` characters and imported the
 * matching library asset, but did not persist the object's asset reference.
 * Recover only unambiguous, exact-name matches that resolve to one model URL.
 * Preset/user-named characters use different IDs and are intentionally left
 * untouched.
 */
function inferLegacyLibraryCharacterAssetId(project: DirectorProject, object: DirectorObject) {
  if (object.kind !== "character" || object.assetRefId || !object.id.startsWith("obj_")) return null;

  const normalizedName = object.name.trim().toLocaleLowerCase();
  if (!normalizedName) return null;

  const matches = project.assets.filter(
    (asset) =>
      asset.kind === "character" &&
      asset.sourceType === "model" &&
      asset.assetSource === "library" &&
      asset.name?.trim().toLocaleLowerCase() === normalizedName,
  );
  if (!matches.length || new Set(matches.map((asset) => asset.url)).size !== 1) return null;

  return matches[0]!.id;
}

function canonicalizePackagedCharacterAssets(project: DirectorProject): DirectorProject {
  const remappedIds = new Map<string, string>();
  const normalizedAssets = project.assets.map((asset) => {
    if (asset.kind !== "character" || asset.sourceType !== "model") return asset;
    // The packaged catalog is authoritative: anything recognizable by id or
    // url is force-rewritten to its canonical identity (id wins on conflict),
    // so catalog evolution never locks an old project out.
    const item = getMixamoCharacterCatalogItem(asset.id) ?? getMixamoCharacterCatalogItemByUrl(asset.url);
    if (!item) return asset;
    const canonical = createMixamoCharacterAssetRef(item);
    remappedIds.set(asset.id, canonical.id);
    return canonical;
  });
  const assetsById = new Map<string, DirectorAssetRef>();
  normalizedAssets.forEach((asset) => {
    const existing = assetsById.get(asset.id);
    if (!existing || asset.assetSource === "library") assetsById.set(asset.id, asset);
  });
  return {
    ...project,
    assets: [...assetsById.values()],
    objects: project.objects.map((object) => {
      const remapped = object.assetRefId ? remappedIds.get(object.assetRefId) : undefined;
      return remapped ? { ...object, assetRefId: remapped, characterSource: "asset" as const } : object;
    }),
  };
}

export function migrateDirectorProject(project: DirectorProject): DirectorProject {
  project = canonicalizePackagedCharacterAssets(project);
  project = backfillDirectorAssetMetricScale(project);
  const defaultCharacterAsset = getDefaultMixamoCharacterAssetRef();
  let needsDefaultCharacterAsset = false;
  const migratedProject: DirectorProject = {
    ...project,
    scene: {
      ...project.scene,
      fog: project.scene.fog ?? DEFAULT_SCENE.fog,
      environment: project.scene.environment ?? DEFAULT_SCENE.environment,
    },
    lights: project.lights ?? createDefaultDirectorLights(),
    cameras: project.cameras.map((camera) => {
      const aspectRatio = camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
      const sensorFormat = camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
      const focalLengthMm = Number.isFinite(camera.focalLengthMm)
        ? camera.focalLengthMm!
        : getFocalLengthFromVerticalFov(camera.fov, aspectRatio, sensorFormat);
      const handheldShake = camera.handheldShake ?? DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE;
      // Existing animated scenes predate the explicit action selector. Keep
      // their authored keyframes live by treating them as Transform actions.
      const action = normalizeDirectorCameraAction(
        camera.action ?? (camera.animation?.keyframes.length ? { mode: "transform" } : undefined),
      );
      const optics = normalizeDirectorCameraOptics(camera);

      return {
        ...camera,
        aspectRatio,
        sensorFormat,
        focalLengthMm,
        handheldShake,
        action,
        ...optics,
      };
    }),
    objects: project.objects.map((object) => {
      if (object.kind !== "character") return object;

      const rig = object.characterRig;
      const inferredAssetRefId = inferLegacyLibraryCharacterAssetId(project, object);
      const assetRefId = object.assetRefId ?? inferredAssetRefId ?? defaultCharacterAsset.id;
      if (assetRefId === defaultCharacterAsset.id) needsDefaultCharacterAsset = true;
      // Pre-Stage scenes automatically assigned the first role a blue tint.
      // Move that generated default to the warm core-Human colour while leaving
      // every other inspector-selected colour unchanged.
      const color =
        object.color?.toLowerCase() === LEGACY_AUTOMATIC_CHARACTER_BLUE ? FLICK_HUMAN_DEFAULT_COLOR : object.color;
      if (rig?.rigType === "mixamo") {
        return {
          ...object,
          color,
          characterSource: "asset",
          assetRefId,
        };
      }

      return {
        ...object,
        color,
        characterSource: "asset",
        assetRefId,
        characterRig: {
          rigType: "mixamo",
          posePresetId: rig?.posePresetId ?? "stand",
          controls: rig?.controls ?? {},
          ...(rig?.ik ? { ik: rig.ik } : {}),
          ...(rig?.motion ? { motion: rig.motion } : {}),
        },
      };
    }),
  };

  if (needsDefaultCharacterAsset && !migratedProject.assets.some((asset) => asset.id === defaultCharacterAsset.id)) {
    migratedProject.assets = [defaultCharacterAsset, ...migratedProject.assets];
  }

  const modelAssetIds = new Set(
    migratedProject.assets.filter((asset) => asset.sourceType === "model").map((asset) => asset.id),
  );
  migratedProject.objects = migratedProject.objects.map((object) =>
    object.assetRefId && modelAssetIds.has(object.assetRefId) && !object.nativeSource
      ? {
          ...object,
          nativeSource: { engine: "blender", objectId: object.id, provisioned: false },
        }
      : object,
  );

  return persistProductionGraphIdentities(migrateDirectorProduction(migratedProject));
}

function withReconciledProduction(project: DirectorProject): DirectorProject {
  if (!project.production || !getDirectorProductionIssues(project).length) return project;
  return { ...project, production: reconcileDirectorProduction(project) };
}

export type DirectorProjectLoadResult =
  { success: true; project: DirectorProject; repairs: string[] } | { success: false; error: string };

/**
 * Load/import boundary: structural corruption still rejects the document,
 * while dangling references and broken character bindings are auto-repaired
 * so an openable scene is never rejected. Agent write paths keep the strict
 * schema instead of this helper.
 */
export function parseDirectorProjectForLoad(value: unknown): DirectorProjectLoadResult {
  const structural = safeParseDirectorProjectStructural(value);
  if (!structural.success) return { success: false, error: structural.error };

  const migrated = migrateDirectorProject(cloneJsonValue(structural.project));
  const bindingRepair = repairDirectorCharacterAssetBindings(migrated);
  const referenceRepair = repairDirectorProjectReferences(bindingRepair.project);
  const repairs = [...bindingRepair.repairs, ...referenceRepair.repairs];

  const strict = safeParseDirectorProject(referenceRepair.project);
  if (!strict.success) return { success: false, error: strict.error };
  const bindingIssues = getDirectorCharacterAssetBindingIssues(strict.project);
  if (bindingIssues.length) return { success: false, error: `项目人物资产绑定无效：${bindingIssues[0]}` };

  return { success: true, project: strict.project, repairs };
}

export function logDirectorProjectRepairs(source: string, repairs: string[]) {
  repairs.forEach((repair) => console.warn(`${source}：${repair}`));
}

const DIRECTOR_CORRUPT_BACKUP_LIMIT = 3;

function notifyCorruptDirectorSnapshot(reason: string, detail: string) {
  notifyDirector({
    key: "director-project-corrupt-load",
    severity: "error",
    title: "本地工程数据损坏，已改为加载空白工程",
    detail: `${reason}。${detail}建议先导出当前可见的工程内容，并向开发者反馈该问题。`,
  });
}

// A failed load must never destroy the user's only copy: the unreadable
// snapshot is preserved under a timestamped key before the default project
// can overwrite the primary key.
function backupCorruptDirectorSnapshot(storage: Storage, storageKey: string, snapshot: string, reason: string) {
  const backupPrefix = `${storageKey}.corrupt-`;
  try {
    const backupKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(backupPrefix)) backupKeys.push(key);
    }
    const existingKey = backupKeys.find((key) => storage.getItem(key) === snapshot);
    if (existingKey) {
      console.error(`Director 项目数据无法加载：${reason}。原始数据已存在备份 ${existingKey}，不会被默认工程覆盖。`);
      notifyCorruptDirectorSnapshot(reason, `原始数据已备份在浏览器 localStorage 键「${existingKey}」中，未被覆盖。`);
      return;
    }

    let backupKey = `${backupPrefix}${Date.now()}`;
    let suffix = 1;
    while (storage.getItem(backupKey) !== null) {
      backupKey = `${backupPrefix}${Date.now()}-${suffix}`;
      suffix += 1;
    }
    storage.setItem(backupKey, snapshot);
    backupKeys
      .concat(backupKey)
      .sort()
      .slice(0, Math.max(0, backupKeys.length + 1 - DIRECTOR_CORRUPT_BACKUP_LIMIT))
      .forEach((key) => storage.removeItem(key));
    console.error(`Director 项目数据无法加载：${reason}。原始数据已备份到 ${backupKey}，不会被默认工程覆盖。`);
    notifyCorruptDirectorSnapshot(reason, `原始数据已备份到浏览器 localStorage 键「${backupKey}」中，未被覆盖。`);
  } catch {
    console.error(`Director 项目数据无法加载：${reason}。原始数据备份失败。`);
    notifyCorruptDirectorSnapshot(reason, "原始数据备份失败，请勿清除浏览器数据。");
  }
}

/**
 * Selects the persisted subset of the runtime state by reference (structural
 * sharing) instead of a full JSON clone. The store updates immutably across
 * the board, so undo entries and pending persistence snapshots stay valid
 * while sharing every untouched subtree with the live document. Restores go
 * through createRuntimeStateFromPersistedState, which deep-clones at that
 * (rare) boundary, so history entries never alias post-restore runtime state.
 */
function extractPersistedDirectorState(state: DirectorState): DirectorState {
  return {
    viewMode: state.viewMode,
    selectedObjectId: state.selectedObjectId,
    selectedObjectIds: state.selectedObjectIds,
    selectedCrowdId: state.selectedCrowdId,
    directorInspectorMode: state.directorInspectorMode,
    transformMode: state.transformMode,
    viewportAspectRatio: state.viewportAspectRatio,
    viewportLayout: state.viewportLayout,
    viewportRuleOfThirdsEnabled: state.viewportRuleOfThirdsEnabled,
    viewportPanelsCollapsed: state.viewportPanelsCollapsed,
    viewportRotateSensitivity: state.viewportRotateSensitivity,
    viewportZoomSensitivity: state.viewportZoomSensitivity,
    viewportMoveSpeed: state.viewportMoveSpeed,
    viewportCharacterMoveSpeed: state.viewportCharacterMoveSpeed,
    viewportPilotInertia: state.viewportPilotInertia,
    viewportPilotLookSmoothing: state.viewportPilotLookSmoothing,
    viewportPilotBankStrength: state.viewportPilotBankStrength,
    project: state.project,
  };
}

const DIRECTOR_PERSIST_FAILURE_NOTIFICATION_KEY = "director-store-persist-failed";

export function createInitialDirectorPersistenceHealth(): DirectorPersistenceHealth {
  return { status: "ok", consecutiveFailures: 0, lastFailureAt: null, lastError: null };
}

/**
 * Downloads the current in-memory project as a JSON backup file. Used as the
 * recovery action when browser persistence fails: the tab still holds the
 * authoritative document even when localStorage rejects writes.
 */
export function exportDirectorProjectBackup() {
  if (typeof document === "undefined") return;
  const blob = new Blob([serializeProject(useDirectorStore.getState().project)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `director-project-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function recordDirectorPersistenceFailure(error: unknown) {
  const current = useDirectorStore.getState().persistenceHealth;
  useDirectorStore.setState({
    persistenceHealth: {
      status: "failed",
      consecutiveFailures: current.consecutiveFailures + 1,
      lastFailureAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
    },
  });
  // Losing local autosave puts every later edit at risk, so warn on the first
  // failed write instead of waiting for a streak; a transient blip is
  // self-clearing because the next successful write dismisses the notice.
  notifyDirector({
    key: DIRECTOR_PERSIST_FAILURE_NOTIFICATION_KEY,
    severity: "warning",
    title: "3D 片场工程未能自动保存到本地",
    detail:
      "浏览器本地存储写入失败（可能是存储空间已满或处于隐私模式）。当前修改仅保留在本页面中，请立即导出工程文件备份。",
    actions: [{ label: "导出工程", onSelect: exportDirectorProjectBackup }],
  });
}

function recordDirectorPersistenceSuccess() {
  if (useDirectorStore.getState().persistenceHealth.status === "ok") return;
  useDirectorStore.setState({ persistenceHealth: createInitialDirectorPersistenceHealth() });
  dismissDirectorNotification(DIRECTOR_PERSIST_FAILURE_NOTIFICATION_KEY);
}

function writePersistedDirectorState(state: DirectorState, storageKey = getDirectorSceneStorageKey()) {
  const storage = getLocalStorageSafe();
  if (!storage) return;

  try {
    storage.setItem(storageKey, JSON.stringify(state));
    recordDirectorPersistenceSuccess();
  } catch (error) {
    // Keep the editor usable when the browser storage quota is exceeded, but
    // record the failure in store state and surface an actionable warning.
    recordDirectorPersistenceFailure(error);
  }
}

function flushScheduledDirectorPersistence() {
  if (directorPersistenceTimer !== null) {
    clearTimeout(directorPersistenceTimer);
    directorPersistenceTimer = null;
  }
  const pending = pendingDirectorPersistence;
  pendingDirectorPersistence = null;
  if (pending) writePersistedDirectorState(extractPersistedDirectorState(pending.state), pending.storageKey);
}

function cancelScheduledDirectorPersistence() {
  if (directorPersistenceTimer !== null) clearTimeout(directorPersistenceTimer);
  directorPersistenceTimer = null;
  pendingDirectorPersistence = null;
}

function isDirectorUndoBatchActive() {
  // The persistence helpers live at module scope and fire from timers, so
  // read the live store instead of mirroring the batch depth in a second
  // module variable that could drift when the store state is replaced.
  return useDirectorStore.getState().undoBatchDepth > 0;
}

function runScheduledDirectorPersistence() {
  directorPersistenceTimer = null;
  // TransformControls drags and inspector sliders wrap their mutation stream
  // in an undo batch. Stringifying a multi-megabyte project once per debounce
  // window mid-drag causes visible hitches, so keep the pending snapshot and
  // let endUndoBatch reschedule the flush. pagehide still force-writes through
  // flushScheduledDirectorPersistence, which ignores the batch on purpose.
  if (isDirectorUndoBatchActive()) return;
  const pending = pendingDirectorPersistence;
  pendingDirectorPersistence = null;
  if (pending) writePersistedDirectorState(extractPersistedDirectorState(pending.state), pending.storageKey);
}

function schedulePersistedDirectorState(state: DirectorState) {
  pendingDirectorPersistence = {
    state,
    storageKey: getDirectorSceneStorageKey(),
  };
  if (directorPersistenceTimer !== null) return;

  directorPersistenceTimer = setTimeout(runScheduledDirectorPersistence, DIRECTOR_PERSIST_DEBOUNCE_MS);
}

function resumeScheduledDirectorPersistenceAfterUndoBatch() {
  // A debounce window that elapsed during the batch left a pending snapshot
  // behind without a timer; restart a full debounce period rather than
  // writing synchronously so releasing a drag stays as cheap as any edit.
  if (pendingDirectorPersistence === null || directorPersistenceTimer !== null) return;
  directorPersistenceTimer = setTimeout(runScheduledDirectorPersistence, DIRECTOR_PERSIST_DEBOUNCE_MS);
}

function persistDirectorStateImmediately(state: DirectorState) {
  cancelScheduledDirectorPersistence();
  writePersistedDirectorState(state);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushScheduledDirectorPersistence);
}

function readPersistedDirectorState(options: DirectorStateOptions = {}): DirectorState | null {
  const storage = getLocalStorageSafe();
  if (!storage) return null;

  let snapshot: string | null = null;
  const storageKey = getDirectorSceneStorageKey(options.persistenceScopeId);
  try {
    snapshot = storage.getItem(storageKey);
  } catch {
    return null;
  }
  if (!snapshot) return null;

  try {
    const parsed = JSON.parse(snapshot) as unknown;

    const persistedProject = parseDirectorProjectForLoad(parsed);
    if (persistedProject.success) {
      logDirectorProjectRepairs("加载本地工程", persistedProject.repairs);
      return {
        ...DEFAULT_UI_STATE,
        project: withPersistedLocalAssets(persistedProject.project, options.includePersistedLocalAssets),
      };
    }

    if (!parsed || typeof parsed !== "object" || !("project" in parsed)) {
      backupCorruptDirectorSnapshot(storage, storageKey, snapshot, persistedProject.error);
      return null;
    }

    const state = parsed as Partial<DirectorState>;
    const stateProject = parseDirectorProjectForLoad(state.project);
    if (!stateProject.success) {
      backupCorruptDirectorSnapshot(storage, storageKey, snapshot, stateProject.error);
      return null;
    }

    logDirectorProjectRepairs("加载本地工程", stateProject.repairs);
    return {
      // Stage keeps one editor workspace. Camera shots are rendered in the
      // live inset and capture pipeline rather than taking over the canvas.
      viewMode: "director",
      selectedObjectId: typeof state.selectedObjectId === "string" ? state.selectedObjectId : null,
      selectedObjectIds: Array.isArray(state.selectedObjectIds)
        ? state.selectedObjectIds.filter((item): item is string => typeof item === "string")
        : [],
      selectedCrowdId: typeof state.selectedCrowdId === "string" ? state.selectedCrowdId : null,
      directorInspectorMode: state.directorInspectorMode === "scene" ? "scene" : "auto",
      transformMode:
        state.transformMode === "rotate" || state.transformMode === "scale" ? state.transformMode : "translate",
      viewportAspectRatio: state.viewportAspectRatio ?? "auto",
      viewportLayout: normalizeDirectorViewportLayout(state.viewportLayout),
      viewportRuleOfThirdsEnabled: Boolean(state.viewportRuleOfThirdsEnabled),
      viewportPanelsCollapsed: Boolean(state.viewportPanelsCollapsed),
      viewportRotateSensitivity: normalizeViewportSensitivity(
        state.viewportRotateSensitivity,
        DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
      ),
      viewportZoomSensitivity: normalizeViewportSensitivity(
        state.viewportZoomSensitivity,
        DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
      ),
      viewportMoveSpeed: normalizeViewportMoveSpeed(state.viewportMoveSpeed),
      viewportCharacterMoveSpeed: normalizeViewportCharacterMoveSpeed(state.viewportCharacterMoveSpeed),
      viewportPilotInertia: normalizeCameraPilotFeel(state.viewportPilotInertia, DEFAULT_CAMERA_PILOT_INERTIA),
      viewportPilotLookSmoothing: normalizeCameraPilotFeel(
        state.viewportPilotLookSmoothing,
        DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING,
      ),
      viewportPilotBankStrength: normalizeCameraPilotFeel(
        state.viewportPilotBankStrength,
        DEFAULT_CAMERA_PILOT_BANK_STRENGTH,
      ),
      project: withPersistedLocalAssets(stateProject.project, options.includePersistedLocalAssets),
    };
  } catch (error) {
    backupCorruptDirectorSnapshot(storage, storageKey, snapshot, error instanceof Error ? error.message : "未知错误");
    return null;
  }
}

/**
 * Deep-clones a persisted or history snapshot into a fresh runtime state.
 * This is the restore boundary that keeps structurally shared undo/redo
 * entries isolated from the live document. persistenceHealth is deliberately
 * omitted: restores replace the document, not the storage health, and
 * Zustand's shallow merge preserves the current value.
 */
function createRuntimeStateFromPersistedState(state: DirectorState): Omit<DirectorRuntimeState, "persistenceHealth"> {
  const snapshot = cloneJsonValue(state);
  const objects = reconcileCameraRigObjects(snapshot.project.objects, snapshot.project.cameras);

  return {
    ...snapshot,
    project: objects === snapshot.project.objects ? snapshot.project : { ...snapshot.project, objects },
    clipboard: [],
    clipboardPasteCount: 0,
    undoStack: [],
    redoStack: [],
    historyUndoStack: [],
    historyRedoStack: [],
    historyBusy: false,
    pendingBlenderSyncs: [],
    undoBatchDepth: 0,
    undoBatchSnapshot: null,
    undoBatchHasTrackedChanges: false,
  };
}

function createUndoStackEntry(state: DirectorRuntimeState) {
  return extractPersistedDirectorState(state);
}

function createDirectorHistoryEntry(
  state: DirectorRuntimeState,
): Extract<DirectorHistoryEntry, { domain: "director" }> {
  return { domain: "director", state: createUndoStackEntry(state) };
}

export type { DirectorUiState, TransformMode } from "@director/protocol/workbench-ui";

export function createDefaultDirectorProject({
  includePersistedLocalAssets = false,
}: {
  includePersistedLocalAssets?: boolean;
} = {}): DirectorProject {
  const project = createCanonicalDefaultDirectorProject();
  if (!includePersistedLocalAssets) return persistProductionGraphIdentities(project);
  const defaultCharacterAsset = project.assets[0];
  return persistProductionGraphIdentities({
    ...project,
    assets: [
      ...project.assets,
      ...readPersistedLocalModelAssets().filter((asset) => asset.id !== defaultCharacterAsset?.id),
    ],
  });
}

export function createInitialDirectorState(options: DirectorStateOptions = {}): DirectorState {
  const persistedState = options.includePersistedScene ? readPersistedDirectorState(options) : null;

  if (persistedState) {
    return persistedState;
  }

  return {
    ...DEFAULT_UI_STATE,
    project: createDefaultDirectorProject({ includePersistedLocalAssets: options.includePersistedLocalAssets }),
  };
}

function updateObjectById(objects: DirectorObject[], id: string, updater: (item: DirectorObject) => DirectorObject) {
  return objects.map((item) => (item.id === id ? updater(item) : item));
}

function getNextCharacterColor(objects: DirectorObject[]) {
  const usedColors = new Set(objects.filter((item) => item.kind === "character").map((item) => item.color));
  const unusedColor = CHARACTER_COLOR_PALETTE.find((color) => !usedColors.has(color));

  if (unusedColor) return unusedColor;

  const characterCount = objects.filter((item) => item.kind === "character").length;
  return CHARACTER_COLOR_PALETTE[characterCount % CHARACTER_COLOR_PALETTE.length];
}

function getGeometryPrimitiveLabel(geometryType: GeometryPrimitiveType) {
  return GEOMETRY_PRIMITIVE_OPTIONS.find((option) => option.type === geometryType)?.label ?? "几何模型";
}

function getAddedModelColumnOffset(index: number) {
  const side = index % 2 === 1 ? -1 : 1;
  const step = Math.ceil(index / 2);

  return side * step * ADDED_MODEL_WORLD_SPACING;
}

function getCrowdCharacterPositions(rows: number, columns: number, spacing: number) {
  const safeRows = Math.max(1, rows);
  const safeColumns = Math.max(1, columns);
  const safeSpacing = Math.max(0.1, spacing);
  const xOffset = ((safeColumns - 1) * safeSpacing) / 2;
  const zOffset = ((safeRows - 1) * safeSpacing) / 2;
  const positions: Array<[number, number, number]> = [];

  for (let rowIndex = 0; rowIndex < safeRows; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < safeColumns; columnIndex += 1) {
      positions.push([
        Number((columnIndex * safeSpacing - xOffset).toFixed(4)),
        0,
        Number((rowIndex * safeSpacing - zOffset).toFixed(4)),
      ]);
    }
  }

  return positions;
}

function getCrowdCharacterOffset(objects: DirectorObject[], spacing: number): [number, number, number] {
  const safeSpacing = Math.max(0.1, spacing);
  const characterPositions = objects.filter((item) => item.kind === "character").map((item) => item.transform.position);
  const maxZ = characterPositions.length ? Math.max(...characterPositions.map((position) => position[2])) : 0;

  return [0, 0, Number((maxZ + safeSpacing * 2).toFixed(4))];
}

function formatCrowdLabel(rows: number, columns: number) {
  return `群众（${rows}x${columns}）`;
}

function buildPresetCharacterObject(
  state: DirectorRuntimeState,
  bodyType: CharacterBodyType,
  position: [number, number, number],
  crowdMetadata?: {
    crowdId: string;
    crowdLabel: string;
  },
  color?: string,
) {
  const characterCount = state.project.objects.filter((item) => item.kind === "character").length;
  const characterIndex = characterCount + 1;
  const objectId = getNextSequentialId(
    state.project.objects.map((item) => item.id),
    "char_preset_",
    characterIndex,
  );
  const normalizedBodyType = normalizeBodyType(bodyType);

  return {
    id: objectId,
    name: formatSceneItemName("角色", characterIndex),
    kind: "character" as const,
    characterSource: "asset" as const,
    assetRefId: getDefaultMixamoCharacterAssetRef().id,
    placementMode: "grounded" as const,
    visible: true,
    locked: false,
    bodyType: normalizedBodyType,
    color: color ?? getNextCharacterColor(state.project.objects),
    crowdId: crowdMetadata?.crowdId,
    crowdLabel: crowdMetadata?.crowdLabel,
    transform: createTransform(position),
    characterRig: {
      rigType: "mixamo" as const,
      posePresetId: "stand",
      controls: {},
    },
  } satisfies DirectorObject;
}

function formatCameraCaptureName(cameraName: string, captureIndex: number) {
  return `${cameraName}-截图${String(captureIndex).padStart(2, "0")}`;
}

function buildCameraCaptures(camera: DirectorCameraShot, dataUrls: string[]) {
  const existingCaptures = camera.captures ?? [];

  return dataUrls.map((dataUrl, indexOffset): DirectorCameraCapture => {
    const captureIndex = existingCaptures.length + indexOffset + 1;

    return {
      id: `${camera.id}-capture-${String(captureIndex).padStart(2, "0")}`,
      index: captureIndex,
      name: formatCameraCaptureName(camera.name, captureIndex),
      dataUrl,
    };
  });
}

function createDisplayNameFromFileName(fileName: string) {
  return fileName.replace(/\.(fbx|obj|glb|gltf|ply|splat|ksplat|spz|sog|jpe?g|png|webp)$/i, "");
}

function createSceneObjectFromAsset(asset: DirectorAssetRef, existingObjects: DirectorObject[]) {
  const nextObjectId = getNextSequentialId(
    existingObjects.map((item) => item.id),
    "obj_",
    existingObjects.length + 1,
  );

  return {
    id: nextObjectId,
    name: asset.name ?? createDisplayNameFromFileName(asset.fileName),
    kind: asset.kind,
    visible: true,
    locked: false,
    assetRefId: asset.id,
    ...(asset.kind === "character"
      ? {
          characterSource: "asset" as const,
          placementMode: "grounded" as const,
          characterRig: {
            rigType: "mixamo" as const,
            posePresetId: "stand",
            controls: {},
          },
        }
      : {}),
    transform: createTransform([0, 0, 0]),
    nativeSource: { engine: "blender", objectId: nextObjectId, provisioned: false },
  } satisfies DirectorObject;
}

function selectedObjectsPatch(
  ids: string[],
  selectedCrowdId: string | null = null,
  directorInspectorMode: DirectorUiState["directorInspectorMode"] = "auto",
) {
  return {
    selectedObjectId: ids.at(-1) ?? null,
    selectedObjectIds: ids,
    selectedCrowdId,
    directorInspectorMode,
  };
}

function withProjectPatch(
  state: DirectorRuntimeState,
  project: Partial<DirectorProject>,
  patch: Partial<Omit<DirectorRuntimeState, "project">> = {},
): DirectorRuntimeState {
  return { ...state, ...patch, project: { ...state.project, ...project } };
}

const MAX_TIMELINE_AUDIO_TRACKS = 8;
const MAX_TIMELINE_AUDIO_CLIPS_PER_TRACK = 128;
const MAX_TIMELINE_AUDIO_FRAME = 1_000_000;

/**
 * Applies a mutation to the stage timeline audio tracks. Creates the default
 * timeline on demand so audio can be added before any camera animation exists;
 * returning the same array (or null) from `mutate` means "no edit".
 */
function withTimelineAudioTracksPatch(
  state: DirectorRuntimeState,
  mutate: (tracks: DirectorTimelineAudioTrack[]) => DirectorTimelineAudioTrack[] | null,
): DirectorRuntimeState {
  const timeline: DirectorTimeline = state.project.scene.timeline ?? createDefaultDirectorFrameTimeline();
  const tracks = timeline.audioTracks ?? [];
  const next = mutate(tracks);
  if (next === null || next === tracks) return state;
  return withProjectPatch(state, {
    scene: { ...state.project.scene, timeline: { ...timeline, audioTracks: next } },
  });
}

function sanitizeTimelineAudioClipPatch(
  clip: DirectorTimelineAudioClip,
  patch: Partial<Omit<DirectorTimelineAudioClip, "id" | "mediaId">>,
): DirectorTimelineAudioClip {
  const next: DirectorTimelineAudioClip = { ...clip };
  if (patch.name !== undefined && patch.name.trim()) next.name = patch.name.trim().slice(0, 240);
  if (patch.sourceUrl !== undefined) next.sourceUrl = patch.sourceUrl?.trim() || undefined;
  if (patch.startFrame !== undefined && Number.isFinite(patch.startFrame)) {
    next.startFrame = clamp(Math.round(patch.startFrame), 0, MAX_TIMELINE_AUDIO_FRAME);
  }
  if (patch.durationFrames !== undefined && Number.isFinite(patch.durationFrames)) {
    next.durationFrames = clamp(Math.round(patch.durationFrames), 1, MAX_TIMELINE_AUDIO_FRAME);
  }
  if (patch.inSec !== undefined && Number.isFinite(patch.inSec)) next.inSec = clamp(patch.inSec, 0, 86_400);
  if (patch.sourceDurationSec !== undefined) {
    next.sourceDurationSec =
      Number.isFinite(patch.sourceDurationSec) && patch.sourceDurationSec! > 0
        ? Math.min(patch.sourceDurationSec!, 86_400)
        : undefined;
  }
  if (patch.volume !== undefined && Number.isFinite(patch.volume)) next.volume = clamp(patch.volume, 0, 1);
  if (patch.fadeInSec !== undefined && Number.isFinite(patch.fadeInSec)) {
    next.fadeInSec = clamp(patch.fadeInSec, 0, 60);
  }
  if (patch.fadeOutSec !== undefined && Number.isFinite(patch.fadeOutSec)) {
    next.fadeOutSec = clamp(patch.fadeOutSec, 0, 60);
  }
  if (patch.muted !== undefined) next.muted = patch.muted;
  return next;
}

function withWorldPatch(
  state: DirectorRuntimeState,
  mutate: (world: DirectorWorld) => DirectorWorld,
): DirectorRuntimeState {
  const world = state.project.world ?? createDefaultDirectorWorld();
  const next = mutate(world);
  if (next === world && state.project.world) return state;
  return withProjectPatch(state, { world: next });
}

function upsertWorldCollectionEntry<T extends { id: string }>(
  entries: T[],
  entry: T,
  maxEntries: number,
): { entries: T[]; applied: boolean } {
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index >= 0) {
    const next = [...entries];
    next[index] = entry;
    return { entries: next, applied: true };
  }
  if (entries.length >= maxEntries) return { entries, applied: false };
  return { entries: [...entries, entry], applied: true };
}

/**
 * Decide how a world-panel full-entity upsert maps onto the authoring engine.
 * "update"/"add" route through update_world_* / add_world_*; "capacity" mirrors
 * the historical applied=false result; null keeps the local mutator because the
 * authoring twin cannot express the write (locked entries reject non-unlock
 * patches, and add_world_* cannot author hidden or locked entries).
 */
function resolveWorldUpsertMode(
  entries: ReadonlyArray<{ id: string; visible: boolean; locked: boolean }>,
  entry: { id: string; visible: boolean; locked: boolean },
  maxEntries: number,
): "update" | "add" | "capacity" | null {
  const existing = entries.find((candidate) => candidate.id === entry.id);
  if (existing) return existing.locked ? null : "update";
  if (entry.visible === false || entry.locked) return null;
  if (entries.length >= maxEntries) return "capacity";
  return "add";
}

/** Snake_case authoring fields shared by add_world_effect / update_world_effect. */
function worldFirePropagationAuthoring(propagation: DirectorWorldEffect["propagation"]) {
  if (!propagation) return undefined;
  return {
    enabled: propagation.enabled,
    radius_m: propagation.radiusM,
    spread_rate: propagation.spreadRate,
  };
}

function worldEffectAuthoringFields(effect: DirectorWorldEffect) {
  const propagation = worldFirePropagationAuthoring(effect.propagation);
  return {
    name: effect.name,
    kind: effect.kind,
    anchor: {
      object_id: effect.anchor.objectId ?? null,
      position: [...effect.anchor.position] as [number, number, number],
    },
    shape: structuredClone(effect.shape),
    intensity: effect.intensity,
    size_scale: effect.sizeScale,
    speed_scale: effect.speedScale,
    wind_influence: effect.windInfluence,
    seed_offset: effect.seedOffset,
    ...(propagation ? { propagation } : {}),
  };
}

/** Snake_case authoring fields shared by add_world_water_body / update_world_water_body. */
function worldWaterBodyAuthoringFields(body: DirectorWorldWaterBody) {
  return {
    name: body.name,
    surface: {
      center: [...body.surface.center] as [number, number, number],
      size_x: body.surface.sizeX,
      size_z: body.surface.sizeZ,
      rotation_degrees: body.surface.rotationDegrees,
    },
    wave_amplitude: body.waveAmplitude,
    wave_length_m: body.waveLengthM,
    flow_direction_degrees: body.flowDirectionDegrees,
    flow_speed_mps: body.flowSpeedMps,
    color_shallow: body.colorShallow,
    color_deep: body.colorDeep,
    opacity: body.opacity,
    foam_intensity: body.foamIntensity,
  };
}

function worldRiverAuthoringFields(river: NonNullable<DirectorWorldWaterBody["river"]>) {
  return {
    points: river.points.map((point) => [...point] as [number, number, number]),
    width_m: river.widthM,
    ...(river.widthProfile ? { width_profile: [...river.widthProfile] } : {}),
  };
}

/** Snake_case authoring fields shared by add_world_wildlife_group / update_world_wildlife_group. */
function worldWildlifeAuthoringFields(group: DirectorWorldWildlifeGroup) {
  return {
    name: group.name,
    species: group.species,
    count: group.count,
    area: {
      center: [...group.area.center] as [number, number, number],
      radius: group.area.radius,
    },
    speed_scale: group.speedScale,
    size_scale: group.sizeScale,
    seed_offset: group.seedOffset,
  };
}

/**
 * update_camera recomputes fov from focal length / aspect / sensor after every
 * patch. Cameras whose (patched) fov matches that derivation can route through
 * authoring without drifting framing; snapshot cameras carrying an explicit
 * viewport fov keep the local mutator.
 */
function isCameraFovFocalStable(camera: DirectorCameraShot, patch: Partial<DirectorCameraShot> = {}) {
  const focalLengthMm = patch.focalLengthMm ?? camera.focalLengthMm ?? DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM;
  const aspectRatio = patch.aspectRatio ?? camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const sensorFormat = patch.sensorFormat ?? camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const derivedFov = getVerticalFovFromFocalLength(focalLengthMm, aspectRatio, sensorFormat);
  const expectedFov = patch.fov ?? camera.fov;
  return Math.abs(expectedFov - derivedFov) < 1e-6;
}

/** UI camera patch keys that update_camera can express. */
const CAMERA_AUTHORING_PATCH_KEYS = new Set([
  "name",
  "focalLengthMm",
  "sensorFormat",
  "aspectRatio",
  "apertureFStop",
  "focusDistanceM",
  "shutterAngle",
  "iso",
  "nearClipM",
  "farClipM",
  "anamorphicSqueeze",
  "handheldShake",
  "action",
  "fov",
  "targetMode",
  "targetObjectId",
]);

type DirectorCameraAuthoringPatch = Extract<DirectorAuthoringAction, { action: "update_camera" }>["patch"];

/**
 * Map a UI camera patch onto the update_camera authoring patch, or return null
 * when the patch must stay on the local mutator: view target / rig transform /
 * capture bookkeeping have different semantics, explicit fovs that diverge from
 * the focal-length derivation would drift, and invalid clip ranges would throw.
 */
function buildCameraAuthoringPatch(
  camera: DirectorCameraShot,
  patch: Partial<Omit<DirectorCameraShot, "id">>,
): DirectorCameraAuthoringPatch | null {
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !CAMERA_AUTHORING_PATCH_KEYS.has(key))) return null;
  // update_camera recomputes fov after every patch; only route when the result
  // matches what the UI expects (CameraPanel always sends the derived fov).
  if (!isCameraFovFocalStable(camera, patch)) return null;
  const nextNearClipM = patch.nearClipM ?? camera.nearClipM ?? DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M;
  const nextFarClipM = patch.farClipM ?? camera.farClipM ?? DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M;
  if (nextFarClipM <= nextNearClipM) return null;
  const hasTargetPatch = patch.targetMode !== undefined || patch.targetObjectId !== undefined;
  if (hasTargetPatch) {
    // target_object_id encodes both fields; mismatched pairs stay local.
    const nextMode = patch.targetMode ?? (patch.targetObjectId ? "object" : "manual");
    if ((nextMode === "object") !== Boolean(patch.targetObjectId)) return null;
  }
  // The local mutator materializes the default action on every write; a camera
  // without one keeps that backfill behavior.
  if (patch.action === undefined && !camera.action) return null;
  const authored: DirectorCameraAuthoringPatch = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(hasTargetPatch ? { target_object_id: patch.targetObjectId ?? null } : {}),
    ...(patch.focalLengthMm !== undefined ? { focal_length_mm: patch.focalLengthMm } : {}),
    ...(patch.sensorFormat !== undefined ? { sensor_format: patch.sensorFormat } : {}),
    ...(patch.aspectRatio !== undefined ? { aspect_ratio: patch.aspectRatio } : {}),
    ...(patch.apertureFStop !== undefined ? { aperture_f_stop: patch.apertureFStop } : {}),
    ...(patch.focusDistanceM !== undefined ? { focus_distance_m: patch.focusDistanceM } : {}),
    ...(patch.shutterAngle !== undefined ? { shutter_angle: patch.shutterAngle } : {}),
    ...(patch.iso !== undefined ? { iso: patch.iso } : {}),
    ...(patch.nearClipM !== undefined ? { near_clip_m: patch.nearClipM } : {}),
    ...(patch.farClipM !== undefined ? { far_clip_m: patch.farClipM } : {}),
    ...(patch.anamorphicSqueeze !== undefined ? { anamorphic_squeeze: patch.anamorphicSqueeze } : {}),
    ...(patch.handheldShake !== undefined ? { handheld_shake: patch.handheldShake } : {}),
    ...(patch.action !== undefined
      ? {
          // normalizeDirectorCameraAction always materializes the mode's
          // path/follow payload, so the result satisfies the parsed union the
          // permissive UI DirectorCameraAction interface widens.
          action: normalizeDirectorCameraAction(patch.action as DirectorCameraAction) as NonNullable<
            DirectorCameraAuthoringPatch["action"]
          >,
        }
      : {}),
  };
  return Object.keys(authored).length ? authored : null;
}

/** Snake_case authoring fields shared by add_world_road / update_world_road. */
function worldRoadAuthoringFields(road: DirectorWorldRoad) {
  return {
    name: road.name,
    points: road.points.map((point) => [...point] as [number, number, number]),
    width_m: road.widthM,
    loop: road.loop,
    vehicle_count: road.vehicleCount,
    speed_kph: road.speedKph,
    show_surface: road.showSurface,
    seed_offset: road.seedOffset,
  };
}

function appendSelectedObject(
  state: DirectorRuntimeState,
  object: DirectorObject,
  project: Partial<Omit<DirectorProject, "objects">> = {},
) {
  return withProjectPatch(
    state,
    { ...project, objects: [...state.project.objects, object] },
    selectedObjectsPatch([object.id]),
  );
}

function withObjectsPatch(
  state: DirectorRuntimeState,
  objects: DirectorObject[],
  project: Partial<Omit<DirectorProject, "objects">> = {},
  patch: Partial<Omit<DirectorRuntimeState, "project">> = {},
) {
  return withProjectPatch(state, { ...project, objects }, patch);
}

function mapProjectObjects(
  state: DirectorRuntimeState,
  map: (object: DirectorObject) => DirectorObject,
  project: Partial<Omit<DirectorProject, "objects">> = {},
  patch: Partial<Omit<DirectorRuntimeState, "project">> = {},
) {
  return withObjectsPatch(state, state.project.objects.map(map), project, patch);
}

function refreshCamerasFocusedOnObject(cameras: DirectorCameraShot[], object: DirectorObject) {
  return cameras.map((camera) =>
    camera.targetMode === "object" && camera.targetObjectId === object.id
      ? {
          ...camera,
          target: getDirectorObjectFocusTarget(object),
        }
      : camera,
  );
}

function refreshCamerasFocusedOnObjects(
  cameras: DirectorCameraShot[],
  objects: DirectorObject[],
  focusedObjectIds: Iterable<string>,
) {
  const focusedIdSet = new Set(focusedObjectIds);
  if (focusedIdSet.size === 0) return cameras;

  const objectsById = new Map(objects.map((item) => [item.id, item]));

  return cameras.map((camera) => {
    if (camera.targetMode !== "object" || !camera.targetObjectId || !focusedIdSet.has(camera.targetObjectId)) {
      return camera;
    }

    const targetObject = objectsById.get(camera.targetObjectId);
    if (!targetObject) {
      return {
        ...camera,
        targetMode: "manual" as const,
        targetObjectId: null,
      };
    }

    return {
      ...camera,
      target: getDirectorObjectFocusTarget(targetObject),
    };
  });
}

function getCrowdMemberObjects(objects: DirectorObject[], crowdId: string) {
  return objects.filter((item) => item.kind === "character" && item.crowdId === crowdId);
}

function getCrowdMemberIds(objects: DirectorObject[], crowdId: string) {
  return getCrowdMemberObjects(objects, crowdId).map((item) => item.id);
}

export function getCrowdAnchorTransform(objects: DirectorObject[], crowdId: string): DirectorTransform | null {
  const crowdMembers = getCrowdMemberObjects(objects, crowdId);
  if (!crowdMembers.length) return null;

  const position = crowdMembers.reduce(
    (accumulator, item) => {
      accumulator[0] += item.transform.position[0];
      accumulator[1] += item.transform.position[1];
      accumulator[2] += item.transform.position[2];
      return accumulator;
    },
    [0, 0, 0] as [number, number, number],
  );
  const memberCount = crowdMembers.length;
  const anchorPosition = roundTransformTuple([
    position[0] / memberCount,
    position[1] / memberCount,
    position[2] / memberCount,
  ]);
  const referenceMember = crowdMembers[0];

  return createTransform(
    anchorPosition,
    [...referenceMember.transform.rotation] as [number, number, number],
    [...referenceMember.transform.scale] as [number, number, number],
  );
}

function getNextCrowdId(objects: DirectorObject[]) {
  return getNextSequentialId(
    objects.map((item) => item.crowdId).filter((item): item is string => typeof item === "string"),
    "crowd_",
    1,
  );
}

function getNextObjectListId(objects: DirectorObject[]) {
  return getNextSequentialId(
    objects.map((item) => item.objectListId).filter((item): item is string => typeof item === "string"),
    "object_list_",
  );
}

function getNextCompositeParentId(objects: DirectorObject[]) {
  return getNextSequentialId(
    objects.filter((item) => item.isCompositeParent).map((item) => item.id),
    "composite_parent_",
  );
}

function getCompositeChildIds(objects: DirectorObject[], parentObjectId: string) {
  return objects.filter((item) => item.parentObjectId === parentObjectId).map((item) => item.id);
}

function composeTransformMatrix(transform: DirectorTransform) {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")),
    new Vector3(...transform.scale),
  );
}

function decomposeTransformMatrix(matrix: Matrix4): DirectorTransform {
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  const euler = new Euler().setFromQuaternion(rotation, "XYZ");

  return {
    position: roundTransformTuple([position.x, position.y, position.z]),
    rotation: roundTransformTuple([euler.x, euler.y, euler.z]),
    scale: roundTransformTuple([scale.x, scale.y, scale.z]),
  };
}

function applyCompositeDeltaToObject(object: DirectorObject, delta: Matrix4): DirectorObject {
  const transform = decomposeTransformMatrix(delta.clone().multiply(composeTransformMatrix(object.transform)));
  const animation = object.animation
    ? {
        ...object.animation,
        keyframes: object.animation.keyframes.map((keyframe) =>
          keyframe.transform
            ? {
                ...keyframe,
                transform: decomposeTransformMatrix(delta.clone().multiply(composeTransformMatrix(keyframe.transform))),
              }
            : keyframe,
        ),
      }
    : undefined;

  return { ...object, transform, ...(animation ? { animation } : {}) };
}

function applyCompositeParentTransformPatch(
  objects: DirectorObject[],
  parentObjectId: string,
  patch: Partial<DirectorTransform>,
) {
  const parent = objects.find((item) => item.id === parentObjectId && item.isCompositeParent);
  if (!parent) return { objects, changedObjectIds: [] as string[] };

  const nextTransform: DirectorTransform = {
    position: patch.position ?? parent.transform.position,
    rotation: patch.rotation ?? parent.transform.rotation,
    scale: patch.scale ?? parent.transform.scale,
  };
  const delta = composeTransformMatrix(nextTransform).multiply(composeTransformMatrix(parent.transform).invert());
  const childIds = new Set(getCompositeChildIds(objects, parentObjectId));
  const changedObjectIds = [parentObjectId, ...childIds];

  return {
    changedObjectIds,
    objects: objects.map((item) => {
      if (item.id === parentObjectId) return { ...item, transform: nextTransform };
      return childIds.has(item.id) ? applyCompositeDeltaToObject(item, delta) : item;
    }),
  };
}

function applyCrowdTransformPatch(objects: DirectorObject[], crowdId: string, patch: Partial<DirectorTransform>) {
  const anchor = getCrowdAnchorTransform(objects, crowdId);
  if (!anchor) {
    return {
      objects,
      changedObjectIds: [],
    };
  }

  const nextPosition = patch.position ?? anchor.position;
  const nextRotation = patch.rotation ?? anchor.rotation;
  const nextScale = patch.scale ?? anchor.scale;
  const deltaRotation: [number, number, number] = [
    nextRotation[0] - anchor.rotation[0],
    nextRotation[1] - anchor.rotation[1],
    nextRotation[2] - anchor.rotation[2],
  ];
  const scaleRatio: [number, number, number] = [
    anchor.scale[0] === 0 ? 1 : nextScale[0] / anchor.scale[0],
    anchor.scale[1] === 0 ? 1 : nextScale[1] / anchor.scale[1],
    anchor.scale[2] === 0 ? 1 : nextScale[2] / anchor.scale[2],
  ];
  const anchorPosition = anchor.position;
  const changedObjectIds = getCrowdMemberIds(objects, crowdId);
  const changedIdSet = new Set(changedObjectIds);

  return {
    changedObjectIds,
    objects: objects.map((item) => {
      if (!changedIdSet.has(item.id)) return item;

      const offsetX = (item.transform.position[0] - anchorPosition[0]) * scaleRatio[0];
      const offsetY = (item.transform.position[1] - anchorPosition[1]) * scaleRatio[1];
      const offsetZ = (item.transform.position[2] - anchorPosition[2]) * scaleRatio[2];
      const cosX = Math.cos(deltaRotation[0]);
      const sinX = Math.sin(deltaRotation[0]);
      const cosY = Math.cos(deltaRotation[1]);
      const sinY = Math.sin(deltaRotation[1]);
      const cosZ = Math.cos(deltaRotation[2]);
      const sinZ = Math.sin(deltaRotation[2]);

      const x1 = offsetX;
      const y1 = offsetY * cosX - offsetZ * sinX;
      const z1 = offsetY * sinX + offsetZ * cosX;

      const x2 = x1 * cosY + z1 * sinY;
      const y2 = y1;
      const z2 = -x1 * sinY + z1 * cosY;

      const x3 = x2 * cosZ - y2 * sinZ;
      const y3 = x2 * sinZ + y2 * cosZ;
      const z3 = z2;

      return {
        ...item,
        transform: {
          position: roundTransformTuple([nextPosition[0] + x3, nextPosition[1] + y3, nextPosition[2] + z3]),
          rotation: roundTransformTuple([
            item.transform.rotation[0] + deltaRotation[0],
            item.transform.rotation[1] + deltaRotation[1],
            item.transform.rotation[2] + deltaRotation[2],
          ]),
          scale: roundTransformTuple([
            item.transform.scale[0] * scaleRatio[0],
            item.transform.scale[1] * scaleRatio[1],
            item.transform.scale[2] * scaleRatio[2],
          ]),
        },
      };
    }),
  };
}

type ObjectTransformMutationResult = {
  objects: DirectorObject[];
  changedObjectIds: string[];
};

function applyObjectTransformMutation(
  state: DirectorRuntimeState,
  result: ObjectTransformMutationResult,
  mapObjects: (objects: DirectorObject[], changedIds: Set<string>) => DirectorObject[] = (objects) => objects,
): DirectorRuntimeState {
  if (result.changedObjectIds.length === 0) return state;
  return withProjectPatch(state, {
    objects: mapObjects(result.objects, new Set(result.changedObjectIds)),
    cameras: refreshCamerasFocusedOnObjects(state.project.cameras, result.objects, result.changedObjectIds),
  });
}

function getOrderedSelectedObjectIds(state: DirectorState) {
  if (state.selectedObjectIds.length) return state.selectedObjectIds;
  return state.selectedObjectId ? [state.selectedObjectId] : [];
}

function isObjectTransformEffectivelyLocked(
  scene: SceneSettings,
  objects: readonly DirectorObject[],
  object: DirectorObject,
) {
  if (isDirectorObjectEffectivelyLocked(scene, object)) return true;
  return Boolean(
    object.isCompositeParent &&
    objects.some((child) => child.parentObjectId === object.id && isDirectorObjectEffectivelyLocked(scene, child)),
  );
}

function deleteDirectorObjects(state: DirectorRuntimeState, objectIds: string[]): DirectorRuntimeState {
  const selectedObjectIds = Array.from(new Set(objectIds)).filter((id) =>
    state.project.objects.some((item) => item.id === id),
  );
  if (!selectedObjectIds.length) return state;

  const selectedObjects = state.project.objects.filter((item) => selectedObjectIds.includes(item.id));
  const linkedCameraIds = new Set(
    selectedObjects.filter((item) => item.kind === "camera" && item.linkedCameraId).map((item) => item.linkedCameraId),
  );
  const nextCameras = linkedCameraIds.size
    ? state.project.cameras.filter((camera) => !linkedCameraIds.has(camera.id))
    : state.project.cameras;
  const selectedObjectIdSet = new Set(selectedObjectIds);
  const nextFocusedCameras = nextCameras.map((camera) =>
    camera.targetObjectId && selectedObjectIdSet.has(camera.targetObjectId)
      ? { ...camera, targetMode: "manual" as const, targetObjectId: null }
      : camera,
  );
  const nextActiveCameraId =
    state.project.activeCameraId && linkedCameraIds.has(state.project.activeCameraId)
      ? (nextFocusedCameras[0]?.id ?? null)
      : state.project.activeCameraId;
  // Deleting a composite parent is non-destructive to its modeled parts: the
  // children keep their world transforms and become independent objects.
  const nextObjects = state.project.objects
    .filter((item) => !selectedObjectIds.includes(item.id))
    .map((item) =>
      item.parentObjectId && selectedObjectIdSet.has(item.parentObjectId)
        ? { ...item, parentObjectId: undefined }
        : item,
    );
  const assetsById = new Map(state.project.assets.map((item) => [item.id, item]));
  const remainingAssetRefIds = new Set(
    nextObjects.map((item) => item.assetRefId).filter((assetRefId): assetRefId is string => Boolean(assetRefId)),
  );
  const removedAssetRefIds = new Set(
    selectedObjects
      .map((item) => item.assetRefId)
      .filter((assetRefId): assetRefId is string => {
        if (typeof assetRefId !== "string" || remainingAssetRefIds.has(assetRefId)) return false;
        return assetsById.get(assetRefId)?.assetSource !== "local";
      }),
  );

  const nextProject: DirectorProject = {
    ...state.project,
    assets: state.project.assets.filter((item) => !removedAssetRefIds.has(item.id)),
    objects: nextObjects,
    cameras: nextFocusedCameras,
    activeCameraId: nextActiveCameraId,
    scene: {
      ...state.project.scene,
      annotations: (state.project.scene.annotations ?? []).filter(
        (annotation) => !annotation.anchor.objectId || !selectedObjectIdSet.has(annotation.anchor.objectId),
      ),
      measurements: (state.project.scene.measurements ?? []).filter(
        (measurement) =>
          (!measurement.start.objectId || !selectedObjectIdSet.has(measurement.start.objectId)) &&
          (!measurement.end.objectId || !selectedObjectIdSet.has(measurement.end.objectId)),
      ),
    },
  };

  return {
    ...state,
    ...selectedObjectsPatch([]),
    project: withReconciledProduction(nextProject),
  };
}

// Duplicate id allocation is shared with the Agent authoring engine
// (duplicate_objects) so UI paste and Agent duplicates land identical ids.
const createObjectIdForDuplicate = getDirectorDuplicateObjectId;

function applyPositionOffset(position: [number, number, number], offset: number): [number, number, number] {
  return [position[0] + offset, position[1], position[2] + offset];
}

function applyOffsetToTransform(transform: DirectorTransform, offset: number): DirectorTransform {
  return {
    ...transform,
    position: applyPositionOffset(transform.position, offset),
  };
}

function buildClipboardEntries(state: DirectorState): DirectorClipboardEntry[] {
  const selectedObjectIds = getOrderedSelectedObjectIds(state);
  if (!selectedObjectIds.length) return [];
  const modelAssetIds = new Set(
    state.project.assets.filter((asset) => asset.sourceType === "model").map((asset) => asset.id),
  );

  return selectedObjectIds.flatMap((objectId) => {
    const object = state.project.objects.find((item) => item.id === objectId);
    if (!object || (object.nativeSource && (!object.assetRefId || !modelAssetIds.has(object.assetRefId)))) {
      return [];
    }

    const camera =
      object.kind === "camera" && object.linkedCameraId
        ? state.project.cameras.find((item) => item.id === object.linkedCameraId)
        : undefined;

    return [
      {
        object: cloneJsonValue(object),
        camera: camera ? cloneJsonValue(camera) : undefined,
      },
    ];
  });
}

function pasteClipboardEntries(state: DirectorRuntimeState): DirectorRuntimeState {
  if (state.clipboard.length === 0) return state;

  const pasteIteration = state.clipboardPasteCount + 1;
  const offset = COPY_PASTE_POSITION_OFFSET * pasteIteration;
  const nextObjects = [...state.project.objects];
  const nextCameras = [...state.project.cameras];
  const idMap = new Map<string, string>();
  const crowdIdMap = new Map<string, string>();
  const pastedObjectIds: string[] = [];

  function getPastedCrowdId(sourceCrowdId: string) {
    const existing = crowdIdMap.get(sourceCrowdId);
    if (existing) return existing;

    const nextCrowdId = getNextCrowdId(nextObjects);
    crowdIdMap.set(sourceCrowdId, nextCrowdId);
    return nextCrowdId;
  }

  state.clipboard.forEach((entry) => {
    if (entry.object.kind === "camera" && entry.camera) {
      const cameraIndex = nextCameras.length + 1;
      const nextCameraId = getNextSequentialId(
        nextCameras.map((item) => item.id),
        "cam_",
        cameraIndex,
      );
      const nextObjectId = createObjectIdForDuplicate(nextObjects, entry.object);
      idMap.set(entry.object.id, nextObjectId);
      if (entry.object.linkedCameraId) {
        idMap.set(entry.object.linkedCameraId, nextCameraId);
      }

      const targetObjectId = entry.camera.targetObjectId ? idMap.get(entry.camera.targetObjectId) : null;
      const nextCamera: DirectorCameraShot = {
        ...entry.camera,
        id: nextCameraId,
        name: formatSceneItemName("机位", cameraIndex),
        transform: applyOffsetToTransform(entry.camera.transform, offset),
        target:
          entry.camera.targetMode === "manual" ? applyPositionOffset(entry.camera.target, offset) : entry.camera.target,
        targetObjectId: targetObjectId ?? entry.camera.targetObjectId ?? null,
        captures: [],
        lastCaptureUrl: null,
      };
      const nextCameraObject: DirectorObject = {
        ...entry.object,
        id: nextObjectId,
        name: nextCamera.name,
        linkedCameraId: nextCamera.id,
        transform: nextCamera.transform,
      };

      nextCameras.push(nextCamera);
      nextObjects.push(nextCameraObject);
      pastedObjectIds.push(nextObjectId);
      return;
    }

    const nextObjectId = createObjectIdForDuplicate(nextObjects, entry.object);
    idMap.set(entry.object.id, nextObjectId);
    const nextCharacterCount =
      entry.object.kind === "character" ? nextObjects.filter((item) => item.kind === "character").length + 1 : null;
    const duplicatedObject: DirectorObject = {
      ...entry.object,
      id: nextObjectId,
      name:
        entry.object.kind === "character" && nextCharacterCount
          ? formatSceneItemName("角色", nextCharacterCount)
          : entry.object.name,
      crowdId: entry.object.crowdId ? getPastedCrowdId(entry.object.crowdId) : entry.object.crowdId,
      transform: applyOffsetToTransform(entry.object.transform, offset),
      ...(entry.object.nativeSource
        ? { nativeSource: { engine: "blender" as const, objectId: nextObjectId, provisioned: false } }
        : {}),
    };

    nextObjects.push(duplicatedObject);
    pastedObjectIds.push(nextObjectId);
  });

  // A pasted child must never silently reattach to the original composition.
  // If its parent was pasted too, reconnect the duplicated pair; otherwise it
  // intentionally becomes an independent object.
  const pastedObjectIdSet = new Set(pastedObjectIds);
  const normalizedObjects = nextObjects.map((item) =>
    pastedObjectIdSet.has(item.id) && item.parentObjectId
      ? { ...item, parentObjectId: idMap.get(item.parentObjectId) }
      : item,
  );
  const nextObjectsById = new Map(normalizedObjects.map((item) => [item.id, item]));
  const normalizedCameras = nextCameras.map((camera) => {
    if (camera.targetMode !== "object" || !camera.targetObjectId) return camera;

    const mappedTargetObjectId = idMap.get(camera.targetObjectId) ?? camera.targetObjectId;
    const targetObject = nextObjectsById.get(mappedTargetObjectId);
    if (!targetObject) {
      return {
        ...camera,
        targetMode: "manual" as const,
        targetObjectId: null,
      };
    }

    return {
      ...camera,
      targetObjectId: mappedTargetObjectId,
      target: getDirectorObjectFocusTarget(targetObject),
    };
  });
  const lastPastedObject = pastedObjectIds.length
    ? nextObjects.find((item) => item.id === pastedObjectIds[pastedObjectIds.length - 1])
    : null;
  const pastedCrowdIds = Array.from(
    new Set(
      pastedObjectIds
        .map((objectId) => nextObjects.find((item) => item.id === objectId)?.crowdId)
        .filter((crowdId): crowdId is string => typeof crowdId === "string"),
    ),
  );

  return {
    ...state,
    selectedObjectId: pastedObjectIds[pastedObjectIds.length - 1] ?? null,
    selectedObjectIds: pastedObjectIds,
    selectedCrowdId: pastedCrowdIds.length === 1 ? pastedCrowdIds[0] : null,
    directorInspectorMode: "auto",
    clipboardPasteCount: pasteIteration,
    project: {
      ...state.project,
      objects: normalizedObjects,
      cameras: normalizedCameras,
      activeCameraId:
        lastPastedObject?.kind === "camera"
          ? (lastPastedObject.linkedCameraId ?? state.project.activeCameraId)
          : state.project.activeCameraId,
    },
  };
}

/**
 * Deep JSON-value equality that short-circuits on shared references. Undo
 * snapshots share every untouched subtree with the live document (structural
 * sharing), so a drag that ends where it started only walks the rebuilt spine
 * and compares the few changed leaves instead of stringifying the whole
 * project. Leaves fall back to JSON.stringify semantics (-0 equals 0,
 * undefined-valued keys equal missing keys) so no-op detection matches what
 * persistence would actually write.
 */
function structuralJsonEqual(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (Array.isArray(previous) && Array.isArray(next)) {
    return previous.length === next.length && previous.every((item, index) => structuralJsonEqual(item, next[index]));
  }
  if (isPlainJsonObject(previous) && isPlainJsonObject(next)) {
    const previousKeys = Object.keys(previous).filter((key) => previous[key] !== undefined);
    const nextKeys = Object.keys(next).filter((key) => next[key] !== undefined);
    if (previousKeys.length !== nextKeys.length) return false;
    return previousKeys.every((key) => structuralJsonEqual(previous[key], next[key]));
  }
  return JSON.stringify(previous) === JSON.stringify(next);
}

function isSameDirectorState(a: DirectorState, b: DirectorState) {
  return structuralJsonEqual(a, b);
}

function trimUndoStack(stack: DirectorState[]) {
  return stack.length > UNDO_STACK_LIMIT ? stack.slice(stack.length - UNDO_STACK_LIMIT) : stack;
}

function trimHistoryStack(stack: DirectorHistoryEntry[]) {
  return stack.length > UNDO_STACK_LIMIT ? stack.slice(stack.length - UNDO_STACK_LIMIT) : stack;
}

function blenderRootObjects(snapshot: BlenderLiveSceneSnapshot) {
  const objectIds = new Set(snapshot.objects.map((object) => object.id));
  return snapshot.objects.filter((object) => !object.parentId || !objectIds.has(object.parentId));
}

function blenderDirectorObjectId(object: BlenderLiveSceneSnapshot["objects"][number]) {
  return object.directorId ?? `native:${object.id}`;
}

function blenderDirectorTransform(object: BlenderLiveSceneSnapshot["objects"][number]): DirectorTransform {
  return {
    position: [object.position[0], object.position[1], object.position[2]],
    rotation: [object.rotation[0], object.rotation[1], object.rotation[2]],
    scale: [object.scale[0], object.scale[1], object.scale[2]],
  };
}

function blenderForwardTarget(
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
) {
  const target = new Vector3(0, 0, -1)
    .applyEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ"))
    .multiplyScalar(10)
    .add(new Vector3(...position));
  return [target.x, target.y, target.z] as [number, number, number];
}

function blenderCameraVerticalFov(camera: BlenderLiveSceneSnapshot["cameras"][number]) {
  const aspectRatio = 16 / 9;
  const sensorFit = camera.sensorFit === "AUTO" ? (aspectRatio >= 1 ? "HORIZONTAL" : "VERTICAL") : camera.sensorFit;
  const sensorHeight = sensorFit === "HORIZONTAL" ? camera.sensorWidthMm / aspectRatio : camera.sensorHeightMm;
  return (2 * Math.atan(sensorHeight / (2 * camera.focalLengthMm)) * 180) / Math.PI;
}

function reconcileBlenderCameras(existing: DirectorCameraShot[], nativeCameras: BlenderLiveSceneSnapshot["cameras"]) {
  const nativeIds = new Set(nativeCameras.map((camera) => camera.id));
  const cameras = existing.filter(
    (camera) => camera.nativeSource?.engine !== "blender" || nativeIds.has(camera.nativeSource.objectId),
  );
  for (const nativeCamera of nativeCameras) {
    const existingIndex = cameras.findIndex(
      (camera) => camera.nativeSource?.engine === "blender" && camera.nativeSource.objectId === nativeCamera.id,
    );
    const previous = existingIndex >= 0 ? cameras[existingIndex] : undefined;
    const id = previous?.id ?? `native-camera:${nativeCamera.id}`;
    const fov = blenderCameraVerticalFov(nativeCamera);
    const target = blenderForwardTarget(nativeCamera.position, nativeCamera.rotation);
    const next: DirectorCameraShot = {
      ...previous,
      id,
      name: nativeCamera.name,
      fov,
      focalLengthMm: nativeCamera.focalLengthMm,
      sensorFormat: previous?.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
      apertureFStop: previous?.apertureFStop ?? DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
      focusDistanceM: previous?.focusDistanceM ?? 10,
      shutterAngle: previous?.shutterAngle ?? DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
      iso: previous?.iso ?? DEFAULT_DIRECTOR_CAMERA_ISO,
      nearClipM: nativeCamera.clipStart,
      farClipM: nativeCamera.clipEnd,
      anamorphicSqueeze: previous?.anamorphicSqueeze ?? DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
      aspectRatio: previous?.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
      handheldShake: previous?.handheldShake ?? DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
      action: previous?.action ?? DEFAULT_DIRECTOR_CAMERA_ACTION,
      transform: {
        position: getCameraRigPositionFromViewSnapshot({ fov, position: [...nativeCamera.position], target }),
        rotation: [...nativeCamera.rotation],
        scale: [1, 1, 1],
      },
      targetMode: "manual",
      targetObjectId: null,
      target,
      lastCaptureUrl: previous?.lastCaptureUrl ?? null,
      captures: previous?.captures ?? [],
      nativeSource: { engine: "blender", objectId: nativeCamera.id, provisioned: true },
      projectionType: nativeCamera.projectionType === "ORTHOGRAPHIC" ? "orthographic" : "perspective",
      orthographicScaleM: nativeCamera.orthographicScale,
      sensorFit: nativeCamera.sensorFit.toLowerCase() as "auto" | "horizontal" | "vertical",
      sensorWidthMm: nativeCamera.sensorWidthMm,
      sensorHeightMm: nativeCamera.sensorHeightMm,
      lensShiftX: nativeCamera.shiftX,
      lensShiftY: nativeCamera.shiftY,
    };
    if (existingIndex >= 0) cameras[existingIndex] = next;
    else cameras.push(next);
  }
  return cameras;
}

function createCameraRigObject(camera: DirectorCameraShot, id: string): DirectorObject {
  return {
    id,
    name: camera.name,
    kind: "camera",
    visible: true,
    locked: false,
    linkedCameraId: camera.id,
    transform: createTransform(
      [...camera.transform.position],
      [...camera.transform.rotation],
      [...camera.transform.scale],
    ),
  };
}

function nextCameraRigObjectId(cameraId: string, usedIds: Set<string>) {
  const preferred = `${cameraId}-rig`;
  if (!usedIds.has(preferred)) return preferred;
  return getNextSequentialId([...usedIds], "cam_object_", 1);
}

/**
 * Object tree, selection, and the camera inspector all key off `kind:"camera"`
 * objects. Blender live snapshots keep cameras in a separate collection, so
 * sync must create and refresh the matching Stage rigs.
 */
function reconcileCameraRigObjects(objects: DirectorObject[], cameras: DirectorCameraShot[]): DirectorObject[] {
  const camerasById = new Map(cameras.map((camera) => [camera.id, camera]));
  const claimedCameraIds = new Set<string>();
  let changed = false;
  const next: DirectorObject[] = [];

  for (const object of objects) {
    if (object.kind !== "camera") {
      next.push(object);
      continue;
    }
    const camera = object.linkedCameraId ? camerasById.get(object.linkedCameraId) : undefined;
    if (!camera || claimedCameraIds.has(camera.id)) {
      changed = true;
      continue;
    }
    claimedCameraIds.add(camera.id);
    if (object.name === camera.name && sameTransform(object.transform, camera.transform)) {
      next.push(object);
      continue;
    }
    changed = true;
    next.push({
      ...object,
      name: camera.name,
      transform: createTransform(
        [...camera.transform.position],
        [...camera.transform.rotation],
        [...camera.transform.scale],
      ),
    });
  }

  const usedIds = new Set(next.map((object) => object.id));
  for (const camera of cameras) {
    if (claimedCameraIds.has(camera.id)) continue;
    const id = nextCameraRigObjectId(camera.id, usedIds);
    usedIds.add(id);
    next.push(createCameraRigObject(camera, id));
    changed = true;
  }

  return changed ? next : objects;
}

function blenderLightType(kind: BlenderLiveSceneSnapshot["lights"][number]["kind"]): DirectorLightType {
  if (kind === "sun") return "directional";
  if (kind === "area") return "rect-area";
  return kind;
}

function hasBlenderLightRepresentation(type: DirectorLightType) {
  return type === "directional" || type === "point" || type === "spot" || type === "rect-area";
}

function blenderLightIntensity(kind: BlenderLiveSceneSnapshot["lights"][number]["kind"], energy: number) {
  return clamp(kind === "sun" ? energy : energy / 1_000, 0, 100);
}

function blenderLightColor(color: readonly [number, number, number]) {
  return `#${new Color(color[0], color[1], color[2]).getHexString(SRGBColorSpace)}`;
}

function reconcileBlenderLights(existing: DirectorLight[], nativeLights: BlenderLiveSceneSnapshot["lights"]) {
  const nativeIds = new Set(nativeLights.map((light) => light.id));
  const lights = existing.filter(
    (light) => light.nativeSource?.engine !== "blender" || nativeIds.has(light.nativeSource.objectId),
  );
  for (const nativeLight of nativeLights) {
    const existingIndex = lights.findIndex(
      (light) => light.nativeSource?.engine === "blender" && light.nativeSource.objectId === nativeLight.id,
    );
    const previous = existingIndex >= 0 ? lights[existingIndex] : undefined;
    const id = previous?.id ?? `native-light:${nativeLight.id}`;
    const type = blenderLightType(nativeLight.kind);
    const next: DirectorLight = {
      ...createDirectorLight(id, type),
      ...previous,
      id,
      name: nativeLight.name,
      type,
      visible: nativeLight.visible,
      color: blenderLightColor(nativeLight.color),
      intensity: blenderLightIntensity(nativeLight.kind, nativeLight.energy),
      position: [...nativeLight.position],
      target: blenderForwardTarget(nativeLight.position, nativeLight.rotation),
      width: nativeLight.kind === "area" ? nativeLight.size : previous?.width,
      height: nativeLight.kind === "area" ? nativeLight.size : previous?.height,
      nativeSource: { engine: "blender", objectId: nativeLight.id, provisioned: true },
    };
    if (existingIndex >= 0) lights[existingIndex] = next;
    else lights.push(next);
  }
  return lights;
}

function sameLocalBounds(left: DirectorObject["localBoundsM"], right: DirectorObject["localBoundsM"]) {
  if (!left || !right) return left === right;
  return (
    left.min.every((value, axis) => value === right.min[axis]) &&
    left.max.every((value, axis) => value === right.max[axis])
  );
}

function sameTransform(left: DirectorTransform, right: DirectorTransform) {
  return (
    left.position.every((value, index) => value === right.position[index]) &&
    left.rotation.every((value, index) => value === right.rotation[index]) &&
    left.scale.every((value, index) => value === right.scale[index])
  );
}

export const useDirectorStore = create<DirectorStore>((set, get) => {
  const initialRuntimeState = createRuntimeStateFromPersistedState(
    createInitialDirectorState({ includePersistedLocalAssets: true, includePersistedScene: true }),
  );

  function commitMutation(
    updater: (state: DirectorRuntimeState) => DirectorRuntimeState,
    options: { trackUndo?: boolean; persist?: boolean } = {},
  ) {
    const { trackUndo = true, persist = true } = options;

    set((state) => {
      const currentState = state as DirectorRuntimeState;
      // The store updates immutably across the board, so an unchanged
      // reference means "no edit" and skips undo bookkeeping and persistence
      // without cloning or stringifying the project.
      const nextState = updater(currentState);
      if (nextState === currentState) return currentState;

      const isActiveUndoBatch = trackUndo && currentState.undoBatchDepth > 0;
      // TransformControls and inspector sliders can emit many mutations per
      // display frame. The batch already owns one immutable pre-drag snapshot,
      // and the non-batch path clones the previous state exactly once per
      // actual edit, so no comparison-only clone or stringify remains.
      const shouldCaptureUndoBatchSnapshot = isActiveUndoBatch && currentState.undoBatchSnapshot === null;
      const shouldPushDirectorHistory = trackUndo && currentState.undoBatchDepth === 0;
      const directorHistoryEntry = shouldPushDirectorHistory ? createDirectorHistoryEntry(currentState) : null;
      const runtimeState: DirectorRuntimeState = {
        ...nextState,
        undoStack: directorHistoryEntry
          ? trimUndoStack([...currentState.undoStack, directorHistoryEntry.state])
          : nextState.undoStack,
        historyUndoStack: directorHistoryEntry
          ? trimHistoryStack([...currentState.historyUndoStack, directorHistoryEntry])
          : nextState.historyUndoStack,
        // A new edit starts a new branch. UI-only mutations deliberately keep
        // the redo history, but every tracked document mutation invalidates it.
        redoStack: trackUndo ? [] : (nextState.redoStack ?? []),
        historyRedoStack: trackUndo ? [] : nextState.historyRedoStack,
        undoBatchSnapshot: shouldCaptureUndoBatchSnapshot
          ? createUndoStackEntry(currentState)
          : nextState.undoBatchSnapshot,
        undoBatchHasTrackedChanges: isActiveUndoBatch ? true : nextState.undoBatchHasTrackedChanges,
      };

      if (persist) {
        // Keep the latest immutable Zustand snapshot and materialize its
        // persistence-only clone when the debounce actually flushes. This
        // avoids a full JSON clone for every intermediate drag value.
        schedulePersistedDirectorState(runtimeState);
      }

      return runtimeState;
    });
  }

  function commitUiMutation(updater: (state: DirectorRuntimeState) => DirectorRuntimeState) {
    set((state) => {
      const currentState = state as DirectorRuntimeState;
      const nextState = updater(currentState);
      if (nextState === currentState) return currentState;
      // UI-only state is never part of undo. Avoid cloning/stringifying the
      // complete project just to prove a selection or viewport preference changed.
      schedulePersistedDirectorState(nextState);
      return nextState;
    });
  }

  function commitUiPatch(
    patch: Partial<DirectorRuntimeState> | ((state: DirectorRuntimeState) => Partial<DirectorRuntimeState>),
  ) {
    commitUiMutation((state) => ({ ...state, ...(typeof patch === "function" ? patch(state) : patch) }));
  }

  async function replayBlenderHistory(
    entry: Extract<DirectorHistoryEntry, { domain: "blender" }>,
    direction: "undo" | "redo",
  ) {
    const currentState = get() as DirectorRuntimeState;
    const nativeScene = currentState.project.nativeScene;
    if (
      currentState.historyBusy ||
      nativeScene?.projectId !== entry.projectId ||
      nativeScene.sceneEpoch !== entry.sceneEpoch ||
      nativeScene.revision === undefined
    ) {
      return;
    }

    set((state) => ({ ...(state as DirectorRuntimeState), historyBusy: true }));
    try {
      const result = await applyBlenderRuntimeOperations({
        expectedSceneEpoch: nativeScene.sceneEpoch,
        expectedRevision: nativeScene.revision,
        operations: [{ op: direction === "undo" ? "undo_scene" : "redo_scene" }],
        beforePublish: (transaction) => {
          get().prepareBlenderSync({
            sceneEpoch: transaction.receipt.sceneEpoch,
            revision: transaction.receipt.revisionAfter,
            origin: "history-replay",
          });
        },
      });

      set((state) => {
        const runtimeState = state as DirectorRuntimeState;
        const source = direction === "undo" ? runtimeState.historyUndoStack : runtimeState.historyRedoStack;
        if (source[source.length - 1] !== entry) return { ...runtimeState, historyBusy: false };
        return direction === "undo"
          ? {
              ...runtimeState,
              historyBusy: false,
              historyUndoStack: source.slice(0, -1),
              historyRedoStack: trimHistoryStack([...runtimeState.historyRedoStack, entry]),
            }
          : {
              ...runtimeState,
              historyBusy: false,
              historyUndoStack: trimHistoryStack([...runtimeState.historyUndoStack, entry]),
              historyRedoStack: source.slice(0, -1),
            };
      });
      if (result.projectedSnapshot) get().syncBlenderScene(result.projectedSnapshot);
    } catch (error) {
      set((state) => ({ ...(state as DirectorRuntimeState), historyBusy: false }));
      notifyDirector({
        severity: "error",
        title: direction === "undo" ? "无法撤销 Blender 编辑" : "无法重做 Blender 编辑",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  type ObjectMutationTarget = { id: string } | { crowdId: string };
  const mutateTargetObjects = (target: ObjectMutationTarget, updater: (item: DirectorObject) => DirectorObject) =>
    commitMutation((state) => ({
      ...state,
      project: {
        ...state.project,
        objects: state.project.objects.map((item) =>
          ("id" in target ? item.id === target.id : item.kind === "character" && item.crowdId === target.crowdId)
            ? updater(item)
            : item,
        ),
      },
    }));

  /**
   * Shared UI entry into the Agent authoring engine. Applies one atomic action
   * batch (one undo entry) and surfaces failures as Director notifications.
   */
  const dispatchUiAuthoring = (
    actions: DirectorAuthoringAction[],
    idempotencyKey: string,
    failureTitle = "更新失败",
  ): boolean => {
    if (!actions.length) return false;
    const receipt = dispatchDirectorAuthoringActions(actions, { idempotencyKey });
    if (!receipt.ok) {
      notifyDirector({
        severity: "error",
        title: failureTitle,
        detail: receipt.error,
      });
      return false;
    }
    return true;
  };

  /**
   * RAF/gizmo/slider batches (undoBatchDepth > 0) keep the lightweight local
   * mutators so intermediate drag samples stay cheap; pointer-up still lands
   * one undo entry through beginUndoBatch/endUndoBatch.
   */
  const canUseAuthoringPath = () => get().undoBatchDepth === 0;

  const targetIdempotencySuffix = (target: ObjectMutationTarget) =>
    "id" in target ? target.id : `crowd:${target.crowdId}`;

  /** Characters matched by a pose/motion/IK target; crowd targets fan out per member. */
  const resolveTargetCharacters = (target: ObjectMutationTarget) =>
    get().project.objects.filter((item) =>
      "id" in target
        ? item.id === target.id && item.kind === "character"
        : item.kind === "character" && item.crowdId === target.crowdId,
    );

  /**
   * Compile a crowd-anchor transform patch into per-member update_object
   * patches carrying the exact transforms the local writer would store.
   * Returns null when the crowd is empty, a member still needs the UI
   * focused-camera refresh, or a grounded drop targets a provisioned native
   * Blender member (placement_mode patches are rejected there).
   */
  const compileCrowdTransformActions = (
    crowdId: string,
    patch: Partial<DirectorTransform>,
    options: { grounded?: boolean } = {},
  ): DirectorAuthoringAction[] | null => {
    const currentState = get();
    const result = applyCrowdTransformPatch(currentState.project.objects, crowdId, patch);
    if (!result.changedObjectIds.length) return null;
    const changed = new Set(result.changedObjectIds);
    const hasObjectFocusedCamera = currentState.project.cameras.some(
      (camera) => camera.targetMode === "object" && camera.targetObjectId && changed.has(camera.targetObjectId),
    );
    if (hasObjectFocusedCamera) return null;
    const members = result.objects.filter((item) => changed.has(item.id));
    if (
      options.grounded &&
      members.some((item) => item.nativeSource?.engine === "blender" && item.nativeSource.provisioned !== false)
    ) {
      return null;
    }
    return members.map((item) => ({
      action: "update_object" as const,
      object_id: item.id,
      patch: {
        transform: structuredClone(item.transform),
        ...(options.grounded ? { placement_mode: "grounded" as const } : {}),
      },
      force: true,
    }));
  };

  const toggleObjectFlag = (id: string, field: "visible" | "locked") => {
    const object = get().project.objects.find((item) => item.id === id);
    if (!object) return;
    // Camera rigs still use the local mutator; authoring routes camera edits through update_camera.
    if (object.kind === "camera") {
      mutateTargetObjects({ id }, (item) => ({ ...item, [field]: !item[field] }));
      return;
    }
    const receipt = dispatchDirectorAuthoringActions(
      [
        {
          action: "update_object",
          object_id: id,
          patch: { [field]: !object[field] },
          force: true,
        },
      ],
      { idempotencyKey: `ui-toggle-${field}:${id}` },
    );
    if (!receipt.ok) {
      notifyDirector({
        severity: "error",
        title: "更新失败",
        detail: receipt.error,
      });
    }
  };

  const applyTargetPosePreset = (target: ObjectMutationTarget, presetId: PosePresetId) => {
    // Preset application keeps the preset identity, so it maps onto the
    // authoring update_object pose_preset_id patch (not raw pose controls).
    // Characters without a rig keep the historical local no-op.
    const riggedCharacters = resolveTargetCharacters(target).filter((item) => item.characterRig);
    if (canUseAuthoringPath() && riggedCharacters.length) {
      dispatchUiAuthoring(
        riggedCharacters.map((item) => ({
          action: "update_object" as const,
          object_id: item.id,
          patch: { pose_preset_id: presetId },
          force: true,
        })),
        `ui-pose-preset:${targetIdempotencySuffix(target)}`,
      );
      return;
    }
    const preset = MANNEQUIN_POSE_PRESETS.find((item) => item.id === presetId);
    mutateTargetObjects(target, (item) => ({
      ...item,
      characterRig: item.characterRig
        ? {
            ...item.characterRig,
            posePresetId: presetId,
            controls: preset ? { ...preset.controls } : item.characterRig.controls,
          }
        : item.characterRig,
    }));
  };

  const updateTargetPoseControl = (target: ObjectMutationTarget, key: string, value: number) => {
    if (!isCharacterPoseControlKey(key) || !Number.isFinite(value)) return;
    const riggedCharacters = resolveTargetCharacters(target).filter((item) => item.characterRig);
    if (canUseAuthoringPath() && riggedCharacters.length) {
      dispatchUiAuthoring(
        riggedCharacters.map((item) => ({
          action: "set_character_pose_controls" as const,
          object_id: item.id,
          // Clamp to the body-type-aware UI limits before the shared merge;
          // the in-process dispatch does not re-run wire validation.
          controls: [{ control: key, value: clampCharacterPoseControlValue(key, value, item.bodyType) }],
          force: true,
        })),
        `ui-pose-control:${targetIdempotencySuffix(target)}:${key}`,
      );
      return;
    }
    mutateTargetObjects(target, (item) => ({
      ...item,
      characterRig: item.characterRig
        ? {
            ...item.characterRig,
            posePresetId: null,
            controls: {
              ...item.characterRig.controls,
              [key]: clampCharacterPoseControlValue(key, value, item.bodyType),
            },
          }
        : item.characterRig,
    }));
  };

  const setTargetCharacterMotion = (target: ObjectMutationTarget, motion: DirectorCharacterMotionState | undefined) => {
    const characters = resolveTargetCharacters(target);
    if (canUseAuthoringPath() && characters.length) {
      if (motion === undefined) {
        // Members without an active clip already match the cleared authoring
        // state, so skipping them avoids a no-op undo entry.
        const withMotion = characters.filter((item) => item.characterRig?.motion);
        if (withMotion.length) {
          dispatchUiAuthoring(
            withMotion.map((item) => ({
              action: "clear_character_motion" as const,
              object_id: item.id,
              force: true,
            })),
            `ui-motion-clear:${targetIdempotencySuffix(target)}`,
          );
        }
        return;
      }
      const rootMotion = motion.rootMotion;
      if (rootMotion !== "authored" && isDirectorCharacterMotionId(motion.clipId)) {
        dispatchUiAuthoring(
          characters.map((item) => ({
            action: "set_character_motion" as const,
            object_id: item.id,
            clip_id: motion.clipId,
            enabled: motion.enabled,
            loop: motion.loop,
            speed: motion.speed,
            weight: motion.weight,
            start_frame: motion.startFrame,
            blend_in_s: motion.blendInS,
            blend_out_s: motion.blendOutS,
            root_motion: rootMotion,
            force: true,
          })),
          `ui-motion:${targetIdempotencySuffix(target)}:${motion.clipId}`,
        );
        return;
      }
      // human-only: legacy `authored` root motion and non-catalog clips predate
      // the in-place-only authoring contract, so they keep the local mutator.
    }
    mutateTargetObjects(target, (item) =>
      item.kind === "character"
        ? {
            ...item,
            characterRig: {
              ...(item.characterRig ?? { rigType: "mixamo" as const, posePresetId: "stand", controls: {} }),
              posePresetId: null,
              motion: motion ? structuredClone(motion) : undefined,
            },
          }
        : item,
    );
  };

  const setTargetCharacterIk = (
    target: ObjectMutationTarget,
    effector: DirectorCharacterIkEffector,
    value: DirectorCharacterIkTarget,
  ) => {
    const characters = resolveTargetCharacters(target);
    if (canUseAuthoringPath() && characters.length) {
      dispatchUiAuthoring(
        characters.map((item) => ({
          action: "set_character_ik" as const,
          object_id: item.id,
          effector,
          target: [...value.target] as [number, number, number],
          pole: [...value.pole] as [number, number, number],
          weight: value.weight,
          reach_clamp: value.reachClamp,
          force: true,
        })),
        `ui-ik:${targetIdempotencySuffix(target)}:${effector}`,
      );
      return;
    }
    mutateTargetObjects(target, (item) =>
      item.kind === "character"
        ? {
            ...item,
            characterRig: {
              ...(item.characterRig ?? { rigType: "mixamo" as const, posePresetId: "stand", controls: {} }),
              ik: { ...item.characterRig?.ik, [effector]: structuredClone(value) },
            },
          }
        : item,
    );
  };

  const clearTargetCharacterIk = (target: ObjectMutationTarget, effector: DirectorCharacterIkEffector) => {
    if (canUseAuthoringPath()) {
      const withEffector = resolveTargetCharacters(target).filter((item) => item.characterRig?.ik?.[effector]);
      // Members without the effector already match the cleared state.
      if (withEffector.length) {
        dispatchUiAuthoring(
          withEffector.map((item) => ({
            action: "clear_character_ik" as const,
            object_id: item.id,
            effector,
            force: true,
          })),
          `ui-ik-clear:${targetIdempotencySuffix(target)}:${effector}`,
        );
      }
      return;
    }
    mutateTargetObjects(target, (item) => {
      if (item.kind !== "character" || !item.characterRig?.ik?.[effector]) return item;
      const ik = { ...item.characterRig.ik };
      delete ik[effector];
      return {
        ...item,
        characterRig: { ...item.characterRig, ...(Object.keys(ik).length ? { ik } : { ik: undefined }) },
      };
    });
  };

  return {
    ...initialRuntimeState,
    persistenceHealth: createInitialDirectorPersistenceHealth(),
    beginUndoBatch: () => {
      set((state) => {
        const currentState = state as DirectorRuntimeState;

        return {
          ...currentState,
          undoBatchDepth: currentState.undoBatchDepth + 1,
          undoBatchSnapshot:
            currentState.undoBatchDepth === 0 ? createUndoStackEntry(currentState) : currentState.undoBatchSnapshot,
          undoBatchHasTrackedChanges:
            currentState.undoBatchDepth === 0 ? false : currentState.undoBatchHasTrackedChanges,
        };
      });
    },
    endUndoBatch: () => {
      set((state) => {
        const currentState = state as DirectorRuntimeState;
        if (currentState.undoBatchDepth === 0) return currentState;

        const nextUndoBatchDepth = currentState.undoBatchDepth - 1;
        if (nextUndoBatchDepth > 0) {
          return {
            ...currentState,
            undoBatchDepth: nextUndoBatchDepth,
          };
        }

        const currentSnapshot = extractPersistedDirectorState(currentState);
        const shouldPushUndoEntry =
          currentState.undoBatchHasTrackedChanges &&
          currentState.undoBatchSnapshot !== null &&
          !isSameDirectorState(currentState.undoBatchSnapshot, currentSnapshot);

        // Persistence flushes were deferred while the batch was active; the
        // outermost end restarts the normal debounce for the pending snapshot.
        resumeScheduledDirectorPersistenceAfterUndoBatch();

        const directorHistoryEntry = shouldPushUndoEntry
          ? { domain: "director" as const, state: currentState.undoBatchSnapshot! }
          : null;

        return {
          ...currentState,
          undoStack: shouldPushUndoEntry
            ? trimUndoStack([...currentState.undoStack, currentState.undoBatchSnapshot!])
            : currentState.undoStack,
          historyUndoStack: directorHistoryEntry
            ? trimHistoryStack([...currentState.historyUndoStack, directorHistoryEntry])
            : currentState.historyUndoStack,
          redoStack: shouldPushUndoEntry ? [] : (currentState.redoStack ?? []),
          historyRedoStack: shouldPushUndoEntry ? [] : currentState.historyRedoStack,
          undoBatchDepth: 0,
          undoBatchSnapshot: null,
          undoBatchHasTrackedChanges: false,
        };
      });
    },
    setTransformMode: (transformMode) => commitUiPatch({ transformMode }),
    setViewportAspectRatio: (viewportAspectRatio) => commitUiPatch({ viewportAspectRatio }),
    setViewportLayout: (layout) => commitUiPatch({ viewportLayout: normalizeDirectorViewportLayout(layout) }),
    toggleViewportLayout: () =>
      commitUiPatch((state) => ({ viewportLayout: state.viewportLayout === "quad" ? "single" : "quad" })),
    setViewportRuleOfThirdsEnabled: (viewportRuleOfThirdsEnabled) => commitUiPatch({ viewportRuleOfThirdsEnabled }),
    toggleViewportPanelsCollapsed: () =>
      commitUiPatch((state) => ({ viewportPanelsCollapsed: !state.viewportPanelsCollapsed })),
    setViewportPanelsCollapsed: (viewportPanelsCollapsed) => commitUiPatch({ viewportPanelsCollapsed }),
    setViewportRotateSensitivity: (sensitivity) =>
      commitUiPatch({
        viewportRotateSensitivity: normalizeViewportSensitivity(sensitivity, DEFAULT_VIEWPORT_ROTATE_SENSITIVITY),
      }),
    setViewportZoomSensitivity: (sensitivity) =>
      commitUiPatch({
        viewportZoomSensitivity: normalizeViewportSensitivity(sensitivity, DEFAULT_VIEWPORT_ZOOM_SENSITIVITY),
      }),
    setViewportMoveSpeed: (speed) => commitUiPatch({ viewportMoveSpeed: normalizeViewportMoveSpeed(speed) }),
    setViewportCharacterMoveSpeed: (speed) =>
      commitUiPatch({ viewportCharacterMoveSpeed: normalizeViewportCharacterMoveSpeed(speed) }),
    setViewportPilotInertia: (amount) =>
      commitUiPatch({ viewportPilotInertia: normalizeCameraPilotFeel(amount, DEFAULT_CAMERA_PILOT_INERTIA) }),
    setViewportPilotLookSmoothing: (amount) =>
      commitUiPatch({
        viewportPilotLookSmoothing: normalizeCameraPilotFeel(amount, DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING),
      }),
    setViewportPilotBankStrength: (amount) =>
      commitUiPatch({
        viewportPilotBankStrength: normalizeCameraPilotFeel(amount, DEFAULT_CAMERA_PILOT_BANK_STRENGTH),
      }),
    resetViewportNavigation: () =>
      commitUiPatch({
        viewportRotateSensitivity: DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
        viewportZoomSensitivity: DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
        viewportMoveSpeed: DEFAULT_VIEWPORT_MOVE_SPEED,
        viewportCharacterMoveSpeed: DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
        viewportPilotInertia: DEFAULT_CAMERA_PILOT_INERTIA,
        viewportPilotLookSmoothing: DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING,
        viewportPilotBankStrength: DEFAULT_CAMERA_PILOT_BANK_STRENGTH,
      }),
    ensureNativeSceneBinding: () => {
      const existing = get().project.nativeScene?.projectId;
      if (existing) return existing;

      const projectId = crypto.randomUUID();
      commitMutation((state) => withProjectPatch(state, { nativeScene: { engine: "blender", projectId } }), {
        trackUndo: false,
      });
      return projectId;
    },
    prepareBlenderSync: (sync) =>
      set((state) => {
        const currentState = state as DirectorRuntimeState;
        if (
          currentState.pendingBlenderSyncs.some(
            (pending) => pending.sceneEpoch === sync.sceneEpoch && pending.revision === sync.revision,
          )
        ) {
          return currentState;
        }
        return {
          ...currentState,
          pendingBlenderSyncs: [...currentState.pendingBlenderSyncs, sync],
        };
      }),
    syncBlenderScene: (snapshot) =>
      commitMutation(
        (state) => {
          const boundNativeScene = state.project.nativeScene;
          if (!snapshot.projectId || !boundNativeScene || snapshot.projectId !== boundNativeScene.projectId) {
            return state;
          }

          const nativeScene: DirectorNativeScene = {
            ...boundNativeScene,
            sceneEpoch: snapshot.sceneEpoch,
            revision: snapshot.revision,
            contentRevision: snapshot.contentRevision,
          };
          const nativeRevisionChanged =
            boundNativeScene.sceneEpoch !== nativeScene.sceneEpoch ||
            boundNativeScene.revision !== nativeScene.revision ||
            boundNativeScene.contentRevision !== nativeScene.contentRevision;
          const previousSceneWasSynchronized =
            boundNativeScene.sceneEpoch === snapshot.sceneEpoch && boundNativeScene.revision !== undefined;
          const sceneEpochChanged =
            boundNativeScene.sceneEpoch !== undefined && boundNativeScene.sceneEpoch !== snapshot.sceneEpoch;
          const pendingSync = state.pendingBlenderSyncs.find(
            (pending) => pending.sceneEpoch === snapshot.sceneEpoch && pending.revision === snapshot.revision,
          );
          const pendingBlenderSyncs = sceneEpochChanged
            ? []
            : state.pendingBlenderSyncs.filter(
                (pending) => pending.sceneEpoch !== snapshot.sceneEpoch || pending.revision > snapshot.revision,
              );
          const adoptBlenderState = previousSceneWasSynchronized && pendingSync?.origin !== "director-projection";

          const roots = blenderRootObjects(snapshot);
          const rootsByDirectorId = new Map(roots.map((root) => [blenderDirectorObjectId(root), root]));
          const assetsById = new Map(state.project.assets.map((asset) => [asset.id, asset]));
          const missingNativeObjects = state.project.objects.filter(
            (object) =>
              object.nativeSource?.engine === "blender" &&
              object.nativeSource.provisioned !== false &&
              !rootsByDirectorId.has(object.id),
          );
          const reprovisionIds = new Set(
            missingNativeObjects.flatMap((object) => {
              const asset = object.assetRefId ? assetsById.get(object.assetRefId) : undefined;
              return asset?.sourceType === "model" && asset.kind !== "panorama" ? [object.id] : [];
            }),
          );
          const removedIds = missingNativeObjects
            .filter((object) => !reprovisionIds.has(object.id))
            .map((object) => object.id);
          const removedIdSet = new Set(removedIds);
          const selectedObjectIds = state.selectedObjectIds.filter((id) => !removedIdSet.has(id));
          const selectedObjectId =
            state.selectedObjectId && removedIdSet.has(state.selectedObjectId)
              ? (selectedObjectIds[selectedObjectIds.length - 1] ?? null)
              : state.selectedObjectId;
          let nextState = removedIds.length ? deleteDirectorObjects(state, removedIds) : state;
          if (removedIds.length) {
            nextState = {
              ...nextState,
              selectedObjectId,
              selectedObjectIds,
              selectedCrowdId: state.selectedCrowdId,
            };
          }

          let changed = nativeRevisionChanged || removedIds.length > 0 || reprovisionIds.size > 0;
          const changedObjectIds: string[] = [];
          const objects = nextState.project.objects.map((object) =>
            reprovisionIds.has(object.id) && object.nativeSource?.engine === "blender"
              ? {
                  ...object,
                  nativeSource: { ...object.nativeSource, provisioned: false as const },
                }
              : object,
          );
          for (const root of roots) {
            const id = blenderDirectorObjectId(root);
            const index = objects.findIndex((object) => object.id === id);
            const existingObject = objects[index];
            const transform =
              existingObject && !adoptBlenderState ? existingObject.transform : blenderDirectorTransform(root);
            const localBoundsM: DirectorObject["localBoundsM"] =
              root.localBounds === undefined
                ? existingObject?.localBoundsM
                : root.localBounds === null
                  ? undefined
                  : { min: [...root.localBounds.min], max: [...root.localBounds.max] };
            if (!existingObject) {
              objects.push({
                id,
                name: root.name,
                kind: "prop",
                visible: root.visible,
                locked: false,
                placementMode: "floating",
                localBoundsM,
                transform,
                nativeSource: { engine: "blender", objectId: root.id, provisioned: true },
              });
              changed = true;
              changedObjectIds.push(id);
              continue;
            }

            const sourceChanged =
              existingObject.nativeSource?.engine !== "blender" ||
              existingObject.nativeSource.objectId !== root.id ||
              existingObject.nativeSource.provisioned !== true;
            if (
              !sourceChanged &&
              existingObject.name === root.name &&
              existingObject.visible === root.visible &&
              sameLocalBounds(existingObject.localBoundsM, localBoundsM) &&
              sameTransform(existingObject.transform, transform)
            ) {
              continue;
            }
            objects[index] = {
              ...existingObject,
              name: root.name,
              visible: root.visible,
              placementMode: "floating",
              localBoundsM,
              transform,
              nativeSource: { engine: "blender", objectId: root.id, provisioned: true },
            };
            changed = true;
            changedObjectIds.push(id);
          }
          let cameras = reconcileBlenderCameras(nextState.project.cameras, snapshot.cameras);
          const objectsWithRigs = reconcileCameraRigObjects(objects, cameras);
          if (objectsWithRigs !== objects) changed = true;
          if (!changed) return state;
          const nextObjects = objectsWithRigs;

          const recordsNativeHistory =
            previousSceneWasSynchronized &&
            pendingSync === undefined &&
            (boundNativeScene.contentRevision !== snapshot.contentRevision ||
              changedObjectIds.length > 0 ||
              removedIds.length > 0 ||
              reprovisionIds.size > 0);
          const historyUndoStack = sceneEpochChanged
            ? state.historyUndoStack.filter((entry) => entry.domain === "director")
            : state.historyUndoStack;
          const historyRedoStack = sceneEpochChanged
            ? state.historyRedoStack.filter((entry) => entry.domain === "director")
            : state.historyRedoStack;
          if (changedObjectIds.length) {
            cameras = refreshCamerasFocusedOnObjects(cameras, nextObjects, changedObjectIds);
          }
          const lights = reconcileBlenderLights(nextState.project.lights ?? [], snapshot.lights);
          const activeNativeCamera = snapshot.cameras.find((camera) => camera.active);
          const activeCameraId = activeNativeCamera
            ? (cameras.find((camera) => camera.nativeSource?.objectId === activeNativeCamera.id)?.id ?? null)
            : nextState.project.activeCameraId &&
                cameras.some((camera) => camera.id === nextState.project.activeCameraId)
              ? nextState.project.activeCameraId
              : (cameras[0]?.id ?? null);
          const synchronizedState = withProjectPatch(nextState, {
            nativeScene,
            objects: nextObjects,
            cameras,
            lights,
            activeCameraId,
          });
          return {
            ...synchronizedState,
            pendingBlenderSyncs,
            historyUndoStack: recordsNativeHistory
              ? trimHistoryStack([
                  ...historyUndoStack,
                  { domain: "blender", projectId: snapshot.projectId, sceneEpoch: snapshot.sceneEpoch },
                ])
              : historyUndoStack,
            historyRedoStack: recordsNativeHistory ? [] : historyRedoStack,
            redoStack: recordsNativeHistory ? [] : synchronizedState.redoStack,
          };
        },
        { trackUndo: false },
      ),
    // Kept as a compatibility command for host and agent callers. The visible
    // Stage intentionally remains the director workspace.
    setViewMode: (_mode) => commitUiPatch({ viewMode: "director" }),
    selectObject: (id) =>
      commitUiMutation((state) => {
        const selectedObject = state.project.objects.find((item) => item.id === id);
        const activeCameraId =
          selectedObject?.kind === "camera" && selectedObject.linkedCameraId
            ? selectedObject.linkedCameraId
            : state.project.activeCameraId;

        return {
          ...state,
          selectedObjectId: id,
          selectedObjectIds: id ? [id] : [],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project:
            activeCameraId === state.project.activeCameraId ? state.project : { ...state.project, activeCameraId },
        };
      }),
    selectObjects: (ids) =>
      commitUiMutation((state) => {
        const selectedObjectIds = Array.from(new Set(ids)).filter((id) =>
          state.project.objects.some((object) => object.id === id),
        );
        const selectedObjectId = selectedObjectIds[selectedObjectIds.length - 1] ?? null;
        const selectedObject = selectedObjectId
          ? state.project.objects.find((object) => object.id === selectedObjectId)
          : undefined;
        const activeCameraId =
          selectedObject?.kind === "camera" && selectedObject.linkedCameraId
            ? selectedObject.linkedCameraId
            : state.project.activeCameraId;

        return {
          ...state,
          selectedObjectId,
          selectedObjectIds,
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project:
            activeCameraId === state.project.activeCameraId ? state.project : { ...state.project, activeCameraId },
        };
      }),
    selectCrowd: (crowdId) =>
      commitUiMutation((state) => {
        if (!crowdId) {
          return {
            ...state,
            selectedCrowdId: null,
            selectedObjectId: null,
            selectedObjectIds: [],
          };
        }

        const crowdMemberIds = getCrowdMemberIds(state.project.objects, crowdId);
        if (!crowdMemberIds.length) return state;

        return {
          ...state,
          selectedCrowdId: crowdId,
          selectedObjectId: crowdMemberIds[crowdMemberIds.length - 1] ?? null,
          selectedObjectIds: crowdMemberIds,
          directorInspectorMode: "auto",
        };
      }),
    toggleObjectSelection: (id) =>
      commitUiMutation((state) => {
        const selectedObject = state.project.objects.find((item) => item.id === id);
        if (!selectedObject) return state;

        const selectedObjectIds = getOrderedSelectedObjectIds(state);
        const nextSelectedObjectIds = selectedObjectIds.includes(id)
          ? selectedObjectIds.filter((itemId) => itemId !== id)
          : [...selectedObjectIds, id];
        return withProjectPatch(
          state,
          {
            activeCameraId:
              selectedObject.kind === "camera" && selectedObject.linkedCameraId
                ? selectedObject.linkedCameraId
                : state.project.activeCameraId,
          },
          selectedObjectsPatch(nextSelectedObjectIds),
        );
      }),
    openSceneInspector: () =>
      commitUiMutation((state) => ({
        ...state,
        directorInspectorMode: "scene",
        selectedObjectId: null,
        selectedObjectIds: [],
        selectedCrowdId: null,
      })),
    updateScene: (patch) => {
      if (canUseAuthoringPath()) {
        // Patches with keys set_scene cannot express (or non-nullable keys set
        // to undefined) compile to null and keep the local merge.
        const action = compileDirectorSceneUpdateAction(patch);
        if (action) {
          dispatchUiAuthoring([action], "ui-scene-update");
          return;
        }
      }
      commitMutation((state) =>
        withProjectPatch(state, {
          scene: { ...state.project.scene, ...patch },
        }),
      );
    },
    updateWorldSettings: (patch) => {
      if (canUseAuthoringPath()) {
        // Every UI world-settings field (including weather.evolution) compiles
        // to set_world_settings; empty patches keep the local path because the
        // authoring action rejects them.
        const action = compileDirectorWorldSettingsAction(patch);
        if (action) {
          dispatchUiAuthoring([action], "ui-world-settings");
          return;
        }
      }
      commitMutation((state) =>
        withWorldPatch(state, (world) => ({
          ...world,
          settings: {
            ...world.settings,
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.seed === undefined ? {} : { seed: patch.seed }),
            wind: { ...world.settings.wind, ...patch.wind },
            timeOfDay: { ...world.settings.timeOfDay, ...patch.timeOfDay },
            weather: { ...world.settings.weather, ...patch.weather },
          },
        })),
      );
    },
    upsertWorldEffect: (effect) => {
      // Anchors bound to a missing object would throw in authoring; the local
      // replace has always tolerated them.
      const anchorObjectExists =
        !effect.anchor.objectId || get().project.objects.some((object) => object.id === effect.anchor.objectId);
      if (canUseAuthoringPath() && anchorObjectExists) {
        const mode = resolveWorldUpsertMode(get().project.world?.effects ?? [], effect, DIRECTOR_WORLD_MAX_EFFECTS);
        if (mode === "capacity") return false;
        if (mode === "update") {
          return dispatchUiAuthoring(
            [
              {
                action: "update_world_effect",
                effect_id: effect.id,
                patch: {
                  ...worldEffectAuthoringFields(effect),
                  color_tint: effect.colorTint ?? null,
                  visible: effect.visible,
                  locked: effect.locked,
                },
              },
            ],
            `ui-world-effect:${effect.id}`,
          );
        }
        if (mode === "add") {
          return dispatchUiAuthoring(
            [
              {
                action: "add_world_effect",
                id: effect.id,
                ...worldEffectAuthoringFields(effect),
                ...(effect.colorTint ? { color_tint: effect.colorTint } : {}),
              },
            ],
            `ui-world-effect:${effect.id}`,
          );
        }
      }
      let applied = false;
      commitMutation((state) =>
        withWorldPatch(state, (world) => {
          const result = upsertWorldCollectionEntry(world.effects, effect, DIRECTOR_WORLD_MAX_EFFECTS);
          applied = result.applied;
          return result.applied ? { ...world, effects: result.entries } : world;
        }),
      );
      return applied;
    },
    removeWorldEffects: (effectIds) => {
      if (canUseAuthoringPath()) {
        // remove_world_effects rejects locked or unknown ids, so the shared
        // contract now skips locked entries instead of silently deleting them.
        const requested = new Set(effectIds);
        const removable = (get().project.world?.effects ?? [])
          .filter((effect) => requested.has(effect.id) && !effect.locked)
          .map((effect) => effect.id);
        if (!removable.length) return 0;
        return dispatchUiAuthoring(
          [{ action: "remove_world_effects", effect_ids: removable }],
          `ui-world-effects-remove:${removable.slice().sort().join(",")}`,
        )
          ? removable.length
          : 0;
      }
      let removed = 0;
      commitMutation((state) => {
        const world = state.project.world;
        if (!world) return state;
        const ids = new Set(effectIds);
        const remaining = world.effects.filter((effect) => !ids.has(effect.id));
        removed = world.effects.length - remaining.length;
        if (removed === 0) return state;
        return withProjectPatch(state, { world: { ...world, effects: remaining } });
      });
      return removed;
    },
    upsertWorldWaterBody: (body) => {
      if (canUseAuthoringPath()) {
        const mode = resolveWorldUpsertMode(
          get().project.world?.waterBodies ?? [],
          body,
          DIRECTOR_WORLD_MAX_WATER_BODIES,
        );
        if (mode === "capacity") return false;
        if (mode === "update") {
          return dispatchUiAuthoring(
            [
              {
                action: "update_world_water_body",
                body_id: body.id,
                patch: {
                  ...worldWaterBodyAuthoringFields(body),
                  river: body.river ? worldRiverAuthoringFields(body.river) : null,
                  visible: body.visible,
                  locked: body.locked,
                },
              },
            ],
            `ui-world-water:${body.id}`,
          );
        }
        if (mode === "add") {
          return dispatchUiAuthoring(
            [
              {
                action: "add_world_water_body",
                id: body.id,
                ...worldWaterBodyAuthoringFields(body),
                ...(body.river ? { river: worldRiverAuthoringFields(body.river) } : {}),
              },
            ],
            `ui-world-water:${body.id}`,
          );
        }
      }
      let applied = false;
      commitMutation((state) =>
        withWorldPatch(state, (world) => {
          const result = upsertWorldCollectionEntry(world.waterBodies, body, DIRECTOR_WORLD_MAX_WATER_BODIES);
          applied = result.applied;
          return result.applied ? { ...world, waterBodies: result.entries } : world;
        }),
      );
      return applied;
    },
    removeWorldWaterBodies: (bodyIds) => {
      if (canUseAuthoringPath()) {
        const requested = new Set(bodyIds);
        const removable = (get().project.world?.waterBodies ?? [])
          .filter((body) => requested.has(body.id) && !body.locked)
          .map((body) => body.id);
        if (!removable.length) return 0;
        return dispatchUiAuthoring(
          [{ action: "remove_world_water_bodies", body_ids: removable }],
          `ui-world-water-remove:${removable.slice().sort().join(",")}`,
        )
          ? removable.length
          : 0;
      }
      let removed = 0;
      commitMutation((state) => {
        const world = state.project.world;
        if (!world) return state;
        const ids = new Set(bodyIds);
        const remaining = world.waterBodies.filter((body) => !ids.has(body.id));
        removed = world.waterBodies.length - remaining.length;
        if (removed === 0) return state;
        return withProjectPatch(state, { world: { ...world, waterBodies: remaining } });
      });
      return removed;
    },
    upsertWorldWildlifeGroup: (group) => {
      // add_world_wildlife_group injects a default flight band for aerial
      // species; an intentionally band-less aerial group keeps the local path.
      const needsAltitudeFallback = !group.altitude && (group.species === "birds" || group.species === "butterflies");
      const assetExists = !group.assetId || get().project.assets.some((asset) => asset.id === group.assetId);
      if (canUseAuthoringPath() && !needsAltitudeFallback && assetExists) {
        const mode = resolveWorldUpsertMode(
          get().project.world?.wildlife ?? [],
          group,
          DIRECTOR_WORLD_MAX_WILDLIFE_GROUPS,
        );
        if (mode === "capacity") return false;
        if (mode === "update") {
          return dispatchUiAuthoring(
            [
              {
                action: "update_world_wildlife_group",
                group_id: group.id,
                patch: {
                  ...worldWildlifeAuthoringFields(group),
                  altitude: group.altitude ? { min_m: group.altitude.minM, max_m: group.altitude.maxM } : null,
                  asset_id: group.assetId ?? null,
                  visible: group.visible,
                  locked: group.locked,
                },
              },
            ],
            `ui-world-wildlife:${group.id}`,
          );
        }
        if (mode === "add") {
          return dispatchUiAuthoring(
            [
              {
                action: "add_world_wildlife_group",
                id: group.id,
                ...worldWildlifeAuthoringFields(group),
                ...(group.altitude ? { altitude: { min_m: group.altitude.minM, max_m: group.altitude.maxM } } : {}),
                ...(group.assetId ? { asset_id: group.assetId } : {}),
              },
            ],
            `ui-world-wildlife:${group.id}`,
          );
        }
      }
      let applied = false;
      commitMutation((state) =>
        withWorldPatch(state, (world) => {
          const result = upsertWorldCollectionEntry(world.wildlife, group, DIRECTOR_WORLD_MAX_WILDLIFE_GROUPS);
          applied = result.applied;
          return result.applied ? { ...world, wildlife: result.entries } : world;
        }),
      );
      return applied;
    },
    removeWorldWildlifeGroups: (groupIds) => {
      if (canUseAuthoringPath()) {
        const requested = new Set(groupIds);
        const removable = (get().project.world?.wildlife ?? [])
          .filter((group) => requested.has(group.id) && !group.locked)
          .map((group) => group.id);
        if (!removable.length) return 0;
        return dispatchUiAuthoring(
          [{ action: "remove_world_wildlife_groups", group_ids: removable }],
          `ui-world-wildlife-remove:${removable.slice().sort().join(",")}`,
        )
          ? removable.length
          : 0;
      }
      let removed = 0;
      commitMutation((state) => {
        const world = state.project.world;
        if (!world) return state;
        const ids = new Set(groupIds);
        const remaining = world.wildlife.filter((group) => !ids.has(group.id));
        removed = world.wildlife.length - remaining.length;
        if (removed === 0) return state;
        return withProjectPatch(state, { world: { ...world, wildlife: remaining } });
      });
      return removed;
    },
    upsertWorldRoad: (road) => {
      if (canUseAuthoringPath()) {
        const mode = resolveWorldUpsertMode(get().project.world?.roads ?? [], road, DIRECTOR_WORLD_MAX_ROADS);
        if (mode === "capacity") return false;
        if (mode === "update") {
          return dispatchUiAuthoring(
            [
              {
                action: "update_world_road",
                road_id: road.id,
                patch: { ...worldRoadAuthoringFields(road), visible: road.visible, locked: road.locked },
              },
            ],
            `ui-world-road:${road.id}`,
          );
        }
        if (mode === "add") {
          return dispatchUiAuthoring(
            [{ action: "add_world_road", id: road.id, ...worldRoadAuthoringFields(road) }],
            `ui-world-road:${road.id}`,
          );
        }
      }
      let applied = false;
      commitMutation((state) =>
        withWorldPatch(state, (world) => {
          // Pre-roads world blocks may lack the collection until reparsed.
          const result = upsertWorldCollectionEntry(world.roads ?? [], road, DIRECTOR_WORLD_MAX_ROADS);
          applied = result.applied;
          return result.applied ? { ...world, roads: result.entries } : world;
        }),
      );
      return applied;
    },
    removeWorldRoads: (roadIds) => {
      if (canUseAuthoringPath()) {
        const requested = new Set(roadIds);
        const removable = (get().project.world?.roads ?? [])
          .filter((road) => requested.has(road.id) && !road.locked)
          .map((road) => road.id);
        if (!removable.length) return 0;
        return dispatchUiAuthoring(
          [{ action: "remove_world_roads", road_ids: removable }],
          `ui-world-roads-remove:${removable.slice().sort().join(",")}`,
        )
          ? removable.length
          : 0;
      }
      let removed = 0;
      commitMutation((state) => {
        const world = state.project.world;
        if (!world?.roads?.length) return state;
        const ids = new Set(roadIds);
        const remaining = world.roads.filter((road) => !ids.has(road.id));
        removed = world.roads.length - remaining.length;
        if (removed === 0) return state;
        return withProjectPatch(state, { world: { ...world, roads: remaining } });
      });
      return removed;
    },
    updateStoryboard: (storyboard) => {
      if (canUseAuthoringPath()) {
        dispatchUiAuthoring([{ action: "set_storyboard", storyboard: cloneJsonValue(storyboard) }], "ui-storyboard");
        return;
      }
      commitMutation((state) => withProjectPatch(state, { storyboard: cloneJsonValue(storyboard) }));
    },
    removePanoramaAsset: () => {
      const panoramaAssetId = get().project.panoramaAssetId;
      if (!panoramaAssetId) return;
      if (canUseAuthoringPath()) {
        const project = get().project;
        const defaultCharacterAsset = getDefaultMixamoCharacterAssetRef();
        // applyAuthoredProject always runs migrateDirectorProject, which injects
        // the default Mixamo asset when characters still reference it but the
        // asset list omitted it. The local writer only removes the panorama
        // entry, so keep that path when migrate would widen the asset list.
        const migrateWouldRehydrateDefaultCharacter =
          !project.assets.some((asset) => asset.id === defaultCharacterAsset.id) &&
          project.objects.some((object) => {
            if (object.kind !== "character") return false;
            const assetRefId =
              object.assetRefId ?? inferLegacyLibraryCharacterAssetId(project, object) ?? defaultCharacterAsset.id;
            return assetRefId === defaultCharacterAsset.id;
          });
        if (!migrateWouldRehydrateDefaultCharacter) {
          dispatchUiAuthoring(
            [{ action: "remove_assets", asset_ids: [panoramaAssetId] }],
            `ui-panorama-remove:${panoramaAssetId}`,
            "删除失败",
          );
          return;
        }
      }
      commitMutation((state) => {
        const currentPanoramaId = state.project.panoramaAssetId;
        if (!currentPanoramaId) return state;

        return withProjectPatch(state, {
          assets: state.project.assets.filter((item) => item.id !== currentPanoramaId),
          panoramaAssetId: null,
        });
      });
    },
    removeImportedAsset: (assetId) => {
      const currentState = get();
      const currentAsset = currentState.project.assets.find((item) => item.id === assetId);
      if (!currentAsset || currentAsset.sourceType !== "model") return;
      if (canUseAuthoringPath()) {
        const removedObjectIds = new Set(
          currentState.project.objects.filter((item) => item.assetRefId === assetId).map((item) => item.id),
        );
        // remove_assets cascade also deletes children of removed objects,
        // clears look targets, camera follow/path bindings, and material
        // texture references; the local writer leaves those untouched, so any
        // such reference keeps the whole call on the legacy path.
        const divergesFromLocalWriter =
          currentState.project.objects.some(
            (item) =>
              !removedObjectIds.has(item.id) &&
              ((item.parentObjectId && removedObjectIds.has(item.parentObjectId)) ||
                (item.lookTargetObjectId && removedObjectIds.has(item.lookTargetObjectId)) ||
                Object.values(item.material?.textures ?? {}).some((textureAssetId) => textureAssetId === assetId)),
          ) ||
          currentState.project.cameras.some(
            (camera) =>
              (camera.action?.mode === "follow" &&
                camera.action.follow?.targetObjectId &&
                removedObjectIds.has(camera.action.follow.targetObjectId)) ||
              (camera.action?.mode === "path" &&
                camera.action.path?.targetObjectId &&
                removedObjectIds.has(camera.action.path.targetObjectId)),
          );
        if (!divergesFromLocalWriter) {
          removePersistedLocalModelAsset(assetId);
          const applied = dispatchUiAuthoring(
            [{ action: "remove_assets", asset_ids: [assetId], cascade: true }],
            `ui-asset-remove:${assetId}`,
            "删除失败",
          );
          if (applied) {
            // Crowd deselection is UI-only state; the shared applyAuthoredProject
            // landing point already prunes removed object ids from the selection.
            commitUiMutation((state) => (state.selectedCrowdId ? { ...state, selectedCrowdId: null } : state));
          }
          return;
        }
      }
      commitMutation((state) => {
        const targetAsset = state.project.assets.find((item) => item.id === assetId);
        if (!targetAsset || targetAsset.sourceType !== "model") return state;

        removePersistedLocalModelAsset(assetId);

        const removedObjectIds = new Set(
          state.project.objects.filter((item) => item.assetRefId === assetId).map((item) => item.id),
        );
        const nextObjects = state.project.objects.filter((item) => item.assetRefId !== assetId);
        const nextCameras = state.project.cameras.map((camera) =>
          camera.targetObjectId && removedObjectIds.has(camera.targetObjectId)
            ? {
                ...camera,
                targetMode: "manual" as const,
                targetObjectId: null,
              }
            : camera,
        );
        const selectedObjectIds = state.selectedObjectIds.filter((id) => !removedObjectIds.has(id));
        const selectedObjectId =
          state.selectedObjectId && removedObjectIds.has(state.selectedObjectId)
            ? (selectedObjectIds[selectedObjectIds.length - 1] ?? null)
            : state.selectedObjectId;

        return {
          ...state,
          selectedObjectId,
          selectedObjectIds,
          selectedCrowdId: null,
          project: withReconciledProduction({
            ...state.project,
            assets: state.project.assets.filter((item) => item.id !== assetId),
            objects: nextObjects,
            cameras: nextCameras,
            scene: {
              ...state.project.scene,
              annotations: (state.project.scene.annotations ?? []).filter(
                (annotation) => !annotation.anchor.objectId || !removedObjectIds.has(annotation.anchor.objectId),
              ),
              measurements: (state.project.scene.measurements ?? []).filter(
                (measurement) =>
                  (!measurement.start.objectId || !removedObjectIds.has(measurement.start.objectId)) &&
                  (!measurement.end.objectId || !removedObjectIds.has(measurement.end.objectId)),
              ),
            },
          }),
        };
      });
    },
    updateObjectTransform: (id, patch) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      if (
        currentObject &&
        isObjectTransformEffectivelyLocked(currentState.project.scene, currentState.project.objects, currentObject)
      ) {
        return;
      }
      const hasObjectFocusedCamera = currentState.project.cameras.some(
        (camera) => camera.targetMode === "object" && camera.targetObjectId === id,
      );
      // Gizmo / slider undo batches keep the lightweight mutator so RAF previews
      // stay cheap; pointer-up still lands in one undo entry. Outside a batch,
      // non-camera objects share the Agent authoring path (except object-focused
      // cameras, which still need the UI refresh helper until authoring owns it).
      const useAuthoringPath =
        currentState.undoBatchDepth === 0 &&
        currentObject &&
        currentObject.kind !== "camera" &&
        !currentObject.isCompositeParent &&
        !hasObjectFocusedCamera;
      if (useAuthoringPath) {
        const receipt = dispatchDirectorAuthoringActions(
          [
            {
              action: "update_object",
              object_id: id,
              patch: { transform: structuredClone(patch) },
              force: true,
            },
          ],
          { idempotencyKey: `ui-transform:${id}` },
        );
        if (!receipt.ok) {
          notifyDirector({
            severity: "error",
            title: "变换失败",
            detail: receipt.error,
          });
        }
        return;
      }
      commitMutation((state) => {
        const object = state.project.objects.find((item) => item.id === id);
        if (!object || isObjectTransformEffectivelyLocked(state.project.scene, state.project.objects, object)) {
          return state;
        }
        if (object.isCompositeParent) {
          const composite = applyCompositeParentTransformPatch(state.project.objects, id, patch);
          return applyObjectTransformMutation(state, composite);
        }
        const nextTransform = {
          position: patch.position ?? object.transform.position,
          rotation: patch.rotation ?? object.transform.rotation,
          scale: patch.scale ?? object.transform.scale,
        };
        const nextObject = { ...object, transform: nextTransform };

        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            transform: {
              position: patch.position ?? item.transform.position,
              rotation: patch.rotation ?? item.transform.rotation,
              scale: patch.scale ?? item.transform.scale,
            },
          })),
          cameras:
            object.kind === "camera" && object.linkedCameraId
              ? state.project.cameras.map((camera) =>
                  camera.id === object.linkedCameraId ? { ...camera, transform: nextTransform } : camera,
                )
              : refreshCamerasFocusedOnObject(state.project.cameras, nextObject),
        });
      });
    },
    updateObjectTransforms: (updates) => {
      const currentProject = get().project;
      const applicable = updates.filter((update) => {
        const object = currentProject.objects.find((item) => item.id === update.id);
        return object && !isObjectTransformEffectivelyLocked(currentProject.scene, currentProject.objects, object);
      });
      // Cameras sync their linked rig, composite parents propagate to children,
      // and object-focused cameras need the UI refresh helper, so any of those
      // in the batch keeps the whole call on the local mutator (rule: keep
      // current exceptions until authoring owns the refresh).
      const needsUiOnlyHandling = applicable.some((update) => {
        const object = currentProject.objects.find((item) => item.id === update.id)!;
        return (
          object.kind === "camera" ||
          object.isCompositeParent ||
          currentProject.cameras.some((camera) => camera.targetMode === "object" && camera.targetObjectId === update.id)
        );
      });
      if (canUseAuthoringPath() && applicable.length && !needsUiOnlyHandling) {
        dispatchUiAuthoring(
          applicable.map((update) => ({
            action: "update_object" as const,
            object_id: update.id,
            patch: { transform: structuredClone(update.transform) },
            force: true,
          })),
          `ui-transforms:${applicable
            .map((update) => update.id)
            .sort()
            .join(",")}`,
          "变换失败",
        );
        return;
      }
      commitMutation((state) => {
        const updatesById = new Map(updates.map((update) => [update.id, update.transform]));
        if (!updatesById.size) return state;

        let objects = state.project.objects;
        const changedObjectIds = new Set<string>();
        updatesById.forEach((transform, id) => {
          const currentObject = objects.find((item) => item.id === id);
          if (!currentObject || isObjectTransformEffectivelyLocked(state.project.scene, objects, currentObject)) {
            return;
          }
          if (currentObject.isCompositeParent) {
            const composite = applyCompositeParentTransformPatch(objects, id, transform);
            objects = composite.objects;
            composite.changedObjectIds.forEach((changedId) => changedObjectIds.add(changedId));
            return;
          }

          objects = updateObjectById(objects, id, (item) => ({ ...item, transform }));
          changedObjectIds.add(id);
        });
        if (!changedObjectIds.size) return state;

        const linkedCameraTransforms = new Map(
          objects
            .filter(
              (object) => changedObjectIds.has(object.id) && object.kind === "camera" && Boolean(object.linkedCameraId),
            )
            .map((object) => [object.linkedCameraId as string, object.transform]),
        );
        const cameras = state.project.cameras.map((camera) => {
          const transform = linkedCameraTransforms.get(camera.id);
          return transform ? { ...camera, transform } : camera;
        });

        return withProjectPatch(state, {
          objects,
          cameras: refreshCamerasFocusedOnObjects(cameras, objects, [...changedObjectIds]),
        });
      });
    },
    batchUpdateObjects: (ids, patch) => {
      const requested = new Set(ids);
      const currentState = get();
      const editableObjects = currentState.project.objects.filter(
        (object) =>
          requested.has(object.id) &&
          object.kind !== "camera" &&
          !isObjectTransformEffectivelyLocked(currentState.project.scene, currentState.project.objects, object),
      );
      const editableIds = editableObjects.map((object) => object.id);
      if (!editableIds.length) return 0;
      const editable = new Set(editableIds);
      const normalizedLayer = patch.layer === null ? undefined : patch.layer?.trim() || undefined;
      const patchHasKeys =
        patch.visible !== undefined ||
        patch.locked !== undefined ||
        patch.layer !== undefined ||
        patch.color !== undefined ||
        patch.material !== undefined ||
        Boolean(patch.transform && Object.keys(patch.transform).length);
      // Composite parents propagate transforms to children and object-focused
      // cameras need the UI refresh helper; both keep the local mutator.
      const needsUiOnlyTransformHandling =
        Boolean(patch.transform) &&
        editableObjects.some(
          (object) =>
            object.isCompositeParent ||
            currentState.project.cameras.some(
              (camera) => camera.targetMode === "object" && camera.targetObjectId === object.id,
            ),
        );
      // update_object rejects color/material/layer patches on provisioned
      // native Blender objects; those edits keep the historical local merge.
      const nativeRestricted =
        (patch.color !== undefined || patch.material !== undefined || patch.layer !== undefined) &&
        editableObjects.some(
          (object) => object.nativeSource?.engine === "blender" && object.nativeSource.provisioned !== false,
        );
      if (canUseAuthoringPath() && patchHasKeys && !needsUiOnlyTransformHandling && !nativeRestricted) {
        const applied = dispatchUiAuthoring(
          editableObjects.map((object) => ({
            action: "update_object" as const,
            object_id: object.id,
            patch: {
              ...(patch.visible === undefined ? {} : { visible: patch.visible }),
              ...(patch.locked === undefined ? {} : { locked: patch.locked }),
              ...(patch.layer === undefined ? {} : { layer: normalizedLayer ?? null }),
              ...(patch.color === undefined ? {} : { color: patch.color }),
              ...(patch.material === undefined
                ? {}
                : {
                    // Pre-merge per object so the shared engine's material
                    // replacement matches the store's partial-merge semantics.
                    material:
                      patch.material === null
                        ? null
                        : {
                            ...object.material,
                            ...patch.material,
                            ...(patch.material.textures
                              ? { textures: { ...object.material?.textures, ...patch.material.textures } }
                              : {}),
                          },
                  }),
              ...(patch.transform ? { transform: structuredClone(patch.transform) } : {}),
            },
            force: true,
          })),
          `ui-batch:${editableIds.slice().sort().join(",")}`,
        );
        return applied ? editableIds.length : 0;
      }
      commitMutation((state) => {
        let objects = state.project.objects;
        const transformedIds = new Set<string>();
        if (patch.transform) {
          for (const objectId of editableIds) {
            const object = objects.find((entry) => entry.id === objectId);
            if (!object) continue;
            if (object.isCompositeParent) {
              const result = applyCompositeParentTransformPatch(objects, objectId, patch.transform);
              objects = result.objects;
              result.changedObjectIds.forEach((id) => transformedIds.add(id));
            } else {
              objects = updateObjectById(objects, objectId, (entry) => ({
                ...entry,
                transform: {
                  position: patch.transform?.position ?? entry.transform.position,
                  rotation: patch.transform?.rotation ?? entry.transform.rotation,
                  scale: patch.transform?.scale ?? entry.transform.scale,
                },
              }));
              transformedIds.add(objectId);
            }
          }
        }
        objects = objects.map((object) => {
          if (!editable.has(object.id)) return object;
          const nextMaterial =
            patch.material === undefined
              ? object.material
              : patch.material === null
                ? undefined
                : {
                    ...object.material,
                    ...patch.material,
                    ...(patch.material.textures
                      ? { textures: { ...object.material?.textures, ...patch.material.textures } }
                      : {}),
                  };
          return {
            ...object,
            ...(patch.visible === undefined ? {} : { visible: patch.visible }),
            ...(patch.locked === undefined ? {} : { locked: patch.locked }),
            ...(patch.layer === undefined ? {} : { layer: normalizedLayer }),
            ...(patch.color === undefined ? {} : { color: patch.color }),
            ...(patch.material === undefined ? {} : { material: nextMaterial }),
          };
        });
        const changedIds = new Set([...editableIds, ...transformedIds]);
        const nextScene =
          patch.layer !== undefined && normalizedLayer
            ? {
                ...state.project.scene,
                objectLayers: state.project.scene.objectLayers?.some((layer) => layer.id === normalizedLayer)
                  ? state.project.scene.objectLayers
                  : [
                      ...(state.project.scene.objectLayers ?? [
                        { id: "default", visible: true, locked: false } as DirectorObjectLayer,
                      ]),
                      { id: normalizedLayer, visible: true, locked: false },
                    ],
              }
            : state.project.scene;
        return withProjectPatch(state, {
          objects,
          scene: nextScene,
          cameras: refreshCamerasFocusedOnObjects(state.project.cameras, objects, [...changedIds]),
        });
      });
      return editableIds.length;
    },
    resetObjectTransforms: (ids, components = ["position", "rotation", "scale"]) => {
      const selected = new Set(components);
      return get().batchUpdateObjects(ids, {
        transform: {
          ...(selected.has("position") ? { position: [0, get().project.scene.groundHeight, 0] } : {}),
          ...(selected.has("rotation") ? { rotation: [0, 0, 0] } : {}),
          ...(selected.has("scale") ? { scale: [1, 1, 1] } : {}),
        },
      });
    },
    alignObjects: (ids, axis, mode) => {
      const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      const requested = new Set(ids);
      const currentState = get();
      const objects = currentState.project.objects.filter(
        (object) =>
          requested.has(object.id) &&
          object.kind !== "camera" &&
          !isDirectorObjectEffectivelyLocked(currentState.project.scene, object) &&
          !object.isCompositeParent,
      );
      if (objects.length < 2) return 0;
      // Object-focused cameras still need the UI refresh helper after moves.
      const hasFocusedCamera = objects.some((object) =>
        currentState.project.cameras.some(
          (camera) => camera.targetMode === "object" && camera.targetObjectId === object.id,
        ),
      );
      if (canUseAuthoringPath() && !hasFocusedCamera) {
        const alignedIds = objects.map((object) => object.id);
        return dispatchUiAuthoring(
          [{ action: "align_objects", object_ids: alignedIds, axis, mode, force: true }],
          `ui-align:${alignedIds.slice().sort().join(",")}:${axis}`,
        )
          ? objects.length
          : 0;
      }
      const coordinates = objects.map((object) => object.transform.position[axisIndex]);
      const coordinate =
        mode === "min"
          ? Math.min(...coordinates)
          : mode === "max"
            ? Math.max(...coordinates)
            : coordinates.reduce((sum, value) => sum + value, 0) / coordinates.length;
      const targetIds = new Set(objects.map((object) => object.id));
      commitMutation((state) => {
        const nextObjects = state.project.objects.map((object) =>
          targetIds.has(object.id)
            ? {
                ...object,
                transform: {
                  ...object.transform,
                  position: replaceTupleAxis(object.transform.position, axisIndex, coordinate),
                },
              }
            : object,
        );
        return withProjectPatch(state, {
          objects: nextObjects,
          cameras: refreshCamerasFocusedOnObjects(state.project.cameras, nextObjects, [...targetIds]),
        });
      });
      return objects.length;
    },
    distributeObjects: (ids, axis) => {
      const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      const requested = new Set(ids);
      const currentState = get();
      const objects = currentState.project.objects
        .filter(
          (object) =>
            requested.has(object.id) &&
            object.kind !== "camera" &&
            !isDirectorObjectEffectivelyLocked(currentState.project.scene, object) &&
            !object.isCompositeParent,
        )
        .sort(
          (left, right) =>
            left.transform.position[axisIndex] - right.transform.position[axisIndex] || left.id.localeCompare(right.id),
        );
      if (objects.length < 3) return 0;
      const hasFocusedCamera = objects.some((object) =>
        currentState.project.cameras.some(
          (camera) => camera.targetMode === "object" && camera.targetObjectId === object.id,
        ),
      );
      if (canUseAuthoringPath() && !hasFocusedCamera) {
        const distributedIds = objects.map((object) => object.id);
        return dispatchUiAuthoring(
          [{ action: "distribute_objects", object_ids: distributedIds, axis, force: true }],
          `ui-distribute:${distributedIds.slice().sort().join(",")}:${axis}`,
        )
          ? objects.length
          : 0;
      }
      const first = objects[0]!.transform.position[axisIndex];
      const last = objects.at(-1)!.transform.position[axisIndex];
      const step = (last - first) / (objects.length - 1);
      const coordinateById = new Map(objects.map((object, index) => [object.id, first + step * index]));
      commitMutation((state) => {
        const nextObjects = state.project.objects.map((object) => {
          const coordinate = coordinateById.get(object.id);
          return coordinate === undefined
            ? object
            : {
                ...object,
                transform: {
                  ...object.transform,
                  position: replaceTupleAxis(object.transform.position, axisIndex, coordinate),
                },
              };
        });
        return withProjectPatch(state, {
          objects: nextObjects,
          cameras: refreshCamerasFocusedOnObjects(state.project.cameras, nextObjects, [...coordinateById.keys()]),
        });
      });
      return objects.length;
    },
    isolateObjects: (ids) => {
      const selected = new Set(ids);
      const currentState = get();
      const changedObjects = currentState.project.objects.filter(
        (object) => object.kind !== "camera" && object.visible !== selected.has(object.id),
      ).length;
      const hiddenLayers = (currentState.project.scene.objectLayers ?? []).filter((layer) => !layer.visible);
      const changed = changedObjects + hiddenLayers.length;
      if (!selected.size || !changed) return 0;
      const existingSelectedIds = ids.filter((id) => currentState.project.objects.some((object) => object.id === id));
      if (canUseAuthoringPath() && existingSelectedIds.length) {
        // Authoring isolate only toggles object visibility; the layer reveal
        // the panel performs rides in the same atomic batch (one undo entry).
        const applied = dispatchUiAuthoring(
          [
            { action: "isolate_objects" as const, object_ids: existingSelectedIds, force: true },
            ...hiddenLayers.map((layer) => ({
              action: "set_object_layer_state" as const,
              layer_id: layer.id,
              visible: true,
            })),
          ],
          `ui-isolate:${existingSelectedIds.slice().sort().join(",")}`,
        );
        return applied ? changed : 0;
      }
      commitMutation((state) =>
        withProjectPatch(state, {
          objects: state.project.objects.map((object) =>
            object.kind === "camera" ? object : { ...object, visible: selected.has(object.id) },
          ),
          scene: {
            ...state.project.scene,
            objectLayers: state.project.scene.objectLayers?.map((layer) => ({ ...layer, visible: true })),
          },
        }),
      );
      return changed;
    },
    showAllObjects: () => {
      const currentState = get();
      const changed =
        currentState.project.objects.filter((object) => !object.visible).length +
        (currentState.project.scene.objectLayers ?? []).filter((layer) => !layer.visible).length;
      if (!changed) return 0;
      // show_all_objects skips camera rigs; a hidden camera object keeps the
      // historical local reveal that includes it.
      const hasHiddenCameraObject = currentState.project.objects.some(
        (object) => object.kind === "camera" && !object.visible,
      );
      if (canUseAuthoringPath() && !hasHiddenCameraObject) {
        return dispatchUiAuthoring([{ action: "show_all_objects" }], "ui-show-all") ? changed : 0;
      }
      commitMutation((state) =>
        withProjectPatch(state, {
          objects: state.project.objects.map((object) => (object.visible ? object : { ...object, visible: true })),
          scene: {
            ...state.project.scene,
            objectLayers: state.project.scene.objectLayers?.map((layer) => ({ ...layer, visible: true })),
          },
        }),
      );
      return changed;
    },
    setObjectPivot: (id, pivot) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      if (canUseAuthoringPath()) {
        if (
          !currentObject ||
          currentObject.kind === "camera" ||
          isObjectTransformEffectivelyLocked(currentState.project.scene, currentState.project.objects, currentObject)
        ) {
          return false;
        }
        // Round exactly like the local path so the shared engine stores the
        // same tuple, and skip no-op writes to keep the undo stack clean.
        const normalized = pivot ? roundTransformTuple(pivot) : undefined;
        if (JSON.stringify(currentObject.pivot ?? null) === JSON.stringify(normalized ?? null)) return false;
        return dispatchUiAuthoring(
          [{ action: "set_object_pivot", object_id: id, pivot: normalized ?? null, force: true }],
          `ui-pivot:${id}`,
        );
      }
      let changed = false;
      commitMutation((state) => {
        const object = state.project.objects.find((item) => item.id === id);
        if (
          !object ||
          object.kind === "camera" ||
          isObjectTransformEffectivelyLocked(state.project.scene, state.project.objects, object)
        ) {
          return state;
        }
        const normalized = pivot ? roundTransformTuple(pivot) : undefined;
        if (JSON.stringify(object.pivot ?? null) === JSON.stringify(normalized ?? null)) return state;
        changed = true;
        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => ({ ...item, pivot: normalized })),
        });
      });
      return changed;
    },
    toggleObjectInteraction: (id) => {
      const state = get();
      const object = state.project.objects.find((item) => item.id === id);
      if (
        !object?.interaction ||
        isObjectTransformEffectivelyLocked(state.project.scene, state.project.objects, object)
      ) {
        return false;
      }
      const target = sameTransform(object.transform, object.interaction.openTransform)
        ? object.interaction.closedTransform
        : object.interaction.openTransform;
      get().updateObjectTransform(id, structuredClone(target));
      return true;
    },
    addSceneAnnotation: (input) => {
      const text = input.text.trim();
      const currentState = get();
      if (!text) return null;
      if (
        input.anchor.objectId &&
        !currentState.project.objects.some((object) => object.id === input.anchor.objectId)
      ) {
        return null;
      }
      if (canUseAuthoringPath()) {
        const annotationId = getNextSequentialId(
          (currentState.project.scene.annotations ?? []).map((annotation) => annotation.id),
          "annotation_",
        );
        const applied = dispatchUiAuthoring(
          [
            {
              action: "add_annotation",
              annotation: {
                id: annotationId,
                text,
                anchor: structuredClone(input.anchor),
                color: input.color?.trim() || "#f6c453",
                visible: true,
                createdAt: new Date().toISOString(),
              },
            },
          ],
          `ui-annotation:${annotationId}`,
        );
        return applied ? annotationId : null;
      }
      let annotationId: string | null = null;
      commitMutation((state) => {
        annotationId = getNextSequentialId(
          (state.project.scene.annotations ?? []).map((annotation) => annotation.id),
          "annotation_",
        );
        const annotation: DirectorSceneAnnotation = {
          id: annotationId,
          text,
          anchor: structuredClone(input.anchor),
          color: input.color?.trim() || "#f6c453",
          visible: true,
          createdAt: new Date().toISOString(),
        };
        return withProjectPatch(state, {
          scene: {
            ...state.project.scene,
            annotations: [...(state.project.scene.annotations ?? []), annotation],
          },
        });
      });
      return annotationId;
    },
    updateSceneAnnotation: (id, patch) => {
      const currentState = get();
      if (!currentState.project.scene.annotations?.some((annotation) => annotation.id === id)) return false;
      if (
        patch.anchor?.objectId &&
        !currentState.project.objects.some((object) => object.id === patch.anchor?.objectId)
      ) {
        return false;
      }
      if (canUseAuthoringPath() && Object.keys(patch).length) {
        return dispatchUiAuthoring(
          [{ action: "update_annotation", annotation_id: id, patch: structuredClone(patch) }],
          `ui-annotation:${id}`,
        );
      }
      let changed = false;
      commitMutation((state) => {
        if (!state.project.scene.annotations?.some((annotation) => annotation.id === id)) return state;
        changed = true;
        return withProjectPatch(state, {
          scene: {
            ...state.project.scene,
            annotations: state.project.scene.annotations.map((annotation) =>
              annotation.id === id ? { ...annotation, ...structuredClone(patch) } : annotation,
            ),
          },
        });
      });
      return changed;
    },
    removeSceneAnnotation: (id) => {
      const currentState = get();
      if (!(currentState.project.scene.annotations ?? []).some((annotation) => annotation.id === id)) return false;
      if (canUseAuthoringPath()) {
        return dispatchUiAuthoring(
          [{ action: "remove_annotations", annotation_ids: [id] }],
          `ui-annotation-remove:${id}`,
        );
      }
      let removed = false;
      commitMutation((state) => {
        const annotations = state.project.scene.annotations ?? [];
        if (!annotations.some((annotation) => annotation.id === id)) return state;
        removed = true;
        return withProjectPatch(state, {
          scene: { ...state.project.scene, annotations: annotations.filter((annotation) => annotation.id !== id) },
        });
      });
      return removed;
    },
    addSceneMeasurement: (input) => {
      const currentState = get();
      const anchorIds = [input.start.objectId, input.end.objectId].filter(Boolean);
      if (anchorIds.some((id) => !currentState.project.objects.some((object) => object.id === id))) return null;
      if (canUseAuthoringPath()) {
        const measurementId = getNextSequentialId(
          (currentState.project.scene.measurements ?? []).map((measurement) => measurement.id),
          "measurement_",
        );
        const applied = dispatchUiAuthoring(
          [
            {
              action: "add_measurement",
              measurement: {
                id: measurementId,
                ...(input.label?.trim() ? { label: input.label.trim() } : {}),
                start: structuredClone(input.start),
                end: structuredClone(input.end),
                color: input.color?.trim() || "#6ed6ff",
                visible: true,
                createdAt: new Date().toISOString(),
              },
            },
          ],
          `ui-measurement:${measurementId}`,
        );
        return applied ? measurementId : null;
      }
      let measurementId: string | null = null;
      commitMutation((state) => {
        measurementId = getNextSequentialId(
          (state.project.scene.measurements ?? []).map((measurement) => measurement.id),
          "measurement_",
        );
        const measurement: DirectorSceneMeasurement = {
          id: measurementId,
          ...(input.label?.trim() ? { label: input.label.trim() } : {}),
          start: structuredClone(input.start),
          end: structuredClone(input.end),
          color: input.color?.trim() || "#6ed6ff",
          visible: true,
          createdAt: new Date().toISOString(),
        };
        return withProjectPatch(state, {
          scene: {
            ...state.project.scene,
            measurements: [...(state.project.scene.measurements ?? []), measurement],
          },
        });
      });
      return measurementId;
    },
    updateSceneMeasurement: (id, patch) => {
      const currentState = get();
      if (!currentState.project.scene.measurements?.some((measurement) => measurement.id === id)) return false;
      const anchorIds = [patch.start?.objectId, patch.end?.objectId].filter(Boolean);
      if (anchorIds.some((objectId) => !currentState.project.objects.some((object) => object.id === objectId))) {
        return false;
      }
      if (canUseAuthoringPath() && Object.keys(patch).length) {
        return dispatchUiAuthoring(
          [{ action: "update_measurement", measurement_id: id, patch: structuredClone(patch) }],
          `ui-measurement:${id}`,
        );
      }
      let changed = false;
      commitMutation((state) => {
        if (!state.project.scene.measurements?.some((measurement) => measurement.id === id)) return state;
        changed = true;
        return withProjectPatch(state, {
          scene: {
            ...state.project.scene,
            measurements: state.project.scene.measurements.map((measurement) =>
              measurement.id === id ? { ...measurement, ...structuredClone(patch) } : measurement,
            ),
          },
        });
      });
      return changed;
    },
    removeSceneMeasurement: (id) => {
      const currentState = get();
      if (!(currentState.project.scene.measurements ?? []).some((measurement) => measurement.id === id)) return false;
      if (canUseAuthoringPath()) {
        return dispatchUiAuthoring(
          [{ action: "remove_measurements", measurement_ids: [id] }],
          `ui-measurement-remove:${id}`,
        );
      }
      let removed = false;
      commitMutation((state) => {
        const measurements = state.project.scene.measurements ?? [];
        if (!measurements.some((measurement) => measurement.id === id)) return state;
        removed = true;
        return withProjectPatch(state, {
          scene: {
            ...state.project.scene,
            measurements: measurements.filter((measurement) => measurement.id !== id),
          },
        });
      });
      return removed;
    },
    addTimelineAudioClip: (input) => {
      const mediaId = input.mediaId.trim();
      const name = input.name.trim().slice(0, 240);
      if (!mediaId || !name || !Number.isFinite(input.durationFrames) || input.durationFrames < 1) return null;
      if (canUseAuthoringPath()) {
        const action: DirectorAuthoringAction = {
          action: "add_timeline_audio_clip",
          name,
          media_id: mediaId,
          duration_frames: clamp(Math.round(input.durationFrames), 1, MAX_TIMELINE_AUDIO_FRAME),
          ...(input.sourceUrl?.trim() ? { source_url: input.sourceUrl.trim() } : {}),
          ...(input.startFrame !== undefined && Number.isFinite(input.startFrame)
            ? { start_frame: clamp(Math.round(input.startFrame), 0, MAX_TIMELINE_AUDIO_FRAME) }
            : {}),
          ...(input.sourceDurationSec !== undefined &&
          Number.isFinite(input.sourceDurationSec) &&
          input.sourceDurationSec > 0
            ? { source_duration_sec: Math.min(input.sourceDurationSec, 86_400) }
            : {}),
        };
        const receipt = dispatchDirectorAuthoringActions([action], {
          idempotencyKey: `ui-timeline-audio-add:${mediaId}:${name}:${action.duration_frames}`,
        });
        if (!receipt.ok) {
          notifyDirector({
            severity: "error",
            title: "时间线音频更新失败",
            detail: receipt.error,
          });
          return null;
        }
        return receipt.created.timeline_audio_clip_ids[0] ?? null;
      }
      let clipId: string | null = null;
      commitMutation((state) => {
        const timeline = state.project.scene.timeline ?? createDefaultDirectorFrameTimeline();
        return withTimelineAudioTracksPatch(state, (tracks) => {
          let trackIndex = tracks.findIndex((track) => track.clips.length < MAX_TIMELINE_AUDIO_CLIPS_PER_TRACK);
          let nextTracks = tracks;
          if (trackIndex < 0) {
            if (tracks.length >= MAX_TIMELINE_AUDIO_TRACKS) return null;
            nextTracks = [
              ...tracks,
              {
                id: getNextSequentialId(
                  tracks.map((track) => track.id),
                  "audio_track_",
                ),
                name: `音频轨 ${tracks.length + 1}`,
                muted: false,
                clips: [],
              },
            ];
            trackIndex = nextTracks.length - 1;
          }
          clipId = getNextSequentialId(
            nextTracks.flatMap((track) => track.clips.map((clip) => clip.id)),
            "audio_clip_",
          );
          const startFrame = clamp(
            Math.round(
              input.startFrame !== undefined && Number.isFinite(input.startFrame)
                ? input.startFrame
                : Math.max(timeline.currentFrame, 0),
            ),
            0,
            MAX_TIMELINE_AUDIO_FRAME,
          );
          const clip: DirectorTimelineAudioClip = {
            id: clipId,
            name,
            mediaId,
            ...(input.sourceUrl?.trim() ? { sourceUrl: input.sourceUrl.trim() } : {}),
            startFrame,
            durationFrames: clamp(Math.round(input.durationFrames), 1, MAX_TIMELINE_AUDIO_FRAME),
            inSec: 0,
            ...(input.sourceDurationSec !== undefined &&
            Number.isFinite(input.sourceDurationSec) &&
            input.sourceDurationSec > 0
              ? { sourceDurationSec: Math.min(input.sourceDurationSec, 86_400) }
              : {}),
            volume: 1,
            fadeInSec: 0,
            fadeOutSec: 0,
            muted: false,
          };
          return nextTracks.map((track, index) =>
            index === trackIndex ? { ...track, clips: [...track.clips, clip] } : track,
          );
        });
      });
      return clipId;
    },
    updateTimelineAudioClip: (clipId, patch) => {
      if (canUseAuthoringPath()) {
        const authorPatch = {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.sourceUrl !== undefined ? { sourceUrl: patch.sourceUrl } : {}),
          ...(patch.startFrame !== undefined ? { startFrame: patch.startFrame } : {}),
          ...(patch.durationFrames !== undefined ? { durationFrames: patch.durationFrames } : {}),
          ...(patch.inSec !== undefined ? { inSec: patch.inSec } : {}),
          ...(patch.sourceDurationSec !== undefined ? { sourceDurationSec: patch.sourceDurationSec } : {}),
          ...(patch.volume !== undefined ? { volume: patch.volume } : {}),
          ...(patch.fadeInSec !== undefined ? { fadeInSec: patch.fadeInSec } : {}),
          ...(patch.fadeOutSec !== undefined ? { fadeOutSec: patch.fadeOutSec } : {}),
          ...(patch.muted !== undefined ? { muted: patch.muted } : {}),
        };
        if (Object.keys(authorPatch).length === 0) return false;
        return dispatchUiAuthoring(
          [{ action: "update_timeline_audio_clip", clip_id: clipId, patch: authorPatch }],
          `ui-timeline-audio-update:${clipId}`,
          "时间线音频更新失败",
        );
      }
      let changed = false;
      commitMutation((state) =>
        withTimelineAudioTracksPatch(state, (tracks) => {
          if (!tracks.some((track) => track.clips.some((clip) => clip.id === clipId))) return null;
          changed = true;
          return tracks.map((track) =>
            track.clips.some((clip) => clip.id === clipId)
              ? {
                  ...track,
                  clips: track.clips.map((clip) =>
                    clip.id === clipId ? sanitizeTimelineAudioClipPatch(clip, patch) : clip,
                  ),
                }
              : track,
          );
        }),
      );
      return changed;
    },
    moveTimelineAudioClip: (clipId, startFrame) => {
      if (!Number.isFinite(startFrame)) return false;
      const nextStart = clamp(Math.round(startFrame), 0, MAX_TIMELINE_AUDIO_FRAME);
      if (canUseAuthoringPath()) {
        const existing = (get().project.scene.timeline?.audioTracks ?? [])
          .flatMap((track) => track.clips)
          .find((clip) => clip.id === clipId);
        if (!existing || existing.startFrame === nextStart) return false;
        return dispatchUiAuthoring(
          [{ action: "update_timeline_audio_clip", clip_id: clipId, patch: { startFrame: nextStart } }],
          `ui-timeline-audio-move:${clipId}:${nextStart}`,
          "时间线音频更新失败",
        );
      }
      let changed = false;
      commitMutation((state) =>
        withTimelineAudioTracksPatch(state, (tracks) => {
          if (
            !tracks.some((track) => track.clips.some((clip) => clip.id === clipId && clip.startFrame !== nextStart))
          ) {
            return null;
          }
          changed = true;
          return tracks.map((track) =>
            track.clips.some((clip) => clip.id === clipId)
              ? {
                  ...track,
                  clips: track.clips.map((clip) => (clip.id === clipId ? { ...clip, startFrame: nextStart } : clip)),
                }
              : track,
          );
        }),
      );
      return changed;
    },
    removeTimelineAudioClip: (clipId) => {
      if (canUseAuthoringPath()) {
        const exists = (get().project.scene.timeline?.audioTracks ?? []).some((track) =>
          track.clips.some((clip) => clip.id === clipId),
        );
        if (!exists) return false;
        return dispatchUiAuthoring(
          [{ action: "remove_timeline_audio_clips", clip_ids: [clipId] }],
          `ui-timeline-audio-remove:${clipId}`,
          "时间线音频更新失败",
        );
      }
      let removed = false;
      commitMutation((state) =>
        withTimelineAudioTracksPatch(state, (tracks) => {
          if (!tracks.some((track) => track.clips.some((clip) => clip.id === clipId))) return null;
          removed = true;
          return tracks.map((track) => ({
            ...track,
            clips: track.clips.filter((clip) => clip.id !== clipId),
          }));
        }),
      );
      return removed;
    },
    setTimelineAudioTrackMuted: (trackId, muted) => {
      if (canUseAuthoringPath()) {
        const track = (get().project.scene.timeline?.audioTracks ?? []).find((candidate) => candidate.id === trackId);
        if (!track || track.muted === muted) return false;
        return dispatchUiAuthoring(
          [{ action: "set_timeline_audio_track_muted", track_id: trackId, muted }],
          `ui-timeline-audio-mute:${trackId}:${muted}`,
          "时间线音频更新失败",
        );
      }
      let changed = false;
      commitMutation((state) =>
        withTimelineAudioTracksPatch(state, (tracks) => {
          const track = tracks.find((candidate) => candidate.id === trackId);
          if (!track || track.muted === muted) return null;
          changed = true;
          return tracks.map((candidate) => (candidate.id === trackId ? { ...candidate, muted } : candidate));
        }),
      );
      return changed;
    },
    setObjectLayerState: (id, patch) => {
      const layerId = id.trim();
      if (!layerId || (!Object.hasOwn(patch, "visible") && !Object.hasOwn(patch, "locked"))) return false;
      if (canUseAuthoringPath()) {
        const layers = get().project.scene.objectLayers ?? [];
        const existing = layers.find((layer) => layer.id === layerId);
        const nextVisible = patch.visible ?? existing?.visible ?? true;
        const nextLocked = patch.locked ?? existing?.locked ?? false;
        if (existing && existing.visible === nextVisible && existing.locked === nextLocked) return false;
        return dispatchUiAuthoring(
          [
            {
              action: "set_object_layer_state",
              layer_id: layerId,
              ...(patch.visible === undefined ? {} : { visible: patch.visible }),
              ...(patch.locked === undefined ? {} : { locked: patch.locked }),
            },
          ],
          `ui-layer-state:${layerId}`,
        );
      }
      let changed = false;
      commitMutation((state) => {
        const layers = state.project.scene.objectLayers ?? [];
        const existing = layers.find((layer) => layer.id === layerId);
        const next: DirectorObjectLayer = {
          id: layerId,
          visible: patch.visible ?? existing?.visible ?? true,
          locked: patch.locked ?? existing?.locked ?? false,
        };
        if (existing && existing.visible === next.visible && existing.locked === next.locked) return state;
        changed = true;
        return withProjectPatch(state, {
          scene: {
            ...state.project.scene,
            objectLayers: existing ? layers.map((layer) => (layer.id === layerId ? next : layer)) : [...layers, next],
          },
        });
      });
      return changed;
    },
    moveObjectLayer: (id, direction) => {
      if (canUseAuthoringPath()) {
        const layers = get().project.scene.objectLayers ?? [];
        const index = layers.findIndex((layer) => layer.id === id);
        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (index < 0 || targetIndex < 0 || targetIndex >= layers.length) return false;
        // The adjacent swap maps onto reorder_object_layer: moving up inserts
        // before the previous layer; moving down inserts before the layer two
        // slots ahead (or at the end when none exists).
        const beforeLayerId = direction === "up" ? layers[targetIndex]!.id : (layers[index + 2]?.id ?? null);
        return dispatchUiAuthoring(
          [{ action: "reorder_object_layer", layer_id: id, before_layer_id: beforeLayerId }],
          `ui-layer-move:${id}`,
        );
      }
      let changed = false;
      commitMutation((state) => {
        const layers = [...(state.project.scene.objectLayers ?? [])];
        const index = layers.findIndex((layer) => layer.id === id);
        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (index < 0 || targetIndex < 0 || targetIndex >= layers.length) return state;
        [layers[index], layers[targetIndex]] = [layers[targetIndex]!, layers[index]!];
        changed = true;
        return withProjectPatch(state, { scene: { ...state.project.scene, objectLayers: layers } });
      });
      return changed;
    },
    dropObjectToGround: (id) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      if (
        !currentObject ||
        currentObject.kind === "camera" ||
        isObjectTransformEffectivelyLocked(currentState.project.scene, currentState.project.objects, currentObject)
      ) {
        return;
      }
      // Composite parents propagate the drop to children, object-focused
      // cameras need the UI refresh helper, and provisioned native Blender
      // objects reject placement_mode patches; those keep the local mutator.
      const hasObjectFocusedCamera = currentState.project.cameras.some(
        (camera) => camera.targetMode === "object" && camera.targetObjectId === id,
      );
      const isProvisionedNative =
        currentObject.nativeSource?.engine === "blender" && currentObject.nativeSource.provisioned !== false;
      if (
        canUseAuthoringPath() &&
        !currentObject.isCompositeParent &&
        !hasObjectFocusedCamera &&
        !isProvisionedNative
      ) {
        dispatchUiAuthoring(
          [
            {
              action: "update_object",
              object_id: id,
              patch: {
                transform: {
                  position: [
                    currentObject.transform.position[0],
                    currentState.project.scene.groundHeight,
                    currentObject.transform.position[2],
                  ],
                },
                placement_mode: "grounded",
              },
              force: true,
            },
          ],
          `ui-drop:${id}`,
          "变换失败",
        );
        return;
      }
      commitMutation((state) => {
        const currentObject = state.project.objects.find((item) => item.id === id);
        if (
          !currentObject ||
          currentObject.kind === "camera" ||
          isObjectTransformEffectivelyLocked(state.project.scene, state.project.objects, currentObject)
        ) {
          return state;
        }

        const groundedPosition: [number, number, number] = [
          currentObject.transform.position[0],
          state.project.scene.groundHeight,
          currentObject.transform.position[2],
        ];

        if (currentObject.isCompositeParent) {
          const composite = applyCompositeParentTransformPatch(state.project.objects, id, {
            position: groundedPosition,
          });
          return applyObjectTransformMutation(state, composite, (objects) =>
            updateObjectById(objects, id, (item) => ({ ...item, placementMode: "grounded" })),
          );
        }

        const nextObject = {
          ...currentObject,
          placementMode: "grounded" as const,
          transform: {
            ...currentObject.transform,
            position: groundedPosition,
          },
        };

        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, () => nextObject),
          cameras: refreshCamerasFocusedOnObject(state.project.cameras, nextObject),
        });
      });
    },
    setObjectAnimation: (id, animation) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      // The transform-lock no-op stays in the UI: authoring set_animation does
      // not consult object locks, so dispatching a locked target would weaken
      // the existing guard.
      if (
        !currentObject ||
        isObjectTransformEffectivelyLocked(currentState.project.scene, currentState.project.objects, currentObject)
      ) {
        return;
      }
      if (canUseAuthoringPath()) {
        dispatchUiAuthoring(
          [
            {
              action: "set_animation",
              target_type: "object",
              target_id: id,
              animation: animation ? structuredClone(animation) : null,
            },
          ],
          `ui-object-animation:${id}`,
        );
        return;
      }
      commitMutation((state) => {
        const object = state.project.objects.find((item) => item.id === id);
        if (!object || isObjectTransformEffectivelyLocked(state.project.scene, state.project.objects, object)) {
          return state;
        }
        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            ...(animation ? { animation } : { animation: undefined }),
          })),
        });
      });
    },
    updateCrowdTransform: (crowdId, patch) => {
      const currentState = get();
      const currentMembers = currentState.project.objects.filter((object) => object.crowdId === crowdId);
      if (currentMembers.some((object) => isDirectorObjectEffectivelyLocked(currentState.project.scene, object))) {
        return;
      }
      if (canUseAuthoringPath()) {
        const actions = compileCrowdTransformActions(crowdId, patch);
        if (actions) {
          dispatchUiAuthoring(actions, `ui-crowd-transform:${crowdId}`, "变换失败");
          return;
        }
      }
      commitMutation((state) => {
        const members = state.project.objects.filter((object) => object.crowdId === crowdId);
        if (members.some((object) => isDirectorObjectEffectivelyLocked(state.project.scene, object))) return state;
        const nextTransformState = applyCrowdTransformPatch(state.project.objects, crowdId, patch);
        return applyObjectTransformMutation(state, nextTransformState);
      });
    },
    dropCrowdToGround: (crowdId) => {
      const currentState = get();
      const currentMembers = currentState.project.objects.filter((object) => object.crowdId === crowdId);
      if (currentMembers.some((object) => isDirectorObjectEffectivelyLocked(currentState.project.scene, object))) {
        return;
      }
      const currentAnchor = getCrowdAnchorTransform(currentState.project.objects, crowdId);
      if (canUseAuthoringPath() && currentAnchor) {
        const actions = compileCrowdTransformActions(
          crowdId,
          {
            position: [currentAnchor.position[0], currentState.project.scene.groundHeight, currentAnchor.position[2]],
          },
          { grounded: true },
        );
        if (actions) {
          dispatchUiAuthoring(actions, `ui-crowd-drop:${crowdId}`, "变换失败");
          return;
        }
      }
      commitMutation((state) => {
        const members = state.project.objects.filter((object) => object.crowdId === crowdId);
        if (members.some((object) => isDirectorObjectEffectivelyLocked(state.project.scene, object))) return state;
        const anchor = getCrowdAnchorTransform(state.project.objects, crowdId);
        if (!anchor) return state;

        const nextTransformState = applyCrowdTransformPatch(state.project.objects, crowdId, {
          position: [anchor.position[0], state.project.scene.groundHeight, anchor.position[2]],
        });
        return applyObjectTransformMutation(state, nextTransformState, (objects, changedIdSet) =>
          objects.map((item) => (changedIdSet.has(item.id) ? { ...item, placementMode: "grounded" as const } : item)),
        );
      });
    },
    updateObjectName: (id, name) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      // Camera rigs rename through update_camera (which syncs the rig object);
      // authoring rejects renaming characters without a bound asset, and a
      // rename must not drift a snapshot camera's explicit fov, so those cases
      // keep the local mutator.
      const linkedCamera =
        currentObject?.kind === "camera" && currentObject.linkedCameraId
          ? currentState.project.cameras.find((camera) => camera.id === currentObject.linkedCameraId)
          : undefined;
      if (canUseAuthoringPath() && currentObject) {
        if (linkedCamera && isCameraFovFocalStable(linkedCamera)) {
          dispatchUiAuthoring(
            [{ action: "update_camera", camera_id: linkedCamera.id, patch: { name } }],
            `ui-camera:${linkedCamera.id}`,
          );
          return;
        }
        if (currentObject.kind !== "camera" && (currentObject.kind !== "character" || currentObject.assetRefId)) {
          dispatchUiAuthoring(
            [{ action: "update_object", object_id: id, patch: { name }, force: true }],
            `ui-name:${id}`,
          );
          return;
        }
      }
      commitMutation((state) => {
        const object = state.project.objects.find((item) => item.id === id);
        const linkedCameraId = object?.kind === "camera" ? object.linkedCameraId : null;
        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => ({ ...item, name })),
          cameras: linkedCameraId
            ? state.project.cameras.map((camera) => (camera.id === linkedCameraId ? { ...camera, name } : camera))
            : state.project.cameras,
        });
      });
    },
    updateObjectReferenceBindings: (id, bindings) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      // update_camera has no reference_bindings field, so camera rigs (which
      // mirror bindings onto the linked camera) keep the local mutator.
      if (
        canUseAuthoringPath() &&
        currentObject &&
        currentObject.kind !== "camera" &&
        !(currentObject.nativeSource?.engine === "blender" && currentObject.nativeSource.provisioned !== false)
      ) {
        dispatchUiAuthoring(
          [
            {
              action: "update_object",
              object_id: id,
              patch: { reference_bindings: structuredClone(bindings) },
              force: true,
            },
          ],
          `ui-bindings:${id}`,
        );
        return;
      }
      commitMutation((state) => {
        const object = state.project.objects.find((item) => item.id === id);
        const linkedCameraId = object?.kind === "camera" ? object.linkedCameraId : null;
        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => ({ ...item, referenceBindings: bindings })),
          cameras: linkedCameraId
            ? state.project.cameras.map((camera) =>
                camera.id === linkedCameraId ? { ...camera, referenceBindings: bindings } : camera,
              )
            : state.project.cameras,
        });
      });
    },
    updateCrowdLabel: (crowdId, label) => {
      const members = resolveTargetCharacters({ crowdId });
      // The wire contract trims crowd_label and rejects empty labels, so
      // mid-typing whitespace drafts keep the local writer verbatim.
      const wireExpressible = label === label.trim() && label.length > 0 && label.length <= 240;
      if (canUseAuthoringPath() && members.length && wireExpressible) {
        dispatchUiAuthoring(
          members.map((item) => ({
            action: "update_object" as const,
            object_id: item.id,
            patch: { crowd_label: label },
            force: true,
          })),
          `ui-crowd-label:${crowdId}`,
        );
        return;
      }
      commitMutation((state) =>
        mapProjectObjects(state, (item) =>
          item.kind === "character" && item.crowdId === crowdId ? { ...item, crowdLabel: label } : item,
        ),
      );
    },
    createCompositeObject: (ids, label = "组合对象") => {
      const normalizedLabel = label.trim() || "组合对象";
      const currentState = get();
      if (canUseAuthoringPath()) {
        const childIdSet = new Set(ids);
        const children = currentState.project.objects.filter(
          (item) =>
            childIdSet.has(item.id) &&
            item.kind !== "camera" &&
            !item.isCompositeParent &&
            !isDirectorObjectEffectivelyLocked(currentState.project.scene, item),
        );
        if (!children.length) return null;
        const compositeId = getNextCompositeParentId(currentState.project.objects);
        const applied = dispatchUiAuthoring(
          [
            {
              action: "group_objects",
              group_id: compositeId,
              name: normalizedLabel,
              object_ids: children.map((child) => child.id),
            },
          ],
          `ui-group:${compositeId}`,
        );
        if (!applied) return null;
        // Selection is UI-only state; apply it after the authored commit.
        commitUiMutation((state) => ({ ...state, ...selectedObjectsPatch([compositeId]) }));
        return compositeId;
      }
      let parentObjectId: string | null = null;

      commitMutation((state) => {
        const childIdSet = new Set(ids);
        const children = state.project.objects.filter(
          (item) =>
            childIdSet.has(item.id) &&
            item.kind !== "camera" &&
            !item.isCompositeParent &&
            !isDirectorObjectEffectivelyLocked(state.project.scene, item),
        );
        if (!children.length) return state;

        const compositeId = getNextCompositeParentId(state.project.objects);
        parentObjectId = compositeId;
        const position = children.reduce<[number, number, number]>(
          (sum, child): [number, number, number] => [
            sum[0] + child.transform.position[0],
            sum[1] + child.transform.position[1],
            sum[2] + child.transform.position[2],
          ],
          [0, 0, 0] as [number, number, number],
        );
        const count = children.length;
        const parent: DirectorObject = {
          id: compositeId,
          name: normalizedLabel,
          kind: "prop",
          visible: true,
          locked: false,
          isCompositeParent: true,
          transform: createTransform(
            roundTransformTuple([position[0] / count, position[1] / count, position[2] / count]),
          ),
        };
        const childrenById = new Set(children.map((child) => child.id));

        return withObjectsPatch(
          state,
          [
            ...state.project.objects.map((item) =>
              childrenById.has(item.id) ? { ...item, parentObjectId: parent.id } : item,
            ),
            parent,
          ],
          {},
          selectedObjectsPatch([parent.id]),
        );
      });

      return parentObjectId;
    },
    addObjectsToComposite: (ids, parentObjectId) => {
      const currentState = get();
      if (canUseAuthoringPath()) {
        const parent = currentState.project.objects.find(
          (item) => item.id === parentObjectId && item.isCompositeParent,
        );
        if (
          !parent ||
          isObjectTransformEffectivelyLocked(currentState.project.scene, currentState.project.objects, parent)
        ) {
          return;
        }
        const childIds = new Set(ids);
        const children = currentState.project.objects.filter(
          (item) =>
            childIds.has(item.id) &&
            item.kind !== "camera" &&
            !item.isCompositeParent &&
            item.id !== parent.id &&
            !isDirectorObjectEffectivelyLocked(currentState.project.scene, item),
        );
        // Provisioned native Blender objects reject parent_id patches through
        // authoring; keep the whole call local so the composite stays complete.
        const hasNativeChild = children.some(
          (item) => item.nativeSource?.engine === "blender" && item.nativeSource.provisioned !== false,
        );
        if (children.length && !hasNativeChild) {
          dispatchUiAuthoring(
            children.map((item) => ({
              action: "update_object" as const,
              object_id: item.id,
              patch: { parent_id: parent.id },
              force: true,
            })),
            `ui-composite-add:${parent.id}`,
          );
          return;
        }
        if (!hasNativeChild) return;
      }
      commitMutation((state) => {
        const parent = state.project.objects.find((item) => item.id === parentObjectId && item.isCompositeParent);
        if (!parent || isObjectTransformEffectivelyLocked(state.project.scene, state.project.objects, parent)) {
          return state;
        }
        const childIds = new Set(ids);
        if (childIds.size === 0) return state;

        return mapProjectObjects(state, (item) =>
          childIds.has(item.id) &&
          item.kind !== "camera" &&
          !item.isCompositeParent &&
          item.id !== parent.id &&
          !isDirectorObjectEffectivelyLocked(state.project.scene, item)
            ? { ...item, parentObjectId: parent.id }
            : item,
        );
      });
    },
    removeObjectsFromComposite: (ids) => {
      const currentState = get();
      if (canUseAuthoringPath()) {
        const childIds = new Set(ids);
        const children = currentState.project.objects.filter(
          (item) =>
            childIds.has(item.id) &&
            item.parentObjectId &&
            !isDirectorObjectEffectivelyLocked(currentState.project.scene, item) &&
            !isObjectTransformEffectivelyLocked(
              currentState.project.scene,
              currentState.project.objects,
              currentState.project.objects.find((candidate) => candidate.id === item.parentObjectId) ?? item,
            ),
        );
        const hasNativeChild = children.some(
          (item) => item.nativeSource?.engine === "blender" && item.nativeSource.provisioned !== false,
        );
        if (children.length && !hasNativeChild) {
          dispatchUiAuthoring(
            children.map((item) => ({
              action: "update_object" as const,
              object_id: item.id,
              patch: { parent_id: null },
              force: true,
            })),
            `ui-composite-remove:${children
              .map((item) => item.id)
              .sort()
              .join(",")}`,
          );
          return;
        }
        if (!hasNativeChild) return;
      }
      commitMutation((state) => {
        const childIds = new Set(ids);
        if (childIds.size === 0) return state;
        return mapProjectObjects(state, (item) =>
          childIds.has(item.id) &&
          item.parentObjectId &&
          !isDirectorObjectEffectivelyLocked(state.project.scene, item) &&
          !isObjectTransformEffectivelyLocked(
            state.project.scene,
            state.project.objects,
            state.project.objects.find((candidate) => candidate.id === item.parentObjectId) ?? item,
          )
            ? { ...item, parentObjectId: undefined }
            : item,
        );
      });
    },
    // human-only: no authoring twin. Object lists are a UI selection helper
    // (objectListId/objectListLabel), not composite groups; group_objects would
    // be a wrong mapping.
    createObjectList: (ids, label) => {
      const normalizedLabel = label.trim();
      const objectIds = Array.from(new Set(ids));
      let objectListId: string | null = null;

      commitMutation((state) => {
        const matchingObjects = state.project.objects.filter((item) => objectIds.includes(item.id) && !item.crowdId);
        if (!normalizedLabel || !matchingObjects.length) return state;

        objectListId = getNextObjectListId(state.project.objects);

        return mapProjectObjects(state, (item) =>
          matchingObjects.some((matchingObject) => matchingObject.id === item.id)
            ? {
                ...item,
                objectListId: objectListId as string,
                objectListLabel: normalizedLabel,
                objectListDetached: undefined,
              }
            : item,
        );
      });

      return objectListId;
    },
    // human-only: no authoring twin (see createObjectList).
    addObjectsToObjectList: (ids, objectListId) =>
      commitMutation((state) => {
        const normalizedListId = objectListId.trim();
        const objectIds = new Set(ids);
        const target = state.project.objects.find((item) => item.objectListId === normalizedListId);
        if (!normalizedListId || !target || objectIds.size === 0) return state;

        const label = target.objectListLabel?.trim() || target.name;

        return mapProjectObjects(state, (item) =>
          objectIds.has(item.id) && !item.crowdId
            ? {
                ...item,
                objectListId: normalizedListId,
                objectListLabel: label,
                objectListDetached: undefined,
              }
            : item,
        );
      }),
    // human-only: no authoring twin (see createObjectList).
    removeObjectsFromObjectList: (ids) =>
      commitMutation((state) => {
        const objectIds = new Set(ids);
        if (objectIds.size === 0) return state;

        return mapProjectObjects(state, (item) =>
          objectIds.has(item.id)
            ? {
                ...item,
                objectListId: undefined,
                objectListLabel: undefined,
                objectListDetached: true,
              }
            : item,
        );
      }),
    // human-only: no authoring twin (see createObjectList).
    updateObjectListLabel: (objectListId, label) =>
      commitMutation((state) => {
        const normalizedListId = objectListId.trim();
        const normalizedLabel = label.trim();
        if (!normalizedListId || !normalizedLabel) return state;

        return mapProjectObjects(state, (item) =>
          item.objectListId === normalizedListId ? { ...item, objectListLabel: normalizedLabel } : item,
        );
      }),
    updateObjectColor: (id, color) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      // update_object rejects camera rigs and color patches on provisioned
      // native Blender objects; those keep the local mutator.
      if (
        canUseAuthoringPath() &&
        currentObject &&
        currentObject.kind !== "camera" &&
        !(currentObject.nativeSource?.engine === "blender" && currentObject.nativeSource.provisioned !== false)
      ) {
        dispatchUiAuthoring(
          [{ action: "update_object", object_id: id, patch: { color }, force: true }],
          `ui-color:${id}`,
        );
        return;
      }
      commitMutation((state) =>
        withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => ({ ...item, color })),
        }),
      );
    },
    setObjectVehicleProfile: (id, profile) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      // set_vehicle_profile/clear_vehicle_profile only accept unlocked prop and
      // scene objects; everything else keeps the historical local write.
      const vehicleAuthorable =
        currentObject &&
        (currentObject.kind === "prop" || currentObject.kind === "scene") &&
        !isDirectorObjectEffectivelyLocked(currentState.project.scene, currentObject);
      if (canUseAuthoringPath() && vehicleAuthorable) {
        if (profile === null) {
          // clear_vehicle_profile on a profile-less object is a no-op note;
          // skip it so the undo stack stays clean like the local path.
          if (currentObject.vehicle) {
            dispatchUiAuthoring([{ action: "clear_vehicle_profile", object_id: id }], `ui-vehicle-clear:${id}`);
          }
          return;
        }
        dispatchUiAuthoring(
          [
            {
              action: "set_vehicle_profile",
              object_id: id,
              // Full snake_case patch so the authoring merge reproduces the
              // exact profile the panel computed.
              profile: {
                kind: profile.kind,
                drivable: profile.drivable,
                mass_kg: profile.massKg,
                engine_force_n: profile.engineForceN,
                brake_force_n: profile.brakeForceN,
                max_speed_kph: profile.maxSpeedKph,
                reverse_speed_kph: profile.reverseSpeedKph,
                steer_max_deg: profile.steerMaxDeg,
                wheel_radius_m: profile.wheelRadiusM,
                suspension_rest_m: profile.suspensionRestM,
                suspension_stiffness: profile.suspensionStiffness,
                center_of_mass_y_offset_m: profile.centerOfMassYOffsetM,
                seat_offset: [...profile.seatOffset] as [number, number, number],
                exit_offsets: structuredClone(profile.exitOffsets),
                camera: {
                  chase_distance_m: profile.camera.chaseDistanceM,
                  chase_height_m: profile.camera.chaseHeightM,
                },
              },
            },
          ],
          `ui-vehicle:${id}`,
        );
        return;
      }
      commitMutation((state) =>
        withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => {
            if (profile === null) {
              if (!item.vehicle) return item;
              const next = { ...item };
              delete next.vehicle;
              return next;
            }
            return { ...item, vehicle: profile };
          }),
        }),
      );
    },
    updateObjectMaterial: (id, patch) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      // Composite parents ignore materials, camera rigs reject update_object,
      // and provisioned native Blender objects reject material patches.
      if (
        canUseAuthoringPath() &&
        currentObject &&
        currentObject.kind !== "camera" &&
        !currentObject.isCompositeParent &&
        !(currentObject.nativeSource?.engine === "blender" && currentObject.nativeSource.provisioned !== false)
      ) {
        dispatchUiAuthoring(
          [
            {
              action: "update_object",
              object_id: id,
              patch:
                patch === null
                  ? { material: null }
                  : {
                      ...(patch.baseColor ? { color: patch.baseColor } : {}),
                      // Pre-merge so the engine's material replacement matches
                      // the store's partial-merge semantics.
                      material: mergeDirectorPbrMaterial(currentObject.material, patch),
                    },
              force: true,
            },
          ],
          `ui-material:${id}`,
        );
        return;
      }
      commitMutation((state) =>
        withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => {
            if (item.isCompositeParent) return item;
            if (patch === null) {
              const next = { ...item };
              delete next.material;
              return next;
            }
            return {
              ...item,
              ...(patch.baseColor ? { color: patch.baseColor } : {}),
              material: mergeDirectorPbrMaterial(item.material, patch),
            };
          }),
        }),
      );
    },
    updateObjectMaterialTexture: (id, slot, assetId) => {
      const currentState = get();
      const currentObject = currentState.project.objects.find((item) => item.id === id);
      if (assetId) {
        const asset = currentState.project.assets.find((item) => item.id === assetId);
        if (!asset || asset.sourceType !== "image") return;
      }
      if (
        canUseAuthoringPath() &&
        currentObject &&
        currentObject.kind !== "camera" &&
        !currentObject.isCompositeParent &&
        !(currentObject.nativeSource?.engine === "blender" && currentObject.nativeSource.provisioned !== false)
      ) {
        const textures = { ...(currentObject.material?.textures ?? {}) };
        if (assetId) textures[slot] = assetId;
        else delete textures[slot];
        dispatchUiAuthoring(
          [
            {
              action: "update_object",
              object_id: id,
              patch: { material: mergeDirectorPbrMaterial(currentObject.material, { textures }) },
              force: true,
            },
          ],
          `ui-material-texture:${id}:${slot}`,
        );
        return;
      }
      commitMutation((state) => {
        if (assetId) {
          const asset = state.project.assets.find((item) => item.id === assetId);
          if (!asset || asset.sourceType !== "image") return state;
        }
        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => {
            if (item.isCompositeParent) return item;
            const textures = { ...(item.material?.textures ?? {}) };
            if (assetId) textures[slot] = assetId;
            else delete textures[slot];
            return {
              ...item,
              material: mergeDirectorPbrMaterial(item.material, { textures }),
            };
          }),
        });
      });
    },
    updateCrowdColor: (crowdId, color) => {
      const members = resolveTargetCharacters({ crowdId });
      // update_object rejects color patches on provisioned native Blender
      // objects; a crowd containing one keeps the local mutator wholesale.
      const hasProvisionedNativeMember = members.some(
        (item) => item.nativeSource?.engine === "blender" && item.nativeSource.provisioned !== false,
      );
      if (canUseAuthoringPath() && members.length && !hasProvisionedNativeMember) {
        dispatchUiAuthoring(
          members.map((item) => ({
            action: "update_object" as const,
            object_id: item.id,
            patch: { color },
            force: true,
          })),
          `ui-crowd-color:${crowdId}`,
        );
        return;
      }
      commitMutation((state) =>
        mapProjectObjects(state, (item) =>
          item.kind === "character" && item.crowdId === crowdId ? { ...item, color } : item,
        ),
      );
    },
    addLight: (type) => {
      const currentState = get();
      const currentLights = currentState.project.lights ?? [];
      const lightId = getNextSequentialId(
        [
          ...currentLights.map((light) => light.id),
          ...currentState.project.assets.map((asset) => asset.id),
          ...currentState.project.objects.map((object) => object.id),
          ...currentState.project.cameras.map((camera) => camera.id),
        ],
        "light_",
        currentLights.length + 1,
      );
      if (canUseAuthoringPath()) {
        // add_light re-applies the same nativeScene provisioning stamp, so the
        // created light matches the local construction exactly.
        dispatchUiAuthoring(
          [{ action: "add_light", light: createDirectorLight(lightId, type) }],
          `ui-light-add:${lightId}`,
        );
        return lightId;
      }
      commitMutation((state) => {
        const lights = state.project.lights ?? [];
        const light = createDirectorLight(lightId, type);
        if (state.project.nativeScene && hasBlenderLightRepresentation(type)) {
          light.nativeSource = { engine: "blender", objectId: lightId, provisioned: false };
        }
        return withProjectPatch(state, { lights: [...lights, light] });
      });
      return lightId;
    },
    updateLight: (id, patch) => {
      const currentState = get();
      const currentLight = (currentState.project.lights ?? []).find((light) => light.id === id);
      // Type switches rebuild the light from defaults locally, and explicit
      // nativeSource patches are renderer bookkeeping; both stay local.
      const isTypeSwitch = Boolean(patch.type && currentLight && patch.type !== currentLight.type);
      if (canUseAuthoringPath() && currentLight && !isTypeSwitch && !("nativeSource" in patch)) {
        const { nativeSource: _nativeSource, ...lightPatch } = patch;
        if (Object.keys(lightPatch).length) {
          dispatchUiAuthoring(
            [{ action: "update_light", light_id: id, patch: structuredClone(lightPatch), force: true }],
            `ui-light:${id}`,
          );
        }
        return;
      }
      commitMutation((state) => {
        const lights = state.project.lights ?? [];
        return withProjectPatch(state, {
          lights: lights.map((light) => {
            if (light.id !== id) return light;
            let next =
              patch.type && patch.type !== light.type
                ? { ...createDirectorLight(light.id, patch.type), name: light.name, locked: light.locked, ...patch }
                : { ...light, ...patch };
            if (!hasBlenderLightRepresentation(next.type)) {
              const { nativeSource: _nativeSource, ...browserLight } = next;
              next = browserLight;
            } else if (state.project.nativeScene && !next.nativeSource) {
              next = {
                ...next,
                nativeSource: { engine: "blender", objectId: next.id, provisioned: false },
              };
            }
            return next;
          }),
        });
      });
    },
    removeLight: (id) => {
      const currentState = get();
      const target = (currentState.project.lights ?? []).find((light) => light.id === id);
      if (!target || target.locked) return;
      if (canUseAuthoringPath()) {
        dispatchUiAuthoring([{ action: "delete_lights", light_ids: [id] }], `ui-light-remove:${id}`);
        return;
      }
      commitMutation((state) => {
        const lights = state.project.lights ?? [];
        const light = lights.find((item) => item.id === id);
        if (!light || light.locked) return state;
        return withProjectPatch(state, { lights: lights.filter((item) => item.id !== id) });
      });
    },
    updateCharacterBodyType: (id, bodyType) => {
      const currentState = get();
      const targetObject = currentState.project.objects.find((item) => item.id === id);
      // Body type changes move the character's focus height, so object-focused
      // cameras still need the UI refresh helper and keep the local mutator.
      const hasObjectFocusedCamera = currentState.project.cameras.some(
        (camera) => camera.targetMode === "object" && camera.targetObjectId === id,
      );
      if (canUseAuthoringPath() && targetObject?.kind === "character" && !hasObjectFocusedCamera) {
        dispatchUiAuthoring(
          [{ action: "update_object", object_id: id, patch: { body_type: normalizeBodyType(bodyType) }, force: true }],
          `ui-body-type:${id}`,
        );
        return;
      }
      commitMutation((state) => {
        const normalizedBodyType = normalizeBodyType(bodyType);
        const currentObject = state.project.objects.find((item) => item.id === id);
        const nextObject =
          currentObject?.kind === "character"
            ? {
                ...currentObject,
                bodyType: normalizedBodyType,
              }
            : null;

        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) =>
            item.kind === "character" ? { ...item, bodyType: normalizedBodyType } : item,
          ),
          cameras: nextObject
            ? refreshCamerasFocusedOnObject(state.project.cameras, nextObject)
            : state.project.cameras,
        });
      });
    },
    updateUniformScale: (id, scale) => {
      const currentState = get();
      const targetObject = currentState.project.objects.find((item) => item.id === id);
      // Composite parents propagate scale to children, camera rigs reject
      // update_object, and object-focused cameras still need the UI refresh
      // helper; those keep the local mutator.
      const hasObjectFocusedCamera = currentState.project.cameras.some(
        (camera) => camera.targetMode === "object" && camera.targetObjectId === id,
      );
      if (
        canUseAuthoringPath() &&
        targetObject &&
        targetObject.kind !== "camera" &&
        !targetObject.isCompositeParent &&
        !hasObjectFocusedCamera
      ) {
        dispatchUiAuthoring(
          [
            {
              action: "update_object",
              object_id: id,
              patch: { transform: { scale: [scale, scale, scale] } },
              force: true,
            },
          ],
          `ui-uniform-scale:${id}`,
          "变换失败",
        );
        return;
      }
      commitMutation((state) => {
        const currentObject = state.project.objects.find((item) => item.id === id);
        if (currentObject?.isCompositeParent) {
          const composite = applyCompositeParentTransformPatch(state.project.objects, id, {
            scale: [scale, scale, scale],
          });
          return applyObjectTransformMutation(state, composite);
        }
        const nextObject = currentObject
          ? {
              ...currentObject,
              transform: {
                ...currentObject.transform,
                scale: [scale, scale, scale] as [number, number, number],
              },
            }
          : null;

        return withProjectPatch(state, {
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            transform: { ...item.transform, scale: [scale, scale, scale] },
          })),
          cameras: nextObject
            ? refreshCamerasFocusedOnObject(state.project.cameras, nextObject)
            : state.project.cameras,
        });
      });
    },
    updateCrowdUniformScale: (crowdId, scale) => {
      if (canUseAuthoringPath()) {
        const actions = compileCrowdTransformActions(crowdId, { scale: [scale, scale, scale] });
        if (actions) {
          dispatchUiAuthoring(actions, `ui-crowd-scale:${crowdId}`, "变换失败");
          return;
        }
      }
      commitMutation((state) => {
        const nextTransformState = applyCrowdTransformPatch(state.project.objects, crowdId, {
          scale: [scale, scale, scale],
        });
        return applyObjectTransformMutation(state, nextTransformState);
      });
    },
    addImportedAsset: (input) => {
      let assetId = "";

      commitMutation((state) => {
        const claimsPackagedCharacter =
          input.kind === "character" &&
          (input.assetSource === "library" ||
            Boolean(input.id?.startsWith("mixamo:")) ||
            input.url.startsWith("/mixamo-characters/"));
        const catalogById = input.id ? getMixamoCharacterCatalogItem(input.id) : null;
        const catalogByUrl = getMixamoCharacterCatalogItemByUrl(input.url);
        if (catalogById && catalogByUrl && catalogById.id !== catalogByUrl.id) {
          throw new Error(`人物目录 ID "${input.id}" 与模型 URL "${input.url}" 不属于同一资产。`);
        }
        const catalogItem = catalogById ?? catalogByUrl;
        if (claimsPackagedCharacter && !catalogItem) {
          throw new Error(`人物资产不是 Mixamo 目录中的真实条目：${input.id ?? input.url}`);
        }

        const generatedAssetId = getNextSequentialId(
          state.project.assets.map((item) => item.id),
          "asset_",
          state.project.assets.length + 1,
        );
        const sourceType = input.sourceType ?? (input.kind === "panorama" ? "image" : "model");
        const estimatedFallbackSizeM =
          sourceType === "model" && input.kind !== "character" && input.modelNormalization !== "preserve"
            ? DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE
            : undefined;
        const realWorldSizeM = input.realWorldSizeM ?? estimatedFallbackSizeM;
        const nextAsset = catalogItem
          ? createMixamoCharacterAssetRef(catalogItem)
          : ({
              id: input.assetSource === "generated" && input.id ? input.id : generatedAssetId,
              kind: input.kind,
              sourceType,
              fileName: input.fileName,
              name: input.name,
              url: input.url,
              assetSource: input.kind === "panorama" ? undefined : (input.assetSource ?? "local"),
              modelNormalization: input.modelNormalization,
              realWorldSizeM,
              sizeSource:
                realWorldSizeM === undefined
                  ? undefined
                  : input.realWorldSizeM === undefined
                    ? "estimated"
                    : (input.sizeSource ?? "catalog"),
              thumbnailUrl: input.thumbnailUrl,
              generation: input.generation,
              projectionMode: input.projectionMode,
              characterMetadata: input.kind === "character" ? input.characterMetadata : undefined,
              splatSequence: input.splatSequence,
            } satisfies DirectorAssetRef);
        assetId = nextAsset.id;
        const existingAsset = state.project.assets.find((asset) => asset.id === assetId);
        if (existingAsset) {
          if (JSON.stringify(existingAsset) !== JSON.stringify(nextAsset)) {
            throw new Error(`资产 ID "${assetId}" 已存在，但内容与真实目录资产不一致。`);
          }
          if (input.addToScene === false || input.kind === "panorama" || existingAsset.sourceType === "image")
            return state;
          const nextObject = createSceneObjectFromAsset(existingAsset, state.project.objects);
          return appendSelectedObject(state, nextObject);
        }

        if (input.kind === "panorama") {
          return withProjectPatch(
            state,
            { assets: [...state.project.assets, nextAsset], panoramaAssetId: assetId },
            selectedObjectsPatch([], null, "scene"),
          );
        }

        if (input.addToScene === false || nextAsset.sourceType === "image") {
          persistLocalModelAsset(nextAsset);

          return withProjectPatch(state, { assets: [...state.project.assets, nextAsset] });
        }

        const nextObject = createSceneObjectFromAsset(nextAsset, state.project.objects);
        return appendSelectedObject(state, nextObject, { assets: [...state.project.assets, nextAsset] });
      });

      return assetId;
    },
    setAssetRealWorldSize: (assetId, sizeM, source = "user") => {
      const currentAsset = get().project.assets.find((item) => item.id === assetId);
      if (!currentAsset || currentAsset.sourceType !== "model" || currentAsset.kind === "character") return;
      if (sizeM !== null && (!Number.isFinite(sizeM) || sizeM <= 0)) return;
      // Clearing omits realWorldSizeM/sizeSource. applyAuthoredProject then runs
      // backfillDirectorAssetMetricScale, which re-estimates unsized models to
      // the 2 m fallback — the Prop inspector would show a filled value again.
      // Keep the local writer for clear so the empty-field UX matches the
      // previous direct patch; finite sizes still share upsert_asset.
      if (canUseAuthoringPath() && sizeM !== null) {
        const nextAsset: DirectorAssetRef = {
          ...currentAsset,
          realWorldSizeM: sizeM,
          sizeSource: source,
        };
        dispatchUiAuthoring(
          [{ action: "upsert_asset", asset: cloneJsonValue(nextAsset) }],
          `ui-asset-size:${assetId}`,
          "更新失败",
        );
        return;
      }
      commitMutation((state) => {
        const asset = state.project.assets.find((item) => item.id === assetId);
        if (!asset || asset.sourceType !== "model" || asset.kind === "character") return state;
        if (sizeM !== null && (!Number.isFinite(sizeM) || sizeM <= 0)) return state;
        return withProjectPatch(state, {
          assets: state.project.assets.map((item) =>
            item.id === assetId
              ? {
                  ...item,
                  realWorldSizeM: sizeM ?? undefined,
                  sizeSource: sizeM === null ? undefined : source,
                }
              : item,
          ),
        });
      });
    },
    // human-only: no authoring twin. createSceneObjectFromAsset stamps the
    // Blender nativeSource provisioning marker and character rig defaults that
    // add_object does not author; migrateDirectorProject backfills them only on
    // load, so runtime asset drops keep the local construction.
    addObjectFromAsset: (assetId) => {
      let nextObjectId: string | null = null;

      commitMutation((state) => {
        const asset = state.project.assets.find((item) => item.id === assetId);
        if (!asset || asset.sourceType !== "model" || asset.kind === "panorama") return state;

        const nextObject = createSceneObjectFromAsset(asset, state.project.objects);
        nextObjectId = nextObject.id;

        return appendSelectedObject(state, nextObject);
      });

      return nextObjectId;
    },
    // human-only: no authoring twin. add_object forces mannequin body type and
    // the default ochre for characters, while the preset flow keeps per-add
    // body types and a rotating distinct-color palette.
    addPresetCharacter: (bodyType = DEFAULT_CHARACTER_BODY_TYPE, color) =>
      commitMutation((state) => {
        const defaultCharacterAsset = getDefaultMixamoCharacterAssetRef();
        const presetCharacterCount = state.project.objects.filter(
          (item) => item.kind === "character" && item.id.startsWith("char_preset_"),
        ).length;
        const presetCharacterIndex = presetCharacterCount + 1;
        const row = Math.floor((presetCharacterIndex - 1) / 4);
        const x = getAddedModelColumnOffset(presetCharacterIndex - row * 4);
        const z = row * 0.8;
        const nextObject = buildPresetCharacterObject(state, bodyType, [x, 0, z], undefined, color);

        return appendSelectedObject(state, nextObject, {
          assets: state.project.assets.some((asset) => asset.id === defaultCharacterAsset.id)
            ? state.project.assets
            : [defaultCharacterAsset, ...state.project.assets],
        });
      }),
    // human-only: no authoring twin. crowdId/crowdLabel grouping is UI-only
    // state that add_object cannot author.
    addCrowdCharacters: ({ bodyType = DEFAULT_CHARACTER_BODY_TYPE, rows, columns, spacing }) => {
      const createdIds: string[] = [];

      commitMutation((state) => {
        const defaultCharacterAsset = getDefaultMixamoCharacterAssetRef();
        const positions = getCrowdCharacterPositions(rows, columns, spacing);
        const offset = getCrowdCharacterOffset(state.project.objects, spacing);
        const nextObjects = [...state.project.objects];
        const crowdLabel = formatCrowdLabel(rows, columns);
        const crowdId = getNextCrowdId(state.project.objects);

        positions.forEach((position) => {
          const nextState = {
            ...state,
            project: {
              ...state.project,
              objects: nextObjects,
            },
          } as DirectorRuntimeState;
          const nextObject = buildPresetCharacterObject(
            nextState,
            bodyType,
            [
              Number((position[0] + offset[0]).toFixed(4)),
              Number((position[1] + offset[1]).toFixed(4)),
              Number((position[2] + offset[2]).toFixed(4)),
            ],
            {
              crowdId,
              crowdLabel,
            },
          );
          nextObjects.push(nextObject);
          createdIds.push(nextObject.id);
        });

        if (!createdIds.length) return state;

        return withProjectPatch(
          state,
          {
            assets: state.project.assets.some((asset) => asset.id === defaultCharacterAsset.id)
              ? state.project.assets
              : [defaultCharacterAsset, ...state.project.assets],
            objects: nextObjects,
          },
          selectedObjectsPatch(createdIds, crowdId),
        );
      });

      return createdIds;
    },
    addGeometryPrimitive: (geometryType) => {
      const buildPrimitive = (objects: DirectorObject[]): DirectorObject => {
        const geometryObjects = objects.filter((item) => item.kind === "prop" && item.geometryType);
        const geometryIndex = geometryObjects.length + 1;
        const sameTypeCount = geometryObjects.filter((item) => item.geometryType === geometryType).length;
        const row = Math.floor((geometryIndex - 1) / 4);
        const column = (geometryIndex - 1) % 4;
        const x = column * 1.15 - 1.725;
        const z = row * 0.75 + 1.15;
        const label = getGeometryPrimitiveLabel(geometryType);
        const objectId = getNextSequentialId(
          objects.map((item) => item.id),
          `geo_${geometryType}_`,
          geometryIndex,
        );
        return {
          id: objectId,
          name: sameTypeCount === 0 ? label : `${label}${String(sameTypeCount + 1).padStart(2, "0")}`,
          kind: "prop",
          visible: true,
          locked: false,
          geometryType,
          color: GEOMETRY_PRIMITIVE_COLOR,
          transform: createTransform([x, 0, z]),
        };
      };
      if (canUseAuthoringPath()) {
        const primitive = buildPrimitive(get().project.objects);
        // In-process authoring still accepts geometry_type for the white-box
        // primitives; only the public workbench agent wire rejects it.
        const applied = dispatchUiAuthoring(
          [
            {
              action: "add_object",
              id: primitive.id,
              name: primitive.name,
              kind: "prop",
              geometry_type: geometryType,
              color: primitive.color,
              transform: primitive.transform,
            },
          ],
          `ui-primitive:${primitive.id}`,
        );
        if (applied) {
          // Selection is UI-only state; apply it after the authored commit.
          commitUiMutation((state) => ({ ...state, ...selectedObjectsPatch([primitive.id]) }));
        }
        return;
      }
      commitMutation((state) => appendSelectedObject(state, buildPrimitive(state.project.objects)));
    },
    // human-only: stays local. Snapshot-created cameras keep the viewport's
    // exact fov while add_camera always derives fov from focal length (rounding
    // drift), the UI's sequential cam_N/cam_object_N ids and active-camera
    // optics inheritance are not authoring concepts, and appendSelectedObject
    // selection rides in the same undoable commit.
    addCameraShot: (snapshot) => {
      let nextCameraId = "";

      commitMutation((state) => {
        const cameraIndex = state.project.cameras.length + 1;
        const cameraId = getNextSequentialId(
          state.project.cameras.map((item) => item.id),
          "cam_",
          cameraIndex,
        );
        const objectId = getNextSequentialId(
          state.project.objects.map((item) => item.id),
          "cam_object_",
          cameraIndex,
        );
        nextCameraId = cameraId;
        const sourceCamera = state.project.cameras.find((camera) => camera.id === state.project.activeCameraId);
        const sourceOptics = normalizeDirectorCameraOptics(sourceCamera ?? {});
        const aspectRatio = DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
        const sensorFormat = sourceCamera?.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
        const focalLengthMm = snapshot
          ? getFocalLengthFromVerticalFov(snapshot.fov, aspectRatio, sensorFormat)
          : (sourceCamera?.focalLengthMm ?? DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM);
        const initialSnapshot = snapshot ?? {
          ...DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
          position: [
            DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.position[0] + (cameraIndex - 1) * 1.2,
            DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.position[1],
            DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.position[2],
          ] as [number, number, number],
        };
        const transform = createTransform(getCameraRigPositionFromViewSnapshot(initialSnapshot));
        const nextCamera: DirectorCameraShot = {
          id: cameraId,
          name: formatSceneItemName("机位", cameraIndex),
          fov: snapshot?.fov ?? getVerticalFovFromFocalLength(focalLengthMm, aspectRatio, sensorFormat),
          focalLengthMm,
          sensorFormat,
          ...sourceOptics,
          aspectRatio,
          handheldShake: sourceCamera?.handheldShake ?? DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
          action: sourceCamera?.action ?? DEFAULT_DIRECTOR_CAMERA_ACTION,
          transform,
          targetMode: "manual",
          target: initialSnapshot.target,
          lastCaptureUrl: null,
          captures: [],
          ...(state.project.nativeScene
            ? { nativeSource: { engine: "blender" as const, objectId: cameraId, provisioned: false as const } }
            : {}),
        };
        const nextCameraObject: DirectorObject = {
          id: objectId,
          name: nextCamera.name,
          kind: "camera",
          visible: true,
          locked: false,
          linkedCameraId: cameraId,
          transform,
        };

        return appendSelectedObject(state, nextCameraObject, {
          cameras: [...state.project.cameras, nextCamera],
          activeCameraId: cameraId,
        });
      });

      return nextCameraId;
    },
    deleteSelectedObject: () => {
      get().deleteObjects(getOrderedSelectedObjectIds(get() as DirectorRuntimeState));
    },
    deleteObjects: (ids) => {
      const actions = compileDirectorDeleteObjectActions(get().project, ids);
      if (!actions.length) return;
      const receipt = dispatchDirectorAuthoringActions(actions, {
        idempotencyKey: `ui-delete:${ids.slice().sort().join(",")}`,
      });
      if (!receipt.ok) {
        notifyDirector({
          severity: "error",
          title: "删除失败",
          detail: receipt.error,
        });
      }
    },
    toggleObjectVisible: (id) => toggleObjectFlag(id, "visible"),
    toggleObjectLocked: (id) => toggleObjectFlag(id, "locked"),
    applyPosePreset: (id, presetId) => applyTargetPosePreset({ id }, presetId),
    applyCrowdPosePreset: (crowdId, presetId) => applyTargetPosePreset({ crowdId }, presetId),
    updatePoseControl: (id, key, value) => updateTargetPoseControl({ id }, key, value),
    updateCrowdPoseControl: (crowdId, key, value) => updateTargetPoseControl({ crowdId }, key, value),
    setCharacterMotion: (id, motion) => setTargetCharacterMotion({ id }, motion),
    setCrowdCharacterMotion: (crowdId, motion) => setTargetCharacterMotion({ crowdId }, motion),
    setCharacterIkEffector: (id, effector, target) => setTargetCharacterIk({ id }, effector, target),
    setCrowdCharacterIkEffector: (crowdId, effector, target) => setTargetCharacterIk({ crowdId }, effector, target),
    clearCharacterIkEffector: (id, effector) => clearTargetCharacterIk({ id }, effector),
    clearCrowdCharacterIkEffector: (crowdId, effector) => clearTargetCharacterIk({ crowdId }, effector),
    setActiveCamera: (cameraId) => {
      const currentState = get() as DirectorRuntimeState;
      const cameraExists = currentState.project.cameras.some((camera) => camera.id === cameraId);
      // An active camera is the selected physical rig in the Stage. Selection
      // and viewport aspect stay UI-only state, applied outside the authored
      // commit so authoring does not dual-write camera fields.
      const applyUiCameraSelection = () =>
        commitUiMutation((state) => {
          const selectedCamera = state.project.cameras.find((camera) => camera.id === cameraId);
          const selectedObjectId =
            state.project.objects.find((item) => item.kind === "camera" && item.linkedCameraId === cameraId)?.id ??
            null;
          return {
            ...state,
            ...selectedObjectsPatch(selectedObjectId ? [selectedObjectId] : []),
            viewportAspectRatio: selectedCamera?.aspectRatio ?? state.viewportAspectRatio,
          };
        });
      if (canUseAuthoringPath() && cameraExists) {
        if (currentState.project.activeCameraId !== cameraId) {
          // Re-activating the current camera only refreshes UI selection;
          // skipping the dispatch avoids a no-op undo entry.
          const applied = dispatchUiAuthoring(
            [{ action: "set_active_camera", camera_id: cameraId }],
            `ui-active-camera:${cameraId}`,
          );
          if (!applied) return;
        }
        applyUiCameraSelection();
        return;
      }
      commitUiMutation((state) => {
        const selectedCamera = state.project.cameras.find((camera) => camera.id === cameraId);
        const selectedObjectId =
          state.project.objects.find((item) => item.kind === "camera" && item.linkedCameraId === cameraId)?.id ?? null;

        return withProjectPatch(
          state,
          { activeCameraId: cameraId },
          {
            ...selectedObjectsPatch(selectedObjectId ? [selectedObjectId] : []),
            viewportAspectRatio: selectedCamera?.aspectRatio ?? state.viewportAspectRatio,
          },
        );
      });
    },
    addCameraCaptures: (cameraId, dataUrls) => {
      const urls = dataUrls.filter((url) => typeof url === "string" && url.startsWith("data:image/"));
      if (urls.length === 0) return;
      if (canUseAuthoringPath()) {
        const state = get() as DirectorRuntimeState;
        const targetCameraId = cameraId ?? state.project.activeCameraId ?? state.project.cameras[0]?.id ?? null;
        if (!targetCameraId) return;
        dispatchUiAuthoring(
          [
            {
              action: "add_camera_captures",
              camera_id: targetCameraId,
              captures: urls.map((data_url) => ({ data_url })),
            },
          ],
          `ui-camera-captures:${targetCameraId}:${urls.length}`,
          "机位截图写入失败",
        );
        return;
      }
      commitMutation((state) => {
        const targetCameraId = cameraId ?? state.project.activeCameraId ?? state.project.cameras[0]?.id ?? null;
        if (!targetCameraId) return state;

        let updated = false;
        const cameras = state.project.cameras.map((camera) => {
          if (camera.id !== targetCameraId) return camera;

          updated = true;
          const nextCaptures = buildCameraCaptures(camera, urls);

          return {
            ...camera,
            lastCaptureUrl: nextCaptures[nextCaptures.length - 1]?.dataUrl ?? camera.lastCaptureUrl ?? null,
            captures: [...(camera.captures ?? []), ...nextCaptures],
          };
        });

        if (!updated) return state;

        return withProjectPatch(state, { cameras });
      });
    },
    updateCamera: (cameraId, patch) => {
      const currentState = get() as DirectorRuntimeState;
      const camera = currentState.project.cameras.find((item) => item.id === cameraId);
      if (canUseAuthoringPath() && camera) {
        const rig = currentState.project.objects.find(
          (item) => item.kind === "camera" && item.linkedCameraId === cameraId,
        );
        // update_camera requires a linked rig object unless the camera is
        // Blender-native; it also syncs the rig name like the local mutator.
        if (rig || camera.nativeSource?.engine === "blender") {
          const authored = buildCameraAuthoringPatch(camera, patch);
          if (authored) {
            dispatchUiAuthoring(
              [{ action: "update_camera", camera_id: cameraId, patch: authored }],
              `ui-camera:${cameraId}`,
            );
            return;
          }
        }
      }
      // Local path: rig transform / view target / capture bookkeeping patches
      // have UI semantics that update_camera cannot express (see
      // buildCameraAuthoringPatch), plus RAF/gizmo undo batches.
      commitMutation((state) =>
        withProjectPatch(state, {
          cameras: state.project.cameras.map((item) =>
            item.id === cameraId
              ? {
                  ...item,
                  ...patch,
                  action: patch.action
                    ? normalizeDirectorCameraAction(patch.action as DirectorCameraAction)
                    : (item.action ?? DEFAULT_DIRECTOR_CAMERA_ACTION),
                  transform: patch.transform ?? item.transform,
                  target: patch.target ?? item.target,
                }
              : item,
          ),
          objects: state.project.objects.map((item) =>
            item.kind === "camera" && item.linkedCameraId === cameraId
              ? {
                  ...item,
                  ...(patch.transform ? { transform: patch.transform } : {}),
                  ...(typeof patch.name === "string" ? { name: patch.name } : {}),
                  ...(patch.referenceBindings ? { referenceBindings: patch.referenceBindings } : {}),
                }
              : item,
          ),
        }),
      );
    },
    setObjectMeasuredLocalBounds: (objectId, bounds) =>
      commitMutation(
        (state) => {
          const object = state.project.objects.find((candidate) => candidate.id === objectId);
          if (!object || sameLocalBounds(object.localBoundsM, bounds)) return state;
          return withProjectPatch(state, {
            objects: updateObjectById(state.project.objects, objectId, (candidate) => ({
              ...candidate,
              localBoundsM: bounds,
            })),
          });
        },
        { trackUndo: false },
      ),
    setCameraAnimation: (cameraId, animation) => {
      const cameraExists = get().project.cameras.some((camera) => camera.id === cameraId);
      if (canUseAuthoringPath() && cameraExists) {
        dispatchUiAuthoring(
          [
            {
              action: "set_animation",
              target_type: "camera",
              target_id: cameraId,
              animation: animation ? structuredClone(animation) : null,
            },
          ],
          `ui-camera-animation:${cameraId}`,
        );
        return;
      }
      commitMutation((state) =>
        withProjectPatch(state, {
          cameras: state.project.cameras.map((camera) =>
            camera.id === cameraId
              ? {
                  ...camera,
                  ...(animation ? { animation } : { animation: undefined }),
                }
              : camera,
          ),
        }),
      );
    },
    copySelectedObjects: () => {
      const currentState = get() as DirectorRuntimeState;
      const clipboard = buildClipboardEntries(currentState);
      set({
        ...currentState,
        clipboard,
        clipboardPasteCount: 0,
      });
    },
    pasteClipboardObjects: () => {
      const currentState = get() as DirectorRuntimeState;
      if (currentState.clipboard.length === 0) return;
      // One-shot pastes share the Agent authoring path via duplicate_objects.
      // Stale clipboard snapshots (source edited or deleted since copy),
      // Blender-native objects without a model asset, camera objects with a
      // missing linked shot, and pastes interacting with object-focused
      // cameras keep the legacy clipboard writer.
      const action = canUseAuthoringPath()
        ? compileDirectorPasteClipboardActions(
            currentState.project,
            currentState.clipboard,
            currentState.clipboardPasteCount,
          )
        : null;
      if (action) {
        const pasteIteration = currentState.clipboardPasteCount + 1;
        const receipt = dispatchDirectorAuthoringActions([action], {
          idempotencyKey: `ui-paste:${pasteIteration}:${action.object_ids[0]}x${action.object_ids.length}`,
        });
        if (!receipt.ok) {
          notifyDirector({
            severity: "error",
            title: "粘贴失败",
            detail: receipt.error,
          });
          return;
        }
        // Selection, inspector mode, and the paste counter are UI-only state,
        // applied outside the authored commit.
        commitUiMutation((state) => {
          const pastedObjectIds = receipt.created.object_ids;
          const pastedCrowdIds = Array.from(
            new Set(
              pastedObjectIds
                .map((objectId) => state.project.objects.find((item) => item.id === objectId)?.crowdId)
                .filter((crowdId): crowdId is string => typeof crowdId === "string"),
            ),
          );
          return {
            ...state,
            ...selectedObjectsPatch(pastedObjectIds, pastedCrowdIds.length === 1 ? pastedCrowdIds[0] : null),
            clipboardPasteCount: pasteIteration,
          };
        });
        return;
      }
      commitMutation((state) => pasteClipboardEntries(state));
    },
    undo: () => {
      const currentState = get() as DirectorRuntimeState;
      if (currentState.historyBusy) return;
      const historyEntry = currentState.historyUndoStack[currentState.historyUndoStack.length - 1];
      if (historyEntry?.domain === "blender") {
        void replayBlenderHistory(historyEntry, "undo");
        return;
      }
      const previousState =
        historyEntry?.domain === "director"
          ? historyEntry.state
          : currentState.undoStack[currentState.undoStack.length - 1];
      if (!previousState) return;

      const runtimeState = createRuntimeStateFromPersistedState(previousState);
      const redoState = createUndoStackEntry(currentState);
      set({
        ...runtimeState,
        clipboard: currentState.clipboard,
        clipboardPasteCount: currentState.clipboardPasteCount,
        undoStack: currentState.undoStack.slice(0, -1),
        redoStack: trimUndoStack([...(currentState.redoStack ?? []), redoState]),
        historyUndoStack: historyEntry ? currentState.historyUndoStack.slice(0, -1) : currentState.historyUndoStack,
        historyRedoStack: trimHistoryStack([
          ...currentState.historyRedoStack,
          { domain: "director", state: redoState },
        ]),
        pendingBlenderSyncs: currentState.pendingBlenderSyncs,
      });
      persistDirectorStateImmediately(previousState);
    },
    redo: () => {
      const currentState = get() as DirectorRuntimeState;
      if (currentState.historyBusy) return;
      const historyEntry = currentState.historyRedoStack[currentState.historyRedoStack.length - 1];
      if (historyEntry?.domain === "blender") {
        void replayBlenderHistory(historyEntry, "redo");
        return;
      }
      const redoStack = currentState.redoStack ?? [];
      const nextState = historyEntry?.domain === "director" ? historyEntry.state : redoStack[redoStack.length - 1];
      if (!nextState) return;

      const runtimeState = createRuntimeStateFromPersistedState(nextState);
      const undoState = createUndoStackEntry(currentState);
      set({
        ...runtimeState,
        clipboard: currentState.clipboard,
        clipboardPasteCount: currentState.clipboardPasteCount,
        undoStack: trimUndoStack([...currentState.undoStack, undoState]),
        redoStack: redoStack.slice(0, -1),
        historyUndoStack: trimHistoryStack([
          ...currentState.historyUndoStack,
          { domain: "director", state: undoState },
        ]),
        historyRedoStack: historyEntry ? currentState.historyRedoStack.slice(0, -1) : currentState.historyRedoStack,
        pendingBlenderSyncs: currentState.pendingBlenderSyncs,
      });
      persistDirectorStateImmediately(nextState);
    },
    openScopedScene: (scopeId) => {
      const currentState = get() as DirectorRuntimeState;
      flushScheduledDirectorPersistence();
      setDirectorScenePersistenceScopeId(scopeId);
      const snapshot = createInitialDirectorState({
        includePersistedLocalAssets: true,
        includePersistedScene: true,
        persistenceScopeId: directorScenePersistenceScopeId,
      });
      const runtimeState = createRuntimeStateFromPersistedState(snapshot);

      set({
        ...runtimeState,
        clipboard: currentState.clipboard,
        clipboardPasteCount: currentState.clipboardPasteCount,
        undoStack: [],
        redoStack: [],
      });
      persistDirectorStateImmediately(snapshot);
    },
    replaceProject: (project) => {
      const migratedProject = migrateDirectorProject(cloneJsonValue(project));
      const characterIssues = getDirectorCharacterAssetBindingIssues(migratedProject);
      if (characterIssues.length) throw new Error(`人物资产绑定无效：${characterIssues[0]}`);
      commitMutation((state) => ({
        ...state,
        project: migratedProject,
        selectedObjectId: null,
        selectedObjectIds: [],
        selectedCrowdId: null,
        directorInspectorMode: "auto",
      }));
    },
    /**
     * Commit an authored project document while preserving still-valid selection.
     * UI dispatch and Agent authoring share this path so undo/revision stay aligned
     * without wiping the inspector selection on every transform/delete.
     */
    applyAuthoredProject: (project) => {
      const migratedProject = migrateDirectorProject(cloneJsonValue(project));
      const characterIssues = getDirectorCharacterAssetBindingIssues(migratedProject);
      if (characterIssues.length) throw new Error(`人物资产绑定无效：${characterIssues[0]}`);
      commitMutation((state) => {
        const nextProject = reuseUnchangedJsonReferences(state.project, migratedProject);
        const remainingIds = new Set(nextProject.objects.map((object) => object.id));
        const nextSelectedIds = getOrderedSelectedObjectIds(state).filter((id) => remainingIds.has(id));
        const selectionUnchanged =
          nextSelectedIds.length === state.selectedObjectIds.length &&
          nextSelectedIds.every((id, index) => state.selectedObjectIds[index] === id);
        const nextCrowdId =
          state.selectedCrowdId &&
          nextProject.objects.some((object) => object.kind === "character" && object.crowdId === state.selectedCrowdId)
            ? state.selectedCrowdId
            : null;
        return {
          ...state,
          project: nextProject,
          ...selectedObjectsPatch(selectionUnchanged ? state.selectedObjectIds : nextSelectedIds, nextCrowdId),
        };
      });
    },
    saveLatestSnapshot: () => {
      persistDirectorStateImmediately(extractPersistedDirectorState(get() as DirectorRuntimeState));
    },
    restoreLatestSnapshot: () => {
      const snapshot = readPersistedDirectorState({ includePersistedLocalAssets: true, includePersistedScene: true });
      if (!snapshot) return;

      const runtimeState = createRuntimeStateFromPersistedState(snapshot);
      set({
        ...runtimeState,
        clipboard: (get() as DirectorRuntimeState).clipboard,
        clipboardPasteCount: (get() as DirectorRuntimeState).clipboardPasteCount,
        undoStack: [],
        redoStack: [],
      });
      persistDirectorStateImmediately(extractPersistedDirectorState(runtimeState));
    },
  };
});

/**
 * Derived undo/redo availability for UI affordances (e.g. viewport toolbar
 * buttons). Kept as store selectors beside undo/redo so subscribers re-render
 * exactly when history depth changes.
 */
export const selectDirectorCanUndo = (state: DirectorStore) =>
  !state.historyBusy && (state.historyUndoStack.length > 0 || state.undoStack.length > 0);
export const selectDirectorCanRedo = (state: DirectorStore) =>
  !state.historyBusy && (state.historyRedoStack.length > 0 || (state.redoStack ?? []).length > 0);

/**
 * Live localStorage persistence health. `status === "failed"` means the
 * current document only lives in this tab; UI surfaces should offer an
 * export path (see exportDirectorProjectBackup).
 */
export const selectDirectorPersistenceHealth = (state: DirectorStore) => state.persistenceHealth;
