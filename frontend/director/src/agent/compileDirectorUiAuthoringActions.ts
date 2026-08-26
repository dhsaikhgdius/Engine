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
import { formatSceneItemName, getNextSequentialId } from "../comprehensive/editor/store/directorStoreUtils";
import type { DirectorWorldSettingsPatch } from "../comprehensive/editor/store/directorStore";

type UpdateCameraAction = Extract<DirectorAuthoringAction, { action: "update_camera" }>;
type AddCameraAction = Extract<DirectorAuthoringAction, { action: "add_camera" }>;
type SetSceneAction = Extract<DirectorAuthoringAction, { action: "set_scene" }>;
type SetWorldSettingsAction = Extract<DirectorAuthoringAction, { action: "set_world_settings" }>;

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
