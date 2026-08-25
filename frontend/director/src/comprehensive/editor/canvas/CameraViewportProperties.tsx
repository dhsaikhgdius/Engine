import { Camera, Move3D } from "lucide-react";
import {
  parseFiniteNumber as finiteOr,
  replaceTupleAxis as replaceAxis,
} from "../../../../../../packages/protocol/src/primitives";
import { useCallback, useRef, type CSSProperties } from "react";
import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS,
  DIRECTOR_CAMERA_HANDHELD_SHAKE_OPTIONS,
  getCameraRigPositionFromViewSnapshot,
  getCameraRotationDegrees,
  getCameraTargetFromRotationDegrees,
  getCameraViewSnapshotFromShot,
  getVerticalFovFromFocalLength,
} from "../schema/cameraGeometry";
import type { DirectorCameraAspectRatio, DirectorCameraHandheldShake } from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";
import { CAMERA_PROPERTIES_WIDTH, useViewportChromeDrag } from "./viewportChromeDrag";

type Axis = 0 | 1 | 2;

function AxisRow({
  label,
  name,
  values,
  onChange,
}: {
  label: string;
  name: string;
  values: [number, number, number];
  onChange: (axis: Axis, value: string) => void;
}) {
  return (
    <div className="camera-viewport-properties-axis-row">
      <span>{label}</span>
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <label key={axis}>
          <span>{axis}</span>
          <input
            aria-label={`${name} ${axis}`}
            inputMode="decimal"
            step="0.001"
            type="number"
            value={values[index]}
            onChange={(event) => onChange(index as Axis, event.currentTarget.value)}
          />
        </label>
      ))}
    </div>
  );
}

/**
 * A concise, in-viewport counterpart to the full inspector. It keeps the
 * practical Flick workflow close to the selected physical camera while the
 * right panel remains the home for captures and advanced camera actions.
 */
export function CameraViewportProperties() {
  const panelRef = useRef<HTMLElement | null>(null);
  const selectedCamera = useDirectorStore((state) => {
    const selectedObject = state.project.objects.find((item) => item.id === state.selectedObjectId);
    if (selectedObject?.kind !== "camera" || !selectedObject.linkedCameraId) return null;
    return state.project.cameras.find((camera) => camera.id === selectedObject.linkedCameraId) ?? null;
  });
  const updateCamera = useDirectorStore((state) => state.updateCamera);
  const setTransformMode = useDirectorStore((state) => state.setTransformMode);
  const getBounds = useCallback(() => {
    const frame = panelRef.current?.closest(".canvas-frame") ?? panelRef.current?.parentElement;
    return frame?.getBoundingClientRect() ?? null;
  }, []);
  const { offset, dragging, onPointerDown } = useViewportChromeDrag("properties", CAMERA_PROPERTIES_WIDTH, getBounds);

  if (!selectedCamera) return null;

  const camera = selectedCamera;
  const viewSnapshot = getCameraViewSnapshotFromShot(camera);
  const rotationDegrees = getCameraRotationDegrees(camera);
  const aspectRatio = camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const sensorFormat = camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const focalLengthMm = camera.focalLengthMm ?? 35;
  const handheldShake = camera.handheldShake ?? "off";

  function updatePosition(axis: Axis, value: string) {
    const position = replaceAxis(viewSnapshot.position, axis, finiteOr(value, viewSnapshot.position[axis]));
    updateCamera(camera.id, {
      transform: {
        ...camera.transform,
        position: getCameraRigPositionFromViewSnapshot({ ...viewSnapshot, position }),
      },
    });
  }

  function updateRotation(axis: Axis, value: string) {
    const nextRotation = replaceAxis(rotationDegrees, axis, finiteOr(value, rotationDegrees[axis]));
    const targetDistance = Math.max(
      viewSnapshot.position
        .map((coordinate, index) => (coordinate - camera.target[index]) ** 2)
        .reduce((sum, coordinate) => sum + coordinate, 0) ** 0.5,
      0.1,
    );
    updateCamera(camera.id, {
      targetMode: "manual",
      targetObjectId: null,
      target: getCameraTargetFromRotationDegrees(viewSnapshot.position, nextRotation, targetDistance),
    });
  }

  function updateFocalLength(value: string) {
    const nextFocalLength = Math.min(200, Math.max(12, finiteOr(value, focalLengthMm)));
    updateCamera(camera.id, {
      focalLengthMm: nextFocalLength,
      fov: getVerticalFovFromFocalLength(nextFocalLength, aspectRatio, sensorFormat),
    });
  }

  function updateAspectRatio(value: string) {
    const nextAspectRatio = value as DirectorCameraAspectRatio;
    updateCamera(camera.id, {
      aspectRatio: nextAspectRatio,
      fov: getVerticalFovFromFocalLength(focalLengthMm, nextAspectRatio, sensorFormat),
    });
  }

  return (
    <aside
      aria-label="相机快捷属性"
      className={`camera-viewport-properties${dragging ? " is-dragging" : ""}`}
      data-viewport-chrome="properties"
      ref={panelRef}
      style={
        {
          left: offset.x,
          top: offset.y,
          "--camera-viewport-properties-width": `${CAMERA_PROPERTIES_WIDTH}px`,
        } as CSSProperties
      }
    >
      <header
        aria-label="拖动相机属性面板"
        className="camera-viewport-properties-drag-handle"
        onPointerDown={onPointerDown}
      >
        <span>属性 · 相机</span>
        <Camera aria-hidden size={13} strokeWidth={1.8} />
      </header>
      <label className="camera-viewport-properties-name">
        <span>名称</span>
        <input
          aria-label="视口相机名称"
          value={camera.name}
          onChange={(event) => updateCamera(camera.id, { name: event.currentTarget.value })}
        />
      </label>
      <AxisRow label="位置" name="视口相机位置" values={viewSnapshot.position} onChange={updatePosition} />
      <AxisRow label="旋转" name="视口相机旋转" values={rotationDegrees} onChange={updateRotation} />
      <label className="camera-viewport-properties-field">
        <span>焦距</span>
        <span>
          <input
            aria-label="视口相机焦距"
            max="200"
            min="12"
            step="0.1"
            type="number"
            value={focalLengthMm}
            onChange={(event) => updateFocalLength(event.currentTarget.value)}
          />
          <small>mm</small>
        </span>
      </label>
      <label className="camera-viewport-properties-field">
        <span>宽高比</span>
        <select
          aria-label="视口相机宽高比"
          value={aspectRatio}
          onChange={(event) => updateAspectRatio(event.currentTarget.value)}
        >
          {DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="camera-viewport-properties-shake">
        <span>手持镜头晃动</span>
        <div aria-label="视口手持镜头晃动" role="group">
          {DIRECTOR_CAMERA_HANDHELD_SHAKE_OPTIONS.map((option) => (
            <button
              aria-pressed={handheldShake === option.id}
              key={option.id}
              type="button"
              onClick={() => updateCamera(camera.id, { handheldShake: option.id as DirectorCameraHandheldShake })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <button
        aria-label="移动当前相机"
        className="camera-viewport-properties-move"
        type="button"
        onClick={() => setTransformMode("translate")}
      >
        <Move3D aria-hidden size={13} strokeWidth={1.9} />
        移动机位
      </button>
    </aside>
  );
}
