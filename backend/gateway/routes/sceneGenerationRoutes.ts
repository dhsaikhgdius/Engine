import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ModelProvider } from "@director/model-provider";
import { runScenePipeline, summarizePipelineOutput } from "@director/scene-pipeline";
import {
  evaluateHttpToolGovernance,
  recordRejectedHttpToolCall,
  withHttpToolAudit,
  type HttpToolGovernanceDependencies,
} from "../agents/httpToolGovernance";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies required by the scene generation route handler. */
export type SceneGenerationRouteDependencies = {
  /** Parses the request body into a JSON-compatible value. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** Resolves a provider identifier to a model provider. */
  resolveProvider: (providerId: string) => Promise<ModelProvider>;
  /** Film-role/plan-mode policy overrides plus the audit trail for POST /api/tools. */
  governance?: HttpToolGovernanceDependencies;
};

const generateSceneRequestSchema = z.strictObject({
  prompt: z.string().min(1).max(2000),
  style: z.enum(["modern", "classic", "minimalist", "industrial", "natural"]).optional(),
  room: z
    .strictObject({
      width: z.number().positive().max(100),
      depth: z.number().positive().max(100),
      height: z.number().positive().max(20),
    })
    .optional(),
  cameraCount: z.number().int().positive().max(10).optional(),
  constraints: z.array(z.string().max(200)).max(10).optional(),
  providerId: z.string().optional(),
  summary: z.boolean().optional(),
  session_id: z.string().trim().min(1).max(160).optional(),
});

/**
 * Handles the POST /api/tools/generate_scene route.
 *
 * Validates the scene generation request, resolves the model provider,
 * runs the scene pipeline, and returns the layout or summary.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param deps - The route dependencies.
 * @returns True if the route was handled, false otherwise.
 */
export async function handleSceneGenerationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: SceneGenerationRouteDependencies,
) {
  if (url.pathname !== "/api/tools/generate_scene") return false;
  if (request.method !== "POST") {
    deps.json(response, 405, { error: "Method not allowed" });
    return true;
  }
  let body: unknown;
  try {
    body = await deps.readBody(request);
  } catch {
    deps.json(response, 400, { error: "Invalid request body" });
    return true;
  }
  const parsed = generateSceneRequestSchema.safeParse(body);
  if (!parsed.success) {
    deps.json(response, 400, {
      error: "Invalid input",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return true;
  }
  const input = parsed.data;
  // Same film-role and plan-mode policy as MCP, checked before the pipeline runs.
  const governance = evaluateHttpToolGovernance({
    request,
    tool: "generate_scene",
    toolInput: input,
    sessionId: input.session_id,
    dependencies: deps.governance,
  });
  const auditContext = {
    store: deps.governance?.auditStore,
    tool: "generate_scene",
    toolInput: input,
    roleId: governance.roleId,
    source: governance.source,
    sessionId: input.session_id,
  };
  if (!governance.allowed) {
    recordRejectedHttpToolCall(governance, auditContext);
    deps.json(response, governance.status, governance.body);
    return true;
  }
  const json = withHttpToolAudit(deps.json, auditContext);
  const providerId = input.providerId ?? "deepseek";
  let provider: ModelProvider;
  try {
    provider = await deps.resolveProvider(providerId);
  } catch (err) {
    json(response, 503, {
      error: `Model provider "${providerId}" is not available`,
      detail: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
  try {
    const output = await runScenePipeline(provider, {
      prompt: input.prompt,
      style: input.style,
      room: input.room,
      cameraCount: input.cameraCount,
      constraints: input.constraints,
    });
    json(response, 200, {
      success: true,
      layout: input.summary ? undefined : output.layout,
      summary: input.summary ? summarizePipelineOutput(output) : undefined,
      warnings: output.warnings,
      timing: output.timing,
    });
    return true;
  } catch (err) {
    json(response, 500, {
      error: "Scene generation failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
