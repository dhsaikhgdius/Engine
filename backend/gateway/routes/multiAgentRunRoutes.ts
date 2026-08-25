import type { IncomingMessage, ServerResponse } from "node:http";
import { createProductionRunRequestSchema } from "@director/agent-engine";
import { safeParseDirectorProject } from "@director/project-schema";
import type { DirectorAgentTargetWire } from "../../../packages/protocol/src/agentGatewayProtocol";
import { filmRoleRequiresToolLoop } from "../agents/filmRoleToolPolicy";
import { AgentProfileRegistry } from "../agents/agentProfileRegistry";
import { MultiAgentRunStore } from "../multiAgent/multiAgentRunStore";
import { ProductionRunOrchestrator } from "../multiAgent/productionRunOrchestrator";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies required by the multi-agent run route handler. */
export type MultiAgentRunRouteDependencies = {
  /** Parses the request body into a JSON-compatible value. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The multi-agent run store for persistence. */
  store: MultiAgentRunStore;
  /** The orchestrator that manages production run lifecycles. */
  orchestrator: ProductionRunOrchestrator;
  /** Registry of available agent profiles. */
  profiles: AgentProfileRegistry;
  /** Checks whether a Director target is currently available. */
  isTargetAvailable: (target: DirectorAgentTargetWire) => boolean;
};

/**
 * Handles HTTP routes for multi-agent production runs.
 *
 * Routes:
 * - `GET /api/agent/runs` — list all production runs.
 * - `POST /api/agent/runs` — create a new production run.
 * - `GET /api/agent/runs/:id` — get a single run.
 * - `POST /api/agent/runs/:id/cancel` — cancel a run.
 * - `POST /api/agent/runs/:id/resume` — resume a paused run.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The route dependencies.
 * @returns True if the route was handled, false otherwise.
 */
export async function handleMultiAgentRunRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: MultiAgentRunRouteDependencies,
) {
  const { readBody, json, store, orchestrator, profiles, isTargetAvailable } = dependencies;
  if (request.method === "GET" && url.pathname === "/api/agent/runs") {
    json(response, 200, { runs: await store.list() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/runs") {
    const parsed = createProductionRunRequestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "Production run 参数无效", code: "invalid_request" });
      return true;
    }
    if (parsed.data.provider !== "api") {
      json(response, 409, {
        error: `${parsed.data.provider} profiles run through DeepSeek Harness; Production run 需要 hosted API Profile`,
        code: "provider_unsupported",
        provider: parsed.data.provider,
      });
      return true;
    }
    const profileByRole = orchestrator.resolveRoleProfiles(parsed.data);
    for (const [roleId, profileId] of Object.entries(profileByRole)) {
      if (!profileId) continue;
      const profile = profiles.get(profileId);
      if (!profile || profile.provider !== parsed.data.provider || !profile.public.available) {
        json(response, 409, {
          error: `${roleId} 的 Production run Profile（${profileId}）不可用或 runtime 不匹配`,
          code: "profile_unavailable",
          roleId,
          profileId,
        });
        return true;
      }
    }
    for (const roleId of Object.keys(profileByRole)) {
      if (!filmRoleRequiresToolLoop(roleId)) continue;
      json(response, 409, {
        error: `${roleId} 需要 Director Workbench 工具循环；hosted Production run 目前只能执行 observe-only 角色`,
        code: "hosted_tools_unavailable",
        roleId,
      });
      return true;
    }
    if (!isTargetAvailable(parsed.data.target)) {
      json(response, 409, { error: "Production run 的 Director target 不可用", code: "target_unavailable" });
      return true;
    }
    const project = parsed.data.project === undefined ? undefined : safeParseDirectorProject(parsed.data.project);
    if (project && !project.success) {
      json(response, 400, { error: project.error, code: "invalid_project" });
      return true;
    }
    const run = await orchestrator.create(parsed.data, project?.project);
    json(response, 202, { run });
    return true;
  }
  const match = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)(?:\/(resume|cancel))?$/);
  if (!match) return false;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    json(response, 400, { error: "Production run id 编码无效", code: "invalid_run_id" });
    return true;
  }
  const action = match[2];
  const run = await store.get(id);
  if (!run) {
    json(response, 404, { error: "Production run 不存在", code: "run_not_found" });
    return true;
  }
  if (request.method === "GET" && !action) {
    json(response, 200, { run });
    return true;
  }
  if (request.method === "POST" && action === "cancel") {
    json(response, 200, { run: await orchestrator.cancel(id) });
    return true;
  }
  if (request.method === "POST" && action === "resume") {
    json(response, 202, { run: await orchestrator.resume(id) });
    return true;
  }
  return false;
}
