import { asRecord as record } from "../../../packages/protocol/src/primitives";

const RECENT_CALL_LIMIT = 12;

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

export const STALE_REVISION_CODES = new Set(["stale_project_revision", "revision_conflict"]);

export type AgentToolCallRecord = {
  tool: string;
  input: unknown;
};

export type AgentToolSessionMemory = {
  lastWorkbenchRevision?: string;
  recentCalls: AgentToolCallRecord[];
};

export function createAgentToolSessionMemory(): AgentToolSessionMemory {
  return { recentCalls: [] };
}

export function extractProjectRevision(envelope: Record<string, unknown>): string | undefined {
  const inner = record(envelope.result);
  const revision = inner?.project_revision;
  return typeof revision === "string" && revision.trim() ? revision : undefined;
}

export function isStaleRevisionResult(envelope: Record<string, unknown>): boolean {
  const inner = record(envelope.result);
  const code = typeof envelope.code === "string" ? envelope.code : typeof inner?.code === "string" ? inner.code : "";
  return STALE_REVISION_CODES.has(code);
}

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
