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
export const createProductionRunRequestSchema = z.strictObject({
  objective: nonEmptyText(8_000),
  provider: agentProviderSchema.default("api"),
  profileId: agentProfileIdSchema.default("api-default"),
  profileByRole: productionRoleProfileMapSchema.optional(),
  roles: z.array(filmRoleIdSchema).min(1).max(16).optional(),
  brief: filmProductionBriefSchema.optional(),
  project: z.unknown().optional(),
  target: directorAgentTargetWireSchema,
});

/** A full multi-agent production run, including nodes, artifacts, and routing. */
export type ProductionRun = z.infer<typeof productionRunSchema>;

/** A single role-assigned node in a production run. */
export type ProductionRunNode = z.infer<typeof productionRunNodeSchema>;

/** A production artifact emitted by a run node. */
export type ProductionArtifact = z.infer<typeof productionArtifactSchema>;

/** Public role-to-profile routing map (re-exported for convenience). */
export type ProductionRoleProfileMap = AgentRoleProfileMap;

/** Request shape for creating a new production run. */
export type CreateProductionRunRequest = z.infer<typeof createProductionRunRequestSchema>;
