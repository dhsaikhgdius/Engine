/**
 * Whole-project referential integrity checker.
 *
 * Every `director_workbench` mutation is validated against this graph check
 * before persistence, and `op:"audit"` re-runs it on demand: a project that
 * introduces dangling ids, duplicates, or parent cycles is rejected with the
 * exact issue strings returned here rather than saved in a broken state.
 *
 * @module directorProjectGraph
 */

import type { DirectorProject } from "@director/project-schema";
import { getDirectorProductionIssues } from "@director/project-schema";
import { getDirectorCharacterAssetBindingIssues } from "@director/dcc-interchange";

/**
 * Validates referential integrity across the entire Director project graph.
 *
 * Checks for duplicate and empty ids, dangling references (asset, object, camera),
 * parent-object cycles, and delegates to production and character-binding
 * validators. Used by both workbench mutation and audit paths so that every
 * mutation is validated before persistence.
 *
 * @param project - The Director project to validate.
 * @returns A list of human-readable issue strings; empty when the graph is consistent.
 */
export function getDirectorProjectGraphIssues(project: DirectorProject) {
  const issues: string[] = [];
  const unique = (label: string, values: string[]) => {
    const seen = new Set<string>();
    values.forEach((value) => {
      if (!value) issues.push(`${label} contains an empty id`);
      else if (seen.has(value)) issues.push(`${label} contains duplicate id "${value}"`);
      seen.add(value);
    });
  };
  unique(
    "assets",
    project.assets.map((asset) => asset.id),
  );
  unique(
    "objects",
    project.objects.map((object) => object.id),
  );
  unique(
    "cameras",
    project.cameras.map((camera) => camera.id),
  );
  if (project.storyboard)
    unique(
      "storyboard shots",
      project.storyboard.shots.map((shot) => shot.id),
    );

  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const objectIds = new Set(project.objects.map((object) => object.id));
  const parentByObjectId = new Map(
    project.objects.flatMap((object) => (object.parentObjectId ? [[object.id, object.parentObjectId] as const] : [])),
  );
  const cameraIds = new Set(project.cameras.map((camera) => camera.id));
  if (project.activeCameraId && !cameraIds.has(project.activeCameraId))
    issues.push(`activeCameraId "${project.activeCameraId}" does not exist`);
  if (project.panoramaAssetId && !assetIds.has(project.panoramaAssetId))
    issues.push(`panoramaAssetId "${project.panoramaAssetId}" does not exist`);
  project.objects.forEach((object) => {
    if (object.assetRefId && !assetIds.has(object.assetRefId))
      issues.push(`${object.id}.assetRefId "${object.assetRefId}" does not exist`);
    if (object.parentObjectId && !objectIds.has(object.parentObjectId))
      issues.push(`${object.id}.parentObjectId "${object.parentObjectId}" does not exist`);
    if (object.lookTargetObjectId && !objectIds.has(object.lookTargetObjectId))
      issues.push(`${object.id}.lookTargetObjectId "${object.lookTargetObjectId}" does not exist`);
    if (object.lookTargetObjectId === object.id) issues.push(`${object.id}.lookTargetObjectId cannot reference itself`);
    if (object.linkedCameraId && !cameraIds.has(object.linkedCameraId))
      issues.push(`${object.id}.linkedCameraId "${object.linkedCameraId}" does not exist`);
  });
  const reportedParentCycles = new Set<string>();
  project.objects.forEach((object) => {
    const path: string[] = [];
    const indexById = new Map<string, number>();
    let currentId: string | undefined = object.id;
    while (currentId && objectIds.has(currentId)) {
      const cycleStart = indexById.get(currentId);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        // Sort-and-join dedup key so the same cycle discovered from
        // different starting nodes is reported only once.
        const key = [...cycle].sort().join("|");
        if (!reportedParentCycles.has(key)) {
          reportedParentCycles.add(key);
          issues.push(`object parent cycle detected: ${[...cycle, cycle[0]].join(" -> ")}`);
        }
        break;
      }
      indexById.set(currentId, path.length);
      path.push(currentId);
      currentId = parentByObjectId.get(currentId);
    }
  });
  project.cameras.forEach((camera) => {
    if (camera.targetObjectId && !objectIds.has(camera.targetObjectId))
      issues.push(`${camera.id}.targetObjectId "${camera.targetObjectId}" does not exist`);
    if (camera.action?.follow?.targetObjectId && !objectIds.has(camera.action.follow.targetObjectId)) {
      issues.push(`${camera.id}.action.follow.targetObjectId "${camera.action.follow.targetObjectId}" does not exist`);
    }
    if (camera.action?.path?.targetObjectId && !objectIds.has(camera.action.path.targetObjectId)) {
      issues.push(`${camera.id}.action.path.targetObjectId "${camera.action.path.targetObjectId}" does not exist`);
    }
  });
  project.storyboard?.shots.forEach((shot) => {
    if (shot.cameraId && !cameraIds.has(shot.cameraId))
      issues.push(`storyboard shot ${shot.id}.cameraId "${shot.cameraId}" does not exist`);
  });
  getDirectorProductionIssues(project).forEach((issue) => {
    issues.push(`production ${issue.path}: ${issue.message}`);
  });
  getDirectorCharacterAssetBindingIssues(project).forEach((issue) => {
    if (!issues.includes(issue)) issues.push(issue);
  });
  return issues;
}
