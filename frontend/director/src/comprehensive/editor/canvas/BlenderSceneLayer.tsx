import { invalidate, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BoxHelper,
  BufferGeometry,
  Color,
  Euler,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Texture,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderAgentOperation,
  type BlenderLiveSceneSnapshot,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import type { PlayerRaycastMesh } from "../player/playerRaycastAcceleration";
import type { PlayerStaticEnvironment } from "../player/playerStaticEnvironment";
import { configureDirectorGLTFLoader } from "../runtime/gltfLoader";
import { isDirectorSplatAssetFileName } from "../loaders/splatFormats";
import { useBlenderRuntimeStore } from "../runtime/blenderRuntimeStore";
import { isDirectorObjectEffectivelyLocked } from "../schema/objectLayers";
import type {
  DirectorAssetRef,
  DirectorCameraShot,
  DirectorLight,
  DirectorObject,
  DirectorTransform,
} from "../schema/directorProject";
import { useDirectorStore, type TransformMode } from "../store/directorStore";
import {
  bindBlenderDirectorProject,
  getBlenderLivePreviewGlb,
  getBlenderLiveScene,
  getBlenderLiveStatus,
  inspectBlenderLiveObject,
  uploadBlenderModelAsset,
  blenderSetSceneFrameOperation,
} from "../api/blenderLiveClient";
import { applyBlenderRuntimeOperations } from "../runtime/blenderRuntimeTransactions";
import { directorControlPlaneUrl } from "../api/directorControlPlaneClient";
import { CenteredObjectTransformControls } from "./SceneRoot";
import { getBlenderCameraViewSnapshot, type BlenderCameraViewSnapshot } from "./blenderCamera";
import { buildBlenderCharacterOperations } from "../runtime/blenderCharacterAdapter";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { getVisibleObjectLocalFloorPivot } from "./visualBounds";
import { stabilizeImportedModelCoplanarDepth } from "./importedModelDepth";
import {
  DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
  getCameraViewSnapshotFromShot,
  getDirectorCameraSensorGate,
  getFocalLengthFromVerticalFov,
} from "../schema/cameraGeometry";
import { directorCameraLookEuler } from "../interchange/cameraOrientation";

export type BlenderSceneLayerPhase = "hidden" | "connecting" | "syncing" | "ready" | "stale" | "offline";

export interface BlenderSceneLayerStatus {
  phase: BlenderSceneLayerPhase;
  revision: number | null;
  targetRevision?: number;
  message?: string;
}

type BlenderSceneLoader = (blob: Blob) => Promise<Object3D>;

interface BlenderSceneVersion {
  revision: number;
  sceneEpoch: string;
}

interface BlenderSceneSelection extends BlenderSceneVersion {
  activeObjectId: string | null;
  selectedObjectIds: string[];
}

interface FailedBlenderSceneVersion extends BlenderSceneVersion {
  attempts: number;
  message: string;
  retryAt: number;
}

const MAX_PREVIEW_RETRY_DELAY_MS = 12_000;
const MAX_PREVIEW_RETRY_EXPONENT = 5;
const OWNS_IMAGE_BITMAPS_KEY = "blenderOwnsImageBitmaps";
const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const COLLISION_DISABLED_KEY = "directorCollisionDisabled";
const DIRECTOR_OWNS_VISUAL_KEY = "directorOwnsBlenderVisual";
export const BLENDER_LIVE_COLLISION_OWNER = "blender-live";

/** Packaged Mixamo characters keep their Director materials; the live GLB is an untextured stand-in. */
export function directorRendersCharacterAsset(object: DirectorObject) {
  return object.kind === "character" && Boolean(object.assetRefId);
}

export function collectHiddenBlenderVisualIds(
  objects: readonly DirectorObject[],
  snapshot: BlenderLiveSceneSnapshot | null,
) {
  const hidden = new Set<string>();
  for (const object of objects) {
    if (!directorRendersCharacterAsset(object)) continue;
    hidden.add(object.id);
    if (object.nativeSource?.engine === "blender") hidden.add(object.nativeSource.objectId);
  }
  if (!snapshot || hidden.size === 0) return hidden;

  const objectsById = new Map(snapshot.objects.map((item) => [item.id, item]));
  const belongsToHiddenRoot = (objectId: string) => {
    let current = objectsById.get(objectId);
    while (current) {
      if (hidden.has(current.id) || (current.directorId && hidden.has(current.directorId))) return true;
      current = current.parentId ? objectsById.get(current.parentId) : undefined;
    }
    return false;
  };
  for (const native of snapshot.objects) {
    if (belongsToHiddenRoot(native.id)) hidden.add(native.id);
  }
  return hidden;
}

export function applyDirectorOwnedBlenderVisibility(scene: Object3D, hiddenIds: ReadonlySet<string>) {
  scene.traverse((object) => {
    const worldengineId = object.userData.worldengine_id;
    const directorId = object.userData.director_id;
    const tagged =
      (typeof worldengineId === "string" && hiddenIds.has(worldengineId)) ||
      (typeof directorId === "string" && hiddenIds.has(directorId));
    if (tagged) {
      object.userData[DIRECTOR_OWNS_VISUAL_KEY] = true;
      object.visible = false;
      return;
    }
    if (object.userData[DIRECTOR_OWNS_VISUAL_KEY] === true) {
      delete object.userData[DIRECTOR_OWNS_VISUAL_KEY];
      object.visible = true;
    }
  });
}

const DIRECTOR_SEGMENTATION_METADATA_KEY = "blenderDirectorSegmentationMetadata";

/**
 * Projects each native hierarchy root onto the canonical Director identity
 * consumed by object-id, mask, and semantic captures.
 */
export function applyBlenderDirectorSegmentationMetadata(
  scene: Object3D,
  snapshot: BlenderLiveSceneSnapshot,
  directorObjects: readonly DirectorObject[],
) {
  const snapshotObjectsById = new Map(snapshot.objects.map((object) => [object.id, object]));
  const directorObjectsById = new Map(directorObjects.map((object) => [object.id, object]));
  const directorObjectsByNativeId = new Map(
    directorObjects.flatMap((object) =>
      object.nativeSource?.engine === "blender" ? [[object.nativeSource.objectId, object] as const] : [],
    ),
  );
  const ownerByNativeId = new Map<string, DirectorObject>();

  for (const nativeObject of snapshot.objects) {
    let root = nativeObject;
    while (root.parentId && snapshotObjectsById.has(root.parentId)) {
      root = snapshotObjectsById.get(root.parentId)!;
    }
    const owner =
      directorObjectsByNativeId.get(root.id) ??
      (root.directorId ? directorObjectsById.get(root.directorId) : undefined) ??
      directorObjectsById.get(`native:${root.id}`);
    if (owner) ownerByNativeId.set(nativeObject.id, owner);
  }

  scene.traverse((object) => {
    const nativeId = object.userData.worldengine_id;
    const owner = typeof nativeId === "string" ? ownerByNativeId.get(nativeId) : undefined;
    if (owner) {
      object.userData.directorObjectId = owner.id;
      object.userData.directorObjectKind = owner.kind;
      object.userData[DIRECTOR_SEGMENTATION_METADATA_KEY] = true;
      return;
    }
    if (object.userData[DIRECTOR_SEGMENTATION_METADATA_KEY] === true) {
      delete object.userData.directorObjectId;
      delete object.userData.directorObjectKind;
      delete object.userData[DIRECTOR_SEGMENTATION_METADATA_KEY];
    }
  });
}

function sameVersion(left: BlenderSceneVersion | null, right: BlenderSceneVersion | null) {
  return left?.sceneEpoch === right?.sceneEpoch && left?.revision === right?.revision;
}

function sameSelection(left: BlenderSceneSelection | null, right: BlenderSceneSelection) {
  return (
    sameVersion(left, right) &&
    left?.activeObjectId === right.activeObjectId &&
    left.selectedObjectIds.length === right.selectedObjectIds.length &&
    left.selectedObjectIds.every((id, index) => id === right.selectedObjectIds[index])
  );
}

export function findBlenderStableObjectId(object: Object3D, scene: Object3D) {
  let current: Object3D | null = object;
  while (current) {
    const id = current.userData.worldengine_id;
    if (typeof id === "string" && id) return id;
    if (current === scene) break;
    current = current.parent;
  }
  return null;
}

export function collectBlenderSelectionTargets(
  scene: Object3D,
  selectedObjectIds: string[],
  activeObjectId: string | null,
) {
  const requested = new Set(selectedObjectIds);
  if (activeObjectId) requested.add(activeObjectId);
  const found = new Set<string>();
  const targets: Array<{ active: boolean; id: string; object: Object3D }> = [];
  scene.traverse((object) => {
    const id = object.userData.worldengine_id;
    if (typeof id !== "string" || !requested.has(id) || found.has(id)) return;
    found.add(id);
    targets.push({ active: id === activeObjectId, id, object });
  });
  return targets;
}

export function findBlenderSnapshotRoot(snapshot: BlenderLiveSceneSnapshot, objectId: string) {
  const objectsById = new Map(snapshot.objects.map((object) => [object.id, object]));
  let current = objectsById.get(objectId);
  while (current?.parentId && objectsById.has(current.parentId)) {
    current = objectsById.get(current.parentId);
  }
  return current ?? null;
}

export function isBlenderSelectionWithinRoot(
  snapshot: BlenderLiveSceneSnapshot,
  rootObjectId: string,
  activeObjectId: string | null,
  selectedObjectIds: string[],
) {
  const selectionIds = new Set(selectedObjectIds);
  if (activeObjectId) selectionIds.add(activeObjectId);
  return (
    selectionIds.size > 0 &&
    [...selectionIds].every((objectId) => findBlenderSnapshotRoot(snapshot, objectId)?.id === rootObjectId)
  );
}

function blenderSnapshotRoots(snapshot: BlenderLiveSceneSnapshot) {
  const ids = new Set(snapshot.objects.map((object) => object.id));
  return snapshot.objects.filter((object) => !object.parentId || !ids.has(object.parentId));
}

function findBlenderSceneObject(scene: Object3D, objectId: string) {
  let result: Object3D | null = null;
  scene.traverse((object) => {
    if (!result && object.userData.worldengine_id === objectId) result = object;
  });
  return result;
}

function sameBlenderValue(left: number, right: number) {
  return Math.abs(left - right) <= 0.00001;
}

function sameBlenderRotation(left: readonly [number, number, number], right: readonly [number, number, number]) {
  const leftRotation = new Quaternion().setFromEuler(new Euler(left[0], left[1], left[2], "XYZ"));
  const rightRotation = new Quaternion().setFromEuler(new Euler(right[0], right[1], right[2], "XYZ"));
  return leftRotation.angleTo(rightRotation) <= 0.00001;
}

function blenderForward(rotation: readonly [number, number, number]) {
  return new Vector3(0, 0, -1).applyEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ")).normalize();
}

function sameBlenderLookDirection(left: readonly [number, number, number], right: readonly [number, number, number]) {
  return blenderForward(left).angleTo(blenderForward(right)) <= 0.00001;
}

function directorLookRotation(
  position: DirectorTransform["position"],
  target: DirectorCameraShot["target"],
  fallback: DirectorTransform["rotation"],
) {
  const desiredForward = new Vector3(...target).sub(new Vector3(...position));
  if (desiredForward.lengthSq() > Number.EPSILON) {
    desiredForward.normalize();
    if (desiredForward.angleTo(blenderForward(fallback)) <= 0.00001) return fallback;
  }
  return directorCameraLookEuler({
    transform: { position, rotation: fallback, scale: [1, 1, 1] },
    target,
  });
}

function srgbChannelToLinear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function directorLightLinearColor(value: string) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (!hex) {
    const color = new Color(value);
    return [color.r, color.g, color.b] as [number, number, number];
  }
  return ([0, 2, 4] as const).map((offset) =>
    srgbChannelToLinear(Number.parseInt(hex.slice(offset, offset + 2), 16) / 255),
  ) as [number, number, number];
}

function sameBlenderTransform(object: DirectorObject, nativeObject: BlenderLiveSceneSnapshot["objects"][number]) {
  return (
    object.transform.position.every((value, index) => sameBlenderValue(value, nativeObject.position[index])) &&
    sameBlenderRotation(object.transform.rotation, nativeObject.rotation) &&
    object.transform.scale.every((value, index) => sameBlenderValue(value, nativeObject.scale[index]))
  );
}

function sameBlenderVector(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((value, index) => sameBlenderValue(value, right[index]));
}

function sameBlenderColor(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) <= 0.005);
}

function directorCameraState(camera: DirectorCameraShot) {
  const view = getCameraViewSnapshotFromShot(camera);
  const sensor = getDirectorCameraSensorGate(camera.sensorFormat);
  const rotation = directorLookRotation(view.position, camera.target, camera.transform.rotation);
  return {
    position: view.position,
    rotation,
    projectionType: camera.projectionType === "orthographic" ? ("ORTHOGRAPHIC" as const) : ("PERSPECTIVE" as const),
    focalLengthMm:
      camera.focalLengthMm ?? getFocalLengthFromVerticalFov(camera.fov, camera.aspectRatio, camera.sensorFormat),
    sensorFit: (camera.sensorFit?.toUpperCase() ?? "AUTO") as "AUTO" | "HORIZONTAL" | "VERTICAL",
    sensorWidthMm: camera.sensorWidthMm ?? sensor.width,
    sensorHeightMm: camera.sensorHeightMm ?? sensor.height,
    shiftX: camera.lensShiftX ?? 0,
    shiftY: camera.lensShiftY ?? 0,
    clipStart: camera.nearClipM ?? DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
    clipEnd: camera.farClipM ?? DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
    orthographicScale: camera.orthographicScaleM ?? 10,
  };
}

function sameBlenderCameraData(
  desired: ReturnType<typeof directorCameraState>,
  native: BlenderLiveSceneSnapshot["cameras"][number],
) {
  return (
    desired.projectionType === native.projectionType &&
    desired.sensorFit === native.sensorFit &&
    sameBlenderValue(desired.focalLengthMm, native.focalLengthMm) &&
    sameBlenderValue(desired.sensorWidthMm, native.sensorWidthMm) &&
    sameBlenderValue(desired.sensorHeightMm, native.sensorHeightMm) &&
    sameBlenderValue(desired.shiftX, native.shiftX) &&
    sameBlenderValue(desired.shiftY, native.shiftY) &&
    sameBlenderValue(desired.clipStart, native.clipStart) &&
    sameBlenderValue(desired.clipEnd, native.clipEnd) &&
    sameBlenderValue(desired.orthographicScale, native.orthographicScale)
  );
}

function blenderCameraData(desired: ReturnType<typeof directorCameraState>) {
  return {
    projectionType: desired.projectionType,
    focalLengthMm: desired.focalLengthMm,
    sensorFit: desired.sensorFit,
    sensorWidthMm: desired.sensorWidthMm,
    sensorHeightMm: desired.sensorHeightMm,
    shiftX: desired.shiftX,
    shiftY: desired.shiftY,
    clipStart: desired.clipStart,
    clipEnd: desired.clipEnd,
    orthographicScale: desired.orthographicScale,
  };
}

function blenderLightKind(light: DirectorLight) {
  if (light.type === "directional") return "sun" as const;
  if (light.type === "rect-area") return "area" as const;
  if (light.type === "point" || light.type === "spot") return light.type;
  return null;
}

function directorLightState(light: DirectorLight, native?: BlenderLiveSceneSnapshot["lights"][number]) {
  const position = light.position ?? [0, 3, 0];
  const target = light.target ?? [0, 0, 0];
  const color = directorLightLinearColor(light.color);
  const kind = blenderLightKind(light);
  return kind
    ? {
        kind,
        position,
        rotation: directorLookRotation(position, target, [0, 0, 0]),
        color,
        energy: kind === "sun" ? light.intensity : light.intensity * 1_000,
        size: kind === "area" ? (light.width ?? light.height ?? native?.size ?? 2) : (native?.size ?? 0.25),
      }
    : null;
}

export function buildDirectorBlenderOperations(
  snapshot: BlenderLiveSceneSnapshot,
  objects: DirectorObject[],
  assets: DirectorAssetRef[] = [],
  stagedAssetSources: ReadonlyMap<string, string> = new Map(),
  provisionObjectIds: ReadonlySet<string> | null = null,
  cameras: DirectorCameraShot[] = [],
  lights: DirectorLight[] = [],
  activeCameraId: string | null = null,
): BlenderAgentOperation[] {
  const objectsById = new Map(objects.map((object) => [object.id, object]));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const objectsByNativeId = new Map(
    objects.flatMap((object) =>
      object.nativeSource?.engine === "blender" ? [[object.nativeSource.objectId, object] as const] : [],
    ),
  );
  const operations: BlenderAgentOperation[] = [];
  const nativeRoots = blenderSnapshotRoots(snapshot);

  for (const nativeObject of nativeRoots) {
    const object =
      objectsByNativeId.get(nativeObject.id) ??
      (nativeObject.directorId ? objectsById.get(nativeObject.directorId) : undefined) ??
      objectsById.get(`native:${nativeObject.id}`);
    if (!object) {
      operations.push({ op: "delete_object", id: nativeObject.id });
      continue;
    }
    if (!sameBlenderTransform(object, nativeObject)) {
      operations.push({ op: "update_transform", id: nativeObject.id, transform: object.transform });
    }
    if (object.name !== nativeObject.name) {
      operations.push({ op: "set_object_name", id: nativeObject.id, name: object.name });
    }
    if (object.visible !== nativeObject.visible) {
      operations.push({ op: "set_object_visibility", id: nativeObject.id, visible: object.visible });
    }
  }

  const nativeRootIds = new Set(nativeRoots.map((root) => root.id));
  const nativeDirectorIds = new Set(nativeRoots.flatMap((root) => (root.directorId ? [root.directorId] : [])));
  for (const object of objects) {
    if (
      object.nativeSource?.engine !== "blender" ||
      object.nativeSource.provisioned !== false ||
      (provisionObjectIds !== null && !provisionObjectIds.has(object.id)) ||
      nativeRootIds.has(object.nativeSource.objectId) ||
      nativeDirectorIds.has(object.id) ||
      !object.assetRefId
    ) {
      continue;
    }
    const asset = assetsById.get(object.assetRefId);
    // Blender has no gaussian splat importer; splat captures render only in the browser viewport.
    if (!asset || asset.sourceType !== "model" || asset.kind === "panorama") continue;
    if (isDirectorSplatAssetFileName(asset.fileName)) continue;
    const sourceUrl =
      stagedAssetSources.get(asset.id) ??
      (requiresBlenderAssetStaging(asset.url) ? null : resolveBlenderAssetSourceUrl(asset.url));
    if (!sourceUrl) continue;
    operations.push({
      op: "import_asset",
      id: object.nativeSource.objectId,
      directorId: object.id,
      assetId: asset.id,
      sourceUrl,
      fileName: asset.fileName,
      name: object.name,
      kind: asset.kind,
      normalization: asset.modelNormalization ?? "auto",
      grounded: object.placementMode === "grounded" || asset.kind === "character",
      ...(asset.characterMetadata?.heightM ? { targetHeightM: asset.characterMetadata.heightM } : {}),
      transform: object.transform,
    });
  }

  const camerasByNativeId = new Map(
    cameras.flatMap((camera) =>
      camera.nativeSource?.engine === "blender" ? [[camera.nativeSource.objectId, camera] as const] : [],
    ),
  );
  for (const nativeCamera of snapshot.cameras) {
    const camera = camerasByNativeId.get(nativeCamera.id);
    if (!camera) {
      operations.push({ op: "delete_object", id: nativeCamera.id });
      continue;
    }
    const desired = directorCameraState(camera);
    const { position, rotation } = desired;
    if (!sameBlenderVector(position, nativeCamera.position) || !sameBlenderRotation(rotation, nativeCamera.rotation)) {
      operations.push({
        op: "update_transform",
        id: nativeCamera.id,
        transform: { position, rotation },
      });
    }
    if (camera.name !== nativeCamera.name) {
      operations.push({ op: "set_object_name", id: nativeCamera.id, name: camera.name });
    }
    if (!sameBlenderCameraData(desired, nativeCamera)) {
      operations.push({ op: "set_camera_data", id: nativeCamera.id, ...blenderCameraData(desired) });
    }
  }
  const nativeCameraIds = new Set(snapshot.cameras.map((camera) => camera.id));
  for (const camera of cameras) {
    if (
      camera.nativeSource?.engine !== "blender" ||
      camera.nativeSource.provisioned !== false ||
      nativeCameraIds.has(camera.nativeSource.objectId)
    ) {
      continue;
    }
    const desired = directorCameraState(camera);
    operations.push({
      op: "create_camera",
      id: camera.nativeSource.objectId,
      name: camera.name,
      position: desired.position,
      target: camera.target,
      focalLengthMm: desired.focalLengthMm,
      sensorWidthMm: desired.sensorWidthMm,
    });
    operations.push({
      op: "set_camera_data",
      id: camera.nativeSource.objectId,
      ...blenderCameraData(desired),
    });
  }

  const lightsByNativeId = new Map(
    lights.flatMap((light) =>
      light.nativeSource?.engine === "blender" ? [[light.nativeSource.objectId, light] as const] : [],
    ),
  );
  for (const nativeLight of snapshot.lights) {
    const light = lightsByNativeId.get(nativeLight.id);
    if (!light) {
      operations.push({ op: "delete_object", id: nativeLight.id });
      continue;
    }
    const desired = directorLightState(light, nativeLight);
    if (!desired) continue;
    if (
      !sameBlenderVector(desired.position, nativeLight.position) ||
      !sameBlenderLookDirection(desired.rotation, nativeLight.rotation)
    ) {
      operations.push({
        op: "update_transform",
        id: nativeLight.id,
        transform: { position: desired.position, rotation: desired.rotation },
      });
    }
    if (light.name !== nativeLight.name) {
      operations.push({ op: "set_object_name", id: nativeLight.id, name: light.name });
    }
    if (light.visible !== nativeLight.visible) {
      operations.push({ op: "set_object_visibility", id: nativeLight.id, visible: light.visible });
    }
    if (
      desired.kind !== nativeLight.kind ||
      !sameBlenderColor(desired.color, nativeLight.color) ||
      !sameBlenderValue(desired.energy, nativeLight.energy) ||
      !sameBlenderValue(desired.size, nativeLight.size)
    ) {
      operations.push({
        op: "set_light_data",
        id: nativeLight.id,
        kind: desired.kind,
        color: desired.color,
        energy: desired.energy,
        size: desired.size,
      });
    }
  }
  const nativeLightIds = new Set(snapshot.lights.map((light) => light.id));
  for (const light of lights) {
    if (
      light.nativeSource?.engine !== "blender" ||
      light.nativeSource.provisioned !== false ||
      nativeLightIds.has(light.nativeSource.objectId)
    ) {
      continue;
    }
    const desired = directorLightState(light);
    if (!desired) continue;
    operations.push({
      op: "create_light",
      id: light.nativeSource.objectId,
      kind: desired.kind,
      name: light.name,
      position: desired.position,
      target: light.target ?? [0, 0, 0],
      color: desired.color,
      energy: desired.energy,
      size: desired.size,
    });
    if (!light.visible) {
      operations.push({ op: "set_object_visibility", id: light.nativeSource.objectId, visible: false });
    }
  }

  const activeCamera = cameras.find((camera) => camera.id === activeCameraId);
  if (
    activeCamera?.nativeSource?.engine === "blender" &&
    !snapshot.cameras.some((camera) => camera.id === activeCamera.nativeSource!.objectId && camera.active)
  ) {
    operations.push({ op: "set_active_camera", id: activeCamera.nativeSource.objectId });
  }

  return operations;
}

export function resolveBlenderAssetSourceUrl(url: string) {
  if (/^(?:data|blob|director-local-media):/i.test(url)) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\/(?:dcc-import|generated-3d|native-models)\//.test(url)) return directorControlPlaneUrl(url);
  return new URL(url, globalThis.location?.origin ?? "http://127.0.0.1:5175").href;
}

export function requiresBlenderAssetStaging(url: string) {
  const pathname = new URL(url, globalThis.location?.origin ?? "http://127.0.0.1:5175").pathname;
  return !/^\/(?:dcc-import|generated-3d|native-models)\//.test(pathname);
}

function getDirectorTransformFromBlenderObject(object: Object3D, scene: Object3D): DirectorTransform {
  scene.updateWorldMatrix(true, false);
  object.updateWorldMatrix(true, true);
  const matrix = new Matrix4().copy(scene.matrixWorld).invert().multiply(object.matrixWorld);
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  const euler = new Euler().setFromQuaternion(rotation, "XYZ");
  const value = (number: number) => Number(number.toFixed(6));
  return {
    position: [value(position.x), value(position.y), value(position.z)],
    rotation: [value(euler.x), value(euler.y), value(euler.z)],
    scale: [value(scale.x), value(scale.y), value(scale.z)],
  };
}

function applyDirectorTransformToBlenderObject(object: Object3D, scene: Object3D, transform: DirectorTransform) {
  scene.updateWorldMatrix(true, true);
  const desiredSceneMatrix = new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation)),
    new Vector3(...transform.scale),
  );
  const desiredWorldMatrix = new Matrix4().multiplyMatrices(scene.matrixWorld, desiredSceneMatrix);
  const desiredLocalMatrix = object.parent
    ? new Matrix4().copy(object.parent.matrixWorld).invert().multiply(desiredWorldMatrix)
    : desiredWorldMatrix;

  desiredLocalMatrix.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrix();
  object.updateWorldMatrix(false, true);
}

interface BlenderSnapshotTransformEntry {
  id: string;
  visible: boolean;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale?: readonly [number, number, number];
}

const blenderNodeIndexCache = new WeakMap<Object3D, Map<string, Object3D>>();

/**
 * Node lookup per mounted preview scene. The transform-only fast path never
 * changes topology (the kernel bumps contentRevision for anything else), so
 * the index stays valid for the lifetime of the loaded scene instance.
 */
function getBlenderNodeIndex(scene: Object3D) {
  let index = blenderNodeIndexCache.get(scene);
  if (!index) {
    const built = new Map<string, Object3D>();
    scene.traverse((object) => {
      const id = object.userData.worldengine_id;
      if (typeof id === "string" && id && !built.has(id)) built.set(id, object);
    });
    blenderNodeIndexCache.set(scene, built);
    index = built;
  }
  return index;
}

function sameBlenderEntryTransform(
  previous: BlenderSnapshotTransformEntry | undefined,
  next: BlenderSnapshotTransformEntry,
) {
  if (!previous) return false;
  const previousScale = previous.scale ?? [1, 1, 1];
  const nextScale = next.scale ?? [1, 1, 1];
  return (
    previous.position.every((value, index) => value === next.position[index]) &&
    previous.rotation.every((value, index) => value === next.rotation[index]) &&
    previousScale.every((value, index) => value === nextScale[index])
  );
}

function blenderSnapshotDepth(id: string, parentById: ReadonlyMap<string, string | null>) {
  let depth = 0;
  let current = parentById.get(id) ?? null;
  while (current !== null && depth <= parentById.size) {
    depth += 1;
    current = parentById.get(current) ?? null;
  }
  return depth;
}

/**
 * Re-poses the mounted preview scene from a structured snapshot instead of
 * re-downloading and re-parsing the whole GLB. Only called when the kernel
 * proved every revision since the loaded one was transform-only.
 *
 * Returns false when any visible snapshot entry has no mounted node (the GLB
 * and snapshot disagree) or a transform is non-finite; the caller then falls
 * back to the full reload path.
 */
export function applyBlenderSnapshotTransforms(
  scene: Object3D,
  previousSnapshot: BlenderLiveSceneSnapshot | null,
  nextSnapshot: BlenderLiveSceneSnapshot,
): boolean {
  const previousById = new Map<string, BlenderSnapshotTransformEntry>();
  for (const entry of previousSnapshot?.objects ?? []) previousById.set(entry.id, entry);
  for (const entry of previousSnapshot?.lights ?? []) previousById.set(entry.id, entry);

  const parentById = new Map<string, string | null>(
    nextSnapshot.objects.map((object) => [object.id, object.parentId ?? null]),
  );
  const changedEntries: Array<{ depth: number; entry: BlenderSnapshotTransformEntry }> = [];
  for (const entry of nextSnapshot.objects) {
    if (!sameBlenderEntryTransform(previousById.get(entry.id), entry)) {
      changedEntries.push({ depth: blenderSnapshotDepth(entry.id, parentById), entry });
    }
  }
  for (const entry of nextSnapshot.lights) {
    if (!sameBlenderEntryTransform(previousById.get(entry.id), entry)) {
      changedEntries.push({ depth: 0, entry });
    }
  }
  if (!changedEntries.length) return true;

  const nodeIndex = getBlenderNodeIndex(scene);
  const applies: Array<{ depth: number; entry: BlenderSnapshotTransformEntry; node: Object3D }> = [];
  for (const { depth, entry } of changedEntries) {
    const node = nodeIndex.get(entry.id);
    if (!node) {
      // Hidden datablocks are legitimately absent from the exported GLB.
      if (entry.visible === false) continue;
      return false;
    }
    const components = [...entry.position, ...entry.rotation, ...(entry.scale ?? [])];
    if (!components.every((value) => Number.isFinite(value))) return false;
    applies.push({ depth, entry, node });
  }
  if (!applies.length) return true;

  // Parents re-pose before children so every desired-world computation reads
  // an up-to-date ancestor matrix, mirroring applyDirectorTransformToBlenderObject.
  applies.sort((left, right) => left.depth - right.depth);
  scene.updateWorldMatrix(true, true);
  for (const { entry, node } of applies) {
    const desiredSceneMatrix = new Matrix4().compose(
      new Vector3(...entry.position),
      new Quaternion().setFromEuler(new Euler(entry.rotation[0], entry.rotation[1], entry.rotation[2], "XYZ")),
      entry.scale ? new Vector3(...entry.scale) : new Vector3(1, 1, 1),
    );
    const desiredWorldMatrix = new Matrix4().multiplyMatrices(scene.matrixWorld, desiredSceneMatrix);
    const desiredLocalMatrix = node.parent
      ? new Matrix4().copy(node.parent.matrixWorld).invert().multiply(desiredWorldMatrix)
      : desiredWorldMatrix;
    desiredLocalMatrix.decompose(node.position, node.quaternion, node.scale);
    node.updateMatrix();
    node.updateWorldMatrix(false, true);
  }
  return true;
}

export function prepareBlenderPreviewScene(scene: Object3D) {
  const embeddedSceneControls: Object3D[] = [];
  scene.traverse((object) => {
    const candidate = object as Object3D & { isCamera?: boolean; isLight?: boolean };
    if (candidate.isCamera || candidate.isLight) embeddedSceneControls.push(object);
  });
  embeddedSceneControls.forEach((object) => object.removeFromParent());
  scene.name = "Blender live environment";
  scene.userData.blenderLiveEnvironment = true;
  scene.userData[OWNS_IMAGE_BITMAPS_KEY] = true;
  return scene;
}

function isVisibleBlenderStaticMesh(object: Object3D, root: Object3D): object is PlayerRaycastMesh {
  const mesh = object as PlayerRaycastMesh;
  if (!mesh.isMesh || mesh.isSkinnedMesh || !mesh.geometry?.getAttribute("position")?.count) return false;

  let current: Object3D | null = object;
  while (current) {
    if (
      !current.visible ||
      current.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY] ||
      current.userData?.[COLLISION_DISABLED_KEY]
    ) {
      return false;
    }
    if (current === root) break;
    current = current.parent;
  }
  return true;
}

/** One traversal per loaded GLB revision; consumers reuse this flat set. */
export function collectBlenderStaticMeshes(scene: Object3D) {
  const meshes: PlayerRaycastMesh[] = [];
  scene.traverse((object) => {
    if (isVisibleBlenderStaticMesh(object, scene)) meshes.push(object);
  });
  return meshes;
}

export function disposeBlenderScene(scene: Object3D | null) {
  if (!scene) return;
  const geometries = new Set<BufferGeometry>();
  const textures = new Set<Texture>();
  const materials = new Set<Material>();
  const skeletons = new Set<SkinnedMesh["skeleton"]>();

  scene.traverse((object) => {
    const renderable = object as Mesh;
    if (renderable.geometry) geometries.add(renderable.geometry);
    const objectMaterials = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material
        ? [renderable.material]
        : [];
    for (const material of objectMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
    if (object instanceof SkinnedMesh) {
      skeletons.add(object.skeleton);
      if (object.skeleton.boneTexture) textures.add(object.skeleton.boneTexture);
    }
  });

  if (scene.userData[OWNS_IMAGE_BITMAPS_KEY] === true) {
    const images = new Set<unknown>();
    for (const texture of textures) {
      const image = texture.image as { close?: () => void } | undefined;
      if (!image || images.has(image) || typeof image.close !== "function") continue;
      images.add(image);
      image.close();
    }
  }

  geometries.forEach((geometry) => geometry.dispose());
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  // Bone textures were disposed with the unique texture set above. Clear the
  // skeleton references so no later Skeleton.dispose() can dispose them twice.
  skeletons.forEach((skeleton) => {
    skeleton.boneTexture = null;
  });
  scene.removeFromParent();
  scene.clear();
}

export async function parseBlenderPreviewGlb(blob: Blob) {
  const loader = configureDirectorGLTFLoader(new GLTFLoader());
  const parsed = await loader.parseAsync(await blob.arrayBuffer(), "");
  // GLTFLoader already creates a fresh object/resource graph. This layer is
  // its sole owner, so an additional deep clone only doubles load latency and
  // memory without adding isolation.
  const scene = prepareBlenderPreviewScene(parsed.scene);
  // Stage uses a reversed-Z framebuffer; flush coplanar panels must not fight
  // the wall they sit on while the live preview is the only visual.
  stabilizeImportedModelCoplanarDepth(scene, true);
  return scene;
}

function isDocumentActive() {
  return document.visibilityState !== "hidden" && document.hasFocus();
}

function BlenderSelectionHelper({
  active,
  id,
  object,
  syncEpoch = 0,
}: {
  active: boolean;
  id: string;
  object: Object3D;
  /** Transform-only syncs move the tracked object without replacing it; re-measure the box. */
  syncEpoch?: number;
}) {
  const helper = useMemo(() => {
    object.updateWorldMatrix(true, true);
    const next = new BoxHelper(object, active ? 0xf06455 : 0x54b8ff);
    next.name = `blender-selection-${id}`;
    next.material.depthTest = false;
    next.renderOrder = 1_000;
    next.userData[HIDE_FROM_VIEWPORT_CAPTURE_KEY] = true;
    next.userData[COLLISION_DISABLED_KEY] = true;
    next.raycast = () => undefined;
    return next;
  }, [active, id, object]);

  useEffect(() => {
    if (syncEpoch > 0) helper.update();
  }, [helper, syncEpoch]);

  useEffect(
    () => () => {
      helper.geometry.dispose();
      helper.material.dispose();
    },
    [helper],
  );

  return <primitive name={helper.name} object={helper} />;
}

function BlenderFloorPivotTransformControls({
  directorObject,
  mode,
  onTransformChange,
  scene,
  target,
  translationSnap,
}: {
  directorObject: DirectorObject;
  mode: TransformMode;
  onTransformChange: (transform: DirectorTransform) => void;
  scene: Object3D;
  target: Object3D;
  translationSnap: number | null;
}) {
  const [measurement, setMeasurement] = useState<{
    pivot: [number, number, number];
    target: Object3D;
  } | null>(null);

  useLayoutEffect(() => {
    if (directorObject.pivot) return;
    let animationFrameId: number | null = null;
    const measure = () => {
      const pivot = getVisibleObjectLocalFloorPivot(target);
      if (!pivot) return;
      setMeasurement((current) =>
        current?.target === target && current.pivot.every((value, index) => Math.abs(value - pivot[index]) < 0.0001)
          ? current
          : { pivot, target },
      );
    };

    measure();
    animationFrameId = window.requestAnimationFrame(measure);
    return () => {
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [directorObject.pivot, target]);

  const localFloorPivot = directorObject.pivot ?? (measurement?.target === target ? measurement.pivot : null);
  const handleTransformChange = useCallback(
    (transform: DirectorTransform) => {
      applyDirectorTransformToBlenderObject(target, scene, transform);
      onTransformChange(transform);
    },
    [onTransformChange, scene, target],
  );

  if (!localFloorPivot) return null;
  return (
    <CenteredObjectTransformControls
      localCenter={localFloorPivot}
      mode={mode}
      onTransformChange={handleTransformChange}
      transform={directorObject.transform}
      translationSnap={translationSnap}
    />
  );
}

export function BlenderSceneLayer({
  cameraAspectRatio = 16 / 9,
  interactionEnabled = true,
  isPlaying = false,
  loadScene = parseBlenderPreviewGlb,
  onActiveCameraChange,
  onCollisionEnvironmentChange,
  onStatusChange,
  pollIntervalMs = 1_200,
  projectId,
  referenceRoot,
  visible,
}: {
  cameraAspectRatio?: number;
  interactionEnabled?: boolean;
  isPlaying?: boolean;
  loadScene?: BlenderSceneLoader;
  onActiveCameraChange?: (camera: BlenderCameraViewSnapshot | null) => void;
  onCollisionEnvironmentChange?: (environment: PlayerStaticEnvironment | null) => void;
  onStatusChange?: (status: BlenderSceneLayerStatus) => void;
  pollIntervalMs?: number;
  projectId?: string;
  referenceRoot: Object3D | null;
  visible: boolean;
}) {
  const directorObjects = useDirectorStore((state) => state.project.objects);
  const directorAssets = useDirectorStore((state) => state.project.assets);
  const directorCameras = useDirectorStore((state) => state.project.cameras);
  const directorLights = useDirectorStore((state) => state.project.lights ?? []);
  const activeCameraId = useDirectorStore((state) => state.project.activeCameraId);
  const directorScene = useDirectorStore((state) => state.project.scene);
  const playheadFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const selectedObjectIds = useDirectorStore((state) => state.selectedObjectIds);
  const transformMode = useDirectorStore((state) => state.transformMode);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const prepareBlenderSync = useDirectorStore((state) => state.prepareBlenderSync);
  const syncBlenderScene = useDirectorStore((state) => state.syncBlenderScene);
  const updateObjectTransform = useDirectorStore((state) => state.updateObjectTransform);
  const runtimeSnapshot = useBlenderRuntimeStore((state) => state.snapshot);
  const publishRuntimeSnapshot = useBlenderRuntimeStore((state) => state.publishSnapshot);
  const publishRuntimeStatus = useBlenderRuntimeStore((state) => state.publishStatus);
  const publishPreviewActive = useBlenderRuntimeStore((state) => state.publishPreviewActive);
  const refreshRequestId = useBlenderRuntimeStore((state) => state.refreshRequestId);
  const completeRuntimeRefresh = useBlenderRuntimeStore((state) => state.completeRefresh);
  const nativeRigCapabilities = useBlenderRuntimeStore((state) => state.nativeRigCapabilities);
  const publishNativeRigCapability = useBlenderRuntimeStore((state) => state.publishNativeRigCapability);
  const resetBlenderRuntime = useBlenderRuntimeStore((state) => state.reset);
  const [scene, setScene] = useState<Object3D | null>(null);
  const [documentActive, setDocumentActive] = useState(isDocumentActive);
  const [selection, setSelection] = useState<BlenderSceneSelection | null>(null);
  const [stagedAssetSourceRevision, setStagedAssetSourceRevision] = useState(0);
  const [collisionSource, setCollisionSource] = useState<Omit<
    PlayerStaticEnvironment,
    "ownerId" | "referenceRoot"
  > | null>(null);
  /** Bumped by transform-only syncs so world-space chrome (selection boxes) re-measures. */
  const [nativeTransformSyncEpoch, setNativeTransformSyncEpoch] = useState(0);
  const failedVersionRef = useRef<FailedBlenderSceneVersion | null>(null);
  const loadedVersionRef = useRef<BlenderSceneVersion | null>(null);
  const mountedSceneRef = useRef<Object3D | null>(null);
  /** Snapshot whose transforms the mounted scene currently shows; delta source for the fast path. */
  const appliedSnapshotRef = useRef<BlenderLiveSceneSnapshot | null>(null);
  const synchronizedVersionRef = useRef<BlenderSceneVersion | null>(null);
  const automaticBindingProjectRef = useRef<string | null>(null);
  const bridgeInFlightRef = useRef(false);
  const stagedAssetSourcesRef = useRef(new Map<string, { assetUrl: string; sourceUrl: string }>());
  const assetStagingInFlightRef = useRef(new Set<string>());
  const failedAssetStagingRef = useRef(new Set<string>());
  const rigInspectionInFlightRef = useRef(new Set<string>());
  const onStatusChangeRef = useRef(onStatusChange);
  const onActiveCameraChangeRef = useRef(onActiveCameraChange);
  const onCollisionEnvironmentChangeRef = useRef(onCollisionEnvironmentChange);
  const publishedCollisionEnvironmentRef = useRef<PlayerStaticEnvironment | null>(null);
  const lastStatusRef = useRef<BlenderSceneLayerStatus | null>(null);
  const activeCameraSignatureRef = useRef("");
  const sequenceRef = useRef(0);
  const authoritativeSnapshot =
    runtimeSnapshot && (!projectId || !runtimeSnapshot.projectId || runtimeSnapshot.projectId === projectId)
      ? runtimeSnapshot
      : null;

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    const updateDocumentActive = () => setDocumentActive(isDocumentActive());
    window.addEventListener("focus", updateDocumentActive);
    window.addEventListener("blur", updateDocumentActive);
    document.addEventListener("visibilitychange", updateDocumentActive);
    return () => {
      window.removeEventListener("focus", updateDocumentActive);
      window.removeEventListener("blur", updateDocumentActive);
      document.removeEventListener("visibilitychange", updateDocumentActive);
    };
  }, []);

  useEffect(() => {
    onActiveCameraChangeRef.current = onActiveCameraChange;
  }, [onActiveCameraChange]);

  useEffect(() => {
    onCollisionEnvironmentChangeRef.current = onCollisionEnvironmentChange;
  }, [onCollisionEnvironmentChange]);

  useEffect(() => {
    synchronizedVersionRef.current = null;
    automaticBindingProjectRef.current = null;
    resetBlenderRuntime();
  }, [projectId, resetBlenderRuntime]);

  useEffect(() => {
    publishPreviewActive(Boolean(visible && scene));
  }, [publishPreviewActive, scene, visible]);

  useEffect(() => () => publishPreviewActive(false), [publishPreviewActive]);

  const hiddenVisualIds = useMemo(
    () => collectHiddenBlenderVisualIds(directorObjects, authoritativeSnapshot),
    [authoritativeSnapshot, directorObjects],
  );
  const hiddenVisualIdsRef = useRef(hiddenVisualIds);
  hiddenVisualIdsRef.current = hiddenVisualIds;

  useLayoutEffect(() => {
    if (!scene) return;
    if (authoritativeSnapshot) {
      applyBlenderDirectorSegmentationMetadata(scene, authoritativeSnapshot, directorObjects);
    }
    applyDirectorOwnedBlenderVisibility(scene, hiddenVisualIds);
    const version = loadedVersionRef.current;
    if (!version) return;
    const meshes = collectBlenderStaticMeshes(scene);
    const versionKey = `${version.sceneEpoch}:${version.revision}`;
    setCollisionSource((current) =>
      current?.root === scene &&
      current.versionKey === versionKey &&
      current.meshes.length === meshes.length &&
      current.meshes.every((mesh, index) => mesh === meshes[index])
        ? current
        : { meshes, root: scene, versionKey },
    );
  }, [authoritativeSnapshot, directorObjects, hiddenVisualIds, nativeTransformSyncEpoch, scene]);

  useEffect(() => {
    const nextEnvironment =
      visible && collisionSource && referenceRoot
        ? {
            ...collisionSource,
            ownerId: BLENDER_LIVE_COLLISION_OWNER,
            referenceRoot,
          }
        : null;
    if (publishedCollisionEnvironmentRef.current === nextEnvironment) return;
    publishedCollisionEnvironmentRef.current = nextEnvironment;
    onCollisionEnvironmentChangeRef.current?.(nextEnvironment);
  }, [collisionSource, referenceRoot, visible]);

  useEffect(
    () => () => {
      if (publishedCollisionEnvironmentRef.current) onCollisionEnvironmentChangeRef.current?.(null);
      publishedCollisionEnvironmentRef.current = null;
    },
    [],
  );

  const publishStatus = useCallback((status: BlenderSceneLayerStatus) => {
    const previous = lastStatusRef.current;
    if (
      previous?.phase === status.phase &&
      previous.revision === status.revision &&
      previous.targetRevision === status.targetRevision &&
      previous.message === status.message
    ) {
      return;
    }
    lastStatusRef.current = status;
    onStatusChangeRef.current?.(status);
  }, []);

  const publishSceneInteraction = useCallback(
    (snapshot: BlenderLiveSceneSnapshot) => {
      publishRuntimeSnapshot(snapshot);
      const nextSelection = {
        sceneEpoch: snapshot.sceneEpoch,
        revision: snapshot.revision,
        activeObjectId: snapshot.activeObjectId,
        selectedObjectIds: snapshot.selectedObjectIds,
      };
      setSelection((current) => (sameSelection(current, nextSelection) ? current : nextSelection));

      const snapshotVersion = { sceneEpoch: snapshot.sceneEpoch, revision: snapshot.revision };
      if (
        projectId &&
        snapshot.projectId === projectId &&
        !sameVersion(synchronizedVersionRef.current, snapshotVersion)
      ) {
        synchronizedVersionRef.current = snapshotVersion;
        syncBlenderScene(snapshot);
      }

      const activeCamera = snapshot.cameras.find((camera) => camera.active) ?? null;
      const signature = activeCamera
        ? JSON.stringify([
            snapshot.sceneEpoch,
            activeCamera.id,
            activeCamera.position,
            activeCamera.rotation,
            activeCamera.projectionType,
            activeCamera.focalLengthMm,
            activeCamera.sensorFit,
            activeCamera.sensorWidthMm,
            activeCamera.sensorHeightMm,
            activeCamera.shiftX,
            activeCamera.shiftY,
            activeCamera.clipStart,
            activeCamera.clipEnd,
            activeCamera.orthographicScale,
            cameraAspectRatio,
          ])
        : `${snapshot.sceneEpoch}:none`;
      if (signature === activeCameraSignatureRef.current) return;
      activeCameraSignatureRef.current = signature;
      onActiveCameraChangeRef.current?.(
        activeCamera ? getBlenderCameraViewSnapshot(activeCamera, cameraAspectRatio) : null,
      );
    },
    [cameraAspectRatio, projectId, publishRuntimeSnapshot, syncBlenderScene],
  );

  useEffect(() => {
    mountedSceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    if (!scene) return;
    return () => disposeBlenderScene(scene);
  }, [scene]);

  useEffect(() => {
    const sequence = ++sequenceRef.current;
    const requestedRefreshId = refreshRequestId;
    const abortController = new AbortController();
    let timer: number | null = null;
    let stopped = false;

    publishStatus({
      phase: visible ? "connecting" : "hidden",
      revision: loadedVersionRef.current?.revision ?? null,
    });

    const poll = async () => {
      let targetVersion: BlenderSceneVersion | null = null;
      let receivedLiveStatus = false;
      try {
        const status = await getBlenderLiveStatus({ signal: abortController.signal });
        if (stopped || sequenceRef.current !== sequence) return;
        receivedLiveStatus = true;
        publishRuntimeStatus(status);
        if (!status.available) {
          publishStatus({
            phase: loadedVersionRef.current === null ? "offline" : "stale",
            revision: loadedVersionRef.current?.revision ?? null,
            message: status.reason,
          });
          return;
        }
        if (status.busy) {
          publishStatus({
            phase: "syncing",
            revision: loadedVersionRef.current?.revision ?? null,
            targetRevision: status.revision,
            message: "Blender is applying scene edits.",
          });
          return;
        }
        const needsProjectBinding = Boolean(projectId && status.projectId !== projectId);
        if (projectId && status.projectId === projectId) automaticBindingProjectRef.current = projectId;
        if (needsProjectBinding && !documentActive) {
          publishStatus({
            phase: loadedVersionRef.current === null ? "offline" : "stale",
            revision: loadedVersionRef.current?.revision ?? null,
            targetRevision: status.revision,
            message: "Modeling is active in another Director project.",
          });
          return;
        }
        if (needsProjectBinding && automaticBindingProjectRef.current === projectId) {
          publishStatus({
            phase: loadedVersionRef.current === null ? "offline" : "stale",
            revision: loadedVersionRef.current?.revision ?? null,
            targetRevision: status.revision,
            message: "Modeling is active in another Director project.",
          });
          return;
        }
        targetVersion = { revision: status.revision, sceneEpoch: status.sceneEpoch };
        const snapshot = needsProjectBinding
          ? await bindBlenderDirectorProject(projectId!, { signal: abortController.signal })
          : await getBlenderLiveScene({ signal: abortController.signal });
        if (stopped || sequenceRef.current !== sequence) return;
        if (needsProjectBinding) automaticBindingProjectRef.current = projectId!;
        const snapshotVersion = { revision: snapshot.revision, sceneEpoch: snapshot.sceneEpoch };
        if (needsProjectBinding) targetVersion = snapshotVersion;
        if (sameVersion(targetVersion, snapshotVersion)) publishSceneInteraction(snapshot);
        if (!visible) {
          publishStatus({ phase: "hidden", revision: loadedVersionRef.current?.revision ?? null });
          return;
        }
        if (sameVersion(targetVersion, loadedVersionRef.current)) {
          failedVersionRef.current = null;
          publishStatus({ phase: "ready", revision: status.revision });
          return;
        }

        const failedVersion = failedVersionRef.current;
        if (failedVersion && sameVersion(targetVersion, failedVersion) && Date.now() < failedVersion.retryAt) {
          publishStatus({
            phase: loadedVersionRef.current === null ? "offline" : "stale",
            revision: loadedVersionRef.current?.revision ?? null,
            targetRevision: targetVersion.revision,
            message: failedVersion.message,
          });
          return;
        }
        if (!sameVersion(targetVersion, failedVersion)) failedVersionRef.current = null;

        // Transform-only fast path: when the kernel proves every revision
        // since the loaded one only moved existing datablocks
        // (contentRevision stayed at or below the loaded revision), re-pose
        // the mounted scene from the snapshot instead of downloading and
        // re-parsing the whole preview GLB on the main thread.
        const mountedScene = mountedSceneRef.current;
        const rePoseBaseVersion = loadedVersionRef.current;
        if (
          mountedScene &&
          rePoseBaseVersion &&
          rePoseBaseVersion.sceneEpoch === targetVersion.sceneEpoch &&
          sameVersion(targetVersion, snapshotVersion) &&
          typeof snapshot.contentRevision === "number" &&
          snapshot.contentRevision <= rePoseBaseVersion.revision &&
          applyBlenderSnapshotTransforms(mountedScene, appliedSnapshotRef.current, snapshot)
        ) {
          loadedVersionRef.current = snapshotVersion;
          appliedSnapshotRef.current = snapshot;
          failedVersionRef.current = null;
          setNativeTransformSyncEpoch((epoch) => epoch + 1);
          invalidate();
          publishStatus({ phase: "ready", revision: snapshot.revision });
          return;
        }

        publishStatus({
          phase: "syncing",
          revision: loadedVersionRef.current?.revision ?? null,
          targetRevision: status.revision,
        });
        const preview = await getBlenderLivePreviewGlb({ signal: abortController.signal });
        const previewVersion = { revision: preview.revision, sceneEpoch: preview.sceneEpoch };
        if (!sameVersion(targetVersion, previewVersion)) {
          throw new Error(
            `Blender preview version ${preview.sceneEpoch}:${preview.revision} does not match ${targetVersion.sceneEpoch}:${targetVersion.revision}.`,
          );
        }
        const nextScene = await loadScene(preview.blob);
        const loadedVersion = loadedVersionRef.current;
        const previewRegressed =
          loadedVersion?.sceneEpoch === previewVersion.sceneEpoch && previewVersion.revision < loadedVersion.revision;
        if (stopped || sequenceRef.current !== sequence || previewRegressed) {
          disposeBlenderScene(nextScene);
          return;
        }
        loadedVersionRef.current = previewVersion;
        // The delta source is only trustworthy when the structured snapshot
        // and the GLB describe the same revision; otherwise the next fast
        // path re-applies every transform against the fresh scene.
        appliedSnapshotRef.current = sameVersion(previewVersion, snapshotVersion) ? snapshot : null;
        failedVersionRef.current = null;
        applyDirectorOwnedBlenderVisibility(nextScene, hiddenVisualIdsRef.current);
        setCollisionSource({
          meshes: collectBlenderStaticMeshes(nextScene),
          root: nextScene,
          versionKey: `${preview.sceneEpoch}:${preview.revision}`,
        });
        setScene(nextScene);
        publishStatus({ phase: "ready", revision: preview.revision });
      } catch (error) {
        if (stopped || abortController.signal.aborted || sequenceRef.current !== sequence) return;
        const message = error instanceof Error ? error.message : "Blender preview unavailable.";
        if (!receivedLiveStatus) {
          publishRuntimeStatus({
            available: false,
            contract: BLENDER_LIVE_CONTRACT,
            reason: message,
          });
        }
        if (targetVersion) {
          const previousFailure = failedVersionRef.current;
          const attempts =
            previousFailure && sameVersion(targetVersion, previousFailure)
              ? Math.min(previousFailure.attempts + 1, MAX_PREVIEW_RETRY_EXPONENT)
              : 1;
          const retryDelay = Math.min(MAX_PREVIEW_RETRY_DELAY_MS, Math.max(500, pollIntervalMs) * 2 ** (attempts - 1));
          failedVersionRef.current = {
            ...targetVersion,
            attempts,
            message,
            retryAt: Date.now() + retryDelay,
          };
        }
        publishStatus({
          phase: loadedVersionRef.current === null ? "offline" : "stale",
          revision: loadedVersionRef.current?.revision ?? null,
          targetRevision: targetVersion?.revision,
          message,
        });
      } finally {
        if (!stopped && sequenceRef.current === sequence) {
          completeRuntimeRefresh(requestedRefreshId);
          timer = window.setTimeout(
            () => void poll(),
            visible ? Math.max(250, pollIntervalMs) : Math.max(4_000, pollIntervalMs),
          );
        }
      }
    };

    void poll();
    return () => {
      stopped = true;
      abortController.abort();
      sequenceRef.current += 1;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    completeRuntimeRefresh,
    documentActive,
    loadScene,
    pollIntervalMs,
    projectId,
    publishRuntimeStatus,
    publishSceneInteraction,
    publishStatus,
    refreshRequestId,
    visible,
  ]);

  useEffect(() => {
    if (!visible || !projectId || !authoritativeSnapshot) return;
    const nativeRoots = blenderSnapshotRoots(authoritativeSnapshot);
    const nativeRootIds = new Set(nativeRoots.map((root) => root.id));
    const nativeDirectorIds = new Set(nativeRoots.flatMap((root) => (root.directorId ? [root.directorId] : [])));
    const assetsById = new Map(directorAssets.map((asset) => [asset.id, asset]));

    for (const object of directorObjects) {
      if (
        object.id !== selectedObjectId ||
        object.nativeSource?.engine !== "blender" ||
        object.nativeSource.provisioned !== false ||
        nativeRootIds.has(object.nativeSource.objectId) ||
        nativeDirectorIds.has(object.id) ||
        !object.assetRefId
      ) {
        continue;
      }
      const asset = assetsById.get(object.assetRefId);
      if (!asset || asset.sourceType !== "model" || !requiresBlenderAssetStaging(asset.url)) continue;
      // Splat captures never reach Blender, so staging their bytes would be wasted upload.
      if (isDirectorSplatAssetFileName(asset.fileName)) continue;
      const stagingKey = `${asset.id}\u0000${asset.url}`;
      const staged = stagedAssetSourcesRef.current.get(asset.id);
      if (
        staged?.assetUrl === asset.url ||
        assetStagingInFlightRef.current.has(stagingKey) ||
        failedAssetStagingRef.current.has(stagingKey)
      ) {
        continue;
      }

      assetStagingInFlightRef.current.add(stagingKey);
      void fetch(asset.url)
        .then((response) => {
          if (!response.ok) throw new Error(`Asset source returned HTTP ${response.status}.`);
          return response.blob();
        })
        .then((blob) => uploadBlenderModelAsset(blob, asset.fileName, asset.id))
        .then((uploaded) => {
          stagedAssetSourcesRef.current.set(asset.id, {
            assetUrl: asset.url,
            sourceUrl: directorControlPlaneUrl(uploaded.url),
          });
          setStagedAssetSourceRevision((revision) => revision + 1);
        })
        .catch((error) => {
          failedAssetStagingRef.current.add(stagingKey);
          publishStatus({
            phase: "stale",
            revision: loadedVersionRef.current?.revision ?? null,
            message: error instanceof Error ? error.message : "Director could not stage the native asset.",
          });
        })
        .finally(() => assetStagingInFlightRef.current.delete(stagingKey));
    }
  }, [authoritativeSnapshot, directorAssets, directorObjects, projectId, publishStatus, selectedObjectId, visible]);

  useEffect(() => {
    if (!visible || !authoritativeSnapshot || authoritativeSnapshot.projectId !== projectId) return;
    const objectsById = new Map(authoritativeSnapshot.objects.map((object) => [object.id, object]));
    const belongsToRoot = (objectId: string, rootObjectId: string) => {
      let current = objectsById.get(objectId);
      while (current) {
        if (current.id === rootObjectId) return true;
        current = current.parentId ? objectsById.get(current.parentId) : undefined;
      }
      return false;
    };

    for (const object of directorObjects) {
      if (
        object.kind !== "character" ||
        object.nativeSource?.engine !== "blender" ||
        object.nativeSource.provisioned === false
      ) {
        continue;
      }
      const rootObjectId = object.nativeSource.objectId;
      const existing = useBlenderRuntimeStore.getState().nativeRigCapabilities[rootObjectId];
      if (
        existing?.sceneEpoch === authoritativeSnapshot.sceneEpoch &&
        existing.revision === authoritativeSnapshot.revision
      ) {
        continue;
      }
      const armature = authoritativeSnapshot.objects.find(
        (candidate) => candidate.type === "ARMATURE" && belongsToRoot(candidate.id, rootObjectId),
      );
      if (!armature) {
        publishNativeRigCapability({
          rootObjectId,
          status: "unsupported",
          compatible: false,
          reason: "所选 Blender 资产中未找到骨架。",
          missingBoneRoles: [],
          mappedBoneCount: 0,
          sceneEpoch: authoritativeSnapshot.sceneEpoch,
          revision: authoritativeSnapshot.revision,
        });
        continue;
      }
      const inspectionKey = `${authoritativeSnapshot.sceneEpoch}:${authoritativeSnapshot.revision}:${armature.id}`;
      if (rigInspectionInFlightRef.current.has(inspectionKey)) continue;
      rigInspectionInFlightRef.current.add(inspectionKey);
      publishNativeRigCapability({
        rootObjectId,
        status: "checking",
        compatible: false,
        missingBoneRoles: [],
        mappedBoneCount: 0,
        sceneEpoch: authoritativeSnapshot.sceneEpoch,
        revision: authoritativeSnapshot.revision,
      });
      void inspectBlenderLiveObject(armature.id, {
        expectedSceneEpoch: authoritativeSnapshot.sceneEpoch,
        expectedRevision: authoritativeSnapshot.revision,
      })
        .then(({ inspection }) => {
          const current = useBlenderRuntimeStore.getState().snapshot;
          if (
            current?.sceneEpoch !== authoritativeSnapshot.sceneEpoch ||
            current.revision !== authoritativeSnapshot.revision ||
            inspection.type !== "ARMATURE" ||
            !inspection.rig
          ) {
            return;
          }
          const compatibility = inspection.rig.mixamoCompatibility;
          publishNativeRigCapability({
            rootObjectId,
            status: compatibility?.compatible ? "ready" : "unsupported",
            compatible: compatibility?.compatible === true,
            reason: compatibility?.compatible
              ? undefined
              : compatibility
                ? "Blender 骨架缺少 Director 角色所需的标准骨骼。"
                : "Blender 骨架未报告角色兼容性。",
            missingBoneRoles: compatibility?.missingBoneRoles ?? [],
            mappedBoneCount: compatibility?.mappedBoneCount ?? 0,
            sceneEpoch: authoritativeSnapshot.sceneEpoch,
            revision: authoritativeSnapshot.revision,
            inspection,
          });
        })
        .catch((error) => {
          const current = useBlenderRuntimeStore.getState().snapshot;
          if (
            current?.sceneEpoch !== authoritativeSnapshot.sceneEpoch ||
            current.revision !== authoritativeSnapshot.revision
          ) {
            return;
          }
          publishNativeRigCapability({
            rootObjectId,
            status: "error",
            compatible: false,
            reason: error instanceof Error ? error.message : String(error),
            missingBoneRoles: [],
            mappedBoneCount: 0,
            sceneEpoch: authoritativeSnapshot.sceneEpoch,
            revision: authoritativeSnapshot.revision,
          });
        })
        .finally(() => rigInspectionInFlightRef.current.delete(inspectionKey));
    }
  }, [authoritativeSnapshot, directorObjects, projectId, publishNativeRigCapability, visible]);

  useEffect(() => {
    if (
      !visible ||
      !documentActive ||
      !projectId ||
      authoritativeSnapshot?.projectId !== projectId ||
      bridgeInFlightRef.current
    ) {
      return;
    }
    const stagedAssetSources = new Map(
      [...stagedAssetSourcesRef.current].map(([assetId, source]) => [assetId, source.sourceUrl]),
    );
    const provisionObjectIds = new Set(selectedObjectId ? [selectedObjectId] : []);
    const operations = buildDirectorBlenderOperations(
      authoritativeSnapshot,
      directorObjects,
      directorAssets,
      stagedAssetSources,
      provisionObjectIds,
      directorCameras,
      directorLights,
      activeCameraId,
    );
    const characterOperations: BlenderAgentOperation[] = [];
    if (!isPlaying) {
      for (const object of directorObjects) {
        if (object.kind !== "character" || object.nativeSource?.engine !== "blender") continue;
        const capability = nativeRigCapabilities[object.nativeSource.objectId];
        const inspection = capability?.inspection;
        if (
          capability?.status !== "ready" ||
          !capability.compatible ||
          capability.sceneEpoch !== authoritativeSnapshot.sceneEpoch ||
          capability.revision !== authoritativeSnapshot.revision ||
          inspection?.type !== "ARMATURE" ||
          !inspection.rig
        ) {
          continue;
        }
        characterOperations.push(
          ...buildBlenderCharacterOperations({
            object,
            inspection: { ...inspection, rig: inspection.rig },
            currentFrame: playheadFrame,
          }),
        );
      }
    }
    if (!isPlaying && authoritativeSnapshot.frame !== playheadFrame) {
      operations.push(blenderSetSceneFrameOperation(playheadFrame));
    }
    operations.push(...characterOperations);
    if (!operations.length) return;

    const timer = window.setTimeout(() => {
      bridgeInFlightRef.current = true;
      void applyBlenderRuntimeOperations({
        expectedSceneEpoch: authoritativeSnapshot.sceneEpoch,
        expectedRevision: authoritativeSnapshot.revision,
        operations,
        beforePublish: (result) => {
          prepareBlenderSync({
            sceneEpoch: result.receipt.sceneEpoch,
            revision: result.receipt.revisionAfter,
            origin: "director-projection",
          });
        },
      })
        .then(({ projectedSnapshot: snapshot }) => {
          if (!snapshot) return;
          if (useDirectorStore.getState().project.nativeScene?.projectId !== snapshot.projectId) return;
          publishSceneInteraction(snapshot);
        })
        .catch((error) => {
          publishStatus({
            phase: "stale",
            revision: loadedVersionRef.current?.revision ?? null,
            message: error instanceof Error ? error.message : "Director could not update the native asset.",
          });
        })
        .finally(() => {
          bridgeInFlightRef.current = false;
        });
    }, 160);

    return () => window.clearTimeout(timer);
  }, [
    authoritativeSnapshot,
    activeCameraId,
    directorAssets,
    directorCameras,
    directorLights,
    directorObjects,
    directorScene.timeline?.fps,
    documentActive,
    isPlaying,
    nativeRigCapabilities,
    playheadFrame,
    prepareBlenderSync,
    projectId,
    publishSceneInteraction,
    publishStatus,
    selectedObjectId,
    stagedAssetSourceRevision,
    visible,
  ]);

  const directorNativeSelection = useMemo(() => {
    const selectedIds = selectedObjectIds.length ? selectedObjectIds : selectedObjectId ? [selectedObjectId] : [];
    const nativeIds = selectedIds.flatMap((id) => {
      const object = directorObjects.find((candidate) => candidate.id === id);
      return object?.nativeSource?.engine === "blender" ? [object.nativeSource.objectId] : [];
    });
    const activeObject = selectedObjectId
      ? directorObjects.find((object) => object.id === selectedObjectId)
      : undefined;
    return {
      activeObjectId: activeObject?.nativeSource?.engine === "blender" ? activeObject.nativeSource.objectId : null,
      selectedObjectIds: nativeIds,
    };
  }, [directorObjects, selectedObjectId, selectedObjectIds]);

  const selectionTargets = useMemo(() => {
    if (!scene) return [];
    const targets = directorNativeSelection.selectedObjectIds.length
      ? collectBlenderSelectionTargets(
          scene,
          directorNativeSelection.selectedObjectIds,
          directorNativeSelection.activeObjectId,
        )
      : selection && sameVersion(selection, loadedVersionRef.current)
        ? collectBlenderSelectionTargets(scene, selection.selectedObjectIds, selection.activeObjectId)
        : [];
    return targets.filter((target) => !hiddenVisualIds.has(target.id));
  }, [directorNativeSelection, hiddenVisualIds, scene, selection]);

  const selectedNativeObject = useMemo(() => {
    if (!selectedObjectId || selectedObjectIds.length > 1) return null;
    const object = directorObjects.find((candidate) => candidate.id === selectedObjectId);
    return object?.nativeSource?.engine === "blender" ? object : null;
  }, [directorObjects, selectedObjectId, selectedObjectIds.length]);
  const selectedNativeTarget = useMemo(
    () =>
      scene && selectedNativeObject ? findBlenderSceneObject(scene, selectedNativeObject.nativeSource!.objectId) : null,
    [scene, selectedNativeObject],
  );
  const nativeTransformEnabled = Boolean(
    interactionEnabled &&
    selectedNativeObject &&
    selectedNativeTarget &&
    !directorRendersCharacterAsset(selectedNativeObject) &&
    !isDirectorObjectEffectivelyLocked(directorScene, selectedNativeObject),
  );

  const commitNativeTransform = useCallback(() => {
    if (!scene || !selectedNativeObject || !selectedNativeTarget) return;
    updateObjectTransform(selectedNativeObject.id, getDirectorTransformFromBlenderObject(selectedNativeTarget, scene));
  }, [scene, selectedNativeObject, selectedNativeTarget, updateObjectTransform]);

  useEffect(() => {
    if (!selectedNativeObject || !authoritativeSnapshot || !visible) return;
    const nativeId = selectedNativeObject.nativeSource!.objectId;
    const authoritativeSelectionMatches = isBlenderSelectionWithinRoot(
      authoritativeSnapshot,
      nativeId,
      authoritativeSnapshot.activeObjectId,
      authoritativeSnapshot.selectedObjectIds,
    );
    const localSelectionMatches =
      selection?.sceneEpoch === authoritativeSnapshot.sceneEpoch &&
      selection.revision === authoritativeSnapshot.revision &&
      isBlenderSelectionWithinRoot(
        authoritativeSnapshot,
        nativeId,
        selection.activeObjectId,
        selection.selectedObjectIds,
      );
    const runtimeSelectionMatches =
      runtimeSnapshot?.sceneEpoch === authoritativeSnapshot.sceneEpoch &&
      runtimeSnapshot.revision === authoritativeSnapshot.revision &&
      isBlenderSelectionWithinRoot(
        runtimeSnapshot,
        nativeId,
        runtimeSnapshot.activeObjectId,
        runtimeSnapshot.selectedObjectIds,
      );
    if (authoritativeSelectionMatches || localSelectionMatches || runtimeSelectionMatches) return;

    void applyBlenderRuntimeOperations({
      expectedSceneEpoch: authoritativeSnapshot.sceneEpoch,
      expectedRevision: authoritativeSnapshot.revision,
      operations: [{ op: "set_selection", selectedIds: [nativeId], activeId: nativeId, mode: "OBJECT" }],
    })
      .then((result) => {
        const nextSelection = {
          sceneEpoch: authoritativeSnapshot.sceneEpoch,
          revision: result.receipt.revisionAfter,
          activeObjectId: result.receipt.selection.activeObjectId,
          selectedObjectIds: result.receipt.selection.selectedObjectIds,
        };
        setSelection((current) => (sameSelection(current, nextSelection) ? current : nextSelection));
      })
      .catch((error) => {
        publishStatus({
          phase: "stale",
          revision: loadedVersionRef.current?.revision ?? null,
          message: error instanceof Error ? error.message : "Blender selection unavailable.",
        });
      });
  }, [authoritativeSnapshot, publishStatus, runtimeSnapshot, selectedNativeObject, selection, visible]);

  const selectNativeObject = useCallback(
    async (object: Object3D) => {
      if (!scene || !selection || !sameVersion(selection, loadedVersionRef.current)) return;
      const id = findBlenderStableObjectId(object, scene);
      if (!id) return;
      const root = authoritativeSnapshot ? findBlenderSnapshotRoot(authoritativeSnapshot, id) : null;
      const nativeId = root?.id ?? id;
      const directorObject = directorObjects.find(
        (candidate) =>
          candidate.nativeSource?.objectId === nativeId ||
          candidate.id === root?.directorId ||
          candidate.id === `native:${nativeId}`,
      );
      const optimisticSelection = {
        sceneEpoch: selection.sceneEpoch,
        revision: selection.revision,
        activeObjectId: nativeId,
        selectedObjectIds: [nativeId],
      };
      setSelection((current) => (sameSelection(current, optimisticSelection) ? current : optimisticSelection));
      if (directorObject) selectObject(directorObject.id);
      try {
        const result = await applyBlenderRuntimeOperations({
          expectedSceneEpoch: selection.sceneEpoch,
          expectedRevision: selection.revision,
          operations: [{ op: "set_selection", selectedIds: [nativeId], activeId: nativeId, mode: "OBJECT" }],
        });
        const nextSelection = {
          sceneEpoch: selection.sceneEpoch,
          revision: result.receipt.revisionAfter,
          activeObjectId: result.receipt.selection.activeObjectId,
          selectedObjectIds: result.receipt.selection.selectedObjectIds,
        };
        setSelection((current) => (sameSelection(current, nextSelection) ? current : nextSelection));
      } catch (error) {
        publishStatus({
          phase: "stale",
          revision: loadedVersionRef.current?.revision ?? null,
          message: error instanceof Error ? error.message : "Blender selection unavailable.",
        });
      }
    },
    [authoritativeSnapshot, directorObjects, publishStatus, scene, selectObject, selection],
  );

  if (!scene) return null;
  return (
    <>
      <primitive
        key={scene.uuid}
        object={scene}
        visible={visible}
        onClick={
          interactionEnabled
            ? (event: ThreeEvent<MouseEvent>) => {
                event.stopPropagation();
                const clickedObject = event.object ?? (event.nativeEvent as MouseEvent & { object?: Object3D }).object;
                if (clickedObject) void selectNativeObject(clickedObject);
              }
            : undefined
        }
      />
      {visible
        ? selectionTargets.map((target) => (
            <BlenderSelectionHelper key={target.id} {...target} syncEpoch={nativeTransformSyncEpoch} />
          ))
        : null}
      {visible && nativeTransformEnabled && selectedNativeObject && selectedNativeTarget ? (
        <BlenderFloorPivotTransformControls
          directorObject={selectedNativeObject}
          mode={transformMode}
          onTransformChange={commitNativeTransform}
          scene={scene}
          target={selectedNativeTarget}
          translationSnap={transformMode === "translate" && directorScene.snapToGrid ? 1 : null}
        />
      ) : null}
    </>
  );
}
