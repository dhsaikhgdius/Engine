import type {
  DirectorAnimationKeyframe,
  DirectorCameraShot,
  DirectorEntityAnimation,
  DirectorObject,
  DirectorProject,
  DirectorTransform,
} from "../schema/directorProject";
import { clampTimelineFrame } from "./frameTime";

/** Whether a track belongs to an object or a camera. */
export type DirectorTrackOwnerType = "object" | "camera";

/** A flat track target for the keyframe editor timeline. */
export interface DirectorFrameTrackTarget {
  /** Stable track key: "ownerType:ownerId". */
  key: string;
  /** Whether this track is for an object or camera. */
  ownerType: DirectorTrackOwnerType;
  /** The owner's id. */
  ownerId: string;
  /** The object's id (same as ownerId for non-camera objects). */
  objectId: string;
  /** Kind: character, prop, or camera. */
  kind: "character" | "prop" | "camera";
  /** Display label. */
  label: string;
  /** Base transform before animation. */
  baseTransform: DirectorTransform;
  /** Optional animation data. */
  animation?: DirectorEntityAnimation;
  /** Camera look-at target (camera tracks only). */
  cameraTarget?: [number, number, number];
  /** Camera field of view (camera tracks only). */
  cameraFov?: number;
  /** Track color in the timeline UI. */
  color: string;
}

/**
 * Creates a stable track key from an owner type and id.
 *
 * @param ownerType - "object" or "camera".
 * @param ownerId - The owner's id.
 * @returns A key string like "object:abc123".
 */
export function createDirectorTrackKey(ownerType: DirectorTrackOwnerType, ownerId: string) {
  return `${ownerType}:${ownerId}`;
}

function cameraTarget(object: DirectorObject, camera: DirectorCameraShot | undefined): DirectorFrameTrackTarget | null {
  if (!camera) return null;
  return {
    key: createDirectorTrackKey("camera", camera.id),
    ownerType: "camera",
    ownerId: camera.id,
    objectId: object.id,
    kind: "camera",
    label: camera.name,
    baseTransform: camera.transform,
    animation: camera.animation,
    cameraTarget: camera.target,
    cameraFov: camera.fov,
    color: camera.animation?.color ?? "#a9d8ff",
  };
}

function objectTarget(object: DirectorObject): DirectorFrameTrackTarget | null {
  if (object.kind !== "character" && object.kind !== "prop") return null;
  return {
    key: createDirectorTrackKey("object", object.id),
    ownerType: "object",
    ownerId: object.id,
    objectId: object.id,
    kind: object.kind,
    label: object.name,
    baseTransform: object.transform,
    animation: object.animation,
    color: object.animation?.color ?? object.color ?? "#18c7e6",
  };
}

/**
 * Gets the track target for a specific object by id.
 *
 * @param project - The Director project.
 * @param objectId - The object id, or null/undefined.
 * @returns The track target, or null if not found.
 */
export function getDirectorTrackTargetForObject(project: DirectorProject, objectId: string | null | undefined) {
  if (!objectId) return null;
  const object = project.objects.find((item) => item.id === objectId);
  if (!object) return null;
  if (object.kind === "camera") {
    return cameraTarget(
      object,
      project.cameras.find((camera) => camera.id === object.linkedCameraId),
    );
  }
  return objectTarget(object);
}

/**
 * Collects all frame tracks for the timeline editor.
 *
 * Only includes tracks that have keyframes, motion blocks, or are explicitly
 * listed in the timeline's trackKeys.
 *
 * @param project - The Director project (cameras, objects, scene).
 * @returns All visible track targets.
 */
export function getDirectorFrameTracks(project: Pick<DirectorProject, "cameras" | "objects" | "scene">) {
  const tracks: DirectorFrameTrackTarget[] = [];
  const explicitTrackKeys = new Set(project.scene.timeline?.trackKeys ?? []);
  project.objects.forEach((object) => {
    const target =
      object.kind === "camera"
        ? cameraTarget(
            object,
            project.cameras.find((camera) => camera.id === object.linkedCameraId),
          )
        : objectTarget(object);
    if (
      target &&
      (target.animation?.keyframes.length ||
        target.animation?.motionBlocks?.length ||
        explicitTrackKeys.has(target.key))
    ) {
      tracks.push(target);
    }
  });
  return tracks;
}

/**
 * Finds a track by its key.
 *
 * @param project - The Director project.
 * @param key - The track key, or null/undefined.
 * @returns The track target, or null if not found.
 */
export function getDirectorFrameTrackByKey(project: DirectorProject, key: string | null | undefined) {
  if (!key) return null;
  return getDirectorFrameTracks(project).find((track) => track.key === key) ?? null;
}

/**
 * Finds a track target by key, scanning all project objects.
 *
 * @param project - The Director project.
 * @param key - The track key, or null/undefined.
 * @returns The track target, or null if not found.
 */
export function getDirectorTrackTargetByKey(project: DirectorProject, key: string | null | undefined) {
  if (!key) return null;
  for (const object of project.objects) {
    const target = getDirectorTrackTargetForObject(project, object.id);
    if (target?.key === key) return target;
  }
  return null;
}

/**
 * Computes the effective end frame of the timeline.
 *
 * Extends beyond the timeline's frameEnd if enabled animation keyframes
 * or motion blocks extend further.
 *
 * @param project - The Director project (cameras, objects, scene).
 * @returns The effective last frame.
 */
export function getEffectiveTimelineEndFrame(project: Pick<DirectorProject, "cameras" | "objects" | "scene">) {
  const timeline = project.scene.timeline;
  if (!timeline) return 0;
  let lastEnabledFrame: number | null = null;
  getDirectorFrameTracks(project).forEach((track) => {
    if (track.animation?.enabled === false) return;
    track.animation?.keyframes.forEach((keyframe) => {
      if (lastEnabledFrame === null || keyframe.frame > lastEnabledFrame) {
        lastEnabledFrame = keyframe.frame;
      }
    });
    track.animation?.motionBlocks?.forEach((block) => {
      if (lastEnabledFrame === null || block.frameEnd > lastEnabledFrame) lastEnabledFrame = block.frameEnd;
    });
  });
  return lastEnabledFrame === null || lastEnabledFrame <= timeline.frameStart
    ? timeline.frameEnd
    : clampTimelineFrame(lastEnabledFrame, timeline.frameStart, timeline.frameEnd);
}

/**
 * Updates a keyframe at a specific index in an animation.
 *
 * @param animation - The animation containing the keyframe.
 * @param keyframeIndex - The index of the keyframe to update.
 * @param patch - Partial properties to apply.
 * @param frameStart - The timeline frame start for clamping.
 * @param frameEnd - The timeline frame end for clamping.
 * @returns The updated animation.
 */
export function updateAnimationKeyframe(
  animation: DirectorEntityAnimation,
  keyframeIndex: number,
  patch: Partial<DirectorAnimationKeyframe>,
  frameStart: number,
  frameEnd: number,
): DirectorEntityAnimation {
  if (!animation.keyframes[keyframeIndex]) return animation;
  const keyframes = animation.keyframes.map((keyframe, index) =>
    index === keyframeIndex
      ? {
          ...keyframe,
          ...patch,
          frame: clampTimelineFrame(patch.frame ?? keyframe.frame, frameStart, frameEnd),
        }
      : keyframe,
  );
  return { ...animation, keyframes };
}

/**
 * Removes the transform track from an animation, keeping only pose keyframes.
 *
 * @param animation - The animation, or undefined.
 * @returns A pose-only animation, or undefined if no pose keyframes remain.
 */
export function removeTransformTrack(animation: DirectorEntityAnimation | undefined) {
  if (!animation) return undefined;
  const keyframes = animation.keyframes.flatMap((keyframe) => {
    if (!keyframe.poseValues) return [];
    return [
      {
        frame: keyframe.frame,
        interpolation: keyframe.interpolation,
        poseValues: { ...keyframe.poseValues },
      },
    ];
  });
  if (keyframes.length === 0) return undefined;
  return { version: 1 as const, keyframes };
}
