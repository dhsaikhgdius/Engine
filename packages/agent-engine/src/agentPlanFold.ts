/**
 * Folds the durable agent event stream into the latest structured plan.
 *
 * Director plans travel as `plan.updated` events on the same event log that
 * drives session status ({@link applyAgentSessionEvent} in
 * agentSessionProjection). This module is the read side: given a session's
 * events it recovers the most recent plan and its lifecycle status, and the
 * write side: it builds the `plan.updated` payload for a status transition.
 * Gateway and browser both fold from the same events, so plan state cannot
 * drift between processes.
 *
 * @module agentPlanFold
 */

import type { AgentEvent } from "./agentSessionSchema";
import type { DirectorAgentPlan } from "./agentPlan";
import { isRecord as isObject } from "@director/protocol/primitives";

/** Lifecycle statuses a folded agent plan can transition through. */
export const FOLDED_AGENT_PLAN_STATUSES = ["pending", "confirmation_required", "applied", "discarded"] as const;

/** A status from the folded plan lifecycle. */
export type FoldedAgentPlanStatus = (typeof FOLDED_AGENT_PLAN_STATUSES)[number];

/** The latest plan folded from a session's event stream, with its resolved status. */
export type FoldedAgentPlan = {
  planId: string;
  status: FoldedAgentPlanStatus;
  requiresConfirmation: boolean;
  summary: string | null;
  plan: DirectorAgentPlan | null;
};

function asPlan(value: unknown): DirectorAgentPlan | null {
  // Guard: a valid plan must have an id, summary, and operations array.
  if (!isObject(value) || typeof value.id !== "string" || typeof value.summary !== "string") return null;
  if (!Array.isArray(value.operations)) return null;
  return value as unknown as DirectorAgentPlan;
}

function asStatus(value: unknown): FoldedAgentPlanStatus | null {
  return typeof value === "string" && (FOLDED_AGENT_PLAN_STATUSES as readonly string[]).includes(value)
    ? (value as FoldedAgentPlanStatus)
    : null;
}

/** Latest structured Director plan from session events. Codex native plan entries are ignored. */
export function foldAgentPlanFromEvents(events: readonly AgentEvent[]): FoldedAgentPlan | null {
  // Walk backwards through events to find the most recent plan.updated.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "plan.updated") continue;
    const plan = asPlan(event.data.plan);
    const planId = typeof event.data.planId === "string" ? event.data.planId : plan?.id;
    if (!planId) continue;
    const requiresConfirmation = Boolean(event.data.requiresConfirmation ?? plan?.requiresConfirmation);
    const recorded = asStatus(event.data.status);
    const status: FoldedAgentPlanStatus = recorded ?? (requiresConfirmation ? "confirmation_required" : "pending");
    return {
      planId,
      status,
      requiresConfirmation,
      summary: typeof event.data.summary === "string" ? event.data.summary : (plan?.summary ?? null),
      plan,
    };
  }
  return null;
}

/**
 * Builds the event data payload for a plan status update.
 *
 * @param status - The target lifecycle status for the plan.
 * @param input - Plan reference fields; planId is required directly or derived from the plan.
 * @returns A plain object suitable for a plan.updated event's data field.
 * @throws When neither input.planId nor input.plan.id is provided.
 */
export function agentPlanUpdateData(
  status: FoldedAgentPlanStatus,
  input: { plan?: DirectorAgentPlan; planId?: string; summary?: string },
) {
  const plan = input.plan;
  const planId = input.planId ?? plan?.id;
  if (!planId) throw new Error("plan update requires a plan id");
  return {
    status,
    planId,
    requiresConfirmation: Boolean(plan?.requiresConfirmation),
    ...(typeof input.summary === "string" || plan?.summary ? { summary: input.summary ?? plan?.summary } : {}),
    ...(plan ? { plan } : {}),
  };
}
