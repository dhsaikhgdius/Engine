import { randomUUID } from "node:crypto";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import type { AgentBoundaryReceipt } from "@director/agent-engine";
import type { CreativeWorkspaceAgentRequest } from "../../packages/protocol/src/creativeWorkspaceProtocol";

type WorkbenchMutation = Extract<
  DirectorWorkbenchOperation,
  { op: "patch" | "author" | "run_macro" | "correct" | "replace_project" | "undo" }
>;
type WorkbenchProductionRequest = Extract<DirectorWorkbenchOperation, { op: "production" }>;
type WorkbenchProductionMutation = Omit<WorkbenchProductionRequest, "command"> & {
  command: Exclude<WorkbenchProductionRequest["command"], { action: "observe" }>;
};
type WorkbenchGenerationRequest = Extract<DirectorWorkbenchOperation, { op: "generation" }>;
type WorkbenchTranscriptionRequest = Extract<DirectorWorkbenchOperation, { op: "transcription" }>;
type WorkbenchGenerated3DRequest = Extract<DirectorWorkbenchOperation, { op: "generated_3d" }>;
type WorkbenchGenerated3DPromotion = Omit<WorkbenchGenerated3DRequest, "command"> & {
  command: Extract<WorkbenchGenerated3DRequest["command"], { action: "promote" }>;
};
type WorkbenchStoryboardMutation = Extract<DirectorWorkbenchOperation, { op: "storyboard_artifact" }>;
type WorkbenchDurableJobMutation =
  | (Omit<WorkbenchGenerationRequest, "command"> & {
      command: Extract<WorkbenchGenerationRequest["command"], { action: "submit" | "retry" }>;
    })
  | (Omit<WorkbenchTranscriptionRequest, "command"> & {
      command: Extract<WorkbenchTranscriptionRequest["command"], { action: "submit" | "retry" }>;
    })
  | (Omit<WorkbenchGenerated3DRequest, "command"> & {
      command: Extract<WorkbenchGenerated3DRequest["command"], { action: "submit" | "retry" }>;
    });
type CreativeEditMutation = Extract<CreativeWorkspaceAgentRequest, { op: "execute" | "execute_batch" }>;
type CreativePipelineRequest = Extract<CreativeWorkspaceAgentRequest, { op: "pipeline" }>;
type CreativePipelineStart = Omit<CreativePipelineRequest, "request"> & {
  request: Extract<CreativePipelineRequest["request"], { action: "start" }>;
};
type CreativeCollaborationRequest = Extract<CreativeWorkspaceAgentRequest, { op: "collaboration" }>;
type CreativeCommentMutation = Omit<CreativeCollaborationRequest, "request"> & {
  request: Extract<
    CreativeCollaborationRequest["request"],
    {
      action:
        | "add-comment"
        | "resolve-comment"
        | "reopen-comment"
        | "update-comment"
        | "delete-comment"
        | "create-version"
        | "restore-version"
        | "delete-version";
    }
  >;
};
type CreativeMutation = CreativeEditMutation | CreativePipelineStart | CreativeCommentMutation;
export type AgentMutation =
  | {
      tool: "director_workbench";
      operation:
        | WorkbenchMutation
        | WorkbenchProductionMutation
        | WorkbenchGenerated3DPromotion
        | WorkbenchStoryboardMutation;
    }
  | { tool: "director_creative"; operation: CreativeMutation };
type AgentDurableJobMutation = { tool: "director_workbench"; operation: WorkbenchDurableJobMutation };

/**
 * A mutation that has been assigned an idempotency key and, when applicable,
 * fitted with an optimistic-concurrency guard. The `needsObservation` flag
 * signals that the caller must preflight-observe before the gateway will
 * execute the mutation.
 */
export type PreparedMutation = {
  mutation: AgentMutation;
  key: string;
  keySource: "caller" | "generated";
  needsObservation: boolean;
  receipt?: AgentBoundaryReceipt;
};

// Process-epoch in-memory caches: guards and target bindings are not persisted
// across restarts — a restart naturally clears all remembered state. Eviction
// is LRU with a hard cap to prevent unbounded growth from long-lived sessions.
const rememberedGuards = new Map<string, string>();
const MAX_REMEMBERED_GUARDS = 2_048;

// Session-sticky browser targets: an untargeted caller keeps addressing the tab
// that served its previous call, so an author→capture sequence cannot fork
// across divergent tabs. Process-epoch memory, like the guard cache below.
// The last-active timestamp doubles as the gateway's only record of "which
// agent sessions recently drove this tool", surfaced read-only through
// GET /api/agent/sessions for the character-binding picker.
type RememberedSessionTarget = { sessionId: string; targetToken: string; lastActiveAtMs: number };
const rememberedTargets = new Map<string, RememberedSessionTarget>();
const MAX_REMEMBERED_TARGETS = 512;

function memoryKey(tool: AgentMutation["tool"], sessionId: string, key: string) {
  return `${tool}\u0000${sessionId}\u0000${key}`;
}

function rememberGuard(key: string, value: string) {
  rememberedGuards.delete(key);
  rememberedGuards.set(key, value);
  while (rememberedGuards.size > MAX_REMEMBERED_GUARDS) rememberedGuards.delete(rememberedGuards.keys().next().value!);
}

function targetMemoryKey(tool: AgentMutation["tool"], sessionId: string) {
  return `${tool}\u0000${sessionId}`;
}

/**
 * Associates a browser target token with an agent session so that subsequent
 * untargeted calls from the same tool+session pair are routed to the same tab.
 */
export function rememberAgentSessionTarget(tool: AgentMutation["tool"], sessionId: string, targetToken: string) {
  const key = targetMemoryKey(tool, sessionId);
  rememberedTargets.delete(key);
  rememberedTargets.set(key, { sessionId, targetToken, lastActiveAtMs: Date.now() });
  while (rememberedTargets.size > MAX_REMEMBERED_TARGETS) {
    rememberedTargets.delete(rememberedTargets.keys().next().value!);
  }
}

/**
 * Returns the previously remembered browser target token for the tool+session
 * pair, or `undefined` if none was stored.
 */
export function recallAgentSessionTarget(tool: AgentMutation["tool"], sessionId: string) {
  return rememberedTargets.get(targetMemoryKey(tool, sessionId))?.targetToken;
}

/**
 * Read-only snapshot of the agent sessions that recently drove the given tool,
 * newest activity first. This is the same process-epoch memory that powers
 * session-sticky target routing — no second session store exists.
 *
 * @param tool - The public tool whose sessions to list.
 * @returns Session ids with their last successful tool-call timestamp.
 */
export function listAgentSessionTargets(
  tool: AgentMutation["tool"],
): Array<{ sessionId: string; lastActiveAtMs: number }> {
  const prefix = `${tool}\u0000`;
  const sessions: Array<{ sessionId: string; lastActiveAtMs: number }> = [];
  for (const [key, record] of rememberedTargets) {
    if (!key.startsWith(prefix)) continue;
    sessions.push({ sessionId: record.sessionId, lastActiveAtMs: record.lastActiveAtMs });
  }
  return sessions.sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs);
}

/**
 * Clears the remembered browser target for the tool+session pair, typically
 * called when the owning tab disconnects.
 */
export function forgetAgentSessionTarget(tool: AgentMutation["tool"], sessionId: string) {
  rememberedTargets.delete(targetMemoryKey(tool, sessionId));
}

function operationName(mutation: AgentMutation) {
  if (mutation.operation.op === "production") return `production.${mutation.operation.command.action}`;
  if (mutation.operation.op === "generated_3d" || mutation.operation.op === "storyboard_artifact") {
    return `${mutation.operation.op}.${mutation.operation.command.action}`;
  }
  return mutation.operation.op === "collaboration" || mutation.operation.op === "pipeline"
    ? `${mutation.operation.op}.${mutation.operation.request.action}`
    : mutation.operation.op;
}

function durableJobOperationName(mutation: AgentDurableJobMutation) {
  return `${mutation.operation.op}.${mutation.operation.command.action}`;
}

function operationKey(mutation: AgentMutation) {
  if (mutation.operation.op === "production") return mutation.operation.command.idempotency_key;
  if (mutation.operation.op === "generated_3d" || mutation.operation.op === "storyboard_artifact") {
    return mutation.operation.command.idempotency_key;
  }
  return mutation.operation.op === "collaboration" || mutation.operation.op === "pipeline"
    ? mutation.operation.request.idempotency_key
    : mutation.operation.idempotency_key;
}

function operationGuard(mutation: AgentMutation) {
  if (mutation.operation.op === "production") {
    return mutation.operation.command.expected_revision === undefined
      ? undefined
      : String(mutation.operation.command.expected_revision);
  }
  if (mutation.operation.op === "generated_3d" || mutation.operation.op === "storyboard_artifact") {
    return mutation.operation.command.expected_revision;
  }
  if (mutation.tool === "director_workbench") return mutation.operation.expected_revision;
  if (mutation.operation.op === "collaboration") return mutation.operation.request.expected_collaboration_fingerprint;
  if (mutation.operation.op === "pipeline") return mutation.operation.request.expected_snapshot_fingerprint;
  return mutation.operation.expected_snapshot_fingerprint;
}

function guardField(mutation: AgentMutation) {
  if (mutation.operation.op === "production") return "expected_production_revision" as const;
  if (mutation.tool === "director_workbench") return "expected_revision" as const;
  return mutation.operation.op === "collaboration"
    ? ("expected_collaboration_fingerprint" as const)
    : ("expected_snapshot_fingerprint" as const);
}

function withKey(mutation: AgentMutation, key: string): AgentMutation {
  const operation = mutation.operation;
  if (operation.op === "production") {
    return {
      ...mutation,
      operation: { ...operation, command: { ...operation.command, idempotency_key: key } },
    } as AgentMutation;
  }
  if (operation.op === "generated_3d" || operation.op === "storyboard_artifact") {
    return {
      ...mutation,
      operation: { ...operation, command: { ...operation.command, idempotency_key: key } },
    } as AgentMutation;
  }
  if (mutation.tool === "director_creative" && (operation.op === "collaboration" || operation.op === "pipeline")) {
    return {
      ...mutation,
      operation: { ...operation, request: { ...operation.request, idempotency_key: key } },
    } as AgentMutation;
  }
  return { ...mutation, operation: { ...operation, idempotency_key: key } } as AgentMutation;
}

function withGuard(mutation: AgentMutation, value: string): AgentMutation {
  const operation = mutation.operation;
  if (operation.op === "production") {
    return {
      ...mutation,
      operation: { ...operation, command: { ...operation.command, expected_revision: Number(value) } },
    } as AgentMutation;
  }
  if (operation.op === "generated_3d" || operation.op === "storyboard_artifact") {
    return {
      ...mutation,
      operation: { ...operation, command: { ...operation.command, expected_revision: value } },
    } as AgentMutation;
  }
  if (mutation.tool === "director_workbench") {
    return { ...mutation, operation: { ...operation, expected_revision: value } } as AgentMutation;
  }
  if (operation.op === "collaboration") {
    return {
      ...mutation,
      operation: { ...operation, request: { ...operation.request, expected_collaboration_fingerprint: value } },
    } as AgentMutation;
  }
  if (operation.op === "pipeline") {
    return {
      ...mutation,
      operation: { ...operation, request: { ...operation.request, expected_snapshot_fingerprint: value } },
    } as AgentMutation;
  }
  return { ...mutation, operation: { ...operation, expected_snapshot_fingerprint: value } } as AgentMutation;
}

function receipt(
  mutation: AgentMutation,
  key: string,
  keySource: PreparedMutation["keySource"],
  options:
    | { mode: "unconditional" }
    | { mode: "revision"; source: "caller" | "preflight_observe" | "remembered_retry"; value: string },
): AgentBoundaryReceipt {
  return {
    policy: "director-agent-public-boundary-v2",
    tool: mutation.tool,
    operation: operationName(mutation),
    exact_target: true,
    preflight_observe: options.mode === "revision" && options.source === "preflight_observe",
    guard:
      options.mode === "unconditional"
        ? { mode: "unconditional", source: "caller" }
        : { mode: "revision", field: guardField(mutation), source: options.source, value: options.value },
    idempotency: { key, source: keySource, stable_retry: true },
  };
}

function durableJobReceipt(
  mutation: AgentDurableJobMutation,
  key: string,
  keySource: PreparedMutation["keySource"],
): AgentBoundaryReceipt {
  return {
    policy: "director-agent-public-boundary-v2",
    tool: "director_workbench",
    operation: durableJobOperationName(mutation),
    exact_target: true,
    preflight_observe: false,
    guard: { mode: "durable_job", source: "gateway" },
    idempotency: { key, source: keySource, stable_retry: true },
  };
}

/**
 * Type guard that narrows a workbench operation to mutations that change
 * project state (patch, author, production mutations, generated_3d promotion,
 * storyboard artifact, etc.).
 */
export function isWorkbenchMutation(
  operation: DirectorWorkbenchOperation,
): operation is
  | WorkbenchMutation
  | WorkbenchProductionMutation
  | WorkbenchGenerated3DPromotion
  | WorkbenchStoryboardMutation {
  return (
    ["patch", "author", "run_macro", "correct", "replace_project", "undo"].includes(operation.op) ||
    (operation.op === "production" && operation.command.action !== "observe") ||
    (operation.op === "generated_3d" && operation.command.action === "promote") ||
    operation.op === "storyboard_artifact"
  );
}

/**
 * Type guard for workbench read-only evidence operations (capture, shot_package,
 * deliver) that produce output without mutating project state.
 */
export function isWorkbenchEvidence(operation: DirectorWorkbenchOperation) {
  return operation.op === "capture" || operation.op === "shot_package" || operation.op === "deliver";
}

/**
 * Type guard for workbench operations that submit or retry durable generation,
 * transcription, or 3D asset jobs.
 */
export function isWorkbenchDurableJobMutation(
  operation: DirectorWorkbenchOperation,
): operation is WorkbenchDurableJobMutation {
  return (
    (operation.op === "generation" || operation.op === "transcription" || operation.op === "generated_3d") &&
    (operation.command.action === "submit" || operation.command.action === "retry")
  );
}

const CREATIVE_COLLABORATION_MUTATIONS = new Set([
  "add-comment",
  "resolve-comment",
  "reopen-comment",
  "update-comment",
  "delete-comment",
  "create-version",
  "restore-version",
  "delete-version",
]);

/**
 * Type guard for creative workspace mutations: execute, execute_batch, pipeline
 * start, and collaboration write actions.
 */
export function isCreativeMutation(operation: CreativeWorkspaceAgentRequest): operation is CreativeMutation {
  return (
    operation.op === "execute" ||
    operation.op === "execute_batch" ||
    (operation.op === "pipeline" && operation.request.action === "start") ||
    (operation.op === "collaboration" && CREATIVE_COLLABORATION_MUTATIONS.has(operation.request.action))
  );
}

/**
 * Type guard for creative workspace read-only operations that still need
 * optimistic-concurrency guard resolution (e.g. preview).
 */
export function isCreativeGuardedRead(operation: CreativeWorkspaceAgentRequest) {
  return operation.op === "preview";
}

/**
 * Prepares an agent mutation for the gateway boundary: assigns an idempotency
 * key, resolves the optimistic-concurrency guard, and determines whether a
 * preflight observation is required before execution.
 *
 * When the caller supplies a guard (expected_revision / fingerprint), the
 * mutation is ready immediately. When the operation is marked unconditional,
 * no guard is attached. Otherwise `needsObservation` is set to `true` and the
 * caller must call {@link applyObservedAgentGuard} with the observed revision
 * before the gateway will execute the mutation.
 *
 * @param mutation - The raw agent mutation to prepare.
 * @param sessionId - The agent session identifier for guard caching.
 * @returns A prepared mutation with key, guard status, and optional receipt.
 */
export function prepareAgentMutation(mutation: AgentMutation, sessionId: string): PreparedMutation {
  const callerKey = operationKey(mutation);
  const key = callerKey ?? `agent-intent:${randomUUID()}`;
  const keySource = callerKey ? "caller" : "generated";
  const preparedMutation = withKey(mutation, key);

  if (
    preparedMutation.tool === "director_workbench" &&
    preparedMutation.operation.op !== "production" &&
    "unconditional" in preparedMutation.operation &&
    preparedMutation.operation.unconditional === true
  ) {
    return {
      mutation: preparedMutation,
      key,
      keySource,
      needsObservation: false,
      receipt: receipt(preparedMutation, key, keySource, { mode: "unconditional" }),
    };
  }

  const suppliedGuard = operationGuard(preparedMutation);
  if (suppliedGuard !== undefined) {
    return {
      mutation: preparedMutation,
      key,
      keySource,
      needsObservation: false,
      receipt: receipt(preparedMutation, key, keySource, { mode: "revision", source: "caller", value: suppliedGuard }),
    };
  }

  const remembered = rememberedGuards.get(memoryKey(mutation.tool, sessionId, key));
  if (!remembered) return { mutation: preparedMutation, key, keySource, needsObservation: true };
  return applyObservedAgentGuard(
    { mutation: preparedMutation, key, keySource, needsObservation: true },
    sessionId,
    remembered,
    "remembered_retry",
  );
}

/**
 * Prepares a durable job mutation (generation/transcription/3D submit/retry).
 * Unlike regular mutations, durable jobs always pass through without a
 * preflight observation — they carry their own idempotency guard.
 *
 * @param mutation - The raw durable job mutation to prepare.
 * @returns A prepared mutation with key, receipt, and `needsObservation: false`.
 */
export function prepareAgentDurableJobMutation(mutation: AgentDurableJobMutation): {
  mutation: AgentDurableJobMutation;
  key: string;
  keySource: PreparedMutation["keySource"];
  needsObservation: false;
  receipt: AgentBoundaryReceipt;
} {
  const callerKey = mutation.operation.command.idempotency_key;
  const key = callerKey ?? `agent-intent:${randomUUID()}`;
  const keySource = callerKey ? "caller" : "generated";
  const prepared = {
    ...mutation,
    operation: {
      ...mutation.operation,
      command: { ...mutation.operation.command, idempotency_key: key },
    },
  } as AgentDurableJobMutation;
  return {
    mutation: prepared,
    key,
    keySource,
    needsObservation: false,
    receipt: durableJobReceipt(prepared, key, keySource),
  };
}

/**
 * Applies an observed revision or fingerprint guard to a prepared mutation,
 * remembers it for future retries, and returns the guard-ready mutation with
 * its boundary receipt.
 *
 * @param prepared - The mutation returned by {@link prepareAgentMutation}.
 * @param sessionId - The agent session identifier for guard caching.
 * @param value - The observed revision or fingerprint string.
 * @param source - Whether this guard came from a preflight observe or a remembered retry.
 * @returns The guard-ready mutation with a receipt.
 */
export function applyObservedAgentGuard(
  prepared: PreparedMutation,
  sessionId: string,
  value: string,
  source: "preflight_observe" | "remembered_retry" = "preflight_observe",
): PreparedMutation & { receipt: AgentBoundaryReceipt } {
  const mutation = withGuard(prepared.mutation, value);
  rememberGuard(memoryKey(prepared.mutation.tool, sessionId, prepared.key), value);
  return {
    ...prepared,
    mutation,
    needsObservation: false,
    receipt: receipt(mutation, prepared.key, prepared.keySource, { mode: "revision", source, value }),
  };
}

/** Clears all in-memory guard and target caches. For test teardown only. */
export function resetAgentNaiveBoundaryForTests() {
  rememberedGuards.clear();
  rememberedTargets.clear();
}
