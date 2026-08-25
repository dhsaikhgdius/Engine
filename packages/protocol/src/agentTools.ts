import agentTools from "./agentTools.json";
import { protocolKeys } from "./primitives";

/** A known agent tool name from the canonical agent tools registry. */
export type AgentToolName = keyof typeof agentTools;

/** The subset of agent tool names that are stage commands (excluding workspace, creative, video, and DCC tools). */
export type StageCommandToolName = Exclude<
  AgentToolName,
  "director_workbench" | "director_creative" | "stage_video" | "blender_native"
>;

/** The full list of agent tool names, in definition order from the registry. */
export const AGENT_TOOL_NAMES = protocolKeys(agentTools);

/** The subset of agent tool names categorised as stage commands. */
export const STAGE_COMMAND_TOOL_NAMES = AGENT_TOOL_NAMES.filter(
  (tool): tool is StageCommandToolName => agentTools[tool] === "stage",
);

/**
 * Type guard that checks whether a value is a known agent tool name.
 *
 * @param value - The value to test.
 * @returns `true` when the value is a string that exists as a key in the agent tools registry.
 */
export function isAgentToolName(value: unknown): value is AgentToolName {
  return typeof value === "string" && Object.hasOwn(agentTools, value);
}
