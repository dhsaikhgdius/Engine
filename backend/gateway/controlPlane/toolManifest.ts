import { z } from "zod";
import { directorWorkbenchOperationNames } from "@director/agent-engine";
import { stageCommandOperationNames, stageCommandOperationSchemas } from "@director/agent-engine/stage-command-schema";
import { directorDccOperationSchema } from "@director/dcc-protocol";
import { creativeWorkspaceAgentRequestSchema } from "../../../packages/protocol/src/creativeWorkspaceProtocol";
import { blenderNativeToolRequestSchema } from "../../../packages/protocol/src/blenderLiveProtocol";
import { videoModelOperationSchema } from "../../../packages/protocol/src/videoGenerationProtocol";
import { productionEvidenceRequestSchema } from "../../../packages/protocol/src/productionArtifactProtocol";
import { filmPipelineOperationSchema } from "../../../packages/protocol/src/filmPipelineProtocol";
import { STAGE_COMMAND_TOOL_NAMES } from "../../../packages/protocol/src/agentTools";
import { compactWireSchema, DIRECTOR_DYNAMIC_TOOLS, operationNames } from "../agents/agentToolRegistry";

/** Versioned contract identifier of the machine-readable tool manifest. */
export const DIRECTOR_TOOL_MANIFEST_CONTRACT = "director-tool-manifest:v1";

export type DirectorToolManifestEntry = {
  name: string;
  description: string;
  /** JSON Schema generated from the tool's Zod wire schema. */
  input_schema: Record<string, unknown>;
  /** Operation names accepted by the tool's strict execution schema. */
  operations?: readonly string[];
  /** Present and true only on frozen `stage_*` compatibility tools. */
  legacy?: true;
};

export type DirectorToolManifest = {
  contract: typeof DIRECTOR_TOOL_MANIFEST_CONTRACT;
  generated_at: string;
  tools: DirectorToolManifestEntry[];
};

/** Strict operation unions backing each dynamic tool's compact wire envelope. */
const DYNAMIC_TOOL_OPERATIONS: Record<string, readonly string[]> = {
  director_workbench: directorWorkbenchOperationNames,
  director_creative: operationNames(creativeWorkspaceAgentRequestSchema),
  stage_video: operationNames(videoModelOperationSchema),
  blender_native: operationNames(blenderNativeToolRequestSchema),
};

/**
 * Tools served over MCP that do not ride the DSH plugin catalog. Their wire
 * envelopes mirror the compact schemas registered in `mcp-server.ts`.
 */
const MCP_ONLY_TOOLS: ReadonlyArray<{
  name: string;
  description: string;
  schema: Parameters<typeof compactWireSchema>[0];
}> = [
  {
    name: "director_production",
    description:
      "Create, inspect, and promote artifact versions into Canvas, Stage, Video, or delivery. Versions and approvals are immutable; promote is optimistic-concurrency guarded.",
    schema: productionEvidenceRequestSchema,
  },
  {
    name: "director_film",
    description:
      "Run the agentic film production pipeline: idea-to-film or script-to-film. create starts a durable run; poll with status; resume continues from the last durable artifact.",
    schema: filmPipelineOperationSchema,
  },
  {
    name: "director_dcc",
    description:
      "Discover and operate Director DCC providers. Call discover first to see provider readiness, formats, and capability maturity.",
    schema: directorDccOperationSchema,
  },
];

function jsonSchemaRecord(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

let cachedManifest: DirectorToolManifest | undefined;

/**
 * The public, machine-readable Director tool catalog, generated from the same
 * Zod schemas that validate execution. Contains only schema-derived data —
 * never configuration, credentials, or provider endpoints.
 */
export function directorToolManifest(): DirectorToolManifest {
  if (cachedManifest) return cachedManifest;
  const dynamicTools: DirectorToolManifestEntry[] = DIRECTOR_DYNAMIC_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Record<string, unknown>,
    operations: DYNAMIC_TOOL_OPERATIONS[tool.name],
  }));
  const mcpTools: DirectorToolManifestEntry[] = MCP_ONLY_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchemaRecord(compactWireSchema(tool.schema, tool.description)),
    operations: operationNames(tool.schema),
  }));
  const legacyStageTools: DirectorToolManifestEntry[] = STAGE_COMMAND_TOOL_NAMES.map((tool) => ({
    name: tool,
    description: "Legacy compact Stage surface (HTTP-compatible only). Frozen; use director_workbench for new automation.",
    input_schema: jsonSchemaRecord(stageCommandOperationSchemas[tool]),
    operations: stageCommandOperationNames(tool),
    legacy: true,
  }));
  cachedManifest = {
    contract: DIRECTOR_TOOL_MANIFEST_CONTRACT,
    generated_at: new Date().toISOString(),
    tools: [...dynamicTools, ...mcpTools, ...legacyStageTools],
  };
  return cachedManifest;
}
