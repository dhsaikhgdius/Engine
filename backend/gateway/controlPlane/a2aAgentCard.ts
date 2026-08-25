import { z } from "zod";
import { buildDirectorToolManifest, DIRECTOR_TOOL_MANIFEST_CONTRACT } from "./toolManifest";

/** Contract identifier for the discovery-only A2A-style agent card (roadmap M7, ADR 0004). */
export const DIRECTOR_A2A_AGENT_CARD_CONTRACT = "director-a2a-agent-card-v1";

const loopbackHttpUrlSchema = z
  .string()
  .regex(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/, "agent card URLs must stay on the loopback gateway");

const a2aAgentSkillSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  operations: z.array(z.string().min(1)).min(1),
  http: z.strictObject({ method: z.literal("POST"), path: z.string().regex(/^\/api\/tools\/[a-z0-9_]+$/) }),
});

/**
 * Validated wire shape of `GET /api/control-plane/a2a-agent-card`.
 *
 * ADR 0004 rejected running a live A2A JSON-RPC server, so the card is
 * discovery-only by construction: the A2A endpoint is a `null` literal, every
 * capability an A2A runtime would need is a `false` literal, and URLs are
 * constrained to the loopback gateway so the card cannot advertise a remote
 * endpoint that bypasses gateway authentication.
 */
export const directorA2aAgentCardSchema = z.strictObject({
  contract: z.literal(DIRECTOR_A2A_AGENT_CARD_CONTRACT),
  discovery_only: z.literal(true),
  name: z.literal("Director"),
  description: z.string().min(1),
  url: loopbackHttpUrlSchema,
  a2a: z.strictObject({
    jsonrpc_endpoint: z.null(),
    decision: z.literal("ADR 0004: no live A2A runtime; discover here, execute over MCP or Director HTTP"),
  }),
  capabilities: z.strictObject({
    streaming: z.literal(false),
    push_notifications: z.literal(false),
    state_transition_history: z.literal(false),
  }),
  interfaces: z.strictObject({
    mcp: z.strictObject({
      transport: z.literal("stdio"),
      command: z.literal("npm run mcp"),
    }),
    http: z.strictObject({
      base_url: loopbackHttpUrlSchema,
      tool_manifest_path: z.literal("/api/control-plane/tool-manifest"),
      tool_manifest_contract: z.literal(DIRECTOR_TOOL_MANIFEST_CONTRACT),
      tool_path_template: z.literal("/api/tools/{tool}"),
      auth: z.literal(
        "Loopback process token in X-Director-Browser-Token; bootstrap via POST /te-man/director/agent/bootstrap",
      ),
    }),
  }),
  skills: z.array(a2aAgentSkillSchema).min(1),
});

export type DirectorA2aAgentCard = z.infer<typeof directorA2aAgentCardSchema>;

/** The Director tools published as A2A-style skills, with card-facing names and tags. */
const A2A_SKILL_TOOLS = [
  { tool: "director_workbench", name: "3D Stage authoring and evidence", tags: ["3d-stage", "authoring", "evidence"] },
  {
    tool: "director_creative",
    name: "Canvas and Video Editor operations",
    tags: ["canvas", "video-editor", "interchange", "collaboration"],
  },
  { tool: "blender_native", name: "Blender native bridge", tags: ["blender", "dcc"] },
  { tool: "stage_video", name: "Video generation jobs", tags: ["video-generation", "jobs"] },
] as const;

/**
 * Builds the discovery-only agent card decided by ADR 0004.
 *
 * Skills are derived from the same tool-manifest builder that reflects the
 * execution schemas, so the card cannot drift from the registry. The gateway
 * base URL comes from the validated control-plane config, which already
 * refuses non-loopback binds.
 */
export function buildDirectorA2aAgentCard(gatewayBaseUrl: string): DirectorA2aAgentCard {
  const manifestTools = new Map(buildDirectorToolManifest().tools.map((tool) => [tool.name, tool]));
  const skills = A2A_SKILL_TOOLS.map(({ tool, name, tags }) => {
    const entry = manifestTools.get(tool);
    if (!entry?.description || !entry.operations || !entry.http) {
      throw new Error(`Tool manifest no longer describes ${tool}; update the A2A agent card skills.`);
    }
    return {
      id: tool,
      name,
      description: entry.description,
      tags: [...tags],
      operations: entry.operations,
      http: entry.http,
    };
  });

  return directorA2aAgentCardSchema.parse({
    contract: DIRECTOR_A2A_AGENT_CARD_CONTRACT,
    discovery_only: true,
    name: "Director",
    description:
      "Agent-native 3D film production workbench: Stage, Canvas, Video Editor, Blender handoff, and generation jobs behind one typed gateway.",
    url: gatewayBaseUrl,
    a2a: {
      jsonrpc_endpoint: null,
      decision: "ADR 0004: no live A2A runtime; discover here, execute over MCP or Director HTTP",
    },
    capabilities: { streaming: false, push_notifications: false, state_transition_history: false },
    interfaces: {
      mcp: { transport: "stdio", command: "npm run mcp" },
      http: {
        base_url: gatewayBaseUrl,
        tool_manifest_path: "/api/control-plane/tool-manifest",
        tool_manifest_contract: DIRECTOR_TOOL_MANIFEST_CONTRACT,
        tool_path_template: "/api/tools/{tool}",
        auth: "Loopback process token in X-Director-Browser-Token; bootstrap via POST /te-man/director/agent/bootstrap",
      },
    },
    skills,
  });
}
