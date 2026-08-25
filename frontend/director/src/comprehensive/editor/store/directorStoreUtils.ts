// Director store utility functions — extracted from directorStore.ts.
// Pure functions and constants that don't depend on Zustand or React.

import { DIRECTOR_PREVIZ_PALETTE } from "@director/project-schema";
import { FLICK_HUMAN_DEFAULT_COLOR } from "../schema/flickHumanAppearance";
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
import { createDefaultDirectorLights, createDirectorLight } from "@director/project-schema";
import { mergeDirectorPbrMaterial } from "../schema/directorMaterial";
import type {
  DirectorAssetRef,
  DirectorObject,
  DirectorProject,
  DirectorTransform,
  SceneSettings,
} from "../schema/directorProject";
import { directorAssetRefSchema } from "../schema/directorProjectSchema";
import {
  createDefaultDirectorProduction,
  getDirectorProductionIssues,
  migrateDirectorProduction,
  reconcileDirectorProduction,
} from "../schema/directorProduction";
import { createDefaultDirectorFrameTimeline } from "../timeline/frameTime";
import { backfillDirectorAssetMetricScale } from "./directorScaleMigration";
import {
  createMixamoCharacterAssetRef,
  getDefaultMixamoCharacterAssetRef,
  getMixamoCharacterCatalogItem,
  getMixamoCharacterCatalogItemByUrl,
} from "../modelLibrary/mixamoCharacterCatalog";
import type { DirectorUiState } from "@director/protocol/workbench-ui";
import {
  DEFAULT_CAMERA_PILOT_BANK_STRENGTH,
  DEFAULT_CAMERA_PILOT_INERTIA,
  DEFAULT_CAMERA_PILOT_LOOK_SMOOTHING,
  DEFAULT_VIEWPORT_MOVE_SPEED,
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
} from "../schema/viewportNavigation";

// ---- Constants ----

export const DEFAULT_SCENE: SceneSettings = {
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

export const CHARACTER_COLOR_PALETTE = [
  "#4F8EF7",
  "#E0524D",
  "#E91E63",
  "#F2A900",
  "#9C4DCC",
  "#12B886",
  "#00B8D9",
  "#FF7A45",
];

export const LEGACY_AUTOMATIC_CHARACTER_BLUE = "#4f8ef7";
export const GEOMETRY_PRIMITIVE_COLOR = "#d7e7ff";
export const ADDED_MODEL_WORLD_SPACING = 1.25;
export const COPY_PASTE_POSITION_OFFSET = 0.6;
export const UNDO_STACK_LIMIT = 80;
export const LOCAL_MODEL_LIBRARY_STORAGE_KEY = "storyai-3d-director-local-model-library";
export const DIRECTOR_SCENE_STORAGE_KEY = "storyai-3d-director-desk-demo";
export const DIRECTOR_SCENE_STORAGE_KEY_PREFIX = `${DIRECTOR_SCENE_STORAGE_KEY}:`;
export const DEFAULT_UI_STATE: DirectorUiState = {
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

export const DIRECTOR_PERSIST_DEBOUNCE_MS = 1_000;

// ---- Utility functions ----

export function normalizeDirectorScenePersistenceScopeId(scopeId: string | null | undefined) {
  return typeof scopeId === "string" ? scopeId.trim() : "";
}

export function getInitialDirectorScenePersistenceScopeId() {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeDirectorScenePersistenceScopeId(params.get("instanceId")) || null;
  } catch {
    return null;
  }
}

export function getDirectorSceneStorageKey(
  scopeId: string | null | undefined,
  persistenceScopeId: string | null,
) {
  const normalizedScopeId = normalizeDirectorScenePersistenceScopeId(scopeId ?? persistenceScopeId);
  return normalizedScopeId ? `${DIRECTOR_SCENE_STORAGE_KEY_PREFIX}${normalizedScopeId}` : DIRECTOR_SCENE_STORAGE_KEY;
}

export function setDirectorScenePersistenceScopeId(scopeId: string | null | undefined) {
  return normalizeDirectorScenePersistenceScopeId(scopeId) || null;
}

export function createTransform(
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): DirectorTransform {
  return { position, rotation, scale };
}

export function roundTransformValue(value: number) {
  return Number(value.toFixed(6));
}

export function roundTransformTuple(values: [number, number, number]): [number, number, number] {
  return values.map((value) => roundTransformValue(value)) as [number, number, number];
}

export function formatSceneItemName(prefix: "角色" | "机位", index: number) {
  return `${prefix}${String(index).padStart(2, "0")}`;
}

export function getNextSequentialId(existingIds: string[], prefix: string, minimumIndex = 1) {
  let maxIndex = minimumIndex - 1;
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    maxIndex = Math.max(maxIndex, Number.parseInt(suffix, 10));
  }
  return `${prefix}${maxIndex + 1}`;
}

export function isLocalModelLibraryAsset(asset: DirectorAssetRef) {
  return (
    asset.sourceType === "model" &&
    asset.kind !== "panorama" &&
    (asset.assetSource === "local" || asset.assetSource === "generated")
  );
}

export function getLocalStorageSafe() {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function readPersistedLocalModelAssets() {
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

export function writePersistedLocalModelAssets(assets: DirectorAssetRef[]) {
  const storage = getLocalStorageSafe();
  if (!storage) return;
  try {
    storage.setItem(LOCAL_MODEL_LIBRARY_STORAGE_KEY, JSON.stringify(assets.filter(isLocalModelLibraryAsset)));
  } catch {
    // Local model files can exceed browser storage limits; keep the current scene usable if persistence fails.
  }
}

export function persistLocalModelAsset(asset: DirectorAssetRef) {
  if (!isLocalModelLibraryAsset(asset)) return;
  const persistedAssets = readPersistedLocalModelAssets().filter((item) => item.id !== asset.id);
  writePersistedLocalModelAssets([...persistedAssets, asset]);
}

export function removePersistedLocalModelAsset(assetId: string) {
  writePersistedLocalModelAssets(readPersistedLocalModelAssets().filter((asset) => asset.id !== assetId));
}

export function withPersistedLocalAssets(project: DirectorProject, includePersistedLocalAssets = false): DirectorProject {
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
 */
export function inferLegacyLibraryCharacterAssetId(project: DirectorProject, object: DirectorObject) {
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

export function canonicalizePackagedCharacterAssets(project: DirectorProject): DirectorProject {
  const remappedIds = new Map<string, string>();
  const normalizedAssets = project.assets.map((asset) => {
    if (asset.kind !== "character" || asset.sourceType !== "model") return asset;
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
      // Only characters still on the legacy procedural rig get the blue
      // rewrite: authored commits also run this migration, and the rotating
      // preset palette deliberately starts on the same blue.
      const color =
        rig?.rigType !== "mixamo" && object.color?.toLowerCase() === LEGACY_AUTOMATIC_CHARACTER_BLUE
          ? FLICK_HUMAN_DEFAULT_COLOR
          : object.color;
      if (rig?.rigType === "mixamo") {
        return { ...object, color, characterSource: "asset" as const, assetRefId };
      }
      return {
        ...object,
        color,
        characterSource: "asset" as const,
        assetRefId,
        characterRig: {
          rigType: "mixamo" as const,
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
      ? { ...object, nativeSource: { engine: "blender" as const, objectId: object.id, provisioned: false } }
      : object,
  );
  return migrateDirectorProduction(migratedProject);
}

export function withReconciledProduction(project: DirectorProject): DirectorProject {
  if (!project.production || !getDirectorProductionIssues(project).length) return project;
  return { ...project, production: reconcileDirectorProduction(project) };
}