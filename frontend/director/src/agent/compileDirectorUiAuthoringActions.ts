/**
 * Compilers that translate Stage UI mutator inputs into Director authoring
 * actions so UI edits and Agent edits share applyDirectorAuthoringActions.
 *
 * Every compiler is total over the inputs the UI actually produces; when a
 * legacy patch carries semantics the authoring contract cannot express yet
 * (camera captures, light type resets, rotated camera rigs, "authored" root
 * motion), the compiler returns null and the store keeps the historical
 * commitMutation path for that call only. World collection upserts compile
 * inline in directorStore (they need live capacity/lock/asset checks).
 */

import type { DirectorAuthoringAction } from "@director/agent-engine/authoring";
import { isDirectorCharacterMotionId } from "@director/agent-engine/character-motions";
import type {
  DirectorCameraShot,
  DirectorCharacterMotionState,
  DirectorLight,
  DirectorLightType,
  DirectorProject,
  DirectorTransform,
  SceneSettings,
} from "../comprehensive/editor/schema/directorProject";
import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
  VIEWPORT_CAMERA_FRUSTUM_DEPTH,
  getCameraViewSnapshotFromShot,
  getFocalLengthFromVerticalFov,
  getVerticalFovFromFocalLength,
  normalizeDirectorCameraAction,
  normalizeDirectorCameraOptics,
  type CameraViewSnapshot,
} from "../comprehensive/editor/schema/cameraGeometry";
import { createDirectorLight } from "@director/project-schema";
import { DIRECTOR_DUPLICATE_POSITION_OFFSET_M } from "@director/agent-engine/authoring";
import { formatSceneItemName, getNextSequentialId } from "../comprehensive/editor/store/directorStoreUtils";
import { getDirectorObjectFocusTarget } from "../comprehensive/editor/schema/cameraTarget";
import type { DirectorClipboardEntry, DirectorWorldSettingsPatch } from "../comprehensive/editor/store/directorStore";

type UpdateCameraAction = Extract<DirectorAuthoringAction, { action: "update_camera" }>;
type DuplicateObjectsAction = Extract<DirectorAuthoringAction, { action: "duplicate_objects" }>;
type AddCameraAction = Extract<DirectorAuthoringAction, { action: "add_camera" }>;
type SetSceneAction = Extract<DirectorAuthoringAction, { action: "set_scene" }>;
type SetWorldSettingsAction = Extract<DirectorAuthoringAction, { action: "set_world_settings" }>;
type CreateObjectListAction = Extract<DirectorAuthoringAction, { action: "create_object_list" }>;
type AddObjectsToObjectListAction = Extract<DirectorAuthoringAction, { action: "add_objects_to_object_list" }>;
type RemoveObjectsFromObjectListsAction = Extract<
  DirectorAuthoringAction,
  { action: "remove_objects_from_object_lists" }
>;
type RenameObjectListAction = Extract<DirectorAuthoringAction, { action: "rename_object_list" }>;

/** Camera patch shape accepted by the DirectorStore updateCamera mutator. */
export type DirectorCameraShotPatch = Partial<DirectorCameraShot> & {
  transform?: DirectorTransform;
  target?: [number, number, number];
};

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function clampFocalLengthMm(value: number) {
  return Math.min(200, Math.max(12, value));
}

const CAMERA_UPDATE_SUPPORTED_KEYS = new Set([
  "name",
  "fov",
  "focalLengthMm",
  "sensorFormat",
  "apertureFStop",
  "focusDistanceM",
  "shutterAngle",
  "iso",
  "nearClipM",
  "farClipM",
  "anamorphicSqueeze",
  "aspectRatio",
  "handheldShake",
  "action",
  "target",
  "targetMode",
  "targetObjectId",
  "transform",
]);

/**
 * Compile a Stage camera-panel patch into an update_camera authoring action.
 * Returns null when the patch carries fields authoring cannot express
 * (captures, animation, rotated rig transforms, inconsistent fov), so the
 * caller keeps the legacy mutation for that call.
 */
export function compileDirectorCameraUpdateAction(
  project: DirectorProject,
  cameraId: string,
  patch: DirectorCameraShotPatch,
): UpdateCameraAction | null {
  const camera = project.cameras.find((item) => item.id === cameraId);
  if (!camera) return null;
  const definedKeys = Object.keys(patch).filter((key) => patch[key as keyof DirectorCameraShotPatch] !== undefined);
  if (!definedKeys.length) return null;
  if (definedKeys.some((key) => !CAMERA_UPDATE_SUPPORTED_KEYS.has(key))) return null;

  const authoringPatch: UpdateCameraAction["patch"] = {};

  // Authoring recomputes fov from focal length after every patch. Route the
  // patch only when that recomputed fov matches what the legacy mutator would
  // have stored, so no camera silently changes its field of view.
  const nextFocalLengthMm = clampFocalLengthMm(
    patch.focalLengthMm ?? camera.focalLengthMm ?? DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  );
  const nextAspectRatio = patch.aspectRatio ?? camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const nextSensorFormat = patch.sensorFormat ?? camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const recomputedFov = getVerticalFovFromFocalLength(nextFocalLengthMm, nextAspectRatio, nextSensorFormat);
  if ((patch.fov ?? camera.fov) !== recomputedFov) return null;

  if (patch.transform) {
    const sameRotation = jsonEqual(patch.transform.rotation, camera.transform.rotation);
    const sameScale = jsonEqual(patch.transform.scale, camera.transform.scale);
    // update_camera only moves the rig position; rotated/scaled rigs from the
    // viewport gizmo keep the legacy writer.
    if (!sameRotation || !sameScale) return null;
  }
  if (patch.transform || patch.target) {
    const nextRigPosition = patch.transform?.position ?? camera.transform.position;
    const nextTarget = patch.target ?? camera.target;
    const rigToTargetDistance = Math.hypot(
      nextTarget[0] - nextRigPosition[0],
      nextTarget[1] - nextRigPosition[1],
      nextTarget[2] - nextRigPosition[2],
    );
    // The rig↔view round trip flips direction inside the frustum depth; keep
    // those extreme close-ups on the legacy writer.
    if (rigToTargetDistance <= VIEWPORT_CAMERA_FRUSTUM_DEPTH + 1e-4) return null;
    const view = getCameraViewSnapshotFromShot({
      ...camera,
      transform: { ...camera.transform, position: [...nextRigPosition] },
      target: [...nextTarget],
    });
    authoringPatch.position = view.position;
    authoringPatch.target = [...nextTarget];
  }

  if (patch.targetMode !== undefined || patch.targetObjectId !== undefined) {
    const nextMode = patch.targetMode ?? camera.targetMode ?? (camera.targetObjectId ? "object" : "manual");
    if (nextMode === "object") {
      const targetObjectId = patch.targetObjectId ?? camera.targetObjectId;
      if (!targetObjectId || !project.objects.some((object) => object.id === targetObjectId)) return null;
      authoringPatch.target_object_id = targetObjectId;
    } else {
      authoringPatch.target_object_id = null;
    }
  }

  if (patch.name !== undefined) authoringPatch.name = patch.name;
  if (patch.focalLengthMm !== undefined) authoringPatch.focal_length_mm = nextFocalLengthMm;
  if (patch.sensorFormat !== undefined) authoringPatch.sensor_format = patch.sensorFormat;
  if (patch.apertureFStop !== undefined) authoringPatch.aperture_f_stop = patch.apertureFStop;
  if (patch.focusDistanceM !== undefined) authoringPatch.focus_distance_m = patch.focusDistanceM;
  if (patch.shutterAngle !== undefined) authoringPatch.shutter_angle = patch.shutterAngle;
  if (patch.iso !== undefined) authoringPatch.iso = patch.iso;
  if (patch.nearClipM !== undefined) authoringPatch.near_clip_m = patch.nearClipM;
  if (patch.farClipM !== undefined) authoringPatch.far_clip_m = patch.farClipM;
  if (patch.anamorphicSqueeze !== undefined) authoringPatch.anamorphic_squeeze = patch.anamorphicSqueeze;
  if (patch.aspectRatio !== undefined) authoringPatch.aspect_ratio = patch.aspectRatio;
  if (patch.handheldShake !== undefined) authoringPatch.handheld_shake = patch.handheldShake;
  if (patch.action !== undefined) {
    // normalizeDirectorCameraAction returns a fully-populated discriminated
    // action; the frontend type stays permissive for panel drafts.
    authoringPatch.action = normalizeDirectorCameraAction(patch.action) as UpdateCameraAction["patch"]["action"];
  }

  if (!Object.keys(authoringPatch).length) return null;
  return { action: "update_camera", camera_id: cameraId, patch: authoringPatch };
}

/**
 * Compile the Stage "add camera" flow into an add_camera authoring action,
 * inheriting optics from the active camera like the legacy mutator did.
 */
export function compileDirectorAddCameraShotAction(
  project: DirectorProject,
  snapshot?: CameraViewSnapshot,
): { action: AddCameraAction; cameraId: string; rigObjectId: string } {
  const cameraIndex = project.cameras.length + 1;
  const usedIds = [
    ...project.cameras.map((camera) => camera.id),
    ...project.objects.map((object) => object.id),
    ...project.assets.map((asset) => asset.id),
    ...(project.lights ?? []).map((light) => light.id),
  ];
  const cameraId = getNextSequentialId(usedIds, "cam_", cameraIndex);
  const rigObjectId = getNextSequentialId(usedIds, "cam_object_", cameraIndex);
  const sourceCamera = project.cameras.find((camera) => camera.id === project.activeCameraId);
  const sourceOptics = normalizeDirectorCameraOptics(sourceCamera ?? {});
  const aspectRatio = DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const sensorFormat = sourceCamera?.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const focalLengthMm = snapshot
    ? getFocalLengthFromVerticalFov(snapshot.fov, aspectRatio, sensorFormat)
    : clampFocalLengthMm(sourceCamera?.focalLengthMm ?? DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM);
  const initialSnapshot = snapshot ?? {
    ...DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
    position: [
      DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.position[0] + (cameraIndex - 1) * 1.2,
      DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.position[1],
      DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.position[2],
    ] as [number, number, number],
  };
  return {
    cameraId,
    rigObjectId,
    action: {
      action: "add_camera",
      id: cameraId,
      object_id: rigObjectId,
      name: formatSceneItemName("机位", cameraIndex),
      position: [...initialSnapshot.position],
      target: [...initialSnapshot.target],
      focal_length_mm: focalLengthMm,
      sensor_format: sensorFormat,
      aperture_f_stop: sourceOptics.apertureFStop,
      focus_distance_m: sourceOptics.focusDistanceM,
      shutter_angle: sourceOptics.shutterAngle,
      iso: sourceOptics.iso,
      near_clip_m: sourceOptics.nearClipM,
      far_clip_m: sourceOptics.farClipM,
      anamorphic_squeeze: sourceOptics.anamorphicSqueeze,
      aspect_ratio: aspectRatio,
      handheld_shake: sourceCamera?.handheldShake ?? DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
      action_mode: normalizeDirectorCameraAction(sourceCamera?.action) as AddCameraAction["action_mode"],
      activate: true,
    },
  };
}

/**
 * Compile a character motion assignment (or clear) into authoring actions.
 * Returns null for states authoring cannot express: unknown clip ids and the
 * migration-only "authored" root motion.
 */
export function compileDirectorCharacterMotionAction(
  objectId: string,
  motion: DirectorCharacterMotionState | undefined,
): DirectorAuthoringAction | null {
  if (!motion) return { action: "clear_character_motion", object_id: objectId, force: true };
  if (!isDirectorCharacterMotionId(motion.clipId)) return null;
  if (motion.rootMotion !== undefined && motion.rootMotion !== "in-place") return null;
  return {
    action: "set_character_motion",
    object_id: objectId,
    clip_id: motion.clipId,
    enabled: motion.enabled,
    loop: motion.loop,
    speed: motion.speed,
    weight: motion.weight,
    start_frame: motion.startFrame,
    ...(motion.blendInS !== undefined ? { blend_in_s: motion.blendInS } : {}),
    ...(motion.blendOutS !== undefined ? { blend_out_s: motion.blendOutS } : {}),
    ...(motion.rootMotion !== undefined ? { root_motion: motion.rootMotion } : {}),
    force: true,
  };
}

/** Compile the Stage "add light" flow into an add_light authoring action. */
export function compileDirectorAddLightAction(
  project: DirectorProject,
  type: DirectorLightType,
): { action: DirectorAuthoringAction; lightId: string } {
  const lights = project.lights ?? [];
  const lightId = getNextSequentialId(
    [
      ...lights.map((light) => light.id),
      ...project.assets.map((asset) => asset.id),
      ...project.objects.map((object) => object.id),
      ...project.cameras.map((camera) => camera.id),
    ],
    "light_",
    lights.length + 1,
  );
  return {
    lightId,
    action: { action: "add_light", light: createDirectorLight(lightId, type) },
  };
}

const LIGHT_UPDATE_SUPPORTED_KEYS = new Set([
  "name",
  "type",
  "visible",
  "locked",
  "color",
  "intensity",
  "position",
  "target",
  "groundColor",
  "distance",
  "decay",
  "angle",
  "penumbra",
  "width",
  "height",
  "castShadow",
]);

/**
 * Compile a light patch into an update_light authoring action. Type changes
 * return null because the legacy mutator resets type-specific fields via
 * createDirectorLight, which update_light cannot express yet.
 */
export function compileDirectorLightUpdateAction(
  light: DirectorLight,
  patch: Partial<Omit<DirectorLight, "id">>,
): DirectorAuthoringAction | null {
  const definedKeys = Object.keys(patch).filter((key) => patch[key as keyof Omit<DirectorLight, "id">] !== undefined);
  if (!definedKeys.length) return null;
  if (definedKeys.some((key) => !LIGHT_UPDATE_SUPPORTED_KEYS.has(key))) return null;
  if (patch.type !== undefined && patch.type !== light.type) return null;
  const authoringPatch: Record<string, unknown> = {};
  definedKeys.forEach((key) => {
    authoringPatch[key] = structuredClone(patch[key as keyof Omit<DirectorLight, "id">]);
  });
  return {
    action: "update_light",
    light_id: light.id,
    patch: authoringPatch,
    force: true,
  } as DirectorAuthoringAction;
}

/**
 * Compile a world settings patch into a set_world_settings authoring action.
 * The store's updateWorldSettings routes every expressible patch through this
 * compiler; `null` (an effectively empty patch) keeps the local merge.
 */
export function compileDirectorWorldSettingsAction(patch: DirectorWorldSettingsPatch): SetWorldSettingsAction | null {
  const settings: SetWorldSettingsAction["settings"] = {};
  if (patch.enabled !== undefined) settings.enabled = patch.enabled;
  if (patch.seed !== undefined) settings.seed = patch.seed;
  if (patch.wind) {
    const wind: NonNullable<SetWorldSettingsAction["settings"]["wind"]> = {};
    if (patch.wind.directionDegrees !== undefined) wind.direction_degrees = patch.wind.directionDegrees;
    if (patch.wind.speedMps !== undefined) wind.speed_mps = patch.wind.speedMps;
    if (patch.wind.gustiness !== undefined) wind.gustiness = patch.wind.gustiness;
    if (patch.wind.turbulence !== undefined) wind.turbulence = patch.wind.turbulence;
    if (Object.keys(wind).length) settings.wind = wind;
  }
  if (patch.timeOfDay) {
    const timeOfDay: NonNullable<SetWorldSettingsAction["settings"]["time_of_day"]> = {};
    if (patch.timeOfDay.mode !== undefined) timeOfDay.mode = patch.timeOfDay.mode;
    if (patch.timeOfDay.hours !== undefined) timeOfDay.hours = patch.timeOfDay.hours;
    if (patch.timeOfDay.cycleMinutes !== undefined) timeOfDay.cycle_minutes = patch.timeOfDay.cycleMinutes;
    if (patch.timeOfDay.drivesSky !== undefined) timeOfDay.drives_sky = patch.timeOfDay.drivesSky;
    if (Object.keys(timeOfDay).length) settings.time_of_day = timeOfDay;
  }
  if (patch.weather) {
    const weather: NonNullable<SetWorldSettingsAction["settings"]["weather"]> = {};
    if (patch.weather.preset !== undefined) weather.preset = patch.weather.preset;
    if (patch.weather.intensity !== undefined) weather.intensity = patch.weather.intensity;
    if (patch.weather.wetness !== undefined) weather.wetness = patch.weather.wetness;
    if (patch.weather.cloudCover !== undefined) weather.cloud_cover = patch.weather.cloudCover;
    if (patch.weather.evolution !== undefined) {
      // The panel always supplies both fields; the authoring reducer keeps the
      // previous period when period_seconds is omitted and treats null as
      // removal (the UI expresses "off" as mode "static" instead).
      weather.evolution = patch.weather.evolution
        ? {
            mode: patch.weather.evolution.mode,
            ...(patch.weather.evolution.periodSeconds !== undefined
              ? { period_seconds: patch.weather.evolution.periodSeconds }
              : {}),
          }
        : null;
    }
    if (Object.keys(weather).length) settings.weather = weather;
  }
  if (!Object.keys(settings).length) return null;
  return { action: "set_world_settings", settings };
}

const SCENE_NULLABLE_KEYS = new Set(["timeline", "clippingPlanes", "objectLayers", "annotations", "measurements"]);
const SCENE_SUPPORTED_KEYS = new Set([
  "scale",
  "position",
  "rotation",
  "backgroundColor",
  "panoramaYaw",
  "panoramaRadius",
  "showLabels",
  "snapToGrid",
  "showGround",
  "groundOpacity",
  "groundHeight",
  "fog",
  "environment",
  ...SCENE_NULLABLE_KEYS,
]);

/**
 * Compile a scene settings patch into a set_scene authoring action. Undefined
 * values on nullable collections map to null (authoring's delete marker);
 * anything else unexpressible returns null for the legacy path.
 */
export function compileDirectorSceneUpdateAction(patch: Partial<SceneSettings>): SetSceneAction | null {
  const scenePatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!SCENE_SUPPORTED_KEYS.has(key)) return null;
    if (value === undefined) {
      if (!SCENE_NULLABLE_KEYS.has(key)) return null;
      scenePatch[key] = null;
    } else {
      scenePatch[key] = structuredClone(value);
    }
  }
  if (!Object.keys(scenePatch).length) return null;
  return { action: "set_scene", patch: scenePatch } as SetSceneAction;
}

/** Contract bounds shared by the object-list authoring actions. */
const OBJECT_LIST_LABEL_MAX_CHARS = 240;
const OBJECT_LIST_MAX_MEMBERS_PER_ACTION = 256;

/**
 * Filter requested ids down to live project objects the object-list actions
 * accept, in project order (the same membership the legacy writer computes).
 * Crowd members are excluded when excludeCrowdMembers is set because the
 * authoring contract rejects them.
 */
function collectObjectListMemberIds(
  project: DirectorProject,
  objectIds: string[],
  options: { excludeCrowdMembers: boolean },
): string[] | null {
  const requested = new Set(objectIds);
  const members = project.objects
    .filter((object) => requested.has(object.id) && !(options.excludeCrowdMembers && object.crowdId))
    .map((object) => object.id);
  if (!members.length || members.length > OBJECT_LIST_MAX_MEMBERS_PER_ACTION) return null;
  return members;
}

/**
 * Compile the Stage tree "create object list" flow into a create_object_list
 * authoring action, allocating the same sequential object_list_N id the
 * legacy writer would. Returns null when the legacy writer would no-op
 * (blank label, no live non-crowd member) or the input exceeds the contract
 * bounds, so the caller keeps the historical mutation for that call.
 */
export function compileDirectorCreateObjectListAction(
  project: DirectorProject,
  objectIds: string[],
  label: string,
): { action: CreateObjectListAction; listId: string } | null {
  const normalizedLabel = label.trim();
  if (!normalizedLabel || normalizedLabel.length > OBJECT_LIST_LABEL_MAX_CHARS) return null;
  const members = collectObjectListMemberIds(project, objectIds, { excludeCrowdMembers: true });
  if (!members) return null;
  const listId = getNextSequentialId(
    project.objects.map((object) => object.objectListId).filter((value): value is string => typeof value === "string"),
    "object_list_",
  );
  return {
    listId,
    action: { action: "create_object_list", list_id: listId, label: normalizedLabel, object_ids: members },
  };
}

/**
 * Compile a Stage tree "add to object list" into an add_objects_to_object_list
 * authoring action. Returns null when the list does not exist or no live
 * non-crowd member remains, matching the legacy writer's no-op.
 */
export function compileDirectorAddObjectsToObjectListAction(
  project: DirectorProject,
  objectIds: string[],
  objectListId: string,
): AddObjectsToObjectListAction | null {
  const normalizedListId = objectListId.trim();
  if (!normalizedListId || !project.objects.some((object) => object.objectListId === normalizedListId)) return null;
  const members = collectObjectListMemberIds(project, objectIds, { excludeCrowdMembers: true });
  if (!members) return null;
  return { action: "add_objects_to_object_list", list_id: normalizedListId, object_ids: members };
}

/**
 * Compile a Stage tree "remove from list" into a
 * remove_objects_from_object_lists authoring action. Returns null when no
 * requested id resolves to a live object, matching the legacy no-op.
 */
export function compileDirectorRemoveObjectsFromObjectListsAction(
  project: DirectorProject,
  objectIds: string[],
): RemoveObjectsFromObjectListsAction | null {
  const members = collectObjectListMemberIds(project, objectIds, { excludeCrowdMembers: false });
  if (!members) return null;
  return { action: "remove_objects_from_object_lists", object_ids: members };
}

/**
 * Compile a Stage tree list rename into a rename_object_list authoring
 * action. Returns null for blank/oversized labels and unknown lists,
 * matching the legacy writer's no-op.
 */
export function compileDirectorRenameObjectListAction(
  project: DirectorProject,
  objectListId: string,
  label: string,
): RenameObjectListAction | null {
  const normalizedListId = objectListId.trim();
  const normalizedLabel = label.trim();
  if (!normalizedListId || !normalizedLabel || normalizedLabel.length > OBJECT_LIST_LABEL_MAX_CHARS) return null;
  if (!project.objects.some((object) => object.objectListId === normalizedListId)) return null;
  return { action: "rename_object_list", list_id: normalizedListId, label: normalizedLabel };
}

/**
 * Compile a Stage clipboard paste into one duplicate_objects authoring action.
 * The authoring engine duplicates live objects, so the compiler routes only
 * pastes whose result provably matches the legacy clipboard writer:
 * - every clipboard snapshot (object, and linked camera shot for camera
 *   entries) must still equal its live project entity, otherwise the paste
 *   must reproduce copy-time state and keeps the legacy writer;
 * - Blender-native objects without an importable model asset keep the legacy
 *   writer (duplicate_objects rejects them; legacy copy filtered them too);
 * - object-focused cameras keep the legacy writer when a copied source is
 *   their focus target (legacy retargets existing cameras at the duplicate)
 *   or when their stored target drifted from the UI focus-height recompute.
 */
export function compileDirectorPasteClipboardActions(
  project: DirectorProject,
  clipboard: DirectorClipboardEntry[],
  clipboardPasteCount: number,
): DuplicateObjectsAction | null {
  if (!clipboard.length || clipboard.length > 64) return null;
  const offset = DIRECTOR_DUPLICATE_POSITION_OFFSET_M * (clipboardPasteCount + 1);
  if (!Number.isFinite(offset) || Math.abs(offset) > 100) return null;
  const copiedObjectIds = clipboard.map((entry) => entry.object.id);
  const copiedObjectIdSet = new Set(copiedObjectIds);
  if (copiedObjectIdSet.size !== clipboard.length) return null;

  for (const entry of clipboard) {
    const liveObject = project.objects.find((object) => object.id === entry.object.id);
    if (!liveObject || !jsonEqual(entry.object, liveObject)) return null;
    if (liveObject.nativeSource) {
      const asset = liveObject.assetRefId
        ? project.assets.find((item) => item.id === liveObject.assetRefId)
        : undefined;
      if (!asset || asset.sourceType !== "model") return null;
    }
    if (entry.object.kind === "camera") {
      // Camera objects with a missing linked shot paste as plain objects in
      // the legacy writer; duplicate_objects rejects them instead.
      if (!entry.camera || !entry.object.linkedCameraId) return null;
      const liveCamera = project.cameras.find((camera) => camera.id === entry.object.linkedCameraId);
      if (!liveCamera || !jsonEqual(entry.camera, liveCamera)) return null;
    }
  }

  for (const camera of project.cameras) {
    if (camera.targetMode !== "object" || !camera.targetObjectId) continue;
    if (copiedObjectIdSet.has(camera.targetObjectId)) return null;
    const targetObject = project.objects.find((object) => object.id === camera.targetObjectId);
    if (!targetObject) return null;
    if (!jsonEqual(camera.target, getDirectorObjectFocusTarget(targetObject))) return null;
  }

  return {
    action: "duplicate_objects",
    object_ids: copiedObjectIds,
    offset_m: offset,
  };
}
