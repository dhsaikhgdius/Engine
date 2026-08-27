/**
 * Pure storyboard helpers shared by the timeline dock, canvas playback, and
 * exports: shot lookup by frame, active-camera resolution, and shot-range
 * arithmetic over the project timeline. No store access — callers pass state.
 */
import type {
  DirectorProject,
  DirectorStoryboard,
  DirectorStoryboardShot,
  DirectorTimeline,
} from "../schema/directorProject";

/** Creates a new empty storyboard with a Chinese-language default title and logline. */
export function createEmptyDirectorStoryboard(): DirectorStoryboard {
  return {
    version: 1,
    title: "未命名分镜",
    logline: "用镜头拆分表演、调度与机位运动。",
    shots: [],
  };
}

/**
 * Finds the storyboard shot that covers the given frame, if any.
 *
 * @param storyboard - The storyboard to search, or undefined.
 * @param frame - The timeline frame to check.
 * @returns The shot covering the frame, or null when no shot matches.
 */
export function getStoryboardShotAtFrame(
  storyboard: DirectorStoryboard | undefined,
  frame: number,
): DirectorStoryboardShot | null {
  if (!storyboard) return null;
  return storyboard.shots.find((shot) => frame >= shot.frameStart && frame <= shot.frameEnd) ?? null;
}

/**
 * Resolves the camera ID for a given frame from the storyboard, falling back to a default.
 *
 * @param storyboard - The storyboard to search, or undefined.
 * @param frame - The timeline frame to check.
 * @param fallbackCameraId - The camera ID to use when no storyboard shot covers the frame.
 * @returns The camera ID from the matching shot, or the fallback.
 */
export function getStoryboardCameraIdAtFrame(
  storyboard: DirectorStoryboard | undefined,
  frame: number,
  fallbackCameraId: string | null,
) {
  return getStoryboardShotAtFrame(storyboard, frame)?.cameraId ?? fallbackCameraId;
}

/**
 * Returns the duration of a storyboard shot in seconds, given the timeline FPS.
 *
 * @param shot - The storyboard shot.
 * @param fps - The timeline frame rate.
 * @returns The shot duration in seconds.
 */
export function getStoryboardShotDuration(shot: DirectorStoryboardShot, fps: number) {
  const frameCount = Math.max(1, shot.frameEnd - shot.frameStart + 1);
  return frameCount / Math.max(1, fps);
}

/** Returns a new array of shots sorted by frameStart, then frameEnd. Does not mutate the input. */
export function sortStoryboardShots(shots: DirectorStoryboardShot[]) {
  return [...shots].sort((left, right) =>
    left.frameStart === right.frameStart ? left.frameEnd - right.frameEnd : left.frameStart - right.frameStart,
  );
}

/**
 * Re-sequences shots so they are contiguous starting from the given frame, preserving each shot's duration.
 *
 * @param shots - The shots to resequence.
 * @param frameStart - The first frame of the first shot.
 * @returns New shot objects with updated frameStart and frameEnd.
 */
export function resequenceStoryboardShots(shots: DirectorStoryboardShot[], frameStart = 0) {
  let cursor = Math.max(0, Math.round(frameStart));
  return shots.map((shot) => {
    const duration = Math.max(1, Math.round(shot.frameEnd) - Math.round(shot.frameStart) + 1);
    const next = { ...shot, frameStart: cursor, frameEnd: cursor + duration - 1 };
    cursor = next.frameEnd + 1;
    return next;
  });
}

/** Moves a storyboard card while preserving every shot's inclusive duration. */
export function reorderStoryboardShot(
  shots: DirectorStoryboardShot[],
  shotId: string,
  direction: "earlier" | "later",
  frameStart = 0,
) {
  const ordered = sortStoryboardShots(shots);
  const index = ordered.findIndex((shot) => shot.id === shotId);
  const target = direction === "earlier" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) return resequenceStoryboardShots(ordered, frameStart);
  [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  return resequenceStoryboardShots(ordered, frameStart);
}

/** Duplicates a shot as a new timeline card; frame-bound image evidence is intentionally cleared. */
export function duplicateStoryboardShot(shots: DirectorStoryboardShot[], shotId: string, frameStart = 0) {
  const ordered = sortStoryboardShots(shots);
  const index = ordered.findIndex((shot) => shot.id === shotId);
  if (index < 0) return { shots: resequenceStoryboardShots(ordered, frameStart), shot: null };
  const source = ordered[index]!;
  const { thumbnail: _thumbnail, ...portableSource } = source;
  const shot: DirectorStoryboardShot = {
    ...portableSource,
    id: createStoryboardShotId(),
    title: `${source.title} · 副本`,
    ...(portableSource.generation ? { generation: { ...portableSource.generation, outputs: [] } } : {}),
  };
  ordered.splice(index + 1, 0, shot);
  const resequenced = resequenceStoryboardShots(ordered, frameStart);
  return { shots: resequenced, shot: resequenced.find((candidate) => candidate.id === shot.id)! };
}

/**
 * Generates a unique storyboard shot ID using the current timestamp and random suffix.
 * The ID is a stable local identifier, not a cryptographic UUID.
 *
 * @returns A new shot ID string like "shot-<timestamp>-<random>".
 */
export function createStoryboardShotId() {
  return `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function getStoryboardCameraName(project: DirectorProject, cameraId: string | null) {
  return project.cameras.find((camera) => camera.id === cameraId)?.name ?? "未指定机位";
}

/**
 * Inserts a three-second shot like a non-linear editor: clips at and after
 * the playhead move right, and a clip cut at the playhead is split into its
 * before/after portions. The caller extends the project timeline when needed.
 */
export function insertStoryboardShotAtFrame({
  project,
  currentFrame,
  timeline,
}: {
  project: DirectorProject;
  currentFrame: number;
  timeline: DirectorTimeline;
}) {
  const storyboard = project.storyboard ?? createEmptyDirectorStoryboard();
  const frameStart = Math.max(timeline.frameStart, Math.min(timeline.frameEnd, Math.round(currentFrame)));
  const duration = Math.max(24, Math.round(timeline.fps * 3));
  const frameEnd = frameStart + duration - 1;
  const cameraId = project.activeCameraId ?? project.cameras[0]?.id ?? null;
  const insertedShot: DirectorStoryboardShot = {
    id: createStoryboardShotId(),
    title: `${String(storyboard.shots.length + 1).padStart(2, "0")} · ${getStoryboardCameraName(project, cameraId)}`,
    cameraId,
    frameStart,
    frameEnd,
    shotSize: "medium",
    movement: "static",
    action: "补充本镜的表演、构图重点与镜头调度。",
  };
  const shiftedShots = storyboard.shots.flatMap((shot) => {
    if (shot.frameStart < frameStart && shot.frameEnd >= frameStart) {
      const before = { ...shot, frameEnd: frameStart - 1 };
      const after = {
        ...shot,
        id: createStoryboardShotId(),
        title: `${shot.title} · 后段`,
        frameStart: frameEnd + 1,
        frameEnd: shot.frameEnd + duration,
      };
      return before.frameStart <= before.frameEnd ? [before, after] : [after];
    }
    if (shot.frameStart >= frameStart) {
      return [{ ...shot, frameStart: shot.frameStart + duration, frameEnd: shot.frameEnd + duration }];
    }
    return [shot];
  });

  return {
    shot: insertedShot,
    storyboard: { ...storyboard, shots: sortStoryboardShots([...shiftedShots, insertedShot]) },
    frameEnd: Math.max(timeline.frameEnd, frameEnd, ...shiftedShots.map((shot) => shot.frameEnd)),
  };
}
