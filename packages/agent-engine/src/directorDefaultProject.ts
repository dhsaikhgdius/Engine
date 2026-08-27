/**
 * Factory for the canonical starter Director project.
 *
 * Both the browser bootstrap (first project a user sees) and gateway/agent
 * tests build from this exact shape, so agent expectations about the default
 * scene (one Mixamo-rigged character at the origin, one camera pair —
 * `DirectorCameraShot` plus its linked scene object — default lights, and a
 * frame timeline) hold in every environment. Deliberately store-free:
 * browser-only persistence concerns are layered on by the frontend wrapper.
 *
 * @module directorDefaultProject
 */

import {
  createDefaultDirectorFrameTimeline,
  createDefaultDirectorLights,
  createDefaultDirectorProduction,
  DEFAULT_CHARACTER_BODY_TYPE,
  DEFAULT_DIRECTOR_CAMERA_ACTION,
  DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
  DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
  DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
  DEFAULT_DIRECTOR_CAMERA_ISO,
  DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
  DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
  DIRECTOR_PREVIZ_PALETTE,
  getCameraRigPositionFromViewSnapshot,
  type DirectorCameraShot,
  type DirectorObject,
  type DirectorProject,
  type DirectorTransform,
  type SceneSettings,
} from "@director/project-schema";
import { getDefaultMixamoCharacterAssetRef } from "@director/dcc-interchange";

function createTransform(
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): DirectorTransform {
  return { position, rotation, scale };
}

// Default scene item names follow the UI source language (Simplified Chinese).
function formatSceneItemName(prefix: "角色" | "机位", index: number) {
  return `${prefix}${String(index).padStart(2, "0")}`;
}

function createDefaultDirectorSceneSettings(): SceneSettings {
  return {
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
}

/**
 * Canonical empty Director project used by Agent tests and browser bootstrap.
 *
 * Browser persistence of local model-library assets is applied by the
 * frontend store wrapper; this factory stays store-free.
 */
export function createDefaultDirectorProject(): DirectorProject {
  const camera: DirectorCameraShot = {
    id: "cam_1",
    name: formatSceneItemName("机位", 1),
    fov: DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.fov,
    focalLengthMm: DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
    sensorFormat: DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
    apertureFStop: DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
    focusDistanceM: DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
    shutterAngle: DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
    iso: DEFAULT_DIRECTOR_CAMERA_ISO,
    nearClipM: DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
    farClipM: DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
    anamorphicSqueeze: DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
    aspectRatio: DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
    handheldShake: DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
    action: DEFAULT_DIRECTOR_CAMERA_ACTION,
    transform: createTransform(getCameraRigPositionFromViewSnapshot(DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT)),
    targetMode: "manual",
    target: DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.target,
    lastCaptureUrl: null,
    captures: [],
  };

  const defaultCharacterAsset = getDefaultMixamoCharacterAssetRef();
  const role: DirectorObject = {
    id: "char_default_a",
    name: formatSceneItemName("角色", 1),
    kind: "character",
    characterSource: "asset",
    assetRefId: defaultCharacterAsset.id,
    placementMode: "grounded",
    visible: true,
    locked: false,
    bodyType: DEFAULT_CHARACTER_BODY_TYPE,
    color: DIRECTOR_PREVIZ_PALETTE.human,
    transform: createTransform([0, 0, 0]),
    characterRig: {
      rigType: "mixamo",
      posePresetId: "stand",
      controls: {},
    },
    nativeSource: { engine: "blender", objectId: "char_default_a", provisioned: false },
  };

  const cameraObject: DirectorObject = {
    id: "cam_object_1",
    name: camera.name,
    kind: "camera",
    visible: true,
    locked: false,
    linkedCameraId: camera.id,
    transform: camera.transform,
  };

  const project: DirectorProject = {
    version: 1,
    scene: {
      ...createDefaultDirectorSceneSettings(),
      timeline: createDefaultDirectorFrameTimeline(),
    },
    assets: [defaultCharacterAsset],
    objects: [role, cameraObject],
    lights: createDefaultDirectorLights(),
    cameras: [camera],
    activeCameraId: camera.id,
    panoramaAssetId: null,
  };

  return { ...project, production: createDefaultDirectorProduction(project) };
}
