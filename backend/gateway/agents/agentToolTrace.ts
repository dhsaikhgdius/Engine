import {
  agentTraceEventSchema,
  type AgentTraceOutcome,
  type AgentTraceSource,
} from "../../../packages/protocol/src/agentObservabilityProtocol";
import type { AgentTraceEventInput } from "./agentTraceStore";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Derives the semantic operation label from a tool input without storing the
 * payload itself. Nested durable-job and production commands are flattened to
 * `<op>.<action>` so a trace reads as a tool chain.
 *
 * @param input - The raw tool input.
 * @returns The operation label, or `"unknown"` when the input has no `op`.
 */
export function describeAgentToolOperation(input: unknown): string {
  const root = record(input);
  const op = typeof root?.op === "string" && root.op.trim() ? root.op.trim().slice(0, 80) : null;
  if (!op) return "unknown";
  const nested = record(root?.command) ?? record(root?.request);
  const action = typeof nested?.action === "string" && nested.action.trim() ? nested.action.trim().slice(0, 60) : null;
  return action ? `${op}.${action}` : op;
}

function outcomeForStatus(status: number, body: Record<string, unknown> | null): AgentTraceOutcome {
  if (status === 409) return "conflict";
  if (status >= 400) return "error";
  return body?.success === false ? "error" : "success";
}

function boundaryOf(body: Record<string, unknown> | null) {
  return record(body?.agent_boundary);
}

function revisionBefore(body: Record<string, unknown> | null): string | null {
  const guard = record(boundaryOf(body)?.guard);
  return guard?.mode === "revision" && typeof guard.value === "string" ? guard.value : null;
}

function revisionAfter(body: Record<string, unknown> | null): string | null {
  const result = record(body?.result);
  if (typeof result?.project_revision === "string" && result.project_revision.trim()) return result.project_revision;
  if (typeof result?.production_revision === "number" && Number.isInteger(result.production_revision)) {
    return String(result.production_revision);
  }
  const snapshot = record(result?.snapshot);
  if (typeof snapshot?.snapshot_fingerprint === "string" && snapshot.snapshot_fingerprint.trim()) {
    return snapshot.snapshot_fingerprint;
  }
  return null;
}

function idempotencyKey(body: Record<string, unknown> | null): string | undefined {
  const key = record(boundaryOf(body)?.idempotency)?.key;
  return typeof key === "string" && key.trim() ? key : undefined;
}

function resultCode(body: Record<string, unknown> | null): string | undefined {
  return typeof body?.code === "string" && body.code.trim() ? body.code.slice(0, 160) : undefined;
}

/**
 * Builds a trace event from one gateway tool response. The event is an
 * execution receipt: it references the boundary guard, revisions, outcome
 * code, and capture URL, and never embeds the tool payload or image bytes.
 *
 * @param input - Call identity plus the final HTTP status and response body.
 * @returns A validated trace event input for {@link AgentTraceStore.record}.
 */
export function buildAgentToolTraceEvent(input: {
  tool: string;
  sessionId: string;
  source: AgentTraceSource;
  operation: string;
  startedAtMs: number;
  status: number;
  body: unknown;
  /** Capture reference (preview URL) when the response carried a capture. */
  captureRef?: string;
  nowMs?: number;
}): AgentTraceEventInput {
  const body = record(input.body);
  const error = typeof body?.error === "string" && body.error.trim() ? body.error.slice(0, 500) : undefined;
  const key = idempotencyKey(body);
  const code = resultCode(body);
  // Preview URLs carry a capability token in the query string; the trace log
  // stores the token-free path so no credential is persisted.
  const captureRef = input.captureRef?.split("?")[0];
  const hasCapture = Boolean(body?.capture) && Boolean(captureRef);
  const event: AgentTraceEventInput = {
    session_id: input.sessionId,
    source: input.source,
    tool: input.tool,
    operation: input.operation,
    outcome: outcomeForStatus(input.status, body),
    status_code: input.status,
    started_at: new Date(input.startedAtMs).toISOString(),
    duration_ms: Math.max(0, Math.round((input.nowMs ?? Date.now()) - input.startedAtMs)),
    revision_before: revisionBefore(body),
    revision_after: revisionAfter(body),
    ...(key ? { idempotency_key: key } : {}),
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    ...(hasCapture ? { capture_ref: captureRef } : {}),
  };
  // Validate the receipt shape here so a malformed recorder bug fails loudly
  // in development instead of silently corrupting the trace log.
  const parsed = agentTraceEventSchema.omit({ id: true }).safeParse(event);
  return parsed.success ? parsed.data : event;
}
