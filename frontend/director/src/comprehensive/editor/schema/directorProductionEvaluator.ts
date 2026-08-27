/**
 * Frame evaluator for the production layer: resolves which take, coverage
 * shot, and camera are active for a given request and samples every entity
 * (and the camera) at that frame through the shared animation evaluator.
 * Pure and side-effect free — the gateway's shot rendering and agent
 * inspection tools call this to get the exact pose the viewport would show.
 */
import { evaluateDirectorCameraAtFrame, evaluateDirectorObjectAtFrame } from "./directorAnimation";
import { findDirectorCameraById } from "./cameraIdentity";
import type {
  DirectorCameraShot,
  DirectorCoverageSequence,
  DirectorCoverageShot,
  DirectorObject,
  DirectorPerformanceTake,
  DirectorProject,
} from "./directorProject";
import { createDefaultDirectorProduction } from "./directorProduction";
import { frameRateToNumber, normalizeDirectorTimebase } from "../timeline/frameRate";

export interface EvaluateDirectorProductionAtFrameOptions {
  takeId?: string;
  coverageShotId?: string;
  cameraId?: string;
  frame?: number;
}

export interface EvaluatedDirectorProductionFrame {
  take: DirectorPerformanceTake;
  sequence: DirectorCoverageSequence | null;
  shot: DirectorCoverageShot | null;
  camera: DirectorCameraShot;
  objects: DirectorObject[];
  fps: number;
  frame: number;
}

function findCoverageShot(
  sequences: DirectorCoverageSequence[],
  shotId: string,
): { sequence: DirectorCoverageSequence; shot: DirectorCoverageShot } | null {
  for (const sequence of sequences) {
    const shot = sequence.shots.find((candidate) => candidate.id === shotId);
    if (shot) return { sequence, shot };
  }
  return null;
}

function assertFrameInRange(frame: number, start: number, end: number, label: string) {
  if (!Number.isInteger(frame) || frame < start || frame > end) {
    throw new Error(`${label} 帧 ${frame} 不在 ${start}-${end} 范围内`);
  }
}

/**
 * Pure exact-frame production evaluator. A take-owned entity track replaces
 * the scene object's compatibility animation before evaluation; a coverage
 * shot selects the camera that evaluates against those same-frame subjects.
 */
export function evaluateDirectorProductionAtFrame(
  project: DirectorProject,
  options: EvaluateDirectorProductionAtFrameOptions = {},
): EvaluatedDirectorProductionFrame {
  const requestedCamera = options.cameraId ? findDirectorCameraById(project, options.cameraId) : undefined;
  if (options.cameraId && !requestedCamera) {
    throw new Error(`Coverage camera "${options.cameraId}" 不存在`);
  }
  const requestedCameraId = requestedCamera?.id;
  const production = project.production ?? createDefaultDirectorProduction(project);
  const activeSequence =
    production.sequences.find((sequence) => sequence.id === production.activeSequenceId) ??
    production.sequences[0] ??
    null;
  const selectedCoverage = options.coverageShotId
    ? findCoverageShot(production.sequences, options.coverageShotId)
    : activeSequence
      ? {
          sequence: activeSequence,
          shot: options.takeId
            ? (activeSequence.shots.find((shot) => shot.takeId === options.takeId) ?? null)
            : (activeSequence.shots[0] ?? null),
        }
      : null;

  if (options.coverageShotId && !selectedCoverage) {
    throw new Error(`CoverageShot "${options.coverageShotId}" 不存在`);
  }

  const sequence = selectedCoverage?.sequence ?? activeSequence;
  const shot = selectedCoverage?.shot ?? null;
  if (shot && options.takeId && shot.takeId !== options.takeId) {
    throw new Error(`CoverageShot "${shot.id}" 引用 take "${shot.takeId}"，与请求的 "${options.takeId}" 不一致`);
  }
  if (shot && requestedCameraId && shot.cameraId !== requestedCameraId) {
    throw new Error(`CoverageShot "${shot.id}" 引用 camera "${shot.cameraId}"，与请求的 "${options.cameraId}" 不一致`);
  }

  const takeId = shot?.takeId ?? options.takeId ?? production.activeTakeId;
  const take = production.takes.find((candidate) => candidate.id === takeId) ?? production.takes[0];
  if (!take) throw new Error("Director production 没有可求值的 PerformanceTake");
  if (takeId && take.id !== takeId) throw new Error(`PerformanceTake "${takeId}" 不存在`);

  const frame = options.frame ?? shot?.frameStart ?? project.scene.timeline?.currentFrame ?? take.frameStart;
  assertFrameInRange(frame, take.frameStart, take.frameEnd, `PerformanceTake "${take.id}"`);
  if (shot) assertFrameInRange(frame, shot.frameStart, shot.frameEnd, `CoverageShot "${shot.id}"`);

  const timeline = project.scene.timeline;
  const fps = Math.max(1, frameRateToNumber(normalizeDirectorTimebase(timeline?.timebase, timeline?.fps ?? 24).rate));
  const takeTracksByObjectId = new Map(take.entityTracks.map((track) => [track.objectId, track]));
  let objects = project.objects.map((object) => {
    const takeTrack = takeTracksByObjectId.get(object.id);
    const performanceObject = takeTrack ? { ...object, animation: takeTrack.animation } : object;
    return evaluateDirectorObjectAtFrame(performanceObject, frame, fps);
  });

  const cameraId = shot?.cameraId ?? requestedCameraId ?? project.activeCameraId ?? project.cameras[0]?.id;
  const sourceCamera = cameraId ? findDirectorCameraById(project, cameraId) : undefined;
  if (!sourceCamera) throw new Error(`Coverage camera "${cameraId ?? ""}" 不存在`);

  const camera = evaluateDirectorCameraAtFrame(
    sourceCamera,
    frame,
    objects.map((object) => ({ id: object.id, position: object.transform.position })),
  );
  objects = objects.map((object) =>
    object.kind === "camera" && object.linkedCameraId === camera.id
      ? { ...object, transform: camera.transform }
      : object,
  );

  return { take, sequence, shot, camera, objects, fps, frame };
}
