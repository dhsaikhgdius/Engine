/** A node in the Canvas production DAG graph. */
export interface DirectorCanvasDagNode {
  /** Stable unique identifier for this node. */
  id: string;
}

/** A directed edge connecting two nodes in the Canvas production DAG. */
export interface DirectorCanvasDagEdge {
  /** Stable unique identifier for this edge. */
  id: string;
  /** The node id this edge originates from. */
  sourceNodeId: string;
  /** The node id this edge points to. */
  targetNodeId: string;
}

/** Validation issue codes for the Canvas DAG. */
export type DirectorCanvasDagIssueCode =
  "dangling_source" | "dangling_target" | "self_edge" | "duplicate_edge" | "cycle";

/** A validation issue found during DAG analysis. */
export interface DirectorCanvasDagIssue {
  /** The category of issue detected. */
  code: DirectorCanvasDagIssueCode;
  /** The edge that triggered the issue, or null when the issue is not tied to a single edge. */
  edgeId: string | null;
  /** The node ids involved in the issue. */
  nodeIds: string[];
}

/**
 * The result of analyzing a Canvas DAG for validity and execution ordering.
 *
 * Nodes in the same parallel level have no dependencies on one another
 * and may be executed concurrently.
 */
export interface DirectorCanvasDagAnalysis {
  /** Whether the graph is acyclic and every edge references existing nodes. */
  valid: boolean;
  /** Nodes with no incoming edges — the entry points of the DAG. */
  roots: string[];
  /** Nodes with no outgoing edges — the terminal points of the DAG. */
  leaves: string[];
  /** A deterministic topological ordering of all nodes. */
  topologicalOrder: string[];
  /**
   * Parallel execution levels. Nodes within the same level have no
   * dependencies on one another and can run concurrently.
   */
  parallelLevels: string[][];
  /** Every issue detected during validation. */
  issues: DirectorCanvasDagIssue[];
}

/** Configuration for laying out the Canvas DAG visually. */
export interface DirectorCanvasDagLayoutOptions {
  /** Whether the DAG flows left-to-right or top-to-bottom. Defaults to "horizontal". */
  direction?: "horizontal" | "vertical";
  /** X offset from the origin for the first layer. */
  originX?: number;
  /** Y offset from the origin for the first layer. */
  originY?: number;
  /** Gap between successive layers in the layout direction. */
  layerGap?: number;
  /** Gap between nodes within the same layer. */
  nodeGap?: number;
}

/** A DAG node that carries its rendered dimensions for layout computation. */
export interface DirectorCanvasDagLayoutNode extends DirectorCanvasDagNode {
  /** Rendered width of the node in pixels. */
  width: number;
  /** Rendered height of the node in pixels. */
  height: number;
}

/** The computed layout positions for a Canvas DAG. */
export interface DirectorCanvasDagLayout {
  /** The analysis result the layout was derived from. */
  analysis: DirectorCanvasDagAnalysis;
  /** Position of each node by id, in the coordinate space defined by the layout options. */
  positions: Map<string, { x: number; y: number }>;
}

function sorted(values: Iterable<string>) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

// Tarjan's strongly connected components algorithm — finds all cycles
// so we can report them as structured issues rather than a single boolean.
function cycleComponents(nodeIds: readonly string[], adjacency: ReadonlyMap<string, ReadonlySet<string>>) {
  let nextIndex = 0;
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (nodeId: string) => {
    indexById.set(nodeId, nextIndex);
    lowLinkById.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const targetId of sorted(adjacency.get(nodeId) ?? [])) {
      if (!indexById.has(targetId)) {
        visit(targetId);
        lowLinkById.set(nodeId, Math.min(lowLinkById.get(nodeId)!, lowLinkById.get(targetId)!));
      } else if (onStack.has(targetId)) {
        lowLinkById.set(nodeId, Math.min(lowLinkById.get(nodeId)!, indexById.get(targetId)!));
      }
    }

    if (lowLinkById.get(nodeId) !== indexById.get(nodeId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === nodeId) break;
    }
    // Only components with at least 2 nodes represent a cycle;
    // single-node components are self-loops caught by the caller.
    if (component.length > 1) components.push(component.sort((left, right) => left.localeCompare(right)));
  };

  for (const nodeId of sorted(nodeIds)) {
    if (!indexById.has(nodeId)) visit(nodeId);
  }
  return components.sort((left, right) => left[0]!.localeCompare(right[0]!));
}

/**
 * Validates the Canvas dependency graph and returns a deterministic execution plan.
 * Nodes in the same parallel level have no dependencies on one another.
 *
 * @param nodes - The complete set of nodes in the graph.
 * @param edges - The complete set of directed edges in the graph.
 * @returns A full analysis including validity, topological order, parallel levels, and issues.
 */
export function analyzeDirectorCanvasDag(
  nodes: readonly DirectorCanvasDagNode[],
  edges: readonly DirectorCanvasDagEdge[],
): DirectorCanvasDagAnalysis {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const issues: DirectorCanvasDagIssue[] = [];
  const adjacency = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const seenPairs = new Set<string>();

  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, new Set());
    incoming.set(nodeId, 0);
    outgoing.set(nodeId, 0);
  }

  // Sort edges by id for deterministic issue ordering across runs.
  for (const edge of [...edges].sort((left, right) => left.id.localeCompare(right.id))) {
    const sourceExists = nodeIds.has(edge.sourceNodeId);
    const targetExists = nodeIds.has(edge.targetNodeId);
    if (!sourceExists) {
      issues.push({ code: "dangling_source", edgeId: edge.id, nodeIds: [edge.sourceNodeId] });
    }
    if (!targetExists) {
      issues.push({ code: "dangling_target", edgeId: edge.id, nodeIds: [edge.targetNodeId] });
    }
    if (!sourceExists || !targetExists) continue;
    if (edge.sourceNodeId === edge.targetNodeId) {
      issues.push({ code: "self_edge", edgeId: edge.id, nodeIds: [edge.sourceNodeId] });
      continue;
    }
    const pair = `${edge.sourceNodeId}\u0000${edge.targetNodeId}`;
    if (seenPairs.has(pair)) {
      issues.push({ code: "duplicate_edge", edgeId: edge.id, nodeIds: [edge.sourceNodeId, edge.targetNodeId] });
      continue;
    }
    seenPairs.add(pair);
    adjacency.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    incoming.set(edge.targetNodeId, incoming.get(edge.targetNodeId)! + 1);
    outgoing.set(edge.sourceNodeId, outgoing.get(edge.sourceNodeId)! + 1);
  }

  for (const component of cycleComponents([...nodeIds], adjacency)) {
    issues.push({ code: "cycle", edgeId: null, nodeIds: component });
  }

  // Kahn's algorithm for topological sort and parallel level partitioning.
  const remainingIncoming = new Map(incoming);
  let frontier = sorted([...nodeIds].filter((nodeId) => remainingIncoming.get(nodeId) === 0));
  const parallelLevels: string[][] = [];
  const topologicalOrder: string[] = [];
  while (frontier.length > 0) {
    parallelLevels.push(frontier);
    topologicalOrder.push(...frontier);
    const next = new Set<string>();
    for (const nodeId of frontier) {
      for (const targetId of sorted(adjacency.get(nodeId) ?? [])) {
        const count = remainingIncoming.get(targetId)! - 1;
        remainingIncoming.set(targetId, count);
        if (count === 0) next.add(targetId);
      }
    }
    frontier = sorted(next);
  }

  return {
    // Graph is valid only when every node appears in the topological order
    // and no issues were found.
    valid: issues.length === 0 && topologicalOrder.length === nodeIds.size,
    roots: sorted([...nodeIds].filter((nodeId) => incoming.get(nodeId) === 0)),
    leaves: sorted([...nodeIds].filter((nodeId) => outgoing.get(nodeId) === 0)),
    topologicalOrder,
    parallelLevels,
    issues,
  };
}

/**
 * Tests whether adding a directed edge would introduce a cycle in the existing DAG.
 *
 * Self-edges and edges referencing unknown nodes are always treated as cycle-creating
 * so the caller can reject them before insertion.
 *
 * @param nodes - The complete set of nodes currently in the graph.
 * @param edges - The complete set of directed edges currently in the graph.
 * @param sourceNodeId - The proposed source node id for the new edge.
 * @param targetNodeId - The proposed target node id for the new edge.
 * @returns `true` if adding the edge would create a cycle or is otherwise invalid.
 */
export function wouldCreateDirectorCanvasCycle(
  nodes: readonly DirectorCanvasDagNode[],
  edges: readonly DirectorCanvasDagEdge[],
  sourceNodeId: string,
  targetNodeId: string,
) {
  if (sourceNodeId === targetNodeId) return true;
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) return true;
  const adjacency = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, new Set());
  for (const edge of edges) {
    if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
      adjacency.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    }
  }
  // DFS from the proposed target back to the proposed source.
  const pending = [targetNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (nodeId === sourceNodeId) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    pending.push(...(adjacency.get(nodeId) ?? []));
  }
  return false;
}

/**
 * Computes visual positions for a Canvas DAG using a layered layout algorithm.
 *
 * Nodes are placed in layers according to the topological parallel levels
 * computed by {@link analyzeDirectorCanvasDag}. If the graph is invalid,
 * an empty positions map is returned alongside the analysis.
 *
 * @param nodes - The nodes to lay out, each with its rendered dimensions.
 * @param edges - The complete set of directed edges in the graph.
 * @param options - Layout direction, gaps, and origin offsets.
 * @returns The analysis and the computed position for each node.
 */
export function layoutDirectorCanvasDag(
  nodes: readonly DirectorCanvasDagLayoutNode[],
  edges: readonly DirectorCanvasDagEdge[],
  options: DirectorCanvasDagLayoutOptions = {},
): DirectorCanvasDagLayout {
  const analysis = analyzeDirectorCanvasDag(nodes, edges);
  const positions = new Map<string, { x: number; y: number }>();
  if (!analysis.valid) return { analysis, positions };

  const direction = options.direction ?? "horizontal";
  const originX = options.originX ?? 80;
  const originY = options.originY ?? 80;
  // Clamp gap values to reasonable bounds so extreme inputs don't blow up the layout.
  const layerGap = Math.max(40, Math.min(1_200, options.layerGap ?? 120));
  const nodeGap = Math.max(20, Math.min(800, options.nodeGap ?? 60));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let layerOffset = 0;

  for (const level of analysis.parallelLevels) {
    let crossOffset = 0;
    let layerExtent = 0;
    for (const nodeId of level) {
      const node = nodeById.get(nodeId)!;
      positions.set(
        nodeId,
        direction === "horizontal"
          ? { x: originX + layerOffset, y: originY + crossOffset }
          : { x: originX + crossOffset, y: originY + layerOffset },
      );
      crossOffset += (direction === "horizontal" ? node.height : node.width) + nodeGap;
      layerExtent = Math.max(layerExtent, direction === "horizontal" ? node.width : node.height);
    }
    layerOffset += layerExtent + layerGap;
  }
  return { analysis, positions };
}