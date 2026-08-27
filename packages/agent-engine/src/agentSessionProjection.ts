/**
 * Pure reducer that materializes an {@link AgentSession} snapshot from its
 * durable event log.
 *
 * The event log is the single source of truth for session lifecycle; this
 * reducer is shared by the gateway's SQLite projection and the browser's
 * live session view so status semantics (queued → running →
 * waiting_approval → completed/failed/interrupted) cannot drift between
 * processes. Events for other sessions are ignored, and malformed event
 * payloads degrade to keeping the previous field value rather than throwing.
 *
 * @module agentSessionProjection
 */

import {
  agentProviderSchema,
  agentSessionCapabilitiesSchema,
  agentSessionStatusSchema,
  type AgentEvent,
  type AgentSession,
  type AgentSessionStatus,
} from "./agentSessionSchema";

function sessionStatus(value: unknown): AgentSessionStatus | null {
  const parsed = agentSessionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function optionalId(value: unknown) {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

// Terminal turn status may arrive flat (`data.status`) or nested under
// `data.turn`; anything unrecognized is treated as a clean completion.
function completedTurnStatus(event: AgentEvent): Extract<AgentSessionStatus, "completed" | "failed" | "interrupted"> {
  const nestedTurn =
    event.data.turn && typeof event.data.turn === "object" ? (event.data.turn as Record<string, unknown>) : null;
  const raw = typeof event.data.status === "string" ? event.data.status : nestedTurn?.status;
  return raw === "failed" || raw === "interrupted" ? raw : "completed";
}

/**
 * Folds one durable event into the materialized session snapshot.
 *
 * The event log is authoritative. Both the gateway's SQLite projection and
 * the browser's live session view call this reducer so lifecycle semantics
 * cannot drift between processes.
 */
export function applyAgentSessionEvent(session: AgentSession, event: AgentEvent): AgentSession {
  if (event.sessionId !== session.id) return session;
  const next: AgentSession = {
    ...session,
    lastEventSequence: Math.max(session.lastEventSequence, event.sequence),
    updatedAt: event.timestamp || session.updatedAt,
  };

  if (event.type === "session.updated") {
    const status = sessionStatus(event.data.status);
    const externalSessionId = optionalId(event.data.externalSessionId);
    const activeTurnId = optionalId(event.data.activeTurnId);
    const profileId = optionalId(event.data.profileId);
    const provider = agentProviderSchema.safeParse(event.data.provider);
    const capabilities = agentSessionCapabilitiesSchema.safeParse(event.data.capabilities);
    const title = typeof event.data.title === "string" ? event.data.title.trim() : "";
    return {
      ...next,
      ...(status ? { status } : {}),
      ...(externalSessionId !== undefined ? { externalSessionId } : {}),
      ...(activeTurnId !== undefined ? { activeTurnId } : {}),
      ...(profileId !== undefined ? { profileId } : {}),
      ...(provider.success ? { provider: provider.data } : {}),
      ...(capabilities.success ? { capabilities: capabilities.data } : {}),
      ...(title ? { title } : {}),
    };
  }

  if (event.type === "queue.updated" && typeof event.data.count === "number" && Number.isFinite(event.data.count)) {
    const queuedMessageCount = Math.max(0, Math.floor(event.data.count));
    const action = event.data.action;
    // Queue transitions only move status when they do not contradict a live
    // turn: enqueue never demotes running/waiting_approval, and cancelling
    // the last queued message from "queued" resolves to "interrupted".
    const status =
      action === "dequeued"
        ? "running"
        : action === "enqueued" && next.status !== "running" && next.status !== "waiting_approval"
          ? "queued"
          : action === "cancelled" && queuedMessageCount === 0 && next.status === "queued"
            ? "interrupted"
            : next.status;
    return { ...next, status, queuedMessageCount };
  }

  if (event.type === "turn.started") {
    return { ...next, status: "running", activeTurnId: event.turnId };
  }

  if (event.type === "turn.completed") {
    return { ...next, status: completedTurnStatus(event), activeTurnId: null };
  }

  if (event.type === "approval.requested") {
    return { ...next, status: "waiting_approval" };
  }

  if (event.type === "approval.resolved" && next.status === "waiting_approval") {
    return { ...next, status: "running" };
  }

  return next;
}
