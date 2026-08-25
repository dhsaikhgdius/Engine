import { MathUtils, Matrix4, PerspectiveCamera } from "three";
import {
  DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getDirectorCameraAspectValue,
  getDirectorCameraSensorGate,
  getFocalLengthFromVerticalFov,
  normalizeDirectorCameraOptics,
} from "./cameraGeometry";
import type { DirectorCameraShot } from "./directorProject";

export type DirectorAnamorphicProjectionInput = Pick<
  DirectorCameraShot,
  | "fov"
  | "focalLengthMm"
  | "sensorFormat"
  | "aspectRatio"
  | "apertureFStop"
  | "focusDistanceM"
  | "shutterAngle"
  | "iso"
  | "nearClipM"
  | "farClipM"
  | "anamorphicSqueeze"
>;

export interface DirectorAnamorphicProjectionMetadata {
  applied: boolean;
  squeeze: number;
  outputAspect: number;
  sensorFormat: NonNullable<DirectorCameraShot["sensorFormat"]>;
  focalLengthMm: number;
  /** Physical gate before optical desqueeze. */
  captureGateWidthMm: number;
  usedSensorHeightMm: number;
  compressedGateAspect: number;
  effectiveHorizontalGateWidthMm: number;
  verticalFovDegreesBefore: number;
  verticalFovDegreesAfter: number;
  horizontalFovDegreesBefore: number;
  horizontalFovDegreesAfter: number;
}

export interface DirectorAnamorphicSensorGate {
  squeeze: number;
  outputAspect: number;
  sensorFormat: NonNullable<DirectorCameraShot["sensorFormat"]>;
  captureGateWidthMm: number;
  usedSensorHeightMm: number;
  compressedGateAspect: number;
  effectiveHorizontalGateWidthMm: number;
}

export interface DirectorAnamorphicProjectionScope {
  metadata: DirectorAnamorphicProjectionMetadata;
  /** Idempotently restores both projection matrices byte-for-byte. */
  restore: () => void;
}

function horizontalFovFromProjectionScale(scaleX: number): number {
  if (!Number.isFinite(scaleX) || scaleX <= 0) return 0;
  return MathUtils.radToDeg(2 * Math.atan(1 / scaleX));
}

export function getDirectorCameraPhysicalFocalLength(input: DirectorAnamorphicProjectionInput): number {
  if (Number.isFinite(input.focalLengthMm)) return Math.min(200, Math.max(12, input.focalLengthMm!));
  if (Number.isFinite(input.fov)) {
    return getFocalLengthFromVerticalFov(
      input.fov,
      input.aspectRatio,
      input.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
    );
  }
  return DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM;
}

/** Physical filmback area used before desqueezing into the authored output. */
export function getDirectorAnamorphicSensorGate(
  input: DirectorAnamorphicProjectionInput,
): DirectorAnamorphicSensorGate {
  const squeeze = normalizeDirectorCameraOptics(input).anamorphicSqueeze;
  const sensorFormat = input.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const outputAspect = getDirectorCameraAspectValue(input.aspectRatio);
  const sensorGate = getDirectorCameraSensorGate(sensorFormat);
  const compressedGateAspect = outputAspect / squeeze;
  const usedSensorHeightMm = Math.min(sensorGate.height, sensorGate.width / compressedGateAspect);
  const captureGateWidthMm = Math.min(sensorGate.width, usedSensorHeightMm * compressedGateAspect);
  return {
    squeeze,
    outputAspect,
    sensorFormat,
    captureGateWidthMm,
    usedSensorHeightMm,
    compressedGateAspect,
    effectiveHorizontalGateWidthMm: captureGateWidthMm * squeeze,
  };
}

/**
 * Applies the optical horizontal field-of-view gain of an anamorphic lens.
 *
 * Director stores a desqueezed output aspect and a vertical FOV derived from
 * the selected filmback/focal length. Dividing projection X scale by the lens
 * squeeze keeps that vertical framing while widening horizontal coverage. The
 * camera's authored properties are not changed; only the two projection
 * matrices are scoped for the render.
 */
export function applyDirectorAnamorphicProjection(
  camera: PerspectiveCamera,
  input: DirectorAnamorphicProjectionInput,
): DirectorAnamorphicProjectionScope {
  const optics = normalizeDirectorCameraOptics(input);
  const squeeze = optics.anamorphicSqueeze;
  // The recorded image is compressed horizontally on the physical gate and
  // desqueezed into outputAspect for display. Fit that pre-desqueeze aspect
  // inside the filmback so geometry retains its proportions after desqueeze.
  const gate = getDirectorAnamorphicSensorGate(input);
  const { sensorFormat, outputAspect, compressedGateAspect, usedSensorHeightMm, captureGateWidthMm } = gate;
  const focalLengthMm = getDirectorCameraPhysicalFocalLength(input);
  const scaleXBefore = camera.projectionMatrix.elements[0];
  const scaleYBefore = camera.projectionMatrix.elements[5];
  const projectionBefore = camera.projectionMatrix.clone();
  const projectionInverseBefore = camera.projectionMatrixInverse.clone();
  let restored = false;

  if (Math.abs(squeeze - 1) > Number.EPSILON) {
    const verticalFovRadians = 2 * Math.atan(usedSensorHeightMm / (2 * focalLengthMm));
    const desiredScaleY = 1 / Math.tan(verticalFovRadians / 2);
    const framingScale = desiredScaleY / scaleYBefore;
    // Scale X and Y together. This produces the wider desqueezed field while
    // preserving round objects; changing X alone would leave a squeezed image.
    camera.projectionMatrix.elements[0] = scaleXBefore * framingScale;
    camera.projectionMatrix.elements[5] = desiredScaleY;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  const metadata: DirectorAnamorphicProjectionMetadata = {
    applied: Math.abs(squeeze - 1) > Number.EPSILON,
    squeeze,
    outputAspect,
    sensorFormat,
    focalLengthMm,
    captureGateWidthMm,
    usedSensorHeightMm,
    compressedGateAspect,
    effectiveHorizontalGateWidthMm: gate.effectiveHorizontalGateWidthMm,
    verticalFovDegreesBefore: horizontalFovFromProjectionScale(scaleYBefore),
    verticalFovDegreesAfter: horizontalFovFromProjectionScale(camera.projectionMatrix.elements[5]),
    horizontalFovDegreesBefore: horizontalFovFromProjectionScale(scaleXBefore),
    horizontalFovDegreesAfter: horizontalFovFromProjectionScale(camera.projectionMatrix.elements[0]),
  };

  return {
    metadata,
    restore: () => {
      if (restored) return;
      restored = true;
      camera.projectionMatrix.copy(projectionBefore);
      camera.projectionMatrixInverse.copy(projectionInverseBefore);
    },
  };
}

/** Runs one render with the anamorphic projection and always restores it. */
export function withDirectorAnamorphicProjection<T>(
  camera: PerspectiveCamera,
  input: DirectorAnamorphicProjectionInput,
  render: (metadata: DirectorAnamorphicProjectionMetadata) => T,
): T {
  const scope = applyDirectorAnamorphicProjection(camera, input);
  try {
    return render(scope.metadata);
  } finally {
    scope.restore();
  }
}

/** Utility used by tests and integrations that need a defensive matrix copy. */
export function copyDirectorCameraProjection(camera: PerspectiveCamera): {
  projectionMatrix: Matrix4;
  projectionMatrixInverse: Matrix4;
} {
  return {
    projectionMatrix: camera.projectionMatrix.clone(),
    projectionMatrixInverse: camera.projectionMatrixInverse.clone(),
  };
}
