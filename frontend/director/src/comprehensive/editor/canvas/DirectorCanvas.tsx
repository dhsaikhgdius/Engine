import { GizmoHelper, GizmoViewport, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Lock, MousePointer2, Unlock } from "lucide-react";
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ComponentProps,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  Box3,
  DoubleSide,
  Euler,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera as ThreePerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  RGBAFormat,
  Scene,
  Spherical,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { Camera, Object3D } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useLanguage } from "../../i18n/language";
import {
  requestViewportCapture,
  setViewportCaptureHandler,
  throwIfViewportCaptureAborted,
  type ViewportCaptureHandlerRequest,
} from "../io/captureBridge";
import { buildScreenshotMeta, filterVisibleObjectIdColors, type ScreenshotResult } from "../io/screenshotExport";
import { captureDirectorRenderPass, type DirectorCaptureBackgroundMode } from "../render/renderPassCapture";
import { composeDirectorLineartPass } from "../render/lineartPassCapture";
import { captureDirectorPosePass } from "../render/posePassCapture";
import {
  composeDirectorMotionVectorPass,
  computeDirectorObjectMotionVectors,
  type DirectorMotionCameraPose,
} from "../render/motionVectorPass";
import { computeDirectorDenseMotionFlow } from "../render/denseMotionFlow";
import { DIRECTOR_PREVIZ_PALETTE } from "@director/project-schema";
import {
  captureDirectorCinematicDepthFloat,
  captureDirectorCinematicRenderPass,
} from "../render/cinematicOpticsCapture";
import { captureDirectorDepthFloat } from "../render/depthFloatCapture";
import { collectDirectorCaptureHelpers, suppressDirectorCaptureHelpers } from "../render/captureVisibility";
import { DirectorViewportLook } from "../render/viewportLook";
import {
  applyDirectorPrevizMaterialEntries,
  collectDirectorPrevizMeshes,
  type DirectorPrevizMeshEntry,
} from "../render/previzMaterialScope";
import {
  applyDirectorCameraPreviewModalityScope,
  applyDirectorCameraPreviewSegmentationScope,
  collectDirectorCameraPreviewSegmentationEntries,
  commitDirectorCameraPreviewMotionHistory,
  computeDirectorCameraPreviewSceneBounds,
  DIRECTOR_CAMERA_PREVIEW_MODES,
  getDirectorCameraPreviewDepthRange,
  isDirectorCameraPreviewSegmentationMode,
  resetDirectorCameraPreviewMotionHistory,
  updateDirectorCameraPreviewMotionUniforms,
  type DirectorCameraPreviewMode,
  type DirectorCameraPreviewSegmentationEntry,
} from "../render/cameraPreviewModality";
import {
  publishDirectorSessionCommandResult,
  subscribeDirectorSessionCommands,
  type DirectorSessionCommand,
} from "../../../agent/directorSessionCommandBus";
import { useDirectorStore, type CameraShotSnapshot } from "../store/directorStore";
import { directorCameraShotLanguageReport } from "@director/agent-engine/framing";
import {
  DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
  getDirectorCameraAspectValue,
  getCameraViewSnapshotFromShot,
  getCameraRigPositionFromViewSnapshot,
  getDirectorCameraHandheldShake,
  normalizeDirectorCameraOptics,
} from "../schema/cameraGeometry";
import { calculateDirectorCameraExposure } from "../schema/cameraExposure";
import { findDirectorCameraById } from "../schema/cameraIdentity";
import { withDirectorAnamorphicProjection } from "../schema/cameraProjection";
import type {
  DirectorAssetRef,
  DirectorCameraAspectRatio,
  DirectorCameraShot,
  DirectorLight,
  DirectorObject,
  DirectorProject,
  DirectorStoryboard,
  DirectorTransform,
  SceneSettings,
} from "../schema/directorProject";
import { resolveDirectorPhysicalPlacements } from "../geometry/physicalPlacement";
import { getDirectorObjectFocusTarget, isCameraFocusableObject } from "../schema/cameraTarget";
import {
  evaluateDirectorCameraAtFrame,
  evaluateDirectorObjectAtFrame,
  getDirectorTimelineFrameAtElapsedTime,
} from "../schema/directorAnimation";
import { getGroundedLabelY } from "../runtime/mannequin/bodyTypes";
import { getUE4GroundedLabelY } from "../runtime/ue4Mannequin/ue4MannequinRig";
import { getDirectorObjectFocusSnapshot } from "./viewportObjectFocus";
import { CameraPreviewModeGlyph } from "./cameraPreviewModeGlyph";
import { SceneRoot } from "./SceneRoot";
import { BlenderSceneLayer, type BlenderSceneLayerPhase, type BlenderSceneLayerStatus } from "./BlenderSceneLayer";
import { DirectorClippingPlanes } from "./DirectorClippingPlanes";
import { CameraViewportProperties } from "./CameraViewportProperties";
import { copyPictureInPicturePreviewToFreezeCanvas } from "./cameraPictureInPictureFreeze";
import {
  CAMERA_PIP_WIDTH,
  getCameraPictureInPictureOffset,
  getCameraPictureInPictureRenderTargetSize,
  getCameraPictureInPictureRenderRectFromLayout,
  isCameraPictureInPictureDragging,
  isCameraPictureInPicturePreviewFrozen,
  markCameraPictureInPicturePreviewFrozen,
  resolveCameraPictureInPictureLayout,
  setCameraPictureInPictureOverlayElement,
  subscribeCameraPictureInPictureFrames,
  useViewportChromeDrag,
} from "./viewportChromeDrag";
import {
  DirectorTimelineDock,
  type DirectorTimelineExportResult,
  type DirectorVideoFormat,
} from "../timeline/DirectorTimelineDock";
import { getEffectiveTimelineEndFrame } from "../timeline/frameTimeline";
import { createPlayerMotionRecordingSession, type PlayerMotionRecordingSession } from "../player/playerMotionRecorder";
import { cancelActiveGamePlaytestSession, startGamePlaytestSession } from "../player/gamePlaytestSession";
import { gamePlaytestScriptSchema } from "@director/protocol/game-slice";
import {
  createTimelineRecordingSettings,
  normalizeTimelineRecordingSettings,
  type DirectorTimelineRecordingAction,
  type DirectorTimelineRecordingSettings,
  type DirectorTimelineRecordingStatus,
} from "../timeline/timelineRecording";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { useBlenderRuntimeStore } from "../runtime/blenderRuntimeStore";
import { useStageTimelineAudioRehearsal } from "../audio/useStageTimelineAudioRehearsal";
import { DirectorTimelineEnablePrompt } from "../timeline/DirectorTimelineEnablePrompt";
import { createDefaultDirectorFrameTimeline } from "../timeline/frameTime";
import { getDirectorTimelineFps } from "../timeline/frameRate";
import { runWithTimelineExportRestore } from "../runtime/timelineExportLifecycle";
import { useVideoRecordingStore } from "../video/videoRecordingStore";
import type { LiveDirectorVideoRecorder } from "../video/directorVideoExport";
import type { DirectorMultimodalFrameExportSelection } from "../video/multimodalFrameExport";
import type { DirectorShotRenderPassId } from "../shot/shotPackage";
import { setDirectorPagePlaybackHandler } from "../assistant/pageStateBridge";
import { ViewportBackground } from "./ViewportBackground";
import { DirectorSceneFog, DirectorSceneLighting } from "./DirectorSceneLighting";
import { ViewportToolbar } from "./ViewportToolbar";
import { useViewportChromeSuppressed } from "./viewportChromeSuppression";
import { getLassoObjectScreenBounds, getLassoSelectionIds, type LassoScreenRect } from "./lassoSelection";
import {
  MODEL_LIBRARY_DRAG_MIME,
  readModelLibraryDragData,
  type ModelLibraryDragPayload,
} from "../modelLibrary/modelLibraryDrag";
import { PlayerController } from "../player/PlayerController";
import { LinearCastingHud } from "../player/linearCasting/LinearCastingHud";
import { LinearCastingLayer } from "../player/linearCasting/LinearCastingLayer";
import type { PlayerStaticEnvironment } from "../player/playerStaticEnvironment";
import { PlayerModeHud } from "../player/PlayerModeHud";
import { createPlayerRuntimeStatusStore, type PlayerRuntimeStatusStore } from "../player/playerRuntimeStatusStore";
import {
  hasWalkableMeshPlayerEnvironment,
  PLAYER_CONTROLLER_CONFIG,
  resolvePlayerRoamGroundEnabled,
  type PlayerObstacle,
  type PlayerViewMode,
} from "../player/playerLocomotion";
import type { PlayerInteractionCandidate } from "../player/playerInteractions";
import { getLocomotionState } from "../player/characterFollowRuntime";
import { getBlenderViewportFov } from "./blenderViewportResize";
import { getViewportAspectFrameRect, type ViewportSafeAreaInsets } from "./viewportAspectFrame";
import { getViewportAspectRatioValue } from "@director/protocol/workbench-ui";
import { getStoryboardCameraIdAtFrame } from "../storyboard/directorStoryboard";
import type { DirectorWorkspaceLayout } from "../../app/layout/workspaceLayout";
import { AdaptivePerformanceController } from "../performance/AdaptivePerformanceController";
import { DirectorShadowMapController } from "../performance/DirectorShadowMapController";
import {
  beginDirectorCompositeRendererInfoPass,
  beginDirectorCompositeShadowPass,
  DIRECTOR_CAMERA_PREVIEW_MAX_FPS,
  getDirectorCameraPreviewRenderPlan,
  getDirectorStageFrameloop,
  shouldContinuouslyUpdateDirectorShadows,
} from "../performance/renderBudget";
import { isDirectorWorldAmbientActive, setWorldAmbientClockSuspended } from "../world/worldClock";
import {
  detectPerformanceCapabilities,
  resolveAutomaticPerformanceProfile,
  type EffectivePerformanceProfileId,
  type RenderDpr,
} from "../performance/performanceProfiles";
import {
  resetAutomaticPerformanceProfile,
  useResolvedPerformanceConfig,
  useSelectedPerformanceProfile,
} from "../performance/performanceRuntime";
import { DirectorKeyboardController } from "./DirectorKeyboardController";
import {
  CameraPilotController,
  type CameraPilotRecord,
  type CameraPilotTargetState,
} from "../motion/CameraPilotController";
import { CameraPilotHud } from "../motion/CameraPilotHud";
import { setDirectorPageViewportHandler } from "../assistant/pageStateBridge";
import { QuadViewportChrome, QuadViewportRenderer, type DirectorQuadViewportZooms } from "./QuadViewportRenderer";
import {
  getDirectorQuadViewFraming,
  getNextDirectorQuadViewportZoom,
  type DirectorQuadViewportId,
} from "./quadViewport";
import {
  applyViewportWheelZoomFrame,
  ensureViewportCameraClippingRange,
  enqueueViewportWheelZoom,
  getViewportGridFadeDistance,
  getViewportWheelZoomImpulse,
  VIEWPORT_FAR_CLIP_DISTANCE,
  VIEWPORT_GRID_CELL_SIZE,
  VIEWPORT_GRID_CELL_THICKNESS,
  VIEWPORT_GRID_FADE_STRENGTH,
  VIEWPORT_GRID_SECTION_SIZE,
  VIEWPORT_GRID_SECTION_THICKNESS,
  VIEWPORT_MAX_ORBIT_DISTANCE,
  VIEWPORT_MIN_ORBIT_DISTANCE,
} from "./viewportWheelZoom";
import { ViewportGroundGrid } from "./ViewportGroundGrid";
import { getViewportNavigationMouseButtons, hasViewportMovementKey } from "./viewportNavigation";

export { getViewportWheelZoomImpulse, normalizeViewportWheelDelta } from "./viewportWheelZoom";

export const DEFAULT_DIRECTOR_VIEW_SNAPSHOT: CameraShotSnapshot = DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT;
const EMPTY_DIRECTOR_LIGHTS: DirectorLight[] = [];
const VIEWPORT_FRAME_PADDING = 40;
const VIEWPORT_TOOLBAR_BOTTOM_OFFSET = 40;
const DEFAULT_VIEWPORT_TOOLBAR_HEIGHT = 44;
const ANIMATION_TRANSPORT_GAP = 10;
const GIZMO_AXIS_COLORS: [string, string, string] = ["#FF5A4F", "#34C759", "#0A84FF"];
const GIZMO_VIEWPORT_SCALE = 28;
const GIZMO_HIT_LAYER_SIZE = 80;
const GIZMO_HIT_LAYER_CENTER = GIZMO_HIT_LAYER_SIZE / 2;
const GIZMO_AXIS_SCREEN_RADIUS = 25;
const GIZMO_AXIS_HIT_SIZE = 15;
const GIZMO_EDGE_PADDING = 20;
const GIZMO_DRAG_THRESHOLD_PX = 4;
const GIZMO_POLAR_LIMIT = 0.05;
const DEFAULT_VIEWPORT_ROTATE_SENSITIVITY = 0.35;
const GIZMO_AXIS_TARGETS = [
  { direction: [1, 0, 0] as const, label: "切换到 X 正向视图" },
  { direction: [-1, 0, 0] as const, label: "切换到 X 负向视图" },
  { direction: [0, 1, 0] as const, label: "切换到 Y 正向视图" },
  { direction: [0, -1, 0] as const, label: "切换到 Y 负向视图" },
  { direction: [0, 0, 1] as const, label: "切换到 Z 正向视图" },
  { direction: [0, 0, -1] as const, label: "切换到 Z 负向视图" },
] as const;
const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const CAPTURE_LABEL_FONT_SIZE = 12;
const CAPTURE_LABEL_HORIZONTAL_PADDING = 10;
const CAPTURE_LABEL_VERTICAL_PADDING = 6;
const CAPTURE_LABEL_BORDER_RADIUS = 999;
const CAPTURE_LABEL_PANEL_RGB_FALLBACK = "26 26 26";
const CAPTURE_LABEL_TEXT_RGB_FALLBACK = "255 255 255";
const VIEWPORT_GRID_ELEVATION = 0.002;
const DROP_SURFACE_MIN_UP_DOT = 0.35;
const DIRECTOR_CANVAS_GL_OPTIONS = {
  antialias: true,
  powerPreference: "high-performance",
  reversedDepthBuffer: true,
  // Every screenshot path performs an explicit synchronous render before
  // reading pixels. Retaining the default framebuffer between frames only
  // forces a slower compositor path during normal Stage interaction.
  preserveDrawingBuffer: false,
} as const;

export type ModelLibraryDropPlacement = {
  position: [number, number, number];
  source: "surface" | "ground" | "fallback";
};

export type PlayerRecordingGait = "idle" | "walk" | "run";

export type PlayerRecordingSample = {
  frame: number;
  transform: DirectorTransform;
  /** Inferred when the sample is captured. Optional for recordings created before gait sampling existed. */
  gait?: PlayerRecordingGait;
};

const PLAYER_RECORDING_RUN_DISTANCE_SHARE = 0.35;
const PLAYER_RECORDING_MIN_PLANAR_DISTANCE = 0.0001;

function getPlayerRecordingSegment(
  previous: PlayerRecordingSample | undefined,
  current: PlayerRecordingSample,
  fps: number,
) {
  if (!previous) return { distance: 0, gait: "idle" as const };
  const frameDelta = current.frame - previous.frame;
  if (!Number.isFinite(frameDelta) || frameDelta <= 0) return { distance: 0, gait: "idle" as const };

  const deltaX = current.transform.position[0] - previous.transform.position[0];
  const deltaZ = current.transform.position[2] - previous.transform.position[2];
  const distance = Math.hypot(deltaX, deltaZ);
  if (!Number.isFinite(distance) || distance < PLAYER_RECORDING_MIN_PLANAR_DISTANCE) {
    return { distance: 0, gait: "idle" as const };
  }

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 24;
  const scaleY = Math.max(0.01, Math.abs(current.transform.scale[1]));
  const characterHeight = PLAYER_CONTROLLER_CONFIG.playerHeight * scaleY;
  const locomotion = getLocomotionState((distance * safeFps) / frameDelta, characterHeight);
  return {
    distance,
    gait:
      locomotion === "runForward"
        ? ("run" as const)
        : locomotion === "walkForward"
          ? ("walk" as const)
          : ("idle" as const),
  };
}

/** Select a single playback gait from the recorded path without losing Shift-run recordings. */
export function inferPlayerRecordingGait(samples: readonly PlayerRecordingSample[], fps: number): "walk" | "run" {
  let travelledDistance = 0;
  let runDistance = 0;

  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index]!;
    const segment = getPlayerRecordingSegment(samples[index - 1], current, fps);
    if (segment.distance <= 0) continue;
    travelledDistance += segment.distance;
    if ((current.gait ?? segment.gait) === "run") runDistance += segment.distance;
  }

  if (travelledDistance <= PLAYER_RECORDING_MIN_PLANAR_DISTANCE) return "walk";
  return runDistance / travelledDistance >= PLAYER_RECORDING_RUN_DISTANCE_SHARE ? "run" : "walk";
}

function getCameraActionTargetsAtFrame(
  camera: DirectorCameraShot,
  objects: DirectorObject[],
  frame: number,
  fps: number,
) {
  const targetIds = new Set<string>();
  const actionTargetId =
    camera.action?.mode === "follow"
      ? camera.action.follow?.targetObjectId
      : camera.action?.mode === "path" && camera.action.path?.lockTarget
        ? camera.action.path.targetObjectId
        : null;
  if (actionTargetId) targetIds.add(actionTargetId);
  camera.animation?.keyframes.forEach((keyframe) => {
    if (keyframe.lookTargetObjectId) targetIds.add(keyframe.lookTargetObjectId);
  });

  return [...targetIds].flatMap((targetId) => {
    const targetObject = objects.find((item) => item.id === targetId && isCameraFocusableObject(item));
    if (!targetObject) return [];
    const evaluatedTarget = evaluateDirectorObjectAtFrame(targetObject, frame, fps);
    return [{ id: evaluatedTarget.id, position: getDirectorObjectFocusTarget(evaluatedTarget) }];
  });
}
type ViewportCaptureLabel = {
  text: string;
  worldPosition: Vector3;
};
type ViewportCaptureFrameRect = NonNullable<ReturnType<typeof getViewportAspectFrameRect>>;

export function getDirectorStageVideoRenderSize(aspectRatio: DirectorCameraAspectRatio = "16:9") {
  const aspect = getDirectorCameraAspectValue(aspectRatio);
  const maximumWidth = aspect >= 1 ? 1920 : 1080;
  const maximumHeight = aspect >= 1 ? 1080 : 1920;
  const height = Math.min(maximumHeight, maximumWidth / aspect);
  const width = height * aspect;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width), height: even(height) };
}

export function createDirectorVideoFrameCaptureRequest(
  cameraId: string,
  frame: number,
  aspectRatio: DirectorCameraAspectRatio = "16:9",
) {
  const normalizedCameraId = cameraId.trim();
  if (!normalizedCameraId) throw new Error("记录渲染视频需要一个有效的活动机位");
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error("记录渲染视频需要非负整数帧");
  }
  const raster = getDirectorStageVideoRenderSize(aspectRatio);
  return {
    preset: "current" as const,
    source: "capture-panel" as const,
    cameraId: normalizedCameraId,
    cleanPlate: true,
    frame,
    ...raster,
  };
}

function waitForAnimationFrame(signal: AbortSignal) {
  throwIfViewportCaptureAborted(signal);

  return new Promise<void>((resolve, reject) => {
    let frameId: number | null = null;
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () =>
      finish(() => {
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        try {
          throwIfViewportCaptureAborted(signal);
        } catch (error) {
          reject(error);
        }
      });

    signal.addEventListener("abort", onAbort, { once: true });
    frameId = window.requestAnimationFrame(() =>
      finish(() => {
        try {
          throwIfViewportCaptureAborted(signal);
          resolve();
        } catch (error) {
          reject(error);
        }
      }),
    );
    if (signal.aborted) onAbort();
  });
}

async function waitForViewportRender(signal: AbortSignal) {
  // The first frame lets React/R3F commit the requested timeline state.  The
  // second keeps the explicit screenshot render behind that committed frame.
  await waitForAnimationFrame(signal);
  throwIfViewportCaptureAborted(signal);
  await waitForAnimationFrame(signal);
  throwIfViewportCaptureAborted(signal);
}

export function shouldRenderViewportGrid(hasPanorama: boolean, snapToGrid: boolean) {
  return true;
}

export function getViewportSnapshotFromGizmoDirection(
  snapshot: CameraShotSnapshot,
  direction: Vector3,
): CameraShotSnapshot {
  const target = new Vector3(...snapshot.target);
  const currentPosition = new Vector3(...snapshot.position);
  const radius = Math.max(currentPosition.distanceTo(target), 0.000001);
  const nextDirection = direction.lengthSq() === 0 ? new Vector3(0, 0, 1) : direction.clone().normalize();
  const nextPosition = target.clone().add(nextDirection.multiplyScalar(radius));

  return {
    fov: snapshot.fov,
    position: toSnapshotTuple(nextPosition),
    target: snapshot.target,
  };
}

export function getViewportSnapshotFromGizmoDrag(
  snapshot: CameraShotSnapshot,
  deltaX: number,
  deltaY: number,
  rotateSensitivity = DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
): CameraShotSnapshot {
  const target = new Vector3(...snapshot.target);
  const offset = new Vector3(...snapshot.position).sub(target);
  if (offset.lengthSq() === 0) offset.set(0, 0, 1);

  const spherical = new Spherical().setFromVector3(offset);
  const sensitivityScale = Math.max(0.05, rotateSensitivity) / DEFAULT_VIEWPORT_ROTATE_SENSITIVITY;
  const radiansPerPixel = (Math.PI / GIZMO_HIT_LAYER_SIZE) * sensitivityScale;
  spherical.theta -= deltaX * radiansPerPixel;
  spherical.phi = Math.max(
    GIZMO_POLAR_LIMIT,
    Math.min(Math.PI - GIZMO_POLAR_LIMIT, spherical.phi + deltaY * radiansPerPixel),
  );

  const nextPosition = target.clone().add(new Vector3().setFromSpherical(spherical));
  return {
    fov: snapshot.fov,
    position: toSnapshotTuple(nextPosition),
    target: snapshot.target,
  };
}

export function getViewportGizmoHitButtonStyle(
  snapshot: CameraShotSnapshot,
  direction: readonly [number, number, number],
): CSSProperties {
  const relativeCamera = new Vector3(...snapshot.position).sub(new Vector3(...snapshot.target));
  const camera = new ThreePerspectiveCamera(snapshot.fov, 1);
  const safeCameraPosition = relativeCamera.lengthSq() === 0 ? new Vector3(0, 0, 1) : relativeCamera;
  camera.position.copy(safeCameraPosition);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const gizmoQuaternion = new Quaternion().setFromRotationMatrix(new Matrix4().copy(camera.matrix).invert());
  const projectedDirection = new Vector3(...direction).applyQuaternion(gizmoQuaternion);
  const left = GIZMO_HIT_LAYER_CENTER + projectedDirection.x * GIZMO_AXIS_SCREEN_RADIUS - GIZMO_AXIS_HIT_SIZE / 2;
  const top = GIZMO_HIT_LAYER_CENTER - projectedDirection.y * GIZMO_AXIS_SCREEN_RADIUS - GIZMO_AXIS_HIT_SIZE / 2;

  return {
    left: `${Number(left.toFixed(3))}px`,
    top: `${Number(top.toFixed(3))}px`,
    zIndex: Math.round((projectedDirection.z + 1) * 100),
  };
}

function toSnapshotTuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(6))) as [number, number, number];
}

function areCameraSnapshotsClose(a: CameraShotSnapshot, b: CameraShotSnapshot) {
  const tupleClose = (left: [number, number, number], right: [number, number, number]) =>
    left.every((value, index) => Math.abs(value - right[index]) < 0.00001);

  return Math.abs(a.fov - b.fov) < 0.00001 && tupleClose(a.position, b.position) && tupleClose(a.target, b.target);
}

function applySnapshotToCamera(camera: ThreePerspectiveCamera, snapshot: CameraShotSnapshot) {
  camera.fov = snapshot.fov;
  camera.position.set(...snapshot.position);
  camera.lookAt(...snapshot.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function isThreePerspectiveCamera(camera: Camera): camera is ThreePerspectiveCamera {
  return (camera as ThreePerspectiveCamera).isPerspectiveCamera === true;
}

export function getSceneCameraViewSnapshot(shot: DirectorCameraShot, scene: SceneSettings): CameraShotSnapshot {
  const snapshot = getCameraViewSnapshotFromShot(shot);
  const sceneMatrix = createSceneMatrix(scene);
  return {
    ...snapshot,
    position: toSnapshotTuple(new Vector3(...snapshot.position).applyMatrix4(sceneMatrix)),
    target: toSnapshotTuple(new Vector3(...snapshot.target).applyMatrix4(sceneMatrix)),
  };
}

export function getInitialDirectorViewSnapshot(project: DirectorProject): CameraShotSnapshot {
  const characterIds = project.objects
    .filter((object) => object.kind === "character" && object.visible)
    .map((object) => object.id);
  if (!characterIds.length) return DEFAULT_DIRECTOR_VIEW_SNAPSHOT;

  return (
    getDirectorObjectFocusSnapshot({ ...project, activeCameraId: null, cameras: [] }, characterIds) ??
    DEFAULT_DIRECTOR_VIEW_SNAPSHOT
  );
}

function applyCameraShotToCamera(camera: ThreePerspectiveCamera, shot: DirectorCameraShot, elapsedSeconds: number) {
  const snapshot = getSceneCameraViewSnapshot(shot, useDirectorStore.getState().project.scene);
  const optics = normalizeDirectorCameraOptics(shot);
  applySnapshotToCamera(camera, snapshot);
  camera.near = optics.nearClipM;
  camera.far = optics.farClipM;
  camera.updateProjectionMatrix();

  const shake = getDirectorCameraHandheldShake(shot.handheldShake, elapsedSeconds);
  if (!shot.handheldShake || shot.handheldShake === "off") return;

  camera.position.add(new Vector3(...shake.position));
  camera.lookAt(
    snapshot.target[0] + shake.target[0],
    snapshot.target[1] + shake.target[1],
    snapshot.target[2] + shake.target[2],
  );
  camera.updateMatrixWorld();
}

function applySnapshotToRelativeGizmoCamera(camera: ThreePerspectiveCamera, snapshot: CameraShotSnapshot) {
  const position = new Vector3(...snapshot.position);
  const target = new Vector3(...snapshot.target);
  const offset = position.sub(target);

  if (offset.lengthSq() === 0) {
    offset.set(0, 0, 1);
  }

  camera.fov = snapshot.fov;
  camera.position.copy(offset);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function createTransformMatrix(transform: DirectorTransform) {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation)),
    new Vector3(...transform.scale),
  );
}

function createSceneMatrix(scene: SceneSettings) {
  return new Matrix4().compose(
    new Vector3(...scene.position),
    new Quaternion().setFromEuler(new Euler(...scene.rotation)),
    new Vector3(scene.scale, scene.scale, scene.scale),
  );
}

function isDropSurface(object: Object3D) {
  const candidate = object as Object3D & { isMesh?: boolean };
  if (!candidate.isMesh || !candidate.visible) return false;
  if (candidate.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY] || candidate.userData?.directorDropPreview) return false;
  if (
    /transformcontrols|director-(?:viewport-ground-grid|player-ground)|panorama-backdrop-dome|camera-frustum/i.test(
      candidate.name,
    )
  )
    return false;
  let parent = candidate.parent;
  while (parent) {
    if (!parent.visible || parent.userData?.directorDropPreview || parent.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY])
      return false;
    parent = parent.parent;
  }
  return true;
}

function collectDropSurfaces(root: Object3D | null | undefined) {
  if (!root) return [];
  const surfaces: Object3D[] = [];
  root.traverse((object) => {
    if (isDropSurface(object)) surfaces.push(object);
  });
  return surfaces;
}

function snapDropPosition(position: [number, number, number], snapToGrid: boolean): [number, number, number] {
  const normalize = (value: number) => {
    const stable = Math.abs(value) < 1e-9 ? 0 : value;
    return Number(stable.toFixed(6));
  };
  if (!snapToGrid) return [normalize(position[0]), normalize(position[1]), normalize(position[2])];
  return [Math.round(position[0]), normalize(position[1]), Math.round(position[2])];
}

export function getModelLibraryDropPlacement({
  bounds,
  camera,
  clientX,
  clientY,
  dropSurfaces,
  fallbackWorldTarget,
  scene,
  sceneRoot,
}: {
  bounds: Pick<DOMRect, "height" | "left" | "top" | "width">;
  camera?: Camera | null;
  clientX: number;
  clientY: number;
  dropSurfaces?: Object3D[];
  fallbackWorldTarget?: Vector3 | null;
  scene: SceneSettings;
  sceneRoot?: Object3D | null;
}): ModelLibraryDropPlacement {
  const sceneMatrix = createSceneMatrix(scene);
  const worldToScene = sceneMatrix.clone().invert();
  const toScenePosition = (worldPoint: Vector3): [number, number, number] => {
    const scenePoint = worldPoint.clone().applyMatrix4(worldToScene);
    if (![scenePoint.x, scenePoint.y, scenePoint.z].every(Number.isFinite)) {
      return [0, scene.groundHeight, 0];
    }
    return [scenePoint.x, scenePoint.y, scenePoint.z];
  };
  const fallbackPoint = fallbackWorldTarget ?? new Vector3(0, scene.groundHeight, 0).applyMatrix4(sceneMatrix);

  if (!camera || bounds.width <= 0 || bounds.height <= 0) {
    return {
      position: snapDropPosition(toScenePosition(fallbackPoint), scene.snapToGrid),
      source: "fallback",
    };
  }

  const pointer = new Vector2(
    Math.min(1, Math.max(-1, ((clientX - bounds.left) / bounds.width) * 2 - 1)),
    Math.min(1, Math.max(-1, -((clientY - bounds.top) / bounds.height) * 2 + 1)),
  );
  const groundPlane = new Plane(new Vector3(0, 1, 0), -scene.groundHeight).applyMatrix4(sceneMatrix);
  const raycaster = new Raycaster();
  const worldPoint = new Vector3();

  raycaster.setFromCamera(pointer, camera);
  const sceneUp = new Vector3(0, 1, 0).transformDirection(sceneMatrix);
  const surfaces = dropSurfaces ?? collectDropSurfaces(sceneRoot);
  const surfaceHit = raycaster.intersectObjects(surfaces, false).find((hit) => {
    if (!hit.face) return false;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return normal.dot(sceneUp) >= DROP_SURFACE_MIN_UP_DOT;
  });
  if (surfaceHit) {
    return {
      position: snapDropPosition(toScenePosition(surfaceHit.point), scene.snapToGrid),
      source: "surface",
    };
  }

  if (!raycaster.ray.intersectPlane(groundPlane, worldPoint)) {
    worldPoint.copy(fallbackPoint);
    return {
      position: snapDropPosition(toScenePosition(worldPoint), scene.snapToGrid),
      source: "fallback",
    };
  }

  return {
    position: snapDropPosition(toScenePosition(worldPoint), scene.snapToGrid),
    source: "ground",
  };
}

export function getModelLibraryDropPosition(
  input: Parameters<typeof getModelLibraryDropPlacement>[0],
): [number, number, number] {
  return getModelLibraryDropPlacement(input).position;
}

/**
 * Freeze character exploration at the transform and pose visible on the
 * current timeline frame. SceneRoot stops evaluating the controlled actor as
 * soon as exploration starts, so passing the raw authored object here would
 * otherwise snap an animated character back to its base transform.
 */
export function getPlayerActorAtFrame(
  candidates: readonly DirectorObject[],
  playerActorId: string | null,
  currentFrame: number,
  fps: number,
) {
  if (!playerActorId) return null;
  const actor = candidates.find((item) => item.id === playerActorId);
  return actor ? evaluateDirectorObjectAtFrame(actor, currentFrame, fps) : null;
}

/** Builds the solid runtime proxy shared by character and follow-camera collision. */
export function createDirectorPlayerObstacle(item: DirectorObject, asset?: DirectorAssetRef): PlayerObstacle {
  const scaleX = Math.abs(item.transform.scale[0]);
  const scaleY = Math.abs(item.transform.scale[1]);
  const scaleZ = Math.abs(item.transform.scale[2]);
  const maxPlanarScale = Math.max(scaleX, scaleZ);
  // Every imported non-character model is a real collider. Characters retain
  // a capsule proxy so animated limbs do not snag on their own triangles.
  if (item.kind !== "character" && asset?.sourceType === "model") {
    return {
      id: item.id,
      meshRevision: `${asset.id}:${asset.url}`,
      position: item.transform.position,
      radius: 0,
      rotation: item.transform.rotation,
      scale: item.transform.scale,
      shape: "mesh",
    };
  }
  const authoredHeight =
    item.kind === "character"
      ? (asset?.characterMetadata?.heightM ?? PLAYER_CONTROLLER_CONFIG.playerHeight) * scaleY
      : Math.max(0.05, scaleY);
  const halfHeight = Math.max(0.025, authoredHeight * 0.5);
  const primitiveRadius =
    item.geometryType === "sphere"
      ? 0.55
      : item.geometryType === "cylinder"
        ? 0.45
        : item.geometryType === "torus"
          ? 0.59
          : item.geometryType === "cone"
            ? 0.5
            : item.geometryType === "pyramid"
              ? 0.55
              : item.kind === "character"
                ? 0.42
                : item.assetRefId
                  ? 1
                  : 0.5;

  if (item.geometryType === "box") {
    const halfWidth = Math.max(0.02, scaleX * 0.5);
    const halfDepth = Math.max(0.02, scaleZ * 0.5);
    return {
      id: item.id,
      position: item.transform.position,
      radius: Math.hypot(halfWidth, halfDepth),
      shape: "box",
      halfExtents: [halfWidth, halfDepth],
      halfHeight,
      rotation: item.transform.rotation,
      yaw: item.transform.rotation[1],
      walkableSurface: item.kind !== "character",
    };
  }

  return {
    id: item.id,
    position: item.transform.position,
    radius: primitiveRadius * maxPlanarScale,
    halfHeight,
    rotation: item.transform.rotation,
    shape: "circle",
    walkableSurface: item.kind !== "character",
  };
}

function getCharacterCaptureLabelY(item: DirectorObject) {
  return item.characterRig?.rigType === "ue4-mannequin"
    ? getUE4GroundedLabelY(item.bodyType)
    : getGroundedLabelY(item.bodyType);
}

function getViewportCaptureLabels(currentFrame: number) {
  const {
    project: { objects, scene },
  } = useDirectorStore.getState();

  if (!scene.showLabels) return [];

  const sceneMatrix = createSceneMatrix(scene);
  const frameObjects = resolveDirectorPhysicalPlacements(
    objects.map((item) => evaluateDirectorObjectAtFrame(item, currentFrame, getDirectorTimelineFps(scene.timeline))),
    scene.groundHeight,
    scene.showGround,
  );

  return frameObjects
    .filter((item) => item.kind === "character" && item.visible)
    .map((item): ViewportCaptureLabel => {
      const objectMatrix = createTransformMatrix(item.transform);
      const worldPosition = new Vector3(0, getCharacterCaptureLabelY(item), 0)
        .applyMatrix4(objectMatrix)
        .applyMatrix4(sceneMatrix);

      return {
        text: item.name,
        worldPosition,
      };
    });
}

function getCssRgbVariable(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function rgbTripletToRgba(rgbTriplet: string, alpha: number) {
  const [red = "0", green = "0", blue = "0"] = rgbTriplet.split(/\s+/);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function drawViewportCaptureLabels({
  camera,
  context,
  frameRect,
  heightScale,
  labels,
  viewportHeight,
  viewportWidth,
  widthScale,
}: {
  camera: Camera;
  context: CanvasRenderingContext2D;
  frameRect: ViewportCaptureFrameRect;
  heightScale: number;
  labels: ViewportCaptureLabel[];
  viewportHeight: number;
  viewportWidth: number;
  widthScale: number;
}) {
  const drawingContext = context as CanvasRenderingContext2D & {
    fillText?: CanvasRenderingContext2D["fillText"];
    measureText?: CanvasRenderingContext2D["measureText"];
  };

  if (labels.length === 0 || !drawingContext.fillText || !drawingContext.measureText) return;

  const pixelScale = Math.max((widthScale + heightScale) / 2, 0.0001);
  const fontSize = CAPTURE_LABEL_FONT_SIZE * pixelScale;
  const horizontalPadding = CAPTURE_LABEL_HORIZONTAL_PADDING * pixelScale;
  const verticalPadding = CAPTURE_LABEL_VERTICAL_PADDING * pixelScale;
  const labelHeight = fontSize + verticalPadding * 2;
  const panelRgb = getCssRgbVariable("--panel-rgb", CAPTURE_LABEL_PANEL_RGB_FALLBACK);
  const textRgb = getCssRgbVariable("--text-rgb", CAPTURE_LABEL_TEXT_RGB_FALLBACK);

  context.font = `${fontSize}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  labels.forEach((label) => {
    const projected = label.worldPosition.clone().project(camera);
    if (projected.z < -1 || projected.z > 1) return;

    const viewportX = (projected.x * 0.5 + 0.5) * viewportWidth;
    const viewportY = (-projected.y * 0.5 + 0.5) * viewportHeight;
    const x = (viewportX - frameRect.left) * widthScale;
    const y = (viewportY - frameRect.top) * heightScale;
    const textWidth = context.measureText(label.text).width;
    const labelWidth = textWidth + horizontalPadding * 2;
    const captureWidth = frameRect.width * widthScale;
    const captureHeight = frameRect.height * heightScale;
    const rawLabelX = x - labelWidth / 2;
    const rawLabelY = y - labelHeight / 2;
    if (rawLabelX > captureWidth || rawLabelY > captureHeight) return;
    if (rawLabelX + labelWidth < 0 || rawLabelY + labelHeight < 0) return;
    const textX = Math.min(Math.max(x, labelWidth / 2), Math.max(captureWidth - labelWidth / 2, labelWidth / 2));
    const textY = Math.min(Math.max(y, labelHeight / 2), Math.max(captureHeight - labelHeight / 2, labelHeight / 2));
    const labelX = textX - labelWidth / 2;
    const labelY = textY - labelHeight / 2;

    context.fillStyle = rgbTripletToRgba(panelRgb, 0.92);
    drawRoundedRect(context, labelX, labelY, labelWidth, labelHeight, CAPTURE_LABEL_BORDER_RADIUS * pixelScale);
    context.fill();
    context.fillStyle = rgbTripletToRgba(textRgb, 1);
    context.fillText(label.text, textX, textY);
  });
}

function captureViewportCanvas(
  canvas: HTMLCanvasElement,
  aspectRatio: ReturnType<typeof useDirectorStore.getState>["viewportAspectRatio"],
  bottomPadding: number,
  safeAreaInsets: ViewportSafeAreaInsets | undefined,
  signal: AbortSignal,
  captureLabels?: {
    camera: Camera;
    labels: ViewportCaptureLabel[];
  },
) {
  throwIfViewportCaptureAborted(signal);
  const viewportWidth = canvas.clientWidth || canvas.width;
  const viewportHeight = canvas.clientHeight || canvas.height;
  const frameRect = getViewportAspectFrameRect(
    aspectRatio,
    viewportWidth,
    viewportHeight,
    bottomPadding,
    safeAreaInsets,
  );
  const labels = captureLabels?.labels ?? [];

  if (!frameRect && labels.length === 0) {
    throwIfViewportCaptureAborted(signal);
    return canvas.toDataURL("image/png");
  }

  const exportFrameRect = frameRect ?? {
    left: 0,
    top: 0,
    width: viewportWidth,
    height: viewportHeight,
  };
  const widthScale = canvas.width / Math.max(viewportWidth, 1);
  const heightScale = canvas.height / Math.max(viewportHeight, 1);
  const sourceX = Math.round(exportFrameRect.left * widthScale);
  const sourceY = Math.round(exportFrameRect.top * heightScale);
  const sourceWidth = Math.max(Math.round(exportFrameRect.width * widthScale), 1);
  const sourceHeight = Math.max(Math.round(exportFrameRect.height * heightScale), 1);
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = sourceWidth;
  cropCanvas.height = sourceHeight;
  let context: CanvasRenderingContext2D | null = null;

  try {
    context = cropCanvas.getContext("2d");
  } catch {
    throwIfViewportCaptureAborted(signal);
    return canvas.toDataURL("image/png");
  }

  if (!context) {
    throwIfViewportCaptureAborted(signal);
    return canvas.toDataURL("image/png");
  }

  context.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  if (captureLabels) {
    drawViewportCaptureLabels({
      camera: captureLabels.camera,
      context,
      frameRect: exportFrameRect,
      heightScale,
      labels,
      viewportHeight,
      viewportWidth,
      widthScale,
    });
  }
  throwIfViewportCaptureAborted(signal);
  return cropCanvas.toDataURL("image/png");
}

export function encodeDirectorRgbaPng(rgba: Uint8Array, width: number, height: number, signal?: AbortSignal) {
  if (signal) throwIfViewportCaptureAborted(signal);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("PNG raster dimensions must be positive integers.");
  }
  if (rgba.byteLength !== width * height * 4) {
    throw new Error(`PNG RGBA byte length ${rgba.byteLength} does not match ${width}x${height}.`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Browser cannot encode the captured RGBA render pass as PNG.");
  const image = context.createImageData(width, height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  if (signal) throwIfViewportCaptureAborted(signal);
  return canvas.toDataURL("image/png");
}

function withViewportCaptureHelpersHidden(scene: Object3D, render: () => void) {
  const hiddenObjects: Array<{ object: Object3D; visible: boolean }> = [];

  scene.traverse((object) => {
    if (object.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY]) {
      hiddenObjects.push({ object, visible: object.visible });
      object.visible = false;
    }
  });

  try {
    render();
  } finally {
    hiddenObjects.forEach(({ object, visible }) => {
      object.visible = visible;
    });
  }
}

function CanvasCaptureBridge({
  activeCamera,
  bottomPadding,
  controlsRef,
  currentFrameRef,
  enabled,
  prepareCaptureFrame,
  safeAreaInsets,
  viewportAspectRatio,
  viewMode,
}: {
  activeCamera: DirectorCameraShot | undefined;
  bottomPadding: number;
  controlsRef: MutableRefObject<OrbitControlsImpl | null>;
  currentFrameRef: MutableRefObject<number>;
  enabled: boolean;
  prepareCaptureFrame: (frame: number) => number;
  safeAreaInsets: ViewportSafeAreaInsets;
  viewportAspectRatio: ReturnType<typeof useDirectorStore.getState>["viewportAspectRatio"];
  viewMode: "director" | "camera";
}) {
  const { camera, gl, invalidate, scene } = useThree();
  const directorCaptureCamera = useMemo(() => new ThreePerspectiveCamera(), []);

  const capture = useCallback(
    async ({
      background,
      cameraId,
      cleanPlate,
      depthFloat,
      depthOfField,
      frame,
      height,
      includeRenderPixels,
      motionFlowFloat,
      preset,
      renderPass,
      revisionRequested,
      signal,
      source,
      width,
    }: ViewportCaptureHandlerRequest): Promise<ScreenshotResult[]> => {
      throwIfViewportCaptureAborted(signal);
      if ((width === undefined) !== (height === undefined)) {
        throw new Error("Viewport capture width and height must be supplied together.");
      }
      const currentFrame = frame === undefined ? currentFrameRef.current : prepareCaptureFrame(frame);
      throwIfViewportCaptureAborted(signal);
      if (frame !== undefined) {
        invalidate();
        await waitForViewportRender(signal);
        throwIfViewportCaptureAborted(signal);
      }
      const captureProject = useDirectorStore.getState().project;
      const requestedCameraSource = cameraId ? findDirectorCameraById(captureProject, cameraId) : undefined;
      if (cameraId && !requestedCameraSource) {
        throw new Error(`Camera not found: ${cameraId}`);
      }
      const captureFps = getDirectorTimelineFps(captureProject.scene.timeline);
      const requestedCamera = requestedCameraSource
        ? evaluateDirectorCameraAtFrame(
            requestedCameraSource,
            currentFrame,
            getCameraActionTargetsAtFrame(requestedCameraSource, captureProject.objects, currentFrame, captureFps),
          )
        : undefined;
      const evaluatedActiveCamera = activeCamera
        ? evaluateDirectorCameraAtFrame(
            activeCamera,
            currentFrame,
            getCameraActionTargetsAtFrame(activeCamera, captureProject.objects, currentFrame, captureFps),
          )
        : undefined;
      const captureCamera = requestedCamera ?? (viewMode === "camera" ? evaluatedActiveCamera : undefined);
      const viewportCamera = camera as ThreePerspectiveCamera | OrthographicCamera;
      const workingCamera =
        captureCamera && !isThreePerspectiveCamera(viewportCamera) ? directorCaptureCamera : viewportCamera;
      const target = new Vector3(0, 1.2, 0);
      if (captureCamera) {
        target.fromArray(getSceneCameraViewSnapshot(captureCamera, captureProject.scene).target);
      } else if (controlsRef.current?.target) {
        target.copy(controlsRef.current.target);
      }

      const originalPosition = workingCamera.position.clone();
      const originalQuaternion = workingCamera.quaternion.clone();
      const originalFov = isThreePerspectiveCamera(workingCamera) ? workingCamera.fov : null;
      const originalAspect = isThreePerspectiveCamera(workingCamera) ? workingCamera.aspect : null;
      const originalNear = workingCamera.near;
      const originalFar = workingCamera.far;
      const originalExposure = gl.toneMappingExposure;

      try {
        throwIfViewportCaptureAborted(signal);
        if (captureCamera) {
          applyCameraShotToCamera(workingCamera as ThreePerspectiveCamera, captureCamera, performance.now() / 1000);
          gl.toneMappingExposure = calculateDirectorCameraExposure(
            captureCamera,
            captureFps,
          ).rendererExposureMultiplier;
        }

        const snapshot = (label: string) => {
          throwIfViewportCaptureAborted(signal);
          const viewportWidth = gl.domElement.clientWidth || gl.domElement.width;
          const viewportHeight = gl.domElement.clientHeight || gl.domElement.height;
          const frameRect = getViewportAspectFrameRect(
            viewportAspectRatio,
            viewportWidth,
            viewportHeight,
            bottomPadding,
            safeAreaInsets,
          );
          const widthScale = gl.domElement.width / Math.max(viewportWidth, 1);
          const heightScale = gl.domElement.height / Math.max(viewportHeight, 1);
          let dataUrl: string | undefined;
          let capturedPass:
            | ReturnType<typeof captureDirectorRenderPass>
            | ReturnType<typeof captureDirectorCinematicRenderPass>
            | ReturnType<typeof composeDirectorLineartPass>
            | ReturnType<typeof captureDirectorPosePass>
            | ReturnType<typeof composeDirectorMotionVectorPass>
            | undefined;
          let capturedDepthFloat: ScreenshotResult["depthFloat"];
          let capturedMotionFlow: ScreenshotResult["motionFlow"];

          try {
            const shouldRenderOffscreen = renderPass !== undefined || width !== undefined;
            if (shouldRenderOffscreen) {
              const renderWidth = width ?? Math.max(1, Math.round((frameRect?.width ?? viewportWidth) * widthScale));
              const renderHeight =
                height ?? Math.max(1, Math.round((frameRect?.height ?? viewportHeight) * heightScale));
              if (isThreePerspectiveCamera(workingCamera)) {
                workingCamera.aspect = renderWidth / renderHeight;
                workingCamera.updateProjectionMatrix();
              }
              const captureSinglePass = (singlePass: DirectorShotRenderPassId) =>
                captureCamera
                  ? captureDirectorCinematicRenderPass({
                      renderer: gl,
                      scene,
                      camera: workingCamera as ThreePerspectiveCamera,
                      cameraShot: captureCamera,
                      renderPass: singlePass,
                      width: renderWidth,
                      height: renderHeight,
                      depthOfField: { quality: "high", enabled: depthOfField !== false },
                      ...(background ? { background } : {}),
                    })
                  : captureDirectorRenderPass({
                      renderer: gl,
                      scene,
                      camera: workingCamera,
                      renderPass: singlePass,
                      width: renderWidth,
                      height: renderHeight,
                      ...(background ? { background } : {}),
                    });
              // Motion is not rendered directly either: the same-frame
              // object-id buffer is the region mask, while the vectors come
              // from the deterministic frame evaluators (current vs previous
              // frame), so camera ego-motion parallax is exact, not estimated.
              const captureMotionPass = () => {
                const objectIdPass = captureSinglePass("object-id");
                const toFrame = currentFrame;
                const fromFrame = Math.max(0, toFrame - 1);
                const aspect = renderWidth / renderHeight;
                const poseFromShot = (shot: DirectorCameraShot): DirectorMotionCameraPose => {
                  const view = getCameraViewSnapshotFromShot(shot);
                  return {
                    position: [...view.position],
                    target: [...view.target],
                    fovDegrees: view.fov,
                    aspect,
                  };
                };
                const toPose: DirectorMotionCameraPose = captureCamera
                  ? poseFromShot(captureCamera)
                  : {
                      position: [workingCamera.position.x, workingCamera.position.y, workingCamera.position.z],
                      target: [target.x, target.y, target.z],
                      fovDegrees: isThreePerspectiveCamera(workingCamera) ? workingCamera.fov : 50,
                      aspect,
                    };
                const previousCameraSource =
                  requestedCameraSource ?? (viewMode === "camera" ? activeCamera : undefined);
                // Frame 0 (and the free viewport camera, which is not
                // animated) samples the same pose twice: zero camera motion.
                const fromPose =
                  captureCamera && previousCameraSource && fromFrame !== toFrame
                    ? poseFromShot(
                        evaluateDirectorCameraAtFrame(
                          previousCameraSource,
                          fromFrame,
                          getCameraActionTargetsAtFrame(
                            previousCameraSource,
                            captureProject.objects,
                            fromFrame,
                            captureFps,
                          ),
                        ),
                      )
                    : toPose;
                const anchorsAtFrame = (anchorFrame: number) =>
                  captureProject.objects
                    .filter((item) => item.visible && item.kind !== "camera")
                    .map((item) => {
                      const evaluated = evaluateDirectorObjectAtFrame(item, anchorFrame, captureFps);
                      return {
                        objectId: item.id,
                        position: [...evaluated.transform.position] as [number, number, number],
                      };
                    });
                const vectors = computeDirectorObjectMotionVectors({
                  width: renderWidth,
                  height: renderHeight,
                  fromCamera: fromPose,
                  toCamera: toPose,
                  fromAnchors: anchorsAtFrame(fromFrame),
                  toAnchors: anchorsAtFrame(toFrame),
                });
                // The dense flow reuses the same-frame captures this pass
                // already owns: float depth (a second depth render, PNG bytes
                // untouched) reprojects static geometry through the frame
                // pair's cameras, while the object-id silhouettes are
                // overridden with the exact per-object vectors above.
                if (motionFlowFloat) {
                  const depthFloatCapture = captureCamera
                    ? captureDirectorCinematicDepthFloat({
                        renderer: gl,
                        scene,
                        camera: workingCamera as ThreePerspectiveCamera,
                        cameraShot: captureCamera,
                        width: renderWidth,
                        height: renderHeight,
                      })
                    : captureDirectorDepthFloat({
                        renderer: gl,
                        scene,
                        camera: workingCamera,
                        width: renderWidth,
                        height: renderHeight,
                      });
                  capturedMotionFlow = computeDirectorDenseMotionFlow({
                    width: renderWidth,
                    height: renderHeight,
                    fromFrame,
                    toFrame,
                    fromCamera: fromPose,
                    toCamera: toPose,
                    toDepth: depthFloatCapture.depth,
                    objectIdRgba: objectIdPass.rgba,
                    objectIdToRgb: objectIdPass.metadata.objectIdToRgb ?? {},
                    objectVectors: vectors,
                  });
                }
                return composeDirectorMotionVectorPass({
                  width: renderWidth,
                  height: renderHeight,
                  objectIdRgba: objectIdPass.rgba,
                  objectIdToRgb: objectIdPass.metadata.objectIdToRgb ?? {},
                  vectors,
                  fromFrame,
                  toFrame,
                  fromCamera: fromPose,
                  toCamera: toPose,
                });
              };
              // Lineart is not rendered directly: capture the same-frame depth
              // and normal passes, then extract geometry edges on the CPU.
              // Pose is likewise CPU-drawn from the skinned rigs and needs only
              // the scene plus the evaluated camera, never the WebGL renderer.
              capturedPass =
                renderPass === "lineart"
                  ? composeDirectorLineartPass({
                      depth: captureSinglePass("depth"),
                      normal: captureSinglePass("normal"),
                    })
                  : renderPass === "pose"
                    ? captureDirectorPosePass({
                        scene,
                        camera: workingCamera,
                        width: renderWidth,
                        height: renderHeight,
                      })
                    : renderPass === "motion"
                      ? captureMotionPass()
                      : captureSinglePass(renderPass ?? "clean");
              dataUrl = encodeDirectorRgbaPng(capturedPass.rgba, renderWidth, renderHeight, signal);
              // Float depth is a second render of the same pass: PNG bytes stay
              // untouched while the EXR path receives full-precision metres.
              if (depthFloat && renderPass === "depth") {
                capturedDepthFloat = captureCamera
                  ? captureDirectorCinematicDepthFloat({
                      renderer: gl,
                      scene,
                      camera: workingCamera as ThreePerspectiveCamera,
                      cameraShot: captureCamera,
                      width: renderWidth,
                      height: renderHeight,
                    })
                  : captureDirectorDepthFloat({
                      renderer: gl,
                      scene,
                      camera: workingCamera,
                      width: renderWidth,
                      height: renderHeight,
                    });
              }
            } else if (frameRect && frameRect.width > 0 && frameRect.height > 0) {
              const renderX = Math.round(frameRect.left * widthScale);
              const renderY = Math.round((viewportHeight - frameRect.top - frameRect.height) * heightScale);
              const renderWidth = Math.max(1, Math.round(frameRect.width * widthScale));
              const renderHeight = Math.max(1, Math.round(frameRect.height * heightScale));
              if (isThreePerspectiveCamera(workingCamera)) {
                workingCamera.aspect = frameRect.width / frameRect.height;
                workingCamera.updateProjectionMatrix();
              }
              gl.setViewport(renderX, renderY, renderWidth, renderHeight);
              gl.setScissor(renderX, renderY, renderWidth, renderHeight);
              gl.setScissorTest(true);
            }

            if (!shouldRenderOffscreen) {
              withViewportCaptureHelpersHidden(scene, () => {
                throwIfViewportCaptureAborted(signal);
                if (captureCamera) {
                  withDirectorAnamorphicProjection(workingCamera as ThreePerspectiveCamera, captureCamera, () =>
                    gl.render(scene, workingCamera),
                  );
                } else {
                  gl.render(scene, workingCamera);
                }
              });
              throwIfViewportCaptureAborted(signal);
              dataUrl = captureViewportCanvas(
                gl.domElement,
                viewportAspectRatio,
                bottomPadding,
                safeAreaInsets,
                signal,
                cleanPlate
                  ? undefined
                  : {
                      camera: workingCamera,
                      labels: getViewportCaptureLabels(currentFrame),
                    },
              );
            }
          } finally {
            gl.setScissorTest(false);
            gl.setViewport(0, 0, gl.domElement.width, gl.domElement.height);
            if (isThreePerspectiveCamera(workingCamera) && originalAspect !== null) {
              workingCamera.aspect = originalAspect;
              workingCamera.updateProjectionMatrix();
            }
          }
          throwIfViewportCaptureAborted(signal);
          if (!dataUrl) throw new Error("Viewport capture did not produce PNG output.");
          return {
            label,
            dataUrl,
            ...(capturedDepthFloat ? { depthFloat: capturedDepthFloat } : {}),
            ...(capturedMotionFlow ? { motionFlow: capturedMotionFlow } : {}),
            ...(includeRenderPixels && capturedPass
              ? {
                  renderPixels: {
                    width: capturedPass.metadata.width,
                    height: capturedPass.metadata.height,
                    format: "rgba8" as const,
                    data: new Uint8Array(capturedPass.rgba),
                  },
                }
              : {}),
            meta: buildScreenshotMeta({
              mode: captureCamera ? "camera" : viewMode,
              cameraId: captureCamera?.id ?? null,
              fov: isThreePerspectiveCamera(workingCamera) ? workingCamera.fov : 50,
              position: [workingCamera.position.x, workingCamera.position.y, workingCamera.position.z],
              target: [target.x, target.y, target.z],
              ...(capturedPass
                ? {
                    renderPass: capturedPass.metadata.renderPass,
                    renderEncoding: capturedPass.metadata.encoding,
                    renderColorSpace: capturedPass.metadata.colorSpace,
                    bitsPerChannel: capturedPass.metadata.bitsPerChannel,
                    raster: { width: capturedPass.metadata.width, height: capturedPass.metadata.height },
                    ...(capturedPass.metadata.renderPass === "object-id" && capturedPass.metadata.objectIdToRgb
                      ? {
                          objectIdColors: filterVisibleObjectIdColors(
                            capturedPass.rgba,
                            capturedPass.metadata.objectIdToRgb,
                          ),
                        }
                      : {}),
                    ...("categoryToRgb" in capturedPass.metadata && capturedPass.metadata.categoryToRgb
                      ? { categoryColors: capturedPass.metadata.categoryToRgb }
                      : {}),
                    ...("anamorphic" in capturedPass.metadata
                      ? {
                          anamorphic: {
                            applied: capturedPass.metadata.anamorphic.applied,
                            squeeze: capturedPass.metadata.anamorphic.squeeze,
                            horizontalFovDegreesBefore: capturedPass.metadata.anamorphic.horizontalFovDegreesBefore,
                            horizontalFovDegreesAfter: capturedPass.metadata.anamorphic.horizontalFovDegreesAfter,
                          },
                          depthOfField: {
                            applied: capturedPass.metadata.depthOfField.applied,
                            quality: capturedPass.metadata.depthOfField.quality,
                            apertureFStop: capturedPass.metadata.depthOfField.apertureFStop,
                            focusDistanceM: capturedPass.metadata.depthOfField.focusDistanceM,
                            sampleCount: capturedPass.metadata.depthOfField.sampleCount,
                            maxBlurPixels: capturedPass.metadata.depthOfField.maxBlurPixels,
                            ...(capturedPass.metadata.depthOfField.bypassReason
                              ? { bypassReason: capturedPass.metadata.depthOfField.bypassReason }
                              : {}),
                          },
                        }
                      : {}),
                  }
                : {}),
              ...(frame === undefined ? {} : { frame: currentFrame }),
              ...(revisionRequested === undefined ? {} : { revisionRequested }),
            }),
          };
        };

        throwIfViewportCaptureAborted(signal);
        if (preset === "current") {
          return [snapshot(captureCamera || source === "camera-panel" ? "当前机位" : "当前视角")];
        }

        const count = preset === "four" ? 4 : 12;
        const labelPrefix = preset === "four" ? "四方位" : "十二方位";
        const offset = workingCamera.position.clone().sub(target);
        const spherical = new Spherical().setFromVector3(offset.lengthSq() === 0 ? new Vector3(0, 0, 6) : offset);
        const phi = Math.min(Math.max(spherical.phi, 0.35), Math.PI - 0.35);
        const radius = spherical.radius || 6;
        const results: ScreenshotResult[] = [];
        for (let index = 0; index < count; index += 1) {
          throwIfViewportCaptureAborted(signal);
          const orbit = new Spherical(radius, phi, spherical.theta + (Math.PI * 2 * index) / count);
          const nextPosition = target.clone().add(new Vector3().setFromSpherical(orbit));
          workingCamera.position.copy(nextPosition);
          workingCamera.lookAt(target);
          workingCamera.updateProjectionMatrix();
          throwIfViewportCaptureAborted(signal);
          results.push(snapshot(`${labelPrefix} ${index + 1}`));
          throwIfViewportCaptureAborted(signal);
        }
        return results;
      } finally {
        workingCamera.position.copy(originalPosition);
        workingCamera.quaternion.copy(originalQuaternion);
        workingCamera.updateMatrixWorld();
        if (isThreePerspectiveCamera(workingCamera) && originalFov !== null) workingCamera.fov = originalFov;
        workingCamera.near = originalNear;
        workingCamera.far = originalFar;
        gl.toneMappingExposure = originalExposure;
        workingCamera.updateProjectionMatrix();
        if (!signal.aborted) {
          throwIfViewportCaptureAborted(signal);
          // Offscreen frame export must not redraw the default framebuffer by
          // itself. The coordinated R3F pass also composites the live camera
          // preview; rendering only the scene here made that preview disappear
          // and reappear once per exported frame, which looked like camera
          // shake during recording and multimodal export.
          if (renderPass !== undefined || width !== undefined) invalidate();
          else gl.render(scene, camera);
        }
      }
    },
    [
      activeCamera,
      bottomPadding,
      camera,
      controlsRef,
      currentFrameRef,
      directorCaptureCamera,
      gl,
      invalidate,
      prepareCaptureFrame,
      safeAreaInsets,
      scene,
      viewMode,
      viewportAspectRatio,
    ],
  );

  const captureRef = useRef(capture);
  captureRef.current = capture;

  // Register during the commit itself so the gateway cannot publish a live
  // Stage target before its visible R3F canvas is capture-ready. The bridge
  // keeps this lease across Vite module replacement; mount/unmount still owns
  // the actual WebGL handler lifetime.
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    return setViewportCaptureHandler(async (request) => {
      // Every capture — screenshot, recording frame, export frame — must
      // render with a frozen ambient world clock so the frame prepared for
      // the request is exactly the frame that gets encoded.
      setWorldAmbientClockSuspended(true);
      try {
        return await captureRef.current(request);
      } finally {
        setWorldAmbientClockSuspended(false);
      }
    });
  }, [enabled]);

  return null;
}

/** Applies authored cinema exposure to the live camera view without putting high-frequency state in React. */
function CameraExposureController({
  cameraShot,
  fps,
  viewMode,
}: {
  cameraShot: DirectorCameraShot | undefined;
  fps: number;
  viewMode: "director" | "camera";
}) {
  const { gl, invalidate } = useThree();
  const exposure =
    viewMode === "camera" && cameraShot
      ? calculateDirectorCameraExposure(cameraShot, fps).rendererExposureMultiplier
      : 1;

  useLayoutEffect(() => {
    gl.toneMappingExposure = exposure;
    invalidate();
    return () => {
      gl.toneMappingExposure = 1;
    };
  }, [exposure, gl, invalidate]);

  return null;
}

function DirectorViewCameraSync({
  controlsRef,
  playerMode = false,
  snapshot,
  viewMode,
}: {
  controlsRef: MutableRefObject<OrbitControlsImpl | null>;
  playerMode?: boolean;
  snapshot: CameraShotSnapshot;
  viewMode: "director" | "camera";
}) {
  const { camera } = useThree();

  useLayoutEffect(() => {
    if (viewMode !== "director" || playerMode) return;

    applySnapshotToCamera(camera as ThreePerspectiveCamera, snapshot);
    const viewDistance = new Vector3(...snapshot.position).distanceTo(new Vector3(...snapshot.target));
    ensureViewportCameraClippingRange(camera as ThreePerspectiveCamera | OrthographicCamera, viewDistance);

    if (controlsRef.current) {
      controlsRef.current.target.set(...snapshot.target);
      controlsRef.current.update();
    }
  }, [camera, controlsRef, playerMode, snapshot, viewMode]);

  return null;
}

function DirectorViewportClippingController({
  active,
  controlsRef,
}: {
  active: boolean;
  controlsRef: MutableRefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();

  useFrame(() => {
    if (!active || !isThreePerspectiveCamera(camera)) return;
    const target = controlsRef.current?.target;
    const viewDistance = target ? camera.position.distanceTo(target) : camera.position.length();
    ensureViewportCameraClippingRange(camera, viewDistance);
  });

  return null;
}

function isEditableViewportTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName);
}

/**
 * Without an explicit selection, roam should pick the character the user is
 * already looking at instead of an arbitrary list order.
 */
function getNearestPlayerCandidate<T extends { transform: { position: [number, number, number] } }>(
  candidates: T[],
  cameraPosition: [number, number, number],
): T | undefined {
  let nearest: T | undefined;
  let nearestDistanceSq = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const dx = candidate.transform.position[0] - cameraPosition[0];
    const dz = candidate.transform.position[2] - cameraPosition[2];
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = candidate;
    }
  }
  return nearest;
}

function SmoothOrbitZoom({
  activityRef,
  controlsRef,
  enabled,
  onSettled,
  zoomSensitivity,
}: {
  activityRef: MutableRefObject<boolean>;
  controlsRef: MutableRefObject<OrbitControlsImpl | null>;
  enabled: boolean;
  onSettled: () => void;
  zoomSensitivity: number;
}) {
  const { gl, invalidate } = useThree();
  const pendingLogScaleRef = useRef(0);

  useEffect(() => {
    const element = gl.domElement;
    if (typeof element.addEventListener !== "function") return;
    const handleWheel = (event: WheelEvent) => {
      if (!enabled) return;
      const controls = controlsRef.current;
      if (!controls?.enabled || !controls.enableZoom) return;

      const impulse = getViewportWheelZoomImpulse(event.deltaY, event.deltaMode, element.clientHeight, zoomSensitivity);
      if (impulse === 0) return;

      pendingLogScaleRef.current = enqueueViewportWheelZoom(pendingLogScaleRef.current, impulse);
      activityRef.current = true;
      invalidate();
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    element.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => element.removeEventListener("wheel", handleWheel, true);
  }, [activityRef, controlsRef, enabled, gl.domElement, invalidate, zoomSensitivity]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!enabled || !controls?.enabled || !controls.enableZoom) {
      pendingLogScaleRef.current = 0;
      if (activityRef.current) {
        activityRef.current = false;
        onSettled();
      }
      return;
    }

    const pending = pendingLogScaleRef.current;
    if (pending === 0) {
      if (activityRef.current) {
        activityRef.current = false;
        onSettled();
      }
      return;
    }

    pendingLogScaleRef.current = applyViewportWheelZoomFrame(controls, pending, delta);
    if (pendingLogScaleRef.current !== 0) invalidate();
    if (pendingLogScaleRef.current === 0 && activityRef.current) {
      activityRef.current = false;
      onSettled();
    }
  });

  return null;
}

/**
 * Cursor view adds Flick's right-button fly-through. Pointer gestures stay
 * inside OrbitControls so selection, Ctrl/Shift pan, and the final settle
 * event cannot fight a second native pointer handler.
 */
function CursorViewportNavigation({
  controlsRef,
  enabled,
  moveSpeed,
  onSnapshotChange,
  onInteractionEnd,
}: {
  controlsRef: MutableRefObject<OrbitControlsImpl | null>;
  enabled: boolean;
  moveSpeed: number;
  onSnapshotChange: (snapshot: CameraShotSnapshot) => void;
  onInteractionEnd: () => void;
}) {
  const { camera, gl, invalidate } = useThree();
  const pressedKeysRef = useRef(new Set<string>());
  const rightPointerDownRef = useRef(false);
  const forwardRef = useRef(new Vector3());
  const rightRef = useRef(new Vector3());
  const upRef = useRef(new Vector3(0, 1, 0));
  const moveRef = useRef(new Vector3());
  const movedSinceSettleRef = useRef(false);

  const emitSnapshot = useCallback(() => {
    const viewportCamera = camera as Camera;
    const target =
      controlsRef.current?.target ?? viewportCamera.getWorldDirection(forwardRef.current).add(viewportCamera.position);
    onSnapshotChange({
      fov:
        (viewportCamera as ThreePerspectiveCamera).isPerspectiveCamera === true
          ? (viewportCamera as ThreePerspectiveCamera).fov
          : DEFAULT_DIRECTOR_VIEW_SNAPSHOT.fov,
      position: [viewportCamera.position.x, viewportCamera.position.y, viewportCamera.position.z],
      target: [target.x, target.y, target.z],
    });
  }, [camera, controlsRef, onSnapshotChange]);

  const settleInteraction = useCallback(() => {
    if (!movedSinceSettleRef.current) return;
    movedSinceSettleRef.current = false;
    onInteractionEnd();
  }, [onInteractionEnd]);

  useEffect(() => {
    if (!enabled) return;
    const element = gl.domElement;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !rightPointerDownRef.current ||
        isEditableViewportTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (!["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyQ", "ShiftLeft", "ShiftRight"].includes(event.code)) return;
      event.preventDefault();
      pressedKeysRef.current.add(event.code);
      invalidate();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      pressedKeysRef.current.delete(event.code);
      if (!hasViewportMovementKey(pressedKeysRef.current)) {
        settleInteraction();
      }
    };
    const clearKeys = () => {
      pressedKeysRef.current.clear();
      settleInteraction();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 2) return;
      rightPointerDownRef.current = true;
      invalidate();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 2) return;
      rightPointerDownRef.current = false;
      clearKeys();
    };
    const clearPointer = () => {
      rightPointerDownRef.current = false;
      clearKeys();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearPointer);
    element.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", clearPointer);
    return () => {
      clearPointer();
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearPointer);
      element.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", clearPointer);
    };
  }, [enabled, gl.domElement, invalidate, settleInteraction]);

  useFrame((_state, delta) => {
    if (!enabled || !rightPointerDownRef.current || !hasViewportMovementKey(pressedKeysRef.current)) return;
    const controls = controlsRef.current;
    if (!controls) return;
    const forward = forwardRef.current;
    const viewportCamera = camera as Camera;
    viewportCamera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.0001) return;
    forward.normalize();
    rightRef.current.crossVectors(forward, upRef.current).normalize();
    const keys = pressedKeysRef.current;
    const speed =
      Math.max(0, moveSpeed) *
      (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1.75 : 1) *
      Math.min(Math.max(delta, 0), 0.1);
    moveRef.current.set(0, 0, 0);
    if (keys.has("KeyW")) moveRef.current.add(forward);
    if (keys.has("KeyS")) moveRef.current.sub(forward);
    if (keys.has("KeyD")) moveRef.current.add(rightRef.current);
    if (keys.has("KeyA")) moveRef.current.sub(rightRef.current);
    if (keys.has("KeyE")) moveRef.current.add(upRef.current);
    if (keys.has("KeyQ")) moveRef.current.sub(upRef.current);
    if (moveRef.current.lengthSq() < 0.0001) return;
    moveRef.current.normalize().multiplyScalar(speed);
    viewportCamera.position.add(moveRef.current);
    viewportCamera.updateMatrixWorld();
    controls.target.add(moveRef.current);
    controls.update();
    movedSinceSettleRef.current = true;
    emitSnapshot();
    invalidate();
  });

  return null;
}

function CameraHandheldMotion({
  cameraShot,
  snapshot,
}: {
  cameraShot: DirectorCameraShot;
  snapshot: CameraShotSnapshot;
}) {
  const { camera } = useThree();

  useFrame(({ clock }) => {
    const shake = getDirectorCameraHandheldShake(cameraShot.handheldShake, clock.getElapsedTime());
    if (cameraShot.handheldShake === "off" || !cameraShot.handheldShake) return;

    const perspectiveCamera = camera as ThreePerspectiveCamera;
    perspectiveCamera.position.set(
      snapshot.position[0] + shake.position[0],
      snapshot.position[1] + shake.position[1],
      snapshot.position[2] + shake.position[2],
    );
    perspectiveCamera.lookAt(
      snapshot.target[0] + shake.target[0],
      snapshot.target[1] + shake.target[1],
      snapshot.target[2] + shake.target[2],
    );
    perspectiveCamera.updateMatrixWorld();
  });

  return null;
}

const previewDepthViewDirection = new Vector3();
// Frame-persistent gl.getViewport/getScissor targets. Each saved value must
// stay untouched until the finally-restore, so viewport and scissor get
// dedicated instances, separate from QuadViewportRenderer's (both passes can
// run within the same frame).
const pipPreviousViewport = new Vector4();
const pipPreviousScissor = new Vector4();

/**
 * Renders the selected camera into a scissored corner of the existing WebGL
 * canvas. Keeping this in the same renderer makes the inset a live view of
 * the exact scene rather than a stale thumbnail or a second, divergent canvas.
 */
function CameraPictureInPictureRenderer({
  cameraShot,
  previewMode,
}: {
  cameraShot: DirectorCameraShot;
  previewMode: DirectorCameraPreviewMode;
}) {
  const { camera, gl, scene, size } = useThree();
  const pictureCamera = useMemo(() => new ThreePerspectiveCamera(), []);
  const previewComposite = useMemo(() => {
    const target = new WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      format: RGBAFormat,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      stencilBuffer: false,
      type: UnsignedByteType,
    });
    target.samples = Math.min(4, Math.max(0, gl.capabilities?.maxSamples ?? 0));
    target.texture.colorSpace = gl.outputColorSpace;
    target.texture.generateMipmaps = false;
    const geometry = new PlaneGeometry(2, 2);
    const material = new MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      map: target.texture,
      toneMapped: false,
    });
    const compositeScene = new Scene();
    compositeScene.add(new Mesh(geometry, material));
    return {
      camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1),
      geometry,
      material,
      scene: compositeScene,
      target,
    };
  }, [gl]);
  const fps = useDirectorStore((state) => getDirectorTimelineFps(state.project.scene.timeline));
  const sceneSettings = useDirectorStore((state) => state.project.scene);
  const aspect = getDirectorCameraAspectValue(cameraShot.aspectRatio);
  const snapshot = useMemo(() => getSceneCameraViewSnapshot(cameraShot, sceneSettings), [cameraShot, sceneSettings]);
  const optics = useMemo(() => normalizeDirectorCameraOptics(cameraShot), [cameraShot]);
  const rendererExposure = useMemo(
    () => calculateDirectorCameraExposure(cameraShot, fps).rendererExposureMultiplier,
    [cameraShot, fps],
  );
  const renderGraphSignature = useDirectorStore((state) =>
    state.project.objects
      .map((object) => `${object.id}:${object.kind}:${object.assetRefId ?? ""}:${object.linkedCameraId ?? ""}`)
      .join("|"),
  );
  const renderIndexRef = useRef<{
    graphSignature: string;
    helpers: Object3D[];
    previzBounds: Box3 | null;
    previzMeshes: DirectorPrevizMeshEntry[];
    refreshedAt: number;
    scene: Object3D | null;
    segmentationEntries: DirectorCameraPreviewSegmentationEntry[];
  }>({
    graphSignature: "",
    helpers: [],
    previzBounds: null,
    previzMeshes: [],
    refreshedAt: Number.NEGATIVE_INFINITY,
    scene: null,
    segmentationEntries: [],
  });
  const lastPreviewRefreshAtRef = useRef(Number.NEGATIVE_INFINITY);
  const previewDirtyRef = useRef(true);
  const motionPreviewActiveRef = useRef(false);
  const motionPreviewCameraIdRef = useRef<string | null>(null);

  // R3F camera motion mutates refs without re-rendering this component. Any
  // React render here therefore represents camera/scene/layout data that must
  // invalidate the cached preview, even when it occurs inside the 30 fps window.
  previewDirtyRef.current = true;

  useEffect(
    () => () => {
      previewComposite.geometry.dispose();
      previewComposite.material.dispose();
      previewComposite.target.dispose();
    },
    [previewComposite],
  );

  useFrame((state) => {
    const draggingPip = isCameraPictureInPictureDragging();
    const frozenPip = isCameraPictureInPicturePreviewFrozen();
    if (draggingPip && frozenPip) return;

    const motionPreview = previewMode === "motion";
    if (motionPreview && (!motionPreviewActiveRef.current || motionPreviewCameraIdRef.current !== cameraShot.id)) {
      resetDirectorCameraPreviewMotionHistory();
    }
    motionPreviewActiveRef.current = motionPreview;
    motionPreviewCameraIdRef.current = cameraShot.id;

    const renderPlan = getDirectorCameraPreviewRenderPlan(
      state.clock.elapsedTime,
      lastPreviewRefreshAtRef.current,
      previewDirtyRef.current,
      DIRECTOR_CAMERA_PREVIEW_MAX_FPS,
      draggingPip,
    );
    const mainCamera = camera as ThreePerspectiveCamera;
    const canvasWidth = Math.max(1, Math.round(size.width));
    const canvasHeight = Math.max(1, Math.round(size.height));
    const pipOffset = getCameraPictureInPictureOffset();
    // DOM getBoundingClientRect() here used to force two synchronous layouts
    // on every frame. The overlay and scissor share these exact layout inputs,
    // so the hot path can stay entirely in arithmetic.
    const inset = getCameraPictureInPictureRenderRectFromLayout({
      viewportWidth: size.width,
      viewportHeight: size.height,
      offset: pipOffset,
      aspect,
    });
    const { x: insetX, y: insetY, width: insetWidth, height: insetHeight } = inset;
    const previewSize = getCameraPictureInPictureRenderTargetSize(insetWidth, insetHeight, gl.getPixelRatio());
    const previewWidth = previewSize.width;
    const previewHeight = previewSize.height;
    const previousAutoClear = gl.autoClear;
    const previousExposure = gl.toneMappingExposure;
    const previousRenderTarget = gl.getRenderTarget();
    const previousViewport = gl.getViewport(pipPreviousViewport);
    const previousScissor = gl.getScissor(pipPreviousScissor);
    const previousScissorTest = gl.getScissorTest();
    const renderIndex = renderIndexRef.current;
    // GLB / living-world meshes appear after the project graph signature is
    // already stable. A 2s cache left those surfaces on authored RGB inside
    // the clay monitor until the next index rebuild.
    if (renderPlan.refreshPictureInPicture) {
      renderIndex.previzMeshes = collectDirectorPrevizMeshes(scene);
      renderIndex.segmentationEntries = collectDirectorCameraPreviewSegmentationEntries(scene);
    }
    if (
      renderIndex.scene !== scene ||
      renderIndex.graphSignature !== renderGraphSignature ||
      state.clock.elapsedTime - renderIndex.refreshedAt >= 2
    ) {
      renderIndex.scene = scene;
      renderIndex.graphSignature = renderGraphSignature;
      renderIndex.refreshedAt = state.clock.elapsedTime;
      renderIndex.helpers = collectDirectorCaptureHelpers(scene);
      renderIndex.previzBounds = computeDirectorCameraPreviewSceneBounds(
        renderIndex.previzMeshes.map((entry) => entry.mesh),
      );
    }

    pictureCamera.aspect = aspect;
    pictureCamera.layers.mask = mainCamera.layers.mask;
    applySnapshotToCamera(pictureCamera, snapshot);
    pictureCamera.near = optics.nearClipM;
    pictureCamera.far = optics.farClipM;
    pictureCamera.updateProjectionMatrix();
    const shake = getDirectorCameraHandheldShake(cameraShot.handheldShake, state.clock.getElapsedTime());
    if (cameraShot.handheldShake && cameraShot.handheldShake !== "off") {
      pictureCamera.position.set(
        snapshot.position[0] + shake.position[0],
        snapshot.position[1] + shake.position[1],
        snapshot.position[2] + shake.position[2],
      );
      pictureCamera.lookAt(
        snapshot.target[0] + shake.target[0],
        snapshot.target[1] + shake.target[1],
        snapshot.target[2] + shake.target[2],
      );
      pictureCamera.updateMatrixWorld();
    }

    // A positive useFrame priority disables R3F's automatic render. Render the
    // main editor first, then replace only the small scissored region with the
    // active camera's image.
    const restoreRendererInfo = beginDirectorCompositeRendererInfoPass(gl.info);
    const restoreShadowMap = beginDirectorCompositeShadowPass(gl.shadowMap);
    try {
      gl.setRenderTarget(null);
      gl.setScissorTest(false);
      gl.setViewport(0, 0, canvasWidth, canvasHeight);
      gl.autoClear = true;
      if (renderPlan.renderMainViewport) gl.render(scene, mainCamera);

      if (renderPlan.refreshPictureInPicture) {
        if (previewComposite.target.width !== previewWidth || previewComposite.target.height !== previewHeight) {
          previewComposite.target.setSize(previewWidth, previewHeight);
        }
        previewComposite.target.texture.colorSpace = gl.outputColorSpace;
        gl.toneMappingExposure = rendererExposure;
        gl.setRenderTarget(previewComposite.target);
        // setRenderTarget applies the target's physical-pixel viewport. Calling
        // setViewport with previewWidth here would multiply it by renderer DPR
        // a second time and crop/underscan the FBO on non-1x displays.
        gl.setScissorTest(false);
        gl.autoClear = true;
        const visibilityScope = suppressDirectorCaptureHelpers(scene, renderIndex.helpers);
        // Previz keeps the blocking-stage clay look; RGB renders authored
        // materials; depth/normal/motion/wireframe switch the scene to technical
        // visualization; objectid/mask recolor cached meshes one by one.
        if (motionPreview) {
          updateDirectorCameraPreviewMotionUniforms(pictureCamera, previewWidth, previewHeight);
        }
        const materialScope =
          previewMode === "previz" ? applyDirectorPrevizMaterialEntries(renderIndex.previzMeshes, scene) : null;
        const modalityScope = applyDirectorCameraPreviewModalityScope(
          gl,
          scene,
          previewMode,
          getDirectorCameraPreviewDepthRange(
            pictureCamera.position,
            pictureCamera.getWorldDirection(previewDepthViewDirection),
            renderIndex.previzBounds,
          ),
        );
        const segmentationScope = isDirectorCameraPreviewSegmentationMode(previewMode)
          ? applyDirectorCameraPreviewSegmentationScope(previewMode, renderIndex.segmentationEntries)
          : null;
        try {
          // Keep the framing monitor on the same colour path as the main scene.
          // Authored DOF remains available in clean captures and recording, while
          // this direct pass avoids a low-resolution post-process colour shift.
          gl.clear(true, true, true);
          gl.render(scene, pictureCamera);
          if (motionPreview) commitDirectorCameraPreviewMotionHistory(pictureCamera, scene);
        } finally {
          segmentationScope?.restore();
          modalityScope?.restore();
          materialScope?.restore();
          visibilityScope.restore();
        }
        lastPreviewRefreshAtRef.current = state.clock.elapsedTime;
        previewDirtyRef.current = false;
      }

      if (draggingPip && !frozenPip) {
        if (copyPictureInPicturePreviewToFreezeCanvas(gl, previewComposite.target)) {
          markCameraPictureInPicturePreviewFrozen(true);
          return;
        }
      }

      if (renderPlan.compositePictureInPicture) {
        gl.toneMappingExposure = previousExposure;
        gl.setRenderTarget(null);
        gl.autoClear = false;
        gl.setViewport(insetX, insetY, insetWidth, insetHeight);
        gl.setScissor(insetX, insetY, insetWidth, insetHeight);
        gl.setScissorTest(true);
        gl.render(previewComposite.scene, previewComposite.camera);
      }

      if (!draggingPip && frozenPip) markCameraPictureInPicturePreviewFrozen(false);
    } finally {
      restoreShadowMap();
      restoreRendererInfo();
      gl.toneMappingExposure = previousExposure;
      gl.setRenderTarget(previousRenderTarget);
      gl.setViewport(previousViewport);
      gl.setScissor(previousScissor);
      gl.setScissorTest(previousScissorTest);
      gl.autoClear = previousAutoClear;
    }
  }, 100);

  return null;
}

function CameraPictureInPictureDragInvalidation() {
  const { invalidate } = useThree();

  useEffect(() => subscribeCameraPictureInPictureFrames(() => invalidate()), [invalidate]);

  return null;
}

const CAMERA_PREVIEW_MODE_LABELS: Record<DirectorCameraPreviewMode, { label: string; title: string }> = {
  previz: { label: "白模", title: "白模：体块阶段的统一材质" },
  rgb: { label: "原彩", title: "原彩：资产的原始 RGB 材质" },
  depth: { label: "深度", title: "深度图：近亮远暗的逆深度" },
  normal: { label: "法向", title: "法向图：视角空间法线" },
  objectid: { label: "分割图", title: "分割图：按对象实例的稳定分割着色" },
  mask: { label: "蒙版", title: "蒙版图：前景纯白、背景纯黑" },
  motion: { label: "光流", title: "光流：帧间屏幕位移，色相表示方向，亮度表示幅度" },
  wireframe: { label: "线框", title: "线框：几何拓扑线框视图" },
};

const CameraPictureInPictureOverlay = memo(function CameraPictureInPictureOverlay({
  cameraShot,
  locked,
  onSelectPreviewMode,
  onToggleLock,
  previewMode,
}: {
  cameraShot: DirectorCameraShot;
  locked: boolean;
  onSelectPreviewMode: (mode: DirectorCameraPreviewMode) => void;
  onToggleLock: () => void;
  previewMode: DirectorCameraPreviewMode;
}) {
  const { t } = useLanguage();
  const panelRef = useRef<HTMLElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const aspect = getDirectorCameraAspectValue(cameraShot.aspectRatio);
  const focalLength = Math.round(cameraShot.focalLengthMm ?? 35);
  const lockLabel = t(locked ? "解除相机视图锁定" : "锁定相机视图");
  const project = useDirectorStore((state) => state.project);
  // The same shared film-language reading agents get from observe, so the
  // viewfinder and the workbench can never disagree about the framing.
  const framingSlate = useMemo(
    () => directorCameraShotLanguageReport(project, cameraShot)?.slate ?? null,
    [project, cameraShot],
  );
  const getBounds = useCallback(() => {
    const frame = panelRef.current?.closest(".canvas-frame") ?? panelRef.current?.parentElement;
    return frame?.getBoundingClientRect() ?? null;
  }, []);
  const layout =
    viewportWidth && viewportWidth > 0
      ? resolveCameraPictureInPictureLayout(viewportWidth, aspect)
      : {
          width: CAMERA_PIP_WIDTH,
          height: CAMERA_PIP_WIDTH / Math.max(aspect, 0.01),
        };
  const { clampToBounds, offset, dragging, onPointerDown } = useViewportChromeDrag("pip", layout, getBounds);

  useLayoutEffect(() => {
    setCameraPictureInPictureOverlayElement(panelRef.current);
    return () => setCameraPictureInPictureOverlayElement(null);
  }, []);

  useLayoutEffect(() => {
    clampToBounds();
  }, [clampToBounds, viewportWidth]);

  useLayoutEffect(() => {
    const frame = panelRef.current?.closest(".canvas-frame") ?? panelRef.current?.parentElement;
    if (!frame) return;
    const updateWidth = () => {
      const nextWidth = frame.getBoundingClientRect().width;
      setViewportWidth((current) => (Math.abs((current ?? 0) - nextWidth) < 0.5 ? current : nextWidth));
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <aside
        aria-label={t(`${cameraShot.name} 实时取景`)}
        className={`camera-picture-in-picture${dragging ? " is-dragging" : ""}`}
        data-viewport-chrome="pip"
        ref={panelRef}
        style={
          {
            left: offset.x,
            top: offset.y,
            width: layout.width,
            height: layout.height,
            "--camera-picture-in-picture-aspect": String(aspect),
            "--camera-picture-in-picture-width": `${layout.width}px`,
          } as CSSProperties
        }
      >
        <span
          aria-label={t("拖动机位实时取景")}
          className="camera-picture-in-picture__drag-handle"
          onPointerDown={onPointerDown}
          role="presentation"
        />
        <div aria-hidden className="camera-picture-in-picture__freeze" />
        <button
          aria-label={lockLabel}
          aria-pressed={locked}
          className="camera-picture-in-picture__lock"
          title={lockLabel}
          type="button"
          onClick={onToggleLock}
        >
          {locked ? (
            <Lock aria-hidden size={13} strokeWidth={1.9} />
          ) : (
            <Unlock aria-hidden size={13} strokeWidth={1.9} />
          )}
        </button>
        <span className="camera-picture-in-picture__meta">
          <strong data-i18n-user-content>{t(cameraShot.name)}</strong>
          {framingSlate ? (
            <small aria-label={t("镜头语言标牌")} className="camera-picture-in-picture__slate">
              {framingSlate}
            </small>
          ) : null}
          <small>
            {focalLength} mm · {cameraShot.aspectRatio ?? "16:9"}
          </small>
        </span>
      </aside>
      {/* Docked below the frame so the monitor image itself stays unobstructed. */}
      <div
        aria-label={t("相机预览模态")}
        className={`camera-picture-in-picture__modes${dragging ? " is-dragging" : ""}`}
        data-viewport-chrome-satellite="pip"
        role="group"
        style={{ left: offset.x, top: offset.y + layout.height + 6, width: layout.width }}
      >
        {DIRECTOR_CAMERA_PREVIEW_MODES.map((mode) => (
          <button
            aria-label={t(CAMERA_PREVIEW_MODE_LABELS[mode].label)}
            aria-pressed={previewMode === mode}
            className={previewMode === mode ? "is-active" : ""}
            key={mode}
            onClick={() => onSelectPreviewMode(mode)}
            title={t(CAMERA_PREVIEW_MODE_LABELS[mode].title)}
            type="button"
          >
            <CameraPreviewModeGlyph mode={mode} />
            <span className="sr-only">{t(CAMERA_PREVIEW_MODE_LABELS[mode].label)}</span>
          </button>
        ))}
      </div>
    </>
  );
});

function BlenderViewportResize({
  fov,
  playerMode = false,
  viewMode,
}: {
  fov: number;
  playerMode?: boolean;
  viewMode: "director" | "camera";
}) {
  const { camera, size } = useThree();
  const referenceRef = useRef<{ fov: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (viewMode !== "director" || playerMode) {
      referenceRef.current = null;
      return;
    }

    const height = Math.max(size.height, 1);
    if (!referenceRef.current || Math.abs(referenceRef.current.fov - fov) > 0.00001) {
      referenceRef.current = { fov, height };
    }

    const perspectiveCamera = camera as ThreePerspectiveCamera;
    perspectiveCamera.fov = getBlenderViewportFov(referenceRef.current.fov, referenceRef.current.height, height);
    perspectiveCamera.updateProjectionMatrix();
  }, [camera, fov, playerMode, size.height, viewMode]);

  return null;
}

function ViewportGizmoContent({ snapshot }: { snapshot: CameraShotSnapshot }) {
  const { camera, invalidate } = useThree();

  useLayoutEffect(() => {
    applySnapshotToRelativeGizmoCamera(camera as ThreePerspectiveCamera, snapshot);
    invalidate();
  }, [camera, invalidate, snapshot]);

  const getGizmoTarget = useCallback(() => new Vector3(0, 0, 0), []);

  return (
    <GizmoHelper alignment="center-center" margin={[0, 0]} onTarget={getGizmoTarget}>
      <GizmoViewport
        axisColors={GIZMO_AXIS_COLORS}
        disabled
        hideNegativeAxes
        labelColor="#F5F5F7"
        labels={["X", "Y", "Z"]}
        scale={GIZMO_VIEWPORT_SCALE}
      />
    </GizmoHelper>
  );
}

function ViewportGizmoOverlay({
  dpr,
  onSnapshotChange,
  rightOffset = GIZMO_EDGE_PADDING,
  rotateSensitivity,
  snapshot,
}: {
  dpr: RenderDpr;
  onSnapshotChange: (snapshot: CameraShotSnapshot) => void;
  rightOffset?: number;
  rotateSensitivity: number;
  snapshot: CameraShotSnapshot;
}) {
  const [dragging, setDragging] = useState(false);
  const pointerSessionRef = useRef<{
    captureActive: boolean;
    initialSnapshot: CameraShotSnapshot;
    moved: boolean;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressClickRef = useRef(false);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const session = {
      captureActive: false,
      initialSnapshot: snapshot,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    pointerSessionRef.current = session;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      session.captureActive = event.currentTarget.hasPointerCapture?.(event.pointerId) ?? true;
    } catch {
      // Synthetic input and older embedded webviews can reject capture even
      // though the same pointer sequence remains usable inside the overlay.
    }
    event.preventDefault();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - session.startX;
    const deltaY = event.clientY - session.startY;
    if (!session.moved && Math.hypot(deltaX, deltaY) < GIZMO_DRAG_THRESHOLD_PX) return;
    if (!session.moved) {
      session.moved = true;
      setDragging(true);
    }
    event.preventDefault();
    onSnapshotChange(getViewportSnapshotFromGizmoDrag(session.initialSnapshot, deltaX, deltaY, rotateSensitivity));
  }

  function finishPointerInteraction(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    pointerSessionRef.current = null;
    suppressClickRef.current = !cancelled && session.moved;
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Pointer capture can be lost asynchronously when the host webview
      // changes focus. The gesture is already cleared above.
    }
  }

  return (
    <div
      aria-label="3D视口原生坐标控件"
      className={`viewport-gizmo-overlay${dragging ? " is-dragging" : ""}`}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onLostPointerCapture={(event) => finishPointerInteraction(event, true)}
      onPointerCancel={(event) => finishPointerInteraction(event, true)}
      onPointerDown={handlePointerDown}
      onPointerLeave={(event) => {
        if (pointerSessionRef.current?.captureActive) return;
        finishPointerInteraction(event, true);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerInteraction}
      style={{ right: `${rightOffset}px` }}
    >
      <Canvas
        className="viewport-gizmo-canvas"
        camera={{ fov: snapshot.fov, position: [0, 0, 1] }}
        dpr={dpr}
        frameloop="demand"
        gl={{
          alpha: true,
          antialias: true,
          depth: true,
          powerPreference: "high-performance",
          stencil: false,
        }}
      >
        <ViewportGizmoContent snapshot={snapshot} />
      </Canvas>
      <div className="viewport-gizmo-axis-hit-layer">
        {GIZMO_AXIS_TARGETS.map(({ direction, label }) => (
          <button
            aria-label={label}
            className="viewport-gizmo-axis-hit"
            key={label}
            style={getViewportGizmoHitButtonStyle(snapshot, direction)}
            title={label}
            type="button"
            onClick={() => onSnapshotChange(getViewportSnapshotFromGizmoDirection(snapshot, new Vector3(...direction)))}
            onPointerDown={(event) => event.stopPropagation()}
          />
        ))}
      </div>
    </div>
  );
}

function PlayheadSceneRoot(props: Omit<NonNullable<ComponentProps<typeof SceneRoot>>, "currentFrame">) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  return <SceneRoot {...props} currentFrame={currentFrame} />;
}

function ConnectedDirectorTimelineDock(props: Omit<ComponentProps<typeof DirectorTimelineDock>, "project">) {
  const project = useDirectorStore((state) => state.project);
  return <DirectorTimelineDock {...props} project={project} />;
}

function PlayheadCameraPilotHud(props: Omit<ComponentProps<typeof CameraPilotHud>, "currentFrame">) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  return <CameraPilotHud {...props} currentFrame={currentFrame} />;
}

function getEvaluatedPlaybackCamera(
  cameras: DirectorCameraShot[],
  storyboard: DirectorStoryboard | undefined,
  activeCameraId: string | null,
  objects: DirectorObject[],
  frame: number,
  fps: number,
) {
  const cameraId = getStoryboardCameraIdAtFrame(storyboard, frame, activeCameraId);
  const source = cameras.find((camera) => camera.id === cameraId);
  return {
    source,
    evaluated:
      source &&
      evaluateDirectorCameraAtFrame(source, frame, getCameraActionTargetsAtFrame(source, objects, frame, fps)),
  };
}

function PlayheadCameraRuntime({
  activeCameraId,
  cameras,
  lockedPreviewCameraId,
  objects,
  previewMode,
  showPictureInPicture,
  storyboard,
  timelineFps,
  viewMode,
}: {
  activeCameraId: string | null;
  cameras: DirectorCameraShot[];
  lockedPreviewCameraId: string | null;
  objects: DirectorObject[];
  previewMode: DirectorCameraPreviewMode;
  showPictureInPicture: boolean;
  storyboard: DirectorStoryboard | undefined;
  timelineFps: number;
  viewMode: "director" | "camera";
}) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  const { evaluated: activeCamera, source: activeCameraSource } = useMemo(
    () => getEvaluatedPlaybackCamera(cameras, storyboard, activeCameraId, objects, currentFrame, timelineFps),
    [activeCameraId, cameras, currentFrame, objects, storyboard, timelineFps],
  );
  const pictureInPictureCamera = useMemo(() => {
    if (!showPictureInPicture) return undefined;
    const source = lockedPreviewCameraId
      ? (cameras.find((camera) => camera.id === lockedPreviewCameraId) ?? activeCameraSource)
      : activeCameraSource;
    if (!source) return undefined;
    if (source.id === activeCameraSource?.id) return activeCamera;
    return evaluateDirectorCameraAtFrame(
      source,
      currentFrame,
      getCameraActionTargetsAtFrame(source, objects, currentFrame, timelineFps),
    );
  }, [
    activeCamera,
    activeCameraSource,
    cameras,
    currentFrame,
    lockedPreviewCameraId,
    objects,
    showPictureInPicture,
    timelineFps,
  ]);
  const activeCameraView = useMemo(
    () => (activeCamera ? getCameraViewSnapshotFromShot(activeCamera) : undefined),
    [activeCamera],
  );
  const activeCameraOptics = useMemo(() => normalizeDirectorCameraOptics(activeCamera ?? {}), [activeCamera]);

  return (
    <>
      <CameraExposureController cameraShot={activeCamera} fps={timelineFps} viewMode={viewMode} />
      {showPictureInPicture && pictureInPictureCamera ? (
        <>
          <CameraPictureInPictureRenderer cameraShot={pictureInPictureCamera} previewMode={previewMode} />
          <CameraPictureInPictureDragInvalidation />
        </>
      ) : null}
      {viewMode === "camera" && activeCameraView ? (
        <>
          <PerspectiveCamera
            far={activeCameraOptics.farClipM}
            fov={activeCameraView.fov}
            makeDefault
            near={activeCameraOptics.nearClipM}
            position={activeCameraView.position}
            onUpdate={(camera) => camera.lookAt(...activeCameraView.target)}
          />
          {activeCamera ? <CameraHandheldMotion cameraShot={activeCamera} snapshot={activeCameraView} /> : null}
        </>
      ) : null}
    </>
  );
}

function PlayheadViewportGizmoOverlay({
  activeCameraId,
  cameras,
  directorSnapshot,
  objects,
  storyboard,
  timelineFps,
  viewMode,
  ...props
}: Omit<ComponentProps<typeof ViewportGizmoOverlay>, "snapshot"> & {
  activeCameraId: string | null;
  cameras: DirectorCameraShot[];
  directorSnapshot: CameraShotSnapshot;
  objects: DirectorObject[];
  storyboard: DirectorStoryboard | undefined;
  timelineFps: number;
  viewMode: "director" | "camera";
}) {
  // Director view uses its own free camera, so transient timeline ticks must
  // not rebuild the nested gizmo canvas. Camera view still follows the shot.
  const currentFrame = useTimelineRuntimeStore((state) => (viewMode === "camera" ? state.playheadFrame : 0));
  const snapshot = useMemo(() => {
    if (viewMode !== "camera") return directorSnapshot;
    const { evaluated } = getEvaluatedPlaybackCamera(
      cameras,
      storyboard,
      activeCameraId,
      objects,
      currentFrame,
      timelineFps,
    );
    return evaluated ? getCameraViewSnapshotFromShot(evaluated) : directorSnapshot;
  }, [activeCameraId, cameras, currentFrame, directorSnapshot, objects, storyboard, timelineFps, viewMode]);
  return <ViewportGizmoOverlay {...props} snapshot={snapshot} />;
}

function PlayheadCameraPictureInPictureOverlay({
  activeCameraId,
  cameras,
  lockedPreviewCameraId,
  storyboard,
  ...props
}: Omit<ComponentProps<typeof CameraPictureInPictureOverlay>, "cameraShot"> & {
  activeCameraId: string | null;
  cameras: DirectorCameraShot[];
  lockedPreviewCameraId: string | null;
  storyboard: DirectorStoryboard | undefined;
}) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  const cameraShot = useMemo(() => {
    const cameraId = getStoryboardCameraIdAtFrame(storyboard, currentFrame, activeCameraId);
    const activeSource = cameras.find((camera) => camera.id === cameraId);
    return lockedPreviewCameraId
      ? (cameras.find((camera) => camera.id === lockedPreviewCameraId) ?? activeSource)
      : activeSource;
  }, [activeCameraId, cameras, currentFrame, lockedPreviewCameraId, storyboard]);
  return cameraShot ? <CameraPictureInPictureOverlay {...props} cameraShot={cameraShot} /> : null;
}

function StoryboardCameraPlaybackSync({ isPlaying }: { isPlaying: boolean }) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  const activeCameraId = useDirectorStore((state) => state.project.activeCameraId);
  const storyboard = useDirectorStore((state) => state.project.storyboard);
  const setActiveCamera = useDirectorStore((state) => state.setActiveCamera);

  useEffect(() => {
    if (!isPlaying) return;
    const nextCameraId = getStoryboardCameraIdAtFrame(storyboard, currentFrame, activeCameraId);
    if (nextCameraId && nextCameraId !== activeCameraId) setActiveCamera(nextCameraId);
  }, [activeCameraId, currentFrame, isPlaying, setActiveCamera, storyboard]);

  return null;
}

function LivePlayerModeHud({
  runtimeStatusStore,
  ...props
}: Omit<ComponentProps<typeof PlayerModeHud>, "runtimeStatus"> & {
  runtimeStatusStore: PlayerRuntimeStatusStore;
}) {
  const runtimeStatus = useSyncExternalStore(
    runtimeStatusStore.subscribe,
    runtimeStatusStore.getSnapshot,
    runtimeStatusStore.getSnapshot,
  );
  return <PlayerModeHud {...props} runtimeStatus={runtimeStatus} />;
}

function PlayerRuntimeCrosshair({ runtimeStatusStore }: { runtimeStatusStore: PlayerRuntimeStatusStore }) {
  const aiming = useSyncExternalStore(
    runtimeStatusStore.subscribe,
    () => runtimeStatusStore.getSnapshot()?.aiming === true,
    () => false,
  );
  return aiming ? <div aria-hidden="true" className="player-controller-crosshair" /> : null;
}

function LiveTimelineFrameCaptureBridge({
  captureFrame,
  finishRecording,
  lastRecordedFrameRef,
  recordingStatus,
}: {
  captureFrame: (frame: number) => Promise<void>;
  finishRecording: (stopPlayback: boolean) => Promise<void>;
  lastRecordedFrameRef: MutableRefObject<number | null>;
  recordingStatus: DirectorTimelineRecordingStatus;
}) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);

  useEffect(() => {
    if (recordingStatus !== "recording") return;
    if (lastRecordedFrameRef.current === currentFrame) return;
    lastRecordedFrameRef.current = currentFrame;
    void captureFrame(currentFrame).catch(() => {
      void finishRecording(true);
    });
  }, [captureFrame, currentFrame, finishRecording, lastRecordedFrameRef, recordingStatus]);

  return null;
}

export function isDirectorCaptureSceneReady({
  blenderLiveVisible,
  captureOnly,
  nativeProjectId,
  nativeScenePhase,
}: {
  blenderLiveVisible: boolean;
  captureOnly: boolean;
  nativeProjectId?: string;
  nativeScenePhase: BlenderSceneLayerPhase;
}) {
  return !captureOnly || !blenderLiveVisible || !nativeProjectId || nativeScenePhase === "ready";
}

export function DirectorCanvas({
  captureOnly = false,
  layout,
  onTimelineCollapsedChange,
  onTimelineHeightChange,
  onToggleFrameless,
  timelineVisible,
  blenderLiveVisible = true,
}: {
  captureOnly?: boolean;
  layout: DirectorWorkspaceLayout;
  onTimelineCollapsedChange: (collapsed: boolean) => void;
  onTimelineHeightChange: (height: number) => void;
  onToggleFrameless: () => void;
  timelineVisible: boolean;
  blenderLiveVisible?: boolean;
}) {
  const selectedPerformanceProfile = useSelectedPerformanceProfile();
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const updatePageVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", updatePageVisibility);
    return () => document.removeEventListener("visibilitychange", updatePageVisibility);
  }, []);
  const detectedPerformanceProfile = useMemo(
    () => resolveAutomaticPerformanceProfile(detectPerformanceCapabilities()),
    [],
  );
  const [automaticPerformanceProfile, setAutomaticPerformanceProfile] =
    useState<EffectivePerformanceProfileId>(detectedPerformanceProfile);
  const effectivePerformanceProfile =
    selectedPerformanceProfile === "auto" ? automaticPerformanceProfile : selectedPerformanceProfile;
  const performanceConfig = useResolvedPerformanceConfig();
  const viewMode = useDirectorStore((state) => state.viewMode);
  const openSceneInspector = useDirectorStore((state) => state.openSceneInspector);
  const sceneSettings = useDirectorStore((state) => state.project.scene);
  const assets = useDirectorStore((state) => state.project.assets);
  const objects = useDirectorStore((state) => state.project.objects);
  const cameras = useDirectorStore((state) => state.project.cameras);
  const lights = useDirectorStore((state) => state.project.lights ?? EMPTY_DIRECTOR_LIGHTS);
  const world = useDirectorStore((state) => state.project.world);
  const storyboard = useDirectorStore((state) => state.project.storyboard);
  const panoramaAssetId = useDirectorStore((state) => state.project.panoramaAssetId);
  const activeCameraId = useDirectorStore((state) => state.project.activeCameraId);
  const nativeProjectId = useDirectorStore((state) => state.project.nativeScene?.projectId);
  const [blenderCaptureState, setBlenderCaptureState] = useState<{
    projectId: string;
    status: BlenderSceneLayerStatus;
  } | null>(null);
  const handleBlenderSceneStatusChange = useCallback(
    (status: BlenderSceneLayerStatus) => {
      if (!captureOnly || !nativeProjectId) return;
      setBlenderCaptureState({ projectId: nativeProjectId, status });
    },
    [captureOnly, nativeProjectId],
  );
  const nativeSceneShadowRevision = useBlenderRuntimeStore((state) => {
    const snapshot = state.snapshot;
    return snapshot ? `${snapshot.projectId}:${snapshot.sceneEpoch}:${snapshot.revision}` : null;
  });
  const captureSceneReady = isDirectorCaptureSceneReady({
    blenderLiveVisible,
    captureOnly,
    nativeProjectId,
    nativeScenePhase:
      blenderCaptureState && blenderCaptureState.projectId === nativeProjectId
        ? blenderCaptureState.status.phase
        : "connecting",
  });
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const selectedObjectIds = useDirectorStore((state) => state.selectedObjectIds);
  const viewportLayout = useDirectorStore((state) => state.viewportLayout);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const smoothOrbitZoomActiveRef = useRef(false);
  const viewportRenderCameraRef = useRef<Camera | null>(null);
  const viewportThreeSceneRef = useRef<Object3D | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [initialDirectorViewSnapshot] = useState(() =>
    getInitialDirectorViewSnapshot(useDirectorStore.getState().project),
  );
  const viewportCameraSnapshotRef = useRef<CameraShotSnapshot>(initialDirectorViewSnapshot);
  const [directorViewSnapshot, setDirectorViewSnapshot] = useState(initialDirectorViewSnapshot);
  const [lockedPreviewCameraId, setLockedPreviewCameraId] = useState<string | null>(null);
  const [cameraPreviewMode, setCameraPreviewMode] = useState<DirectorCameraPreviewMode>("rgb");
  const [toolbarHeight, setToolbarHeight] = useState(DEFAULT_VIEWPORT_TOOLBAR_HEIGHT);
  const viewportChromeSuppressed = useViewportChromeSuppressed();
  const [blenderCollisionEnvironment, setBlenderCollisionEnvironment] = useState<PlayerStaticEnvironment | null>(null);
  const [collisionReferenceRoot, setCollisionReferenceRoot] = useState<Object3D | null>(null);
  const [currentFrame, setCurrentFrame] = useState(() => sceneSettings.timeline?.currentFrame ?? 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [navigationMode, setNavigationMode] = useState<"hand" | "cursor">("hand");
  const [activeQuadViewportId, setActiveQuadViewportId] = useState<DirectorQuadViewportId>("perspective");
  const [maximizedQuadViewportId, setMaximizedQuadViewportId] = useState<DirectorQuadViewportId | null>(null);
  const [quadViewportZooms, setQuadViewportZooms] = useState<DirectorQuadViewportZooms>({
    perspective: 1,
    top: 1,
    front: 1,
    right: 1,
  });
  const [cameraPilotMode, setCameraPilotMode] = useState(false);
  const [cameraPilotControlActive, setCameraPilotControlActive] = useState(false);
  const [cameraPilotTargetState, setCameraPilotTargetState] = useState<CameraPilotTargetState>({
    hoveredTargetId: null,
    lockedTargetId: null,
    lockedPoint: null,
  });
  const [cameraPilotRecordedCount, setCameraPilotRecordedCount] = useState(0);
  const [lassoSelectionEnabled, setLassoSelectionEnabled] = useState(false);
  const [lassoSelectionBox, setLassoSelectionBox] = useState<LassoScreenRect | null>(null);
  const lassoSelectionBoxRef = useRef<LassoScreenRect | null>(null);
  const lassoPointerIdRef = useRef<number | null>(null);
  const [assetDropActive, setAssetDropActive] = useState(false);
  const [assetDropPreview, setAssetDropPreview] = useState<
    (ModelLibraryDropPlacement & { pointerX: number; pointerY: number }) | null
  >(null);
  const assetDropActiveRef = useRef(false);
  const assetDropPreviewFrameRef = useRef<number | null>(null);
  const pendingAssetDropPreviewRef = useRef<
    (ModelLibraryDropPlacement & { pointerX: number; pointerY: number }) | null
  >(null);
  const dropSurfacesRef = useRef<Object3D[]>([]);
  const dropSurfacesSceneRef = useRef<Object3D | null>(null);
  const dropSurfacesSignatureRef = useRef("");
  const [playerMode, setPlayerMode] = useState(false);
  const [playerActorId, setPlayerActorId] = useState<string | null>(null);
  const [playerViewMode, setPlayerViewMode] = useState<PlayerViewMode>("third");
  const [playerFlying, setPlayerFlying] = useState(false);
  const [playerControlActive, setPlayerControlActive] = useState(false);
  const playerRuntimeStatusStore = useMemo(() => createPlayerRuntimeStatusStore(), []);
  const [playerModeRecording, setPlayerModeRecording] = useState(false);
  const [playerEmoteRequest, setPlayerEmoteRequest] = useState<{ clipId: string; nonce: number } | null>(null);
  const playerEmoteNonceRef = useRef(0);
  // Keyboard listeners are installed for the workspace lifetime. Keep their
  // actions current without re-binding listeners every render.
  const togglePlayerModeRecordingRef = useRef<() => void>(() => undefined);
  const playerRecordingStartRef = useRef<number | null>(null);
  const playerRecordingSessionRef = useRef<PlayerMotionRecordingSession | null>(null);
  const playerUndoBatchActiveRef = useRef(false);
  const [recordingSettings, setRecordingSettings] = useState<DirectorTimelineRecordingSettings>(() => {
    const initialTimeline = sceneSettings.timeline;
    return createTimelineRecordingSettings({
      frameStart: initialTimeline?.frameStart ?? 0,
      frameEnd: initialTimeline?.frameEnd ?? 0,
    });
  });
  const [recordingStatus, setRecordingStatus] = useState<DirectorTimelineRecordingStatus>("idle");
  const currentFrameRef = useRef(currentFrame);
  const publishPlayheadFrame = useCallback((frame: number) => {
    currentFrameRef.current = frame;
    useTimelineRuntimeStore.getState().setPlayheadFrame(frame);
  }, []);
  const publishPlayheadFrameAndRenderShell = useCallback(
    (frame: number) => {
      publishPlayheadFrame(frame);
      setCurrentFrame(frame);
    },
    [publishPlayheadFrame],
  );
  // A render-loop callback can already be queued when an export begins. Keep a
  // monotonic session id outside React so that callback cannot advance the
  // playhead after automatic IN/OUT export has reached its OUT frame.
  const playbackSessionRef = useRef(0);
  // Automatic IN/OUT export owns the transport. This is deliberately a ref,
  // not React state: host messages and queued animation callbacks must see the
  // OUT boundary immediately, before React schedules a render.
  const automaticExportEndFrameRef = useRef<number | null>(null);
  const deterministicExportControllerRef = useRef<AbortController | null>(null);
  const liveRecordingRef = useRef<LiveDirectorVideoRecorder | null>(null);
  const recordingStatusRef = useRef<DirectorTimelineRecordingStatus>(recordingStatus);
  const lastRecordedFrameRef = useRef<number | null>(null);
  const timeline = sceneSettings.timeline;
  const timelineFps = getDirectorTimelineFps(timeline);
  const effectiveCameraId = isPlaying
    ? activeCameraId
    : getStoryboardCameraIdAtFrame(storyboard, currentFrame, activeCameraId);
  const activeCameraSource = useMemo(
    () => cameras.find((item) => item.id === effectiveCameraId),
    [cameras, effectiveCameraId],
  );
  const previewCameraSource = useMemo(
    () =>
      lockedPreviewCameraId
        ? (cameras.find((item) => item.id === lockedPreviewCameraId) ?? activeCameraSource)
        : activeCameraSource,
    [activeCameraSource, cameras, lockedPreviewCameraId],
  );
  const handheldPreviewVisible =
    viewMode === "director" && viewportLayout === "single" && !playerMode && !cameraPilotMode && cameras.length > 0;
  const continuouslyAnimatedCamera =
    viewMode === "camera" ? activeCameraSource : handheldPreviewVisible ? previewCameraSource : undefined;
  const worldAmbientActive = isDirectorWorldAmbientActive(world);
  const stageFrameloop = getDirectorStageFrameloop(
    {
      cameraHandheldActive: Boolean(
        continuouslyAnimatedCamera?.handheldShake && continuouslyAnimatedCamera.handheldShake !== "off",
      ),
      cameraPilotMode,
      isPlaying,
      playerMode,
      recordingActive: recordingStatus !== "idle" && recordingStatus !== "paused",
      worldAmbientActive,
    },
    pageVisible,
  );
  const continuousShadowUpdates = shouldContinuouslyUpdateDirectorShadows({ isPlaying, playerMode, world });
  const dynamicShadowObjects = useMemo(
    () =>
      objects.filter(
        (item) =>
          item.kind === "character" ||
          Boolean(item.vehicle) ||
          (item.animation?.enabled !== false && Boolean(item.animation?.keyframes.length)),
      ),
    [objects],
  );
  const dynamicShadowObjectIds = useMemo(
    () => new Set(dynamicShadowObjects.map((item) => item.id)),
    [dynamicShadowObjects],
  );
  const staticShadowObjects = useMemo(
    () => objects.filter((item) => !dynamicShadowObjectIds.has(item.id)),
    [dynamicShadowObjectIds, objects],
  );
  const shadowSceneTransform = useMemo(
    () => ({
      clippingPlanes: sceneSettings.clippingPlanes,
      groundHeight: sceneSettings.groundHeight,
      position: sceneSettings.position,
      rotation: sceneSettings.rotation,
      scale: sceneSettings.scale,
      showGround: sceneSettings.showGround,
    }),
    [
      sceneSettings.clippingPlanes,
      sceneSettings.groundHeight,
      sceneSettings.position,
      sceneSettings.rotation,
      sceneSettings.scale,
      sceneSettings.showGround,
    ],
  );
  const staticShadowInvalidationToken = useMemo(
    () => ({
      assets,
      lights,
      nativeSceneRevision:
        blenderLiveVisible && nativeProjectId ? `${nativeProjectId}:${nativeSceneShadowRevision ?? "loading"}` : null,
      objects: staticShadowObjects,
      scene: shadowSceneTransform,
      shadowMapSize: performanceConfig.shadowMapSize,
    }),
    [
      assets,
      lights,
      nativeProjectId,
      nativeSceneShadowRevision,
      performanceConfig.shadowMapSize,
      shadowSceneTransform,
      staticShadowObjects,
      blenderLiveVisible,
    ],
  );
  const dynamicShadowInvalidationToken = useMemo(
    () => ({
      assets,
      frame: continuousShadowUpdates ? null : currentFrame,
      lights,
      objects: dynamicShadowObjects,
      scene: shadowSceneTransform,
      shadowMapSize: performanceConfig.shadowMapSize,
      world,
    }),
    [
      assets,
      continuousShadowUpdates,
      currentFrame,
      dynamicShadowObjects,
      lights,
      performanceConfig.shadowMapSize,
      shadowSceneTransform,
      world,
    ],
  );
  // Deterministic export and recording sessions must observe a frozen ambient
  // world clock from the first prepared frame until the transport restore.
  // `exporting` spans video export, deterministic/multimodal frame export,
  // and live recording sessions (including their paused gaps); the
  // per-capture hold in CanvasCaptureBridge covers one-off screenshots.
  useEffect(() => {
    let sessionHeld = false;
    const syncWorldClockSuspension = (exporting: boolean) => {
      if (exporting === sessionHeld) return;
      sessionHeld = exporting;
      setWorldAmbientClockSuspended(exporting);
    };
    syncWorldClockSuspension(useTimelineRuntimeStore.getState().exporting);
    const unsubscribe = useTimelineRuntimeStore.subscribe((state) => syncWorldClockSuspension(state.exporting));
    return () => {
      unsubscribe();
      syncWorldClockSuspension(false);
    };
  }, []);
  const hasPanorama = Boolean(panoramaAssetId);
  const panoramaAsset = useMemo(() => assets.find((item) => item.id === panoramaAssetId), [assets, panoramaAssetId]);
  const showViewportGrid = shouldRenderViewportGrid(hasPanorama, sceneSettings.snapToGrid);
  const viewportGridFadeDistance = useMemo(() => {
    const [px, py, pz] = directorViewSnapshot.position;
    const [tx, ty, tz] = directorViewSnapshot.target;
    return getViewportGridFadeDistance(Math.hypot(px - tx, py - ty, pz - tz));
  }, [directorViewSnapshot.position, directorViewSnapshot.target]);
  useEffect(() => {
    const nextProfile = selectedPerformanceProfile === "auto" ? detectedPerformanceProfile : selectedPerformanceProfile;
    setAutomaticPerformanceProfile(nextProfile);
    resetAutomaticPerformanceProfile(nextProfile);
  }, [detectedPerformanceProfile, selectedPerformanceProfile]);
  const togglePictureInPictureLock = useCallback(() => {
    const sourceId = getStoryboardCameraIdAtFrame(
      storyboard,
      useTimelineRuntimeStore.getState().playheadFrame,
      activeCameraId,
    );
    setLockedPreviewCameraId((current) => (current ? null : sourceId));
  }, [activeCameraId, storyboard]);
  const playerCandidates = useMemo(
    () => objects.filter((item) => item.kind === "character" && item.visible && !item.locked && !item.crowdId),
    [objects],
  );
  const physicallyResolvedFrameObjects = useMemo(
    () =>
      resolveDirectorPhysicalPlacements(
        objects.map((item) => evaluateDirectorObjectAtFrame(item, currentFrame, timelineFps)),
        sceneSettings.groundHeight,
        sceneSettings.showGround,
      ),
    [currentFrame, objects, sceneSettings.groundHeight, sceneSettings.showGround, timelineFps],
  );
  const activePlayer = useMemo(() => {
    if (!playerActorId || !playerCandidates.some((item) => item.id === playerActorId)) return null;
    return physicallyResolvedFrameObjects.find((item) => item.id === playerActorId) ?? null;
  }, [physicallyResolvedFrameObjects, playerActorId, playerCandidates]);
  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const playerObstacles = useMemo<PlayerObstacle[]>(() => {
    if (!playerMode) return [];
    return physicallyResolvedFrameObjects
      .filter((item) => item.id !== playerActorId && item.visible && item.kind !== "camera" && item.kind !== "panorama")
      .map((item) => createDirectorPlayerObstacle(item, item.assetRefId ? assetsById.get(item.assetRefId) : undefined));
  }, [assetsById, physicallyResolvedFrameObjects, playerActorId, playerMode]);
  const roamGroundEnabled = resolvePlayerRoamGroundEnabled({
    showGround: sceneSettings.showGround,
    hasWalkableMeshEnvironment: hasWalkableMeshPlayerEnvironment(
      playerObstacles,
      blenderCollisionEnvironment?.meshes.length ?? 0,
    ),
  });
  const playerInteractionCandidates = useMemo<PlayerInteractionCandidate[]>(() => {
    if (!playerMode) return [];
    return physicallyResolvedFrameObjects.flatMap((item) => {
      if (!item.visible || !item.interaction) return [];
      const isOpen = JSON.stringify(item.transform) === JSON.stringify(item.interaction.openTransform);
      return [
        {
          id: item.id,
          position: [...item.transform.position] as [number, number, number],
          prompt: `${isOpen ? "关闭" : "打开"}${item.interaction.prompt}`,
          radiusM: item.interaction.radiusM,
        },
      ];
    });
  }, [physicallyResolvedFrameObjects, playerMode]);
  const lassoObjects = useMemo(
    () =>
      lassoSelectionEnabled
        ? objects.map((item) => evaluateDirectorObjectAtFrame(item, currentFrame, timelineFps))
        : objects,
    [currentFrame, lassoSelectionEnabled, objects, timelineFps],
  );
  const viewportAspectRatio = useDirectorStore((state) => state.viewportAspectRatio);
  const viewportRotateSensitivity = useDirectorStore((state) => state.viewportRotateSensitivity);
  const viewportZoomSensitivity = useDirectorStore((state) => state.viewportZoomSensitivity);
  const viewportMoveSpeed = useDirectorStore((state) => state.viewportMoveSpeed);
  const viewportCharacterMoveSpeed = useDirectorStore((state) => state.viewportCharacterMoveSpeed);
  const viewportPilotInertia = useDirectorStore((state) => state.viewportPilotInertia);
  const viewportPilotLookSmoothing = useDirectorStore((state) => state.viewportPilotLookSmoothing);
  const viewportPilotBankStrength = useDirectorStore((state) => state.viewportPilotBankStrength);
  const setViewMode = useDirectorStore((state) => state.setViewMode);
  const beginUndoBatch = useDirectorStore((state) => state.beginUndoBatch);
  const endUndoBatch = useDirectorStore((state) => state.endUndoBatch);
  const updateScene = useDirectorStore((state) => state.updateScene);
  const updateObjectTransform = useDirectorStore((state) => state.updateObjectTransform);
  const toggleObjectInteraction = useDirectorStore((state) => state.toggleObjectInteraction);
  const addImportedAsset = useDirectorStore((state) => state.addImportedAsset);
  const addObjectFromAsset = useDirectorStore((state) => state.addObjectFromAsset);
  const addPresetCharacter = useDirectorStore((state) => state.addPresetCharacter);
  const addGeometryPrimitive = useDirectorStore((state) => state.addGeometryPrimitive);
  const addCameraShot = useDirectorStore((state) => state.addCameraShot);
  const selectObjects = useDirectorStore((state) => state.selectObjects);
  const selectCrowd = useDirectorStore((state) => state.selectCrowd);
  const setObjectAnimation = useDirectorStore((state) => state.setObjectAnimation);
  const setCameraAnimation = useDirectorStore((state) => state.setCameraAnimation);
  const updateCamera = useDirectorStore((state) => state.updateCamera);
  const viewportSafeAreaInsets: ViewportSafeAreaInsets = {
    // The workspace puts the side panels in their own grid tracks, so the
    // canvas never sits underneath them. Keep capture and picture framing in
    // the real viewport rather than shrinking it again for overlay insets.
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  };
  const gizmoRightOffset = GIZMO_EDGE_PADDING;
  const effectiveTimelineEndFrame = useMemo(
    () => getEffectiveTimelineEndFrame({ cameras, objects, scene: sceneSettings }),
    [cameras, objects, sceneSettings],
  );
  const timelineExporting = useTimelineRuntimeStore((state) => state.exporting);
  useStageTimelineAudioRehearsal({
    enabled: !timelineExporting,
    isPlaying,
    timeline,
    endFrame: Math.max(timeline?.frameStart ?? 0, effectiveTimelineEndFrame),
  });
  const cameraPilotObjectKey = useMemo(
    () =>
      objects
        .filter((object) => isCameraFocusableObject(object))
        .map((object) => object.id)
        .join("\u0000"),
    [objects],
  );
  const cameraPilotHoveredName =
    objects.find((object) => object.id === cameraPilotTargetState.hoveredTargetId)?.name ?? null;
  const cameraPilotLockedName =
    objects.find((object) => object.id === cameraPilotTargetState.lockedTargetId)?.name ?? null;
  const quadViewFraming = useMemo(
    () => getDirectorQuadViewFraming(physicallyResolvedFrameObjects, sceneSettings.groundHeight, sceneSettings),
    [physicallyResolvedFrameObjects, sceneSettings],
  );
  const activateQuadViewport = useCallback((paneId: DirectorQuadViewportId) => {
    setActiveQuadViewportId(paneId);
  }, []);
  const resetQuadViewport = useCallback((paneId: DirectorQuadViewportId) => {
    setQuadViewportZooms((current) => (current[paneId] === 1 ? current : { ...current, [paneId]: 1 }));
  }, []);
  const toggleMaximizedQuadViewport = useCallback((paneId: DirectorQuadViewportId) => {
    setMaximizedQuadViewportId((current) => (current === paneId ? null : paneId));
  }, []);
  const zoomQuadViewport = useCallback((paneId: DirectorQuadViewportId, deltaY: number) => {
    setQuadViewportZooms((current) => {
      const nextZoom = getNextDirectorQuadViewportZoom(current[paneId], deltaY);
      return nextZoom === current[paneId] ? current : { ...current, [paneId]: nextZoom };
    });
  }, []);

  useLayoutEffect(() => {
    publishPlayheadFrame(currentFrame);
  }, [currentFrame, publishPlayheadFrame]);

  useLayoutEffect(() => {
    recordingStatusRef.current = recordingStatus;
  }, [recordingStatus]);

  useEffect(
    () =>
      setDirectorPageViewportHandler((snapshot) => {
        if (playerMode || cameraPilotMode) return;
        setViewMode("director");
        viewportCameraSnapshotRef.current = snapshot;
        setDirectorViewSnapshot((currentSnapshot) =>
          areCameraSnapshotsClose(currentSnapshot, snapshot) ? currentSnapshot : snapshot,
        );
      }),
    [cameraPilotMode, playerMode, setViewMode],
  );

  useEffect(() => {
    if (playerMode && !activePlayer) {
      setPlayerControlActive(false);
      setPlayerMode(false);
    }
  }, [activePlayer, playerMode]);

  useEffect(() => {
    if (!playerMode) return;
    setLassoSelectionEnabled(false);
    lassoSelectionBoxRef.current = null;
    setLassoSelectionBox(null);
  }, [playerMode]);

  useEffect(() => {
    if (!isPlaying) return;
    setLassoSelectionEnabled(false);
    lassoPointerIdRef.current = null;
    lassoSelectionBoxRef.current = null;
    setLassoSelectionBox(null);
  }, [isPlaying]);

  useEffect(() => {
    if (!lassoSelectionEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setLassoSelectionEnabled(false);
      lassoPointerIdRef.current = null;
      lassoSelectionBoxRef.current = null;
      setLassoSelectionBox(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lassoSelectionEnabled]);

  useEffect(() => {
    if (viewportLayout !== "quad") return;
    setLassoSelectionEnabled(false);
    lassoSelectionBoxRef.current = null;
    setLassoSelectionBox(null);
    if (cameraPilotMode) {
      setCameraPilotMode(false);
      setCameraPilotTargetState({ hoveredTargetId: null, lockedTargetId: null, lockedPoint: null });
    }
    if (playerMode) setPlayerMode(false);
  }, [cameraPilotMode, playerMode, viewportLayout]);

  useEffect(() => {
    if (viewportLayout === "quad") return;
    setMaximizedQuadViewportId(null);
  }, [viewportLayout]);

  useEffect(() => {
    if (viewportLayout !== "quad" || !maximizedQuadViewportId) return;
    const restoreQuadView = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMaximizedQuadViewportId(null);
    };
    window.addEventListener("keydown", restoreQuadView);
    return () => window.removeEventListener("keydown", restoreQuadView);
  }, [maximizedQuadViewportId, viewportLayout]);

  useEffect(() => {
    dropSurfacesRef.current = [];
    dropSurfacesSceneRef.current = null;
    dropSurfacesSignatureRef.current = "";
  }, [objects]);

  useEffect(() => {
    const clearAssetDropState = () => {
      assetDropActiveRef.current = false;
      pendingAssetDropPreviewRef.current = null;
      if (assetDropPreviewFrameRef.current !== null) {
        window.cancelAnimationFrame(assetDropPreviewFrameRef.current);
        assetDropPreviewFrameRef.current = null;
      }
      setAssetDropActive(false);
      setAssetDropPreview(null);
    };
    window.addEventListener("dragend", clearAssetDropState);
    window.addEventListener("drop", clearAssetDropState);
    window.addEventListener("blur", clearAssetDropState);
    return () => {
      window.removeEventListener("dragend", clearAssetDropState);
      window.removeEventListener("drop", clearAssetDropState);
      window.removeEventListener("blur", clearAssetDropState);
    };
  }, []);

  useEffect(() => {
    if (lockedPreviewCameraId && !cameras.some((camera) => camera.id === lockedPreviewCameraId)) {
      setLockedPreviewCameraId(null);
    }
  }, [cameras, lockedPreviewCameraId]);

  useEffect(
    () =>
      setDirectorPagePlaybackHandler((state) => {
        const liveTimeline = useDirectorStore.getState().project.scene.timeline;
        if (Number.isSafeInteger(state.currentFrame)) {
          const requestedFrame = state.currentFrame as number;
          const nextFrame = liveTimeline
            ? Math.min(liveTimeline.frameEnd, Math.max(liveTimeline.frameStart, requestedFrame))
            : 0;
          const boundedFrame = clampFrameToAutomaticExportBoundary(nextFrame);
          publishPlayheadFrameAndRenderShell(boundedFrame);
        }
        if (typeof state.playing === "boolean") {
          if (!state.playing) publishPlayheadFrameAndRenderShell(currentFrameRef.current);
          setIsPlaying(automaticExportEndFrameRef.current === null && Boolean(liveTimeline) && state.playing);
        }
      }),
    [publishPlayheadFrameAndRenderShell],
  );

  useEffect(() => {
    if (!timeline) {
      setIsPlaying(false);
      publishPlayheadFrameAndRenderShell(0);
      return;
    }

    const nextFrame = clampFrameToAutomaticExportBoundary(
      Math.min(timeline.frameEnd, Math.max(timeline.frameStart, timeline.currentFrame)),
    );
    publishPlayheadFrameAndRenderShell(nextFrame);
    setIsPlaying(false);
  }, [publishPlayheadFrameAndRenderShell, timeline]);

  useEffect(() => {
    if (!timeline) return;
    const frameEnd = Math.max(timeline.frameStart, effectiveTimelineEndFrame);
    setRecordingSettings((current) =>
      normalizeTimelineRecordingSettings(current, {
        frameStart: timeline.frameStart,
        frameEnd,
      }),
    );
  }, [effectiveTimelineEndFrame, timeline]);

  const setLiveRecordingStatus = useCallback((nextStatus: DirectorTimelineRecordingStatus) => {
    recordingStatusRef.current = nextStatus;
    setRecordingStatus(nextStatus);
  }, []);

  function stopTimelinePlaybackSynchronously() {
    playbackSessionRef.current += 1;
    flushSync(() => {
      publishPlayheadFrameAndRenderShell(currentFrameRef.current);
      setIsPlaying(false);
    });
  }

  function clampFrameToAutomaticExportBoundary(frame: number) {
    const exportEndFrame = automaticExportEndFrameRef.current;
    return exportEndFrame === null ? frame : Math.min(frame, exportEndFrame);
  }

  function lockTimelineAtAutomaticExportOutFrame(frameEnd: number) {
    playbackSessionRef.current += 1;
    flushSync(() => {
      publishPlayheadFrameAndRenderShell(frameEnd);
      setIsPlaying(false);
    });
  }

  const finishLiveTimelineRecording = useCallback(
    async (stopPlayback: boolean) => {
      const liveRecording = liveRecordingRef.current;
      if (!liveRecording || recordingStatusRef.current === "finalizing") return;
      setLiveRecordingStatus("finalizing");
      if (stopPlayback) {
        publishPlayheadFrameAndRenderShell(currentFrameRef.current);
        setIsPlaying(false);
      }
      try {
        const recording = await liveRecording.stop();
        useVideoRecordingStore.getState().addRecording(recording);
      } catch {
        /* Recording failures stop the capture session without a timeline overlay. */
      } finally {
        liveRecordingRef.current = null;
        lastRecordedFrameRef.current = null;
        useTimelineRuntimeStore.getState().setHelpersHidden(false);
        useTimelineRuntimeStore.getState().setExporting(false);
        setLiveRecordingStatus("idle");
      }
    },
    [publishPlayheadFrameAndRenderShell, setLiveRecordingStatus],
  );

  const pauseLiveTimelineRecording = useCallback(
    (pausePlayback = true) => {
      if (recordingStatusRef.current !== "recording") return;
      liveRecordingRef.current?.pause();
      setLiveRecordingStatus("paused");
      if (pausePlayback) {
        publishPlayheadFrameAndRenderShell(currentFrameRef.current);
        setIsPlaying(false);
      }
    },
    [publishPlayheadFrameAndRenderShell, setLiveRecordingStatus],
  );

  function resumeLiveTimelineRecording() {
    if (recordingStatusRef.current !== "paused") return;
    liveRecordingRef.current?.resume();
    setLiveRecordingStatus("recording");
    setIsPlaying(true);
  }

  function startLiveTimelineRecording() {
    if (!timeline) return;
    if (recordingStatusRef.current === "paused") {
      resumeLiveTimelineRecording();
      return;
    }
    if (recordingStatusRef.current !== "idle") return;
    const runtime = useTimelineRuntimeStore.getState();
    if (runtime.exporting) {
      return;
    }
    setLiveRecordingStatus("preparing");
    void import("../video/directorVideoExport")
      .then(({ createLiveDirectorVideoRecorder }) => {
        if (recordingStatusRef.current !== "preparing") return;
        try {
          const liveRecording = createLiveDirectorVideoRecorder({
            fps: timelineFps,
            format: recordingSettings.format,
          });
          liveRecordingRef.current = liveRecording;
          lastRecordedFrameRef.current = null;
          useTimelineRuntimeStore.getState().setExporting(true);
          useTimelineRuntimeStore.getState().setHelpersHidden(true);
          setLiveRecordingStatus("recording");

          const requestedFrame = recordingSettings.manualStart;
          publishPlayheadFrameAndRenderShell(requestedFrame);
          setIsPlaying(true);
        } catch {
          liveRecordingRef.current = null;
          useTimelineRuntimeStore.getState().setHelpersHidden(false);
          useTimelineRuntimeStore.getState().setExporting(false);
          setLiveRecordingStatus("idle");
        }
      })
      .catch(() => {
        setLiveRecordingStatus("idle");
      });
  }

  const captureLiveTimelineFrame = useCallback(
    async (frame: number) => {
      const liveRecording = liveRecordingRef.current;
      if (!liveRecording) return;
      const fallbackCameraId = activeCameraId;
      const renderCameraId = getStoryboardCameraIdAtFrame(storyboard, frame, fallbackCameraId);
      if (!renderCameraId) throw new Error("当前帧没有可用于渲染记录的机位");
      const [capture] = await requestViewportCapture({
        preset: "current",
        source: "capture-panel",
        cameraId: renderCameraId,
        cleanPlate: true,
        renderPass: "clean",
      });
      if (!capture?.dataUrl.startsWith("data:image/png")) {
        throw new Error(`第 ${frame} 帧没有返回真实 PNG`);
      }
      if (liveRecordingRef.current === liveRecording && recordingStatusRef.current === "recording") {
        await liveRecording.appendFrame(capture.dataUrl, frame);
      }
    },
    [activeCameraId, storyboard],
  );

  function handleRecordingControl(action: DirectorTimelineRecordingAction) {
    if (action === "start") {
      startLiveTimelineRecording();
    } else if (action === "resume") {
      resumeLiveTimelineRecording();
    } else if (action === "pause") {
      pauseLiveTimelineRecording();
    } else {
      void finishLiveTimelineRecording(true);
    }
  }

  function updateTimelineRecordingSettings(nextSettings: DirectorTimelineRecordingSettings) {
    if (!timeline) return;
    setRecordingSettings(
      normalizeTimelineRecordingSettings(nextSettings, {
        frameStart: timeline.frameStart,
        frameEnd: Math.max(timeline.frameStart, effectiveTimelineEndFrame),
      }),
    );
  }

  useEffect(() => {
    if (!isPlaying || !timeline) return;

    const automaticExportEndFrame = automaticExportEndFrameRef.current;
    if (automaticExportEndFrame !== null) {
      publishPlayheadFrameAndRenderShell(automaticExportEndFrame);
      setIsPlaying(false);
      return;
    }

    const playbackSession = playbackSessionRef.current + 1;
    playbackSessionRef.current = playbackSession;

    const effectiveEnd = Math.max(timeline.frameStart, effectiveTimelineEndFrame);
    const playbackEndFrame = effectiveEnd;
    const playbackTimeline =
      playbackEndFrame === timeline.frameEnd ? timeline : { ...timeline, frameEnd: playbackEndFrame };
    const playbackStartFrame = Math.min(playbackEndFrame, Math.max(timeline.frameStart, currentFrameRef.current));
    let playbackStartTime: number | null = null;
    let animationFrameId = 0;

    const tick = (time: number) => {
      if (playbackSessionRef.current !== playbackSession) return;
      const automaticExportEndFrame = automaticExportEndFrameRef.current;
      if (automaticExportEndFrame !== null) {
        publishPlayheadFrameAndRenderShell(automaticExportEndFrame);
        setIsPlaying(false);
        return;
      }
      playbackStartTime ??= time;
      const sample = getDirectorTimelineFrameAtElapsedTime(
        playbackTimeline,
        playbackStartFrame,
        time - playbackStartTime,
      );

      if (sample.ended) {
        playbackSessionRef.current += 1;
        publishPlayheadFrameAndRenderShell(sample.frame);
        if (recordingStatusRef.current === "recording") {
          pauseLiveTimelineRecording(false);
        }
        setIsPlaying(false);
        return;
      }

      if (sample.frame !== currentFrameRef.current) {
        publishPlayheadFrame(sample.frame);
      }
      if (playbackSessionRef.current === playbackSession) {
        animationFrameId = window.requestAnimationFrame(tick);
      }
    };

    animationFrameId = window.requestAnimationFrame(tick);
    return () => {
      if (playbackSessionRef.current === playbackSession) {
        playbackSessionRef.current += 1;
      }
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [
    effectiveTimelineEndFrame,
    isPlaying,
    pauseLiveTimelineRecording,
    publishPlayheadFrame,
    publishPlayheadFrameAndRenderShell,
    timeline,
  ]);

  function setPlaybackFrame(frame: number) {
    if (!timeline) return;

    const nextFrame = clampFrameToAutomaticExportBoundary(
      Math.min(timeline.frameEnd, Math.max(timeline.frameStart, Math.round(frame))),
    );
    pauseLiveTimelineRecording(false);
    publishPlayheadFrameAndRenderShell(nextFrame);
    setIsPlaying(false);
  }

  function commitPlaybackFrame(frame: number) {
    const liveTimeline = useDirectorStore.getState().project.scene.timeline;
    if (!liveTimeline) return;
    updateScene({
      timeline: {
        ...liveTimeline,
        currentFrame: Math.min(liveTimeline.frameEnd, Math.max(liveTimeline.frameStart, Math.round(frame))),
      },
    });
  }

  const prepareCaptureFrame = useCallback(
    (requestedFrame: number) => {
      if (!Number.isSafeInteger(requestedFrame) || requestedFrame < 0) {
        throw new Error("Capture frame must be a non-negative integer");
      }
      if (timeline) {
        if (requestedFrame < timeline.frameStart || requestedFrame > timeline.frameEnd) {
          throw new Error("Capture frame is outside the scene timeline");
        }
      } else if (requestedFrame !== 0) {
        throw new Error("Capture frame must be 0 when the scene has no timeline");
      }
      const automaticExportEndFrame = automaticExportEndFrameRef.current;
      if (automaticExportEndFrame !== null && requestedFrame > automaticExportEndFrame) {
        throw new Error("自动导出不能越过 OUT 帧");
      }

      flushSync(() => {
        playbackSessionRef.current += 1;
        publishPlayheadFrameAndRenderShell(requestedFrame);
        setIsPlaying(false);
      });
      return requestedFrame;
    },
    [publishPlayheadFrameAndRenderShell, timeline],
  );

  function togglePlayback() {
    if (!timeline) return;

    const automaticExportEndFrame = automaticExportEndFrameRef.current;
    if (automaticExportEndFrame !== null) {
      lockTimelineAtAutomaticExportOutFrame(automaticExportEndFrame);
      return;
    }

    if (isPlaying) {
      pauseLiveTimelineRecording();
      if (recordingStatusRef.current !== "paused") {
        publishPlayheadFrameAndRenderShell(currentFrameRef.current);
        setIsPlaying(false);
      }
      return;
    }

    if (recordingStatusRef.current === "paused") {
      resumeLiveTimelineRecording();
      return;
    }

    const effectiveEnd = Math.max(timeline.frameStart, effectiveTimelineEndFrame);
    const playbackEndFrame = effectiveEnd;
    if (!timeline.loop && currentFrameRef.current >= playbackEndFrame) {
      publishPlayheadFrameAndRenderShell(timeline.frameStart);
    }
    setIsPlaying(true);
  }

  async function exportTimelineVideo(
    format: DirectorVideoFormat,
    requestedFrameStart: number,
    requestedFrameEnd: number,
    onProgress: (progress: number, frame: number) => void,
  ): Promise<DirectorTimelineExportResult> {
    if (!timeline) throw new Error("当前场景没有可导出的时间轴");
    const runtime = useTimelineRuntimeStore.getState();
    if (runtime.exporting) throw new Error("已有视频导出正在进行");

    if (!activeCameraSource?.id) throw new Error("当前场景没有可用于渲染记录的活动机位");
    const maximumFrame = Math.max(timeline.frameStart, effectiveTimelineEndFrame);
    const frameStart = Math.min(maximumFrame, Math.max(timeline.frameStart, Math.round(requestedFrameStart)));
    const frameEnd = Math.min(maximumFrame, Math.max(frameStart, Math.round(requestedFrameEnd)));
    const fallbackCameraId = activeCameraSource.id;
    const exportAspectRatio = activeCameraSource.aspectRatio ?? "16:9";
    automaticExportEndFrameRef.current = frameEnd;
    let completed = false;

    try {
      const result = await runWithTimelineExportRestore(
        {
          readSnapshot: () => ({
            frame: currentFrameRef.current,
            isPlaying,
            helpersHidden: runtime.helpersHidden,
          }),
          setExporting: (exporting) => useTimelineRuntimeStore.getState().setExporting(exporting),
          setHelpersHidden: (hidden) => useTimelineRuntimeStore.getState().setHelpersHidden(hidden),
          setPlaying: (playing) => {
            if (playing) {
              flushSync(() => setIsPlaying(true));
              return;
            }
            stopTimelinePlaybackSynchronously();
          },
          restorePlayback: (frame, playing) => {
            flushSync(() => {
              playbackSessionRef.current += 1;
              publishPlayheadFrameAndRenderShell(frame);
              setIsPlaying(playing);
            });
          },
        },
        async () => {
          const { recordDirectorVideo } = await import("../video/directorVideoExport");
          const { createDirectorStageAudioSource, getStageTimelineAudioWindow } =
            await import("../audio/stageTimelineAudio");
          const { resolveStageAudioClipSourceUrl } = await import("../audio/stageAudioMediaResolver");
          // Stage audio covers exactly the exported IN/OUT window: clip
          // portions overlapping [frameStart, frameEnd] scheduled relative to
          // the IN frame, so the mixed track lines up with the first video
          // sample regardless of where the clips sit on the timeline.
          const audioEntries = getStageTimelineAudioWindow(
            useDirectorStore.getState().project.scene.timeline?.audioTracks ?? [],
            { frameStart, frameEnd, fps: timelineFps, resolveSourceUrl: resolveStageAudioClipSourceUrl },
          );
          const stageAudioSource = await createDirectorStageAudioSource(audioEntries);
          try {
            const recording = await recordDirectorVideo({
              frameStart,
              frameEnd,
              fps: timelineFps,
              format,
              onProgress: (progress, frame) => onProgress(progress, Math.min(frame, frameEnd)),
              ...(stageAudioSource?.stream
                ? {
                    audioSource: {
                      stream: stageAudioSource.stream,
                      start: stageAudioSource.start,
                      stop: stageAudioSource.stop,
                    },
                  }
                : {}),
              captureFrame: async (frame) => {
                if (frame > frameEnd) {
                  throw new Error("自动导出不能越过 OUT 帧");
                }
                const renderCameraId = getStoryboardCameraIdAtFrame(storyboard, frame, fallbackCameraId);
                if (!renderCameraId) throw new Error("当前帧没有可用于渲染记录的机位");
                const [capture] = await requestViewportCapture({
                  ...createDirectorVideoFrameCaptureRequest(renderCameraId, frame, exportAspectRatio),
                  renderPass: "clean",
                });
                if (!capture?.dataUrl.startsWith("data:image/png")) {
                  throw new Error(`第 ${frame} 帧没有返回真实 PNG`);
                }
                return capture.dataUrl;
              },
            });
            const libraryItem = useVideoRecordingStore.getState().addRecording(recording);
            return {
              extension: recording.extension,
              frameStart: recording.frameStart,
              frameEnd: recording.frameEnd,
              name: libraryItem.name,
              ...(recording.fallbackFrom ? { fallbackFrom: recording.fallbackFrom } : {}),
            };
          } finally {
            // recordDirectorVideo stops the source on its own paths, but the
            // capture loop can throw before the recorder exists; stop() is
            // idempotent so this cannot double-close the AudioContext.
            await stageAudioSource?.stop();
          }
        },
        {
          playbackAfterSuccess: (result) => ({
            frame: result.frameEnd,
            isPlaying: false,
          }),
        },
      );
      completed = true;
      return result;
    } finally {
      if (completed) {
        // Keep the transport pinned at OUT even after MediaRecorder resolves.
        // This is intentionally separate from the lifecycle restore so a late
        // host message or animation callback cannot restart the full timeline.
        lockTimelineAtAutomaticExportOutFrame(frameEnd);
      }
      automaticExportEndFrameRef.current = null;
    }
  }

  async function exportTimelineDeterministicFrames(
    requestedFrameStart: number,
    requestedFrameEnd: number,
    onProgress: (progress: number, frame: number, phase: "capture" | "encode" | "package") => void,
    options?: { background?: DirectorCaptureBackgroundMode },
  ): Promise<DirectorTimelineExportResult> {
    if (!timeline) throw new Error("当前场景没有可导出的时间轴");
    const runtime = useTimelineRuntimeStore.getState();
    if (runtime.exporting) throw new Error("已有导出任务正在进行");
    if (!activeCameraSource?.id) throw new Error("当前场景没有可用于逐帧渲染的活动机位");

    const background: DirectorCaptureBackgroundMode =
      options?.background === "transparent" ? "transparent" : "composited";
    const maximumFrame = Math.max(timeline.frameStart, effectiveTimelineEndFrame);
    const frameStart = Math.min(maximumFrame, Math.max(timeline.frameStart, Math.round(requestedFrameStart)));
    const frameEnd = Math.min(maximumFrame, Math.max(frameStart, Math.round(requestedFrameEnd)));
    const fallbackCameraId = activeCameraSource.id;
    const exportAspectRatio = activeCameraSource.aspectRatio ?? "16:9";
    automaticExportEndFrameRef.current = frameEnd;
    const exportController = new AbortController();
    deterministicExportControllerRef.current = exportController;
    let completed = false;

    try {
      const result = await runWithTimelineExportRestore(
        {
          readSnapshot: () => ({
            frame: currentFrameRef.current,
            isPlaying,
            helpersHidden: runtime.helpersHidden,
          }),
          setExporting: (exporting) => useTimelineRuntimeStore.getState().setExporting(exporting),
          setHelpersHidden: (hidden) => useTimelineRuntimeStore.getState().setHelpersHidden(hidden),
          setPlaying: (playing) => {
            if (playing) {
              flushSync(() => setIsPlaying(true));
              return;
            }
            stopTimelinePlaybackSynchronously();
          },
          restorePlayback: (frame, playing) => {
            flushSync(() => {
              playbackSessionRef.current += 1;
              publishPlayheadFrameAndRenderShell(frame);
              setIsPlaying(playing);
            });
          },
        },
        async () => {
          // The deterministic frame package is intentionally video-only: its
          // contract is reproducible per-frame PNG bytes with a fingerprint,
          // and a mixed audio bounce is a realtime artifact that would break
          // that determinism. Stage audio ships in the realtime export above.
          const { downloadDirectorDeterministicExport, exportDeterministicDirectorFrames } =
            await import("../video/directorVideoExport");
          const exported = await exportDeterministicDirectorFrames({
            frameStart,
            frameEnd,
            sourceFps: timelineFps,
            outputFps: timelineFps,
            background,
            signal: exportController.signal,
            onProgress: (progress) =>
              onProgress(
                progress.progress,
                Math.min(progress.sample?.sourceFrame ?? frameEnd, frameEnd),
                progress.phase,
              ),
            captureFrame: async (frame, _sample, signal) => {
              const renderCameraId = getStoryboardCameraIdAtFrame(storyboard, frame, fallbackCameraId);
              if (!renderCameraId) throw new Error(`第 ${frame} 帧没有可用于渲染的机位`);
              const [capture] = await requestViewportCapture({
                ...createDirectorVideoFrameCaptureRequest(renderCameraId, frame, exportAspectRatio),
                renderPass: "clean",
                // The composited default must stay byte-identical, so the
                // request only names a background when transparency is on.
                ...(background === "transparent" ? { background } : {}),
                signal,
              });
              if (!capture?.dataUrl.startsWith("data:image/png")) {
                throw new Error(`第 ${frame} 帧没有返回真实 PNG`);
              }
              return capture.dataUrl;
            },
          });
          const baseName = `director-${activeCameraSource.name || "scene"}-deterministic`;
          downloadDirectorDeterministicExport(exported, baseName);
          return {
            extension: exported.extension,
            frameStart: exported.manifest.sourceFrameStart,
            frameEnd: exported.manifest.sourceFrameEnd,
            frameCount: exported.manifest.outputFrameCount,
            kind: exported.kind,
            name: exported.kind === "png-sequence" ? exported.fileName : `${baseName}.${exported.extension}`,
            packageFingerprint: exported.manifest.packageFingerprint,
          };
        },
        {
          playbackAfterSuccess: (result) => ({
            frame: result.frameEnd,
            isPlaying: false,
          }),
        },
      );
      completed = true;
      return result;
    } finally {
      if (completed) lockTimelineAtAutomaticExportOutFrame(frameEnd);
      if (deterministicExportControllerRef.current === exportController) {
        deterministicExportControllerRef.current = null;
      }
      automaticExportEndFrameRef.current = null;
    }
  }

  async function exportTimelineMultimodalFrames(
    requestedFrameStart: number,
    requestedFrameEnd: number,
    selection: DirectorMultimodalFrameExportSelection,
    onProgress: (progress: number, frame: number, renderPass: DirectorShotRenderPassId) => void,
  ): Promise<DirectorTimelineExportResult> {
    if (!timeline) throw new Error("当前场景没有可导出的时间轴");
    const runtime = useTimelineRuntimeStore.getState();
    if (runtime.exporting) throw new Error("已有导出任务正在进行");
    if (!activeCameraSource?.id) throw new Error("当前场景没有可用于逐帧渲染的活动机位");

    const maximumFrame = Math.max(timeline.frameStart, effectiveTimelineEndFrame);
    const frameStart = Math.min(maximumFrame, Math.max(timeline.frameStart, Math.round(requestedFrameStart)));
    const frameEnd = Math.min(maximumFrame, Math.max(frameStart, Math.round(requestedFrameEnd)));
    const fallbackCameraId = activeCameraSource.id;
    const exportAspectRatio = activeCameraSource.aspectRatio ?? "16:9";
    const exportProject = useDirectorStore.getState().project;
    automaticExportEndFrameRef.current = frameEnd;
    const exportController = new AbortController();
    deterministicExportControllerRef.current = exportController;
    let completed = false;

    try {
      const result = await runWithTimelineExportRestore(
        {
          readSnapshot: () => ({
            frame: currentFrameRef.current,
            isPlaying,
            helpersHidden: runtime.helpersHidden,
          }),
          setExporting: (exporting) => useTimelineRuntimeStore.getState().setExporting(exporting),
          setHelpersHidden: (hidden) => useTimelineRuntimeStore.getState().setHelpersHidden(hidden),
          setPlaying: (playing) => {
            if (playing) {
              flushSync(() => setIsPlaying(true));
              return;
            }
            stopTimelinePlaybackSynchronously();
          },
          restorePlayback: (frame, playing) => {
            flushSync(() => {
              playbackSessionRef.current += 1;
              publishPlayheadFrameAndRenderShell(frame);
              setIsPlaying(playing);
            });
          },
        },
        async () => {
          const [{ buildDirectorShotIr }, multimodalModule] = await Promise.all([
            import("../shot/shotIr"),
            import("../video/multimodalFrameExport"),
          ]);
          const exported = await multimodalModule.exportDirectorMultimodalFramePackage({
            frameStart,
            frameEnd,
            fps: timelineFps,
            selection,
            signal: exportController.signal,
            onProgress,
            buildShotIr: (frame) => {
              const cameraId = getStoryboardCameraIdAtFrame(storyboard, frame, fallbackCameraId);
              if (!cameraId) throw new Error(`第 ${frame} 帧没有可用于导出参数的机位`);
              return buildDirectorShotIr(exportProject, { cameraId, frame });
            },
            capturePass: async (frame, renderPass, signal) => {
              const renderCameraId = getStoryboardCameraIdAtFrame(storyboard, frame, fallbackCameraId);
              if (!renderCameraId) throw new Error(`第 ${frame} 帧没有可用于渲染的机位`);
              const [capture] = await requestViewportCapture({
                ...createDirectorVideoFrameCaptureRequest(renderCameraId, frame, exportAspectRatio),
                renderPass,
                ...(selection.depthExr && renderPass === "depth" ? { depthFloat: true } : {}),
                ...(selection.includeInstanceAnnotations && renderPass === "object-id"
                  ? { includeRenderPixels: true }
                  : {}),
                signal,
              });
              if (!capture?.dataUrl.startsWith("data:image/png")) {
                throw new Error(`第 ${frame} 帧的 ${renderPass} 通道没有返回真实 PNG`);
              }
              if (
                capture.depthFloat ||
                capture.renderPixels ||
                capture.meta.objectIdColors ||
                capture.meta.categoryColors
              ) {
                return {
                  image: capture.dataUrl,
                  ...(capture.depthFloat ? { depthFloat: capture.depthFloat } : {}),
                  ...(capture.renderPixels ? { renderPixels: capture.renderPixels } : {}),
                  ...(capture.meta.objectIdColors ? { objectIdColors: capture.meta.objectIdColors } : {}),
                  ...(capture.meta.categoryColors ? { categoryColors: capture.meta.categoryColors } : {}),
                };
              }
              return capture.dataUrl;
            },
            ...(selection.denseMotionExr
              ? {
                  captureMotionFlow: async (frame: number, signal?: AbortSignal) => {
                    const renderCameraId = getStoryboardCameraIdAtFrame(storyboard, frame, fallbackCameraId);
                    if (!renderCameraId) throw new Error(`第 ${frame} 帧没有可用于渲染的机位`);
                    const [capture] = await requestViewportCapture({
                      ...createDirectorVideoFrameCaptureRequest(renderCameraId, frame, exportAspectRatio),
                      renderPass: "motion",
                      motionFlowFloat: true,
                      signal,
                    });
                    if (!capture?.motionFlow) {
                      throw new Error(`第 ${frame} 帧的 motion 通道没有返回稠密光流`);
                    }
                    return capture.motionFlow;
                  },
                }
              : {}),
          });
          const baseName = `director-${activeCameraSource.name || "scene"}-multimodal`;
          multimodalModule.downloadDirectorMultimodalFramePackage(exported, baseName);
          return {
            extension: exported.extension,
            frameStart: exported.manifest.sourceFrameStart,
            frameEnd: exported.manifest.sourceFrameEnd,
            frameCount: exported.manifest.frameCount,
            kind: exported.kind,
            name: `${baseName}.zip`,
            packageFingerprint: exported.manifest.packageFingerprint,
          };
        },
        {
          playbackAfterSuccess: (exported) => ({
            frame: exported.frameEnd,
            isPlaying: false,
          }),
        },
      );
      completed = true;
      return result;
    } finally {
      if (completed) lockTimelineAtAutomaticExportOutFrame(frameEnd);
      if (deterministicExportControllerRef.current === exportController) {
        deterministicExportControllerRef.current = null;
      }
      automaticExportEndFrameRef.current = null;
    }
  }

  function cancelTimelineDeterministicExport() {
    deterministicExportControllerRef.current?.abort();
  }

  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;

    const updateHeight = () => {
      const nextHeight = Math.max(element.offsetHeight, DEFAULT_VIEWPORT_TOOLBAR_HEIGHT);
      setToolbarHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => {
        window.removeEventListener("resize", updateHeight);
      };
    }

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(element);
    window.addEventListener("resize", updateHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  function getLassoPointerPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  }

  function handleLassoPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (viewMode !== "director" || playerMode || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = getLassoPointerPoint(event);
    const nextBox = { startX: point.x, startY: point.y, endX: point.x, endY: point.y };
    lassoPointerIdRef.current = event.pointerId;
    lassoSelectionBoxRef.current = nextBox;
    setLassoSelectionBox(nextBox);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleLassoPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (lassoPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    const point = getLassoPointerPoint(event);
    const currentBox = lassoSelectionBoxRef.current;
    if (!currentBox) return;
    const nextBox = { ...currentBox, endX: point.x, endY: point.y };
    lassoSelectionBoxRef.current = nextBox;
    setLassoSelectionBox(nextBox);
  }

  function finishLassoSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (lassoPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    const selection = lassoSelectionBoxRef.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    const camera =
      viewportRenderCameraRef.current ?? (controlsRef.current?.object as ThreePerspectiveCamera | undefined);

    if (selection && camera && bounds.width > 0 && bounds.height > 0) {
      const selectedIds = getLassoSelectionIds({
        camera,
        objects: lassoObjects,
        scene: sceneSettings,
        screenBoundsById: viewportThreeSceneRef.current
          ? getLassoObjectScreenBounds(viewportThreeSceneRef.current, camera, bounds)
          : undefined,
        selection: {
          startX: bounds.left + selection.startX,
          startY: bounds.top + selection.startY,
          endX: bounds.left + selection.endX,
          endY: bounds.top + selection.endY,
        },
        viewport: bounds,
      });
      const selectedObjects = selectedIds
        .map((id) => lassoObjects.find((object) => object.id === id))
        .filter((object): object is DirectorObject => Boolean(object));
      const crowdIds = new Set(selectedObjects.map((object) => object.crowdId).filter(Boolean));

      if (selectedObjects.length > 0 && crowdIds.size === 1 && selectedObjects.every((object) => object.crowdId)) {
        selectCrowd(selectedObjects[0]!.crowdId ?? null);
      } else {
        selectObjects(selectedIds);
      }
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    lassoPointerIdRef.current = null;
    lassoSelectionBoxRef.current = null;
    setLassoSelectionBox(null);
  }

  function cancelLassoSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (lassoPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    lassoPointerIdRef.current = null;
    lassoSelectionBoxRef.current = null;
    setLassoSelectionBox(null);
  }

  function toggleLassoSelection(enabled: boolean) {
    setLassoSelectionEnabled(enabled);
    if (!enabled) {
      lassoPointerIdRef.current = null;
      lassoSelectionBoxRef.current = null;
      setLassoSelectionBox(null);
    }
  }

  function getCachedDropSurfaces() {
    const sceneRoot = viewportThreeSceneRef.current;
    if (!sceneRoot) return [];
    const signature = objects.map((object) => object.id).join("|");
    if (dropSurfacesSceneRef.current === sceneRoot && dropSurfacesSignatureRef.current === signature)
      return dropSurfacesRef.current;

    const surfaces = collectDropSurfaces(sceneRoot);
    dropSurfacesSceneRef.current = sceneRoot;
    dropSurfacesSignatureRef.current = signature;
    dropSurfacesRef.current = surfaces;
    return surfaces;
  }

  function getAssetDropPlacement(event: ReactDragEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = getModelLibraryDropPlacement({
      bounds,
      camera: viewportRenderCameraRef.current ?? (controlsRef.current?.object as ThreePerspectiveCamera | undefined),
      clientX: event.clientX,
      clientY: event.clientY,
      dropSurfaces: getCachedDropSurfaces(),
      fallbackWorldTarget: controlsRef.current?.target,
      scene: sceneSettings,
      sceneRoot: viewportThreeSceneRef.current,
    });
    return {
      ...placement,
      pointerX: Math.min(bounds.width - 16, Math.max(16, event.clientX - bounds.left)),
      pointerY: Math.min(bounds.height - 16, Math.max(16, event.clientY - bounds.top)),
    };
  }

  function addDroppedAsset(payload: ModelLibraryDragPayload, position: [number, number, number]) {
    const previousSelectedObjectId = useDirectorStore.getState().selectedObjectId;
    let createdObjectId: string | null = null;
    beginUndoBatch();
    try {
      if (payload.nativeAction === "add-human") {
        addPresetCharacter();
      } else if (payload.nativeAction === "add-camera") {
        addCameraShot(getViewportCameraSnapshot());
      } else if (payload.nativeAction === "add-cube") {
        addGeometryPrimitive("box");
      } else if (payload.nativeAction === "add-sphere") {
        addGeometryPrimitive("sphere");
      } else {
        const assetSource = payload.assetSource ?? "library";
        const assetKind = payload.kind ?? "prop";
        const existingAsset = useDirectorStore
          .getState()
          .project.assets.find(
            (asset) =>
              asset.sourceType === "model" &&
              asset.assetSource === assetSource &&
              asset.kind === assetKind &&
              asset.url === payload.url,
          );
        if (existingAsset) {
          createdObjectId = addObjectFromAsset(existingAsset.id);
        } else {
          addImportedAsset({
            id: payload.id,
            kind: assetKind,
            assetSource,
            fileName: payload.fileName,
            name: payload.name,
            url: payload.url,
            characterMetadata: payload.characterMetadata,
            realWorldSizeM: payload.realWorldSizeM,
            sizeSource: payload.realWorldSizeM === undefined ? undefined : "catalog",
          });
        }
      }

      const selectedObjectIdAfterAdd = useDirectorStore.getState().selectedObjectId;
      createdObjectId ??= selectedObjectIdAfterAdd !== previousSelectedObjectId ? selectedObjectIdAfterAdd : null;
      if (createdObjectId) updateObjectTransform(createdObjectId, { position });
    } finally {
      endUndoBatch();
    }
  }

  function commitAssetDropPreview(nextPreview: ModelLibraryDropPlacement & { pointerX: number; pointerY: number }) {
    setAssetDropPreview((current) => {
      if (
        current &&
        current.source === nextPreview.source &&
        current.position.every((value, index) => Math.abs(value - nextPreview.position[index]) < 0.001) &&
        Math.abs(current.pointerX - nextPreview.pointerX) < 1 &&
        Math.abs(current.pointerY - nextPreview.pointerY) < 1
      )
        return current;
      return nextPreview;
    });
  }

  function handleAssetDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (
      playerMode ||
      lassoSelectionEnabled ||
      viewportLayout === "quad" ||
      viewMode !== "director" ||
      !Array.from(event.dataTransfer.types).includes(MODEL_LIBRARY_DRAG_MIME)
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!assetDropActiveRef.current) {
      assetDropActiveRef.current = true;
      setAssetDropActive(true);
    }
    pendingAssetDropPreviewRef.current = getAssetDropPlacement(event);
    if (assetDropPreviewFrameRef.current === null) {
      commitAssetDropPreview(pendingAssetDropPreviewRef.current);
      assetDropPreviewFrameRef.current = window.requestAnimationFrame(() => {
        assetDropPreviewFrameRef.current = null;
        const nextPreview = pendingAssetDropPreviewRef.current;
        if (!nextPreview || !assetDropActiveRef.current) return;
        commitAssetDropPreview(nextPreview);
      });
    }
  }

  function clearAssetDropInteraction() {
    assetDropActiveRef.current = false;
    pendingAssetDropPreviewRef.current = null;
    if (assetDropPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(assetDropPreviewFrameRef.current);
      assetDropPreviewFrameRef.current = null;
    }
    setAssetDropActive(false);
    setAssetDropPreview(null);
  }

  function handleAssetDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    clearAssetDropInteraction();
  }

  function handleAssetDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    clearAssetDropInteraction();
    if (playerMode || lassoSelectionEnabled || viewportLayout === "quad" || viewMode !== "director") return;
    const payload = readModelLibraryDragData(event.dataTransfer);
    if (!payload) return;
    const placement = getAssetDropPlacement(event);
    addDroppedAsset(payload, placement.position);
  }

  function getViewportCameraSnapshot(): CameraShotSnapshot {
    return viewportCameraSnapshotRef.current;
  }

  const previewDirectorViewSnapshot = useCallback((snapshot: CameraShotSnapshot) => {
    viewportCameraSnapshotRef.current = snapshot;
  }, []);

  const updateDirectorViewSnapshot = useCallback((snapshot: CameraShotSnapshot) => {
    viewportCameraSnapshotRef.current = snapshot;
    setDirectorViewSnapshot((currentSnapshot) =>
      areCameraSnapshotsClose(currentSnapshot, snapshot) ? currentSnapshot : snapshot,
    );
  }, []);

  const commitCurrentDirectorViewSnapshot = useCallback(() => {
    updateDirectorViewSnapshot(viewportCameraSnapshotRef.current);
  }, [updateDirectorViewSnapshot]);

  function stopCameraPilot() {
    setCameraPilotControlActive(false);
    setCameraPilotMode(false);
    updateDirectorViewSnapshot(viewportCameraSnapshotRef.current);
  }

  function startCameraPilot() {
    if (playerModeRecording) stopPlayerModeRecording();
    setPlayerMode(false);
    setLassoSelectionEnabled(false);
    lassoSelectionBoxRef.current = null;
    setLassoSelectionBox(null);
    const pilotFrame = currentFrameRef.current;
    const { evaluated: evaluatedPilotCamera } = getEvaluatedPlaybackCamera(
      cameras,
      storyboard,
      activeCameraId,
      objects,
      pilotFrame,
      timelineFps,
    );
    publishPlayheadFrameAndRenderShell(pilotFrame);
    setIsPlaying(false);
    setViewMode("director");
    const pilotSnapshot = evaluatedPilotCamera
      ? getCameraViewSnapshotFromShot(evaluatedPilotCamera)
      : getViewportCameraSnapshot();
    viewportCameraSnapshotRef.current = pilotSnapshot;
    updateDirectorViewSnapshot(pilotSnapshot);
    setCameraPilotTargetState({ hoveredTargetId: null, lockedTargetId: null, lockedPoint: null });
    setCameraPilotControlActive(false);
    const source = useDirectorStore
      .getState()
      .project.cameras.find((camera) => camera.id === useDirectorStore.getState().project.activeCameraId);
    setCameraPilotRecordedCount(source?.animation?.keyframes.length ?? 0);
    setCameraPilotMode(true);
  }

  function recordCameraPilotWaypoint(record: CameraPilotRecord) {
    const stateBefore = useDirectorStore.getState();
    const recordingTimeline = stateBefore.project.scene.timeline ?? createDefaultDirectorFrameTimeline();
    const recordFrame = Math.min(
      recordingTimeline.frameEnd,
      Math.max(recordingTimeline.frameStart, currentFrameRef.current),
    );

    beginUndoBatch();
    try {
      if (!stateBefore.project.scene.timeline) updateScene({ timeline: recordingTimeline });
      let cameraId = stateBefore.project.activeCameraId;
      if (!cameraId) cameraId = addCameraShot(record.snapshot);
      const latestCamera = useDirectorStore.getState().project.cameras.find((camera) => camera.id === cameraId);
      if (!latestCamera) return;

      const previousAtFrame = latestCamera.animation?.keyframes.find((keyframe) => keyframe.frame === recordFrame);
      const nextKeyframe = {
        ...previousAtFrame,
        frame: recordFrame,
        interpolation: previousAtFrame?.interpolation ?? ("smooth" as const),
        transform: {
          ...latestCamera.transform,
          position: getCameraRigPositionFromViewSnapshot(record.snapshot),
        },
        lookTarget: [...record.snapshot.target] as [number, number, number],
        lookTargetObjectId: record.targetObjectId,
        fov: record.snapshot.fov,
      };
      const keyframes = [
        ...(latestCamera.animation?.keyframes ?? []).filter((keyframe) => keyframe.frame !== recordFrame),
        nextKeyframe,
      ].sort((left, right) => left.frame - right.frame);

      updateCamera(cameraId, {
        action: { mode: "transform" },
        fov: record.snapshot.fov,
        target: [...record.snapshot.target],
        targetMode: record.targetObjectId ? "object" : "manual",
        targetObjectId: record.targetObjectId,
        transform: nextKeyframe.transform,
      });
      setCameraAnimation(cameraId, {
        version: 1,
        ...latestCamera.animation,
        enabled: true,
        preset: "custom",
        source: "manual",
        keyframes,
      });
      setCameraPilotRecordedCount(keyframes.length);
    } finally {
      endUndoBatch();
    }

    const nextFrame = Math.min(recordingTimeline.frameEnd, recordFrame + Math.max(1, recordingTimeline.fps));
    if (nextFrame !== recordFrame) setPlaybackFrame(nextFrame);
  }

  function updateViewportGizmoSnapshot(snapshot: CameraShotSnapshot) {
    if (viewMode !== "director") {
      setViewMode("director");
    }
    updateDirectorViewSnapshot(snapshot);
  }

  function startPlayerModeRecording() {
    if (!activePlayer) return;
    const liveTimeline = useDirectorStore.getState().project.scene.timeline;
    const recordingTimeline = liveTimeline ?? createDefaultDirectorFrameTimeline();
    if (!liveTimeline) updateScene({ timeline: recordingTimeline });
    const frameStart = clampFrameToAutomaticExportBoundary(
      Math.min(recordingTimeline.frameEnd, Math.max(recordingTimeline.frameStart, currentFrameRef.current)),
    );
    playerRecordingStartRef.current = performance.now();
    // One session records the whole performance: walking samples land on the
    // character, driving samples on the vehicle object, and entering/exiting a
    // car splits the take into sequential per-actor clips automatically.
    playerRecordingSessionRef.current = createPlayerMotionRecordingSession({
      fps: recordingTimeline.fps,
      frameEnd: recordingTimeline.frameEnd,
      startFrame: frameStart,
      resolveActor: (actorId) => {
        const actor = useDirectorStore.getState().project.objects.find((item) => item.id === actorId);
        if (!actor) return null;
        return { baseTransform: actor.transform, existingAnimation: actor.animation };
      },
      commitClip: ({ actorId, recorder }) => {
        const state = useDirectorStore.getState();
        const actor = state.project.objects.find((item) => item.id === actorId);
        const recordingFps = state.project.scene.timeline?.fps ?? recordingTimeline.fps;
        if (!actor) return;
        // Characters replay with the gait the performance actually used;
        // vehicles carry their motion in the keyframes alone.
        const motion = actor.vehicle ? "none" : inferPlayerRecordingGait(recorder.getFrameSamples(), recordingFps);
        const recording = recorder.finalize({ motion });
        if (recording) setObjectAnimation(actorId, recording.animation);
      },
    });
    setPlayerModeRecording(true);
  }

  function stopPlayerModeRecording() {
    const session = playerRecordingSessionRef.current;
    playerRecordingStartRef.current = null;
    playerRecordingSessionRef.current = null;
    setPlayerModeRecording(false);
    session?.stop();
  }

  function togglePlayerModeRecording() {
    if (playerModeRecording) stopPlayerModeRecording();
    else startPlayerModeRecording();
  }

  togglePlayerModeRecordingRef.current = togglePlayerModeRecording;

  function recordPlayerModeTransform(id: string, transform: DirectorTransform) {
    const startedAt = playerRecordingStartRef.current;
    const session = playerRecordingSessionRef.current;
    if (startedAt === null || !session) return;
    session.ingest(id, (performance.now() - startedAt) / 1000, {
      position: [transform.position[0], transform.position[1], transform.position[2]],
      yawRadians: transform.rotation[1],
    });
  }

  useEffect(() => {
    if (!playerMode) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Enter" || event.repeat || isEditableViewportTarget(event.target)) return;
      event.preventDefault();
      togglePlayerModeRecordingRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playerMode]);

  useEffect(() => {
    const unsubscribe = subscribeDirectorSessionCommands((envelope: DirectorSessionCommand) => {
      try {
        if (envelope.surface === "player") {
          const command = envelope.command;
          if (command.type === "enter") {
            if (command.actor_id) {
              const exists = useDirectorStore
                .getState()
                .project.objects.some((object) => object.id === command.actor_id);
              if (!exists) {
                publishDirectorSessionCommandResult({
                  requestId: envelope.requestId,
                  ok: false,
                  error: `No actor object with id "${command.actor_id}".`,
                });
                return;
              }
              beginUndoBatch();
              playerUndoBatchActiveRef.current = true;
              setPlayerActorId(command.actor_id);
              setPlayerViewMode("third");
              setPlayerFlying(false);
              setPlayerControlActive(false);
              playerRuntimeStatusStore.publish(null);
              publishPlayheadFrameAndRenderShell(currentFrameRef.current);
              setIsPlaying(false);
              setViewMode("director");
              setPlayerMode(true);
            } else {
              togglePlayerMode();
              if (!playerMode && !useDirectorStore.getState().selectedObjectId) {
                // togglePlayerMode may no-op without candidates; report based on candidate list
                const candidates = useDirectorStore
                  .getState()
                  .project.objects.filter((object) => object.kind === "character" || object.vehicle);
                if (!candidates.length && !playerMode) {
                  publishDirectorSessionCommandResult({
                    requestId: envelope.requestId,
                    ok: false,
                    error: "No character or vehicle actor is available for Player Mode.",
                  });
                  return;
                }
              }
            }
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { player_mode: true, actor_id: command.actor_id ?? playerActorId },
            });
            return;
          }
          if (command.type === "exit") {
            exitPlayerMode();
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { player_mode: false },
            });
            return;
          }
          if (command.type === "set_actor") {
            selectPlayerActor(command.actor_id);
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { actor_id: command.actor_id },
            });
            return;
          }
          if (command.type === "teleport" || command.type === "walk_to") {
            const store = useDirectorStore.getState();
            // Prefer the command's actor_id so possessed Agents cannot hijack
            // the shared-tab selection when playerActorId is unset.
            const actorId = command.actor_id ?? playerActorId ?? store.selectedObjectId;
            if (!actorId) {
              publishDirectorSessionCommandResult({
                requestId: envelope.requestId,
                ok: false,
                error: "No active player actor for teleport/walk_to.",
              });
              return;
            }
            let position = command.position;
            if (!position && command.object_id) {
              const target = store.project.objects.find((object) => object.id === command.object_id);
              if (!target) {
                publishDirectorSessionCommandResult({
                  requestId: envelope.requestId,
                  ok: false,
                  error: `No object with id "${command.object_id}".`,
                });
                return;
              }
              position = [...target.transform.position] as [number, number, number];
            }
            if (!position) {
              publishDirectorSessionCommandResult({
                requestId: envelope.requestId,
                ok: false,
                error: "teleport/walk_to requires position or object_id.",
              });
              return;
            }
            const actor = store.project.objects.find((object) => object.id === actorId);
            if (!actor) {
              publishDirectorSessionCommandResult({
                requestId: envelope.requestId,
                ok: false,
                error: `No actor object with id "${actorId}".`,
              });
              return;
            }
            store.updateObjectTransform(actorId, {
              ...actor.transform,
              position,
            });
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { actor_id: actorId, position, mode: command.type },
            });
            return;
          }
          if (command.type === "interact") {
            const objectId = command.object_id ?? useDirectorStore.getState().selectedObjectId ?? undefined;
            if (!objectId) {
              publishDirectorSessionCommandResult({
                requestId: envelope.requestId,
                ok: false,
                error: "interact requires object_id or a current selection.",
              });
              return;
            }
            toggleObjectInteraction(objectId);
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { object_id: objectId },
            });
            return;
          }
          if (command.type === "enter_vehicle" || command.type === "exit_vehicle") {
            // Vehicle enter/exit is owned by PlayerController live session; surface the intent.
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: {
                action: command.type,
                object_id: command.type === "enter_vehicle" ? (command.object_id ?? null) : null,
                note: "Vehicle enter/exit is applied by the live PlayerController when the actor is in range.",
              },
            });
            return;
          }
          if (command.type === "record_start") {
            if (!playerMode) {
              publishDirectorSessionCommandResult({
                requestId: envelope.requestId,
                ok: false,
                error: "record_start requires Player Mode to be active.",
              });
              return;
            }
            if (!playerModeRecording) togglePlayerModeRecording();
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { recording: true },
            });
            return;
          }
          if (command.type === "record_stop") {
            if (playerModeRecording) stopPlayerModeRecording();
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { recording: false },
            });
            return;
          }
          if (command.type === "play_script") {
            const parsedScript = gamePlaytestScriptSchema.safeParse(command.script);
            if (!parsedScript.success) {
              const issue = parsedScript.error.issues[0];
              publishDirectorSessionCommandResult({
                requestId: envelope.requestId,
                ok: false,
                error: `Invalid playtest script at ${issue?.path.join(".") || "script"}: ${issue?.message ?? "invalid value"}.`,
              });
              return;
            }
            const store = useDirectorStore.getState();
            const actorId = command.actor_id ?? playerActorId ?? store.selectedObjectId;
            const actor = actorId ? store.project.objects.find((object) => object.id === actorId) : undefined;
            if (!actor) {
              publishDirectorSessionCommandResult({
                requestId: envelope.requestId,
                ok: false,
                error: actorId
                  ? `No actor object with id "${actorId}" for play_script.`
                  : "play_script requires actor_id (bind the player role, then pass its object id).",
              });
              return;
            }
            // Ensure Player Mode is live for the tape's actor before the
            // first tick, mirroring the `enter` command.
            if (!playerMode || playerActorId !== actor.id) {
              beginUndoBatch();
              playerUndoBatchActiveRef.current = true;
              setPlayerActorId(actor.id);
              setPlayerViewMode("third");
              setPlayerFlying(false);
              setPlayerControlActive(false);
              playerRuntimeStatusStore.publish(null);
              publishPlayheadFrameAndRenderShell(currentFrameRef.current);
              setIsPlaying(false);
              setViewMode("director");
              setPlayerMode(true);
            }
            // The receipt is published when the live PlayerController has
            // consumed and sampled every tape frame; the bus dispatcher's
            // timeout covers a tab that never ticks.
            startGamePlaytestSession({ script: parsedScript.data, sliceId: command.slice_id }).then(
              (trace) => {
                publishDirectorSessionCommandResult({
                  requestId: envelope.requestId,
                  ok: true,
                  result: {
                    actor_id: actor.id,
                    trace,
                    sample_count: trace.samples.length,
                    verbs_exercised: trace.verbs_exercised,
                  },
                });
              },
              (error: unknown) => {
                publishDirectorSessionCommandResult({
                  requestId: envelope.requestId,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              },
            );
            return;
          }
        }

        if (envelope.surface === "pilot") {
          const command = envelope.command;
          if (command.type === "start") {
            if (command.camera_id) {
              useDirectorStore.getState().setActiveCamera(command.camera_id);
            }
            startCameraPilot();
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { pilot_mode: true, camera_id: command.camera_id ?? null },
            });
            return;
          }
          if (command.type === "stop") {
            stopCameraPilot();
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { pilot_mode: false },
            });
            return;
          }
          if (command.type === "set_view") {
            const snapshot = {
              ...viewportCameraSnapshotRef.current,
              position: command.position,
              ...(command.target ? { target: command.target } : {}),
              ...(command.fov !== undefined ? { fov: command.fov } : {}),
            };
            viewportCameraSnapshotRef.current = snapshot;
            updateDirectorViewSnapshot(snapshot);
            if (!cameraPilotMode) startCameraPilot();
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { position: command.position, target: command.target ?? null, fov: command.fov ?? null },
            });
            return;
          }
          if (command.type === "record_waypoint") {
            if (!cameraPilotMode) startCameraPilot();
            recordCameraPilotWaypoint({
              snapshot: viewportCameraSnapshotRef.current,
              targetObjectId: cameraPilotTargetState.lockedTargetId,
            });
            publishDirectorSessionCommandResult({
              requestId: envelope.requestId,
              ok: true,
              result: { recorded: true },
            });
            return;
          }
        }
        publishDirectorSessionCommandResult({
          requestId: envelope.requestId,
          ok: false,
          error: "Unsupported session command.",
        });
      } catch (error) {
        publishDirectorSessionCommandResult({
          requestId: envelope.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return () => {
      unsubscribe();
    };
  });

  function togglePlayerMode() {
    if (playerMode) {
      exitPlayerMode();
      return;
    }
    const selectedCharacter = playerCandidates.find((item) => item.id === selectedObjectId);
    const nextPlayer =
      selectedCharacter ?? getNearestPlayerCandidate(playerCandidates, viewportCameraSnapshotRef.current.position);
    if (!nextPlayer) return;

    beginUndoBatch();
    playerUndoBatchActiveRef.current = true;
    setPlayerActorId(nextPlayer.id);
    setPlayerViewMode("third");
    setPlayerFlying(false);
    setPlayerControlActive(false);
    playerRuntimeStatusStore.publish(null);
    publishPlayheadFrameAndRenderShell(currentFrameRef.current);
    setIsPlaying(false);
    setViewMode("director");
    setPlayerMode(true);
  }

  function exitPlayerMode() {
    if (playerModeRecording) stopPlayerModeRecording();
    cancelActiveGamePlaytestSession("Player Mode exited before the playtest tape finished.");
    setPlayerControlActive(false);
    playerRuntimeStatusStore.publish(null);
    setPlayerEmoteRequest(null);
    setPlayerMode(false);
  }

  function selectPlayerActor(actorId: string) {
    if (actorId === playerActorId) return;
    // A movement take belongs to a single actor; finish it before switching.
    if (playerModeRecording) stopPlayerModeRecording();
    cancelActiveGamePlaytestSession("Player actor switched before the playtest tape finished.");
    setPlayerActorId(actorId);
  }

  function requestPlayerEmote(clipId: string) {
    playerEmoteNonceRef.current += 1;
    setPlayerEmoteRequest({ clipId, nonce: playerEmoteNonceRef.current });
  }

  function finishPlayerMode() {
    if (!playerUndoBatchActiveRef.current) return;
    playerUndoBatchActiveRef.current = false;
    endUndoBatch();
  }

  const aspectOverlayBottomPadding = VIEWPORT_FRAME_PADDING + VIEWPORT_TOOLBAR_BOTTOM_OFFSET + toolbarHeight + 52;
  const animationTransportBottom = VIEWPORT_TOOLBAR_BOTTOM_OFFSET + toolbarHeight + ANIMATION_TRANSPORT_GAP;
  const showCameraPictureInPicture =
    viewMode === "director" &&
    viewportLayout === "single" &&
    !playerMode &&
    !cameraPilotMode &&
    !viewportChromeSuppressed &&
    cameras.length > 0;

  return (
    <>
      <StoryboardCameraPlaybackSync isPlaying={isPlaying} />
      <LiveTimelineFrameCaptureBridge
        captureFrame={captureLiveTimelineFrame}
        finishRecording={finishLiveTimelineRecording}
        lastRecordedFrameRef={lastRecordedFrameRef}
        recordingStatus={recordingStatus}
      />
      <div className="canvas-frame">
        <div
          className={`director-canvas${viewportLayout === "quad" ? " is-quad-view" : ""}${assetDropActive ? " is-asset-drop-target" : ""}`}
          data-navigation-mode={navigationMode}
          data-active-quad-pane={viewportLayout === "quad" ? activeQuadViewportId : undefined}
          data-maximized-quad-pane={maximizedQuadViewportId ?? undefined}
          data-viewport-layout={viewportLayout}
          data-testid="director-canvas"
          onContextMenu={(event) => event.preventDefault()}
          onDragLeave={handleAssetDragLeave}
          onDragOver={handleAssetDragOver}
          onDrop={handleAssetDrop}
        >
          <Canvas
            camera={{
              far: VIEWPORT_FAR_CLIP_DISTANCE,
              fov: initialDirectorViewSnapshot.fov,
              position: initialDirectorViewSnapshot.position,
            }}
            className="director-stage-canvas"
            dpr={viewportLayout === "quad" ? performanceConfig.quadDpr : performanceConfig.mainDpr}
            frameloop={stageFrameloop}
            gl={DIRECTOR_CANVAS_GL_OPTIONS}
            shadows={performanceConfig.shadowsEnabled ? "percentage" : false}
            onPointerMissed={
              playerMode
                ? undefined
                : (event) => {
                    // Right/middle gestures are navigation, never a request to
                    // open the empty-scene inspector. OrbitControls also emits
                    // context-menu events for its right-button pan gesture.
                    if (event && (event.button !== 0 || event.defaultPrevented)) return;
                    openSceneInspector();
                  }
            }
            onCreated={({ camera, scene }) => {
              const perspectiveCamera = camera as ThreePerspectiveCamera;
              viewportRenderCameraRef.current = perspectiveCamera;
              viewportThreeSceneRef.current = scene;
              perspectiveCamera.lookAt(...initialDirectorViewSnapshot.target);
              viewportCameraSnapshotRef.current = {
                fov: perspectiveCamera.fov,
                position: [perspectiveCamera.position.x, perspectiveCamera.position.y, perspectiveCamera.position.z],
                target: initialDirectorViewSnapshot.target,
              };
              setDirectorViewSnapshot(viewportCameraSnapshotRef.current);
            }}
          >
            <DirectorViewportLook />
            <DirectorViewportClippingController
              active={viewMode === "director" && !playerMode}
              controlsRef={controlsRef}
            />
            <ViewportBackground
              backgroundColor={sceneSettings.backgroundColor}
              environmentEnabled={sceneSettings.environment?.enabled}
              environmentIntensity={sceneSettings.environment?.intensity}
              environmentRotation={sceneSettings.environment?.rotation}
              environmentUsePanorama={sceneSettings.environment?.usePanorama}
              panoramaAsset={panoramaAsset}
              panoramaRadius={sceneSettings.panoramaRadius}
              panoramaYaw={sceneSettings.panoramaYaw}
            />
            <DirectorSceneFog fog={sceneSettings.fog} />
            <DirectorSceneLighting
              lights={lights}
              shadowMapSize={performanceConfig.shadowMapSize}
              shadowsEnabled={performanceConfig.shadowsEnabled}
            />
            <DirectorShadowMapController
              continuous={continuousShadowUpdates}
              dynamicObjectIds={dynamicShadowObjectIds}
              dynamicRevisionToken={dynamicShadowInvalidationToken}
              enabled={performanceConfig.shadowsEnabled}
              staticRevisionToken={staticShadowInvalidationToken}
            />
            <AdaptivePerformanceController
              automatic={selectedPerformanceProfile === "auto"}
              effectiveProfileId={effectivePerformanceProfile}
              onAutomaticProfileChange={setAutomaticPerformanceProfile}
            />
            <PlayheadCameraRuntime
              activeCameraId={activeCameraId}
              cameras={cameras}
              lockedPreviewCameraId={lockedPreviewCameraId}
              objects={objects}
              previewMode={cameraPreviewMode}
              showPictureInPicture={showCameraPictureInPicture}
              storyboard={storyboard}
              timelineFps={timelineFps}
              viewMode={viewMode}
            />
            {viewportLayout === "quad" ? (
              <QuadViewportRenderer
                framing={quadViewFraming}
                maximizedPaneId={maximizedQuadViewportId}
                zooms={quadViewportZooms}
              />
            ) : null}
            {showViewportGrid ? (
              <group
                name="director-viewport-ground-grid"
                position={sceneSettings.position}
                rotation={sceneSettings.rotation}
                scale={[sceneSettings.scale, sceneSettings.scale, sceneSettings.scale]}
              >
                <ViewportGroundGrid
                  cellColor={DIRECTOR_PREVIZ_PALETTE.gridMinor}
                  cellSize={VIEWPORT_GRID_CELL_SIZE}
                  cellThickness={VIEWPORT_GRID_CELL_THICKNESS}
                  fadeDistance={viewportGridFadeDistance}
                  fadeStrength={VIEWPORT_GRID_FADE_STRENGTH}
                  followCamera={viewportLayout === "single"}
                  infiniteGrid
                  position={[0, sceneSettings.groundHeight + VIEWPORT_GRID_ELEVATION, 0]}
                  sectionColor={DIRECTOR_PREVIZ_PALETTE.gridMajor}
                  sectionSize={VIEWPORT_GRID_SECTION_SIZE}
                  sectionThickness={VIEWPORT_GRID_SECTION_THICKNESS}
                  side={DoubleSide}
                  userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
                />
              </group>
            ) : null}
            {viewMode === "director" && !playerMode ? (
              <OrbitControls
                ref={controlsRef}
                enableDamping
                enabled={!lassoSelectionEnabled && !cameraPilotMode && viewportLayout === "single"}
                makeDefault
                maxDistance={VIEWPORT_MAX_ORBIT_DISTANCE}
                minDistance={VIEWPORT_MIN_ORBIT_DISTANCE}
                rotateSpeed={viewportRotateSensitivity / 0.35}
                zoomSpeed={viewportZoomSensitivity / 0.4}
                mouseButtons={getViewportNavigationMouseButtons(navigationMode)}
                target={directorViewSnapshot.target}
                onChange={(event) => {
                  const viewportCamera = event?.target?.object as Camera | undefined;
                  const target = event?.target?.target as Vector3 | undefined;
                  if (!viewportCamera || !target) return;
                  const snapshot = {
                    // Orbit/pan changes are user intent; a panel resize is not.
                    // Keep the logical FOV stable so resizing reveals or crops
                    // the surrounding scene like Blender's editor regions.
                    fov: viewportCameraSnapshotRef.current.fov,
                    position: [viewportCamera.position.x, viewportCamera.position.y, viewportCamera.position.z],
                    target: [target.x, target.y, target.z],
                  } satisfies CameraShotSnapshot;
                  previewDirectorViewSnapshot(snapshot);
                }}
                onEnd={() => {
                  if (!smoothOrbitZoomActiveRef.current) {
                    updateDirectorViewSnapshot(viewportCameraSnapshotRef.current);
                  }
                }}
              />
            ) : null}
            <SmoothOrbitZoom
              activityRef={smoothOrbitZoomActiveRef}
              controlsRef={controlsRef}
              enabled={
                viewMode === "director" &&
                viewportLayout === "single" &&
                !playerMode &&
                !lassoSelectionEnabled &&
                !cameraPilotMode
              }
              onSettled={commitCurrentDirectorViewSnapshot}
              zoomSensitivity={viewportZoomSensitivity}
            />
            <DirectorKeyboardController
              active={
                viewMode === "director" &&
                viewportLayout === "single" &&
                !playerMode &&
                !lassoSelectionEnabled &&
                !cameraPilotMode
              }
              controlsRef={controlsRef}
              moveEnabled={navigationMode === "hand"}
              moveSpeed={viewportMoveSpeed}
              rotateSensitivity={viewportRotateSensitivity}
              onInteractionEnd={commitCurrentDirectorViewSnapshot}
            />
            <CameraPilotController
              active={viewMode === "director" && cameraPilotMode}
              bankStrength={viewportPilotBankStrength}
              inertia={viewportPilotInertia}
              lookSmoothing={viewportPilotLookSmoothing}
              moveSpeed={viewportMoveSpeed}
              objectKey={cameraPilotObjectKey}
              onControlActiveChange={setCameraPilotControlActive}
              onExit={stopCameraPilot}
              onRecord={recordCameraPilotWaypoint}
              onTargetStateChange={setCameraPilotTargetState}
              rotateSensitivity={viewportRotateSensitivity}
              snapshotRef={viewportCameraSnapshotRef}
              zoomSensitivity={viewportZoomSensitivity}
            />
            <CursorViewportNavigation
              controlsRef={controlsRef}
              enabled={
                viewMode === "director" &&
                viewportLayout === "single" &&
                !playerMode &&
                !lassoSelectionEnabled &&
                !cameraPilotMode &&
                navigationMode === "cursor"
              }
              moveSpeed={viewportMoveSpeed}
              onInteractionEnd={commitCurrentDirectorViewSnapshot}
              onSnapshotChange={previewDirectorViewSnapshot}
            />
            <DirectorViewCameraSync
              controlsRef={controlsRef}
              playerMode={playerMode}
              snapshot={directorViewSnapshot}
              viewMode={viewMode}
            />
            <BlenderViewportResize fov={directorViewSnapshot.fov} playerMode={playerMode} viewMode={viewMode} />
            <CanvasCaptureBridge
              activeCamera={activeCameraSource}
              bottomPadding={aspectOverlayBottomPadding}
              controlsRef={controlsRef}
              currentFrameRef={currentFrameRef}
              enabled={captureSceneReady}
              prepareCaptureFrame={prepareCaptureFrame}
              safeAreaInsets={viewportSafeAreaInsets}
              viewportAspectRatio={viewportAspectRatio}
              viewMode={viewMode}
            />
            <DirectorClippingPlanes planes={sceneSettings.clippingPlanes ?? []} />
            <Suspense fallback={null}>
              <PlayheadSceneRoot
                interactionEnabled={!playerMode && !cameraPilotMode && viewportLayout === "single"}
                isPlaying={isPlaying || playerMode}
                onRootChange={setCollisionReferenceRoot}
                showCameraRigs={!cameraPilotMode}
                showViewportOverlays={viewportLayout === "single"}
                suppressedAnimationObjectId={playerMode ? activePlayer?.id : undefined}
                runtimeTransformOwnerId={playerMode ? activePlayer?.id : undefined}
              >
                <BlenderSceneLayer
                  cameraAspectRatio={getViewportAspectRatioValue(viewportAspectRatio) ?? 16 / 9}
                  interactionEnabled={viewportLayout === "single"}
                  isPlaying={isPlaying || playerMode}
                  onCollisionEnvironmentChange={setBlenderCollisionEnvironment}
                  onStatusChange={captureOnly ? handleBlenderSceneStatusChange : undefined}
                  pollIntervalMs={captureOnly ? 4_000 : undefined}
                  projectId={nativeProjectId}
                  referenceRoot={collisionReferenceRoot}
                  visible={blenderLiveVisible && Boolean(nativeProjectId)}
                />
              </PlayheadSceneRoot>
            </Suspense>
            {playerMode && activePlayer ? (
              <PlayerController
                emoteRequest={playerEmoteRequest}
                enabled={playerMode}
                flying={playerFlying}
                collisionReferenceRoot={collisionReferenceRoot}
                groundEnabled={roamGroundEnabled}
                groundHeight={sceneSettings.groundHeight}
                interactionCandidates={playerInteractionCandidates}
                liveEnvironment={blenderCollisionEnvironment}
                obstacles={playerObstacles}
                onCameraSnapshot={updateDirectorViewSnapshot}
                onControlActiveChange={setPlayerControlActive}
                onExitRequest={exitPlayerMode}
                onFinished={finishPlayerMode}
                onFlyingChange={setPlayerFlying}
                onInteract={toggleObjectInteraction}
                onRuntimeStatusChange={playerRuntimeStatusStore.publish}
                onTransformSample={recordPlayerModeTransform}
                onTransformCommit={updateObjectTransform}
                onViewModeChange={setPlayerViewMode}
                player={activePlayer}
                rotateSensitivity={viewportRotateSensitivity}
                moveSpeedScale={viewportCharacterMoveSpeed}
                viewMode={playerViewMode}
                zoomSensitivity={viewportZoomSensitivity}
              />
            ) : null}
            {playerMode && activePlayer ? (
              <LinearCastingLayer
                enabled={playerMode}
                groundHeight={sceneSettings.groundHeight}
                origin={activePlayer.transform.position ?? [0, sceneSettings.groundHeight, 0]}
                runtimeStatusStore={playerRuntimeStatusStore}
              />
            ) : null}
          </Canvas>
          {viewportLayout === "quad" ? (
            <QuadViewportChrome
              activePaneId={activeQuadViewportId}
              maximizedPaneId={maximizedQuadViewportId}
              onPaneActivate={activateQuadViewport}
              onPaneReset={resetQuadViewport}
              onPaneToggleMaximize={toggleMaximizedQuadViewport}
              onPaneZoom={zoomQuadViewport}
              zooms={quadViewportZooms}
            />
          ) : null}
          {lassoSelectionEnabled && !playerMode && !isPlaying && !cameraPilotMode && viewportLayout === "single" ? (
            <div
              aria-label="套索选择区域"
              className="lasso-selection-layer"
              onPointerCancel={cancelLassoSelection}
              onPointerDown={handleLassoPointerDown}
              onPointerMove={handleLassoPointerMove}
              onPointerUp={finishLassoSelection}
            >
              {lassoSelectionBox ? (
                <div
                  aria-hidden="true"
                  className="lasso-selection-box"
                  style={{
                    left: `${Math.min(lassoSelectionBox.startX, lassoSelectionBox.endX)}px`,
                    top: `${Math.min(lassoSelectionBox.startY, lassoSelectionBox.endY)}px`,
                    width: `${Math.abs(lassoSelectionBox.endX - lassoSelectionBox.startX)}px`,
                    height: `${Math.abs(lassoSelectionBox.endY - lassoSelectionBox.startY)}px`,
                  }}
                />
              ) : (
                <span className="lasso-selection-hint">拖动方框选择对象</span>
              )}
            </div>
          ) : null}
          {assetDropPreview ? (
            <div
              aria-live="polite"
              className={`asset-drop-placement-label is-${assetDropPreview.source}`}
              style={{ left: assetDropPreview.pointerX, top: assetDropPreview.pointerY }}
            >
              <strong>释放以放置</strong>
              <span>
                {assetDropPreview.source === "surface"
                  ? "吸附到模型表面"
                  : assetDropPreview.source === "ground"
                    ? "落到场景地面"
                    : "落到当前视图中心"}
                {sceneSettings.snapToGrid ? " · 网格吸附" : ""}
              </span>
            </div>
          ) : null}
          {showCameraPictureInPicture ? (
            <PlayheadCameraPictureInPictureOverlay
              activeCameraId={activeCameraId}
              cameras={cameras}
              locked={Boolean(lockedPreviewCameraId)}
              lockedPreviewCameraId={lockedPreviewCameraId}
              onSelectPreviewMode={setCameraPreviewMode}
              onToggleLock={togglePictureInPictureLock}
              previewMode={cameraPreviewMode}
              storyboard={storyboard}
            />
          ) : null}
          {playerMode && activePlayer && !playerControlActive ? (
            <div className="player-controller-resume-hint" role="status">
              <MousePointer2 aria-hidden size={13} />
              点击场景恢复漫游控制 · Esc 退出
            </div>
          ) : null}
          {playerMode && activePlayer ? <PlayerRuntimeCrosshair runtimeStatusStore={playerRuntimeStatusStore} /> : null}
          {playerMode && activePlayer ? <LinearCastingHud /> : null}
        </div>
        {viewMode === "director" && viewportLayout === "single" && !playerMode && !cameraPilotMode ? (
          <CameraViewportProperties />
        ) : null}
        {!playerMode && !cameraPilotMode && viewportLayout === "single" ? (
          <PlayheadViewportGizmoOverlay
            activeCameraId={activeCameraId}
            cameras={cameras}
            directorSnapshot={directorViewSnapshot}
            dpr={performanceConfig.gizmoDpr}
            objects={objects}
            onSnapshotChange={updateViewportGizmoSnapshot}
            rightOffset={gizmoRightOffset}
            rotateSensitivity={viewportRotateSensitivity}
            storyboard={storyboard}
            timelineFps={timelineFps}
            viewMode={viewMode}
          />
        ) : null}
        {playerMode && activePlayer ? (
          <LivePlayerModeHud
            actors={playerCandidates.map((candidate) => ({ id: candidate.id, name: candidate.name }))}
            activeActorId={activePlayer.id}
            controlActive={playerControlActive}
            flying={playerFlying}
            onEmote={requestPlayerEmote}
            onExit={exitPlayerMode}
            onSelectActor={selectPlayerActor}
            onToggleFlight={() => setPlayerFlying((current) => !current)}
            onToggleRecording={togglePlayerModeRecording}
            onToggleView={() => setPlayerViewMode((current) => (current === "third" ? "first" : "third"))}
            playerName={activePlayer.name}
            recording={playerModeRecording}
            runtimeStatusStore={playerRuntimeStatusStore}
            viewMode={playerViewMode}
          />
        ) : null}
        {cameraPilotMode && !playerMode ? (
          <PlayheadCameraPilotHud
            controlActive={cameraPilotControlActive}
            lockedTargetName={cameraPilotLockedName}
            onExit={stopCameraPilot}
            onRecord={() =>
              recordCameraPilotWaypoint({
                snapshot: viewportCameraSnapshotRef.current,
                targetObjectId: cameraPilotTargetState.lockedTargetId,
              })
            }
            pointedTargetName={cameraPilotHoveredName}
            recordedCount={cameraPilotRecordedCount}
            targetLocked={Boolean(cameraPilotTargetState.lockedTargetId || cameraPilotTargetState.lockedPoint)}
          />
        ) : null}
        {!timeline && !layout.frameless ? (
          <DirectorTimelineEnablePrompt
            bottom={animationTransportBottom}
            onEnable={() => {
              onTimelineCollapsedChange(false);
              updateScene({ timeline: createDefaultDirectorFrameTimeline() });
            }}
          />
        ) : null}
        {!viewportChromeSuppressed ? (
          <ViewportToolbar
            assetActionsInSidebar
            getViewportCameraSnapshot={getViewportCameraSnapshot}
            onToggleFrameless={onToggleFrameless}
            onTogglePlayerMode={togglePlayerMode}
            cameraPilotMode={cameraPilotMode}
            onToggleCameraPilot={() => (cameraPilotMode ? stopCameraPilot() : startCameraPilot())}
            navigationMode={navigationMode}
            onNavigationModeChange={setNavigationMode}
            lassoSelectionDisabled={isPlaying || cameraPilotMode || viewportLayout !== "single"}
            lassoSelectionEnabled={lassoSelectionEnabled}
            onLassoSelectionEnabledChange={toggleLassoSelection}
            playerAvailable={playerCandidates.length > 0}
            playerMode={playerMode}
            toolbarContainerRef={toolbarRef}
          />
        ) : null}
      </div>
      {timeline && timelineVisible ? (
        <ConnectedDirectorTimelineDock
          height={layout.timelineHeight}
          isPlaying={isPlaying}
          onCancelDeterministicExport={cancelTimelineDeterministicExport}
          onCollapse={() => onTimelineCollapsedChange(true)}
          onDeterministicExport={exportTimelineDeterministicFrames}
          onMultimodalExport={exportTimelineMultimodalFrames}
          onExport={exportTimelineVideo}
          onRecordingControl={handleRecordingControl}
          onRecordingSettingsChange={updateTimelineRecordingSettings}
          onFrameChange={setPlaybackFrame}
          onFrameCommit={commitPlaybackFrame}
          onHeightChange={onTimelineHeightChange}
          onReset={() => setPlaybackFrame(timeline.frameStart)}
          onTogglePlaying={togglePlayback}
          recordingSettings={recordingSettings}
          recordingStatus={recordingStatus}
          timeline={timeline}
        />
      ) : null}
    </>
  );
}
