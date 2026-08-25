import {
  DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
  DEFAULT_DIRECTOR_CAMERA_ISO,
  DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
  normalizeDirectorCameraOptics,
} from "./cameraGeometry";
import type { DirectorCameraShot } from "./directorProject";
import { normalizeDirectorFps } from "../timeline/frameTime";

export const DEFAULT_DIRECTOR_CAMERA_EXPOSURE_FPS = 24;

/** A symmetric ±10-stop guard keeps renderer exposure finite and practical. */
export const DIRECTOR_RENDERER_EXPOSURE_MULTIPLIER_LIMITS = {
  min: 1 / 1_024,
  max: 1_024,
} as const;

export interface DirectorCameraExposureMetrics {
  apertureFStop: number;
  iso: number;
  shutterAngle: number;
  fps: number;
  shutterSeconds: number;
  /** Exposure value normalized to ISO 100: log2((N² / t) × (100 / ISO)). */
  ev100: number;
  /**
   * Relative image exposure for a renderer. The current Director default
   * (f/2.8, ISO 800, 180° at 24 fps) is exactly 1.0.
   */
  rendererExposureMultiplier: number;
}

type DirectorCameraExposureInput = Pick<DirectorCameraShot, "apertureFStop" | "iso" | "shutterAngle">;

function imageExposure(apertureFStop: number, iso: number, shutterSeconds: number) {
  return (iso * shutterSeconds) / apertureFStop ** 2;
}

const REFERENCE_SHUTTER_SECONDS = DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE / 360 / DEFAULT_DIRECTOR_CAMERA_EXPOSURE_FPS;
const REFERENCE_IMAGE_EXPOSURE = imageExposure(
  DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
  DEFAULT_DIRECTOR_CAMERA_ISO,
  REFERENCE_SHUTTER_SECONDS,
);

/**
 * Converts persisted cinema-camera controls into deterministic exposure math.
 * This function does not mutate the shot and does not imply that a renderer
 * has consumed the returned multiplier.
 */
export function calculateDirectorCameraExposure(
  camera: DirectorCameraExposureInput,
  fps = DEFAULT_DIRECTOR_CAMERA_EXPOSURE_FPS,
): DirectorCameraExposureMetrics {
  const optics = normalizeDirectorCameraOptics(camera);
  const normalizedFps = normalizeDirectorFps(fps, DEFAULT_DIRECTOR_CAMERA_EXPOSURE_FPS);
  const shutterSeconds = optics.shutterAngle / 360 / normalizedFps;
  const ev100 = Math.log2((optics.apertureFStop ** 2 / shutterSeconds) * (100 / optics.iso));
  const rawMultiplier = imageExposure(optics.apertureFStop, optics.iso, shutterSeconds) / REFERENCE_IMAGE_EXPOSURE;
  const rendererExposureMultiplier = Math.min(
    DIRECTOR_RENDERER_EXPOSURE_MULTIPLIER_LIMITS.max,
    Math.max(DIRECTOR_RENDERER_EXPOSURE_MULTIPLIER_LIMITS.min, rawMultiplier),
  );

  return {
    apertureFStop: optics.apertureFStop,
    iso: optics.iso,
    shutterAngle: optics.shutterAngle,
    fps: normalizedFps,
    shutterSeconds,
    ev100,
    rendererExposureMultiplier,
  };
}
