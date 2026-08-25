import { DIRECTOR_WORKBENCH_PLUGIN_TOOLS } from "@director/dsh-plugin-workbench";
import { asRecord as record } from "../../../packages/protocol/src/primitives";

export { compactWireSchema, DIRECTOR_AGENT_WIRE_SCHEMAS, operationNames } from "@director/dsh-plugin-workbench";

/** Stage / Canvas / Video / Blender tools served by Gateway and the DSH plugin. */
export const DIRECTOR_DYNAMIC_TOOLS = [...DIRECTOR_WORKBENCH_PLUGIN_TOOLS] as const;

export type DirectorAgentToolName = (typeof DIRECTOR_DYNAMIC_TOOLS)[number]["name"];

/** Tool-name allowlist for MCP and HTTP tool routes. */
export const DIRECTOR_AGENT_PIPELINE_TOOLS = new Set<string>(DIRECTOR_DYNAMIC_TOOLS.map((tool) => tool.name));

/** MCP / DSH abort budget for `blender_native` (Poly Haven, render, execute_code). */
export const BLENDER_NATIVE_TOOL_TIMEOUT_MS = 300_000;

/** Shared transport timeout used by MCP and HTTP tool routes. */
export function dynamicToolTimeoutMs(tool: string, input: unknown): number {
  if (tool === "blender_native") return BLENDER_NATIVE_TOOL_TIMEOUT_MS;
  const values = record(input);
  if (tool === "director_creative" && values?.op === "pipeline") {
    const request = record(values.request);
    if (request?.action === "start" && request.await_completion === true) return 15 * 60_000;
    if (request?.action === "cancel") return 120_000;
  }
  return 70_000;
}

/** Workbench ops that only read project or catalog state. */
const PARALLEL_WORKBENCH_OPS = new Set([
  "capabilities",
  "observe",
  "query_objects",
  "catalog",
  "inspect",
  "snapshot",
  "audit",
  "diff",
  "trace",
  "shot_ir",
  "describe_camera_move",
]);

/** Creative ops that only read workspace state. */
const PARALLEL_CREATIVE_OPS = new Set(["capabilities", "observe", "audit"]);

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
  "polyhaven_search",
  "sketchfab_search",
]);

/** Read-only calls may share a bounded execution window; every mutation is a barrier. */
export function directorAgentToolExecutionMode(tool: string, input: unknown): "parallel" | "exclusive" {
  const op = record(input)?.op;
  if (tool === "director_workbench" && typeof op === "string" && PARALLEL_WORKBENCH_OPS.has(op)) return "parallel";
  if (tool === "director_creative" && typeof op === "string" && PARALLEL_CREATIVE_OPS.has(op)) return "parallel";
  if (tool === "blender_native" && typeof op === "string" && PARALLEL_BLENDER_OPS.has(op)) return "parallel";
  if (tool === "stage_video" && (op === "capabilities" || op === "status")) return "parallel";
  return "exclusive";
}
