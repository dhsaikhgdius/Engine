import type { DirectorProject } from "@director/project-schema";
import { getCameraViewSnapshotFromShot, normalizeDirectorCameraOptics } from "@director/project-schema";
import { observeDirectorProductionGraph } from "@director/project-schema/production-graph";
import { getDirectorProjectGraphIssues } from "./directorProjectGraph";
import { buildDirectorObjectHierarchy } from "./directorObjectHierarchy";
import type { DirectorWorkbenchObserveField } from "./directorWorkbenchContract";

/** Totals an observe result reports for each persisted collection. */
export interface DirectorProjectObservationCounts {
  assets: number;
  objects: number;
  cameras: number;
  lights: number;
  storyboard_shots: number;
  performance_takes: number;
  coverage_sequences: number;
  coverage_shots: number;
}

export type DirectorWorkbenchObserveOptions = {
  objectMode?: "flat" | "hierarchy";
  maxObjects?: number;
  /** Transient UI snapshot. Omit when no live Stage tab is connected. */
  ui?: unknown;
  /** Observe payload detail. `production_graph` full mode includes nodes/edges. */
  detail?: "summary" | "full";
};

/**
 * Count persisted Director collections. Used by observe and revision diffs.
 *
 * @param project - The project whose collections are counted.
 */
export function directorProjectObservationCounts(project: DirectorProject): DirectorProjectObservationCounts {
  return {
    assets: project.assets.length,
    objects: project.objects.length,
    cameras: project.cameras.length,
    lights: project.lights?.length ?? 0,
    storyboard_shots: project.storyboard?.shots.length ?? 0,
    performance_takes: project.production?.takes.length ?? 0,
    coverage_sequences: project.production?.sequences.length ?? 0,
    coverage_shots: project.production?.sequences.reduce((total, sequence) => total + sequence.shots.length, 0) ?? 0,
  };
}

function observeDirectorObjects(project: DirectorProject) {
  return project.objects.map((object) => ({
    id: object.id,
    name: object.name,
    kind: object.kind,
    visible: object.visible,
    locked: object.locked,
    transform: object.transform,
    ...(object.bodyType ? { body_type: object.bodyType } : {}),
    ...(object.characterSource ? { character_source: object.characterSource } : {}),
    ...(object.color ? { color: object.color } : {}),
    ...(object.material ? { material: structuredClone(object.material) } : {}),
    ...(object.characterRig?.posePresetId ? { pose_preset_id: object.characterRig.posePresetId } : {}),
    ...(object.characterRig
      ? {
          character_rig: {
            type: object.characterRig.rigType,
            pose_preset_id: object.characterRig.posePresetId,
            controls: structuredClone(object.characterRig.controls),
            ik: structuredClone(object.characterRig.ik ?? {}),
            motion: object.characterRig.motion ? structuredClone(object.characterRig.motion) : null,
          },
        }
      : {}),
    ...(object.animation
      ? {
          animation: {
            keyframe_count: object.animation.keyframes.length,
            motion: object.animation.motion ?? "none",
            action: object.animation.actionPresetId ?? null,
          },
        }
      : {}),
    ...(object.geometryType ? { geometry_type: object.geometryType } : {}),
    ...(object.placementMode ? { placement_mode: object.placementMode } : {}),
    ...(object.assetRefId ? { asset_id: object.assetRefId } : {}),
    ...(object.vehicle ? { vehicle: structuredClone(object.vehicle) } : {}),
    ...(object.interaction ? { interaction: structuredClone(object.interaction) } : {}),
    ...(object.crowdId ? { crowd_id: object.crowdId } : {}),
    ...(object.parentObjectId ? { parent_id: object.parentObjectId } : {}),
    ...(object.lookTargetObjectId ? { look_target_object_id: object.lookTargetObjectId } : {}),
    ...(object.linkedCameraId ? { camera_id: object.linkedCameraId } : {}),
  }));
}

function observeDirectorCameras(project: DirectorProject) {
  return project.cameras.map((camera) => {
    const optics = normalizeDirectorCameraOptics(camera);
    return {
      id: camera.id,
      name: camera.name,
      position: getCameraViewSnapshotFromShot(camera).position,
      target: camera.target,
      focal_length_mm: camera.focalLengthMm ?? null,
      sensor_format: camera.sensorFormat ?? "fullFrame",
      aperture_f_stop: optics.apertureFStop,
      focus_distance_m: optics.focusDistanceM,
      shutter_angle: optics.shutterAngle,
      iso: optics.iso,
      near_clip_m: optics.nearClipM,
      far_clip_m: optics.farClipM,
      anamorphic_squeeze: optics.anamorphicSqueeze,
      aspect_ratio: camera.aspectRatio ?? null,
      handheld_shake: camera.handheldShake ?? "off",
      action: camera.action?.mode ?? "still",
      target_object_id: camera.targetObjectId ?? null,
      animation_keyframe_count: camera.animation?.keyframes.length ?? 0,
    };
  });
}

/**
 * Build an observe payload from a persisted Director project.
 *
 * Live Stage UI is optional. When `fields` includes `ui` and no UI snapshot is
 * supplied, the result reports `ui: null` instead of failing.
 *
 * @param project - Persisted project document.
 * @param fields - Optional subset of observe fields.
 * @param options - Hierarchy mode and optional UI snapshot.
 */
export function observeDirectorProject(
  project: DirectorProject,
  fields?: DirectorWorkbenchObserveField[],
  options: DirectorWorkbenchObserveOptions = {},
): Record<string, unknown> {
  const objects = observeDirectorObjects(project);
  const cameras = observeDirectorCameras(project);
  const counts = directorProjectObservationCounts(project);
  const storyboard = project.storyboard
    ? {
        title: project.storyboard.title,
        shot_count: project.storyboard.shots.length,
        shots: project.storyboard.shots.map((shot) => ({ id: shot.id, title: shot.title, camera_id: shot.cameraId })),
      }
    : null;
  const production = project.production
    ? {
        active_take_id: project.production.activeTakeId,
        active_sequence_id: project.production.activeSequenceId,
        takes: project.production.takes.map((take) => ({
          id: take.id,
          name: take.name,
          frame_start: take.frameStart,
          frame_end: take.frameEnd,
          object_ids: [...take.objectIds],
          entity_track_count: take.entityTracks.length,
        })),
        sequences: project.production.sequences.map((sequence) => ({
          id: sequence.id,
          name: sequence.name,
          shots: sequence.shots.map((shot) => ({
            id: shot.id,
            name: shot.name,
            take_id: shot.takeId,
            camera_id: shot.cameraId,
            frame_start: shot.frameStart,
            frame_end: shot.frameEnd,
            storyboard_shot_id: shot.storyboardShotId ?? null,
          })),
        })),
      }
    : null;
  const timeline = {
    settings: project.scene.timeline ?? null,
    object_tracks: objects.flatMap((object) =>
      object.animation ? [{ id: object.id, kind: object.kind, ...object.animation }] : [],
    ),
    camera_tracks: cameras
      .filter((camera) => camera.animation_keyframe_count > 0)
      .map((camera) => ({ id: camera.id, keyframe_count: camera.animation_keyframe_count })),
  };
  const objectHierarchy =
    options.objectMode === "hierarchy" ? buildDirectorObjectHierarchy(objects, options.maxObjects ?? 200) : null;
  const complete: Record<string, unknown> = {
    scene: project.scene,
    ui: options.ui ?? null,
    active_camera_id: project.activeCameraId,
    panorama_asset_id: project.panoramaAssetId,
    world: project.world ? structuredClone(project.world) : null,
    assets: project.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name ?? asset.fileName,
      source: asset.assetSource ?? "local",
    })),
    objects: objectHierarchy ?? objects,
    ...(objectHierarchy ? { object_mode: "hierarchy" as const } : {}),
    lights: structuredClone(project.lights ?? []),
    cameras,
    storyboard,
    production,
    timeline,
    counts,
    graph_issues: getDirectorProjectGraphIssues(project),
  };

  if (!fields?.length) return complete;
  const selected: Record<string, unknown> = {
    active_camera_id: project.activeCameraId,
    requested_fields: fields,
    ...(objectHierarchy ? { object_mode: "hierarchy" } : {}),
  };
  const graphDetail = options.detail === "full" ? "full" : "summary";
  fields.forEach((field) => {
    if (field === "characters") selected.characters = objects.filter((object) => object.kind === "character");
    else if (field === "production_graph") {
      selected.production_graph = observeDirectorProductionGraph(project, graphDetail);
    } else selected[field] = complete[field];
  });
  return selected;
}
