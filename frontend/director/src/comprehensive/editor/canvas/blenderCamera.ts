/**
 * Blender camera bridge.
 *
 * Converts between Blender live session camera state and Director
 * camera shot snapshots, handling perspective and orthographic projections.
 *
 * @module director/canvas/blenderCamera
 */

import { MathUtils, type OrthographicCamera, type PerspectiveCamera } from "three";
import type { BlenderLiveSceneSnapshot } from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { directorCameraTargetFromEuler } from "../interchange/cameraOrientation";
import type { CameraShotSnapshot } from "../store/directorStore";

type BlenderCamera = BlenderLiveSceneSnapshot["cameras"][number];

/** Camera view snapshot extended with Blender-specific projection metadata. */
export interface BlenderCameraViewSnapshot extends CameraShotSnapshot {
  aspectRatio: number;
  projectionType: BlenderCamera["projectionType"];
  focalLengthMm: number;
  sensorFit: BlenderCamera["sensorFit"];
  sensorWidthMm: number;
  sensorHeightMm: number;
  shiftX: number;
  shiftY: number;
  clipStart: number;
  clipEnd: number;
  orthographicScale: number;
}

type BlenderPhysicalViewSnapshot = Omit<BlenderCameraViewSnapshot, "fov">;

/** Perspective or orthographic projection parameters derived from a Blender camera view snapshot. */
export type BlenderCameraProjection =
  | {
      projectionType: "PERSPECTIVE";
      aspectRatio: number;
      far: number;
      fov: number;
      near: number;
      view: {
        enabled: true;
        fullWidth: number;
        fullHeight: number;
        offsetX: number;
        offsetY: number;
        width: number;
        height: number;
      };
    }
  | {
      projectionType: "ORTHOGRAPHIC";
      bottom: number;
      far: number;
      left: number;
      near: number;
      right: number;
      top: number;
    };

function getEffectiveSensorFit(camera: Pick<BlenderCameraViewSnapshot, "sensorFit">, aspectRatio: number) {
  if (camera.sensorFit !== "AUTO") return camera.sensorFit;
  return aspectRatio >= 1 ? "HORIZONTAL" : "VERTICAL";
}

function getPerspectiveVerticalFov(camera: BlenderPhysicalViewSnapshot) {
  const sensorSize = camera.sensorFit === "VERTICAL" ? camera.sensorHeightMm : camera.sensorWidthMm;
  const fittedSensorHeight =
    getEffectiveSensorFit(camera, camera.aspectRatio) === "HORIZONTAL" ? sensorSize / camera.aspectRatio : sensorSize;
  return MathUtils.radToDeg(2 * Math.atan(fittedSensorHeight / (2 * camera.focalLengthMm)));
}

/** Converts a raw Blender camera into a view snapshot with computed vertical FOV. */
export function getBlenderCameraViewSnapshot(
  camera: BlenderCamera,
  aspectRatio = 16 / 9,
): BlenderCameraViewSnapshot {
  const physicalCamera = {
    aspectRatio,
    clipEnd: camera.clipEnd,
    clipStart: camera.clipStart,
    focalLengthMm: camera.focalLengthMm,
    orthographicScale: camera.orthographicScale,
    position: camera.position,
    projectionType: camera.projectionType,
    sensorFit: camera.sensorFit,
    sensorHeightMm: camera.sensorHeightMm,
    sensorWidthMm: camera.sensorWidthMm,
    shiftX: camera.shiftX,
    shiftY: camera.shiftY,
    target: directorCameraTargetFromEuler(camera.position, camera.rotation),
  } satisfies BlenderPhysicalViewSnapshot;
  return {
    ...physicalCamera,
    fov: getPerspectiveVerticalFov(physicalCamera),
  };
}

/** Computes a perspective or orthographic projection from a Blender camera view snapshot at a given render aspect ratio. */
export function getBlenderCameraProjection(
  camera: BlenderCameraViewSnapshot,
  renderAspectRatio: number,
): BlenderCameraProjection {
  const effectiveFit = getEffectiveSensorFit(camera, renderAspectRatio);
  const fittedDimension =
    camera.projectionType === "ORTHOGRAPHIC"
      ? camera.orthographicScale
      : (camera.sensorFit === "VERTICAL" ? camera.sensorHeightMm : camera.sensorWidthMm) / camera.focalLengthMm;
  const outputHeight = effectiveFit === "HORIZONTAL" ? fittedDimension / renderAspectRatio : fittedDimension;
  const renderWidth = outputHeight * renderAspectRatio;
  const centerX = camera.shiftX * fittedDimension;
  const centerY = camera.shiftY * fittedDimension;

  if (camera.projectionType === "ORTHOGRAPHIC") {
    return {
      projectionType: "ORTHOGRAPHIC",
      bottom: centerY - outputHeight / 2,
      far: camera.clipEnd,
      left: centerX - renderWidth / 2,
      near: camera.clipStart,
      right: centerX + renderWidth / 2,
      top: centerY + outputHeight / 2,
    };
  }

  return {
    projectionType: "PERSPECTIVE",
    aspectRatio: renderAspectRatio,
    far: camera.clipEnd,
    fov: MathUtils.radToDeg(2 * Math.atan(outputHeight / 2)),
    near: camera.clipStart,
    view: {
      enabled: true,
      fullWidth: 1,
      fullHeight: 1,
      offsetX: centerX / renderWidth,
      offsetY: -centerY / outputHeight,
      width: 1,
      height: 1,
    },
  };
}

/** Applies the Blender camera projection (near/far/fov or ortho bounds) to a Three.js camera without changing its position. */
export function configureBlenderStageCameraProjection<TCamera extends PerspectiveCamera | OrthographicCamera>(
  camera: TCamera,
  snapshot: BlenderCameraViewSnapshot,
  renderAspectRatio: number,
): TCamera {
  const projection = getBlenderCameraProjection(snapshot, renderAspectRatio);
  camera.near = projection.near;
  camera.far = projection.far;
  if (projection.projectionType === "PERSPECTIVE") {
    const perspectiveCamera = camera as PerspectiveCamera;
    perspectiveCamera.aspect = projection.aspectRatio;
    perspectiveCamera.fov = projection.fov;
    perspectiveCamera.filmOffset = 0;
    perspectiveCamera.view = projection.view;
    perspectiveCamera.zoom = 1;
  } else {
    const orthographicCamera = camera as OrthographicCamera;
    orthographicCamera.bottom = projection.bottom;
    orthographicCamera.left = projection.left;
    orthographicCamera.right = projection.right;
    orthographicCamera.top = projection.top;
    orthographicCamera.view = null;
    orthographicCamera.zoom = 1;
  }
  camera.updateProjectionMatrix();
  return camera;
}

/** Configures a Three.js camera with both the projection and world-space position/rotation from a Blender camera snapshot. */
export function configureBlenderStageCamera<TCamera extends PerspectiveCamera | OrthographicCamera>(
  camera: TCamera,
  snapshot: BlenderCameraViewSnapshot,
  renderAspectRatio: number,
): TCamera {
  configureBlenderStageCameraProjection(camera, snapshot, renderAspectRatio);
  camera.position.set(...snapshot.position);
  camera.lookAt(...snapshot.target);
  camera.updateMatrixWorld();
  return camera;
}
