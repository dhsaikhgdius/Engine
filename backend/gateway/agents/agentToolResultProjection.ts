/**
 * Gateway compatibility re-export. The implementation lives in the DSH plugin
 * so MCP, HTTP, and Harness share one projection.
 */
export {
  DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT,
  DIRECTOR_AGENT_TOOL_RESULT_BUDGET_BYTES,
  directorAgentModelEnvelope,
  directorAgentToolResultNeedsProjection,
  finalizeDirectorAgentToolEnvelope,
  projectDirectorAgentToolEnvelope,
  slimDirectorAgentToolResult,
  utf8ByteLength,
  type DirectorAgentToolProjection,
  type DirectorAgentToolProjectionReason,
  type DirectorAgentToolSpillRef,
  type FinalizeDirectorAgentToolEnvelopeOptions,
} from "@director/dsh-plugin-workbench";
