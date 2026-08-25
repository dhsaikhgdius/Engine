import type { DirectorProject } from "../schema/directorProject";
import { getCameraRotationDegrees } from "../schema/cameraGeometry";
import { buildDirectorShotIr, type BuildDirectorShotIrOptions, type DirectorShotIrCamera } from "./shotIr";

/** One sample of a camera trajectory at a single frame. */
export interface DirectorCameraTrajectorySample {
  /** Frame number. */
  frame: number;
  /** Elapsed time from frame 0 in seconds. */
  timeSeconds: number;
  /** Camera world position in metres. */
  position: [number, number, number];
  /** Camera rotation in degrees. */
  rotationDegrees: [number, number, number];
  /** Look-at target in metres. */
  target: [number, number, number];
  /** Vertical field of view in degrees. */
  fov: number;
  /** Focal length in millimetres. */
  focalLengthMm: number;
  /** Aperture f-stop, or null if not set. */
  apertureFStop: number | null;
  /** Focus distance in metres, or null. */
  focusDistanceM: number | null;
  /** Shutter angle in degrees, or null. */
  shutterAngle: number | null;
  /** ISO sensitivity, or null. */
  iso: number | null;
  /** Anamorphic squeeze factor, or null. */
  anamorphicSqueeze: number | null;
}

/** Portable camera trajectory, exportable as a reproducible control signal. */
export interface DirectorCameraTrajectory {
  /** Schema version. */
  schemaVersion: 1;
  /** Contract identifier. */
  contract: "director-camera-trajectory-v1";
  /** The camera id. */
  cameraId: string;
  /** Frame rate. */
  fps: number;
  /** First frame of the trajectory. */
  frameStart: number;
  /** Last frame of the trajectory. */
  frameEnd: number;
  /** Coordinate system reference. */
  coordinateSystem: {
    handedness: "right";
    upAxis: "Y";
    forwardAxis: "-Z";
    linearUnit: "meter";
    rotationUnit: "degree";
  };
  /** Ordered samples, one per frame. */
  samples: DirectorCameraTrajectorySample[];
}

/** Options for building a camera trajectory. */
export interface BuildDirectorCameraTrajectoryOptions extends BuildDirectorShotIrOptions {
  /** Override the start frame of the trajectory. */
  frameStart?: number;
  /** Override the end frame of the trajectory. */
  frameEnd?: number;
  /** Prevent an accidental multi-hour browser export from locking the UI. */
  maxSamples?: number;
}

function resolveProductionRange(project: DirectorProject, options: BuildDirectorCameraTrajectoryOptions) {
  if (options.coverageShotId) {
    for (const sequence of project.production?.sequences ?? []) {
      const shot = sequence.shots.find((candidate) => candidate.id === options.coverageShotId);
      if (shot) return { frameStart: shot.frameStart, frameEnd: shot.frameEnd };
    }
  }
  if (options.takeId) {
    const take = project.production?.takes.find((candidate) => candidate.id === options.takeId);
    if (take) return { frameStart: take.frameStart, frameEnd: take.frameEnd };
  }
  const timeline = project.scene.timeline;
  const frame = options.frame ?? timeline?.currentFrame ?? 0;
  return timeline
    ? { frameStart: timeline.frameStart, frameEnd: timeline.frameEnd }
    : { frameStart: frame, frameEnd: frame };
}

function finiteInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer; received ${String(value)}.`);
  }
  return value;
}

function copyCameraForRotation(camera: DirectorShotIrCamera) {
  return {
    target: [...camera.target] as [number, number, number],
    transform: {
      position: [...camera.position] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
}

/**
 * Samples the exact same frame evaluator used by ShotIR/capture. The exported
 * trajectory is therefore a reproducible control signal rather than a UI
 * approximation of the camera path.
 *
 * @param project - The Director project.
 * @param options - Optional frame range, camera id, and maxSamples.
 * @returns A deterministic camera trajectory with one sample per frame.
 */
export function buildDirectorCameraTrajectory(
  project: DirectorProject,
  options: BuildDirectorCameraTrajectoryOptions = {},
): DirectorCameraTrajectory {
  const naturalRange = resolveProductionRange(project, options);
  const frameStart = finiteInteger(options.frameStart ?? naturalRange.frameStart, "Camera trajectory frameStart");
  const frameEnd = finiteInteger(options.frameEnd ?? naturalRange.frameEnd, "Camera trajectory frameEnd");
  if (frameEnd < frameStart) {
    throw new Error(`Camera trajectory frameEnd ${frameEnd} cannot be before frameStart ${frameStart}.`);
  }
  const maxSamples = options.maxSamples ?? 10_000;
  const sampleCount = frameEnd - frameStart + 1;
  if (!Number.isInteger(maxSamples) || maxSamples < 1 || sampleCount > maxSamples) {
    throw new Error(`Camera trajectory contains ${sampleCount} samples; the limit is ${String(maxSamples)}.`);
  }

  const samples: DirectorCameraTrajectorySample[] = [];
  let cameraId = "";
  let fps = 24;
  for (let frame = frameStart; frame <= frameEnd; frame += 1) {
    const shot = buildDirectorShotIr(project, {
      cameraId: options.cameraId,
      takeId: options.takeId,
      coverageShotId: options.coverageShotId,
      frame,
    });
    cameraId = shot.camera.id;
    fps = shot.fps;
    samples.push({
      frame,
      timeSeconds: shot.timeSeconds,
      position: [...shot.camera.position],
      rotationDegrees: getCameraRotationDegrees(copyCameraForRotation(shot.camera)),
      target: [...shot.camera.target],
      fov: shot.camera.fov,
      focalLengthMm: shot.camera.focalLengthMm,
      apertureFStop: shot.camera.apertureFStop ?? null,
      focusDistanceM: shot.camera.focusDistanceM ?? null,
      shutterAngle: shot.camera.shutterAngle ?? null,
      iso: shot.camera.iso ?? null,
      anamorphicSqueeze: shot.camera.anamorphicSqueeze ?? null,
    });
  }

  return {
    schemaVersion: 1,
    contract: "director-camera-trajectory-v1",
    cameraId,
    fps,
    frameStart,
    frameEnd,
    coordinateSystem: {
      handedness: "right",
      upAxis: "Y",
      forwardAxis: "-Z",
      linearUnit: "meter",
      rotationUnit: "degree",
    },
    samples,
  };
}
