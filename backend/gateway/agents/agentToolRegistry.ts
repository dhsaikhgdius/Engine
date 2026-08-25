import { DIRECTOR_WORKBENCH_PLUGIN_TOOLS } from "@director/dsh-plugin-workbench";

export { compactWireSchema, DIRECTOR_AGENT_WIRE_SCHEMAS, operationNames } from "@director/dsh-plugin-workbench";
export {
  BLENDER_NATIVE_TOOL_TIMEOUT_MS,
  directorAgentToolExecutionMode,
  DIRECTOR_PIPELINE_AWAIT_TIMEOUT_MS,
  DIRECTOR_PIPELINE_CANCEL_TIMEOUT_MS,
  DIRECTOR_TOOL_TIMEOUT_MS,
  directorToolIsConcurrencySafe,
  dynamicToolTimeoutMs,
} from "@director/dsh-plugin-workbench";

/** Stage / Canvas / Video / Blender tools served by Gateway and the DSH plugin. */
export const DIRECTOR_DYNAMIC_TOOLS = [...DIRECTOR_WORKBENCH_PLUGIN_TOOLS] as const;

export type DirectorAgentToolName = (typeof DIRECTOR_DYNAMIC_TOOLS)[number]["name"];

/** Tool-name allowlist for MCP and HTTP tool routes. */
export const DIRECTOR_AGENT_PIPELINE_TOOLS = new Set<string>(DIRECTOR_DYNAMIC_TOOLS.map((tool) => tool.name));
