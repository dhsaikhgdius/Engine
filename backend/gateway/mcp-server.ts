import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  creativeWorkspaceAgentOperationNames,
  creativeWorkspaceAgentRequestSchema,
} from "../../packages/protocol/src/creativeWorkspaceProtocol";
import { directorWorkbenchOperationNames, directorWorkbenchOperationSchema } from "@director/agent-engine";
import type { StageGatewayExecution } from "@director/agent-engine";
import { parseStageScene } from "@director/stage-protocol";
import {
  AGENT_TOOL_NAMES,
  STAGE_COMMAND_TOOL_NAMES,
  type AgentToolName,
  type StageCommandToolName,
} from "../../packages/protocol/src/agentTools";
import {
  directorAgentTargetWireSchema,
  sameDirectorAgentTarget,
  type DirectorAgentTargetWire,
} from "../../packages/protocol/src/agentGatewayProtocol";
import {
  createMcpToolResponse,
  mcpToolStructuredOutputSchema,
  stripEncodedMediaFromSerializedView,
} from "./mcpToolResponse";
import { directorDccOperationSchema } from "@director/dcc-protocol";
import { blenderNativeToolRequestSchema } from "../../packages/protocol/src/blenderLiveProtocol";
import {
  productionEvidenceRequestSchema,
  type ProductionEvidenceRequest,
} from "../../packages/protocol/src/productionArtifactProtocol";
import { filmPipelineOperationSchema } from "../../packages/protocol/src/filmPipelineProtocol";
import { videoModelOperationSchema } from "../../packages/protocol/src/videoGenerationProtocol";
import { directorToolPolicyRejection, filmRoleFromEnvironment, roleCanSeeTool } from "./agents/filmRoleToolPolicy";
import {
  createAgentToolSessionMemory,
  injectCachedWorkbenchRevision,
  isStaleRevisionResult,
  rememberDirectorAgentToolCall,
} from "./agents/agentToolMemory";
import { compactWireSchema, DIRECTOR_AGENT_WIRE_SCHEMAS, dynamicToolTimeoutMs } from "./agents/agentToolRegistry";

const gatewayUrl = process.env.STAGE_GATEWAY_URL ?? "http://127.0.0.1:8787";
const sessionId = process.env.DIRECTOR_MCP_SESSION_ID?.trim() || `mcp-${process.pid}-${crypto.randomUUID()}`;
const configuredGatewayToken = process.env.DIRECTOR_GATEWAY_TOKEN?.trim() || "";
if (configuredGatewayToken && configuredGatewayToken.length < 24) {
  console.warn(
    "DIRECTOR_GATEWAY_TOKEN is shorter than the recommended 24 characters; using it for gateway authentication anyway.",
  );
}
let gatewayAuthToken = configuredGatewayToken;
const filmRoleId = filmRoleFromEnvironment(process.env.DIRECTOR_FILM_ROLE);

/**
 * Returns the gateway authentication token. On first call, if no token was
 * configured via the environment, bootstraps one from the gateway's bootstrap
 * endpoint. The token is cached for the lifetime of this process.
 */
async function getGatewayAuthToken() {
  if (gatewayAuthToken) return gatewayAuthToken;
  const response = await fetch(`${gatewayUrl}/te-man/director/agent/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = (await response.json()) as unknown;
  const parsed = z.looseObject({ browserToken: z.string().min(24) }).safeParse(payload);
  if (!response.ok || !parsed.success)
    throw new Error("Director gateway bootstrap did not return an authorization token.");
  gatewayAuthToken = parsed.data.browserToken;
  return gatewayAuthToken;
}

/**
 * Authenticated fetch to the Director gateway. Retries once with a fresh
 * bootstrap token when the gateway returns 401.
 *
 * @param path - The gateway API path (e.g. `/api/tools/director_workbench`).
 * @param init - Standard fetch options.
 * @param retryUnauthorized - Whether to retry on 401 (default true).
 */
async function authenticatedGatewayFetch(path: string, init: RequestInit, retryUnauthorized = true) {
  const token = await getGatewayAuthToken();
  const headers = new Headers(init.headers);
  headers.set("x-director-browser-token", token);
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl}${path}`, { ...init, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      response = await fetch(`${gatewayUrl}${path}`, { ...init, headers });
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(
        `Director gateway request to ${gatewayUrl}${path} failed: ${retryMessage || message}. Start npm run dev and reload the Director tab if this persists.`,
      );
    }
  }
  if (response.status === 401 && retryUnauthorized) {
    gatewayAuthToken = "";
    return authenticatedGatewayFetch(path, init, false);
  }
  return response;
}

const server = new McpServer({
  name: "director-agent-native-stage",
  version: "0.1.0",
  websiteUrl: "http://127.0.0.1:5175",
});

/**
 * Returns a policy-rejection tool response when the film role is not allowed
 * to use the given tool, or `null` when the tool is permitted.
 */
function readAgentSessionPlanMode() {
  return process.env.DIRECTOR_PLAN_MODE?.trim() === "1";
}

async function policyRejectedToolResponse(tool: string, input: unknown) {
  const rejection = directorToolPolicyRejection(filmRoleId, readAgentSessionPlanMode(), tool, input);
  if (!rejection) return null;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(rejection) }],
    isError: true,
  };
}

/**
 * Registers an MCP tool only if the current film role is allowed to see it.
 * When the role cannot see the tool, the `register` callback is never called.
 */
function registerVisibleTool(tool: string, register: () => void) {
  if (roleCanSeeTool(filmRoleId, tool)) register();
}

/** Full-contract validation with a single readable issue instead of a raw ZodError dump. */
function parseToolInput<Schema extends z.ZodType>(schema: Schema, input: unknown, tool: string): z.infer<Schema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? issue.path.map(String).join(".") : "input";
  throw new Error(`${tool} input is invalid: ${path} ${issue?.message ?? "is malformed"}`);
}

/**
 * MCP uses compact operation envelopes. The full strict
 * schemas remain the execution boundary and `describe` exposes exact fields on
 * demand without resending every operation union on every model round.
 */
const wireSchemas = {
  ...DIRECTOR_AGENT_WIRE_SCHEMAS,
  director_production: compactWireSchema(
    productionEvidenceRequestSchema,
    "Operation. capabilities explains the evidence contract; versions and approvals are immutable; promote is optimistic-concurrency guarded.",
  ),
  director_film: compactWireSchema(
    filmPipelineOperationSchema,
    "Operation. create starts a durable run (minutes to hours); poll with status; resume continues from the last durable artifact.",
  ),
  director_dcc: compactWireSchema(
    directorDccOperationSchema,
    "Operation. Call discover first to see provider readiness, formats, and capability maturity.",
  ),
};

const directorDccOutputSchema = z.strictObject({
  ok: z.boolean(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
});

const directorProductionOutputSchema = z.strictObject({
  ok: z.boolean(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
});

// Stage command tools (stage_read/stage_scene/stage_object/stage_camera/stage_show)
// stay executable over the gateway HTTP compatibility routes but are no longer
// advertised to models, so only the typed tool surface keeps a description here.
const descriptions: Record<Exclude<AgentToolName, StageCommandToolName>, string> = {
  director_workbench: [
    `Control Director's 3D scene, objects, characters, cameras, production scenes, timeline, storyboard, capture, and UI. Ops: ${directorWorkbenchOperationNames.join(", ")}.`,
    'describe returns the exact JSON Schema of one operation or author action on demand (target "<op>" or "author.<action>").',
    "Use catalog or a selective observe only when you need current IDs or state, then send one direct authoring operation.",
    "Reuse catalog IDs and URLs exactly. Do not assemble scenes from geometry_type primitives; instance catalog meshes, model with blender_native, or generate with generated_3d.",
    "After an edit, one targeted inspect is enough when confirmation is useful. Use audit, correct, trace, capture, or deliver only when the user asks for diagnosis or an output artifact.",
  ].join(" "),
  director_creative: `Control the live Director Canvas, multimodal generation graph, Video Editor, interchange export, and collaboration comments. Use capabilities or observe when current IDs are needed, then execute one direct operation or batch. Pipeline actions are start, status, and cancel; interchange uses plan-export followed by export. Preview and audit are optional diagnostics, not required steps. Edit operations: ${creativeWorkspaceAgentOperationNames.join(", ")}.`,
  stage_video:
    "Discover providers and prepare, submit, inspect, or cancel durable image-to-video jobs from the current validated 3D white-box scene. Ops: capabilities, prepare, render, submit, status, cancel. LTX-2.3 uses the isolated Python GPU worker; ComfyUI remains an optional workflow provider; minimax-h3 renders through the hosted MiniMax H3 multimodal API.",
  blender_native:
    'Operate Blender\'s native modeling and rig surface. Use typed apply directly; call scene when object IDs are unknown. Search CC0 assets with {"op":"polyhaven_search"} then apply polyhaven_import. Sketchfab needs SKETCHFAB_API_TOKEN. Describe typed apply ops with {"op":"describe","target":"create_primitive"} when a field is unknown. catalog/describe with operator discover Blender RNA for invoke_operator. execute_code runs Python when a typed op or operator is not enough. Native stills use {"op":"capture"} or {"op":"capture_render"}. Do not quit Blender. Missing scene epoch, revision, and intent id are filled by the gateway. inspect and capture are optional checks. status, scene, catalog, describe, inspect, capture, capture_render, polyhaven_search, and sketchfab_search are read-only.',
};

function targetDescriptorFromEnvironment(): DirectorAgentTargetWire | undefined {
  const source = process.env.DIRECTOR_TARGET_DESCRIPTOR?.trim();
  if (!source) return undefined;
  try {
    const parsed = directorAgentTargetWireSchema.safeParse(JSON.parse(source));
    if (parsed.success) return parsed.data;
  } catch {
    // The explicit target token below remains usable when the optional descriptor is malformed.
  }
  console.warn("DIRECTOR_TARGET_DESCRIPTOR is invalid; exact target comparison is unavailable.");
  return undefined;
}

const configuredTargetToken = process.env.DIRECTOR_TARGET_TOKEN?.trim() || undefined;
const configuredTarget = targetDescriptorFromEnvironment();
const hasExplicitTargetBinding = Boolean(configuredTargetToken || configuredTarget);
let boundTarget = configuredTarget;
let boundTargetToken: string | undefined = configuredTargetToken ?? configuredTarget?.token;
const toolMemory = createAgentToolSessionMemory();

/**
 * Calls the Director gateway for a tool execution. Handles target tracking,
 * revision injection for guarded workbench writes, stale-revision retry, and
 * scene parsing.
 *
 * @param tool - The agent tool name.
 * @param input - The tool input payload.
 * @returns The gateway execution result with the parsed scene.
 */
async function callGateway(tool: AgentToolName, input: Record<string, unknown>): Promise<StageGatewayExecution> {
  const prepared = injectCachedWorkbenchRevision(tool, input, toolMemory);
  const effectiveInput = prepared.input;
  const response = await authenticatedGatewayFetch(`/api/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: effectiveInput,
      session_id: sessionId,
      ...(boundTargetToken ? { target_token: boundTargetToken } : {}),
    }),
    signal: AbortSignal.timeout(dynamicToolTimeoutMs(tool, effectiveInput)),
  });
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Gateway returned malformed JSON for ${tool}`);
  }
  const record = payload as Record<string, unknown>;
  const parsedTarget = directorAgentTargetWireSchema.safeParse(record.target);
  if (parsedTarget.success) {
    if (boundTarget && !sameDirectorAgentTarget(boundTarget, parsedTarget.data)) {
      throw new Error("Director tool response came from a different browser target and was discarded");
    }
    boundTarget = parsedTarget.data;
    boundTargetToken = parsedTarget.data.token;
  } else if (record.target !== undefined) {
    const issueSummary = parsedTarget.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    console.warn(
      `Director gateway returned a target that failed strict validation; target tracking falls back to discovery: ${issueSummary}`,
    );
  }
  if (record.code === "target_unavailable" && !hasExplicitTargetBinding) {
    boundTarget = undefined;
    boundTargetToken = undefined;
  }
  if (prepared.injectedRevision && isStaleRevisionResult(record)) {
    toolMemory.lastWorkbenchRevision = undefined;
    return callGateway(tool, input);
  }
  rememberDirectorAgentToolCall(toolMemory, tool, effectiveInput, record);
  const parsedScene = parseStageScene(record.scene);
  if (!parsedScene.success || typeof record.success !== "boolean") {
    const gatewayError =
      typeof record.error === "string"
        ? record.error
        : parsedScene.success
          ? "missing success flag"
          : parsedScene.error;
    throw new Error(`Gateway returned an invalid tool response: ${gatewayError}`);
  }
  const result = { ...record, scene: parsedScene.scene } as StageGatewayExecution;
  if (!response.ok && !result.error) result.error = `Gateway returned HTTP ${response.status}`;
  return result;
}

const stageCommandTools = new Set<AgentToolName>(STAGE_COMMAND_TOOL_NAMES);

for (const tool of AGENT_TOOL_NAMES.filter(
  (name): name is Exclude<AgentToolName, StageCommandToolName | "blender_native"> =>
    name !== "blender_native" && !stageCommandTools.has(name) && roleCanSeeTool(filmRoleId, name),
)) {
  server.registerTool(
    tool,
    {
      title:
        tool === "director_workbench"
          ? "Director Workbench"
          : tool === "director_creative"
            ? "Director Canvas & Video"
            : "Stage video",
      description: descriptions[tool],
      inputSchema:
        tool === "director_workbench"
          ? wireSchemas.director_workbench
          : tool === "director_creative"
            ? wireSchemas.director_creative
            : wireSchemas.stage_video,
      outputSchema: mcpToolStructuredOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: Record<string, unknown>) => {
      const rejection = await policyRejectedToolResponse(tool, input);
      if (rejection) return rejection;
      try {
        const result = await callGateway(tool, input as Record<string, unknown>);
        return createMcpToolResponse(result, tool);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Director Stage gateway is unavailable at ${gatewayUrl}. Start it with \"npm run gateway\" or \"npm run dev\". ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

registerVisibleTool("blender_native", () => {
  server.registerTool(
    "blender_native",
    {
      title: "Blender Native Scene",
      description: descriptions.blender_native,
      inputSchema: wireSchemas.blender_native,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const rejection = await policyRejectedToolResponse("blender_native", input);
      if (rejection) return rejection;
      try {
        const response = await authenticatedGatewayFetch("/api/tools/blender_native", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, session_id: sessionId }),
          signal: AbortSignal.timeout(dynamicToolTimeoutMs("blender_native", input)),
        });
        const payload = (await response.json()) as Record<string, unknown>;
        const capture =
          payload.capture && typeof payload.capture === "object" && !Array.isArray(payload.capture)
            ? (payload.capture as Record<string, unknown>)
            : null;
        const imageData =
          typeof capture?.dataBase64 === "string"
            ? capture.dataBase64
            : typeof capture?.data === "string"
              ? capture.data
              : null;
        const mimeType = typeof capture?.mimeType === "string" ? capture.mimeType : null;
        // Capture bytes travel only in the MCP image block below; the
        // serialized text/structured JSON keeps capture metadata without the base64 payload.
        const serializedPayload = stripEncodedMediaFromSerializedView(payload) as Record<string, unknown>;
        const content: Array<
          | { type: "text"; text: string }
          | {
              type: "image";
              data: string;
              mimeType: string;
              annotations: { audience: ["assistant"]; priority: number };
            }
        > = [{ type: "text", text: JSON.stringify(serializedPayload) }];
        if (imageData && mimeType) {
          content.push({
            type: "image",
            data: imageData,
            mimeType,
            annotations: { audience: ["assistant"], priority: 1 },
          });
        }
        return {
          content,
          structuredContent: serializedPayload,
          isError: !response.ok || payload.success === false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Blender native session is unavailable. ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
});

async function callProductionEvidence(input: ProductionEvidenceRequest): Promise<unknown> {
  if (input.op === "capabilities") {
    return {
      contract: "director-production-evidence-v1",
      operations: [
        "capabilities",
        "list_versions",
        "get_version",
        "put_version",
        "put_approval",
        "promote",
        "current_promotion",
      ],
      invariants: [
        "artifact versions and approvals are immutable",
        "promotion is append-only and optimistic-concurrency guarded",
        "promotion_id is required and binds exact retries to one immutable promotion request",
        "fingerprint-bound approvals become stale when observed evidence changes",
      ],
    };
  }

  let path: string;
  let init: RequestInit;
  switch (input.op) {
    case "list_versions": {
      const query = input.artifact_id ? `?artifact_id=${encodeURIComponent(input.artifact_id)}` : "";
      path = `/api/production/artifact-versions${query}`;
      init = { method: "GET" };
      break;
    }
    case "get_version":
      path = `/api/production/artifact-versions/${encodeURIComponent(input.version_id)}`;
      init = { method: "GET" };
      break;
    case "put_version":
      path = "/api/production/artifact-versions";
      init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: input.version }),
      };
      break;
    case "put_approval":
      path = "/api/production/approvals";
      init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approval: input.approval }),
      };
      break;
    case "promote":
      path = "/api/production/promotions";
      init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          promotionId: input.promotion_id,
          target: input.target,
          versionId: input.version_id,
          expectedPreviousVersionId: input.expected_previous_version_id,
          approvalIds: input.approval_ids,
          observedFingerprints: input.observed_fingerprints,
          promotedBy: input.promoted_by,
          requireCurrentApproval: input.require_current_approval,
        }),
      };
      break;
    case "current_promotion": {
      const query = new URLSearchParams({
        workspace: input.target.workspace,
        owner_id: input.target.ownerId,
        slot: input.target.slot,
      });
      path = `/api/production/promotions/current?${query.toString()}`;
      init = { method: "GET" };
      break;
    }
  }

  const response = await authenticatedGatewayFetch(path, init);
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const parsed = z.looseObject({ message: z.string().optional(), code: z.string().optional() }).safeParse(payload);
    throw new Error(
      parsed.success
        ? `${parsed.data.code ?? `http_${response.status}`}: ${parsed.data.message ?? "Production evidence request failed"}`
        : `Production evidence request failed with HTTP ${response.status}`,
    );
  }
  return payload;
}

registerVisibleTool("director_production", () => {
  server.registerTool(
    "director_production",
    {
      title: "Director Production Evidence",
      description:
        "Create, inspect, and promote artifact versions into Canvas, Stage, Video, or delivery. Use approvals only when the user explicitly requests a review workflow.",
      inputSchema: wireSchemas.director_production,
      outputSchema: directorProductionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const rejection = await policyRejectedToolResponse("director_production", input);
      if (rejection) return rejection;
      try {
        const result = await callProductionEvidence(
          parseToolInput(productionEvidenceRequestSchema, input, "director_production"),
        );
        const structuredContent = { ok: true, result, error: null };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        const structuredContent = {
          ok: false,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
          isError: true,
        };
      }
    },
  );
});

registerVisibleTool("director_film", () => {
  server.registerTool(
    "director_film",
    {
      title: "Director Film Pipeline",
      description:
        "Run the agentic film production pipeline: idea-to-film or script-to-film. create starts a durable run (story, characters, storyboard, shot specs, camera plan, character portraits, first/last keyframes, per-shot video clips, dialogue TTS mix, final assembly plus an OTIO timeline for the Video Editor). Runs take minutes to hours; poll with status and read run.events for progress. Set input.reviewGate=true to pause after planning, then approve to spend render budget. input.autoStageAnchors=true captures white-box Stage anchors per shot from the connected Director tab automatically; input.stageReferences binds captures manually; input.characterReferences pins character identity images; input.enableAudio=false skips dialogue synthesis. resume continues a failed or cancelled run from its last durable artifact.",
      inputSchema: wireSchemas.director_film,
      outputSchema: directorProductionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const rejection = await policyRejectedToolResponse("director_film", input);
      if (rejection) return rejection;
      try {
        const operation = parseToolInput(filmPipelineOperationSchema, input, "director_film");
        let path = "/api/film/runs";
        let init: RequestInit = { method: "GET" };
        if (operation.op === "create") {
          init = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workflow: operation.workflow, input: operation.input }),
          };
        } else if (operation.op === "status") {
          path = `/api/film/runs/${encodeURIComponent(operation.id)}`;
        } else if (operation.op !== "list") {
          path = `/api/film/runs/${encodeURIComponent(operation.id)}/${operation.op}`;
          init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
        }
        const response = await authenticatedGatewayFetch(path, init);
        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          const parsed = z
            .looseObject({ error: z.string().optional(), code: z.string().optional() })
            .safeParse(payload);
          throw new Error(
            parsed.success
              ? `${parsed.data.code ?? `http_${response.status}`}: ${parsed.data.error ?? "Film pipeline request failed"}`
              : `Film pipeline request failed with HTTP ${response.status}`,
          );
        }
        const structuredContent = { ok: true, result: payload, error: null };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        const structuredContent = {
          ok: false,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
          isError: true,
        };
      }
    },
  );
});

registerVisibleTool("director_dcc", () => {
  server.registerTool(
    "director_dcc",
    {
      title: "Director DCC Bridge",
      description:
        "Discover and operate Director DCC providers. Call discover first: it reports nativeReady/exchangeReady, supported formats, and capability maturity for Blender, Maya, Unreal, Houdini, Cinema 4D, Unity, 3ds Max, Godot, and registered third-party providers. export_exchange_package creates a canonical metre/Y-up/stable-ID USD/GLB package without overstating native readiness. Blender additionally retains its revision-guarded export, raw-scene preview/apply, and stable-ID return workflow.",
      inputSchema: wireSchemas.director_dcc,
      outputSchema: directorDccOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const rejection = await policyRejectedToolResponse("director_dcc", input);
      if (rejection) return rejection;
      try {
        const parsedInput = parseToolInput(directorDccOperationSchema, input, "director_dcc");
        const response = await authenticatedGatewayFetch("/api/tools/director_dcc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: parsedInput, session_id: sessionId }),
        });
        const payload = (await response.json()) as unknown;
        const parsedPayload = z
          .looseObject({ success: z.boolean(), result: z.unknown().optional(), error: z.string().optional() })
          .safeParse(payload);
        if (!parsedPayload.success) throw new Error("Gateway returned malformed DCC JSON.");
        const structuredContent = {
          ok: parsedPayload.data.success,
          result: parsedPayload.data.result ?? null,
          error: parsedPayload.data.error ?? null,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
          isError: !structuredContent.ok,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Director DCC gateway is unavailable at ${gatewayUrl}. Start it with "npm run gateway" or "npm run dev". ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
});

await server.connect(new StdioServerTransport());
