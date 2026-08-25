/**
 * UI dispatch layer for Director creative workspace (Canvas / Video / Gallery) mutations.
 *
 * UI mutators and the director_creative Agent boundary share
 * executeCreativeWorkspaceAgentRequest: this helper observes the live snapshot,
 * fills the fingerprint guard and idempotency key, validates the envelope with
 * the shared Zod contract, executes the exact same path agents use, and returns
 * the execution receipt for parity harnesses. One operation dispatches as
 * `execute`; several dispatch as an atomic `execute_batch` (all-or-nothing,
 * one undo entry).
 */

import { z } from "zod";
import {
  creativeWorkspaceAgentExecutionResultSchema,
  creativeWorkspaceAgentRequestSchema,
  executeCreativeWorkspaceAgentRequest,
  observeCreativeWorkspaceAgentSnapshot,
  creativeWorkspaceAgentOperationSchema,
  type CreativeWorkspaceAgentContext,
  type CreativeWorkspaceAgentErrorCode,
} from "./creativeWorkspaceAgentContract";

/** Pre-parse operation payload as authored by UI call sites (defaults not yet applied). */
export type CreativeWorkspaceOperationInput = z.input<typeof creativeWorkspaceAgentOperationSchema>;

/** Execution payload exactly as the shared agent envelope returned it. */
export type DispatchedCreativeWorkspaceExecution = z.infer<typeof creativeWorkspaceAgentExecutionResultSchema>;

export type DispatchCreativeWorkspaceOptions = {
  idempotencyKey?: string;
  /** Override the live browser stores (parity harnesses and tests). */
  context?: CreativeWorkspaceAgentContext;
};

export type DispatchCreativeWorkspaceReceipt = {
  ok: true;
  execution: Extract<DispatchedCreativeWorkspaceExecution, { success: true }>;
  idempotency_key: string;
  snapshot_fingerprint_before: string;
  snapshot_fingerprint_after: string;
};

export type DispatchCreativeWorkspaceFailure = {
  ok: false;
  error: string;
  code: CreativeWorkspaceAgentErrorCode | null;
  execution: Extract<DispatchedCreativeWorkspaceExecution, { success: false }> | null;
  snapshot_fingerprint_before: string;
};

export type DispatchCreativeWorkspaceResult = DispatchCreativeWorkspaceReceipt | DispatchCreativeWorkspaceFailure;

/**
 * Route one or more UI mutations through the shared creative workspace agent
 * contract. The snapshot guard is filled from the live store, so callers only
 * describe intent; concurrency conflicts and semantic rejections surface as a
 * failure receipt instead of a silent store no-op.
 */
export function dispatchCreativeWorkspaceOperations(
  operations: CreativeWorkspaceOperationInput | CreativeWorkspaceOperationInput[],
  options: DispatchCreativeWorkspaceOptions = {},
): DispatchCreativeWorkspaceResult {
  const list = Array.isArray(operations) ? operations : [operations];
  const before = observeCreativeWorkspaceAgentSnapshot(options.context);
  if (!list.length) {
    return {
      ok: false,
      error: "No creative workspace operations to dispatch.",
      code: "invalid_input",
      execution: null,
      snapshot_fingerprint_before: before.snapshot_fingerprint,
    };
  }
  const idempotencyKey = options.idempotencyKey ?? `ui-creative:${crypto.randomUUID()}`;
  const envelope =
    list.length === 1
      ? {
          op: "execute" as const,
          operation: list[0],
          idempotency_key: idempotencyKey,
          expected_snapshot_fingerprint: before.snapshot_fingerprint,
        }
      : {
          op: "execute_batch" as const,
          idempotency_key: idempotencyKey,
          expected_snapshot_fingerprint: before.snapshot_fingerprint,
          steps: list.map((operation, index) => ({ step_id: `ui-step-${index + 1}`, operation })),
        };
  const parsedEnvelope = creativeWorkspaceAgentRequestSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    return {
      ok: false,
      error: parsedEnvelope.error.issues
        .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
        .join("; "),
      code: "invalid_input",
      execution: null,
      snapshot_fingerprint_before: before.snapshot_fingerprint,
    };
  }
  const result = executeCreativeWorkspaceAgentRequest(parsedEnvelope.data, options.context);
  if (result.op !== "execute" && result.op !== "execute_batch") {
    return {
      ok: false,
      error: `Unexpected tool result "${result.op}" for a creative mutation dispatch.`,
      code: "operation_rejected",
      execution: null,
      snapshot_fingerprint_before: before.snapshot_fingerprint,
    };
  }
  const execution = result.execution;
  if (!execution.success) {
    return {
      ok: false,
      error: execution.error,
      code: execution.code,
      execution,
      snapshot_fingerprint_before: before.snapshot_fingerprint,
    };
  }
  return {
    ok: true,
    execution,
    idempotency_key: idempotencyKey,
    snapshot_fingerprint_before: before.snapshot_fingerprint,
    snapshot_fingerprint_after: execution.snapshot.snapshot_fingerprint,
  };
}
