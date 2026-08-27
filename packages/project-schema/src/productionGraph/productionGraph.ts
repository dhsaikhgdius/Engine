/**
 * Deterministic identity, ordering, canonicalization, and query helpers for
 * the production graph.
 *
 * Everything here is engineered for reproducibility: node ids embed
 * percent-encoded source ids (reversible, transport-safe), edge ids are
 * content hashes of (kind, from, to, role), and canonical JSON sorts both
 * object keys and graph arrays. Two independently produced graphs of the same
 * project therefore share one fingerprint, which is what makes graph diffing
 * and revision pinning trustworthy.
 */
import { compareText } from "@director/protocol/primitives";
import { sha256HexSync } from "../directorProjectRevision";
import {
  PRODUCTION_GRAPH_EDGE_KINDS,
  PRODUCTION_GRAPH_NODE_KINDS,
  parseProductionGraph,
  type ProductionGraphEdge,
  type ProductionGraphEdgeKind,
  type ProductionGraphFingerprint,
  type ProductionGraphNode,
  type ProductionGraphNodeKind,
  type ProductionGraphNodeOfKind,
  type ProductionGraphV1,
} from "./productionGraphSchema";

export type {
  ProductionGraphEdge,
  ProductionGraphEdgeKind,
  ProductionGraphFingerprint,
  ProductionGraphNode,
  ProductionGraphNodeKind,
  ProductionGraphNodeOfKind,
  ProductionGraphV1,
} from "./productionGraphSchema";

const nodeKindOrder = new Map<ProductionGraphNodeKind, number>(
  PRODUCTION_GRAPH_NODE_KINDS.map((kind, index) => [kind, index]),
);
const edgeKindOrder = new Map<ProductionGraphEdgeKind, number>(
  PRODUCTION_GRAPH_EDGE_KINDS.map((kind, index) => [kind, index]),
);

/** Percent-encoding makes source IDs reversible while keeping graph IDs transport-safe. */
export function encodeProductionGraphIdComponent(value: string): string {
  if (!value) throw new TypeError("ProductionGraph source IDs must not be empty.");
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds a deterministic graph node id from a kind and source id.
 *
 * @param kind - The node kind.
 * @param sourceId - The source-specific id.
 * @returns A namespaced id like "asset:my-asset".
 */
export function getProductionGraphNodeId(kind: ProductionGraphNodeKind, sourceId: string): string {
  return `${kind}:${encodeProductionGraphIdComponent(sourceId)}`;
}

/**
 * Builds a deterministic edge id from kind, from/to nodes, and optional role.
 *
 * @param kind - The edge kind.
 * @param from - The source node id.
 * @param to - The target node id.
 * @param role - Optional edge role.
 * @returns A SHA-256-based edge id.
 */
export function getProductionGraphEdgeId(
  kind: ProductionGraphEdgeKind,
  from: string,
  to: string,
  role?: string,
): string {
  const digest = sha256HexSync(JSON.stringify([kind, from, to, role ?? null]));
  return `edge:${kind}:sha256:${digest}`;
}

export function compareProductionGraphNodes(left: ProductionGraphNode, right: ProductionGraphNode): number {
  return (
    (nodeKindOrder.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
      (nodeKindOrder.get(right.kind) ?? Number.MAX_SAFE_INTEGER) || compareText(left.id, right.id)
  );
}

/** Compares two edges by kind, from, to, role, then id. */
export function compareProductionGraphEdges(left: ProductionGraphEdge, right: ProductionGraphEdge): number {
  return (
    (edgeKindOrder.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
      (edgeKindOrder.get(right.kind) ?? Number.MAX_SAFE_INTEGER) ||
    compareText(left.from, right.from) ||
    compareText(left.to, right.to) ||
    compareText(left.role ?? "", right.role ?? "") ||
    compareText(left.id, right.id)
  );
}

export function sortProductionGraphNodes(nodes: readonly ProductionGraphNode[]): ProductionGraphNode[] {
  return [...nodes].sort(compareProductionGraphNodes);
}

/** Returns a sorted copy of the edges array. */
export function sortProductionGraphEdges(edges: readonly ProductionGraphEdge[]): ProductionGraphEdge[] {
  return [...edges].sort(compareProductionGraphEdges);
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { readonly [key: string]: CanonicalValue };

function canonicalizeValue(value: unknown, path: string): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`ProductionGraph requires a finite number at ${path}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalizeValue(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const result: Record<string, CanonicalValue> = {};
    Object.keys(value)
      .sort(compareText)
      .forEach((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) result[key] = canonicalizeValue(item, `${path}.${key}`);
      });
    return result;
  }
  throw new TypeError(`ProductionGraph cannot canonicalize ${typeof value} at ${path}.`);
}

/** Canonical JSON is independent of insertion order and graph array order. */
export function canonicalizeProductionGraph(graphInput: ProductionGraphV1): string {
  const graph = parseProductionGraph(graphInput);
  const canonicalGraph = {
    schema: graph.schema,
    version: graph.version,
    productionId: graph.productionId,
    nodes: sortProductionGraphNodes(graph.nodes),
    edges: sortProductionGraphEdges(graph.edges),
  } satisfies ProductionGraphV1;
  return JSON.stringify(canonicalizeValue(canonicalGraph, "$"));
}

/** Fingerprints only the versioned graph contract, never browser/runtime state. */
export function getProductionGraphFingerprint(graph: ProductionGraphV1): ProductionGraphFingerprint {
  return `production-graph:v1:sha256:${sha256HexSync(canonicalizeProductionGraph(graph))}`;
}

/** A read-only index for efficient graph queries. */
export interface ProductionGraphIndex {
  /** Nodes by id. */
  readonly nodesById: ReadonlyMap<string, ProductionGraphNode>;
  /** Nodes grouped by kind. */
  readonly nodesByKind: ReadonlyMap<ProductionGraphNodeKind, readonly ProductionGraphNode[]>;
  /** Outgoing edges by source node id. */
  readonly outgoingByNodeId: ReadonlyMap<string, readonly ProductionGraphEdge[]>;
  /** Incoming edges by target node id. */
  readonly incomingByNodeId: ReadonlyMap<string, readonly ProductionGraphEdge[]>;
}

function appendMapValue<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Builds a read-only query index. Integrity should be checked before indexing untrusted graphs. */
export function createProductionGraphIndex(graph: ProductionGraphV1): ProductionGraphIndex {
  const nodesById = new Map<string, ProductionGraphNode>();
  const nodesByKind = new Map<ProductionGraphNodeKind, ProductionGraphNode[]>();
  const outgoingByNodeId = new Map<string, ProductionGraphEdge[]>();
  const incomingByNodeId = new Map<string, ProductionGraphEdge[]>();

  sortProductionGraphNodes(graph.nodes).forEach((node) => {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
    appendMapValue(nodesByKind, node.kind, node);
  });
  sortProductionGraphEdges(graph.edges).forEach((edge) => {
    appendMapValue(outgoingByNodeId, edge.from, edge);
    appendMapValue(incomingByNodeId, edge.to, edge);
  });

  return { nodesById, nodesByKind, outgoingByNodeId, incomingByNodeId };
}

/**
 * Looks up a single node by id from the graph.
 *
 * @param graph - The production graph.
 * @param id - The node id.
 * @returns The node, or undefined if not found.
 */
export function getProductionGraphNode(graph: ProductionGraphV1, id: string): ProductionGraphNode | undefined {
  return createProductionGraphIndex(graph).nodesById.get(id);
}

/**
 * Returns all nodes of a given kind.
 *
 * @param graph - The production graph.
 * @param kind - The node kind.
 * @returns An array of nodes of that kind.
 */
export function getProductionGraphNodesByKind<Kind extends ProductionGraphNodeKind>(
  graph: ProductionGraphV1,
  kind: Kind,
): readonly ProductionGraphNodeOfKind<Kind>[] {
  return (createProductionGraphIndex(graph).nodesByKind.get(kind) ?? []) as readonly ProductionGraphNodeOfKind<Kind>[];
}

/** Query filters for production graph nodes. */
export interface ProductionGraphNodeQuery {
  /** Exact match on node id. */
  readonly id?: string;
  /** Exact match on node kind. */
  readonly kind?: ProductionGraphNodeKind;
  /** Exact match on node name. */
  readonly name?: string;
}

/** Deterministic node query used by UI and Agent read surfaces. */
export function queryProductionGraphNodes(
  graph: ProductionGraphV1,
  query: ProductionGraphNodeQuery = {},
): readonly ProductionGraphNode[] {
  return sortProductionGraphNodes(graph.nodes).filter(
    (node) =>
      (query.id === undefined || node.id === query.id) &&
      (query.kind === undefined || node.kind === query.kind) &&
      (query.name === undefined || node.name === query.name),
  );
}

/** Query filters for production graph edges. */
export interface ProductionGraphEdgeQuery {
  /** Exact match on edge kind. */
  readonly kind?: ProductionGraphEdgeKind;
  /** Exact match on source node id. */
  readonly from?: string;
  /** Exact match on target node id. */
  readonly to?: string;
  /** Exact match on edge role. */
  readonly role?: string;
}

/**
 * Deterministic edge query.
 *
 * @param graph - The production graph.
 * @param query - Optional filters on kind, from, to, and role.
 * @returns Matching edges in sorted order.
 */
export function queryProductionGraphEdges(
  graph: ProductionGraphV1,
  query: ProductionGraphEdgeQuery = {},
): readonly ProductionGraphEdge[] {
  return sortProductionGraphEdges(graph.edges).filter(
    (edge) =>
      (query.kind === undefined || edge.kind === query.kind) &&
      (query.from === undefined || edge.from === query.from) &&
      (query.to === undefined || edge.to === query.to) &&
      (query.role === undefined || edge.role === query.role),
  );
}

/** Direction for relation traversal queries. */
export type ProductionGraphRelationDirection = "incoming" | "outgoing" | "both";

/** Filters for relation queries. */
export interface ProductionGraphRelationQuery {
  /** Filter by edge kind. */
  readonly kind?: ProductionGraphEdgeKind;
  /** Filter by edge role. */
  readonly role?: string;
  /** Traversal direction. */
  readonly direction?: ProductionGraphRelationDirection;
}

/** A relation result connecting an edge to its neighboring node. */
export interface ProductionGraphRelation {
  /** The connecting edge. */
  readonly edge: ProductionGraphEdge;
  /** The neighboring node. */
  readonly node: ProductionGraphNode;
  /** Whether the node is the source or target of the edge. */
  readonly direction: Exclude<ProductionGraphRelationDirection, "both">;
}

/**
 * Returns neighboring nodes through an optional relation and direction filter.
 *
 * @param graph - The production graph.
 * @param nodeId - The node to find relations for.
 * @param query - Optional filters on kind, role, and direction.
 * @returns Sorted relations.
 */
export function getProductionGraphRelations(
  graph: ProductionGraphV1,
  nodeId: string,
  query: ProductionGraphRelationQuery = {},
): readonly ProductionGraphRelation[] {
  const index = createProductionGraphIndex(graph);
  const direction = query.direction ?? "both";
  const result: ProductionGraphRelation[] = [];

  if (direction !== "incoming") {
    (index.outgoingByNodeId.get(nodeId) ?? []).forEach((edge) => {
      const node = index.nodesById.get(edge.to);
      if (
        node &&
        (query.kind === undefined || edge.kind === query.kind) &&
        (query.role === undefined || edge.role === query.role)
      ) {
        result.push({ edge, node, direction: "outgoing" });
      }
    });
  }
  if (direction !== "outgoing") {
    (index.incomingByNodeId.get(nodeId) ?? []).forEach((edge) => {
      const node = index.nodesById.get(edge.from);
      if (
        node &&
        (query.kind === undefined || edge.kind === query.kind) &&
        (query.role === undefined || edge.role === query.role)
      ) {
        result.push({ edge, node, direction: "incoming" });
      }
    });
  }

  return result.sort(
    (left, right) =>
      compareProductionGraphEdges(left.edge, right.edge) ||
      compareText(left.direction, right.direction) ||
      compareProductionGraphNodes(left.node, right.node),
  );
}
