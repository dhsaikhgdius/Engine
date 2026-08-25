import { isFilmRoleId, type FilmRoleId } from "../../../packages/protocol/src/filmRoles";
import { blenderNativeReadOperationNames } from "../../../packages/protocol/src/blenderLiveProtocol";
import { asRecord as record } from "../../../packages/protocol/src/primitives";

const WORKSPACE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "bash", "todo_write"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

function isDirectorWorkspaceTool(tool: string) {
  return WORKSPACE_TOOLS.has(tool);
}

function isDirectorWebTool(tool: string) {
  return WEB_TOOLS.has(tool);
}

/** Workbench operations that only read state — safe for any role. */
const READ_ONLY_WORKBENCH_OPERATIONS = new Set([
  "capabilities",
  "observe",
  "query_objects",
  "catalog",
  "audit",
  "diff",
  "trace",
  "shot_ir",
  "compare",
]);
/** Workbench operations that provide visual evidence (includes capture). */
const VISUAL_EVIDENCE_WORKBENCH_OPERATIONS = new Set([
  "capabilities",
  "observe",
  "query_objects",
  "catalog",
  "capture",
  "shot_ir",
  "compare",
]);
/** Creative/Canvas operations that only read state. */
const READ_ONLY_CREATIVE_OPERATIONS = new Set(["capabilities", "observe", "audit", "preview"]);
/** Blender operations that are read-only. */
const READ_ONLY_BLENDER_OPERATIONS = new Set<string>(blenderNativeReadOperationNames);
/** Roles that are allowed to author stage changes. */
const STAGE_AUTHOR_ROLES = new Set<FilmRoleId>(["stage-director", "cinematographer", "repair-operator"]);
/**
 * Roles whose contract requires Workbench / Blender / generation tools.
 *
 * After the in-tree harness cutover, hosted production runs are a single text
 * completion. These roles must not be marked successful without a tool loop.
 */
export const FILM_ROLES_REQUIRING_TOOL_LOOP = new Set<FilmRoleId>([
  "production-designer",
  "stage-director",
  "cinematographer",
  "repair-operator",
  "generation-operator",
  "visual-critic",
  "editor",
]);
/** Tools that stage-author roles are allowed to use. */
const STAGE_AUTHOR_TOOLS = new Set([
  "stage_read",
  "stage_scene",
  "stage_object",
  "stage_camera",
  "stage_show",
  "director_workbench",
  "blender_native",
]);

/**
 * Returns whether a creative/Canvas operation is read-only.
 *
 * Handles the main ops plus nested `interchange`, `pipeline`, and
 * `collaboration` sub-operations.
 */
function isReadOnlyCreativeOperation(values: Record<string, unknown> | null) {
  const operation = typeof values?.op === "string" ? values.op : "";
  if (READ_ONLY_CREATIVE_OPERATIONS.has(operation)) return true;
  if (operation === "interchange") return record(values?.request)?.action === "capabilities";
  if (operation === "pipeline") {
    const request = record(values?.request);
    return new Set(["capabilities", "status"]).has(typeof request?.action === "string" ? request.action : "");
  }
  if (operation !== "collaboration") return false;
  const request = record(values?.request);
  return new Set(["observe", "list-comments", "list-versions", "compare"]).has(
    typeof request?.action === "string" ? request.action : "",
  );
}

/**
 * Returns whether a creative/Canvas pipeline operation is allowed for the
 * generation-operator role — either read-only or the `start`/`cancel` actions.
 */
function isCanvasPipelineOperatorOperation(values: Record<string, unknown> | null) {
  if (isReadOnlyCreativeOperation(values)) return true;
  if (values?.op === "pipeline") {
    const request = record(values.request);
    return new Set(["start", "cancel"]).has(typeof request?.action === "string" ? request.action : "");
  }
  if (values?.op === "execute") return record(values.operation)?.op === "canvas.production.configure";
  if (values?.op !== "execute_batch" || !Array.isArray(values.steps) || !values.steps.length) return false;
  return values.steps.every((step) => record(record(step)?.operation)?.op === "canvas.production.configure");
}

/**
 * One role policy shared by hosted API agents and local Agent harness prompts.
 *
 * Determines whether a given film role is allowed to execute a specific tool
 * with a specific input. Falls back to read-only access for any unrecognized role.
 *
 * @param roleId - The film role, or `null` for unrestricted access.
 * @param tool - The tool name.
 * @param input - The tool input.
 * @returns `true` when the operation is allowed.
 */
/**
 * Tools and operations that do not mutate the scene, files, or Blender.
 * Plan mode allows only these; the pipeline rejects everything else.
 */
/** Workspace tools that mutate the repository; plan mode hides and rejects them. */
export function isPlanModeHiddenWorkspaceTool(tool: string) {
  return tool === "write" || tool === "edit" || tool === "bash" || tool === "todo_write";
}

export function isReadOnlyDirectorTool(tool: string, input: unknown) {
  if (tool === "update_goal" || tool === "read" || tool === "glob" || tool === "grep") return true;
  if (isDirectorWebTool(tool)) return true;
  if (isPlanModeHiddenWorkspaceTool(tool)) return false;
  const values = record(input);
  const operation = typeof values?.op === "string" ? values.op : "";
  if (tool === "director_workbench") return READ_ONLY_WORKBENCH_OPERATIONS.has(operation);
  if (tool === "director_creative") return isReadOnlyCreativeOperation(values);
  if (tool === "stage_video") return operation === "capabilities" || operation === "status";
  if (tool === "blender_native") return READ_ONLY_BLENDER_OPERATIONS.has(operation);
  return false;
}

/** Rejects mutating tools while `/plan` is on. */
export function planModeToolPolicyRejection(planMode: boolean, tool: string, input: unknown) {
  if (!planMode || isReadOnlyDirectorTool(tool, input)) return null;
  return {
    success: false as const,
    code: "plan_mode_blocked" as const,
    error: "Plan mode is on. Mutating tools are blocked until /plan off.",
  };
}

export function roleAllowsTool(roleId: FilmRoleId | null, tool: string, input: unknown) {
  if (!roleId) return true;
  if (tool === "update_goal") return true;
  if (isDirectorWorkspaceTool(tool) || isDirectorWebTool(tool)) return false;
  const values = record(input);
  const operation = typeof values?.op === "string" ? values.op : "";

  if (STAGE_AUTHOR_ROLES.has(roleId)) return STAGE_AUTHOR_TOOLS.has(tool);
  if (roleId === "production-designer") {
    return (
      tool === "stage_read" ||
      tool === "blender_native" ||
      (tool === "director_workbench" && READ_ONLY_WORKBENCH_OPERATIONS.has(operation))
    );
  }
  if (roleId === "generation-operator") {
    return (
      tool === "stage_video" ||
      tool === "stage_read" ||
      (tool === "blender_native" && READ_ONLY_BLENDER_OPERATIONS.has(operation)) ||
      (tool === "director_workbench" && READ_ONLY_WORKBENCH_OPERATIONS.has(operation)) ||
      (tool === "director_creative" && isCanvasPipelineOperatorOperation(values))
    );
  }
  if (roleId === "visual-critic") {
    return (
      tool === "stage_read" ||
      (tool === "blender_native" && READ_ONLY_BLENDER_OPERATIONS.has(operation)) ||
      (tool === "director_workbench" && VISUAL_EVIDENCE_WORKBENCH_OPERATIONS.has(operation)) ||
      (tool === "director_creative" && isReadOnlyCreativeOperation(values))
    );
  }
  if (roleId === "editor") return tool === "director_creative" || tool === "stage_read";
  return (
    tool === "stage_read" ||
    (tool === "blender_native" && READ_ONLY_BLENDER_OPERATIONS.has(operation)) ||
    (tool === "director_workbench" && READ_ONLY_WORKBENCH_OPERATIONS.has(operation)) ||
    (tool === "director_creative" && isReadOnlyCreativeOperation(values))
  );
}

/** True when a film role cannot complete honestly without a workbench tool loop. */
export function filmRoleRequiresToolLoop(roleId: string): roleId is FilmRoleId {
  return isFilmRoleId(roleId) && FILM_ROLES_REQUIRING_TOOL_LOOP.has(roleId);
}

/**
 * MCP and hosted harnesses use the same representative read operation when
 * deciding tool visibility — a role that can read a tool can see it in the
 * tool list, even if not all operations are allowed.
 *
 * @param roleId - The film role, or `null` for unrestricted access.
 * @param tool - The tool name.
 * @returns `true` when the tool should be visible to the role.
 */
export function roleCanSeeTool(roleId: FilmRoleId | null, tool: string) {
  const op = tool === "blender_native" ? "status" : tool === "stage_read" ? "observe" : "capabilities";
  return roleAllowsTool(roleId, tool, { op });
}

/**
 * Returns a rejection object when a tool operation is not allowed for the
 * given role, or `null` when the operation is permitted.
 *
 * @param roleId - The film role, or `null` for unrestricted access.
 * @param tool - The tool name.
 * @param input - The tool input.
 * @returns A rejection object, or `null` when allowed.
 */
export function filmRoleToolPolicyRejection(roleId: FilmRoleId | null, tool: string, input: unknown) {
  if (roleAllowsTool(roleId, tool, input)) return null;
  return {
    success: false as const,
    code: "tool_policy_rejected" as const,
    error: `${roleId ?? "session"} is not allowed to execute ${tool} with this operation`,
  };
}

/** Role policy first, then plan-mode. Shared by MCP and film-role tool routes. */
export function directorToolPolicyRejection(
  roleId: FilmRoleId | null,
  planMode: boolean,
  tool: string,
  input: unknown,
) {
  return filmRoleToolPolicyRejection(roleId, tool, input) ?? planModeToolPolicyRejection(planMode, tool, input);
}

/**
 * Parses a film role from an environment variable value.
 *
 * @param value - The raw environment value.
 * @returns The parsed {@link FilmRoleId}, or `null` when empty.
 * @throws {@link Error} When the value is not a recognized role id.
 */
export function filmRoleFromEnvironment(value: string | undefined) {
  const roleId = value?.trim();
  if (!roleId) return null;
  if (!isFilmRoleId(roleId)) throw new Error(`Unknown Director film role: ${roleId}`);
  return roleId;
}

/**
 * Returns an English system prompt fragment describing the permissions for a
 * given film role.
 *
 * Used by MCP and film-role tool routes. DSH receives the same policy through
 * the tool allowlist instead.
 *
 * @param roleId - The film role, or `null`/`undefined` for no role hint.
 * @returns A prompt string, or an empty string when no role is set.
 */
export function filmRoleToolPolicyPrompt(roleId: FilmRoleId | null | undefined) {
  if (!roleId) return "";
  if (roleId === "production-designer") {
    return "Role policy: you may model natively with blender_native. Use Director and Canvas only to read context.";
  }
  if (STAGE_AUTHOR_ROLES.has(roleId)) {
    return "Role policy: you may edit the Director 3D Stage and Blender. Place catalog or generated meshes; model unique geometry with blender_native. Do not assemble Stage primitives. Do not submit video generation or edit Canvas / Video Editor.";
  }
  if (roleId === "generation-operator") {
    return "Role policy: you may submit video generation and configure Canvas generation pipelines. Other scene capabilities are read-only.";
  }
  if (roleId === "visual-critic") {
    return "Role policy: read state and use capture/inspect to check frames. Do not edit the scene, Canvas, or generation jobs.";
  }
  if (roleId === "editor") return "Role policy: use Video Editor / Canvas and read-only Stage context only.";
  return "Role policy: read production context only. Do not edit the scene, Canvas, or generation jobs.";
}
