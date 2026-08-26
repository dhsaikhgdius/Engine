/**
 * Possession scope for character ↔ Agent bindings.
 *
 * When a character carries an `agentBinding` with `mode: "possess"`, the bound
 * Agent drives that character. The public Agent boundary (gateway) resolves
 * the possessed character set from the same preflight observation it already
 * performs for revision guards, then rejects workbench mutations that reach
 * outside that set — including Player Mode (`op:"player"`) and the persistent
 * Camera Pilot waypoint write (`pilot.record_waypoint`), which mutate live
 * project state without carrying author targets. A binding that names a
 * `session_id` belongs to that exact session; a binding that names only a
 * `profile_id` is matched against the `profile_id` carried by the request
 * envelope. Sessions that possess no character keep full stage-wide
 * authoring; the Director UI dispatch path is not session-scoped.
 *
 * When a session possesses exactly one character, the gateway may fill the
 * omitted object target of character-scoped author actions before Zod
 * validation ({@link findDirectorAuthorCharacterTargetGaps} and
 * {@link fillDirectorAuthorCharacterTargets}).
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
      profile_id: z.string().nullable().optional(),
      mode: z.string().optional(),
    })
    .nullable()
    .optional(),
});

/** The calling Agent identity the gateway resolves possession against. */
export type DirectorPossessionIdentity = {
  /** Durable Agent session id (e.g. `dsh-<session>`). */
  sessionId: string;
  /** Agent profile id carried by the tool request envelope, when available. */
  profileId?: string | null;
};

/**
 * Live Player Mode state observed from Stage `ui` (Canvas-published snapshot).
 * Required under possession for the remaining live-actor player verbs.
 */
export type DirectorLivePlayerState = {
  playerMode: boolean;
  playerActorId: string | null;
};

/** Player verbs that drive the live actor constrained by enter/set_actor. */
const LIVE_ACTOR_PLAYER_ACTIONS = new Set([
  "exit",
  "interact",
  "enter_vehicle",
  "exit_vehicle",
  "record_start",
  "record_stop",
]);

/**
 * Collect the object ids of characters possessed by the calling Agent.
 *
 * A binding that names a `session_id` is possessed only by that exact session.
 * A binding that names only a `profile_id` (attached before a live session
 * exists) is possessed by any caller presenting the same `profile_id`.
 *
 * @param observedCharacters - The `characters` field of an observe result.
 * @param identity - The calling session id plus the optional envelope profile id.
 * @returns Object ids whose `agent_binding` names this caller with mode `possess`.
 */
export function collectPossessedObjectIds(observedCharacters: unknown, identity: DirectorPossessionIdentity): string[] {
  const sessionId = identity.sessionId.trim();
  const profileId = identity.profileId?.trim() ?? "";
  if (!Array.isArray(observedCharacters) || (!sessionId && !profileId)) return [];
  const possessed: string[] = [];
  for (const entry of observedCharacters) {
    const parsed = observedPossessionCharacterSchema.safeParse(entry);
    if (!parsed.success) continue;
    const binding = parsed.data.agent_binding;
    if (!binding || binding.mode !== "possess") continue;
    const boundSession = typeof binding.session_id === "string" ? binding.session_id : "";
    const boundProfile = typeof binding.profile_id === "string" ? binding.profile_id : "";
    const possessedBySession = Boolean(sessionId) && boundSession === sessionId;
    // A binding that names a session belongs to that exact session; profile
    // matching only applies to bindings created before a live session exists.
    const possessedByProfile = !boundSession && Boolean(profileId) && boundProfile === profileId;
    if (!possessedBySession && !possessedByProfile) continue;
    if (!possessed.includes(parsed.data.id)) possessed.push(parsed.data.id);
  }
  return possessed;
}

/**
 * Author actions a possessed session may use, with how they name their
 * targets. Spatial `place_relative`/`orient_toward` mutate only their
 * `object_id`; `anchor_id`/`target_id` are read-only references and may name
 * any object, which is how a possessed character walks up to or turns toward
 * someone else.
 */
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
  "place_relative",
  "orient_toward",
]);

const MULTI_OBJECT_AUTHOR_ACTIONS = new Set<string>([
  "batch_update_objects",
  "reset_transforms",
  "align_objects",
  "distribute_objects",
  "focus_objects",
  "arrange_group",
  "arrange_facing_pair",
]);

const ANIMATION_AUTHOR_ACTIONS = new Set<string>(["set_animation", "apply_animation_recipe"]);

/**
 * Multi-target actions that stay valid with a single filled id. `align_objects`
 * and `distribute_objects` require several explicit ids, and the arrange
 * actions require two, so filling one possessed id would only trade a missing
 * field for a confusing length error.
 */
const FILLABLE_OBJECT_IDS_ACTIONS = new Set<string>(["batch_update_objects", "reset_transforms", "focus_objects"]);

/** Verdict returned by {@link evaluateDirectorPossessionScope}. */
export type DirectorPossessionScopeVerdict = { allowed: true } | { allowed: false; error: string };

function possessionScopeError(
  sessionId: string,
  possessedObjectIds: readonly string[],
  detail: string,
): {
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
  if (action.action === "compose_blocking") {
    // compose_blocking moves every listed character (and fits a camera); the
    // possession verdict below requires the character set ⊆ possessed set.
    return action.characters.map((character) => character.id);
  }
  if (
    SINGLE_OBJECT_AUTHOR_ACTIONS.has(action.action) &&
    "object_id" in action &&
    typeof action.object_id === "string"
  ) {
    return [action.object_id];
  }
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
 * every mutated target id is a possessed character: single-object actions by
 * `object_id`, multi-object actions by `object_ids`, object-targeted
 * animation by `target_id`, spatial `place_relative`/`orient_toward` by the
 * moved `object_id` (read-only anchors and look targets may name any object),
 * arrange actions by every moved `object_ids` entry, and `compose_blocking`
 * only when its character set is a subset of the possessed set. All other
 * mutations (patch, run_macro, correct, replace_project, undo, start_scene,
 * delete_objects, production edits, generated_3d promotion, storyboard
 * artifacts) are rejected with a readable error.
 *
 * Player Mode and Camera Pilot session commands are scoped too: `player`
 * `enter`/`set_actor`/`teleport`/`walk_to` must explicitly name a possessed
 * `actor_id` (Stage otherwise falls back to shared-tab state such as the
 * user's selection), the remaining `player` verbs (`exit`/`interact`/
 * `enter_vehicle`/`exit_vehicle`/`record_start`/`record_stop`) require an
 * active Player Mode whose live actor is one of the possessed characters
 * (pass {@link DirectorLivePlayerState} from observe `ui`), and
 * `pilot.record_waypoint` is rejected because it writes camera keyframes
 * outside any character. Transient pilot flight (`start`/`stop`/`set_view`)
 * stays available.
 *
 * @param input - The guarded operation, the calling session id, and the possessed set.
 * @returns `{ allowed: true }` or a rejection with an actionable error message.
 */
export function evaluateDirectorPossessionScope(input: {
  operation: DirectorWorkbenchOperation;
  sessionId: string;
  possessedObjectIds: readonly string[];
  /** Live Player Mode from observe `ui`; required for live-actor player verbs. */
  livePlayer?: DirectorLivePlayerState | null;
}): DirectorPossessionScopeVerdict {
  const { operation, sessionId, possessedObjectIds, livePlayer } = input;
  if (!possessedObjectIds.length) return { allowed: true };
  const isMutation =
    ["patch", "author", "run_macro", "correct", "replace_project", "undo"].includes(operation.op) ||
    (operation.op === "production" && operation.command.action !== "observe") ||
    (operation.op === "generated_3d" && operation.command.action === "promote") ||
    operation.op === "storyboard_artifact" ||
    operation.op === "player" ||
    (operation.op === "pilot" && operation.action === "record_waypoint");
  if (!isMutation) return { allowed: true };

  const possessed = new Set(possessedObjectIds);
  if (operation.op === "player") {
    // enter/set_actor select the live actor; teleport/walk_to mutate a
    // character transform and likewise fall back to shared-tab selection when
    // actor_id is omitted — require an explicit possessed id for all four.
    if (
      operation.action === "enter" ||
      operation.action === "set_actor" ||
      operation.action === "teleport" ||
      operation.action === "walk_to"
    ) {
      if (!operation.actor_id) {
        return possessionScopeError(
          sessionId,
          possessedObjectIds,
          `player.${operation.action} omitted actor_id; name one of the possessed character ids explicitly.`,
        );
      }
      if (!possessed.has(operation.actor_id)) {
        return possessionScopeError(
          sessionId,
          possessedObjectIds,
          `player.${operation.action} targets "${operation.actor_id}", which this session does not possess.`,
        );
      }
      return { allowed: true };
    }
    if (LIVE_ACTOR_PLAYER_ACTIONS.has(operation.action)) {
      if (!livePlayer?.playerMode || !livePlayer.playerActorId) {
        return possessionScopeError(
          sessionId,
          possessedObjectIds,
          `player.${operation.action} requires an active Player Mode on a possessed character; call player.enter with actor_id first, then observe fields=["ui"] to confirm player_mode/player_actor_id.`,
        );
      }
      if (!possessed.has(livePlayer.playerActorId)) {
        return possessionScopeError(
          sessionId,
          possessedObjectIds,
          `player.${operation.action} would drive live actor "${livePlayer.playerActorId}", which this session does not possess.`,
        );
      }
      return { allowed: true };
    }
    return { allowed: true };
  }
  if (operation.op === "pilot") {
    return possessionScopeError(
      sessionId,
      possessedObjectIds,
      `Operation "pilot.record_waypoint" writes camera keyframes outside the possessed characters and is rejected.`,
    );
  }

  if (operation.op !== "author") {
    return possessionScopeError(
      sessionId,
      possessedObjectIds,
      `Operation "${workbenchOperationName(operation)}" mutates state outside the possessed characters and is rejected.`,
    );
  }

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

/** An author action that omitted its fillable object target. */
export type DirectorCharacterTargetGap = {
  /** Index into the author `actions` array. */
  index: number;
  /** Action name at that index. */
  action: string;
  /** The omitted object-target field the gateway may fill. */
  field: "object_id" | "object_ids" | "target_id";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Scan a raw (pre-Zod) `director_workbench` input for character-scoped author
 * actions that omitted their object target.
 *
 * Only fields the possession preflight can meaningfully fill are reported:
 * `object_id` on single-object and spatial single-object actions,
 * `object_ids` on multi-object actions that accept one id, and `target_id` on
 * animation actions explicitly aimed at `target_type: "object"`. Anything
 * else (including non-author operations) yields no gaps, so unpossessed
 * sessions keep the exact validation errors they get today.
 *
 * @param input - The raw tool input before Zod validation.
 * @returns The gaps in action order; empty when nothing is fillable.
 */
export function findDirectorAuthorCharacterTargetGaps(input: unknown): DirectorCharacterTargetGap[] {
  const operation = asRecord(input);
  if (!operation || operation.op !== "author" || !Array.isArray(operation.actions)) return [];
  const gaps: DirectorCharacterTargetGap[] = [];
  operation.actions.forEach((entry, index) => {
    const action = asRecord(entry);
    const name = typeof action?.action === "string" ? action.action : null;
    if (!action || !name) return;
    if (SINGLE_OBJECT_AUTHOR_ACTIONS.has(name)) {
      if (action.object_id === undefined) gaps.push({ index, action: name, field: "object_id" });
      return;
    }
    if (FILLABLE_OBJECT_IDS_ACTIONS.has(name)) {
      if (action.object_ids === undefined) gaps.push({ index, action: name, field: "object_ids" });
      return;
    }
    if (ANIMATION_AUTHOR_ACTIONS.has(name) && action.target_type === "object" && action.target_id === undefined) {
      gaps.push({ index, action: name, field: "target_id" });
    }
  });
  return gaps;
}

/**
 * Return a copy of the raw author input with every reported gap filled with
 * the uniquely possessed character id. The original input is not mutated; the
 * result still goes through the full Zod validation afterwards.
 *
 * @param input - The raw tool input whose gaps were previously scanned.
 * @param gaps - The gaps reported by {@link findDirectorAuthorCharacterTargetGaps}.
 * @param objectId - The single possessed character id to fill in.
 * @returns The filled input, or the original input when there is nothing to fill.
 */
export function fillDirectorAuthorCharacterTargets(
  input: unknown,
  gaps: readonly DirectorCharacterTargetGap[],
  objectId: string,
): unknown {
  const operation = asRecord(input);
  if (!operation || !Array.isArray(operation.actions) || !gaps.length) return input;
  const gapsByIndex = new Map(gaps.map((gap) => [gap.index, gap]));
  return {
    ...operation,
    actions: operation.actions.map((entry, index) => {
      const gap = gapsByIndex.get(index);
      const action = asRecord(entry);
      if (!gap || !action) return entry;
      return { ...action, [gap.field]: gap.field === "object_ids" ? [objectId] : objectId };
    }),
  };
}

/**
 * Build the readable rejection used when a session that possesses several
 * characters omits the object target of a character-scoped author action.
 *
 * @param input - The calling session, its possessed set, and the omitted fields.
 * @returns An actionable error message naming the possessed characters.
 */
export function describeDirectorPossessionTargetAmbiguity(input: {
  sessionId: string;
  possessedObjectIds: readonly string[];
  gaps: readonly DirectorCharacterTargetGap[];
}): string {
  const scope = input.possessedObjectIds.map((id) => `"${id}"`).join(", ");
  const omissions = input.gaps.map((gap) => `actions[${gap.index}] "${gap.action}" omitted ${gap.field}`).join("; ");
  return (
    `Agent session "${input.sessionId}" possesses ${input.possessedObjectIds.length} characters (${scope}), ` +
    `so omitted character targets cannot be filled automatically: ${omissions}. ` +
    `Auto-fill only applies when the session possesses exactly one character; name one of the possessed ` +
    `character ids explicitly and retry.`
  );
}
