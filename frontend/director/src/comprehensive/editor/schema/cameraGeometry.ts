import { Euler, PerspectiveCamera, Vector3 } from "three";
import type {
  DirectorCameraAction,
  DirectorCameraAspectRatio,
  DirectorCameraHandheldShake,
  DirectorCameraSensorFormat,
  DirectorCameraShot,
} from "./directorProject";

export interface CameraViewSnapshot {
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

export const VIEWPORT_CAMERA_ASPECT = 16 / 9;
export const VIEWPORT_CAMERA_VISUAL_SCALE = 0.8;
export const VIEWPORT_CAMERA_FRUSTUM_DEPTH = 5.2 * VIEWPORT_CAMERA_VISUAL_SCALE;
export const VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH = 3.2 * VIEWPORT_CAMERA_VISUAL_SCALE;
/** @deprecated Prefer DIRECTOR_CAMERA_SENSOR_FORMATS.fullFrame.width. */
export const DIRECTOR_CAMERA_SENSOR_WIDTH_MM = 36;
export const DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM = 35;
export const DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT: DirectorCameraSensorFormat = "fullFrame";
export const DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO: DirectorCameraAspectRatio = "16:9";
export const DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE: DirectorCameraHandheldShake = "off";
export const DEFAULT_DIRECTOR_CAMERA_ACTION: DirectorCameraAction = { mode: "still" };

export const DIRECTOR_CAMERA_OPTICS_LIMITS = {
  apertureFStop: { min: 0.7, max: 64 },
  focusDistanceM: { min: 0.01, max: 10_000 },
  shutterAngle: { min: 1, max: 360 },
  iso: { min: 25, max: 102_400 },
  nearClipM: { min: 0.001, max: 100 },
  farClipM: { min: 1, max: 1_000_000 },
  anamorphicSqueeze: { min: 1, max: 2.5 },
} as const;

export const DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP = 2.8;
export const DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M = 5;
export const DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE = 180;
export const DEFAULT_DIRECTOR_CAMERA_ISO = 800;
// Match Three.js PerspectiveCamera defaults so legacy scenes keep the exact
// clipping behaviour they had before these values became authorable.
export const DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M = 0.1;
export const DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M = 2_000;
export const DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE = 1;

export interface DirectorCameraOptics {
  apertureFStop: number;
  focusDistanceM: number;
  shutterAngle: number;
  iso: number;
  nearClipM: number;
  farClipM: number;
  anamorphicSqueeze: number;
}

function normalizeOptic(value: number | undefined, fallback: number, min: number, max: number) {
  const finite = Number.isFinite(value) ? value! : fallback;
  return Math.min(max, Math.max(min, finite));
}

/**
 * Supplies stable defaults for pre-optics projects and bounds external input.
 * Aperture/focus/shutter/ISO/squeeze remain portable metadata; near/far are
 * consumed by the live Three.js camera and capture cameras.
 */
export function normalizeDirectorCameraOptics(
  camera: Pick<
    DirectorCameraShot,
    "apertureFStop" | "focusDistanceM" | "shutterAngle" | "iso" | "nearClipM" | "farClipM" | "anamorphicSqueeze"
  >,
): DirectorCameraOptics {
  const nearClipM = normalizeOptic(
    camera.nearClipM,
    DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
    DIRECTOR_CAMERA_OPTICS_LIMITS.nearClipM.min,
    DIRECTOR_CAMERA_OPTICS_LIMITS.nearClipM.max,
  );
  const authoredFarClipM = normalizeOptic(
    camera.farClipM,
    DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
    DIRECTOR_CAMERA_OPTICS_LIMITS.farClipM.min,
    DIRECTOR_CAMERA_OPTICS_LIMITS.farClipM.max,
  );

  return {
    apertureFStop: normalizeOptic(
      camera.apertureFStop,
      DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
      DIRECTOR_CAMERA_OPTICS_LIMITS.apertureFStop.min,
      DIRECTOR_CAMERA_OPTICS_LIMITS.apertureFStop.max,
    ),
    focusDistanceM: normalizeOptic(
      camera.focusDistanceM,
      DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
      DIRECTOR_CAMERA_OPTICS_LIMITS.focusDistanceM.min,
      DIRECTOR_CAMERA_OPTICS_LIMITS.focusDistanceM.max,
    ),
    shutterAngle: normalizeOptic(
      camera.shutterAngle,
      DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
      DIRECTOR_CAMERA_OPTICS_LIMITS.shutterAngle.min,
      DIRECTOR_CAMERA_OPTICS_LIMITS.shutterAngle.max,
    ),
    iso: normalizeOptic(
      camera.iso,
      DEFAULT_DIRECTOR_CAMERA_ISO,
      DIRECTOR_CAMERA_OPTICS_LIMITS.iso.min,
      DIRECTOR_CAMERA_OPTICS_LIMITS.iso.max,
    ),
    nearClipM,
    farClipM: Math.max(authoredFarClipM, nearClipM + DIRECTOR_CAMERA_OPTICS_LIMITS.nearClipM.min),
    anamorphicSqueeze: normalizeOptic(
      camera.anamorphicSqueeze,
      DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
      DIRECTOR_CAMERA_OPTICS_LIMITS.anamorphicSqueeze.min,
      DIRECTOR_CAMERA_OPTICS_LIMITS.anamorphicSqueeze.max,
    ),
  };
}

export interface DirectorCameraSensorGate {
  id: DirectorCameraSensorFormat;
  label: string;
  width: number;
  height: number;
}

/** Physical capture gates in millimetres, matching the Blockout camera model. */
export const DIRECTOR_CAMERA_SENSOR_FORMATS: Record<DirectorCameraSensorFormat, DirectorCameraSensorGate> = {
  super16: { id: "super16", label: "Super 16", width: 12.52, height: 7.41 },
  super35: { id: "super35", label: "Super 35", width: 24.89, height: 18.66 },
  fullFrame: { id: "fullFrame", label: "Full Frame / VistaVision", width: 36, height: 24 },
  imax65: { id: "imax65", label: "65mm / IMAX", width: 52.63, height: 23.01 },
};

export const DIRECTOR_CAMERA_SENSOR_FORMAT_OPTIONS = Object.values(DIRECTOR_CAMERA_SENSOR_FORMATS);

export const DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS: Array<{
  id: DirectorCameraAspectRatio;
  label: string;
  value: number;
}> = [
  { id: "16:9", label: "16:9", value: 16 / 9 },
  { id: "9:16", label: "9:16", value: 9 / 16 },
  { id: "1:1", label: "1:1", value: 1 },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "1.85:1", label: "1.85:1", value: 1.85 },
  { id: "2.39:1", label: "2.39:1", value: 2.39 },
];

export const DIRECTOR_CAMERA_HANDHELD_SHAKE_OPTIONS: Array<{
  id: DirectorCameraHandheldShake;
  label: string;
}> = [
  { id: "off", label: "关" },
  { id: "subtle", label: "轻微" },
  { id: "medium", label: "中" },
  { id: "strong", label: "强烈" },
];

export function getDirectorCameraHandheldShake(
  shake: DirectorCameraHandheldShake = DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
  elapsedSeconds: number,
) {
  const strength = {
    off: 0,
    subtle: 0.0035,
    medium: 0.008,
    strong: 0.016,
  }[shake];
  if (!strength)
    return { position: [0, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number] };

  const time = Math.max(0, elapsedSeconds);
  return {
    position: [
      Math.sin(time * 1.83) * strength,
      Math.sin(time * 2.17 + 0.8) * strength * 0.72,
      Math.sin(time * 1.31 + 1.4) * strength * 0.42,
    ] as [number, number, number],
    target: [Math.sin(time * 1.58 + 0.55) * strength * 0.7, Math.sin(time * 1.96 + 1.2) * strength * 0.45, 0] as [
      number,
      number,
      number,
    ],
  };
}

const FLICK_REFERENCE_CAMERA_POSITION: [number, number, number] = [-0.843, 1.676, 0.675];
const FLICK_REFERENCE_CAMERA_ROTATION_DEGREES: [number, number, number] = [-8.658, -13.209, -1.993];

function toTuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(6))) as [number, number, number];
}

function clampFocalLength(value: number) {
  return Math.min(200, Math.max(12, value));
}

function clampFov(value: number) {
  return Math.min(160, Math.max(5, value));
}

export function getDirectorCameraAspectValue(
  aspectRatio: DirectorCameraAspectRatio = DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
) {
  return DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS.find((option) => option.id === aspectRatio)?.value ?? 16 / 9;
}

export function getDirectorCameraSensorGate(
  sensorFormat: DirectorCameraSensorFormat = DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
) {
  return DIRECTOR_CAMERA_SENSOR_FORMATS[sensorFormat] ?? DIRECTOR_CAMERA_SENSOR_FORMATS.fullFrame;
}

/**
 * Fits the requested output aspect inside the physical gate. This is a crop,
 * never an expansion: portrait and 4:3 outputs retain the gate's full height,
 * while wide outputs crop the top and bottom when necessary.
 */
export function getDirectorCameraUsedSensorHeight(
  aspectRatio: DirectorCameraAspectRatio = DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  sensorFormat: DirectorCameraSensorFormat = DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
) {
  const sensor = getDirectorCameraSensorGate(sensorFormat);
  return Math.min(sensor.height, sensor.width / getDirectorCameraAspectValue(aspectRatio));
}

/** Keeps externally-authored scene JSON inside the supported Stage range. */
export function normalizeDirectorCameraAction(action: DirectorCameraAction | undefined): DirectorCameraAction {
  if (!action) return DEFAULT_DIRECTOR_CAMERA_ACTION;
  const mode = action.mode;
  if (mode === "path") {
    return {
      mode,
      path: {
        speed: Math.min(4, Math.max(0.1, Number.isFinite(action.path?.speed) ? action.path!.speed : 1)),
        lockTarget: Boolean(action.path?.lockTarget),
        targetObjectId: action.path?.targetObjectId ?? null,
      },
    };
  }
  if (mode === "follow") {
    const positionOffset = action.follow?.positionOffset;
    const targetOffset = action.follow?.targetOffset;
    const finiteTuple = (value: [number, number, number] | undefined) =>
      value && value.length === 3 && value.every(Number.isFinite)
        ? ([...value] as [number, number, number])
        : ([0, 0, 0] as [number, number, number]);
    return {
      mode,
      follow: {
        targetObjectId: action.follow?.targetObjectId ?? null,
        positionOffset: finiteTuple(positionOffset),
        targetOffset: finiteTuple(targetOffset),
      },
    };
  }
  return mode === "transform" ? { mode } : DEFAULT_DIRECTOR_CAMERA_ACTION;
}

/** Converts a physical focal length and crop gate into Three.js's vertical FOV. */
export function getVerticalFovFromFocalLength(
  focalLengthMm: number,
  aspectRatio: DirectorCameraAspectRatio = DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  sensorFormat: DirectorCameraSensorFormat = DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
) {
  const focal = clampFocalLength(
    Number.isFinite(focalLengthMm) ? focalLengthMm : DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  );
  const sensorHeight = getDirectorCameraUsedSensorHeight(aspectRatio, sensorFormat);
  return Number(((Math.atan(sensorHeight / (2 * focal)) * 2 * 180) / Math.PI).toFixed(6));
}

/** Preserves legacy FOV scenes while exposing their equivalent focal length in the inspector. */
export function getFocalLengthFromVerticalFov(
  fov: number,
  aspectRatio: DirectorCameraAspectRatio = DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  sensorFormat: DirectorCameraSensorFormat = DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
) {
  const safeFov = clampFov(
    Number.isFinite(fov)
      ? fov
      : getVerticalFovFromFocalLength(DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM, aspectRatio, sensorFormat),
  );
  const sensorHeight = getDirectorCameraUsedSensorHeight(aspectRatio, sensorFormat);
  return Number(clampFocalLength(sensorHeight / (2 * Math.tan((safeFov * Math.PI) / 360))).toFixed(3));
}

/** Focal length the compact Stage contract must carry to reproduce this shot on its full-frame-only contract. */
export function getEquivalentFullFrameFocalLength(
  camera: Pick<DirectorCameraShot, "fov" | "focalLengthMm" | "aspectRatio" | "sensorFormat">,
) {
  const aspectRatio = camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const sourceFov = Number.isFinite(camera.focalLengthMm)
    ? getVerticalFovFromFocalLength(
        camera.focalLengthMm!,
        aspectRatio,
        camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
      )
    : camera.fov;
  return getFocalLengthFromVerticalFov(sourceFov, aspectRatio, DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT);
}

export function getCameraTargetFromRotationDegrees(
  position: [number, number, number],
  rotationDegrees: [number, number, number],
  distance = VIEWPORT_CAMERA_FRUSTUM_DEPTH,
) {
  const rotation = new Euler(...(rotationDegrees.map((value) => (value * Math.PI) / 180) as [number, number, number]));
  const direction = new Vector3(0, 0, -1).applyEuler(rotation).normalize();
  return toTuple(new Vector3(...position).add(direction.multiplyScalar(Math.max(distance, 0.1))));
}

export function getCameraRotationDegrees(camera: Pick<DirectorCameraShot, "transform" | "target">) {
  const view = getCameraViewSnapshotFromShot(camera as DirectorCameraShot);
  const object = new PerspectiveCamera();
  object.position.set(...view.position);
  object.lookAt(...view.target);
  const lookRotation = object.rotation;
  return [
    Number(((lookRotation.x * 180) / Math.PI).toFixed(3)),
    Number(((lookRotation.y * 180) / Math.PI).toFixed(3)),
    Number(((lookRotation.z * 180) / Math.PI).toFixed(3)),
  ] as [number, number, number];
}

export const DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT: CameraViewSnapshot = {
  fov: getVerticalFovFromFocalLength(DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM),
  position: FLICK_REFERENCE_CAMERA_POSITION,
  target: getCameraTargetFromRotationDegrees(FLICK_REFERENCE_CAMERA_POSITION, FLICK_REFERENCE_CAMERA_ROTATION_DEGREES),
};

function getForwardDirection(position: [number, number, number], target: [number, number, number]) {
  const direction = new Vector3(...target).sub(new Vector3(...position));
  return direction.lengthSq() === 0 ? new Vector3(0, 0, -1) : direction.normalize();
}

export function getCameraViewSnapshotFromShot(camera: DirectorCameraShot): CameraViewSnapshot {
  const rigPosition = new Vector3(...camera.transform.position);
  const forward = getForwardDirection(camera.transform.position, camera.target);
  const viewPosition = rigPosition.add(forward.multiplyScalar(VIEWPORT_CAMERA_FRUSTUM_DEPTH));

  return {
    fov: camera.fov,
    position: toTuple(viewPosition),
    target: camera.target,
  };
}

export function getCameraRigPositionFromViewSnapshot(snapshot: CameraViewSnapshot): [number, number, number] {
  const viewPosition = new Vector3(...snapshot.position);
  const forward = getForwardDirection(snapshot.position, snapshot.target);
  const rigPosition = viewPosition.sub(forward.multiplyScalar(VIEWPORT_CAMERA_FRUSTUM_DEPTH));

  return toTuple(rigPosition);
}
