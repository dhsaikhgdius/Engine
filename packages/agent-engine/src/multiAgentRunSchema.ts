/**
 * Durable schemas for multi-agent film production runs.
 *
 * A production run is a DAG of film-role nodes (screenwriter, director,
 * cinematographer, …) executed by delegated Agent sessions; nodes exchange
 * typed artifacts and the whole run is persisted as a versioned snapshot.
 * These schemas are the single contract for the gateway scheduler, the HTTP
 * run API, and the browser run view.
 *
 * Invariants enforced here rather than in the scheduler: run and node ids
 * are path-safe because they double as snapshot/checkpoint file names;
 * explicit graphs must be acyclic with unique ids and known edges (Kahn's
 * algorithm in the schema refinement) so the scheduler can always make
 * progress; and v1 single-profile snapshots are migrated to the v2 per-role
 * routing shape at parse time, so consumers only ever see v2.
 *
 * @module multiAgentRunSchema
 */

import { z } from "zod";
import { agentProviderSchema } from "./agentSessionSchema";
import {
  agentProfileIdSchema,
  agentRoleProfileMapSchema,
  filmRoleIdSchema,
  type AgentRoleProfileMap,
} from "./agentRuntimeSchema";
import { directorAgentTargetWireSchema } from "@director/protocol/agentGatewayProtocol";
import { filmProductionBriefSchema } from "@director/protocol/filmProductionProtocol";

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/**
 * Public run requests carry only server-owned profile ids. Unknown role keys
 * and secret-shaped extra fields are rejected at the boundary.
 */
export const productionRoleProfileMapSchema = agentRoleProfileMapSchema;

/** Durable run ids double as local snapshot file names, so they must be path-safe. */
export const productionRunIdSchema = z
  .string()
  .trim()
  .regex(/^run-[a-z0-9][a-z0-9-]{3,155}$/i);

/** Lifecycle statuses a production run can occupy. */
export const productionRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Per-node status within a multi-agent production run. */
export const productionNodeStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled", "stale"]);

/** Kinds of artifacts produced during a production run. */
export const productionArtifactKindSchema = z.enum([
  "role-report",
  "creative-brief",
  "screenplay",
  "production-bible",
  "continuity-ledger",
  "shot-plan",
  "staging-plan",
  "cinematography-plan",
  "generation-plan",
  "visual-review",
  "repair-report",
  "sound-plan",
  "edit-decision-list",
  "director-receipt",
  "generation-receipt",
]);

/** A single artifact produced by a role node during a production run. */
export const productionArtifactSchema = z.object({
  id: nonEmptyText(160),
  kind: productionArtifactKindSchema,
  roleId: filmRoleIdSchema,
  payload: z.unknown(),
  createdAt: z.string(),
});

/** A single role-assigned node in a multi-agent production run DAG. */
export const productionRunNodeSchema = z.strictObject({
  id: nonEmptyText(160),
  roleId: filmRoleIdSchema,
  /** The exact profile chosen when the run was created. Resume never re-routes it. */
  profileId: agentProfileIdSchema,
  sessionId: z.string().nullable(),
  status: productionNodeStatusSchema,
  attempt: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  inputArtifactIds: z.array(z.string()),
  outputArtifactIds: z.array(z.string()),
  error: z.string().nullable(),
  /**
   * Explicit upstream node ids for graph runs. Absent on serial-list runs
   * (including every legacy snapshot), where strict array order is the edge
   * set and artifact inheritance stays role-context based.
   */
  dependsOn: z.array(z.string()).max(23).optional(),
});

/** Graph node ids double as durable run checkpoint ids, so they must be compact and path-safe. */
export const productionGraphNodeIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,78}$/i);

/** One node of a configurable multi-agent production graph request. */
export const productionRunGraphNodeSchema = z.strictObject({
  id: productionGraphNodeIdSchema,
  roleId: filmRoleIdSchema,
  /** Optional per-node profile override; wins over profileByRole routing. */
  profileId: agentProfileIdSchema.optional(),
  /** Upstream node ids whose artifacts this node consumes. Empty means a root node. */
  dependsOn: z.array(productionGraphNodeIdSchema).max(23).default([]),
});

/**
 * A configurable production graph: nodes with explicit dependency edges.
 * Ids must be unique, edges must reference declared nodes, and the graph must
 * be acyclic so the scheduler can always make progress.
 */
export const productionRunGraphSchema = z
  .strictObject({ nodes: z.array(productionRunGraphNodeSchema).min(1).max(24) })
  .superRefine((graph, context) => {
    const ids = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (ids.has(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: `Duplicate production graph node id "${node.id}"`,
        });
      }
      ids.add(node.id);
    }
    let edgesValid = true;
    for (const [index, node] of graph.nodes.entries()) {
      for (const dependency of node.dependsOn) {
        if (dependency === node.id || !ids.has(dependency)) {
          edgesValid = false;
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "dependsOn"],
            message:
              dependency === node.id
                ? `Node "${node.id}" cannot depend on itself`
                : `Node "${node.id}" depends on unknown node "${dependency}"`,
          });
        }
      }
    }
    if (!edgesValid) return;
    // Kahn's algorithm: any unresolvable remainder is a cycle.
    const remainingDependencies = new Map(graph.nodes.map((node) => [node.id, new Set(node.dependsOn)]));
    let progressed = true;
    while (progressed && remainingDependencies.size > 0) {
      progressed = false;
      for (const [id, dependencies] of remainingDependencies) {
        if ([...dependencies].some((dependency) => remainingDependencies.has(dependency))) continue;
        remainingDependencies.delete(id);
        progressed = true;
      }
    }
    if (remainingDependencies.size > 0) {
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: `Production graph contains a dependency cycle involving: ${[...remainingDependencies.keys()].join(", ")}`,
      });
    }
  });

const productionRunV2Schema = z.strictObject({
  version: z.literal(2),
  id: productionRunIdSchema,
  objective: nonEmptyText(8_000),
  provider: agentProviderSchema,
  /** Compatibility fallback for roles without an explicit/configured route. */
  profileId: agentProfileIdSchema,
  /** Resolved, durable role routing table for this run. */
  profileByRole: productionRoleProfileMapSchema,
  /** Optional on legacy snapshots; every newly created film run persists one. */
  brief: filmProductionBriefSchema.optional(),
  status: productionRunStatusSchema,
  target: directorAgentTargetWireSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  activeNodeId: z.string().nullable(),
  nodes: z.array(productionRunNodeSchema).min(1).max(24),
  artifacts: z.array(productionArtifactSchema).max(240),
});

function migrateProductionRun(value: unknown): unknown {
  // v1 snapshots have a single profileId for all nodes; upgrade to v2
  // by distributing it into a per-role profileByRole map.
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.profileId !== "string" || !Array.isArray(record.nodes)) return value;
  const profileByRole: Record<string, string> = {};
  const nodes = record.nodes.map((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const candidate = node as Record<string, unknown>;
    if (typeof candidate.roleId === "string") profileByRole[candidate.roleId] = record.profileId as string;
    return { ...candidate, profileId: candidate.profileId ?? record.profileId };
  });
  return {
    ...record,
    version: 2,
    profileByRole,
    nodes,
  };
}

/** Reads current snapshots and upgrades durable v1 single-profile runs in memory. */
export const productionRunSchema = z.preprocess(migrateProductionRun, productionRunV2Schema);

/** Request body for creating a new multi-agent production run. */
export const createProductionRunRequestSchema = z
  .strictObject({
    objective: nonEmptyText(8_000),
    provider: agentProviderSchema.default("api"),
    profileId: agentProfileIdSchema.default("api-default"),
    profileByRole: productionRoleProfileMapSchema.optional(),
    roles: z.array(filmRoleIdSchema).min(1).max(16).optional(),
    /** Explicit node/edge graph. Mutually exclusive with the serial `roles` list. */
    graph: productionRunGraphSchema.optional(),
    brief: filmProductionBriefSchema.optional(),
    project: z.unknown().optional(),
    target: directorAgentTargetWireSchema,
  })
  .superRefine((request, context) => {
    if (request.roles && request.graph) {
      context.addIssue({
        code: "custom",
        path: ["graph"],
        message: "Provide either a serial roles list or an explicit graph, not both",
      });
    }
  });

/** Request body for resuming a production run, optionally from a checkpoint node. */
export const resumeProductionRunRequestSchema = z.strictObject({
  /**
   * Re-run from this durable checkpoint: the node itself and every transitive
   * dependent are reset even when they previously succeeded.
   */
  from_node_id: nonEmptyText(160).optional(),
});

/** A full multi-agent production run, including nodes, artifacts, and routing. */
export type ProductionRun = z.infer<typeof productionRunSchema>;

/** A single role-assigned node in a production run. */
export type ProductionRunNode = z.infer<typeof productionRunNodeSchema>;

/** A configurable production graph request. */
export type ProductionRunGraph = z.infer<typeof productionRunGraphSchema>;

/** One node of a configurable production graph request. */
export type ProductionRunGraphNode = z.infer<typeof productionRunGraphNodeSchema>;

/** Request shape for resuming a production run. */
export type ResumeProductionRunRequest = z.infer<typeof resumeProductionRunRequestSchema>;

/** A production artifact emitted by a run node. */
export type ProductionArtifact = z.infer<typeof productionArtifactSchema>;

/** Public role-to-profile routing map (re-exported for convenience). */
export type ProductionRoleProfileMap = AgentRoleProfileMap;

/** Request shape for creating a new production run. */
export type CreateProductionRunRequest = z.infer<typeof createProductionRunRequestSchema>;
