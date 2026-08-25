// Director store type definitions — extracted from directorStore.ts.
// Shareable between the store implementation and consumers.

import type { BlenderLiveSceneSnapshot } from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import type { DirectorUiState, TransformMode } from "@director/protocol/workbench-ui";
import type {
  DirectorAssetRef,
  DirectorAssetSource,
  DirectorAssetKind,
  DirectorCameraShot,
  DirectorCharacterIkEffector,
  DirectorCharacterIkTarget,
  DirectorCharacterMotionState,
  DirectorEntityAnimation,
  DirectorLight,
  DirectorLightType,
  DirectorMaterialTextureSlot,
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
  DirectorTransform,
  DirectorVehicleProfile,
  DirectorWorldEffect,
  DirectorWorldRoad,
  DirectorWorldWaterBody,
  DirectorWorldWildlifeGroup,
  DirectorWorldWind,
  DirectorWorldTimeOfDay,
  DirectorWorldWeather,
  CharacterBodyType,
  GeometryPrimitiveType,
  MixamoCharacterMetadata,
  PanoramaProjectionMode,
  SceneSettings,
  ViewMode,
} from "../schema/directorProject";
import type { PosePresetId } from "../schema/poseSchema";
import type { ViewportAspectRatio } from "@director/protocol/workbench-ui";
import type { DirectorViewportLayout } from "@director/protocol/workbench-ui";

export type { DirectorUiState, TransformMode };

export interface DirectorWorldSettingsPatch {
  enabled?: boolean;
  seed?: number;
  wind?: Partial<DirectorWorldWind>;
  timeOfDay?: Partial<DirectorWorldTimeOfDay>;
  weather?: Partial<DirectorWorldWeather>;
}

export interface ImportedAssetInput {
  /** Canonical catalog id. Local user imports omit this and receive asset_N. */
  id?: string;
  kind: DirectorAssetKind;
  name: string;
  fileName: string;
  url: string;
  sourceType?: DirectorAssetRef["sourceType"];
  addToScene?: boolean;
  assetSource?: DirectorAssetSource;
  projectionMode?: PanoramaProjectionMode;
  characterMetadata?: MixamoCharacterMetadata;
  thumbnailUrl?: DirectorAssetRef["thumbnailUrl"];
  modelNormalization?: DirectorAssetRef["modelNormalization"];
  realWorldSizeM?: DirectorAssetRef["realWorldSizeM"];
  sizeSource?: DirectorAssetRef["sizeSource"];
  generation?: DirectorAssetRef["generation"];
  splatSequence?: DirectorAssetRef["splatSequence"];
}

export interface TimelineAudioClipInput {
  mediaId: string;
  name: string;
  sourceUrl?: string;
  /** Defaults to the current playhead frame. */
  startFrame?: number;
  durationFrames: number;
  sourceDurationSec?: number;
}

export interface CameraShotSnapshot {
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

export interface CrowdCharactersInput {
  bodyType?: CharacterBodyType;
  rows: number;
  columns: number;
  spacing: number;
}

export interface DirectorObjectTransformUpdate {
  id: string;
  transform: DirectorTransform;
}

export interface DirectorStateOptions {
  includePersistedLocalAssets?: boolean;
  includePersistedScene?: boolean;
  persistenceScopeId?: string | null;
}

export interface DirectorState extends DirectorUiState {
  project: DirectorProject;
}

export interface DirectorClipboardEntry {
  object: DirectorObject;
  camera?: DirectorCameraShot;
}

export interface DirectorInternalState {
  clipboard: DirectorClipboardEntry[];
  clipboardPasteCount: number;
  undoStack: DirectorState[];
  redoStack: DirectorState[];
  undoBatchDepth: number;
  undoBatchSnapshot: DirectorState | null;
  undoBatchHasTrackedChanges: boolean;
}

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
  saveLatestSnapshot: () => void;
  restoreLatestSnapshot: () => void;
}

export type DirectorObjectEditAxis = "x" | "y" | "z";
export type DirectorObjectAlignMode = "min" | "center" | "max";
export interface DirectorObjectBatchPatch {
  visible?: boolean;
  locked?: boolean;
  layer?: string | null;
  transform?: Partial<DirectorTransform>;
  color?: string;
  material?: Partial<DirectorPbrMaterial> | null;
}

export type DirectorRuntimeState = DirectorState & DirectorInternalState;

export type DirectorStore = DirectorRuntimeState & DirectorActions;