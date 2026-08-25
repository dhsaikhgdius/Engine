import { Box3, Euler, Matrix4, Quaternion, Vector3, type Camera, type Object3D } from "three";
import type { DirectorObject, SceneSettings } from "../schema/directorProject";
import { isDirectorObjectEffectivelyVisible } from "../schema/objectLayers";
import {
  getDirectorObjectBatchCount,
  getDirectorObjectBatchLocalBoundsAt,
  isDirectorObjectBatchMesh,
} from "./directorObjectBatch";

/** The viewport rectangle in CSS pixels, relative to the canvas element. */
export interface LassoViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The lasso selection rectangle in screen coordinates. */
export interface LassoScreenRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/** The screen-space bounding box of an object, used for lasso intersection tests. */
export interface LassoObjectScreenBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function composeTransform(transform: DirectorObject["transform"]) {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation)),
    new Vector3(...transform.scale),
  );
}

function getObjectWorldMatrix(
  object: DirectorObject,
  objectsById: Map<string, DirectorObject>,
  cache: Map<string, Matrix4>,
  visiting: Set<string>,
) {
  const cached = cache.get(object.id);
  if (cached) return cached;

  const localMatrix = composeTransform(object.transform);
  if (object.parentObjectId && !visiting.has(object.id)) {
    const parent = objectsById.get(object.parentObjectId);
    if (parent) {
      visiting.add(object.id);
      localMatrix.premultiply(getObjectWorldMatrix(parent, objectsById, cache, visiting));
      visiting.delete(object.id);
    }
  }

  cache.set(object.id, localMatrix);
  return localMatrix;
}

function getSceneMatrix(scene: SceneSettings) {
  return new Matrix4().compose(
    new Vector3(...scene.position),
    new Quaternion().setFromEuler(new Euler(...scene.rotation)),
    new Vector3(scene.scale, scene.scale, scene.scale),
  );
}

function getScreenPoint(
  object: DirectorObject,
  objectsById: Map<string, DirectorObject>,
  matrixCache: Map<string, Matrix4>,
  sceneMatrix: Matrix4,
  camera: Camera,
  viewport: LassoViewportRect,
) {
  const worldMatrix = sceneMatrix.clone().multiply(getObjectWorldMatrix(object, objectsById, matrixCache, new Set()));
  const worldPosition = new Vector3().setFromMatrixPosition(worldMatrix);
  const projected = worldPosition.project(camera);

  if (projected.z < -1 || projected.z > 1) return null;

  return {
    x: viewport.left + (projected.x * 0.5 + 0.5) * viewport.width,
    y: viewport.top + (-projected.y * 0.5 + 0.5) * viewport.height,
  };
}

/**
 * Computes screen-space bounding boxes for every visible object in the scene
 * by projecting their world-space bounds through the camera.
 * Supports both regular objects and instanced batch meshes.
 *
 * @param sceneRoot - The root Object3D of the scene.
 * @param camera - The current camera.
 * @param viewport - The viewport rectangle in CSS pixels.
 * @returns A map from object id to its screen-space bounds.
 */
export function getLassoObjectScreenBounds(sceneRoot: Object3D, camera: Camera, viewport: LassoViewportRect) {
  const result = new Map<string, LassoObjectScreenBounds>();
  const bounds = new Box3();
  const corner = new Vector3();
  const instanceMatrix = new Matrix4();
  const instanceWorldMatrix = new Matrix4();
  const instanceBounds = new Box3();
  sceneRoot.updateMatrixWorld(true);

  const collectBounds = (objectId: string) => {
    if (result.has(objectId)) return;
    if (bounds.isEmpty()) return;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          const projected = corner.set(x, y, z).project(camera);
          if (projected.z < -1 || projected.z > 1) continue;
          const screenX = viewport.left + (projected.x * 0.5 + 0.5) * viewport.width;
          const screenY = viewport.top + (-projected.y * 0.5 + 0.5) * viewport.height;
          minX = Math.min(minX, screenX);
          minY = Math.min(minY, screenY);
          maxX = Math.max(maxX, screenX);
          maxY = Math.max(maxY, screenY);
        }

    if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
      result.set(objectId, { minX, minY, maxX, maxY });
    }
  };

  sceneRoot.traverse((root) => {
    const instanceObjectIds = root.userData?.directorInstanceObjectIds;
    if (Array.isArray(instanceObjectIds) && isDirectorObjectBatchMesh(root)) {
      instanceObjectIds.slice(0, getDirectorObjectBatchCount(root)).forEach((objectId, index) => {
        if (typeof objectId !== "string") return;
        if (!getDirectorObjectBatchLocalBoundsAt(root, index, instanceBounds)) return;
        root.getMatrixAt(index, instanceMatrix);
        instanceWorldMatrix.multiplyMatrices(root.matrixWorld, instanceMatrix);
        bounds.copy(instanceBounds).applyMatrix4(instanceWorldMatrix);
        collectBounds(objectId);
      });
      return;
    }

    const objectId = root.userData?.directorObjectId;
    if (typeof objectId !== "string" || result.has(objectId)) return;
    bounds.setFromObject(root, true);
    collectBounds(objectId);
  });

  return result;
}

/**
 * Returns the set of object ids that intersect the lasso selection rectangle.
 * Uses screen-space bounds when available (from `getLassoObjectScreenBounds`),
 * falling back to per-object center-point projection.
 * Composite parents and crowd members are resolved to their container ids.
 *
 * @param options.camera - The current camera.
 * @param options.objects - All director objects in the project.
 * @param options.scene - The scene settings.
 * @param options.selection - The lasso rectangle in screen coordinates.
 * @param options.screenBoundsById - Pre-computed screen bounds keyed by object id.
 * @param options.viewport - The viewport rectangle in CSS pixels.
 * @returns An array of selected object ids.
 */
export function getLassoSelectionIds({
  camera,
  objects,
  scene,
  selection,
  screenBoundsById,
  viewport,
}: {
  camera: Camera;
  objects: DirectorObject[];
  scene: SceneSettings;
  selection: LassoScreenRect;
  screenBoundsById?: ReadonlyMap<string, LassoObjectScreenBounds>;
  viewport: LassoViewportRect;
}) {
  const minX = Math.min(selection.startX, selection.endX);
  const maxX = Math.max(selection.startX, selection.endX);
  const minY = Math.min(selection.startY, selection.endY);
  const maxY = Math.max(selection.startY, selection.endY);
  const objectsById = new Map(objects.map((object) => [object.id, object]));
  const matrixCache = new Map<string, Matrix4>();
  const sceneMatrix = getSceneMatrix(scene);
  const selectedIds = new Set<string>();
  const selectedCrowdIds = new Set<string>();

  objects.forEach((object) => {
    if (!isDirectorObjectEffectivelyVisible(scene, object)) return;
    const screenBounds = screenBoundsById?.get(object.id);
    const intersectsSelection = screenBounds
      ? screenBounds.maxX >= minX && screenBounds.minX <= maxX && screenBounds.maxY >= minY && screenBounds.minY <= maxY
      : (() => {
          const point = getScreenPoint(object, objectsById, matrixCache, sceneMatrix, camera, viewport);
          return Boolean(point && point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY);
        })();
    if (!intersectsSelection) return;

    const parent = object.parentObjectId ? objectsById.get(object.parentObjectId) : undefined;
    if (parent?.isCompositeParent) {
      selectedIds.add(parent.id);
    } else if (object.crowdId) {
      selectedCrowdIds.add(object.crowdId);
    } else {
      selectedIds.add(object.id);
    }
  });

  selectedCrowdIds.forEach((crowdId) => {
    objects.forEach((object) => {
      if (object.crowdId === crowdId) selectedIds.add(object.id);
    });
  });

  return Array.from(selectedIds);
}
