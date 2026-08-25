import { describe, expect, it } from "vitest";
import type { DirectorProject } from "../../../../src/comprehensive/editor/schema/directorProject";
import { createProductionGraphFromDirectorProject } from "../../../../src/comprehensive/editor/productionGraph/directorProjectProductionGraph";
import {
  canonicalizeProductionGraph,
  getProductionGraphEdgeId,
  getProductionGraphFingerprint,
  getProductionGraphNodeId,
  getProductionGraphNodesByKind,
  getProductionGraphRelations,
  queryProductionGraphEdges,
} from "../../../../src/comprehensive/editor/productionGraph/productionGraph";
import { validateProductionGraphIntegrity } from "../../../../src/comprehensive/editor/productionGraph/productionGraphIntegrity";
import {
  safeParseProductionGraph,
  type ProductionGraphV1,
} from "../../../../src/comprehensive/editor/productionGraph/productionGraphSchema";

function createProject(): DirectorProject {
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor: "#20242c",
      panoramaYaw: 0,
      panoramaRadius: 60,
      showLabels: true,
      snapToGrid: false,
      showGround: true,
      groundOpacity: 0.4,
      groundHeight: 0,
      timeline: {
        version: 1,
        fps: 24,
        frameStart: 0,
        frameEnd: 120,
        currentFrame: 0,
        loop: false,
      },
    },
    assets: [
      {
        id: "shared-id",
        kind: "character",
        sourceType: "model",
        fileName: "actor.glb",
        name: "Actor asset",
        url: "/assets/actor.glb",
        assetSource: "library",
      },
    ],
    objects: [
      {
        id: "shared-id",
        name: "Stage mark",
        kind: "prop",
        visible: true,
        locked: false,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: "actor-a",
        name: "Actor A",
        kind: "character",
        visible: true,
        locked: false,
        assetRefId: "shared-id",
        parentObjectId: "shared-id",
        lookTargetObjectId: "shared-id",
        transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ],
    cameras: [
      {
        id: "shared-id",
        name: "A Camera",
        fov: 45,
        focalLengthMm: 35,
        aspectRatio: "16:9",
        transform: { position: [0, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        targetMode: "object",
        targetObjectId: "actor-a",
        target: [1, 1, 0],
      },
    ],
    storyboard: {
      version: 1,
      title: "Graph fixture",
      logline: "One actor crosses a mark.",
      shots: [
        {
          id: "board-a",
          scriptBeatId: "beat-a",
          title: "Master",
          cameraId: "shared-id",
          frameStart: 0,
          frameEnd: 48,
          shotSize: "wide",
          movement: "static",
          action: "Actor crosses.",
        },
      ],
    },
    production: {
      version: 1,
      activeTakeId: "take-a",
      activeSequenceId: "sequence-a",
      takes: [
        {
          id: "take-a",
          name: "Performance A",
          frameStart: 0,
          frameEnd: 48,
          objectIds: ["actor-a", "shared-id"],
          entityTracks: [
            {
              id: "track-a",
              objectId: "actor-a",
              animation: { version: 1, keyframes: [{ frame: 0 }, { frame: 48 }] },
            },
          ],
        },
      ],
      sequences: [
        {
          id: "sequence-a",
          name: "Coverage A",
          shots: [
            {
              id: "coverage-a",
              name: "Master coverage",
              takeId: "take-a",
              cameraId: "shared-id",
              frameStart: 0,
              frameEnd: 48,
              storyboardShotId: "board-a",
            },
          ],
        },
      ],
    },
    activeCameraId: "shared-id",
    panoramaAssetId: null,
  };
}

describe("ProductionGraph v1", () => {
  it("projects DirectorProject deterministically with collision-safe namespaced IDs", () => {
    const first = createProductionGraphFromDirectorProject(createProject());
    const second = createProductionGraphFromDirectorProject(structuredClone(createProject()));

    expect(first).toEqual(second);
    expect(first.schema).toBe("director.production-graph");
    expect(first.version).toBe(1);
    expect(first.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(["asset:shared-id", "object:shared-id", "camera:shared-id"]),
    );
    expect(new Set(first.nodes.map((node) => node.id)).size).toBe(first.nodes.length);
    expect(validateProductionGraphIntegrity(first)).toMatchObject({ valid: true, issues: [] });
  });

  it("projects typed cross-object, camera, asset, take, and storyboard references", () => {
    const graph = createProductionGraphFromDirectorProject(createProject());
    const actorId = getProductionGraphNodeId("object", "actor-a");

    expect(getProductionGraphRelations(graph, actorId, { role: "parent" })).toEqual([
      expect.objectContaining({ node: expect.objectContaining({ id: "object:shared-id" }) }),
    ]);
    expect(getProductionGraphRelations(graph, actorId, { role: "look-target" })).toEqual([
      expect.objectContaining({ node: expect.objectContaining({ id: "object:shared-id" }) }),
    ]);
    expect(queryProductionGraphEdges(graph, { from: actorId, role: "asset" })[0]?.to).toBe("asset:shared-id");
    expect(queryProductionGraphEdges(graph, { from: "coverage:sequence-a%2Fcoverage-a", role: "take" })[0]?.to).toBe(
      "take:take-a",
    );
    expect(getProductionGraphNodesByKind(graph, "camera")[0]).toMatchObject({ sourceCameraId: "shared-id" });
  });

  it("projects Storyboard generation jobs and promoted Gallery artifacts as durable lineage", () => {
    const project = createProject();
    project.storyboard!.shots[0]!.generation = {
      workflowId: "comfy-workflow-image-main",
      nodeIds: ["node-a"],
      parameters: { "12.cfg": 6.5 },
      outputs: [
        {
          jobId: "generation-job-1",
          kind: "image.generate",
          workflowId: "comfy-workflow-image-main",
          mediaIds: ["creative-media:image:abc"],
          artifactIds: ["artifact-image-1"],
          prompt: "Master shot",
          negativePrompt: "blur",
          seed: 17,
          promotedAt: "2026-08-07T00:00:00.000Z",
        },
      ],
    };
    const graph = createProductionGraphFromDirectorProject(project);
    const jobId = getProductionGraphNodeId("job", "generation-job-1");
    const artifactId = getProductionGraphNodeId("artifact", "generation-job-1/creative-media:image:abc");

    expect(getProductionGraphNodesByKind(graph, "job")).toContainEqual(
      expect.objectContaining({ id: jobId, jobType: "image.generate", status: "succeeded" }),
    );
    expect(getProductionGraphNodesByKind(graph, "artifact")).toContainEqual(
      expect.objectContaining({ id: artifactId, artifactKind: "image", uri: "creative-media:image:abc" }),
    );
    expect(queryProductionGraphEdges(graph, { from: jobId, kind: "uses", role: "source-shot" })[0]?.to).toBe(
      "shot:board-a",
    );
    expect(queryProductionGraphEdges(graph, { from: jobId, kind: "renders" })[0]?.to).toBe(artifactId);
    expect(validateProductionGraphIntegrity(graph)).toMatchObject({ valid: true, issues: [] });
  });

  it("reports a dangling cross-object reference instead of losing it", () => {
    const project = createProject();
    project.objects[1]!.lookTargetObjectId = "missing-object";
    const graph = createProductionGraphFromDirectorProject(project);
    const result = validateProductionGraphIntegrity(graph);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dangling-edge-target",
          nodeId: "object:missing-object",
        }),
      ]),
    );
  });

  it("rejects a structurally valid edge whose relation has illegal endpoint kinds", () => {
    const graph = createProductionGraphFromDirectorProject(createProject());
    const from = "asset:shared-id";
    const to = graph.productionId;
    const illegalEdge = {
      kind: "contains" as const,
      id: getProductionGraphEdgeId("contains", from, to, "illegal"),
      from,
      to,
      role: "illegal",
    };
    const invalidGraph: ProductionGraphV1 = { ...graph, edges: [...graph.edges, illegalEdge] };
    const result = validateProductionGraphIntegrity(invalidGraph);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid-edge-relation", edgeId: illegalEdge.id })]),
    );
  });

  it("produces the same canonical fingerprint for the same graph independent of array order", () => {
    const graph = createProductionGraphFromDirectorProject(createProject());
    const reordered: ProductionGraphV1 = {
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };

    expect(canonicalizeProductionGraph(reordered)).toBe(canonicalizeProductionGraph(graph));
    expect(getProductionGraphFingerprint(reordered)).toBe(getProductionGraphFingerprint(graph));
    expect(getProductionGraphFingerprint(graph)).toMatch(/^production-graph:v1:sha256:[a-f0-9]{64}$/);
  });

  it("enforces node namespaces and edge IDs at the Zod boundary", () => {
    const graph = createProductionGraphFromDirectorProject(createProject());
    const firstAssetIndex = graph.nodes.findIndex((node) => node.kind === "asset");
    const malformed = structuredClone(graph) as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    malformed.nodes[firstAssetIndex]!.id = "object:not-an-asset";

    expect(safeParseProductionGraph(malformed).success).toBe(false);
  });
});
