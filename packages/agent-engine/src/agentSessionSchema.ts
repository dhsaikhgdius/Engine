import { z } from "zod";
import { directorAgentTargetWireSchema } from "@director/protocol/agentGatewayProtocol";
import { protocolKeys } from "@director/protocol/primitives";
import { DIRECTOR_SESSION_PROVIDER_IDS } from "./agentIds";
import { agentProfileIdSchema, filmRoleIdSchema } from "./agentRuntimeSchema";
import agentSessionProtocol from "./agentSessionProtocol.json";

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Provider enum shared across all session-related schemas. */
export const agentProviderSchema = z.enum(DIRECTOR_SESSION_PROVIDER_IDS);

/** A session lifecycle status from the agent session protocol. */
export type AgentSessionStatus = keyof typeof agentSessionProtocol.statuses;

/** An event type from the agent session protocol. */
export type AgentEventType = keyof typeof agentSessionProtocol.eventTypes;

/** How a session entered the sidebar: a user thread, an explicit fork, or a hidden subagent. */
export const agentSessionOriginSchema = z.enum(["user", "fork", "subagent"]);

/** Validated session status enum. */
export const agentSessionStatusSchema = z.enum(protocolKeys(agentSessionProtocol.statuses));

/** Validated event type enum. */
export const agentEventTypeSchema = z.enum(protocolKeys(agentSessionProtocol.eventTypes));

/** Feature flags a session's provider supports, used for capability-gating UI and logic. */
export const agentSessionCapabilitiesSchema = z.strictObject({
  streaming: z.boolean(),
  resume: z.boolean(),
  fork: z.boolean(),
  interrupt: z.boolean(),
  approvals: z.boolean(),
  messageQueue: z.boolean(),
  checkpoints: z.boolean(),
});

/** Full session shape — identity, provider, role, and live status fields. */
export const agentSessionSchema = z.strictObject({
  id: nonEmptyText(160),
  provider: agentProviderSchema,
  profileId: agentProfileIdSchema.nullable(),
  roleId: filmRoleIdSchema.nullable(),
  title: nonEmptyText(240),
  status: agentSessionStatusSchema,
  externalSessionId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  origin: agentSessionOriginSchema.optional(),
  activeTurnId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastEventSequence: z.number().int().nonnegative(),
  queuedMessageCount: z.number().int().nonnegative(),
  capabilities: agentSessionCapabilitiesSchema,
});

/** A single event in a session's ordered event stream. */
export const agentEventSchema = z.strictObject({
  id: nonEmptyText(160),
  sessionId: nonEmptyText(160),
  sequence: z.number().int().positive(),
  type: agentEventTypeSchema,
  timestamp: z.string(),
  turnId: z.string().nullable(),
  itemId: z.string().nullable(),
  provider: agentProviderSchema,
  data: z.record(z.string(), z.unknown()),
});

/** A named snapshot of a session's project state at a specific event sequence. */
export const agentCheckpointSchema = z.strictObject({
  id: nonEmptyText(160),
  sessionId: nonEmptyText(160),
  name: nonEmptyText(240),
  createdAt: z.string(),
  eventSequence: z.number().int().nonnegative(),
  project: z.unknown(),
});

/** A queued message waiting to be delivered to the session's agent provider. */
export const agentQueuedMessageSchema = z.strictObject({
  id: nonEmptyText(160),
  sessionId: nonEmptyText(160),
  text: nonEmptyText(8_000),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Request body for creating a new agent session. */
export const createAgentSessionRequestSchema = z.strictObject({
  provider: agentProviderSchema,
  profileId: agentProfileIdSchema.optional(),
  roleId: filmRoleIdSchema.optional(),
  title: z.string().trim().min(1).max(240).optional(),
  parentSessionId: z.string().trim().min(1).max(160).optional(),
});

/** Request body for switching the model of an existing session. */
export const setAgentSessionModelRequestSchema = z.strictObject({
  provider: agentProviderSchema,
  profileId: agentProfileIdSchema,
});

/** Request body for sending a user message into an agent session. */
export const sendAgentMessageRequestSchema = z.strictObject({
  message: nonEmptyText(8_000),
  project: z.unknown().optional(),
  target: directorAgentTargetWireSchema,
});

/** Request body for injecting supplementary context into an agent session. */
export const injectAgentContextRequestSchema = z
  .strictObject({
    kind: z.enum(["scene_revision"]).optional(),
    project_revision: nonEmptyText(240).optional(),
    text: nonEmptyText(2_000).optional(),
  })
  .refine((value) => Boolean(value.project_revision || value.text), {
    message: "inject requires project_revision or text",
  });

/** Request body for retrying the last agent message with an updated project snapshot. */
export const retryAgentMessageRequestSchema = z.strictObject({
  project: z.unknown().optional(),
  target: directorAgentTargetWireSchema,
});

/** Request body for forking an existing session into a new child session. */
export const forkAgentSessionRequestSchema = z.strictObject({
  provider: agentProviderSchema.optional(),
  title: z.string().trim().min(1).max(240).optional(),
});

/** Request body for creating a named checkpoint of the current project state. */
export const createAgentCheckpointRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(240).optional(),
  project: z.unknown(),
});

/** Request body for resolving a pending approval request (accept, decline, or cancel). */
export const resolveAgentApprovalRequestSchema = z.strictObject({
  requestId: nonEmptyText(160),
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
});

/** How a session was created. */
export type AgentSessionOrigin = z.infer<typeof agentSessionOriginSchema>;

/** A provider identifier from the session provider enum. */
export type AgentProvider = z.infer<typeof agentProviderSchema>;

/** Session-level feature flags. */
export type AgentSessionCapabilities = z.infer<typeof agentSessionCapabilitiesSchema>;

/** A live agent session. */
export type AgentSession = z.infer<typeof agentSessionSchema>;

/** A single event in a session's event stream. */
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** A named project snapshot checkpoint. */
export type AgentCheckpoint = z.infer<typeof agentCheckpointSchema>;

/** A queued message waiting to be delivered. */
export type AgentQueuedMessage = z.infer<typeof agentQueuedMessageSchema>;

const SUBAGENT_TITLE_PREFIX = "Subagent · ";

/** Fields needed to recover origin for legacy rows that predate the column. */
export type AgentSessionOriginSource = Pick<AgentSession, "origin" | "parentSessionId" | "title">;

/**
 * Resolves the durable session origin, including legacy rows that only have
 * a parent id or a `Subagent ·` title.
 */
export function resolveAgentSessionOrigin(session: AgentSessionOriginSource): AgentSessionOrigin {
  if (session.origin) return session.origin;
  if (session.title.startsWith(SUBAGENT_TITLE_PREFIX)) return "subagent";
  if (session.parentSessionId) return "fork";
  return "user";
}

/** Whether the session is a delegated child that stays out of the sidebar. */
export function isAgentSubagentSession(session: AgentSessionOriginSource) {
  return resolveAgentSessionOrigin(session) === "subagent";
}

/** Sidebar rows: user threads and explicit forks, never subagents. */
export function sidebarAgentSessions<T extends AgentSessionOriginSource>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => !isAgentSubagentSession(session));
}

/** Direct subagent children of one parent, newest-first callers still sort. */
export function childSubagentSessions<T extends AgentSessionOriginSource & { parentSessionId: string | null }>(
  sessions: readonly T[],
  parentSessionId: string,
): T[] {
  return sessions.filter(
    (session) => isAgentSubagentSession(session) && session.parentSessionId === parentSessionId,
  );
}

const ACTIVE_SUBAGENT_STATUSES = new Set<AgentSession["status"]>(["running", "queued", "waiting_approval"]);

/** Running / queued / waiting child count used on the parent sidebar row. */
export function runningSubagentCount(
  sessions: readonly (AgentSessionOriginSource & {
    parentSessionId: string | null;
    status: AgentSession["status"];
  })[],
  parentSessionId: string,
) {
  return childSubagentSessions(sessions, parentSessionId).filter((session) =>
    ACTIVE_SUBAGENT_STATUSES.has(session.status),
  ).length;
}

/** Display title without the internal `Subagent ·` prefix. */
export function agentSessionDisplayTitle(session: AgentSessionOriginSource, locale: "zh-CN" | "en-US" = "zh-CN") {
  if (isAgentSubagentSession(session) && session.title.startsWith(SUBAGENT_TITLE_PREFIX)) {
    return session.title.slice(SUBAGENT_TITLE_PREFIX.length);
  }
  if (locale === "en-US" && session.parentSessionId && session.title.endsWith(" · 分支")) {
    return `${session.title.slice(0, -5)} · Branch`;
  }
  return session.title;
}
