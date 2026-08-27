import { asRecord as record } from "../../../packages/protocol/src/primitives";

/**
 * Per-session memory of Director agent tool calls, used to make optimistic
 * concurrency ergonomic for agents: every successful `director_workbench`
 * call that reports a `project_revision` is remembered, and the next guarded
 * mutation on the same session gets that revision injected as
 * `expected_revision` automatically, so a stale agent loses the compare-swap
 * instead of silently overwriting a newer project state.
 *
 * The memory is advisory only. It never overrides an explicit
 * `expected_revision` from the agent, never applies to reads, and is dropped
 * as soon as the gateway reports a stale-revision conflict — the corrective
 * observe call is then the only way to re-learn the current revision.
 */

/** Bound on the retained call history; the oldest entries are dropped first. */
const RECENT_CALL_LIMIT = 12;

/**
 * Workbench ops that mutate (or capture from) the project and therefore get
 * the cached revision injected as `expected_revision` when the agent did not
 * supply one. Read-style ops are deliberately excluded: they must never fail
 * on a stale revision.
 */
export const GUARDED_WORKBENCH_OPS = new Set([
  "patch",
  "author",
  "correct",
  "replace_project",
  "undo",
  "capture",
  "shot_package",
  "deliver",
]);

/** Result codes that mean the cached revision is no longer trustworthy. */
export const STALE_REVISION_CODES = new Set(["stale_project_revision", "revision_conflict"]);

/** One remembered successful tool call (tool name plus the exact input sent). */
export type AgentToolCallRecord = {
  tool: string;
  input: unknown;
};

/** Mutable per-session memory shared across a Director agent's tool calls. */
export type AgentToolSessionMemory = {
  /** Last `project_revision` observed from a successful workbench call. */
  lastWorkbenchRevision?: string;
  /** Recent successful calls, oldest first, bounded by {@link RECENT_CALL_LIMIT}. */
  recentCalls: AgentToolCallRecord[];
};

/** Creates an empty session memory with no cached revision. */
export function createAgentToolSessionMemory(): AgentToolSessionMemory {
  return { recentCalls: [] };
}

/** Reads `result.project_revision` from a tool envelope, if present and non-blank. */
export function extractProjectRevision(envelope: Record<string, unknown>): string | undefined {
  const inner = record(envelope.result);
  const revision = inner?.project_revision;
  return typeof revision === "string" && revision.trim() ? revision : undefined;
}

/**
 * True when the envelope reports a stale-revision conflict. The code can live
 * at the envelope top level or inside `result` depending on which layer
 * rejected the call, so both locations are checked.
 */
export function isStaleRevisionResult(envelope: Record<string, unknown>): boolean {
  const inner = record(envelope.result);
  const code = typeof envelope.code === "string" ? envelope.code : typeof inner?.code === "string" ? inner.code : "";
  return STALE_REVISION_CODES.has(code);
}

/**
 * Injects the cached revision as `expected_revision` into a guarded workbench
 * mutation. The injection is skipped whenever the agent expressed its own
 * intent — an explicit `expected_revision` (even a wrong one) or
 * `unconditional: true` — so the memory can only add safety, never take
 * control away from the caller.
 */
export function injectCachedWorkbenchRevision(
  tool: string,
  input: unknown,
  memory?: AgentToolSessionMemory,
): { input: unknown; injectedRevision?: string } {
  const values = record(input);
  if (
    !memory?.lastWorkbenchRevision ||
    tool !== "director_workbench" ||
    !values ||
    typeof values.op !== "string" ||
    !GUARDED_WORKBENCH_OPS.has(values.op) ||
    values.expected_revision !== undefined ||
    values.unconditional === true
  ) {
    return { input };
  }
  return {
    input: { ...values, expected_revision: memory.lastWorkbenchRevision },
    injectedRevision: memory.lastWorkbenchRevision,
  };
}

/**
 * Records the outcome of a tool call into the session memory: successful
 * calls join the bounded history, a successful workbench call refreshes the
 * cached revision, and a stale-revision rejection invalidates it so the next
 * mutation cannot reuse a revision the gateway already refused.
 */
export function rememberDirectorAgentToolCall(
  memory: AgentToolSessionMemory,
  tool: string,
  input: unknown,
  envelope: Record<string, unknown>,
) {
  if (envelope.success === true) {
    memory.recentCalls.push({ tool, input });
    if (memory.recentCalls.length > RECENT_CALL_LIMIT) memory.recentCalls.shift();
  }
  const revision = extractProjectRevision(envelope);
  if (tool === "director_workbench" && envelope.success === true && revision) {
    memory.lastWorkbenchRevision = revision;
    return;
  }
  if (isStaleRevisionResult(envelope)) memory.lastWorkbenchRevision = undefined;
}
