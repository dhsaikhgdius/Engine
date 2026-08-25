import type {
  DirectorCoverageSequence,
  DirectorCoverageShot,
  DirectorEntityAnimation,
  DirectorPerformanceEntityTrack,
  DirectorPerformanceTake,
  DirectorProduction,
  DirectorProject,
} from "./directorProject";

/** Default id for the auto-generated performance take. */
export const DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID = "take_default";
/** Default id for the auto-generated coverage sequence. */
export const DEFAULT_DIRECTOR_COVERAGE_SEQUENCE_ID = "coverage_default";

/** Codes for structural issues detected during production validation. */
export type DirectorProductionIssueCode =
  "duplicate-id" | "duplicate-ref" | "empty-id" | "frame-outside-take" | "invalid-frame-range" | "missing-ref";

/** A structural issue found during production validation with its code, path, and message. */
export interface DirectorProductionIssue {
  code: DirectorProductionIssueCode;
  path: string;
  message: string;
}

function cloneAnimation(animation: DirectorEntityAnimation): DirectorEntityAnimation {
  return JSON.parse(JSON.stringify(animation)) as DirectorEntityAnimation;
}

function normalizedFrameStart(value: number) {
  return Math.max(0, Math.floor(value));
}

function normalizedFrameEnd(value: number) {
  return Math.max(0, Math.ceil(value));
}

function getProjectFrameRange(project: DirectorProject) {
  const startCandidates = [project.scene.timeline?.frameStart ?? 0];
  const endCandidates = [project.scene.timeline?.frameEnd ?? 0];

  project.storyboard?.shots.forEach((shot) => {
    startCandidates.push(shot.frameStart);
    endCandidates.push(shot.frameEnd);
  });
  project.objects.forEach((object) => {
    object.animation?.keyframes.forEach((keyframe) => {
      startCandidates.push(keyframe.frame);
      endCandidates.push(keyframe.frame);
    });
  });
  project.cameras.forEach((camera) => {
    camera.animation?.keyframes.forEach((keyframe) => {
      startCandidates.push(keyframe.frame);
      endCandidates.push(keyframe.frame);
    });
  });

  const frameStart = normalizedFrameStart(Math.min(...startCandidates.filter(Number.isFinite)));
  const frameEnd = Math.max(frameStart, normalizedFrameEnd(Math.max(...endCandidates.filter(Number.isFinite))));
  return { frameStart, frameEnd };
}

function createDefaultTake(project: DirectorProject, frameStart: number, frameEnd: number): DirectorPerformanceTake {
  const performanceObjects = project.objects.filter((object) => object.kind !== "camera" && object.kind !== "panorama");
  const entityTracks: DirectorPerformanceEntityTrack[] = performanceObjects.flatMap((object, index) =>
    object.animation
      ? [
          {
            id: `${DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID}_track_${index + 1}`,
            objectId: object.id,
            animation: cloneAnimation(object.animation),
          },
        ]
      : [],
  );

  return {
    id: DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
    name: "默认表演",
    frameStart,
    frameEnd,
    objectIds: performanceObjects.map((object) => object.id),
    entityTracks,
  };
}

function createCoverageShot(
  id: string,
  name: string,
  takeId: string,
  cameraId: string,
  frameStart: number,
  frameEnd: number,
  storyboardShotId?: string,
): DirectorCoverageShot {
  return {
    id,
    name,
    takeId,
    cameraId,
    frameStart,
    frameEnd,
    ...(storyboardShotId ? { storyboardShotId } : {}),
  };
}

function createDefaultSequence(project: DirectorProject, take: DirectorPerformanceTake): DirectorCoverageSequence {
  const cameraIds = new Set(project.cameras.map((camera) => camera.id));
  const fallbackCameraId =
    project.activeCameraId && cameraIds.has(project.activeCameraId)
      ? project.activeCameraId
      : (project.cameras[0]?.id ?? null);

  const storyboardShots = project.storyboard?.shots ?? [];
  const shots = storyboardShots.flatMap((shot, index) => {
    const cameraId = shot.cameraId && cameraIds.has(shot.cameraId) ? shot.cameraId : fallbackCameraId;
    if (!cameraId) return [];

    const frameStart = Math.min(take.frameEnd, Math.max(take.frameStart, normalizedFrameStart(shot.frameStart)));
    const frameEnd = Math.min(
      take.frameEnd,
      Math.max(frameStart, Math.max(take.frameStart, normalizedFrameEnd(shot.frameEnd))),
    );
    return [
      createCoverageShot(
        `coverage_shot_${index + 1}`,
        shot.title || `镜头 ${index + 1}`,
        take.id,
        cameraId,
        frameStart,
        frameEnd,
        shot.id,
      ),
    ];
  });

  if (!shots.length && fallbackCameraId) {
    shots.push(
      createCoverageShot(
        "coverage_shot_1",
        project.cameras.find((camera) => camera.id === fallbackCameraId)?.name ?? "默认镜头",
        take.id,
        fallbackCameraId,
        take.frameStart,
        take.frameEnd,
      ),
    );
  }

  return {
    id: DEFAULT_DIRECTOR_COVERAGE_SEQUENCE_ID,
    name: project.storyboard?.title || "默认镜头组",
    shots,
  };
}

/** Builds the compatibility take/coverage projection for a v1 scene document. */
export function createDefaultDirectorProduction(project: DirectorProject): DirectorProduction {
  const { frameStart, frameEnd } = getProjectFrameRange(project);
  const take = createDefaultTake(project, frameStart, frameEnd);
  const sequence = createDefaultSequence(project, take);

  return {
    version: 1,
    takes: [take],
    sequences: [sequence],
    activeTakeId: take.id,
    activeSequenceId: sequence.id,
  };
}

/** Adds the production projection once and leaves already-authored production data untouched. */
export function migrateDirectorProduction(project: DirectorProject): DirectorProject {
  if (project.production) return project;
  return { ...project, production: createDefaultDirectorProduction(project) };
}

/**
 * Removes references that no longer exist after an object, camera, take, or
 * storyboard edit. The function is pure so every import/authoring adapter can
 * share the same relationship repair instead of maintaining local variants.
 */
export function reconcileDirectorProduction(
  project: DirectorProject,
  production: DirectorProduction | undefined = project.production,
): DirectorProduction | undefined {
  if (!production) return undefined;

  const objectIds = new Set(project.objects.map((object) => object.id));
  const cameraIds = new Set(project.cameras.map((camera) => camera.id));
  const storyboardShotIds = new Set(project.storyboard?.shots.map((shot) => shot.id) ?? []);
  const takes = production.takes.map((take) => ({
    ...take,
    objectIds: take.objectIds.filter((objectId) => objectIds.has(objectId)),
    entityTracks: take.entityTracks.filter((track) => objectIds.has(track.objectId)),
  }));
  const takeIds = new Set(takes.map((take) => take.id));
  const sequences = production.sequences.map((sequence) => ({
    ...sequence,
    shots: sequence.shots
      .filter((shot) => takeIds.has(shot.takeId) && cameraIds.has(shot.cameraId))
      .map((shot) =>
        shot.storyboardShotId && !storyboardShotIds.has(shot.storyboardShotId)
          ? { ...shot, storyboardShotId: undefined }
          : shot,
      ),
  }));
  const sequenceIds = new Set(sequences.map((sequence) => sequence.id));

  return {
    ...production,
    takes,
    sequences,
    activeTakeId:
      production.activeTakeId && takeIds.has(production.activeTakeId)
        ? production.activeTakeId
        : (takes[0]?.id ?? null),
    activeSequenceId:
      production.activeSequenceId && sequenceIds.has(production.activeSequenceId)
        ? production.activeSequenceId
        : (sequences[0]?.id ?? null),
  };
}

function isValidFrame(value: number) {
  return Number.isInteger(value) && value >= 0;
}

function addUniqueIdIssues(
  issues: DirectorProductionIssue[],
  label: string,
  entries: Array<{ id: string; path: string }>,
) {
  const seen = new Set<string>();
  entries.forEach(({ id, path }) => {
    if (!id.trim()) {
      issues.push({ code: "empty-id", path, message: `${label} ID 不能为空` });
      return;
    }
    if (seen.has(id)) issues.push({ code: "duplicate-id", path, message: `${label} ID \"${id}\" 重复` });
    seen.add(id);
  });
}

function addFrameRangeIssues(issues: DirectorProductionIssue[], path: string, frameStart: number, frameEnd: number) {
  if (!isValidFrame(frameStart) || !isValidFrame(frameEnd) || frameStart > frameEnd) {
    issues.push({
      code: "invalid-frame-range",
      path,
      message: `${path} 必须是非负整数帧，且 frameStart 不得晚于 frameEnd`,
    });
  }
}

/**
 * Pure referential and temporal validation for the optional production model.
 * Zod owns JSON structure; this function owns relationships between IDs and
 * frame ranges.
 */
export function getDirectorProductionIssues(project: DirectorProject): DirectorProductionIssue[] {
  const production = project.production;
  if (!production) return [];

  const issues: DirectorProductionIssue[] = [];
  const objectIds = new Set(project.objects.map((object) => object.id));
  const cameraIds = new Set(project.cameras.map((camera) => camera.id));
  const storyboardShotIds = new Set(project.storyboard?.shots.map((shot) => shot.id) ?? []);

  addUniqueIdIssues(
    issues,
    "PerformanceTake",
    production.takes.map((take, index) => ({ id: take.id, path: `production.takes.${index}.id` })),
  );
  addUniqueIdIssues(
    issues,
    "CoverageSequence",
    production.sequences.map((sequence, index) => ({
      id: sequence.id,
      path: `production.sequences.${index}.id`,
    })),
  );
  addUniqueIdIssues(
    issues,
    "EntityTrack",
    production.takes.flatMap((take, takeIndex) =>
      take.entityTracks.map((track, trackIndex) => ({
        id: track.id,
        path: `production.takes.${takeIndex}.entityTracks.${trackIndex}.id`,
      })),
    ),
  );
  addUniqueIdIssues(
    issues,
    "CoverageShot",
    production.sequences.flatMap((sequence, sequenceIndex) =>
      sequence.shots.map((shot, shotIndex) => ({
        id: shot.id,
        path: `production.sequences.${sequenceIndex}.shots.${shotIndex}.id`,
      })),
    ),
  );

  const takesById = new Map(production.takes.map((take) => [take.id, take]));
  const sequenceIds = new Set(production.sequences.map((sequence) => sequence.id));
  if (production.activeTakeId && !takesById.has(production.activeTakeId)) {
    issues.push({
      code: "missing-ref",
      path: "production.activeTakeId",
      message: `activeTakeId \"${production.activeTakeId}\" 不存在`,
    });
  }
  if (production.activeSequenceId && !sequenceIds.has(production.activeSequenceId)) {
    issues.push({
      code: "missing-ref",
      path: "production.activeSequenceId",
      message: `activeSequenceId \"${production.activeSequenceId}\" 不存在`,
    });
  }

  production.takes.forEach((take, takeIndex) => {
    const takePath = `production.takes.${takeIndex}`;
    addFrameRangeIssues(issues, takePath, take.frameStart, take.frameEnd);

    const takeObjectIds = new Set<string>();
    take.objectIds.forEach((objectId, objectIndex) => {
      const path = `${takePath}.objectIds.${objectIndex}`;
      if (!objectIds.has(objectId)) {
        issues.push({ code: "missing-ref", path, message: `objectId \"${objectId}\" 不存在` });
      }
      if (takeObjectIds.has(objectId)) {
        issues.push({ code: "duplicate-ref", path, message: `objectId \"${objectId}\" 在同一 take 中重复` });
      }
      takeObjectIds.add(objectId);
    });

    const trackedObjectIds = new Set<string>();
    take.entityTracks.forEach((track, trackIndex) => {
      const trackPath = `${takePath}.entityTracks.${trackIndex}`;
      if (!objectIds.has(track.objectId)) {
        issues.push({
          code: "missing-ref",
          path: `${trackPath}.objectId`,
          message: `objectId \"${track.objectId}\" 不存在`,
        });
      } else if (!takeObjectIds.has(track.objectId)) {
        issues.push({
          code: "missing-ref",
          path: `${trackPath}.objectId`,
          message: `objectId \"${track.objectId}\" 未列入所属 take.objectIds`,
        });
      }
      if (trackedObjectIds.has(track.objectId)) {
        issues.push({
          code: "duplicate-ref",
          path: `${trackPath}.objectId`,
          message: `objectId \"${track.objectId}\" 在同一 take 中有多条表演轨道`,
        });
      }
      trackedObjectIds.add(track.objectId);

      track.animation.keyframes.forEach((keyframe, keyframeIndex) => {
        if (!isValidFrame(keyframe.frame) || keyframe.frame < take.frameStart || keyframe.frame > take.frameEnd) {
          issues.push({
            code: "frame-outside-take",
            path: `${trackPath}.animation.keyframes.${keyframeIndex}.frame`,
            message: `关键帧 ${keyframe.frame} 不在 take ${take.id} 的 ${take.frameStart}-${take.frameEnd} 范围内`,
          });
        }
      });
    });
  });

  production.sequences.forEach((sequence, sequenceIndex) => {
    sequence.shots.forEach((shot, shotIndex) => {
      const shotPath = `production.sequences.${sequenceIndex}.shots.${shotIndex}`;
      addFrameRangeIssues(issues, shotPath, shot.frameStart, shot.frameEnd);
      const take = takesById.get(shot.takeId);
      if (!take) {
        issues.push({ code: "missing-ref", path: `${shotPath}.takeId`, message: `takeId \"${shot.takeId}\" 不存在` });
      } else if (shot.frameStart < take.frameStart || shot.frameEnd > take.frameEnd) {
        issues.push({
          code: "frame-outside-take",
          path: shotPath,
          message: `镜头帧范围 ${shot.frameStart}-${shot.frameEnd} 超出 take ${take.id} 的 ${take.frameStart}-${take.frameEnd}`,
        });
      }
      if (!cameraIds.has(shot.cameraId)) {
        issues.push({
          code: "missing-ref",
          path: `${shotPath}.cameraId`,
          message: `cameraId \"${shot.cameraId}\" 不存在`,
        });
      }
      if (shot.storyboardShotId && !storyboardShotIds.has(shot.storyboardShotId)) {
        issues.push({
          code: "missing-ref",
          path: `${shotPath}.storyboardShotId`,
          message: `storyboardShotId \"${shot.storyboardShotId}\" 不存在`,
        });
      }
    });
  });

  return issues;
}

/**
 * Returns true when the production model has no structural issues.
 *
 * @param project - The Director project to validate.
 * @returns True when getDirectorProductionIssues returns an empty array.
 */
export function isDirectorProductionValid(project: DirectorProject) {
  return getDirectorProductionIssues(project).length === 0;
}
