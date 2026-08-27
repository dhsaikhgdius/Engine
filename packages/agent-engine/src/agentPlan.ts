/**
 * Validation of model-drafted agent plans before any operation executes.
 *
 * The legacy JSON planner path lets a model propose a multi-step plan (up to
 * 48 operations across the shared agent tool registry). This module turns
 * that untrusted draft into a {@link DirectorAgentPlan}: every step is
 * dry-run validated against the tool's real schema — Stage commands are
 * actually executed against a cloned scene so later steps see earlier
 * staged state — and the whole plan is rejected with a step-indexed error
 * on the first invalid operation.
 *
 * Confirmation is a gateway decision, never a model claim: each step's
 * `requiresConfirmation` is derived here from a per-tool destructive-verb
 * taxonomy (deletes, removals, resets, render/submit, replace_project, …),
 * and an unparseable input is conservatively treated as destructive.
 *
 * @module agentPlan
 */

import { executeStageTool } from "./commandEngine";
import { validateVideoModelInput } from "./videoModelContract";
import { cloneScene } from "@director/stage-protocol";
import type { StageCommandToolName, StageScene } from "@director/stage-protocol";
import { z } from "zod";
import { parseDirectorWorkbenchInput } from "./directorWorkbenchContract";
import { blenderNativeToolRequestInputSchema } from "@director/protocol/blenderLiveProtocol";
import { creativeWorkspaceAgentRequestSchema } from "@director/protocol/creativeWorkspaceProtocol";
import { isRecord as isObject } from "@director/protocol/primitives";
import { AGENT_TOOL_NAMES, type AgentToolName } from "@director/protocol/agentTools";
import type { DirectorAgentId } from "./agentIds";
export { DIRECTOR_AGENT_IDS, type DirectorAgentId } from "./agentIds";

/** All tools an agent plan may target, drawn from the shared agent tool registry. */
export const DIRECTOR_AGENT_PLAN_TOOLS = AGENT_TOOL_NAMES;

/** A tool name that is valid within a Director agent plan. */
export type DirectorAgentPlanTool = AgentToolName;

/** A single planned operation — tool, input, and metadata — inside a validated agent plan. */
export interface DirectorAgentPlanOperation {
  id: string;
  tool: DirectorAgentPlanTool;
  input: Record<string, unknown>;
  summary: string;
  /** Derived by the gateway; models never decide whether confirmation is needed. */
  requiresConfirmation: boolean;
}

/** A fully validated, executable agent plan with resolved operations and metadata. */
export interface DirectorAgentPlan {
  id: string;
  agent: DirectorAgentId;
  summary: string;
  suggestedNext: string;
  operations: DirectorAgentPlanOperation[];
  requiresConfirmation: boolean;
  changedObjectIds: string[];
}

type JsonObject = Record<string, unknown>;

const nonEmptyTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const agentPlanOperationSchema = z.strictObject({
  tool: z.enum(DIRECTOR_AGENT_PLAN_TOOLS),
  input: z.record(z.string(), z.unknown()),
  summary: nonEmptyTextSchema(360),
});
const agentPlanDraftSchema = z.strictObject({
  summary: nonEmptyTextSchema(420),
  suggested_next: nonEmptyTextSchema(260).optional(),
  operations: z.array(agentPlanOperationSchema).max(48),
});
/** Shape of a raw agent plan draft as received from a model, before validation. */
export type AgentPlanDraft = z.infer<typeof agentPlanDraftSchema>;

function containsDestructiveOperation(tool: DirectorAgentPlanTool, input: Record<string, unknown>) {
  // Each tool family has its own destructive-operation taxonomy.
  // Parsing input against the schema gives us a reliable signal
  // rather than guessing from loose object shapes.
  if (tool === "blender_native") {
    if (input.op !== "apply" || !Array.isArray(input.operations)) return false;
    return input.operations.some((operation) => isObject(operation) && operation.op === "delete_object");
  }
  if (tool === "director_creative") {
    const parsed = creativeWorkspaceAgentRequestSchema.safeParse(input);
    if (!parsed.success) return true;
    if (
      parsed.data.op === "capabilities" ||
      parsed.data.op === "describe" ||
      parsed.data.op === "observe" ||
      parsed.data.op === "audit" ||
      parsed.data.op === "preview" ||
      parsed.data.op === "interchange" ||
      parsed.data.op === "collaboration"
    )
      return false;
    if (parsed.data.op === "pipeline") {
      return parsed.data.request.action === "start" || parsed.data.request.action === "cancel";
    }
    const destructive = ["canvas.node.remove", "canvas.edge.remove", "edit.clip.remove", "edit.track.remove"];
    if (parsed.data.op === "execute_batch") {
      return parsed.data.steps.some((step) => destructive.includes(step.operation.op));
    }
    return destructive.includes(parsed.data.operation.op);
  }
  if (tool === "director_workbench") {
    const parsed = parseDirectorWorkbenchInput(input);
    if (!parsed.success) return true;
    if (parsed.operation.op === "replace_project") return true;
    if (parsed.operation.op === "run_macro") return true;
    if (parsed.operation.op === "macro") return parsed.operation.command.action === "remove";
    if (parsed.operation.op === "memory") return parsed.operation.command.action === "forget";
    if (parsed.operation.op === "generation") {
      return ["submit", "cancel", "retry", "promote"].includes(parsed.operation.command.action);
    }
    if (parsed.operation.op === "transcription") {
      return ["submit", "cancel", "retry", "promote"].includes(parsed.operation.command.action);
    }
    if (parsed.operation.op === "reconstruction") {
      return ["submit", "apply"].includes(parsed.operation.command.action);
    }
    if (parsed.operation.op === "patch") return parsed.operation.patches.some((patch) => patch.op === "remove");
    if (parsed.operation.op === "author") {
      return parsed.operation.actions.some(
        (action) =>
          action.action === "delete_objects" ||
          action.action === "delete_cameras" ||
          action.action === "remove_assets" ||
          action.action === "start_scene" ||
          (action.action === "set_storyboard" && action.storyboard === null),
      );
    }
    return false;
  }
  const operations = Array.isArray(input.ops) ? input.ops : [input];
  return operations.some((value) => {
    if (!isObject(value)) return true;
    const op = value.op;
    return (
      op === "delete" ||
      op === "remove_item" ||
      op === "remove_track" ||
      (tool === "stage_scene" && op === "reset") ||
      (tool === "stage_video" && (op === "render" || op === "submit"))
    );
  });
}

function changedObjectIds(input: Record<string, unknown>, result: unknown) {
  // Collect every object id that the operation touched — from the
  // input spec, the result payload, and nested tool-specific shapes.
  const ids = new Set<string>();
  const operations = Array.isArray(input.ops) ? input.ops : [input];
  for (const operation of operations) {
    if (!isObject(operation)) continue;
    if (typeof operation.object_id === "string") ids.add(operation.object_id);
    if (Array.isArray(operation.object_ids)) {
      operation.object_ids.forEach((id) => {
        if (typeof id === "string") ids.add(id);
      });
    }
  }
  if (isObject(result)) {
    for (const key of ["object_id", "camera_id", "group_id"] as const) {
      if (typeof result[key] === "string") ids.add(result[key] as string);
    }
    for (const key of ["created", "updated", "deleted"] as const) {
      const group = isObject(result[key]) ? (result[key] as JsonObject) : null;
      if (group && Array.isArray(group.object_ids))
        group.object_ids.forEach((id) => {
          if (typeof id === "string") ids.add(id);
        });
    }
  }
  if (input.op === "author" && Array.isArray(input.actions)) {
    input.actions.forEach((action) => {
      if (!isObject(action)) return;
      for (const key of ["id", "object_id", "target_id"] as const)
        if (typeof action[key] === "string") ids.add(action[key] as string);
      if (Array.isArray(action.object_ids))
        action.object_ids.forEach((id) => {
          if (typeof id === "string") ids.add(id);
        });
    });
  }
  if (input.op === "execute" && isObject(input.operation)) {
    for (const key of ["node_id", "edge_id", "clip_id", "track_id", "source_node_id", "target_node_id"] as const) {
      if (typeof input.operation[key] === "string") ids.add(input.operation[key] as string);
    }
  }
  if (input.op === "execute_batch" && Array.isArray(input.steps)) {
    input.steps.forEach((step) => {
      if (!isObject(step) || !isObject(step.operation)) return;
      for (const key of ["node_id", "edge_id", "clip_id", "track_id", "source_node_id", "target_node_id"] as const) {
        const value = step.operation[key];
        if (typeof value === "string" && !value.startsWith("@")) ids.add(value);
      }
    });
  }
  if (input.op === "apply" && Array.isArray(input.operations)) {
    input.operations.forEach((operation) => {
      if (!isObject(operation)) return;
      for (const key of ["id", "newId", "idPrefix", "targetId", "parentId", "objectId"] as const) {
        const value = operation[key];
        if (typeof value === "string") ids.add(value);
      }
      for (const key of ["ids", "selectedIds"] as const) {
        const values = operation[key];
        if (!Array.isArray(values)) continue;
        values.forEach((value) => {
          if (typeof value === "string") ids.add(value);
        });
      }
      if (isObject(operation.target) && typeof operation.target.objectId === "string") {
        ids.add(operation.target.objectId);
      }
      if (isObject(operation.context)) {
        if (typeof operation.context.activeId === "string") ids.add(operation.context.activeId);
        if (Array.isArray(operation.context.selectedIds)) {
          operation.context.selectedIds.forEach((value) => {
            if (typeof value === "string") ids.add(value);
          });
        }
      }
    });
  }
  return ids;
}

// Parse the raw model draft and enforce the per-operation payload budget
// before any per-tool validation runs.
function normalizeDraft(value: unknown): AgentPlanDraft | { error: string } {
  const parsed = agentPlanDraftSchema.safeParse(value);
  if (!parsed.success) return { error: "Agent plan format invalid" };
  const oversizedOperation = parsed.data.operations.find(
    (operation) => JSON.stringify(operation.input).length > 24_000,
  );
  if (oversizedOperation) return { error: "Plan operation too large" };
  return {
    summary: parsed.data.summary,
    operations: parsed.data.operations,
    suggested_next: parsed.data.suggested_next ?? "If you want to continue, tell me the next shot or action.",
  };
}

/**
 * Validate a model-drafted plan into an executable {@link DirectorAgentPlan}.
 *
 * Stage tool steps are executed against a clone of the live scene so each
 * step is checked in the context its predecessors produced; workbench,
 * creative, and Blender steps are schema-validated only (their execution is
 * owned by the gateway/browser executors). Returns a step-indexed error for
 * the first failing operation instead of a partial plan.
 */
export function validateDirectorAgentPlan(input: {
  draft: unknown;
  scene: StageScene;
  agent: DirectorAgentId;
  id: string;
}): DirectorAgentPlan | { error: string } {
  const draft = normalizeDraft(input.draft);
  if ("error" in draft) return draft;

  const refs = new Map<string, string>();
  let staged = cloneScene(input.scene);
  const allChangedObjectIds = new Set<string>();
  const operations: DirectorAgentPlanOperation[] = [];
  for (let index = 0; index < draft.operations.length; index += 1) {
    const operation = draft.operations[index];
    let result: unknown;
    if (operation.tool === "director_creative") {
      const parsed = creativeWorkspaceAgentRequestSchema.safeParse(operation.input);
      if (!parsed.success) {
        return {
          error: `Plan step ${index + 1} cannot execute: director_creative input invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.map(String).join(".") || "$"} ${issue.message}`)
            .join("; ")}`,
        };
      }
      result = { accepted: true };
    } else if (operation.tool === "director_workbench") {
      const parsed = parseDirectorWorkbenchInput(operation.input);
      if (!parsed.success) return { error: `Plan step ${index + 1} cannot execute: ${parsed.error}` };
      result = { accepted: true };
    } else if (operation.tool === "blender_native") {
      const parsed = blenderNativeToolRequestInputSchema.safeParse(operation.input);
      if (!parsed.success) {
        return {
          error: `Plan step ${index + 1} cannot execute: blender_native input invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.map(String).join(".") || "$"} ${issue.message}`)
            .join("; ")}`,
        };
      }
      result = { accepted: true };
    } else if (operation.tool === "stage_video") {
      const error = validateVideoModelInput(operation.input, staged);
      if (error) return { error: `Plan step ${index + 1} cannot execute: ${error}` };
    } else {
      const execution = executeStageTool(staged, operation.tool as StageCommandToolName, operation.input, refs);
      if (!execution.success) {
        return { error: `Plan step ${index + 1} cannot execute: ${execution.error ?? "unknown error"}` };
      }
      staged = execution.scene;
      result = execution.result;
    }
    changedObjectIds(operation.input, result).forEach((id) => allChangedObjectIds.add(id));
    operations.push({
      id: `${input.id}-${index + 1}`,
      tool: operation.tool,
      input: operation.input,
      summary: operation.summary,
      requiresConfirmation: containsDestructiveOperation(operation.tool, operation.input),
    });
  }

  return {
    id: input.id,
    agent: input.agent,
    summary: draft.summary,
    suggestedNext: draft.suggested_next ?? "If you want to continue, tell me the next shot or action.",
    operations,
    requiresConfirmation: operations.some((operation) => operation.requiresConfirmation),
    changedObjectIds: [...allChangedObjectIds],
  };
}
