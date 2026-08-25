import type { DirectorProject } from "../directorProjectSchema";
import { createProductionGraphFromDirectorProject } from "./directorProjectProductionGraph";
import { migrateProductionGraphIdentities } from "./productionGraphMigration";
import { getProductionGraphFingerprint, getProductionGraphNodesByKind } from "./productionGraph";
import { validateProductionGraphIntegrity } from "./productionGraphIntegrity";
import { PRODUCTION_GRAPH_NODE_KINDS, type ProductionGraphNodeKind } from "./productionGraphSchema";

const SUMMARY_ISSUE_LIMIT = 24;

/** Bounded Agent/HTTP observation of the read-only ProductionGraph projector. */
export type DirectorProductionGraphObservationDetail = "summary" | "full";

/**
 * Project a DirectorProject into a size-bounded ProductionGraph observation.
 *
 * Summary mode returns fingerprints, counts, and integrity codes. Full mode
 * includes nodes/edges and identity-map entries. Default unscoped observe must
 * not request this payload.
 *
 * @param project - Persisted Director project.
 * @param detail - `summary` omits node/edge tables; `full` includes them.
 */
export function observeDirectorProductionGraph(
  project: DirectorProject,
  detail: DirectorProductionGraphObservationDetail = "summary",
): Record<string, unknown> {
  const graph = createProductionGraphFromDirectorProject(project);
  const fingerprint = getProductionGraphFingerprint(graph);
  const integrity = validateProductionGraphIntegrity(graph);
  const issues = integrity.issues;
  const boundedIssues = issues.slice(0, SUMMARY_ISSUE_LIMIT);
  const node_counts = Object.fromEntries(
    PRODUCTION_GRAPH_NODE_KINDS.map((kind: ProductionGraphNodeKind) => [
      kind,
      getProductionGraphNodesByKind(graph, kind).length,
    ]),
  );
  const identities = migrateProductionGraphIdentities(project, {
    existing: project.productionGraphIdentities ?? null,
    migratedAt: "1970-01-01T00:00:00.000Z",
  });
  const identitySummary = identities.success
    ? {
        status: identities.receipt.status,
        fingerprint: identities.identityMap.fingerprint,
        entry_count: identities.identityMap.entries.length,
        receipt_id: identities.receipt.receiptId,
      }
    : {
        status: identities.receipt.status,
        fingerprint: null,
        entry_count: 0,
        receipt_id: identities.receipt.receiptId,
        conflicts: identities.receipt.conflicts,
      };
  const observation: Record<string, unknown> = {
    contract: "director-production-graph-observe-v1",
    schema: graph.schema,
    version: graph.version,
    production_id: graph.productionId,
    fingerprint,
    integrity: {
      valid: integrity.valid,
      issue_count: issues.length,
      issues_omitted: Math.max(0, issues.length - boundedIssues.length),
      issues: detail === "full" ? issues : boundedIssues,
    },
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      node_counts,
    },
    identities: identitySummary,
  };
  if (detail === "full") {
    observation.nodes = graph.nodes;
    observation.edges = graph.edges;
    if (identities.success) observation.identity_map = identities.identityMap;
  }
  return observation;
}
