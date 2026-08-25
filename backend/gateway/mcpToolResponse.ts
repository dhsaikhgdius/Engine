import { z } from "zod";
import {
  directorAgentTargetWireSchema,
  stageAgentEventTypeSchema,
} from "../../packages/protocol/src/agentGatewayProtocol";
import { asRecord as record } from "../../packages/protocol/src/primitives";
import {
  agentBoundaryReceiptSchema,
  createStageSceneHint,
  stageChangedEntitiesSchema,
  stageFeedbackContextSchema,
  stageSceneHintSchema,
  type StageGatewayExecution,
} from "@director/agent-engine";
import {
  directorAgentModelEnvelope,
  directorAgentToolResultNeedsProjection,
  projectDirectorAgentToolEnvelope,
  stripEncodedMediaPayloads,
} from "./agents/agentToolResultProjection";

/** Schema for the structured output returned by every MCP tool invocation. */
export const mcpToolStructuredOutputSchema = z.strictObject({
  /** Whether the operation succeeded. */
  ok: z.boolean(),
  /** Machine-readable outcome code, or null on success. */
  code: z.string().nullable(),
  /** The operation's result payload, or null. */
  result: z.unknown().nullable(),
  /** Human-readable error message, or null on success. */
  error: z.string().nullable(),
  /** A suggested next action for the agent, or null. */
  suggested_next: z.string().nullable(),
  /** UI events that should be applied to the Director workbench. */
  ui_events: z.array(
    z.strictObject({
      type: stageAgentEventTypeSchema,
      objectId: z.string().optional(),
    }),
  ),
  /** Entities that changed as a result of the operation. */
  changed: stageChangedEntitiesSchema,
  /** A hint about the current Stage scene state. */
  scene_hint: stageSceneHintSchema,
  /** Contextual feedback for the target workspace. */
  context: stageFeedbackContextSchema,
  /** Map of available reference identifiers to their descriptions. */
  available_refs: z.record(z.string(), z.string()),
  /** The Director target the operation was executed against, or null. */
  target: directorAgentTargetWireSchema.nullable(),
  /** Agent boundary receipt, or null when the call was not accepted. */
  agent_boundary: agentBoundaryReceiptSchema.nullable(),
});

export type McpToolStructuredOutput = z.infer<typeof mcpToolStructuredOutputSchema>;

/**
 * Recursively searches a nested object for a string value at the given key.
 *
 * Looks in the root object and in common child keys (`execution`, `preview`,
 * `result`) to surface nested codes and suggestions.
 *
 * @param value - The object to search.
 * @param key - The key to look for.
 * @returns The string value or null if not found.
 */
function nestedString(value: unknown, key: string): string | null {
  const root = record(value);
  if (!root) return null;
  if (typeof root[key] === "string") return root[key];
  for (const childKey of ["execution", "preview", "result"]) {
    const child = record(root[childKey]);
    if (child && typeof child[key] === "string") return child[key];
  }
  return null;
}

/**
 * Maps an error code to a human-readable recovery suggestion for the agent.
 *
 * Covers common error codes such as target mismatches, revision conflicts,
 * and resource unavailability.
 *
 * @param code - The machine-readable error code, or null.
 * @returns A suggested next action, or null if no recovery is known.
 */
function recoverySuggestion(code: string | null): string | null {
  switch (code) {
    case "target_required":
      return "Call observe first, retain its exact target token, then retry against that same target.";
    case "target_unavailable":
      return "Stop writes, reconnect the intended Director tab, and call observe again to acquire a new exact target.";
    case "target_mismatch":
      return "Stop writes. The exact target changed during preflight; observe the intended Director tab again and never fall back to another tab.";
    case "invalid_preflight_revision":
      return "No mutation was sent. Observe the same target again and retry only after it returns a valid project_revision.";
    case "stale_project_revision":
    case "revision_conflict":
      return "Observe the same target again, reconcile current state, and submit the remaining intent with the latest revision.";
    case "stale_snapshot":
    case "conflict":
      return "Observe the same creative workspace again and rebuild the request with its latest snapshot fingerprint.";
    case "outcome_unknown":
      return "Reconnect the target, inspect the current state, and retry only work that is still missing.";
    case "session_busy":
      return "A leftover session_busy means an older gateway still rejected overlap. Current gateways queue untargeted calls and bound target_token calls; retry the same request only if this error persists.";
    case "command_timeout":
      return "Keep the intended Director tab visible, refresh the observation guard when required, and retry the cancelled read or evidence request.";
    case "capture_unavailable":
      return "Open or switch the intended target to 3D Stage, wait for its viewport to finish mounting, then observe again before retrying capture or delivery.";
    case "workbench_unavailable":
    case "creative_workspace_unavailable":
      return "Open the intended Director workspace and retry. Durable observe/audit can use the last persisted project or live Blender kernel; mutations and capture still need a visible tab. Use blender_native scene/inspect for native geometry.";
    default:
      return null;
  }
}

/**
 * Projects the model-facing slice of an execution when it is oversized.
 *
 * The measurement excludes the embedded `scene` (target-tracking data that
 * never reaches the model). A full-project observe or heavy catalog page is
 * summarized to counts, id samples, and a retrieval hint so the MCP client's
 * context is not flooded; small results pass through untouched. Feedback keeps
 * the strict {@link mcpToolStructuredOutputSchema} shape: slimmed keys are
 * adopted only when they stay schema-valid.
 */
function projectExecutionForModel(execution: StageGatewayExecution, tool?: string): StageGatewayExecution {
  const envelope = directorAgentModelEnvelope(execution as unknown as Record<string, unknown>);
  const decision = directorAgentToolResultNeedsProjection(envelope, { tool: tool ?? "", input: undefined });
  if (!decision.needed || !decision.reason) return execution;
  const projected = projectDirectorAgentToolEnvelope(
    { ...envelope, feedback: execution.feedback },
    decision.reason,
    undefined,
    tool,
  );
  const projectedContext = stageFeedbackContextSchema.safeParse(record(projected.feedback)?.context);
  const feedback = execution.feedback
    ? {
        ...execution.feedback,
        context: projectedContext.success ? projectedContext.data : { objects: [], tracks: [] },
      }
    : undefined;
  return {
    ...execution,
    result: projected.result,
    ...(feedback ? { feedback } : {}),
  };
}

/**
 * Builds an MCP tool response from a {@link StageGatewayExecution}.
 *
 * Produces a structured JSON payload with outcome, feedback, and recovery
 * hints, and optionally attaches a Stage viewport capture image. Oversized
 * results are summarized before they reach the model.
 *
 * @param rawExecution - The Stage gateway execution result.
 * @param tool - The Director tool that produced the execution.
 * @returns An object with structured content, MCP-compatible text/image
 *          content blocks, and an error flag.
 */
export function createMcpToolResponse(rawExecution: StageGatewayExecution, tool?: string) {
  const execution = projectExecutionForModel(rawExecution, tool);
  const fallbackFeedback = {
    changed: { object_ids: [], track_ids: [], scene_settings: false },
    scene_hint: createStageSceneHint(execution.scene),
    context: { objects: [], tracks: [] },
    available_refs: {},
  };
  const feedback = execution.feedback ?? fallbackFeedback;
  const code = execution.code ?? nestedString(execution.result, "code");
  const suggestedNext = nestedString(execution.result, "suggested_next") ?? recoverySuggestion(code ?? null);
  const structuredContent: McpToolStructuredOutput = {
    ok: execution.success,
    code: code ?? null,
    result: execution.result ?? null,
    error: execution.error ?? null,
    suggested_next: suggestedNext,
    ui_events: execution.events ?? [],
    changed: feedback.changed,
    scene_hint: feedback.scene_hint,
    context: feedback.context,
    available_refs: feedback.available_refs,
    target: execution.target ?? null,
    agent_boundary: execution.agent_boundary ?? null,
  };
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string; annotations: { audience: ["assistant"]; priority: number } }
  > = [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }];
  if (execution.capture) {
    content.push({
      type: "image",
      data: execution.capture.data,
      mimeType: execution.capture.mimeType,
      annotations: { audience: ["assistant"], priority: 1 },
    });
  }
  return { content, structuredContent, isError: !execution.success };
}
