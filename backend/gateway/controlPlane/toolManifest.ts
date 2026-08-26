import { z } from "zod";
import { directorWorkbenchOperationNames } from "@director/agent-engine";
import { directorDccOperationSchema } from "@director/dcc-protocol";
import { DIRECTOR_WORKBENCH_PLUGIN_TOOLS, operationNames } from "@director/dsh-plugin-workbench";
import { directorGameOperationSchema } from "../../../packages/protocol/src/directorGameProtocol";
import agentToolCategories from "../../../packages/protocol/src/agentTools.json";
import { AGENT_TOOL_NAMES, STAGE_COMMAND_TOOL_NAMES } from "../../../packages/protocol/src/agentTools";
import { creativeWorkspaceAgentRequestSchema } from "../../../packages/protocol/src/creativeWorkspaceProtocol";
import { blenderNativeToolRequestSchema } from "../../../packages/protocol/src/blenderLiveProtocol";
import { filmPipelineOperationSchema } from "../../../packages/protocol/src/filmPipelineProtocol";
import { productionEvidenceRequestSchema } from "../../../packages/protocol/src/productionArtifactProtocol";
import { videoModelOperationSchema } from "../../../packages/protocol/src/videoGenerationProtocol";

/** Contract identifier for the machine-readable tool manifest (roadmap M7). */
export const DIRECTOR_TOOL_MANIFEST_CONTRACT = "director-tool-manifest-v1";

const agentToolCategorySchema = z.enum(["stage", "targeted", "external"]);

const toolManifestEntrySchema = z.strictObject({
  name: z.string().min(1),
  surface: z.enum(["mcp", "http", "both"]),
  category: agentToolCategorySchema.optional(),
  description: z.string().min(1).optional(),
  operations: z.array(z.string().min(1)).min(1).optional(),
  http: z.strictObject({ method: z.literal("POST"), path: z.string().regex(/^\/api\/tools\/[a-z0-9_]+$/) }).nullable(),
  legacy: z.literal(true).optional(),
});

/** Validated wire shape of `GET /api/control-plane/tool-manifest`. */
export const directorToolManifestSchema = z.strictObject({
  contract: z.literal(DIRECTOR_TOOL_MANIFEST_CONTRACT),
  generated_at: z.iso.datetime(),
  tools: z.array(toolManifestEntrySchema).min(1),
});

export type DirectorToolManifest = z.infer<typeof directorToolManifestSchema>;
export type DirectorToolManifestEntry = z.infer<typeof toolManifestEntrySchema>;

function toolsHttpBinding(name: string): DirectorToolManifestEntry["http"] {
  return { method: "POST", path: `/api/tools/${name}` };
}

/**
 * First sentence of the model-facing plugin description. The full text carries
 * usage hints (including credential environment-variable names) that a public
 * discovery response must not repeat.
 */
function summarySentence(description: string): string {
  const end = description.indexOf(". ");
  return end === -1 ? description : description.slice(0, end + 1);
}

const pluginToolDescriptions = new Map<string, string>(
  DIRECTOR_WORKBENCH_PLUGIN_TOOLS.map((tool) => [tool.name, summarySentence(tool.description)]),
);

const toolCategories: Record<string, DirectorToolManifestEntry["category"]> = Object.fromEntries(
  Object.entries(agentToolCategories).map(([name, category]) => [name, agentToolCategorySchema.parse(category)]),
);

/**
 * Wire `op` enum per typed tool, derived from the same protocol schemas that
 * validate execution. `describe` on each tool reflects exact per-op fields, so
 * the manifest stays a catalog rather than an inlined schema tree.
 */
const typedToolOperations: Record<string, readonly string[]> = {
  director_workbench: directorWorkbenchOperationNames,
  director_creative: operationNames(creativeWorkspaceAgentRequestSchema),
  stage_video: operationNames(videoModelOperationSchema),
  blender_native: operationNames(blenderNativeToolRequestSchema),
  director_dcc: operationNames(directorDccOperationSchema),
  director_game: operationNames(directorGameOperationSchema),
  director_film: operationNames(filmPipelineOperationSchema),
  director_production: operationNames(productionEvidenceRequestSchema),
};

const stageCommandToolNames = new Set<string>(STAGE_COMMAND_TOOL_NAMES);

/**
 * Builds the machine-readable Director tool catalog.
 *
 * Reflects the real transport bindings instead of assuming one rule for every
 * tool: registry tools from `agentTools.json` are POST `/api/tools/<name>`;
 * legacy `stage_*` commands are HTTP-only compatibility routes that MCP no
 * longer advertises; `director_dcc` is served by the DCC route and MCP;
 * `director_film` and `director_production` are MCP tools whose HTTP surface
 * is their own domain routes, not `/api/tools/<name>`.
 */
export function buildDirectorToolManifest(now: Date = new Date()): DirectorToolManifest {
  const registryTools: DirectorToolManifestEntry[] = AGENT_TOOL_NAMES.map((name) => {
    const legacy = stageCommandToolNames.has(name);
    return {
      name,
      surface: legacy ? ("http" as const) : ("both" as const),
      category: toolCategories[name],
      description: legacy
        ? "Legacy compact Stage command surface kept for HTTP compatibility; superseded by director_workbench and no longer advertised over MCP."
        : pluginToolDescriptions.get(name),
      operations: typedToolOperations[name] ? [...typedToolOperations[name]] : undefined,
      http: toolsHttpBinding(name),
      ...(legacy ? { legacy: true as const } : {}),
    };
  });

  const extraTools: DirectorToolManifestEntry[] = [
    {
      name: "director_dcc",
      surface: "both",
      description:
        "Discover and operate Director DCC providers (Blender, Maya, Unreal, and others): exchange packages, revision-guarded .blend export, and preview/apply import plans.",
      operations: [...typedToolOperations.director_dcc],
      http: toolsHttpBinding("director_dcc"),
    },
    {
      name: "director_game",
      surface: "both",
      description:
        "Plan and playtest a typed game slice on the live Director Stage. Capabilities and describe are the vocabulary; engine export is director_dcc after a playable receipt.",
      operations: [...typedToolOperations.director_game],
      http: toolsHttpBinding("director_game"),
    },
    {
      name: "director_film",
      surface: "mcp",
      description:
        "Durable idea/script-to-film pipeline runs. MCP-only tool name; over raw HTTP use the film domain routes (GET/POST /api/film/runs, GET /api/film/runs/{id}, POST /api/film/runs/{id}/{op}), not POST /api/tools/director_film.",
      operations: [...typedToolOperations.director_film],
      http: null,
    },
    {
      name: "director_production",
      surface: "mcp",
      description:
        "Immutable production artifact versions, approvals, and guarded promotion. MCP-only tool name; over raw HTTP use the production evidence routes (/api/production/artifact-versions, /api/production/approvals, /api/production/promotions), not POST /api/tools/director_production.",
      operations: [...typedToolOperations.director_production],
      http: null,
    },
  ];

  return directorToolManifestSchema.parse({
    contract: DIRECTOR_TOOL_MANIFEST_CONTRACT,
    generated_at: now.toISOString(),
    tools: [...registryTools, ...extraTools],
  });
}
