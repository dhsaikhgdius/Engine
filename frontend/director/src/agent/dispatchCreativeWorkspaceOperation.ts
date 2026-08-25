/**
 * UI dispatch layer for creative workspace (Canvas / Video Editor) operations.
 *
 * UI mutators and the Agent surface share executeCreativeWorkspaceAgentRequest;
 * this helper observes the live snapshot to fill expected_snapshot_fingerprint,
 * assigns an idempotency key, executes one operation through the same guarded
 * boundary, and returns a receipt for parity harnesses.
 */

import {
  executeCreativeWorkspaceAgentRequest,
  observeCreativeWorkspaceAgentSnapshot,
  type CreativeWorkspaceAgentErrorCode,
  type CreativeWorkspaceAgentOperation,
} from "./creativeWorkspaceAgentContract";

export type DispatchCreativeWorkspaceOptions = {
  idempotencyKey?: string;
  expectedSnapshotFingerprint?: string;
};

export type DispatchCreativeWorkspaceReceipt = {
  ok: true;
  operation: string;
  snapshot_fingerprint_before: string;
  snapshot_fingerprint: string;
  idempotency_key: string;
  message: string;
  result: Record<string, unknown>;
};

export type DispatchCreativeWorkspaceFailure = {
  ok: false;
  error: string;
  code: CreativeWorkspaceAgentErrorCode | null;
  snapshot_fingerprint_before: string;
};

export function dispatchCreativeWorkspaceOperation(
  operation: CreativeWorkspaceAgentOperation,
  options: DispatchCreativeWorkspaceOptions = {},
): DispatchCreativeWorkspaceReceipt | DispatchCreativeWorkspaceFailure {
  const snapshotFingerprintBefore = observeCreativeWorkspaceAgentSnapshot().snapshot_fingerprint;
  if (options.expectedSnapshotFingerprint && options.expectedSnapshotFingerprint !== snapshotFingerprintBefore) {
    return {
      ok: false,
      error: `Stale creative snapshot (expected ${options.expectedSnapshotFingerprint}, current ${snapshotFingerprintBefore}).`,
      code: "conflict",
      snapshot_fingerprint_before: snapshotFingerprintBefore,
    };
  }
  const idempotencyKey = options.idempotencyKey ?? `ui-creative:${crypto.randomUUID()}`;
  const result = executeCreativeWorkspaceAgentRequest({
    op: "execute",
    operation,
    expected_snapshot_fingerprint: snapshotFingerprintBefore,
    idempotency_key: idempotencyKey,
  });
  if (result.op !== "execute") {
    return {
      ok: false,
      error: `Creative execute returned an unexpected "${result.op}" envelope.`,
      code: null,
      snapshot_fingerprint_before: snapshotFingerprintBefore,
    };
  }
  const execution = result.execution;
  if (!execution.success) {
    return {
      ok: false,
      error: execution.error,
      code: execution.code ?? null,
      snapshot_fingerprint_before: snapshotFingerprintBefore,
    };
  }
  return {
    ok: true,
    operation: execution.operation,
    snapshot_fingerprint_before: snapshotFingerprintBefore,
    snapshot_fingerprint: execution.snapshot.snapshot_fingerprint,
    idempotency_key: idempotencyKey,
    message: execution.message,
    result: execution.result,
  };
}
