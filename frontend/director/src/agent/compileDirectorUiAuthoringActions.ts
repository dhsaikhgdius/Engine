/**
 * Compilers that translate Stage UI mutator inputs into Director authoring
 * actions so UI edits and Agent edits share applyDirectorAuthoringActions.
 *
 * Every compiler is total over the inputs the UI actually produces; when a
 * legacy patch carries semantics the authoring contract cannot express yet
 * (camera captures, light type resets, rotated camera rigs, "authored" root
 * motion), the compiler returns null / "legacy" and the store keeps the
 * historical commitMutation path for that call only.
 */

import type { DirectorAuthoringAction } from "@director/agent-engine/authoring";
import { isDirectorCharacterMotionId } from "@director/agent-engine/character-motions";
import { clamp } from "@director/protocol/primitives";
import type {
  DirectorAssetRef,
  DirectorCameraShot,
  DirectorCharacterMotionState,
  DirectorLight,
  DirectorLightType,
  DirectorProject,
  DirectorTimeline,
  DirectorTimelineAudioClip,
  DirectorTimelineAudioTrack,
  DirectorTransform,
  DirectorWorldEffect,
  DirectorWorldRoad,
  DirectorWorldWaterBody,
  DirectorWorldWildlifeGroup,
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

/** Tri-state result for upsert compilers: dispatch, skip (no change), or keep the legacy writer. */
export type DirectorUiUpsertCompilation =
  { kind: "dispatch"; action: DirectorAuthoringAction } | { kind: "noop" } | { kind: "legacy" };

const LEGACY: DirectorUiUpsertCompilation = { kind: "legacy" };
const NOOP: DirectorUiUpsertCompilation = { kind: "noop" };

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

/** Compile a world settings patch into a set_world_settings authoring action. */
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
    if (Object.keys(weather).length) settings.weather = weather;
  }
  if (!Object.keys(settings).length) return null;
  return { action: "set_world_settings", settings };
}

/**
 * Guards shared by every world upsert compiler: adds must match the defaults
 * authoring stamps on new entries, and updates on locked entries can only be
 * the unlock patch itself.
 */
function guardWorldEntryUpsert(
  existing: { locked: boolean } | undefined,
  entry: { visible: boolean; locked: boolean },
  patch: Record<string, unknown>,
): DirectorUiUpsertCompilation | null {
  if (!existing) {
    if (!entry.visible || entry.locked) return LEGACY;
    return null;
  }
  if (!Object.keys(patch).length) return NOOP;
  if (existing.locked) {
    const unlockOnly = Object.keys(patch).length === 1 && patch.locked === false;
    if (!unlockOnly) return LEGACY;
  }
  return null;
}

export function compileDirectorWorldEffectUpsertAction(
  existing: DirectorWorldEffect | undefined,
  effect: DirectorWorldEffect,
): DirectorUiUpsertCompilation {
  if (!existing) {
    const guard = guardWorldEntryUpsert(existing, effect, {});
    if (guard) return guard;
    return {
      kind: "dispatch",
      action: {
        action: "add_world_effect",
        id: effect.id,
        name: effect.name,
        kind: effect.kind,
        anchor: { object_id: effect.anchor.objectId ?? null, position: [...effect.anchor.position] },
        shape: structuredClone(effect.shape),
        intensity: effect.intensity,
        size_scale: effect.sizeScale,
        speed_scale: effect.speedScale,
        ...(effect.colorTint !== undefined ? { color_tint: effect.colorTint } : {}),
        wind_influence: effect.windInfluence,
        seed_offset: effect.seedOffset,
      },
    };
  }
  if (!jsonEqual(existing.createdAt, effect.createdAt)) return LEGACY;
  const patch: Record<string, unknown> = {};
  if (existing.name !== effect.name) patch.name = effect.name;
  if (existing.kind !== effect.kind) patch.kind = effect.kind;
  if (!jsonEqual(existing.anchor, effect.anchor)) {
    patch.anchor = { object_id: effect.anchor.objectId ?? null, position: [...effect.anchor.position] };
  }
  if (!jsonEqual(existing.shape, effect.shape)) patch.shape = structuredClone(effect.shape);
  if (existing.intensity !== effect.intensity) patch.intensity = effect.intensity;
  if (existing.sizeScale !== effect.sizeScale) patch.size_scale = effect.sizeScale;
  if (existing.speedScale !== effect.speedScale) patch.speed_scale = effect.speedScale;
  if (!jsonEqual(existing.colorTint, effect.colorTint)) patch.color_tint = effect.colorTint ?? null;
  if (existing.windInfluence !== effect.windInfluence) patch.wind_influence = effect.windInfluence;
  if (existing.seedOffset !== effect.seedOffset) patch.seed_offset = effect.seedOffset;
  if (existing.visible !== effect.visible) patch.visible = effect.visible;
  if (existing.locked !== effect.locked) patch.locked = effect.locked;
  const guard = guardWorldEntryUpsert(existing, effect, patch);
  if (guard) return guard;
  return {
    kind: "dispatch",
    action: { action: "update_world_effect", effect_id: effect.id, patch } as DirectorAuthoringAction,
  };
}

function compileWorldRiverInput(river: NonNullable<DirectorWorldWaterBody["river"]>) {
  return {
    points: river.points.map((point) => [...point] as [number, number, number]),
    width_m: river.widthM,
    ...(river.widthProfile ? { width_profile: [...river.widthProfile] } : {}),
  };
}

export function compileDirectorWorldWaterBodyUpsertAction(
  existing: DirectorWorldWaterBody | undefined,
  body: DirectorWorldWaterBody,
): DirectorUiUpsertCompilation {
  if (!existing) {
    const guard = guardWorldEntryUpsert(existing, body, {});
    if (guard) return guard;
    return {
      kind: "dispatch",
      action: {
        action: "add_world_water_body",
        id: body.id,
        name: body.name,
        surface: {
          center: [...body.surface.center],
          size_x: body.surface.sizeX,
          size_z: body.surface.sizeZ,
          rotation_degrees: body.surface.rotationDegrees,
        },
        ...(body.river ? { river: compileWorldRiverInput(body.river) } : {}),
        wave_amplitude: body.waveAmplitude,
        wave_length_m: body.waveLengthM,
        flow_direction_degrees: body.flowDirectionDegrees,
        flow_speed_mps: body.flowSpeedMps,
        color_shallow: body.colorShallow,
        color_deep: body.colorDeep,
        opacity: body.opacity,
        foam_intensity: body.foamIntensity,
      },
    };
  }
  const patch: Record<string, unknown> = {};
  if (existing.name !== body.name) patch.name = body.name;
  if (!jsonEqual(existing.surface, body.surface)) {
    patch.surface = {
      center: [...body.surface.center],
      size_x: body.surface.sizeX,
      size_z: body.surface.sizeZ,
      rotation_degrees: body.surface.rotationDegrees,
    };
  }
  if (!jsonEqual(existing.river, body.river)) {
    patch.river = body.river ? compileWorldRiverInput(body.river) : null;
  }
  if (existing.waveAmplitude !== body.waveAmplitude) patch.wave_amplitude = body.waveAmplitude;
  if (existing.waveLengthM !== body.waveLengthM) patch.wave_length_m = body.waveLengthM;
  if (existing.flowDirectionDegrees !== body.flowDirectionDegrees)
    patch.flow_direction_degrees = body.flowDirectionDegrees;
  if (existing.flowSpeedMps !== body.flowSpeedMps) patch.flow_speed_mps = body.flowSpeedMps;
  if (existing.colorShallow !== body.colorShallow) patch.color_shallow = body.colorShallow;
  if (existing.colorDeep !== body.colorDeep) patch.color_deep = body.colorDeep;
  if (existing.opacity !== body.opacity) patch.opacity = body.opacity;
  if (existing.foamIntensity !== body.foamIntensity) patch.foam_intensity = body.foamIntensity;
  if (existing.visible !== body.visible) patch.visible = body.visible;
  if (existing.locked !== body.locked) patch.locked = body.locked;
  const guard = guardWorldEntryUpsert(existing, body, patch);
  if (guard) return guard;
  return {
    kind: "dispatch",
    action: { action: "update_world_water_body", body_id: body.id, patch } as DirectorAuthoringAction,
  };
}

/** Species whose absent altitude would gain the authoring default band on add. */
const WORLD_WILDLIFE_ALTITUDE_DEFAULT_SPECIES = new Set(["birds", "butterflies"]);

export function compileDirectorWorldWildlifeUpsertAction(
  existing: DirectorWorldWildlifeGroup | undefined,
  group: DirectorWorldWildlifeGroup,
): DirectorUiUpsertCompilation {
  if (!existing) {
    const guard = guardWorldEntryUpsert(existing, group, {});
    if (guard) return guard;
    // add_world_wildlife_group backfills the default flight band when altitude
    // is omitted; keep such entries on the legacy writer to avoid drift.
    if (!group.altitude && WORLD_WILDLIFE_ALTITUDE_DEFAULT_SPECIES.has(group.species)) return LEGACY;
    return {
      kind: "dispatch",
      action: {
        action: "add_world_wildlife_group",
        id: group.id,
        name: group.name,
        species: group.species,
        count: group.count,
        area: { center: [...group.area.center], radius: group.area.radius },
        ...(group.altitude ? { altitude: { min_m: group.altitude.minM, max_m: group.altitude.maxM } } : {}),
        speed_scale: group.speedScale,
        size_scale: group.sizeScale,
        ...(group.assetId ? { asset_id: group.assetId } : {}),
        seed_offset: group.seedOffset,
      },
    };
  }
  const patch: Record<string, unknown> = {};
  if (existing.name !== group.name) patch.name = group.name;
  if (existing.species !== group.species) patch.species = group.species;
  if (existing.count !== group.count) patch.count = group.count;
  if (!jsonEqual(existing.area, group.area)) {
    patch.area = { center: [...group.area.center], radius: group.area.radius };
  }
  if (!jsonEqual(existing.altitude, group.altitude)) {
    patch.altitude = group.altitude ? { min_m: group.altitude.minM, max_m: group.altitude.maxM } : null;
  }
  if (existing.speedScale !== group.speedScale) patch.speed_scale = group.speedScale;
  if (existing.sizeScale !== group.sizeScale) patch.size_scale = group.sizeScale;
  if (!jsonEqual(existing.assetId, group.assetId)) patch.asset_id = group.assetId ?? null;
  if (existing.seedOffset !== group.seedOffset) patch.seed_offset = group.seedOffset;
  if (existing.visible !== group.visible) patch.visible = group.visible;
  if (existing.locked !== group.locked) patch.locked = group.locked;
  const guard = guardWorldEntryUpsert(existing, group, patch);
  if (guard) return guard;
  return {
    kind: "dispatch",
    action: { action: "update_world_wildlife_group", group_id: group.id, patch } as DirectorAuthoringAction,
  };
}

export function compileDirectorWorldRoadUpsertAction(
  existing: DirectorWorldRoad | undefined,
  road: DirectorWorldRoad,
): DirectorUiUpsertCompilation {
  if (!existing) {
    const guard = guardWorldEntryUpsert(existing, road, {});
    if (guard) return guard;
    return {
      kind: "dispatch",
      action: {
        action: "add_world_road",
        id: road.id,
        name: road.name,
        points: road.points.map((point) => [...point] as [number, number, number]),
        width_m: road.widthM,
        loop: road.loop,
        vehicle_count: road.vehicleCount,
        speed_kph: road.speedKph,
        show_surface: road.showSurface,
        seed_offset: road.seedOffset,
      },
    };
  }
  const patch: Record<string, unknown> = {};
  if (existing.name !== road.name) patch.name = road.name;
  if (!jsonEqual(existing.points, road.points)) {
    patch.points = road.points.map((point) => [...point] as [number, number, number]);
  }
  if (existing.widthM !== road.widthM) patch.width_m = road.widthM;
  if (existing.loop !== road.loop) patch.loop = road.loop;
  if (existing.vehicleCount !== road.vehicleCount) patch.vehicle_count = road.vehicleCount;
  if (existing.speedKph !== road.speedKph) patch.speed_kph = road.speedKph;
  if (existing.showSurface !== road.showSurface) patch.show_surface = road.showSurface;
  if (existing.seedOffset !== road.seedOffset) patch.seed_offset = road.seedOffset;
  if (existing.visible !== road.visible) patch.visible = road.visible;
  if (existing.locked !== road.locked) patch.locked = road.locked;
  const guard = guardWorldEntryUpsert(existing, road, patch);
  if (guard) return guard;
  return {
    kind: "dispatch",
    action: { action: "update_world_road", road_id: road.id, patch } as DirectorAuthoringAction,
  };
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

/*
 * Timeline audio edits have no dedicated authoring action; both the UI and the
 * Agent express them as a set_scene timeline replacement. These builders keep
 * the historical DirectorStore semantics (track auto-creation, clamping,
 * sanitizing) so the dispatched timeline is byte-identical to the legacy
 * in-batch writer's result.
 */

const MAX_TIMELINE_AUDIO_TRACKS = 8;
const MAX_TIMELINE_AUDIO_CLIPS_PER_TRACK = 128;
const MAX_TIMELINE_AUDIO_FRAME = 1_000_000;

/** Input shape for adding an audio clip to the stage timeline. */
export type DirectorTimelineAudioClipAddInput = {
  mediaId: string;
  name: string;
  sourceUrl?: string;
  /** Defaults to the current playhead frame. */
  startFrame?: number;
  durationFrames: number;
  sourceDurationSec?: number;
};

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

function withTimelineAudioTracks(timeline: DirectorTimeline, audioTracks: DirectorTimelineAudioTrack[]) {
  return { ...timeline, audioTracks };
}

/**
 * Compile a stage "add audio clip" edit into the next timeline. Returns null
 * when the input is invalid or the track/clip capacity is exhausted.
 */
export function compileDirectorTimelineAudioClipAdd(
  timeline: DirectorTimeline,
  input: DirectorTimelineAudioClipAddInput,
): { timeline: DirectorTimeline; clipId: string } | null {
  const mediaId = input.mediaId.trim();
  const name = input.name.trim().slice(0, 240);
  if (!mediaId || !name || !Number.isFinite(input.durationFrames) || input.durationFrames < 1) return null;
  const tracks = timeline.audioTracks ?? [];
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
  const clipId = getNextSequentialId(
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
    ...(input.sourceDurationSec !== undefined && Number.isFinite(input.sourceDurationSec) && input.sourceDurationSec > 0
      ? { sourceDurationSec: Math.min(input.sourceDurationSec, 86_400) }
      : {}),
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
  };
  return {
    clipId,
    timeline: withTimelineAudioTracks(
      timeline,
      nextTracks.map((track, index) => (index === trackIndex ? { ...track, clips: [...track.clips, clip] } : track)),
    ),
  };
}

/** Compile a stage audio clip patch into the next timeline; null when the clip is missing. */
export function compileDirectorTimelineAudioClipUpdate(
  timeline: DirectorTimeline,
  clipId: string,
  patch: Partial<Omit<DirectorTimelineAudioClip, "id" | "mediaId">>,
): DirectorTimeline | null {
  const tracks = timeline.audioTracks ?? [];
  if (!tracks.some((track) => track.clips.some((clip) => clip.id === clipId))) return null;
  return withTimelineAudioTracks(
    timeline,
    tracks.map((track) =>
      track.clips.some((clip) => clip.id === clipId)
        ? {
            ...track,
            clips: track.clips.map((clip) => (clip.id === clipId ? sanitizeTimelineAudioClipPatch(clip, patch) : clip)),
          }
        : track,
    ),
  );
}

/** Compile a stage audio clip move into the next timeline; null when nothing changes. */
export function compileDirectorTimelineAudioClipMove(
  timeline: DirectorTimeline,
  clipId: string,
  startFrame: number,
): DirectorTimeline | null {
  if (!Number.isFinite(startFrame)) return null;
  const tracks = timeline.audioTracks ?? [];
  const nextStart = clamp(Math.round(startFrame), 0, MAX_TIMELINE_AUDIO_FRAME);
  if (!tracks.some((track) => track.clips.some((clip) => clip.id === clipId && clip.startFrame !== nextStart))) {
    return null;
  }
  return withTimelineAudioTracks(
    timeline,
    tracks.map((track) =>
      track.clips.some((clip) => clip.id === clipId)
        ? {
            ...track,
            clips: track.clips.map((clip) => (clip.id === clipId ? { ...clip, startFrame: nextStart } : clip)),
          }
        : track,
    ),
  );
}

/** Compile a stage audio clip removal into the next timeline; null when the clip is missing. */
export function compileDirectorTimelineAudioClipRemoval(
  timeline: DirectorTimeline,
  clipId: string,
): DirectorTimeline | null {
  const tracks = timeline.audioTracks ?? [];
  if (!tracks.some((track) => track.clips.some((clip) => clip.id === clipId))) return null;
  return withTimelineAudioTracks(
    timeline,
    tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== clipId) })),
  );
}

/** Compile a stage audio track mute toggle into the next timeline; null when nothing changes. */
export function compileDirectorTimelineAudioTrackMute(
  timeline: DirectorTimeline,
  trackId: string,
  muted: boolean,
): DirectorTimeline | null {
  const tracks = timeline.audioTracks ?? [];
  const track = tracks.find((candidate) => candidate.id === trackId);
  if (!track || track.muted === muted) return null;
  return withTimelineAudioTracks(
    timeline,
    tracks.map((candidate) => (candidate.id === trackId ? { ...candidate, muted } : candidate)),
  );
}

/** Wrap a rebuilt timeline into the set_scene replacement both UI and Agent dispatch. */
export function compileDirectorTimelineSetSceneAction(timeline: DirectorTimeline): SetSceneAction {
  return { action: "set_scene", patch: { timeline: structuredClone(timeline) } } as SetSceneAction;
}

/**
 * Compile the Stage "remove imported asset" flow into authoring actions:
 * children of removed instances are detached first (UI deletes never cascade
 * into children), then remove_assets cascade-deletes the instances, clears
 * texture bindings, and drops anchored annotations/measurements. Returns null
 * when the asset is missing or not a model (the legacy writer no-ops there).
 */
export function compileDirectorRemoveImportedAssetActions(
  project: DirectorProject,
  assetId: string,
): DirectorAuthoringAction[] | null {
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset || asset.sourceType !== "model") return null;
  const removedObjectIds = new Set(
    project.objects.filter((object) => object.assetRefId === assetId).map((object) => object.id),
  );
  const detachChildren: DirectorAuthoringAction[] = project.objects
    .filter(
      (object) =>
        object.parentObjectId && removedObjectIds.has(object.parentObjectId) && !removedObjectIds.has(object.id),
    )
    .map((object) => ({
      action: "update_object" as const,
      object_id: object.id,
      patch: { parent_id: null },
      force: true,
    }));
  return [...detachChildren, { action: "remove_assets", asset_ids: [assetId], cascade: true }];
}

/**
 * Compile the Stage "remove panorama" flow into a remove_assets action.
 * Returns null (legacy writer) when there is no panorama asset in the catalog
 * or something still references it, which authoring would reject or cascade.
 */
export function compileDirectorRemovePanoramaAssetAction(project: DirectorProject): DirectorAuthoringAction | null {
  const panoramaAssetId = project.panoramaAssetId;
  if (!panoramaAssetId) return null;
  if (!project.assets.some((asset) => asset.id === panoramaAssetId)) return null;
  const referenced = project.objects.some(
    (object) =>
      object.assetRefId === panoramaAssetId ||
      Object.values(object.material?.textures ?? {}).some((textureAssetId) => textureAssetId === panoramaAssetId),
  );
  if (referenced) return null;
  return { action: "remove_assets", asset_ids: [panoramaAssetId] };
}

/**
 * Compile a real-world-size calibration into an upsert_asset replacement.
 * Returns null for the same inputs the legacy writer ignores, and for clears
 * (sizeM null): the authored landing point re-runs the metric-scale backfill,
 * which would immediately re-estimate a cleared size.
 */
export function compileDirectorAssetRealWorldSizeAction(
  project: DirectorProject,
  assetId: string,
  sizeM: number | null,
  source: DirectorAssetRef["sizeSource"],
): DirectorAuthoringAction | null {
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset || asset.sourceType !== "model" || asset.kind === "character") return null;
  if (sizeM === null || !Number.isFinite(sizeM) || sizeM <= 0) return null;
  const nextAsset: DirectorAssetRef = {
    ...asset,
    realWorldSizeM: sizeM,
    sizeSource: source,
  };
  return { action: "upsert_asset", asset: structuredClone(nextAsset) } as DirectorAuthoringAction;
}

/** Compile a library-only asset import (no scene instancing) into upsert_asset. */
export function compileDirectorImportedAssetUpsertAction(asset: DirectorAssetRef): DirectorAuthoringAction {
  return { action: "upsert_asset", asset: structuredClone(asset) } as DirectorAuthoringAction;
}
