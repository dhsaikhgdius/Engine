/**
 * Canonical implementation lives in the DSH workbench plugin so both
 * model-facing surfaces (the DeepSeek Harness plugin in its own process and
 * the MCP server in this one) share a single projection. This module remains
 * the gateway-side import path.
 */
export {
  DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT,
  DIRECTOR_AGENT_TOOL_RESULT_BUDGET_BYTES,
  directorAgentModelEnvelope,
  directorAgentToolResultNeedsProjection,
  finalizeDirectorAgentToolEnvelope,
  projectDirectorAgentToolEnvelope,
  projectOversizedDirectorAgentToolEnvelope,
  slimDirectorAgentToolResult,
  stripEncodedMediaPayloads,
  utf8ByteLength,
  type DirectorAgentToolProjection,
  type DirectorAgentToolProjectionReason,
  type DirectorAgentToolSpillRef,
  type FinalizeDirectorAgentToolEnvelopeOptions,
} from "@director/dsh-plugin-workbench/tool-result-projection";
