import type { DirectorProject } from "@director/project-schema";
import { getProductionGraphFingerprint, createProductionGraphFromDirectorProject } from "@director/project-schema/production-graph";
import { stableJson } from "@director/protocol/stableJson";
import type { DirectorWorkbenchObserveField } from "./directorWorkbenchContract";
import { getDirectorProjectGraphIssues } from "./directorProjectGraph";
import { directorProjectObservationCounts } from "./directorWorkbenchObserve";

function collectionDiff<T extends { id: string }>(before: T[], after: T[], maxChanges: number) {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];
  const added = ids.flatMap((id) => (!beforeById.has(id) && afterById.has(id) ? [afterById.get(id)!] : []));
  const updated = ids.flatMap((id) => {
    const previous = beforeById.get(id);
    const next = afterById.get(id);
    return previous && next && stableJson(previous) !== stableJson(next) ? [{ id, before: previous, after: next }] : [];
  });
  const removed = ids.filter((id) => beforeById.has(id) && !afterById.has(id));
  const totalChanges = added.length + updated.length + removed.length;
  const boundedAdded = added.slice(0, maxChanges);
  const boundedUpdated = updated.slice(0, Math.max(0, maxChanges - boundedAdded.length));
  const boundedRemoved = removed.slice(0, Math.max(0, maxChanges - boundedAdded.length - boundedUpdated.length));
  return {
    added: boundedAdded,
    updated: boundedUpdated,
    removed: boundedRemoved,
    total_changes: totalChanges,
    truncated: totalChanges > boundedAdded.length + boundedUpdated.length + boundedRemoved.length,
  };
}

function changedValue<T>(before: T, after: T) {
  return stableJson(before) === stableJson(after) ? null : { before, after };
}

function timelineObservation(project: DirectorProject) {
  return {
    settings: project.scene.timeline ?? null,
    object_tracks: project.objects.flatMap((object) =>
      object.animation
        ? [
            {
              id: object.id,
              kind: object.kind,
              keyframe_count: object.animation.keyframes.length,
              motion: object.animation.motion ?? "none",
              action: object.animation.actionPresetId ?? null,
            },
          ]
        : [],
    ),
    camera_tracks: project.cameras
      .filter((camera) => (camera.animation?.keyframes.length ?? 0) > 0)
      .map((camera) => ({ id: camera.id, keyframe_count: camera.animation?.keyframes.length ?? 0 })),
  };
}

/** Compare two persisted Director projects and return only requested, bounded changes. */
export function buildDirectorRevisionDiff(
  before: DirectorProject,
  after: DirectorProject,
  fields: DirectorWorkbenchObserveField[] | undefined,
  maxChanges: number,
) {
  const include = (field: DirectorWorkbenchObserveField) => !fields?.length || fields.includes(field);
  const result: Record<string, unknown> = {};
  let changed = false;
  const addValue = (key: string, value: unknown) => {
    result[key] = value;
    if (value !== null) changed = true;
  };
  const addCollection = (key: string, value: ReturnType<typeof collectionDiff>) => {
    result[key] = value;
    if (value.total_changes > 0) changed = true;
  };

  if (include("scene")) {
    addValue("scene", changedValue(before.scene, after.scene));
    addValue("active_camera_id", changedValue(before.activeCameraId, after.activeCameraId));
    addValue("panorama_asset_id", changedValue(before.panoramaAssetId ?? null, after.panoramaAssetId ?? null));
  }
  if (include("assets")) addCollection("assets", collectionDiff(before.assets, after.assets, maxChanges));
  if (include("objects")) addCollection("objects", collectionDiff(before.objects, after.objects, maxChanges));
  if (include("characters")) {
    addCollection(
      "characters",
      collectionDiff(
        before.objects.filter((object) => object.kind === "character"),
        after.objects.filter((object) => object.kind === "character"),
        maxChanges,
      ),
    );
  }
  if (include("lights")) {
    addCollection("lights", collectionDiff(before.lights ?? [], after.lights ?? [], maxChanges));
  }
  if (include("cameras")) addCollection("cameras", collectionDiff(before.cameras, after.cameras, maxChanges));
  if (include("storyboard")) addValue("storyboard", changedValue(before.storyboard ?? null, after.storyboard ?? null));
  if (include("production")) addValue("production", changedValue(before.production ?? null, after.production ?? null));
  if (include("world")) addValue("world", changedValue(before.world ?? null, after.world ?? null));
  if (include("timeline")) addValue("timeline", changedValue(timelineObservation(before), timelineObservation(after)));
  if (include("counts")) {
    addValue("counts", changedValue(directorProjectObservationCounts(before), directorProjectObservationCounts(after)));
  }
  if (include("graph_issues")) {
    addValue("graph_issues", changedValue(getDirectorProjectGraphIssues(before), getDirectorProjectGraphIssues(after)));
  }
  if (include("production_graph")) {
    addValue(
      "production_graph",
      changedValue(
        getProductionGraphFingerprint(createProductionGraphFromDirectorProject(before)),
        getProductionGraphFingerprint(createProductionGraphFromDirectorProject(after)),
      ),
    );
  }

  return { changed, ...result };
}
