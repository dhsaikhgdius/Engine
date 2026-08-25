import { getDirectorProjectRevision } from "@director/project-schema";
import type { DirectorProject } from "@director/project-schema";
import { auditDirectorProject } from "@director/agent-engine/audit";
import { getDirectorAgentCatalogAsset } from "@director/agent-engine/asset-catalog";
import {
  directorWorkbenchOperationNames,
  type DirectorWorkbenchObserveField,
  type DirectorWorkbenchOperation,
} from "@director/agent-engine/contract";
import { directorProjectObservationCounts, observeDirectorProject } from "@director/agent-engine/observe";
import { queryDirectorObjects } from "@director/agent-engine/spatial-query";
import directorWorkbenchCapabilities from "@director/agent-engine/workbench-capabilities";
import type { BlenderLiveSceneSnapshot } from "../../packages/protocol/src/blenderLiveProtocol";

export type DisconnectedWorkbenchSources = {
  project: DirectorProject | null;
  blenderScene: BlenderLiveSceneSnapshot | null;
};

export type DisconnectedWorkbenchExecution =
  | { handled: false }
  | { handled: true; success: true; result: Record<string, unknown> }
  | { handled: true; success: false; error: string };

const DISCONNECTED_NOTE =
  "Stage tab is disconnected. This result is from the last persisted Director project and/or the live Blender kernel. Mutations, capture, and live viewport layout still need a visible Stage tab.";

function blenderCounts(scene: BlenderLiveSceneSnapshot) {
  return {
    assets: 0,
    objects: scene.objects.length,
    cameras: scene.cameras.length,
    lights: scene.lights.length,
    storyboard_shots: 0,
    performance_takes: 0,
    coverage_sequences: 0,
    coverage_shots: 0,
  };
}

function blenderActiveCameraId(scene: BlenderLiveSceneSnapshot) {
  return scene.cameras.find((camera) => camera.active)?.id ?? scene.cameras[0]?.id ?? null;
}

function observeBlenderScene(
  scene: BlenderLiveSceneSnapshot,
  fields?: DirectorWorkbenchObserveField[],
): Record<string, unknown> {
  const counts = blenderCounts(scene);
  const objects = scene.objects.map((object) => ({
    id: object.directorId ?? object.id,
    name: object.name,
    kind: object.kind,
    visible: object.visible,
    transform: { position: object.position, rotation: object.rotation, scale: object.scale },
    parent_id: object.parentId,
    dimensions: object.dimensions,
  }));
  const cameras = scene.cameras.map((camera) => ({
    id: camera.id,
    name: camera.name,
    position: camera.position,
    focal_length_mm: camera.focalLengthMm,
  }));
  const ui = {
    selectedObjectIds: [...scene.selectedObjectIds],
    selectedObjectId: scene.activeObjectId,
    activeCameraId: blenderActiveCameraId(scene),
    currentFrame: scene.frame,
  };
  const complete: Record<string, unknown> = {
    ui,
    active_camera_id: blenderActiveCameraId(scene),
    objects,
    cameras,
    lights: scene.lights,
    counts,
    graph_issues: [],
  };
  if (!fields?.length) return complete;
  const selected: Record<string, unknown> = {
    active_camera_id: blenderActiveCameraId(scene),
    requested_fields: fields,
  };
  fields.forEach((field) => {
    if (field === "characters") {
      selected.characters = objects.filter((object) => object.kind === "character");
      return;
    }
    selected[field] = complete[field] ?? null;
  });
  return selected;
}

function preferBlenderKernel(sources: DisconnectedWorkbenchSources) {
  if (!sources.blenderScene) return false;
  if (!sources.project) return true;
  return sources.blenderScene.objects.length > sources.project.objects.length;
}

function disconnectedMeta(sources: DisconnectedWorkbenchSources, source: string) {
  return {
    workbench_connected: false,
    source,
    note: DISCONNECTED_NOTE,
    project_revision: sources.project ? getDirectorProjectRevision(sources.project) : null,
    kernel_counts: sources.blenderScene ? blenderCounts(sources.blenderScene) : null,
    project_counts: sources.project ? directorProjectObservationCounts(sources.project) : null,
  };
}

function disconnectedCapabilities() {
  const capabilities = structuredClone(directorWorkbenchCapabilities) as Record<string, unknown>;
  return {
    ...capabilities,
    operations: directorWorkbenchOperationNames,
    workbench_connected: false,
    source: "gateway",
    note: DISCONNECTED_NOTE,
  };
}

/**
 * Durable reads that can be answered without a live Stage tab.
 * Mutations, capture, and revision deltas still require the browser.
 */
export function canServeDisconnectedWorkbenchRead(operation: DirectorWorkbenchOperation): boolean {
  if (operation.op === "observe") {
    return !operation.since_revision && !operation.since_turn && !operation.since_audit;
  }
  return (
    operation.op === "capabilities" ||
    operation.op === "audit" ||
    operation.op === "query_objects" ||
    operation.op === "inspect"
  );
}

/**
 * Serve durable workbench reads when no Stage tab is connected.
 *
 * @param operation - Parsed director_workbench operation.
 * @param sources - Persisted project and optional live Blender snapshot.
 */
export function executeDisconnectedWorkbenchRead(
  operation: DirectorWorkbenchOperation,
  sources: DisconnectedWorkbenchSources,
): DisconnectedWorkbenchExecution {
  if (operation.op === "capabilities") {
    return { handled: true, success: true, result: disconnectedCapabilities() };
  }

  if (operation.op === "inspect" && operation.entity === "catalog_asset") {
    const value = getDirectorAgentCatalogAsset(operation.id);
    return value
      ? {
          handled: true,
          success: true,
          result: { entity: operation.entity, value, ...disconnectedMeta(sources, "catalog") },
        }
      : {
          handled: true,
          success: false,
          error: `No catalog asset with id "${operation.id}" exists. Search director_workbench catalog assets instead of guessing an ID.`,
        };
  }

  if (operation.op === "observe") {
    if (operation.since_revision || operation.since_turn || operation.since_audit) return { handled: false };
    const useBlender = preferBlenderKernel(sources);
    if (useBlender && sources.blenderScene) {
      return {
        handled: true,
        success: true,
        result: {
          ...observeBlenderScene(sources.blenderScene, operation.fields),
          ...disconnectedMeta(sources, "blender_kernel"),
        },
      };
    }
    if (sources.project) {
      return {
        handled: true,
        success: true,
        result: {
          ...observeDirectorProject(sources.project, operation.fields, {
            objectMode: operation.object_mode,
            maxObjects: operation.max_objects,
          }),
          ...disconnectedMeta(sources, "persisted_project"),
        },
      };
    }
    return { handled: false };
  }

  if (operation.op === "audit") {
    if (sources.project) {
      const audit = auditDirectorProject(sources.project, {
        camera_id: operation.camera_id,
        subject_id: operation.subject_id,
        include_spatial: operation.include_spatial,
      });
      const kernelAhead = sources.blenderScene && sources.blenderScene.objects.length > sources.project.objects.length;
      const issues = kernelAhead
        ? [
            {
              severity: "warning" as const,
              code: "workbench_disconnected_kernel_ahead",
              message: `Live Blender has ${sources.blenderScene!.objects.length} objects; last persisted Director project has ${sources.project.objects.length}. audit.ready reflects the persisted project. Open a Stage tab to resync.`,
            },
            ...audit.issues,
          ]
        : audit.issues;
      const warningCount = issues.filter((issue) => issue.severity === "warning").length;
      return {
        handled: true,
        success: true,
        result: {
          ...audit,
          issues: issues.slice(0, 80),
          issue_count: issues.length,
          warning_count: warningCount,
          kernel_ahead: Boolean(kernelAhead),
          ...disconnectedMeta(sources, "persisted_project"),
        },
      };
    }
    if (sources.blenderScene) {
      const counts = blenderCounts(sources.blenderScene);
      return {
        handled: true,
        success: true,
        result: {
          ready: false,
          visual_judgment: false,
          scope: ["structure"],
          summary: `Stage tab is disconnected and no Director project is persisted. Live Blender has ${counts.objects} objects, ${counts.cameras} cameras, ${counts.lights} lights. Use blender_native scene/inspect, or reopen a Stage tab for structural audit.`,
          issue_count: 0,
          error_count: 0,
          warning_count: 0,
          issues: [],
          ...disconnectedMeta(sources, "blender_kernel"),
        },
      };
    }
    return { handled: false };
  }

  if (operation.op === "query_objects" && sources.project) {
    try {
      return {
        handled: true,
        success: true,
        result: {
          ...queryDirectorObjects(
            sources.project,
            {
              spatial: operation.spatial,
              namePattern: operation.name_pattern,
              kind: operation.kind,
            },
            {
              includeHidden: operation.include_hidden,
              maxResults: operation.max_results,
            },
          ),
          ...disconnectedMeta(sources, "persisted_project"),
        },
      };
    } catch (error) {
      return {
        handled: true,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (operation.op === "inspect" && operation.entity !== "catalog_asset") {
    if (!sources.project && !sources.blenderScene) return { handled: false };
    const project = sources.project;
    let value: unknown;
    if (project) {
      if (operation.entity === "object") value = project.objects.find((item) => item.id === operation.id);
      else if (operation.entity === "light") value = project.lights?.find((item) => item.id === operation.id);
      else if (operation.entity === "camera") value = project.cameras.find((item) => item.id === operation.id);
      else if (operation.entity === "asset") value = project.assets.find((item) => item.id === operation.id);
    }
    if (value) {
      return {
        handled: true,
        success: true,
        result: { entity: operation.entity, value, ...disconnectedMeta(sources, "persisted_project") },
      };
    }
    const blenderObject = sources.blenderScene?.objects.find(
      (item) => item.id === operation.id || item.directorId === operation.id,
    );
    if (blenderObject && (operation.entity === "object" || operation.entity === "camera")) {
      return {
        handled: true,
        success: true,
        result: { entity: operation.entity, value: blenderObject, ...disconnectedMeta(sources, "blender_kernel") },
      };
    }
    return {
      handled: true,
      success: false,
      error: `No ${operation.entity} with id "${operation.id}" exists. Use director_workbench observe first.`,
    };
  }

  return { handled: false };
}
