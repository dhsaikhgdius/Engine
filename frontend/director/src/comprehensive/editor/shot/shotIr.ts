import { compareText } from "../../../../../../packages/protocol/src/primitives";
import { stableLexicalJson } from "../../../../../../packages/protocol/src/stableJson";
import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getCameraViewSnapshotFromShot,
  getDirectorCameraAspectValue,
  getDirectorCameraSensorGate,
  getDirectorCameraUsedSensorHeight,
  getFocalLengthFromVerticalFov,
  normalizeDirectorCameraOptics,
} from "../schema/cameraGeometry";
import { evaluateDirectorCameraAtFrame, evaluateDirectorObjectAtFrame } from "../schema/directorAnimation";
import { findDirectorCameraById } from "../schema/cameraIdentity";
import { evaluateDirectorProductionAtFrame } from "../schema/directorProductionEvaluator";
import type {
  CharacterBodyType,
  DirectorCharacterIkState,
  CharacterRigType,
  DirectorCameraActionMode,
  DirectorCameraAspectRatio,
  DirectorCameraSensorFormat,
  DirectorObjectKind,
  DirectorProject,
  DirectorReferenceBinding,
  DirectorReferenceKind,
  DirectorTransform,
} from "../schema/directorProject";
import { frameRateToNumber, normalizeDirectorTimebase, serializeDirectorFrameRate } from "../timeline/frameRate";
import { formatDirectorTimelineTimecode } from "../timeline/timecode";
import { resolveCharacterPoseControls } from "../presets/mannequinPosePresets";

type Tuple3 = [number, number, number];

/** Options for building a ShotIR descriptor. */
export interface BuildDirectorShotIrOptions {
  /** Optional camera id; defaults to the active camera. */
  cameraId?: string;
  /** Optional production take id for evaluated frame resolution. */
  takeId?: string;
  /** Optional coverage shot id for evaluated frame resolution. */
  coverageShotId?: string;
  /** Frame number; defaults to the timeline current frame. */
  frame?: number;
}

/** A portable reference to an external asset or binding. */
export interface DirectorShotIrReference {
  /** Stable id. */
  id: string;
  /** Reference kind. */
  kind: DirectorReferenceKind;
  /** The reference value. */
  ref: string;
}

/** A character rig pose resolved at evaluation time. */
export interface DirectorShotIrRigPose {
  /** The rig type the pose applies to. */
  rigType: CharacterRigType;
  /** Preset pose id, or null. */
  posePresetId: string | null;
  /** Resolved control values. */
  controls: Record<string, number>;
  /** IK effector targets, if any. */
  ik?: DirectorCharacterIkState;
}

/** An evaluated scene object at the shot frame. */
export interface DirectorShotIrObject {
  /** Stable object id. */
  id: string;
  /** Display name. */
  name: string;
  /** Object kind (character, prop, etc.). */
  kind: Exclude<DirectorObjectKind, "camera">;
  /** Evaluated world transform. */
  transform: DirectorTransform;
  /** Body type for characters. */
  bodyType?: CharacterBodyType;
  /** Reference to the asset this object uses. */
  assetRefId?: string;
  /** Resolved rig pose, if the object has a character rig. */
  rigPose?: DirectorShotIrRigPose;
  /** Id of the look-at target object, if any. */
  lookTargetObjectId?: string | null;
  /** Portable references to external assets. */
  referenceRefs: DirectorShotIrReference[];
}

/** Sensor gate dimensions computed from the camera's format and aspect ratio. */
export interface DirectorShotIrCameraSensor {
  /** Sensor format identifier. */
  format: DirectorCameraSensorFormat;
  /** Full gate width in mm. */
  gateWidthMm: number;
  /** Full gate height in mm. */
  gateHeightMm: number;
  /** Used width in mm, accounting for aspect ratio cropping. */
  usedWidthMm: number;
  /** Used height in mm, accounting for aspect ratio cropping. */
  usedHeightMm: number;
}

/** The evaluated camera at the shot frame. */
export interface DirectorShotIrCamera {
  /** Stable camera id. */
  id: string;
  /** Display name. */
  name: string;
  /** World position in metres. */
  position: Tuple3;
  /** Look-at target in metres. */
  target: Tuple3;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Focal length in millimetres. */
  focalLengthMm: number;
  /** Added compatibly in ShotIR v1; builders always emit these normalized values. */
  apertureFStop?: number;
  focusDistanceM?: number;
  shutterAngle?: number;
  iso?: number;
  nearClipM?: number;
  farClipM?: number;
  anamorphicSqueeze?: number;
  /** Aspect ratio identifier. */
  aspectRatio: DirectorCameraAspectRatio;
  /** Computed aspect ratio value (width / height). */
  aspectValue: number;
  /** Sensor gate dimensions. */
  sensor: DirectorShotIrCameraSensor;
  /** Camera action mode (still, follow, path, etc.). */
  actionMode: DirectorCameraActionMode;
  /** Whether the target is manual or tracking an object. */
  targetMode: "manual" | "object";
  /** Id of the target object, if targetMode is "object". */
  targetObjectId?: string | null;
  /** Portable references to external assets. */
  referenceRefs: DirectorShotIrReference[];
}

/** Production context when the shot was evaluated through a take/coverage. */
export interface DirectorShotIrProductionContext {
  /** The take id. */
  takeId: string;
  /** The sequence id, or null. */
  sequenceId: string | null;
  /** The coverage shot id, or null. */
  coverageShotId: string | null;
}

/** Portable, deterministic description of one evaluated Director shot. */
export interface DirectorShotIr {
  /** Schema version. */
  schemaVersion: 1;
  /** Stable content-addressed id. */
  id: string;
  /** Deterministic fingerprint of the revision source. */
  revisionFingerprint: string;
  /** Project version at evaluation time. */
  projectVersion: DirectorProject["version"];
  /** Frame rate. */
  fps: number;
  /** Added compatibly in ShotIR v1; builders always emit this rational timebase. */
  timebase?: {
    rate: string;
    numerator: number;
    denominator: number;
    dropFrame: boolean;
    startTimecode: string;
  };
  /** Evaluated frame number. */
  frame: number;
  /** Elapsed time from frame 0 in seconds. */
  timeSeconds: number;
  /** SMPTE timecode at `frame`; builders always emit it. */
  timecode?: string;
  /** Production context, present when evaluated through a take/coverage. */
  production?: DirectorShotIrProductionContext;
  /** The evaluated camera. */
  camera: DirectorShotIrCamera;
  /** All visible, non-camera objects in the scene. */
  objects: DirectorShotIrObject[];
}

const DEFAULT_FPS = 24;
const DATA_OR_BLOB_URL = /^(?:data|blob):/i;

function copyTuple(value: Tuple3): Tuple3 {
  return [value[0], value[1], value[2]];
}

function copyTransform(transform: DirectorTransform): DirectorTransform {
  return {
    position: copyTuple(transform.position),
    rotation: copyTuple(transform.rotation),
    scale: copyTuple(transform.scale),
  };
}

function copySortedControls(controls: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(controls).sort(([left], [right]) => compareText(left, right)));
}

function copyCharacterIk(ik: DirectorCharacterIkState | undefined): DirectorCharacterIkState | undefined {
  if (!ik) return undefined;
  const copied: DirectorCharacterIkState = {};
  (["leftHand", "rightHand", "leftFoot", "rightFoot"] as const).forEach((effector) => {
    const target = ik[effector];
    if (!target) return;
    copied[effector] = {
      target: copyTuple(target.target),
      pole: copyTuple(target.pole),
      weight: target.weight,
      reachClamp: target.reachClamp,
    };
  });
  return copied;
}

function getPortableReferenceRefs(bindings: DirectorReferenceBinding[] | undefined): DirectorShotIrReference[] {
  return (bindings ?? [])
    .filter((binding) => !DATA_OR_BLOB_URL.test(binding.ref.trim()))
    .map((binding) => ({ id: binding.id, kind: binding.kind, ref: binding.ref }))
    .sort(
      (left, right) =>
        compareText(left.id, right.id) || compareText(left.kind, right.kind) || compareText(left.ref, right.ref),
    );
}

function getDeterministicFingerprint(value: unknown): string {
  const serialized = stableLexicalJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function resolveFrame(project: DirectorProject, requestedFrame: number | undefined): number {
  const timeline = project.scene.timeline;
  const frame = requestedFrame ?? timeline?.currentFrame ?? 0;
  if (!Number.isFinite(frame) || !Number.isInteger(frame) || frame < 0) {
    throw new Error(`ShotIR frame must be a non-negative finite integer; received ${String(frame)}.`);
  }
  if (timeline && (frame < timeline.frameStart || frame > timeline.frameEnd)) {
    throw new Error(`ShotIR frame ${frame} is outside the timeline range ${timeline.frameStart}-${timeline.frameEnd}.`);
  }
  return frame;
}

function resolveFps(project: DirectorProject): number {
  const timeline = project.scene.timeline;
  const fps = timeline
    ? frameRateToNumber(normalizeDirectorTimebase(timeline.timebase, timeline.fps).rate)
    : DEFAULT_FPS;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`ShotIR fps must be a finite number greater than zero; received ${String(fps)}.`);
  }
  return fps;
}

function resolveCamera(project: DirectorProject, requestedCameraId: string | undefined) {
  const cameraId = requestedCameraId ?? project.activeCameraId ?? project.cameras[0]?.id;
  if (!cameraId) {
    throw new Error("ShotIR requires a camera, but the project has no active or available camera.");
  }
  const camera = findDirectorCameraById(project, cameraId);
  if (!camera) {
    throw new Error(`ShotIR camera "${cameraId}" does not exist in the project.`);
  }
  return camera;
}

/**
 * Builds a portable, deterministic description of one evaluated Director shot.
 *
 * It is deliberately derived-only: no project object is mutated and binary or
 * URL-backed capture payloads never cross this boundary.
 *
 * @param project - The Director project.
 * @param options - Optional camera, take, coverage, and frame overrides.
 * @returns A deterministic ShotIR descriptor.
 */
export function buildDirectorShotIr(
  project: DirectorProject,
  options: BuildDirectorShotIrOptions = {},
): DirectorShotIr {
  const usesProduction = options.takeId !== undefined || options.coverageShotId !== undefined;
  const productionFrame = usesProduction
    ? evaluateDirectorProductionAtFrame(project, {
        takeId: options.takeId,
        coverageShotId: options.coverageShotId,
        cameraId: options.cameraId,
        frame: options.frame,
      })
    : null;
  const frame = productionFrame?.frame ?? resolveFrame(project, options.frame);
  const fps = productionFrame?.fps ?? resolveFps(project);
  const timebase = normalizeDirectorTimebase(project.scene.timeline?.timebase, fps);
  const evaluatedObjects =
    productionFrame?.objects ?? project.objects.map((item) => evaluateDirectorObjectAtFrame(item, frame, fps));
  const evaluatedCamera =
    productionFrame?.camera ??
    evaluateDirectorCameraAtFrame(
      resolveCamera(project, options.cameraId),
      frame,
      evaluatedObjects.map((item) => ({ id: item.id, position: copyTuple(item.transform.position) })),
    );
  const production: DirectorShotIrProductionContext | undefined = productionFrame
    ? {
        takeId: productionFrame.take.id,
        sequenceId: productionFrame.sequence?.id ?? null,
        coverageShotId: productionFrame.shot?.id ?? null,
      }
    : undefined;
  const cameraView = getCameraViewSnapshotFromShot(evaluatedCamera);
  const aspectRatio = evaluatedCamera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const aspectValue = getDirectorCameraAspectValue(aspectRatio);
  const sensorFormat = evaluatedCamera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const sensorGate = getDirectorCameraSensorGate(sensorFormat);
  const usedSensorHeight = getDirectorCameraUsedSensorHeight(aspectRatio, sensorFormat);
  const optics = normalizeDirectorCameraOptics(evaluatedCamera);

  const objects: DirectorShotIrObject[] = evaluatedObjects
    .filter((item): item is typeof item & { kind: Exclude<DirectorObjectKind, "camera"> } => {
      return item.visible && item.kind !== "camera";
    })
    .map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      transform: copyTransform(item.transform),
      ...(item.bodyType ? { bodyType: item.bodyType } : {}),
      ...(item.assetRefId ? { assetRefId: item.assetRefId } : {}),
      ...(item.characterRig
        ? {
            rigPose: {
              rigType: item.characterRig.rigType,
              posePresetId: item.characterRig.posePresetId,
              controls: copySortedControls(resolveCharacterPoseControls(item.characterRig)),
              ...(item.characterRig.ik ? { ik: copyCharacterIk(item.characterRig.ik) } : {}),
            },
          }
        : {}),
      ...(item.lookTargetObjectId !== undefined ? { lookTargetObjectId: item.lookTargetObjectId } : {}),
      referenceRefs: getPortableReferenceRefs(item.referenceBindings),
    }))
    .sort((left, right) => compareText(left.id, right.id));

  const cameraIr: DirectorShotIrCamera = {
    id: evaluatedCamera.id,
    name: evaluatedCamera.name,
    position: copyTuple(cameraView.position),
    target: copyTuple(cameraView.target),
    fov: cameraView.fov,
    focalLengthMm: getFocalLengthFromVerticalFov(cameraView.fov, aspectRatio, sensorFormat),
    ...optics,
    aspectRatio,
    aspectValue,
    sensor: {
      format: sensorFormat,
      gateWidthMm: sensorGate.width,
      gateHeightMm: sensorGate.height,
      usedWidthMm: Number((usedSensorHeight * aspectValue).toFixed(6)),
      usedHeightMm: Number(usedSensorHeight.toFixed(6)),
    },
    actionMode: evaluatedCamera.action?.mode ?? "still",
    targetMode: evaluatedCamera.targetMode,
    ...(evaluatedCamera.targetObjectId !== undefined ? { targetObjectId: evaluatedCamera.targetObjectId } : {}),
    referenceRefs: getPortableReferenceRefs(evaluatedCamera.referenceBindings),
  };

  const revisionSource = {
    schemaVersion: 1,
    projectVersion: project.version,
    fps,
    timebase: {
      rate: serializeDirectorFrameRate(timebase.rate),
      numerator: timebase.rate.numerator,
      denominator: timebase.rate.denominator,
      dropFrame: timebase.dropFrame,
      startTimecode: timebase.startTimecode,
    },
    frame,
    timeSeconds: frame / fps,
    timecode: formatDirectorTimelineTimecode(frame, timebase),
    ...(production ? { production } : {}),
    camera: cameraIr,
    objects,
  } as const;

  return {
    ...revisionSource,
    id: production
      ? `director-shot:${cameraIr.id}:take:${production.takeId}:coverage:${production.coverageShotId ?? "none"}:frame:${frame}`
      : `director-shot:${cameraIr.id}:frame:${frame}`,
    revisionFingerprint: getDeterministicFingerprint(revisionSource),
  };
}
