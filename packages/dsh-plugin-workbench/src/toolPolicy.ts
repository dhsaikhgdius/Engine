import { asRecord } from "@director/protocol/primitives";

/** MCP / DSH abort budget for `blender_native` (Poly Haven, render, execute_code). */
export const BLENDER_NATIVE_TOOL_TIMEOUT_MS = 300_000;

/** Default cooperative timeout for Stage / Canvas / video tools. */
export const DIRECTOR_TOOL_TIMEOUT_MS = 70_000;

/** Creative pipeline start that waits for completion. */
export const DIRECTOR_PIPELINE_AWAIT_TIMEOUT_MS = 15 * 60_000;

/** Creative pipeline cancel. */
export const DIRECTOR_PIPELINE_CANCEL_TIMEOUT_MS = 120_000;

/** Workbench ops that only read project or catalog state. */
const PARALLEL_WORKBENCH_OPS = new Set([
  "capabilities",
  "describe",
  "observe",
  "query_objects",
  "catalog",
  "inspect",
  "snapshot",
  "audit",
  "diff",
  "trace",
  "shot_ir",
  "compare",
  "describe_camera_move",
]);

/** Creative ops that only read workspace state. */
const PARALLEL_CREATIVE_OPS = new Set(["capabilities", "observe", "audit", "describe"]);

/** Native Blender ops that only read state or search public libraries. */
const PARALLEL_BLENDER_OPS = new Set([
  "status",
  "scene",
  "catalog",
  "describe",
  "inspect",
  "capture",
  "capture_render",
  "query",
  "live_link",
  "polyhaven_search",
  "sketchfab_search",
]);

const PARALLEL_JOB_ACTIONS = new Set(["get", "status", "providers", "list", "capabilities"]);

function nestedAction(input: unknown): string | undefined {
  const values = asRecord(input);
  const direct = values?.action;
  if (typeof direct === "string") return direct;
  const command = asRecord(values?.command) ?? asRecord(values?.request);
  return typeof command?.action === "string" ? command.action : undefined;
}

/** Shared transport timeout used by DSH, MCP, and HTTP tool routes. */
export function dynamicToolTimeoutMs(tool: string, input: unknown): number {
  if (tool === "blender_native") return BLENDER_NATIVE_TOOL_TIMEOUT_MS;
  const values = asRecord(input);
  if (tool === "director_creative" && values?.op === "pipeline") {
    const request = asRecord(values.request);
    if (request?.action === "start" && request.await_completion === true) return DIRECTOR_PIPELINE_AWAIT_TIMEOUT_MS;
    if (request?.action === "cancel") return DIRECTOR_PIPELINE_CANCEL_TIMEOUT_MS;
  }
  return DIRECTOR_TOOL_TIMEOUT_MS;
}

/**
 * Read-only calls may share a bounded DSH parallel window; every mutation is exclusive.
 * Nested generation/transcription/reconstruction polls (`get` / `status` / `providers`) are reads.
 */
export function directorAgentToolExecutionMode(tool: string, input: unknown): "parallel" | "exclusive" {
  const op = asRecord(input)?.op;
  if (tool === "director_workbench" && typeof op === "string") {
    if (PARALLEL_WORKBENCH_OPS.has(op)) return "parallel";
    if (
      (op === "generated_3d" || op === "generation" || op === "transcription" || op === "reconstruction") &&
      PARALLEL_JOB_ACTIONS.has(nestedAction(input) ?? "")
    ) {
      return "parallel";
    }
  }
  if (tool === "director_creative" && typeof op === "string" && PARALLEL_CREATIVE_OPS.has(op)) return "parallel";
  if (tool === "blender_native" && typeof op === "string" && PARALLEL_BLENDER_OPS.has(op)) return "parallel";
  if (tool === "stage_video" && (op === "capabilities" || op === "status" || op === "get")) return "parallel";
  if (tool === "director_model_routes") return "parallel";
  return "exclusive";
}

/** DSH `isConcurrencySafe` classifier: only an exact `true` opts into a parallel group. */
export function directorToolIsConcurrencySafe(tool: string, args: unknown): boolean {
  return directorAgentToolExecutionMode(tool, args) === "parallel";
}
