import { Euler, Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { DirectorObject, SceneSettings } from "../schema/directorProject";

export type { DirectorViewportLayout } from "@director/protocol/workbench-ui";
/** The four panes of the quad viewport layout. */
export type DirectorQuadViewportId = "perspective" | "top" | "front" | "right";

/** A rectangle that defines one pane of the quad viewport layout. */
export interface DirectorQuadViewportRect {
  id: DirectorQuadViewportId;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Returns the render rects for the quad viewport. WebGLRenderer.setViewport
 * and setScissor apply the configured DPR internally, so these rects are in
 * logical pixels.
 *
 * @param width - The canvas width in logical pixels.
 * @param height - The canvas height in logical pixels.
 * @param _pixelRatio - Ignored; present for API compatibility.
 * @param maximizedPaneId - When set, only that pane is rendered (full canvas).
 * @returns The array of render rects, one per pane.
 */
export function getDirectorQuadViewportRenderRects(
  width: number,
  height: number,
  _pixelRatio: number,
  maximizedPaneId: DirectorQuadViewportId | null = null,
): DirectorQuadViewportRect[] {
  // WebGLRenderer.setViewport/setScissor apply the configured DPR internally.
  return getDirectorQuadViewportRects(width, height, maximizedPaneId);
}

/** The framing parameters for the quad view: center, half-size, and bounding radius. */
export interface DirectorQuadViewFraming {
  center: [number, number, number];
  halfSize: [number, number, number];
  radius: number;
}

const MIN_QUAD_VIEW_RADIUS = 2;
const MIN_QUAD_VIEW_ZOOM = 0.5;
const MAX_QUAD_VIEW_ZOOM = 8;

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Returns the four quad-viewport rectangles in logical pixels.
 * When maximized, only a single full-canvas rect is returned.
 * WebGL viewport origins are bottom-left; DOM labels convert rows in CSS.
 *
 * @param width - The canvas width in logical pixels.
 * @param height - The canvas height in logical pixels.
 * @param maximizedPaneId - When set, only that pane is rendered.
 * @returns The array of viewport rects.
 */
export function getDirectorQuadViewportRects(
  width: number,
  height: number,
  maximizedPaneId: DirectorQuadViewportId | null = null,
): DirectorQuadViewportRect[] {
  const safeWidth = Math.max(2, Math.floor(finiteOr(width, 2)));
  const safeHeight = Math.max(2, Math.floor(finiteOr(height, 2)));
  if (maximizedPaneId) {
    const labels: Record<DirectorQuadViewportId, string> = {
      perspective: "透视",
      top: "顶视",
      front: "前视",
      right: "右视",
    };
    return [
      {
        id: maximizedPaneId,
        label: labels[maximizedPaneId],
        x: 0,
        y: 0,
        width: safeWidth,
        height: safeHeight,
      },
    ];
  }
  const leftWidth = Math.floor(safeWidth / 2);
  const rightWidth = safeWidth - leftWidth;
  const bottomHeight = Math.floor(safeHeight / 2);
  const topHeight = safeHeight - bottomHeight;

  // WebGL viewport origins are bottom-left. DOM labels use the same IDs but
  // convert their rows in CSS, so the authored pane order remains explicit.
  return [
    {
      id: "perspective",
      label: "透视",
      x: 0,
      y: bottomHeight,
      width: leftWidth,
      height: topHeight,
    },
    {
      id: "top",
      label: "顶视",
      x: leftWidth,
      y: bottomHeight,
      width: rightWidth,
      height: topHeight,
    },
    {
      id: "front",
      label: "前视",
      x: 0,
      y: 0,
      width: leftWidth,
      height: bottomHeight,
    },
    {
      id: "right",
      label: "右视",
      x: leftWidth,
      y: 0,
      width: rightWidth,
      height: bottomHeight,
    },
  ];
}

function getObjectHalfExtent(object: DirectorObject) {
  const [scaleX, scaleY, scaleZ] = object.transform.scale.map((value) => Math.abs(finiteOr(value, 1)));
  if (object.kind === "character") return new Vector3(Math.max(0.45, scaleX * 0.45), Math.max(1, scaleY), 0.45);
  if (object.geometryType)
    return new Vector3(Math.max(0.05, scaleX / 2), Math.max(0.05, scaleY / 2), Math.max(0.05, scaleZ / 2));
  const uniform = Math.max(0.5, scaleX, scaleY, scaleZ);
  return new Vector3(uniform, uniform, uniform);
}

/**
 * Computes the quad-view framing (center, half-size, radius) from the set of
 * visible objects, accounting for the scene transform. When no objects are
 * visible, a default framing centered above the ground is returned.
 *
 * @param objects - All director objects in the project.
 * @param groundHeight - The ground plane height for default framing.
 * @param sceneTransform - The scene's position, rotation, and scale.
 * @returns The framing parameters.
 */
export function getDirectorQuadViewFraming(
  objects: DirectorObject[],
  groundHeight = 0,
  sceneTransform?: Pick<SceneSettings, "position" | "rotation" | "scale">,
): DirectorQuadViewFraming {
  const visible = objects.filter((object) => object.visible && object.kind !== "camera");
  const framed = visible;
  const scenePosition = new Vector3(...(sceneTransform?.position ?? [0, 0, 0])).multiplyScalar(1);
  const sceneRotation = new Quaternion().setFromEuler(new Euler(...(sceneTransform?.rotation ?? [0, 0, 0])));
  const sceneScale = Math.max(0.0001, Math.abs(finiteOr(sceneTransform?.scale ?? 1, 1)));
  const sceneMatrix = new Matrix4().compose(
    scenePosition,
    sceneRotation,
    new Vector3(sceneScale, sceneScale, sceneScale),
  );

  if (!framed.length) {
    const center = new Vector3(0, finiteOr(groundHeight, 0) + 1, 0).applyMatrix4(sceneMatrix);
    return {
      center: [center.x, center.y, center.z],
      halfSize: [6 * sceneScale, 3 * sceneScale, 6 * sceneScale],
      radius: 6 * sceneScale,
    };
  }

  const min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  const position = new Vector3();
  const corner = new Vector3();
  const objectRotation = new Quaternion();
  for (const object of framed) {
    position.fromArray(object.transform.position);
    const halfExtent = getObjectHalfExtent(object);
    objectRotation.setFromEuler(new Euler(...object.transform.rotation));
    for (const x of [-1, 1]) {
      for (const y of [-1, 1]) {
        for (const z of [-1, 1]) {
          corner
            .set(halfExtent.x * x, halfExtent.y * y, halfExtent.z * z)
            .applyQuaternion(objectRotation)
            .add(position)
            .applyMatrix4(sceneMatrix);
          min.min(corner);
          max.max(corner);
        }
      }
    }
  }

  const center = min.clone().add(max).multiplyScalar(0.5);
  const halfSize = max.clone().sub(min).multiplyScalar(0.5);
  const radius = Math.max(MIN_QUAD_VIEW_RADIUS, halfSize.length() * 1.16);
  return {
    center: [center.x, center.y, center.z],
    halfSize: [halfSize.x, halfSize.y, halfSize.z],
    radius: Number.isFinite(radius) ? radius : 6,
  };
}

/**
 * Configures an orthographic camera for an orthographic quad-view pane (top, front, or right).
 *
 * @param camera - The orthographic camera to configure.
 * @param id - Which orthographic pane to set up.
 * @param framing - The quad-view framing parameters.
 * @param aspect - The viewport aspect ratio (width / height).
 * @param zoom - The zoom level (1 = default).
 * @returns The configured camera.
 */
export function configureDirectorOrthographicCamera(
  camera: OrthographicCamera,
  id: Exclude<DirectorQuadViewportId, "perspective">,
  framing: DirectorQuadViewFraming,
  aspect: number,
  zoom = 1,
) {
  const safeAspect = Math.max(0.01, finiteOr(aspect, 1));
  const radius = Math.max(MIN_QUAD_VIEW_RADIUS, finiteOr(framing.radius, 6));
  const [halfSizeX, halfSizeY, halfSizeZ] = framing.halfSize;
  const projectedHalfWidth = id === "right" ? halfSizeZ : halfSizeX;
  const projectedHalfHeight = id === "top" ? halfSizeZ : halfSizeY;
  const fittedHalfHeight = Math.max(1, projectedHalfHeight, projectedHalfWidth / safeAspect) * 1.1;
  const halfHeight = fittedHalfHeight / clampDirectorQuadViewportZoom(zoom);
  const halfWidth = halfHeight * safeAspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.near = 0.01;
  camera.far = Math.max(1_000, radius * 20);

  const center = new Vector3().fromArray(framing.center);
  const distance = Math.max(12, radius * 4);
  if (id === "top") {
    camera.position.copy(center).add(new Vector3(0, distance, 0.0001));
    camera.up.set(0, 0, -1);
  } else if (id === "front") {
    camera.position.copy(center).add(new Vector3(0, 0, distance));
    camera.up.set(0, 1, 0);
  } else {
    camera.position.copy(center).add(new Vector3(distance, 0, 0));
    camera.up.set(0, 1, 0);
  }
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

/**
 * Configures a perspective camera for the perspective quad-view pane,
 * positioning it so the framed objects fill the viewport.
 *
 * @param camera - The perspective camera to configure.
 * @param framing - The quad-view framing parameters.
 * @param aspect - The viewport aspect ratio (width / height).
 * @param zoom - The zoom level (1 = default).
 * @returns The configured camera.
 */
export function configureDirectorPerspectivePane(
  camera: PerspectiveCamera,
  framing: DirectorQuadViewFraming,
  aspect: number,
  zoom = 1,
) {
  const safeAspect = Math.max(0.01, finiteOr(aspect, 1));
  const radius = Math.max(MIN_QUAD_VIEW_RADIUS, finiteOr(framing.radius, 6));
  const center = new Vector3().fromArray(framing.center);
  const direction = camera.getWorldDirection(new Vector3());
  const verticalHalfFov = Math.max(0.01, (camera.fov * Math.PI) / 360);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * safeAspect);
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  const distance = (radius / Math.max(0.01, Math.sin(limitingHalfFov))) * 1.08;

  camera.aspect = safeAspect;
  camera.zoom = clampDirectorQuadViewportZoom(zoom);
  camera.position.copy(center).addScaledVector(direction, -distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

/**
 * Clamps a zoom value to the valid range [MIN_QUAD_VIEW_ZOOM, MAX_QUAD_VIEW_ZOOM].
 *
 * @param zoom - The raw zoom value.
 * @returns The clamped zoom value.
 */
export function clampDirectorQuadViewportZoom(zoom: number) {
  return Math.min(MAX_QUAD_VIEW_ZOOM, Math.max(MIN_QUAD_VIEW_ZOOM, finiteOr(zoom, 1)));
}

/**
 * Computes the next zoom level from a wheel delta, applying exponential scaling
 * for smooth zoom feel across the full range.
 *
 * @param currentZoom - The current zoom level.
 * @param wheelDeltaY - The raw wheel deltaY value.
 * @returns The new zoom level, clamped to the valid range.
 */
export function getNextDirectorQuadViewportZoom(currentZoom: number, wheelDeltaY: number) {
  const safeDelta = Math.max(-320, Math.min(320, finiteOr(wheelDeltaY, 0)));
  return clampDirectorQuadViewportZoom(currentZoom * Math.exp(-safeDelta * 0.0018));
}
