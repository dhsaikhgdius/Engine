import {
  PRODUCTION_GRAPH_EDGE_KINDS,
  PRODUCTION_GRAPH_NODE_KINDS,
  productionGraphSchema,
  type ProductionGraphEdge,
  type ProductionGraphEdgeKind,
  type ProductionGraphNodeKind,
  type ProductionGraphV1,
} from "./productionGraphSchema";
import { getProductionGraphEdgeId, getProductionGraphNodeId } from "./productionGraph";
import productionGraphProtocol from "./productionGraphProtocol.json";
import productionGraphRelations from "./productionGraphRelations.json";

/** Codes for integrity issues detected during graph validation. */
export type ProductionGraphIntegrityIssueCode = keyof typeof productionGraphProtocol.integrityIssueCodes;
/** All valid integrity issue codes. */
export const PRODUCTION_GRAPH_INTEGRITY_ISSUE_CODES = Object.keys(
  productionGraphProtocol.integrityIssueCodes,
) as ProductionGraphIntegrityIssueCode[];

/** A single integrity issue found during graph validation. */
export interface ProductionGraphIntegrityIssue {
  /** Machine-readable issue code. */
  readonly code: ProductionGraphIntegrityIssueCode;
  /** JSON path to the problematic value. */
  readonly path: string;
  /** Human-readable description. */
  readonly message: string;
  /** Related node id, if applicable. */
  readonly nodeId?: string;
  /** Related edge id, if applicable. */
  readonly edgeId?: string;
}

/** Validation result: either valid with the graph, or invalid with issues. */
export type ProductionGraphIntegrityResult =
  | { readonly valid: true; readonly graph: ProductionGraphV1; readonly issues: readonly [] }
  | {
      readonly valid: false;
      readonly graph?: ProductionGraphV1;
      readonly issues: readonly ProductionGraphIntegrityIssue[];
    };

/** An allowed relation pair: [fromNodeKind, toNodeKind]. */
export type ProductionGraphAllowedRelation = readonly [from: ProductionGraphNodeKind, to: ProductionGraphNodeKind];

/**
 * Semantic relation contract. Structural Zod validation proves the shape;
 * these pairs prove that an edge has a meaningful source and destination.
 */
const nodeKinds = new Set<string>(PRODUCTION_GRAPH_NODE_KINDS);
if (
  PRODUCTION_GRAPH_EDGE_KINDS.some(
    (kind) => !productionGraphRelations[kind]?.every(([from, to]) => nodeKinds.has(from) && nodeKinds.has(to)),
  )
) {
  throw new Error("Production graph relation data does not match the shared graph protocol.");
}
export const PRODUCTION_GRAPH_ALLOWED_RELATIONS = productionGraphRelations as unknown as Readonly<
  Record<ProductionGraphEdgeKind, readonly ProductionGraphAllowedRelation[]>
>;

function edgeIdentity(edge: ProductionGraphEdge): string {
  return JSON.stringify([edge.kind, edge.from, edge.to, edge.role ?? null]);
}

function getExpectedNodeId(node: ProductionGraphV1["nodes"][number]): string | null {
  switch (node.kind) {
    case "production":
      return getProductionGraphNodeId("production", node.source.sourceProductionId);
    case "scene":
      return getProductionGraphNodeId("scene", node.sourceSceneId);
    case "asset":
      return getProductionGraphNodeId("asset", node.sourceAssetId);
    case "object":
      return getProductionGraphNodeId("object", node.sourceObjectId);
    case "camera":
      return getProductionGraphNodeId("camera", node.sourceCameraId);
    case "shot":
      return getProductionGraphNodeId("shot", node.sourceShotId);
    case "take":
      return getProductionGraphNodeId("take", node.sourceTakeId);
    case "coverage":
      return getProductionGraphNodeId("coverage", `${node.sourceSequenceId}/${node.sourceCoverageId}`);
    case "artifact":
    case "job":
    case "review":
    case "approval":
      return null;
  }
}

/**
 * Checks whether an edge kind between two node kinds is allowed.
 *
 * @param edgeKind - The edge kind.
 * @param fromKind - The source node kind.
 * @param toKind - The target node kind.
 * @returns True if the relation is in the allowed set.
 */
export function isProductionGraphRelationAllowed(
  edgeKind: ProductionGraphEdgeKind,
  fromKind: ProductionGraphNodeKind,
  toKind: ProductionGraphNodeKind,
): boolean {
  return PRODUCTION_GRAPH_ALLOWED_RELATIONS[edgeKind].some(
    ([allowedFrom, allowedTo]) => allowedFrom === fromKind && allowedTo === toKind,
  );
}

function getParsedGraphIssues(graph: ProductionGraphV1): ProductionGraphIntegrityIssue[] {
  const issues: ProductionGraphIntegrityIssue[] = [];
  const nodeIndexById = new Map<string, number>();

  graph.nodes.forEach((node, index) => {
    const priorIndex = nodeIndexById.get(node.id);
    if (priorIndex === undefined) {
      nodeIndexById.set(node.id, index);
      return;
    }
    issues.push({
      code: "duplicate-node",
      path: `nodes.${index}.id`,
      nodeId: node.id,
      message: `Node id "${node.id}" duplicates nodes.${priorIndex}.id.`,
    });
  });

  graph.nodes.forEach((node, index) => {
    const expectedId = getExpectedNodeId(node);
    if (expectedId !== null && node.id !== expectedId) {
      issues.push({
        code: "node-id-mismatch",
        path: `nodes.${index}.id`,
        nodeId: node.id,
        message: `Node id "${node.id}" does not match its stable source-derived id "${expectedId}".`,
      });
    }
  });

  graph.nodes.forEach((node, index) => {
    if ((node.kind === "shot" || node.kind === "take" || node.kind === "coverage") && node.frameEnd < node.frameStart) {
      issues.push({
        code: "invalid-frame-range",
        path: `nodes.${index}.frameEnd`,
        nodeId: node.id,
        message: `Node "${node.id}" ends at frame ${node.frameEnd}, before frame ${node.frameStart}.`,
      });
    }
  });

  const productionNodes = graph.nodes.filter((node) => node.kind === "production");
  if (productionNodes.length === 0) {
    issues.push({
      code: "missing-production-node",
      path: "nodes",
      message: `ProductionGraph productionId "${graph.productionId}" has no production node.`,
    });
  } else {
    if (productionNodes.length > 1) {
      issues.push({
        code: "multiple-production-nodes",
        path: "nodes",
        message: `ProductionGraph must contain one production node; found ${productionNodes.length}.`,
      });
    }
    if (!productionNodes.some((node) => node.id === graph.productionId)) {
      issues.push({
        code: "production-id-mismatch",
        path: "productionId",
        nodeId: graph.productionId,
        message: `productionId "${graph.productionId}" does not identify a production node.`,
      });
    }
  }

  const edgeIndexById = new Map<string, number>();
  const edgeIndexByIdentity = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    const expectedEdgeId = getProductionGraphEdgeId(edge.kind, edge.from, edge.to, edge.role);
    if (edge.id !== expectedEdgeId) {
      issues.push({
        code: "edge-id-mismatch",
        path: `edges.${index}.id`,
        edgeId: edge.id,
        message: `Edge id "${edge.id}" does not match its stable content-derived id "${expectedEdgeId}".`,
      });
    }

    const priorIdIndex = edgeIndexById.get(edge.id);
    if (priorIdIndex === undefined) edgeIndexById.set(edge.id, index);
    else {
      issues.push({
        code: "duplicate-edge-id",
        path: `edges.${index}.id`,
        edgeId: edge.id,
        message: `Edge id "${edge.id}" duplicates edges.${priorIdIndex}.id.`,
      });
    }

    const identity = edgeIdentity(edge);
    const priorIdentityIndex = edgeIndexByIdentity.get(identity);
    if (priorIdentityIndex === undefined) edgeIndexByIdentity.set(identity, index);
    else {
      issues.push({
        code: "duplicate-edge",
        path: `edges.${index}`,
        edgeId: edge.id,
        message: `Edge ${edge.kind} ${edge.from} -> ${edge.to} duplicates edges.${priorIdentityIndex}.`,
      });
    }

    const sourceIndex = nodeIndexById.get(edge.from);
    const targetIndex = nodeIndexById.get(edge.to);
    if (sourceIndex === undefined) {
      issues.push({
        code: "dangling-edge-source",
        path: `edges.${index}.from`,
        edgeId: edge.id,
        nodeId: edge.from,
        message: `Edge "${edge.id}" references missing source node "${edge.from}".`,
      });
    }
    if (targetIndex === undefined) {
      issues.push({
        code: "dangling-edge-target",
        path: `edges.${index}.to`,
        edgeId: edge.id,
        nodeId: edge.to,
        message: `Edge "${edge.id}" references missing target node "${edge.to}".`,
      });
    }
    if (sourceIndex !== undefined && targetIndex !== undefined) {
      const source = graph.nodes[sourceIndex]!;
      const target = graph.nodes[targetIndex]!;
      if (!isProductionGraphRelationAllowed(edge.kind, source.kind, target.kind)) {
        issues.push({
          code: "invalid-edge-relation",
          path: `edges.${index}`,
          edgeId: edge.id,
          message: `Edge "${edge.id}" cannot connect ${source.kind} to ${target.kind} using ${edge.kind}.`,
        });
      }
    }
  });

  return issues;
}

/** Structural Zod validation followed by graph-level identity and reference validation. */
export function validateProductionGraphIntegrity(value: unknown): ProductionGraphIntegrityResult {
  const parsed = productionGraphSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema",
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const issues = getParsedGraphIssues(parsed.data);
  return issues.length === 0
    ? { valid: true, graph: parsed.data, issues: [] }
    : { valid: false, graph: parsed.data, issues };
}

/**
 * Returns all integrity issues for a graph without the Zod schema step.
 *
 * @param graph - The production graph.
 * @returns An array of integrity issues.
 */
export function getProductionGraphIntegrityIssues(graph: ProductionGraphV1): readonly ProductionGraphIntegrityIssue[] {
  return getParsedGraphIssues(graph);
}

/** Error thrown when a production graph fails integrity validation. */
export class ProductionGraphIntegrityError extends Error {
  /** The integrity issues that caused the error. */
  readonly issues: readonly ProductionGraphIntegrityIssue[];

  constructor(issues: readonly ProductionGraphIntegrityIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "ProductionGraphIntegrityError";
    this.issues = issues;
  }
}

/**
 * Asserts graph integrity, throwing if any issues are found.
 *
 * @param graph - The production graph.
 * @returns The graph unchanged.
 * @throws ProductionGraphIntegrityError if issues are found.
 */
export function assertProductionGraphIntegrity(graph: ProductionGraphV1): ProductionGraphV1 {
  const issues = getParsedGraphIssues(graph);
  if (issues.length > 0) throw new ProductionGraphIntegrityError(issues);
  return graph;
}
