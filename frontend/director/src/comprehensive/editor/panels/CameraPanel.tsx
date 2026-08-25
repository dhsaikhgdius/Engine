import {
  Camera,
  Download,
  Eye,
  Film,
  Images,
  Move3D,
  PackageOpen,
  Send,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../i18n/language";
import {
  parseFiniteNumber as finiteOr,
  replaceTupleAxis as replaceAxis,
} from "../../../../../../packages/protocol/src/primitives";
import {
  InspectorAxisGroup,
  InspectorPanel,
  InspectorSection,
  InspectorSelectField,
  InspectorTextField,
  InspectorUnitNumberField,
} from "./InspectorControls";
import { requestViewportCapture } from "../io/captureBridge";
import { downloadDataUrl } from "../io/screenshotExport";
import { postDirectorDeskCapturesToHost, postDirectorDeskVideoToHost } from "../io/hostBridge";
import { getDirectorObjectFocusTarget, isCameraFocusableObject } from "../schema/cameraTarget";
import { calculateDirectorCameraExposure } from "../schema/cameraExposure";
import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_ACTION,
  DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  DIRECTOR_CAMERA_OPTICS_LIMITS,
  DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS,
  DIRECTOR_CAMERA_HANDHELD_SHAKE_OPTIONS,
  DIRECTOR_CAMERA_SENSOR_FORMAT_OPTIONS,
  getCameraRigPositionFromViewSnapshot,
  getCameraRotationDegrees,
  getCameraTargetFromRotationDegrees,
  getCameraViewSnapshotFromShot,
  getDirectorCameraAspectValue,
  getFocalLengthFromVerticalFov,
  getVerticalFovFromFocalLength,
  normalizeDirectorCameraOptics,
} from "../schema/cameraGeometry";
import { evaluateDirectorCameraAtFrame, evaluateDirectorObjectAtFrame } from "../schema/directorAnimation";
import type {
  DirectorCameraActionMode,
  DirectorCameraAspectRatio,
  DirectorCameraCapture,
  DirectorCameraSensorFormat,
} from "../schema/directorProject";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { useModalDialogFocus } from "../../app/layout/useModalDialogFocus";
import { useDirectorStore } from "../store/directorStore";
import type { ViewportAspectRatio } from "@director/protocol/workbench-ui";
import { useVideoRecordingStore, type DirectorVideoLibraryItem } from "../video/videoRecordingStore";
import { buildDirectorCameraMove, type DirectorCameraFraming } from "../trajectory/cameraMoveAuthoring";
import { CinematographyAdvisor } from "./CinematographyAdvisor";

const VIEWER_ZOOM_MIN = 0.25;
const VIEWER_ZOOM_MAX = 5;
const VIEWER_ZOOM_STEP = 0.25;
type CameraOpticalField =
  "apertureFStop" | "focusDistanceM" | "shutterAngle" | "iso" | "nearClipM" | "farClipM" | "anamorphicSqueeze";
const CAMERA_OPTICAL_FIELDS = [
  { field: "apertureFStop", ariaLabel: "相机光圈", label: "光圈", step: "0.1", unit: "f" },
  { field: "focusDistanceM", ariaLabel: "相机对焦距离", label: "对焦距离", step: "0.01", unit: "m" },
  { field: "shutterAngle", ariaLabel: "相机快门角度", label: "快门角度", step: "1", unit: "°" },
  { field: "iso", ariaLabel: "相机 ISO", label: "ISO", step: "25", unit: "ISO" },
  { field: "nearClipM", ariaLabel: "相机近裁剪面", label: "近裁剪", step: "0.001", unit: "m" },
  { field: "farClipM", ariaLabel: "相机远裁剪面", label: "远裁剪", step: "1", unit: "m" },
  {
    field: "anamorphicSqueeze",
    ariaLabel: "相机变形宽银幕挤压",
    label: "变形挤压",
    step: "0.01",
    unit: "×",
  },
] as const satisfies ReadonlyArray<{
  field: CameraOpticalField;
  ariaLabel: string;
  label: string;
  step: string;
  unit: string;
}>;

export function CameraPanel() {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<"properties" | "captures" | "recordings">("properties");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [controlPackageStatus, setControlPackageStatus] = useState<string | null>(null);
  const [controlPackageExporting, setControlPackageExporting] = useState(false);
  const [cameraMoveStart, setCameraMoveStart] = useState<{ cameraId: string; framing: DirectorCameraFraming } | null>(
    null,
  );
  const [cameraMoveStatus, setCameraMoveStatus] = useState<string | null>(null);
  const [hoveredCaptureId, setHoveredCaptureId] = useState<string | null>(null);
  // Destructive actions (deleting render videos, clearing captures) are either
  // unrecoverable or expensive to redo, so they use an inline two-step confirm
  // instead of firing on the first click.
  const [confirmingActionKey, setConfirmingActionKey] = useState<string | null>(null);
  const [viewerCapture, setViewerCapture] = useState<DirectorCameraCapture | null>(null);
  const [viewerScale, setViewerScale] = useState(1);
  const [viewerOffset, setViewerOffset] = useState({ x: 0, y: 0 });
  const [viewerDragging, setViewerDragging] = useState(false);
  const viewerDragStateRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const camera = useDirectorStore((state) =>
    state.project.cameras.find((item) => item.id === state.project.activeCameraId),
  );
  const cameras = useDirectorStore((state) => state.project.cameras);
  const objects = useDirectorStore((state) => state.project.objects);
  const setActiveCamera = useDirectorStore((state) => state.setActiveCamera);
  const setTransformMode = useDirectorStore((state) => state.setTransformMode);
  const setViewportAspectRatio = useDirectorStore((state) => state.setViewportAspectRatio);
  const addCameraCaptures = useDirectorStore((state) => state.addCameraCaptures);
  const updateCamera = useDirectorStore((state) => state.updateCamera);
  const setCameraAnimation = useDirectorStore((state) => state.setCameraAnimation);
  const beginUndoBatch = useDirectorStore((state) => state.beginUndoBatch);
  const endUndoBatch = useDirectorStore((state) => state.endUndoBatch);
  const timeline = useDirectorStore((state) => state.project.scene.timeline);
  const recordings = useVideoRecordingStore((state) => state.recordings);
  const removeRecording = useVideoRecordingStore((state) => state.removeRecording);
  const clearRecordings = useVideoRecordingStore((state) => state.clearRecordings);
  const updateRecordingStatus = useVideoRecordingStore((state) => state.updateRecordingStatus);

  // Keep all hooks above the missing-camera guard. The active camera can be
  // removed from a different panel while this inspector remains mounted.
  // Returning before the hooks used to make React's hook order conditional.
  const captures = useMemo(() => camera?.captures ?? [], [camera?.captures]);
  const cameraCaptureGroups = useMemo(
    () =>
      cameras.map((item) => ({
        camera: item,
        captures: item.captures ?? [],
      })),
    [cameras],
  );
  const hasAnyCameraCapture = cameraCaptureGroups.some((group) => group.captures.length > 0);
  const focusableObjects = useMemo(() => objects.filter(isCameraFocusableObject), [objects]);
  const targetSelectValue =
    camera?.targetMode === "object" && camera.targetObjectId ? `object:${camera.targetObjectId}` : "manual";
  const currentAspectRatio = camera?.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const currentSensorFormat = camera?.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const currentFocalLengthMm = camera?.focalLengthMm ?? DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM;
  const currentHandheldShake = camera?.handheldShake ?? DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE;
  const currentAction = camera?.action ?? DEFAULT_DIRECTOR_CAMERA_ACTION;
  const currentOptics = normalizeDirectorCameraOptics(camera ?? {});
  const currentExposure = calculateDirectorCameraExposure(currentOptics, timeline?.fps ?? 24);
  const currentViewSnapshot = camera ? getCameraViewSnapshotFromShot(camera) : null;
  const currentRotationDegrees = camera ? getCameraRotationDegrees(camera) : null;

  useEffect(() => {
    setCameraMoveStart(null);
    setCameraMoveStatus(null);
  }, [camera?.id]);

  useEffect(() => {
    if (!confirmingActionKey) return;
    const timer = window.setTimeout(() => setConfirmingActionKey(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingActionKey]);

  useEffect(() => {
    if (viewerCapture) return;
    setViewerScale(1);
    setViewerOffset({ x: 0, y: 0 });
    setViewerDragging(false);
    viewerDragStateRef.current = null;
  }, [viewerCapture]);

  const viewerDialogRef = useModalDialogFocus<HTMLDivElement>({
    enabled: viewerCapture !== null,
    onClose: () => setViewerCapture(null),
  });

  useEffect(() => {
    if (viewerScale <= 1) {
      setViewerOffset({ x: 0, y: 0 });
      setViewerDragging(false);
      viewerDragStateRef.current = null;
    }
  }, [viewerScale]);

  useEffect(() => {
    if (!viewerDragging) {
      return;
    }

    function handleMouseMove(event: MouseEvent) {
      const dragState = viewerDragStateRef.current;
      if (!dragState) {
        return;
      }

      setViewerOffset({
        x: dragState.originX + event.clientX - dragState.startX,
        y: dragState.originY + event.clientY - dragState.startY,
      });
    }

    function handleMouseUp() {
      setViewerDragging(false);
      viewerDragStateRef.current = null;
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [viewerDragging]);

  const clampViewerScale = useCallback((value: number) => {
    return Math.min(VIEWER_ZOOM_MAX, Math.max(VIEWER_ZOOM_MIN, value));
  }, []);

  const updateViewerScale = useCallback(
    (updater: (currentScale: number) => number) => {
      setViewerScale((currentScale) => clampViewerScale(Number(updater(currentScale).toFixed(2))));
    },
    [clampViewerScale],
  );

  const sendCaptureToCanvas = useCallback((capture: DirectorCameraCapture) => {
    postDirectorDeskCapturesToHost([
      {
        dataUrl: capture.dataUrl,
        fileName: `${capture.name}.png`,
      },
    ]);
  }, []);

  const sendAllCapturesToCanvas = useCallback(() => {
    postDirectorDeskCapturesToHost(
      cameraCaptureGroups.flatMap((group) =>
        group.captures.map((capture) => ({
          dataUrl: capture.dataUrl,
          fileName: `${capture.name}.png`,
        })),
      ),
    );
  }, [cameraCaptureGroups]);

  if (!camera || !currentViewSnapshot || !currentRotationDegrees) return null;
  const currentCamera = camera;
  // These constants are deliberately established after the guard so callback
  // closures retain non-null camera geometry even as the store updates later.
  const viewSnapshot = currentViewSnapshot;
  const rotationDegreesSnapshot = currentRotationDegrees;

  async function handleCameraCapture() {
    try {
      setCaptureError(null);
      const results = await requestViewportCapture({
        preset: "current",
        source: "camera-panel",
        cameraId: currentCamera.id,
      });
      const preview = results[0];
      if (preview) {
        addCameraCaptures(currentCamera.id, [preview.dataUrl]);
      }
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "机位截图失败");
    }
  }

  async function handleExportAiControlPackage() {
    if (controlPackageExporting) return;
    setCaptureError(null);
    setControlPackageStatus("正在渲染 clean、白模、深度、法线、对象 ID 与遮罩…");
    setControlPackageExporting(true);
    try {
      const project = useDirectorStore.getState().project;
      const aspect = getDirectorCameraAspectValue(currentCamera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO);
      const width = aspect >= 1 ? 1280 : Math.max(1, Math.round(1280 * aspect));
      const height = aspect >= 1 ? Math.max(1, Math.round(1280 / aspect)) : 1280;
      const [{ getDirectorProjectRevision }, { runWithDirectorProjectRevision }, controlPackageModule] =
        await Promise.all([
          import("../schema/directorProjectRevision"),
          import("../../../agent/directorRevisionBoundCapture"),
          import("../shot/shotControlPackageExport"),
        ]);
      const revision = getDirectorProjectRevision(project);
      const result = await runWithDirectorProjectRevision(revision, ({ project: immutableProject, signal }) =>
        controlPackageModule.createDirectorAiControlPackage(
          immutableProject,
          {
            cameraId: currentCamera.id,
            frame: immutableProject.scene.timeline?.currentFrame ?? 0,
            width,
            height,
            renderPasses: ["clean", "clay", "depth", "normal", "object-id", "mask"],
          },
          (request) => requestViewportCapture({ ...request, signal }),
        ),
      );
      controlPackageModule.downloadDirectorAiControlPackage(result.archive, result.captured.manifest.packageId);
      setControlPackageStatus(
        `控制包已就绪 · ${result.captured.manifest.controlPackage?.trajectoryFrameRange.sampleCount ?? 1} 个轨迹采样`,
      );
    } catch (error) {
      setControlPackageStatus(null);
      setCaptureError(error instanceof Error ? error.message : "AI 控制包导出失败");
    } finally {
      setControlPackageExporting(false);
    }
  }

  function handleDeleteCapture(captureId: string) {
    const captureCamera = cameras.find((item) => (item.captures ?? []).some((capture) => capture.id === captureId));
    if (!captureCamera) return;

    const nextCaptures = (captureCamera.captures ?? []).filter((item) => item.id !== captureId);
    updateCamera(captureCamera.id, {
      captures: nextCaptures,
      lastCaptureUrl: nextCaptures[nextCaptures.length - 1]?.dataUrl ?? null,
    });
    setHoveredCaptureId((current) => (current === captureId ? null : current));
    setViewerCapture((current) => (current?.id === captureId ? null : current));
  }

  /**
   * First click arms the confirm state for `key`; the second click within the
   * timeout actually runs the action. Blur or the 4s timer disarms it.
   */
  function confirmThenRun(key: string, run: () => void) {
    if (confirmingActionKey === key) {
      setConfirmingActionKey(null);
      run();
      return;
    }
    setConfirmingActionKey(key);
  }

  function resetConfirmingAction(key: string) {
    setConfirmingActionKey((current) => (current === key ? null : current));
  }

  function handleClearAllCaptures() {
    // A single undo batch keeps "clear all" reversible with one Cmd+Z instead
    // of one entry per camera.
    beginUndoBatch();
    try {
      cameras.forEach((item) => {
        if ((item.captures ?? []).length === 0 && !item.lastCaptureUrl) return;

        updateCamera(item.id, {
          captures: [],
          lastCaptureUrl: null,
        });
      });
    } finally {
      endUndoBatch();
    }
    setHoveredCaptureId(null);
    setViewerCapture(null);
  }

  function handleViewerZoom(direction: "in" | "out") {
    updateViewerScale((current) => current + (direction === "in" ? VIEWER_ZOOM_STEP : -VIEWER_ZOOM_STEP));
  }

  function handleViewerWheel(event: React.WheelEvent<HTMLImageElement>) {
    event.preventDefault();
    event.stopPropagation();
    updateViewerScale((current) => current + (event.deltaY < 0 ? VIEWER_ZOOM_STEP : -VIEWER_ZOOM_STEP));
  }

  function handleViewerMouseDown(event: React.MouseEvent<HTMLImageElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (viewerScale <= 1) {
      return;
    }

    viewerDragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: viewerOffset.x,
      originY: viewerOffset.y,
    };
    setViewerDragging(true);
  }

  function closeViewer() {
    setViewerCapture(null);
  }

  function handleTargetSelection(value: string) {
    if (value === "manual") {
      updateCamera(currentCamera.id, {
        targetMode: "manual",
        targetObjectId: null,
      });
      return;
    }

    const objectId = value.replace(/^object:/, "");
    const targetObject = focusableObjects.find((item) => item.id === objectId);

    if (!targetObject) {
      updateCamera(currentCamera.id, {
        targetMode: "manual",
        targetObjectId: null,
      });
      return;
    }

    updateCamera(currentCamera.id, {
      targetMode: "object",
      targetObjectId: targetObject.id,
      target: getDirectorObjectFocusTarget(targetObject),
      transform: {
        ...currentCamera.transform,
        position: getCameraRigPositionFromViewSnapshot({
          ...viewSnapshot,
          target: getDirectorObjectFocusTarget(targetObject),
        }),
      },
    });
  }

  function updateCameraActionMode(mode: DirectorCameraActionMode) {
    if (mode === "path") {
      updateCamera(currentCamera.id, {
        action: {
          mode,
          path: {
            speed: currentAction.path?.speed ?? 1,
            lockTarget: currentAction.path?.lockTarget ?? Boolean(currentCamera.targetObjectId),
            targetObjectId: currentAction.path?.targetObjectId ?? currentCamera.targetObjectId ?? null,
          },
        },
      });
      return;
    }
    if (mode === "follow") {
      updateCamera(currentCamera.id, {
        action: {
          mode,
          follow: currentAction.follow ?? {
            targetObjectId: null,
            positionOffset: [0, 0, 0],
            targetOffset: [0, 0, 0],
          },
        },
      });
      return;
    }
    if (mode === "still") {
      // Still is a real camera action rather than a hidden view-state toggle.
      // Remove the active transform track so its evaluation cannot keep moving
      // this shot after the user returns it to a fixed frame.
      setCameraAnimation(currentCamera.id, undefined);
    }
    updateCamera(currentCamera.id, { action: { mode } });
  }

  function updatePathAction(patch: Partial<NonNullable<typeof currentAction.path>>) {
    const path = currentAction.path ?? { speed: 1, lockTarget: false, targetObjectId: null };
    updateCamera(currentCamera.id, { action: { mode: "path", path: { ...path, ...patch } } });
  }

  function updateFollowTarget(value: string) {
    const targetObject = focusableObjects.find((item) => item.id === value);
    if (!targetObject) {
      updateCamera(currentCamera.id, {
        action: {
          mode: "follow",
          follow: {
            targetObjectId: null,
            positionOffset: [0, 0, 0],
            targetOffset: [0, 0, 0],
          },
        },
      });
      return;
    }
    const anchor = targetObject.transform.position;
    updateCamera(currentCamera.id, {
      action: {
        mode: "follow",
        follow: {
          targetObjectId: targetObject.id,
          positionOffset: [
            currentCamera.transform.position[0] - anchor[0],
            currentCamera.transform.position[1] - anchor[1],
            currentCamera.transform.position[2] - anchor[2],
          ],
          targetOffset: [
            currentCamera.target[0] - anchor[0],
            currentCamera.target[1] - anchor[1],
            currentCamera.target[2] - anchor[2],
          ],
        },
      },
    });
  }

  function beginCameraPathDrawing() {
    useTimelineRuntimeStore.getState().beginDrawing(`camera:${currentCamera.id}`, currentCamera.transform.position);
  }

  function recordCameraTransformKeyframe() {
    const frame = timeline?.currentFrame ?? 0;
    const keyframe = {
      frame,
      interpolation: "smooth" as const,
      transform: {
        position: [...currentCamera.transform.position] as [number, number, number],
        rotation: [...currentCamera.transform.rotation] as [number, number, number],
        scale: [...currentCamera.transform.scale] as [number, number, number],
      },
      lookTarget: [...currentCamera.target] as [number, number, number],
      fov: currentCamera.fov,
    };
    const existing = currentCamera.animation?.keyframes ?? [];
    setCameraAnimation(currentCamera.id, {
      version: 1,
      enabled: true,
      source: "manual",
      keyframes: [...existing.filter((item) => item.frame !== frame), keyframe].sort(
        (left, right) => left.frame - right.frame,
      ),
    });
  }

  function captureCurrentCameraFraming(): DirectorCameraFraming {
    const frame = Math.round(timeline?.currentFrame ?? 0);
    const fps = timeline?.fps ?? 24;
    const actionTargets = focusableObjects.map((item) => {
      const evaluatedObject = evaluateDirectorObjectAtFrame(item, frame, fps);
      return { id: item.id, position: getDirectorObjectFocusTarget(evaluatedObject) };
    });
    const evaluatedCamera = evaluateDirectorCameraAtFrame(currentCamera, frame, actionTargets);
    const evaluatedView = getCameraViewSnapshotFromShot(evaluatedCamera);

    return {
      frame,
      position: [...evaluatedView.position],
      target: [...evaluatedView.target],
      focalLengthMm: getFocalLengthFromVerticalFov(evaluatedCamera.fov, currentAspectRatio, currentSensorFormat),
      rotation: [...evaluatedCamera.transform.rotation],
      scale: [...evaluatedCamera.transform.scale],
    };
  }

  function recordCameraMoveStart() {
    const framing = captureCurrentCameraFraming();
    setCameraMoveStart({ cameraId: currentCamera.id, framing });
    setCameraMoveStatus(`A · 第 ${framing.frame} 帧 · ${framing.focalLengthMm}mm`);
  }

  function authorCameraMove() {
    if (!cameraMoveStart || cameraMoveStart.cameraId !== currentCamera.id) {
      setCameraMoveStatus("请先记录构图 A");
      return;
    }

    const to = captureCurrentCameraFraming();
    if (to.frame <= cameraMoveStart.framing.frame) {
      setCameraMoveStatus("请将播放头移到 A 之后，再记录构图 B");
      return;
    }

    const result = buildDirectorCameraMove({
      from: cameraMoveStart.framing,
      to,
      aspectRatio: currentAspectRatio,
      sensorFormat: currentSensorFormat,
      existingAnimation: currentCamera.animation,
    });

    beginUndoBatch();
    try {
      updateCamera(currentCamera.id, { action: { mode: "transform" } });
      setCameraAnimation(currentCamera.id, result.animation);
    } finally {
      endUndoBatch();
    }

    setCameraMoveStart(null);
    setCameraMoveStatus(
      `${result.classification.label} · ${to.frame - cameraMoveStart.framing.frame} 帧 · ${cameraMoveStart.framing.focalLengthMm}mm → ${to.focalLengthMm}mm`,
    );
  }

  function updateManualTarget(axis: 0 | 1 | 2, value: string) {
    const target = replaceAxis(currentCamera.target, axis, Number(value));
    updateCamera(currentCamera.id, {
      targetMode: "manual",
      targetObjectId: null,
      target,
      transform: {
        ...currentCamera.transform,
        position: getCameraRigPositionFromViewSnapshot({ ...viewSnapshot, target }),
      },
    });
  }

  function updateCameraViewPosition(axis: 0 | 1 | 2, value: string) {
    const position = replaceAxis(viewSnapshot.position, axis, finiteOr(value, viewSnapshot.position[axis]));
    const nextSnapshot = { ...viewSnapshot, position };
    updateCamera(currentCamera.id, {
      transform: {
        ...currentCamera.transform,
        position: getCameraRigPositionFromViewSnapshot(nextSnapshot),
      },
    });
  }

  function updateCameraRotation(axis: 0 | 1 | 2, value: string) {
    const rotationDegrees = replaceAxis(rotationDegreesSnapshot, axis, finiteOr(value, rotationDegreesSnapshot[axis]));
    const distance = Math.max(
      viewSnapshot.position
        .map((coordinate, index) => (coordinate - currentCamera.target[index]) ** 2)
        .reduce((sum, coordinate) => sum + coordinate, 0) ** 0.5,
      0.1,
    );
    updateCamera(currentCamera.id, {
      targetMode: "manual",
      targetObjectId: null,
      target: getCameraTargetFromRotationDegrees(viewSnapshot.position, rotationDegrees, distance),
    });
  }

  function beginViewportCameraMove() {
    // Selecting the shot's scene object makes its transform gizmo visible in
    // the Stage. "translate" is deliberate: it is the least surprising
    // direct-manipulation mode for moving a physical camera rig.
    setActiveCamera(currentCamera.id);
    setTransformMode("translate");
  }

  function updateFocalLength(value: string) {
    const focalLengthMm = finiteOr(value, currentFocalLengthMm);
    updateCamera(currentCamera.id, {
      focalLengthMm,
      fov: getVerticalFovFromFocalLength(focalLengthMm, currentAspectRatio, currentSensorFormat),
    });
  }

  function updateSensorFormat(value: string) {
    const sensorFormat = value as DirectorCameraSensorFormat;
    updateCamera(currentCamera.id, {
      sensorFormat,
      fov: getVerticalFovFromFocalLength(currentFocalLengthMm, currentAspectRatio, sensorFormat),
    });
  }

  function updateAspectRatio(value: string) {
    const aspectRatio = value as DirectorCameraAspectRatio;
    updateCamera(currentCamera.id, {
      aspectRatio,
      fov: getVerticalFovFromFocalLength(currentFocalLengthMm, aspectRatio, currentSensorFormat),
    });
    setViewportAspectRatio(aspectRatio as ViewportAspectRatio);
  }

  function updateOpticalNumber(
    field: CameraOpticalField,
    value: string,
    fallback: number,
    limits: { min: number; max: number },
  ) {
    const nextValue = Math.min(limits.max, Math.max(limits.min, finiteOr(value, fallback)));
    if (field === "nearClipM" && nextValue >= currentOptics.farClipM) return;
    if (field === "farClipM" && nextValue <= currentOptics.nearClipM) return;
    updateCamera(currentCamera.id, { [field]: nextValue });
  }

  function renderOpticalFields(fields: readonly (typeof CAMERA_OPTICAL_FIELDS)[number][]) {
    return fields.map(({ field, ariaLabel, label, step, unit }) => {
      const limits = DIRECTOR_CAMERA_OPTICS_LIMITS[field];
      const min = field === "farClipM" ? Math.max(limits.min, currentOptics.nearClipM + 0.001) : limits.min;
      const max = field === "nearClipM" ? Math.min(limits.max, currentOptics.farClipM - 0.001) : limits.max;
      return (
        <InspectorUnitNumberField
          ariaLabel={ariaLabel}
          key={field}
          label={label}
          max={String(max)}
          min={String(min)}
          step={step}
          unit={unit}
          value={currentOptics[field]}
          onChange={(value) => updateOpticalNumber(field, value, currentOptics[field], limits)}
        />
      );
    });
  }

  function renderCaptureCards(captureList: DirectorCameraCapture[]) {
    return (
      <div className="camera-capture-grid" aria-label="相机截图列表">
        {captureList.map((capture) => {
          const captureActive = hoveredCaptureId === capture.id;

          return (
            <div key={capture.id} className="camera-capture-card">
              <div
                className="camera-capture-thumb-wrap"
                onClick={() => setViewerCapture(capture)}
                onMouseEnter={() => setHoveredCaptureId(capture.id)}
                onMouseLeave={() => setHoveredCaptureId((current) => (current === capture.id ? null : current))}
              >
                <img className="camera-capture-thumb" alt={`${capture.name} 缩略图`} src={capture.dataUrl} />
                <div
                  aria-label={`${capture.name} 缩略图操作`}
                  className={`camera-capture-actions${captureActive ? " is-visible" : ""}`}
                  role="group"
                >
                  <button
                    aria-label={`删除截图 ${capture.name}`}
                    className="camera-capture-action"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDeleteCapture(capture.id);
                    }}
                  >
                    <Trash2 aria-hidden="true" size={14} strokeWidth={1.9} />
                  </button>
                  <button
                    aria-label={`发送到画布 ${capture.name}`}
                    className="camera-capture-action"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      sendCaptureToCanvas(capture);
                    }}
                  >
                    <Send aria-hidden="true" size={14} strokeWidth={1.9} />
                  </button>
                  <button
                    aria-label={`查看截图 ${capture.name}`}
                    className="camera-capture-action"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setViewerCapture(capture);
                    }}
                  >
                    <Eye aria-hidden="true" size={14} strokeWidth={1.9} />
                  </button>
                </div>
              </div>
              <span className="camera-capture-name" data-i18n-user-content>
                {capture.name}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderCurrentCameraCaptureGrid() {
    if (captures.length === 0) {
      return <div className="capture-list-placeholder">当前还没有机位截图，可先从当前机位生成一张预览。</div>;
    }

    return renderCaptureCards(captures);
  }

  function renderCaptureEmptyState() {
    return (
      <div className="camera-capture-empty object-search-empty-state" role="status" aria-label="暂无摄像机截图">
        <span className="object-search-empty-icon" data-testid="camera-capture-empty-icon">
          <Images aria-hidden="true" size={16} strokeWidth={1.8} />
        </span>
        <span>暂无摄像机截图</span>
      </div>
    );
  }

  function renderAllCameraCaptures() {
    return (
      <div className="camera-capture-overview">
        <div className="camera-capture-overview-scroll">
          {hasAnyCameraCapture
            ? cameraCaptureGroups
                .filter((group) => group.captures.length > 0)
                .map((group) => (
                  <section
                    key={group.camera.id}
                    aria-label={`${group.camera.name}截图`}
                    className="camera-capture-group"
                    data-i18n-preserve-attributes
                  >
                    <h3>
                      <span data-i18n-user-content>{t(group.camera.name)}</span>
                      <span className="camera-capture-group-suffix">截图</span>
                    </h3>
                    {renderCaptureCards(group.captures)}
                  </section>
                ))
            : renderCaptureEmptyState()}
        </div>
      </div>
    );
  }

  function renderCaptureOverviewFooter() {
    if (activeTab === "captures") {
      const confirmingClearCaptures = confirmingActionKey === "captures:clear";

      return (
        <div className="camera-capture-overview-footer">
          <button
            className={`camera-capture-clear-all${confirmingClearCaptures ? " is-confirming" : ""}`}
            type="button"
            onBlur={() => resetConfirmingAction("captures:clear")}
            onClick={() => confirmThenRun("captures:clear", handleClearAllCaptures)}
          >
            <Trash2 aria-hidden="true" data-testid="camera-capture-clear-icon" size={14} strokeWidth={1.9} />
            <span>{confirmingClearCaptures ? "确认清空全部截图？" : "清空全部"}</span>
          </button>
          <button
            className="camera-capture-send-all viewport-toolbar-crowd-confirm"
            type="button"
            onClick={sendAllCapturesToCanvas}
          >
            <Send aria-hidden="true" data-testid="camera-capture-send-icon" size={14} strokeWidth={1.9} />
            <span>发送到画布</span>
          </button>
        </div>
      );
    }

    if (activeTab === "recordings" && recordings.length > 0) {
      const confirmingClearRecordings = confirmingActionKey === "recordings:clear";

      return (
        <div className="camera-capture-overview-footer">
          <button
            className={`camera-capture-clear-all${confirmingClearRecordings ? " is-confirming" : ""}`}
            type="button"
            onBlur={() => resetConfirmingAction("recordings:clear")}
            onClick={() => confirmThenRun("recordings:clear", clearRecordings)}
          >
            <Trash2 aria-hidden="true" size={14} strokeWidth={1.9} />
            <span>{confirmingClearRecordings ? "确认清空？渲染视频不可恢复" : "清空全部"}</span>
          </button>
        </div>
      );
    }

    return null;
  }

  async function downloadRecording(recording: DirectorVideoLibraryItem) {
    const { downloadDirectorVideo } = await import("../video/directorVideoExport");
    downloadDirectorVideo(recording, recording.name);
  }

  async function sendRecordingToComfyUI(recording: DirectorVideoLibraryItem) {
    updateRecordingStatus(recording.id, "uploading", "正在上传到 ComfyUI input…");
    try {
      const result = await postDirectorDeskVideoToHost({
        blob: recording.blob,
        fileName: recording.fileName,
        mimeType: recording.mimeType,
        frameStart: recording.frameStart,
        frameEnd: recording.frameEnd,
        fps: recording.sourceFps,
        durationSec: recording.durationSec,
      });
      updateRecordingStatus(
        recording.id,
        "uploaded",
        result.nodeType ? `已上传并创建 ${result.nodeType}` : `已上传 ${result.relativeName}`,
      );
    } catch (error) {
      updateRecordingStatus(recording.id, "error", error instanceof Error ? error.message : "发送参考视频失败");
    }
  }

  function renderVideoLibrary() {
    if (recordings.length === 0) {
      return (
        <div className="camera-capture-tab">
          <div className="render-video-empty object-search-empty-state" role="status" aria-label="暂无渲染视频">
            <span className="object-search-empty-icon">
              <Film aria-hidden size={16} strokeWidth={1.8} />
            </span>
            <span>在底部时间轴设置 IN / OUT 后，点击“记录渲染”</span>
          </div>
        </div>
      );
    }

    return (
      <div className="render-video-library" aria-label="渲染视频记录列表">
        {recordings.map((recording) => (
          <article className="render-video-card" key={recording.id} aria-label={recording.name}>
            <div className="render-video-thumbnail-wrap">
              <img
                alt={`${recording.name} 缩略图`}
                className="render-video-thumbnail"
                src={recording.thumbnailDataUrl}
              />
              <span className={`render-video-status is-${recording.status}`}>
                {recording.status === "ready"
                  ? "已就绪"
                  : recording.status === "uploading"
                    ? "上传中"
                    : recording.status === "uploaded"
                      ? "已发送"
                      : "失败"}
              </span>
            </div>
            <div className="render-video-card-heading">
              <strong data-i18n-user-content>{recording.name}</strong>
              <span>{recording.extension.toUpperCase()}</span>
            </div>
            <dl className="render-video-metadata">
              <div>
                <dt>区间</dt>
                <dd>
                  F{recording.frameStart}–F{recording.frameEnd}
                </dd>
              </div>
              <div>
                <dt>FPS</dt>
                <dd>{recording.sourceFps}</dd>
              </div>
              <div>
                <dt>时长</dt>
                <dd>{recording.durationSec.toFixed(3)}s</dd>
              </div>
              <div>
                <dt>帧数</dt>
                <dd>{recording.frameCount}</dd>
              </div>
            </dl>
            <p className={`render-video-message is-${recording.status}`}>{recording.statusMessage}</p>
            <div className="render-video-actions" role="group" aria-label={`${recording.name} 操作`}>
              <button
                aria-label={`下载 ${recording.name}`}
                onClick={() => void downloadRecording(recording)}
                type="button"
              >
                <Download aria-hidden size={14} />
                下载
              </button>
              <button
                aria-label={`发送 ${recording.name} 到 ComfyUI`}
                disabled={recording.status === "uploading"}
                onClick={() => void sendRecordingToComfyUI(recording)}
                type="button"
              >
                <Upload aria-hidden size={14} />
                参考视频
              </button>
              <button
                aria-label={
                  confirmingActionKey === `recording:${recording.id}`
                    ? `确认删除 ${recording.name}`
                    : `删除 ${recording.name}`
                }
                className={confirmingActionKey === `recording:${recording.id}` ? "is-confirming" : undefined}
                onBlur={() => resetConfirmingAction(`recording:${recording.id}`)}
                onClick={() => confirmThenRun(`recording:${recording.id}`, () => removeRecording(recording.id))}
                type="button"
              >
                <Trash2 aria-hidden size={14} />
                {confirmingActionKey === `recording:${recording.id}` ? <span>确认删除？</span> : null}
              </button>
            </div>
          </article>
        ))}
      </div>
    );
  }

  function renderViewer() {
    if (!viewerCapture) {
      return null;
    }

    const viewerImageClassName = [
      "camera-capture-viewer-image",
      viewerScale > 1 ? "is-zoomed" : "",
      viewerDragging ? "is-dragging" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className="camera-capture-viewer" role="presentation" onClick={closeViewer}>
        {/* display: contents keeps the dialog wrapper out of layout so the
            backdrop still positions the toolbar and stage directly. */}
        <div
          aria-label="相机截图查看器"
          aria-modal="true"
          className="camera-capture-viewer-dialog"
          ref={viewerDialogRef}
          role="dialog"
          style={{ display: "contents" }}
        >
          <div
            aria-label="相机截图查看器工具栏"
            className="camera-capture-viewer-toolbar"
            role="toolbar"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              aria-label="放大图片"
              className="camera-capture-viewer-tool"
              type="button"
              onClick={() => handleViewerZoom("in")}
            >
              <ZoomIn aria-hidden="true" size={18} strokeWidth={2} />
            </button>
            <button
              aria-label="缩小图片"
              className="camera-capture-viewer-tool"
              type="button"
              onClick={() => handleViewerZoom("out")}
            >
              <ZoomOut aria-hidden="true" size={18} strokeWidth={2} />
            </button>
            <button
              aria-label="下载图片"
              className="camera-capture-viewer-tool"
              type="button"
              onClick={() => downloadDataUrl(viewerCapture.dataUrl, `${viewerCapture.name}.png`)}
            >
              <Download aria-hidden="true" size={18} strokeWidth={2} />
            </button>
            <button
              aria-label="关闭相机截图查看器"
              className="camera-capture-viewer-tool camera-capture-viewer-close"
              type="button"
              onClick={closeViewer}
            >
              <X aria-hidden="true" size={18} strokeWidth={2} />
            </button>
          </div>
          <div className="camera-capture-viewer-stage">
            <img
              className={viewerImageClassName}
              alt={`${viewerCapture.name} 查看大图`}
              src={viewerCapture.dataUrl}
              style={{ transform: `translate(${viewerOffset.x}px, ${viewerOffset.y}px) scale(${viewerScale})` }}
              onClick={(event) => event.stopPropagation()}
              onWheel={handleViewerWheel}
              onMouseDown={handleViewerMouseDown}
              draggable={false}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <InspectorPanel
      title="相机"
      ariaLabel="相机右侧属性面板"
      className={`camera-inspector flick-camera-inspector${
        activeTab === "properties"
          ? ""
          : ` camera-inspector-captures camera-inspector-library${activeTab === "recordings" ? " camera-inspector-recordings" : ""}`
      }`}
      footer={renderCaptureOverviewFooter()}
      tabs={[
        { label: "属性", active: activeTab === "properties", onClick: () => setActiveTab("properties") },
        { label: "摄像机截图", active: activeTab === "captures", onClick: () => setActiveTab("captures") },
        { label: "渲染视频", active: activeTab === "recordings", onClick: () => setActiveTab("recordings") },
      ]}
    >
      {activeTab === "properties" ? (
        <>
          <InspectorTextField
            label="名称"
            ariaLabel="机位名称"
            value={currentCamera.name}
            onChange={(value) => updateCamera(currentCamera.id, { name: value })}
          />
          <InspectorSection className="camera-rig-section" collapsible title="机位设置">
            <InspectorSelectField
              label="切换机位"
              ariaLabel="切换机位"
              value={currentCamera.id}
              onChange={(value) => setActiveCamera(value)}
            >
              {cameras.map((item) => (
                <option data-i18n-user-content key={item.id} value={item.id}>
                  {t(item.name)}
                </option>
              ))}
            </InspectorSelectField>
            <button
              aria-label="在画布中移动机位"
              className="camera-action-path-button camera-viewport-move-button"
              type="button"
              onClick={beginViewportCameraMove}
            >
              <Move3D aria-hidden size={14} strokeWidth={1.9} />
              <span>在画布中移动机位</span>
            </button>
          </InspectorSection>
          <CinematographyAdvisor
            camera={currentCamera}
            onApply={(patch) => {
              updateCamera(currentCamera.id, patch);
              setViewportAspectRatio(patch.aspectRatio as ViewportAspectRatio);
            }}
          />
          <InspectorSection className="camera-transform-section" collapsible title="变换">
            <div className="camera-transform-group">
              {[
                { label: "位置", values: viewSnapshot.position, update: updateCameraViewPosition },
                { label: "旋转", values: rotationDegreesSnapshot, update: updateCameraRotation },
              ].map(({ label, values, update }) => (
                <InspectorAxisGroup
                  key={label}
                  label={label}
                  axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
                    axis,
                    ariaLabel: `相机${label} ${axis}`,
                    value: values[index],
                    step: "0.001",
                    onChange: (value) => update(index as 0 | 1 | 2, value),
                  }))}
                />
              ))}
            </div>
            <InspectorUnitNumberField
              ariaLabel="相机焦距"
              label="焦距"
              max="200"
              min="12"
              step="0.1"
              unit="mm"
              value={currentFocalLengthMm}
              onChange={updateFocalLength}
            />
            <InspectorSelectField
              ariaLabel="相机传感器"
              label="传感器"
              value={currentSensorFormat}
              onChange={updateSensorFormat}
            >
              {DIRECTOR_CAMERA_SENSOR_FORMAT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </InspectorSelectField>
            <InspectorSelectField
              ariaLabel="相机宽高比"
              label="宽高比"
              value={currentAspectRatio}
              onChange={updateAspectRatio}
            >
              {DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </InspectorSelectField>
          </InspectorSection>
          <InspectorSection collapsible defaultOpen={false} title="高级光学">
            {renderOpticalFields(CAMERA_OPTICAL_FIELDS.slice(0, 4))}
            <p aria-label="相机曝光计算" className="camera-action-help">
              实际快门
              <output aria-label="相机实际快门秒数">
                {currentExposure.shutterSeconds.toFixed(6)} s（1/
                {Number((1 / currentExposure.shutterSeconds).toFixed(2))}）
              </output>
              <span aria-hidden="true"> · </span>
              EV100
              <output aria-label="相机 EV100">{currentExposure.ev100.toFixed(2)}</output>
            </p>
            {renderOpticalFields(CAMERA_OPTICAL_FIELDS.slice(4))}
            <p className="camera-action-help">光圈、对焦、快门、ISO 与挤压会写入镜头元数据；近/远裁剪会实时生效。</p>
          </InspectorSection>
          <InspectorSection className="camera-motion-section" collapsible defaultOpen={false} title="镜头运动">
            <InspectorSelectField
              ariaLabel="手持镜头晃动"
              label="手持镜头晃动"
              value={currentHandheldShake}
              onChange={(handheldShake) =>
                updateCamera(currentCamera.id, { handheldShake: handheldShake as typeof currentHandheldShake })
              }
            >
              {DIRECTOR_CAMERA_HANDHELD_SHAKE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </InspectorSelectField>
            <InspectorSelectField
              ariaLabel="相机动作模式"
              label="镜头动作"
              value={currentAction.mode}
              onChange={(value) => updateCameraActionMode(value as DirectorCameraActionMode)}
            >
              <option value="still">静止（Still）</option>
              <option value="path">路径（Path）</option>
              <option value="follow">跟随（Follow）</option>
              <option value="transform">Transform（关键帧）</option>
            </InspectorSelectField>
            <div className="camera-subgroup">
              <p className="camera-subgroup-title">A/B 运镜</p>
              <p className="camera-action-help">在时间轴记录起止构图，按真实机位、注视点和焦距生成运镜。</p>
              <div aria-label="A/B 运镜" className="camera-move-actions" role="group">
                <button
                  className="camera-action-path-button camera-move-capture-button"
                  type="button"
                  onClick={recordCameraMoveStart}
                >
                  {cameraMoveStart ? "重录构图 A" : "记录构图 A"}
                </button>
                <button className="camera-action-path-button" type="button" onClick={authorCameraMove}>
                  记录构图 B 并生成运镜
                </button>
              </div>
              {cameraMoveStatus ? (
                <output aria-label="A/B 运镜状态" className="camera-move-status" role="status">
                  {cameraMoveStatus}
                </output>
              ) : null}
            </div>
            {currentAction.mode === "path" ? (
              <div className="camera-subgroup">
                <p className="camera-subgroup-title">路径属性</p>
                <InspectorUnitNumberField
                  ariaLabel="路径移动速度"
                  label="移动速度"
                  max="4"
                  min="0.1"
                  step="0.1"
                  unit="×"
                  value={currentAction.path?.speed ?? 1}
                  onChange={(value) => {
                    const speed = Number(value);
                    if (Number.isFinite(speed)) updatePathAction({ speed });
                  }}
                />
                <InspectorSelectField
                  ariaLabel="路径锁定目标"
                  label="锁定目标"
                  value={currentAction.path?.targetObjectId ?? "none"}
                  onChange={(value) => updatePathAction({ targetObjectId: value === "none" ? null : value })}
                >
                  <option value="none">不锁定</option>
                  {focusableObjects.map((item) => (
                    <option data-i18n-user-content key={item.id} value={item.id}>
                      {t(item.name)}
                    </option>
                  ))}
                </InspectorSelectField>
                <label className="trajectory-inspector-toggle camera-action-toggle">
                  <input
                    aria-label="路径中锁定目标"
                    checked={Boolean(currentAction.path?.lockTarget && currentAction.path?.targetObjectId)}
                    disabled={!currentAction.path?.targetObjectId}
                    type="checkbox"
                    onChange={() => updatePathAction({ lockTarget: !currentAction.path?.lockTarget })}
                  />
                  <span>移动时始终注视目标</span>
                </label>
                <button className="camera-action-path-button" type="button" onClick={beginCameraPathDrawing}>
                  在 3D Stage 绘制路径
                </button>
              </div>
            ) : null}
            {currentAction.mode === "follow" ? (
              <div className="camera-subgroup">
                <p className="camera-subgroup-title">跟随属性</p>
                <InspectorSelectField
                  ariaLabel="相机跟随对象"
                  label="跟随对象"
                  value={currentAction.follow?.targetObjectId ?? "none"}
                  onChange={updateFollowTarget}
                >
                  <option value="none">选择对象</option>
                  {focusableObjects.map((item) => (
                    <option data-i18n-user-content key={item.id} value={item.id}>
                      {t(item.name)}
                    </option>
                  ))}
                </InspectorSelectField>
                <p className="camera-action-help">相机会保留当前相对距离，并随对象的动画一起移动。</p>
              </div>
            ) : null}
            {currentAction.mode === "transform" ? (
              <div className="camera-subgroup">
                <p className="camera-subgroup-title">Transform 属性</p>
                <p className="camera-action-help">
                  在时间轴移动播放头后记录位置与旋转关键帧，生成传统 Transform 镜头动画。
                </p>
                <button className="camera-action-path-button" type="button" onClick={recordCameraTransformKeyframe}>
                  在当前帧记录关键帧
                </button>
              </div>
            ) : null}
          </InspectorSection>
          <InspectorSection className="camera-look-section" collapsible defaultOpen={false} title="注视">
            <InspectorSelectField
              label="注视目标"
              ariaLabel="注视目标模式"
              value={targetSelectValue}
              onChange={handleTargetSelection}
            >
              <option value="manual">手动坐标</option>
              {focusableObjects.map((item) => (
                <option data-i18n-user-content key={item.id} value={`object:${item.id}`}>
                  {t(item.name)}
                </option>
              ))}
            </InspectorSelectField>
            <InspectorAxisGroup
              label="注视坐标"
              axes={[
                {
                  axis: "X",
                  ariaLabel: "注视坐标 X",
                  value: currentCamera.target[0],
                  onChange: (value) => updateManualTarget(0, value),
                },
                {
                  axis: "Y",
                  ariaLabel: "注视坐标 Y",
                  value: currentCamera.target[1],
                  onChange: (value) => updateManualTarget(1, value),
                },
                {
                  axis: "Z",
                  ariaLabel: "注视坐标 Z",
                  value: currentCamera.target[2],
                  onChange: (value) => updateManualTarget(2, value),
                },
              ]}
            />
          </InspectorSection>
          <InspectorSection className="camera-capture-section" collapsible title="相机截图">
            <button className="camera-capture-current-button" type="button" onClick={() => void handleCameraCapture()}>
              <Camera aria-hidden="true" data-testid="camera-current-capture-icon" size={14} strokeWidth={1.9} />
              <span>截图到画布</span>
            </button>
            <button
              aria-label="导出 AI 控制包"
              className="camera-capture-current-button"
              disabled={controlPackageExporting}
              type="button"
              onClick={() => void handleExportAiControlPackage()}
            >
              <PackageOpen aria-hidden size={14} strokeWidth={1.9} />
              <span>{controlPackageExporting ? "正在导出控制包…" : "导出 AI 控制包"}</span>
            </button>
            {controlPackageStatus ? <p role="status">{controlPackageStatus}</p> : null}
            {captureError ? <p>{captureError}</p> : null}
            {renderCurrentCameraCaptureGrid()}
          </InspectorSection>
        </>
      ) : activeTab === "captures" ? (
        <div className="camera-capture-tab">
          {captureError ? <p>{captureError}</p> : null}
          {renderAllCameraCaptures()}
        </div>
      ) : (
        renderVideoLibrary()
      )}
      {renderViewer()}
    </InspectorPanel>
  );
}
