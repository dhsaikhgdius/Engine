import { z } from "zod";
import type { DirectorObject, DirectorProject } from "@director/project-schema";
import {
  DIRECTOR_DEFAULT_SUBJECT_HEIGHT_M,
  DIRECTOR_SHOT_LEVEL_IDS,
  DIRECTOR_SHOT_SIDE_IDS,
  DIRECTOR_SHOT_SIZE_IDS,
  DIRECTOR_SHOT_VIEW_IDS,
  buildDirectorCameraMovePhrase,
  deriveDirectorShotLanguage,
  describeDirectorCameraMove,
  directorShotLanguageReport,
  evaluateDirectorCameraAtFrame,
  formatDirectorCameraMoveSlate,
  formatDirectorShotSlate,
  getCameraViewSnapshotFromShot,
  getFocalLengthFromVerticalFov,
  solveDirectorShotFraming,
  type DirectorCameraFraming,
  type DirectorCameraMoveDescription,
  type DirectorCameraShot,
  type DirectorFramingSubject,
} from "@director/project-schema";
import { strictAction } from "@director/protocol/strictProtocolVariant";
import { directorCameraAspectRatioSchema } from "@director/protocol/directorCameraProtocol";
import type { DirectorAuthoringAction } from "./directorAuthoring";
import { getDirectorSpatialBounds } from "./directorSpatialGeometry";

const framingId = z.string().trim().min(1).max(200);

/**
 * Validation schema for a frame_shot high-level framing intent.
 *
 * frame_shot places and aims an existing physical camera from cinematic
 * vocabulary (shot size, view, side, level, lens) relative to a subject
 * object, instead of requiring raw transforms for "low wide right profile".
 * It compiles into an ordinary update_camera mutation through the shared
 * film-language solver, so the derived observe/HUD reading always matches
 * the requested intent or reports the physical adjustment that was made.
 */
export const directorFrameShotActionSchema = strictAction("frame_shot", {
  camera_id: framingId,
  subject_object_id: framingId,
  size: z.enum(DIRECTOR_SHOT_SIZE_IDS).optional(),
  view: z.enum(DIRECTOR_SHOT_VIEW_IDS).optional(),
  side: z.enum(DIRECTOR_SHOT_SIDE_IDS).optional(),
  level: z.enum(DIRECTOR_SHOT_LEVEL_IDS).optional(),
  focal_length_mm: z.number().finite().min(12).max(200).optional(),
  aspect_ratio: directorCameraAspectRatioSchema.optional(),
  activate: z.boolean().optional(),
});

/** Inferred payload type for a frame_shot action. */
export type DirectorFrameShotAction = z.infer<typeof directorFrameShotActionSchema>;

/**
 * Validation schema for a mark_camera_move action.
 *
 * mark_camera_move pins the camera's current framing (rig transform, aim
 * target, and field of view) as a keyframe on the camera's own animation
 * track. Composing a move is therefore "frame the shot twice": frame A,
 * mark at the start frame, frame B, mark at the end frame. The move between
 * marks is played back by the existing camera animation evaluator and named
 * by describe_camera_move.
 */
export const directorMarkCameraMoveActionSchema = strictAction("mark_camera_move", {
  camera_id: framingId,
  frame: z.number().int().min(0).max(1_000_000),
});

/** Inferred payload type for a mark_camera_move action. */
export type DirectorMarkCameraMoveAction = z.infer<typeof directorMarkCameraMoveActionSchema>;

/** Any atomic authoring action except the framing macros this module compiles from. */
type ExpandedFramingAction = Exclude<DirectorAuthoringAction, { action: "frame_shot" | "mark_camera_move" }>;

/** Expansion output: atomic actions plus human-readable notes for the author result. */
export interface DirectorFramingExpansion {
  actions: ExpandedFramingAction[];
  notes: string[];
}

/**
 * Resolves a scene object into the film-language subject contract: floor-pivot
 * ground position, facing yaw, and standing height measured from spatial
 * bounds (body-type heuristics for characters, measured bounds for props).
 */
export function directorFramingSubjectForObject(
  object: DirectorObject,
  project?: DirectorProject,
): DirectorFramingSubject {
  const bounds = project ? getDirectorSpatialBounds(object, project) : null;
  const heightM = bounds ? Math.max(bounds.size[1], 0.3) : DIRECTOR_DEFAULT_SUBJECT_HEIGHT_M;
  return {
    position: [
      object.transform.position[0],
      bounds ? bounds.min[1] : object.transform.position[1],
      object.transform.position[2],
    ],
    yawRad: object.transform.rotation[1],
    heightM,
  };
}

function requireFramingCamera(project: DirectorProject, cameraId: string): DirectorCameraShot {
  const camera = project.cameras.find((item) => item.id === cameraId);
  if (!camera) {
    throw new Error(`No camera with id "${cameraId}" exists. frame_shot aims an existing camera; add one first.`);
  }
  return camera;
}

function requireFramingSubject(project: DirectorProject, objectId: string): DirectorObject {
  const object = project.objects.find((item) => item.id === objectId);
  if (!object) throw new Error(`No object with id "${objectId}" exists.`);
  if (object.kind === "camera") throw new Error(`Object "${objectId}" is a camera and cannot be a framing subject.`);
  return object;
}

/**
 * Compiles a frame_shot intent into an update_camera mutation through the
 * shared film-language solver. Physical conflicts (a wide lens that cannot
 * hold the requested size, a level out of reach) surface as notes instead of
 * failing silently or producing an impossible pose.
 */
export function buildDirectorFrameShotActions(
  project: DirectorProject,
  action: DirectorFrameShotAction,
): DirectorFramingExpansion {
  const camera = requireFramingCamera(project, action.camera_id);
  const subjectObject = requireFramingSubject(project, action.subject_object_id);
  const subject = directorFramingSubjectForObject(subjectObject, project);
  const aspectRatio = action.aspect_ratio ?? camera.aspectRatio;
  const solved = solveDirectorShotFraming(
    {
      size: action.size,
      view: action.view,
      side: action.side,
      level: action.level,
      focalLengthMm: action.focal_length_mm,
      aspectRatio,
      sensorFormat: camera.sensorFormat,
    },
    subject,
  );
  const language = deriveDirectorShotLanguage(
    {
      position: solved.position,
      target: solved.target,
      focalLengthMm: solved.focalLengthMm,
      aspectRatio,
      sensorFormat: camera.sensorFormat,
    },
    subject,
  );
  const actions: ExpandedFramingAction[] = [
    {
      action: "update_camera",
      camera_id: action.camera_id,
      patch: {
        position: solved.position,
        target: solved.target,
        focal_length_mm: solved.focalLengthMm,
        // Hold the solved aim: an object-tracking target would override it.
        target_object_id: null,
        ...(action.aspect_ratio ? { aspect_ratio: action.aspect_ratio } : {}),
      },
    },
  ];
  if (action.activate) actions.push({ action: "set_active_camera", camera_id: action.camera_id });
  return {
    actions,
    notes: [
      `frame_shot: camera "${action.camera_id}" framed on "${action.subject_object_id}" — ${formatDirectorShotSlate(language)}.`,
      ...solved.adjustments.map((adjustment) => `frame_shot: ${adjustment.message}`),
    ],
  };
}

/**
 * Compiles a mark_camera_move action into a set_animation mutation that
 * upserts one keyframe (rig transform + aim + fov) at the requested frame on
 * the camera's existing animation track, preserving every other keyframe.
 */
export function buildDirectorMarkCameraMoveActions(
  project: DirectorProject,
  action: DirectorMarkCameraMoveAction,
): DirectorFramingExpansion {
  const camera = requireFramingCamera(project, action.camera_id);
  const mark = {
    frame: action.frame,
    transform: structuredClone(camera.transform),
    lookTarget: [...camera.target] as [number, number, number],
    fov: camera.fov,
  };
  const existing = camera.animation?.keyframes ?? [];
  const replaced = existing.some((keyframe) => keyframe.frame === action.frame);
  const keyframes = [...existing.filter((keyframe) => keyframe.frame !== action.frame), mark].sort(
    (left, right) => left.frame - right.frame,
  );
  return {
    actions: [
      {
        action: "set_animation",
        target_type: "camera",
        target_id: action.camera_id,
        animation: {
          version: 1,
          ...(camera.animation ? structuredClone(camera.animation) : {}),
          keyframes,
        },
      },
    ],
    notes: [
      `mark_camera_move: camera "${action.camera_id}" ${replaced ? "re-marked" : "marked"} at frame ${action.frame} (${keyframes.length} mark${keyframes.length === 1 ? "" : "s"} total).`,
    ],
  };
}

/** Zod schema for the describe_camera_move read operation payload. */
export const directorDescribeCameraMoveInputSchema = z
  .strictObject({
    camera_id: framingId,
    subject_object_id: framingId,
    from_frame: z.number().int().min(0).max(1_000_000).optional(),
    to_frame: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((value) => value.from_frame === undefined || value.to_frame === undefined || value.from_frame < value.to_frame, {
    message: "from_frame must be before to_frame",
    path: ["from_frame"],
  });

export type DirectorDescribeCameraMoveInput = z.infer<typeof directorDescribeCameraMoveInputSchema>;

function framingAtFrame(camera: DirectorCameraShot, frame: number): DirectorCameraFraming {
  const evaluated = evaluateDirectorCameraAtFrame(camera, frame);
  const view = getCameraViewSnapshotFromShot(evaluated);
  return {
    position: view.position,
    target: view.target,
    focalLengthMm: getFocalLengthFromVerticalFov(view.fov, camera.aspectRatio, camera.sensorFormat),
    aspectRatio: camera.aspectRatio,
    sensorFormat: camera.sensorFormat,
  };
}

function moveSegmentReport(segment: DirectorCameraMoveDescription, fromFrame: number, toFrame: number) {
  return {
    from_frame: fromFrame,
    to_frame: toFrame,
    move: segment.id,
    label: segment.label,
    phrase: segment.phrase,
    tempo: segment.tempo,
    slate: formatDirectorCameraMoveSlate(segment),
    from: directorShotLanguageReport(segment.from),
    to: directorShotLanguageReport(segment.to),
    deltas: segment.deltas,
  };
}

/**
 * Names the camera move a marked track proves between two frames.
 *
 * Uses the camera's own animation marks: with no explicit frames it reads the
 * first and last keyframes, classifies each adjacent pair as a segment, and
 * chains the proven phrases in time order for generation prompts. Pure
 * project-state math — works identically in the live executor and in
 * gateway disconnected reads.
 */
export function describeDirectorCameraMoveFromProject(
  project: DirectorProject,
  input: DirectorDescribeCameraMoveInput,
): Record<string, unknown> {
  const camera = requireFramingCamera(project, input.camera_id);
  const subjectObject = requireFramingSubject(project, input.subject_object_id);
  const subject = directorFramingSubjectForObject(subjectObject, project);
  const fps = project.scene.timeline?.fps ?? 24;

  const markFrames = [...new Set((camera.animation?.keyframes ?? []).map((keyframe) => keyframe.frame))].sort(
    (left, right) => left - right,
  );
  let frames: number[];
  if (input.from_frame !== undefined || input.to_frame !== undefined) {
    const fromFrame = input.from_frame ?? markFrames[0];
    const toFrame = input.to_frame ?? markFrames[markFrames.length - 1];
    if (fromFrame === undefined || toFrame === undefined || fromFrame >= toFrame) {
      throw new Error(
        `Camera "${input.camera_id}" needs two distinct frames to describe a move. Provide from_frame and to_frame, or author marks with mark_camera_move.`,
      );
    }
    frames = [fromFrame, ...markFrames.filter((frame) => frame > fromFrame && frame < toFrame), toFrame];
  } else {
    if (markFrames.length < 2) {
      throw new Error(
        `Camera "${input.camera_id}" has ${markFrames.length} animation mark(s); a move needs at least two. Author marks with mark_camera_move or pass from_frame/to_frame.`,
      );
    }
    frames = markFrames;
  }

  const segments = frames.slice(0, -1).map((frame, index) => {
    const nextFrame = frames[index + 1];
    const segment = describeDirectorCameraMove(framingAtFrame(camera, frame), framingAtFrame(camera, nextFrame), subject, {
      durationSeconds: (nextFrame - frame) / fps,
    });
    return moveSegmentReport(segment, frame, nextFrame);
  });
  const firstFrame = frames[0];
  const lastFrame = frames[frames.length - 1];
  const overall = describeDirectorCameraMove(
    framingAtFrame(camera, firstFrame),
    framingAtFrame(camera, lastFrame),
    subject,
    { durationSeconds: (lastFrame - firstFrame) / fps },
  );

  return {
    camera_id: input.camera_id,
    subject_object_id: input.subject_object_id,
    from_frame: firstFrame,
    to_frame: lastFrame,
    fps,
    move: overall.id,
    label: overall.label,
    slate: formatDirectorCameraMoveSlate(overall),
    phrase: buildDirectorCameraMovePhrase(segments.length > 1 ? segments : [overall]),
    from: directorShotLanguageReport(overall.from),
    to: directorShotLanguageReport(overall.to),
    segments,
  };
}
