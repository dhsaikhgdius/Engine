import type { DirectorProject } from "../directorProjectSchema";
import { getDirectorProjectRevision } from "../directorProjectRevision";
import {
  encodeProductionGraphIdComponent,
  getProductionGraphEdgeId,
  getProductionGraphNodeId,
  sortProductionGraphEdges,
  sortProductionGraphNodes,
} from "./productionGraph";
import {
  PRODUCTION_GRAPH_SCHEMA,
  PRODUCTION_GRAPH_SCHEMA_VERSION,
  parseProductionGraph,
  type ProductionGraphEdge,
  type ProductionGraphEdgeKind,
  type ProductionGraphNode,
  type ProductionGraphV1,
} from "./productionGraphSchema";

const DEFAULT_SOURCE_PRODUCTION_ID = "director-project";
const DEFAULT_SOURCE_SCENE_ID = "main";

/** Options for projecting a DirectorProject into a production graph. */
export interface DirectorProjectProductionGraphOptions {
  /** Stable source identity supplied by a host once project IDs exist. */
  readonly sourceProductionId?: string;
  /** Stable source identity for the single DirectorProject scene projection. */
  readonly sourceSceneId?: string;
  /** Override production name. */
  readonly productionName?: string;
  /** Override scene name. */
  readonly sceneName?: string;
}

function nonEmptyName(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

/**
 * Projects the complete identity/reference layer of DirectorProject into a
 * stable graph. Broken source references deliberately become dangling graph
 * edges so the integrity audit can report them instead of silently erasing
 * evidence.
 *
 * @param projectInput - The Director project to project.
 * @param options - Optional source identities and name overrides.
 * @returns A validated production graph.
 */
export function createProductionGraphFromDirectorProject(
  projectInput: DirectorProject,
  options: DirectorProjectProductionGraphOptions = {},
): ProductionGraphV1 {
  const project = projectInput;
  const revision = getDirectorProjectRevision(project);
  const sourceProductionId = options.sourceProductionId ?? DEFAULT_SOURCE_PRODUCTION_ID;
  const sourceSceneId = options.sourceSceneId ?? DEFAULT_SOURCE_SCENE_ID;
  const productionId = getProductionGraphNodeId("production", sourceProductionId);
  const sceneId = getProductionGraphNodeId("scene", sourceSceneId);
  const nodes: ProductionGraphNode[] = [];
  const edges: ProductionGraphEdge[] = [];

  function addEdge(kind: ProductionGraphEdgeKind, from: string, to: string, role?: string): void {
    edges.push({
      kind,
      id: getProductionGraphEdgeId(kind, from, to, role),
      from,
      to,
      ...(role ? { role } : {}),
    });
  }

  nodes.push({
    kind: "production",
    id: productionId,
    name: nonEmptyName(options.productionName ?? project.storyboard?.title, "Director Production"),
    source: { kind: "director-project", version: 1, sourceProductionId, revision },
  });
  nodes.push({
    kind: "scene",
    id: sceneId,
    name: nonEmptyName(options.sceneName, "Main Stage"),
    sourceSceneId,
    sourceRevision: revision,
  });
  addEdge("contains", productionId, sceneId, "stage");

  for (const asset of project.assets) {
    const assetId = getProductionGraphNodeId("asset", asset.id);
    nodes.push({
      kind: "asset",
      id: assetId,
      name: nonEmptyName(asset.name, asset.fileName),
      sourceAssetId: asset.id,
      assetKind: asset.kind,
      sourceType: asset.sourceType,
      ...(asset.assetSource ? { assetSource: asset.assetSource } : {}),
      fileName: asset.fileName,
    });
    addEdge("contains", productionId, assetId, "asset-library");
  }

  for (const object of project.objects) {
    const objectId = getProductionGraphNodeId("object", object.id);
    nodes.push({
      kind: "object",
      id: objectId,
      name: nonEmptyName(object.name, object.id),
      sourceObjectId: object.id,
      objectKind: object.kind,
      visible: object.visible,
      ...(object.assetRefId ? { assetRefId: object.assetRefId } : {}),
    });
    addEdge("contains", sceneId, objectId, "scene-object");
    if (object.assetRefId) {
      addEdge("uses", objectId, getProductionGraphNodeId("asset", object.assetRefId), "asset");
    }
    if (object.parentObjectId) {
      addEdge("references", objectId, getProductionGraphNodeId("object", object.parentObjectId), "parent");
    }
    if (object.lookTargetObjectId) {
      addEdge("references", objectId, getProductionGraphNodeId("object", object.lookTargetObjectId), "look-target");
    }
    if (object.linkedCameraId) {
      addEdge("references", objectId, getProductionGraphNodeId("camera", object.linkedCameraId), "linked-camera");
    }
  }

  for (const camera of project.cameras) {
    const cameraId = getProductionGraphNodeId("camera", camera.id);
    nodes.push({
      kind: "camera",
      id: cameraId,
      name: nonEmptyName(camera.name, camera.id),
      sourceCameraId: camera.id,
      ...(camera.focalLengthMm !== undefined ? { focalLengthMm: camera.focalLengthMm } : {}),
      ...(camera.aspectRatio ? { aspectRatio: camera.aspectRatio } : {}),
      ...(camera.targetObjectId !== undefined ? { targetObjectId: camera.targetObjectId } : {}),
    });
    addEdge("contains", sceneId, cameraId, "camera");
    if (camera.targetObjectId) {
      addEdge("references", cameraId, getProductionGraphNodeId("object", camera.targetObjectId), "target");
    }
    if (camera.action?.follow?.targetObjectId) {
      addEdge(
        "references",
        cameraId,
        getProductionGraphNodeId("object", camera.action.follow.targetObjectId),
        "follow-target",
      );
    }
    if (camera.action?.path?.targetObjectId) {
      addEdge(
        "references",
        cameraId,
        getProductionGraphNodeId("object", camera.action.path.targetObjectId),
        "path-target",
      );
    }
  }

  if (project.activeCameraId) {
    addEdge("references", sceneId, getProductionGraphNodeId("camera", project.activeCameraId), "active-camera");
  }
  if (project.panoramaAssetId) {
    addEdge("uses", sceneId, getProductionGraphNodeId("asset", project.panoramaAssetId), "panorama");
  }

  for (const shot of project.storyboard?.shots ?? []) {
    const shotId = getProductionGraphNodeId("shot", shot.id);
    nodes.push({
      kind: "shot",
      id: shotId,
      name: nonEmptyName(shot.title, shot.id),
      sourceShotId: shot.id,
      source: "storyboard",
      ...(shot.scriptBeatId ? { scriptBeatId: shot.scriptBeatId } : {}),
      cameraId: shot.cameraId,
      frameStart: shot.frameStart,
      frameEnd: shot.frameEnd,
    });
    addEdge("contains", sceneId, shotId, "storyboard-shot");
    if (shot.cameraId) {
      addEdge("uses", shotId, getProductionGraphNodeId("camera", shot.cameraId), "camera");
    }
    for (const output of shot.generation?.outputs ?? []) {
      const jobId = getProductionGraphNodeId("job", output.jobId);
      nodes.push({
        kind: "job",
        id: jobId,
        name: `${shot.title} · ${output.kind}`,
        jobType: output.kind,
        status: "succeeded",
        attempt: 1,
      });
      addEdge("contains", productionId, jobId, "storyboard-generation");
      addEdge("uses", jobId, shotId, "source-shot");
      output.mediaIds.forEach((mediaId, mediaIndex) => {
        const artifactId = getProductionGraphNodeId("artifact", `${output.jobId}/${mediaId}`);
        nodes.push({
          kind: "artifact",
          id: artifactId,
          name: mediaId,
          artifactKind:
            output.kind === "image.generate" ? "image" : output.kind === "video.generate" ? "video" : "audio",
          version: 1,
          immutable: true,
          uri: mediaId,
        });
        addEdge("contains", productionId, artifactId, "gallery-media");
        addEdge("renders", jobId, artifactId, output.artifactIds[mediaIndex] ?? "output");
        addEdge("derived_from", artifactId, shotId, "source-shot");
      });
    }
  }

  for (const take of project.production?.takes ?? []) {
    const takeId = getProductionGraphNodeId("take", take.id);
    nodes.push({
      kind: "take",
      id: takeId,
      name: nonEmptyName(take.name, take.id),
      sourceTakeId: take.id,
      frameStart: take.frameStart,
      frameEnd: take.frameEnd,
    });
    addEdge("contains", productionId, takeId, "performance-take");
    for (const objectId of take.objectIds) {
      addEdge("uses", takeId, getProductionGraphNodeId("object", objectId), "cast");
    }
    for (const track of take.entityTracks) {
      addEdge(
        "uses",
        takeId,
        getProductionGraphNodeId("object", track.objectId),
        `entity-track:${encodeProductionGraphIdComponent(track.id)}`,
      );
    }
  }

  for (const sequence of project.production?.sequences ?? []) {
    for (const coverage of sequence.shots) {
      const coverageSourceId = `${sequence.id}/${coverage.id}`;
      const coverageId = getProductionGraphNodeId("coverage", coverageSourceId);
      nodes.push({
        kind: "coverage",
        id: coverageId,
        name: nonEmptyName(coverage.name, coverage.id),
        sourceCoverageId: coverage.id,
        sourceSequenceId: sequence.id,
        cameraId: coverage.cameraId,
        takeId: coverage.takeId,
        ...(coverage.storyboardShotId ? { storyboardShotId: coverage.storyboardShotId } : {}),
        frameStart: coverage.frameStart,
        frameEnd: coverage.frameEnd,
      });
      addEdge("contains", productionId, coverageId, "coverage-shot");
      addEdge("uses", coverageId, getProductionGraphNodeId("camera", coverage.cameraId), "camera");
      addEdge("uses", coverageId, getProductionGraphNodeId("take", coverage.takeId), "take");
      if (coverage.storyboardShotId) {
        addEdge(
          "references",
          coverageId,
          getProductionGraphNodeId("shot", coverage.storyboardShotId),
          "storyboard-shot",
        );
      }
    }
  }

  // Canonical ordering + a final parse make the projection deterministic and
  // self-validating: the same project always serializes to the same graph
  // bytes (diffable across revisions), and a projection bug fails loudly here
  // rather than producing a silently malformed graph.
  return parseProductionGraph({
    schema: PRODUCTION_GRAPH_SCHEMA,
    version: PRODUCTION_GRAPH_SCHEMA_VERSION,
    productionId,
    nodes: sortProductionGraphNodes(nodes),
    edges: sortProductionGraphEdges(edges),
  });
}
