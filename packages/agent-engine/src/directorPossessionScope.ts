/**
 * Possession scope for character ↔ Agent bindings.
 *
 * When a character carries an `agentBinding` with `mode: "possess"`, the bound
 * Agent session drives that character. The public Agent boundary (gateway)
 * resolves the possessed character set from the same preflight observation it
 * already performs for revision guards, then rejects workbench mutations that
 * reach outside that set. Sessions that possess no character keep full
 * stage-wide authoring; the Director UI dispatch path is not session-scoped.
 *
 * @module directorPossessionScope
 */

import { z } from "zod";
import type { DirectorAuthoringAction } from "./directorAuthoring";
import type { DirectorWorkbenchOperation } from "./directorWorkbenchContract";

const observedPossessionCharacterSchema = z.looseObject({
  id: z.string(),
  agent_binding: z
    .looseObject({
      session_id: z.string().nullable().optional(),
      mode: z.string().optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Collect the object ids of characters possessed by the given Agent session.
 *
 * @param observedCharacters - The `characters` field of an observe result.
 * @param sessionId - The calling Agent session id (e.g. `dsh-<session>`).
 * @returns Object ids whose `agent_binding` names this session with mode `possess`.
 */
export function collectPossessedObjectIds(observedCharacters: unknown, sessionId: string): string[] {
  if (!Array.isArray(observedCharacters) || !sessionId.trim()) return [];
  const possessed: string[] = [];
  for (const entry of observedCharacters) {
    const parsed = observedPossessionCharacterSchema.safeParse(entry);
    if (!parsed.success) continue;
    const binding = parsed.data.agent_binding;
    if (!binding || binding.mode !== "possess" || binding.session_id !== sessionId) continue;
    if (!possessed.includes(parsed.data.id)) possessed.push(parsed.data.id);
  }
  return possessed;
}

/** Author actions a possessed session may use, with how they name their targets. */
const SINGLE_OBJECT_AUTHOR_ACTIONS = new Set<string>([
  "update_object",
  "set_object_pivot",
  "set_object_interaction",
  "clear_object_interaction",
  "set_character_pose_controls",
  "clear_character_pose_controls",
  "set_character_motion",
  "clear_character_motion",
  "set_character_ik",
  "clear_character_ik",
  "bind_character_agent",
  "unbind_character_agent",
]);

const MULTI_OBJECT_AUTHOR_ACTIONS = new Set<string>([
  "batch_update_objects",
  "reset_transforms",
  "align_objects",
  "distribute_objects",
  "focus_objects",
]);

const ANIMATION_AUTHOR_ACTIONS = new Set<string>(["set_animation", "apply_animation_recipe"]);

/** Verdict returned by {@link evaluateDirectorPossessionScope}. */
export type DirectorPossessionScopeVerdict = { allowed: true } | { allowed: false; error: string };

function possessionScopeError(sessionId: string, possessedObjectIds: readonly string[], detail: string): {
  allowed: false;
  error: string;
} {
  const scope = possessedObjectIds.map((id) => `"${id}"`).join(", ");
  return {
    allowed: false,
    error:
      `Agent session "${sessionId}" possesses character(s) ${scope}, so its workbench mutations are limited to ` +
      `those characters. ${detail} Run unbind_character_agent (from the Director inspector or an unpossessed ` +
      `session) to lift the restriction.`,
  };
}

function workbenchOperationName(operation: DirectorWorkbenchOperation): string {
  if (operation.op === "production") return `production.${operation.command.action}`;
  if (operation.op === "generation" || operation.op === "transcription" || operation.op === "generated_3d") {
    return `${operation.op}.${operation.command.action}`;
  }
  if (operation.op === "storyboard_artifact") return `storyboard_artifact.${operation.command.action}`;
  return operation.op;
}

function authoringActionTargetIds(action: DirectorAuthoringAction): string[] | null {
  if (SINGLE_OBJECT_AUTHOR_ACTIONS.has(action.action) && "object_id" in action) return [action.object_id];
  if (MULTI_OBJECT_AUTHOR_ACTIONS.has(action.action) && "object_ids" in action) return [...action.object_ids];
  if (ANIMATION_AUTHOR_ACTIONS.has(action.action) && "target_type" in action) {
    // Camera animation is outside a character possession scope.
    return action.target_type === "object" ? [action.target_id] : null;
  }
  return null;
}

/**
 * Decide whether a workbench operation is allowed for a session that possesses
 * the given characters.
 *
 * Reads, evidence captures, and durable generation/transcription job commands
 * stay allowed. Author batches must only contain object-scoped actions whose
 * every target id is a possessed character. All other mutations (patch,
 * run_macro, correct, replace_project, undo, start_scene, production edits,
 * generated_3d promotion, storyboard artifacts) are rejected with a readable
 * error.
 *
 * @param input - The guarded operation, the calling session id, and the possessed set.
 * @returns `{ allowed: true }` or a rejection with an actionable error message.
 */
export function evaluateDirectorPossessionScope(input: {
  operation: DirectorWorkbenchOperation;
  sessionId: string;
  possessedObjectIds: readonly string[];
}): DirectorPossessionScopeVerdict {
  const { operation, sessionId, possessedObjectIds } = input;
  if (!possessedObjectIds.length) return { allowed: true };
  const isMutation =
    ["patch", "author", "run_macro", "correct", "replace_project", "undo"].includes(operation.op) ||
    (operation.op === "production" && operation.command.action !== "observe") ||
    (operation.op === "generated_3d" && operation.command.action === "promote") ||
    operation.op === "storyboard_artifact";
  if (!isMutation) return { allowed: true };

  if (operation.op !== "author") {
    return possessionScopeError(
      sessionId,
      possessedObjectIds,
      `Operation "${workbenchOperationName(operation)}" mutates state outside the possessed characters and is rejected.`,
    );
  }

  const possessed = new Set(possessedObjectIds);
  for (const action of operation.actions) {
    const targetIds = authoringActionTargetIds(action);
    if (targetIds === null) {
      return possessionScopeError(
        sessionId,
        possessedObjectIds,
        `Author action "${action.action}" is not a character-scoped action and is rejected.`,
      );
    }
    const outside = targetIds.find((id) => !possessed.has(id));
    if (outside !== undefined) {
      return possessionScopeError(
        sessionId,
        possessedObjectIds,
        `Author action "${action.action}" targets "${outside}", which this session does not possess.`,
      );
    }
  }
  return { allowed: true };
}
