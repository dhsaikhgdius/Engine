import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { MAX_AGENT_API_PROVIDER_MODELS } from "@director/agent-engine";
import {
  AgentApiProviderStore,
  expandAgentApiProvidersToHostedProfiles,
  mergeHostedAgentProfiles,
  saveAgentApiProvidersRequestSchema,
  type StoredAgentApiProvider,
} from "../agents/agentApiProviderStore";
import { fetchAgentApiModelsRequestSchema, fetchHostedAgentModels } from "../agents/agentApiModels";
import type { HostedAgentProfileConfig } from "../controlPlane/controlPlaneConfig";
import { ModelDriverHttpError, ModelDriverResponseError } from "@director/model-provider/runtime";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

export type AgentApiProviderRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  store: AgentApiProviderStore;
  environmentProfiles: readonly HostedAgentProfileConfig[];
  applyHostedProfiles: (profiles: readonly HostedAgentProfileConfig[]) => void;
  fetchModels?: typeof fetchHostedAgentModels;
};

/**
 * Applies user-configured API providers onto the live profile registry and API adapter.
 *
 * @param environmentProfiles - Hosted profiles from the control-plane env config.
 * @param userProviders - Providers persisted by the Agent workspace.
 * @param applyHostedProfiles - Callback that updates registry + harness.
 */
export function applyAgentApiProviders(
  environmentProfiles: readonly HostedAgentProfileConfig[],
  userProviders: readonly StoredAgentApiProvider[],
  applyHostedProfiles: (profiles: readonly HostedAgentProfileConfig[]) => void,
) {
  applyHostedProfiles(
    mergeHostedAgentProfiles(environmentProfiles, expandAgentApiProvidersToHostedProfiles(userProviders)),
  );
}

function publicError(error: unknown) {
  if (error instanceof ModelDriverHttpError || error instanceof ModelDriverResponseError) return error.message;
  if (error instanceof Error) return error.message;
  return "请求失败";
}

function saveProvidersError(error: z.ZodError) {
  if (
    error.issues.some(
      (issue) => issue.path.includes("models") && (issue.code === "too_big" || issue.code === "too_small"),
    )
  ) {
    return `每个提供方至少 1 个、最多 ${MAX_AGENT_API_PROVIDER_MODELS} 个模型`;
  }
  return "API 配置无效";
}

/** Handles `/api/agent/api-providers` configuration and model listing. */
export async function handleAgentApiProviderRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: AgentApiProviderRouteDependencies,
): Promise<boolean> {
  const { readBody, json, store, environmentProfiles, applyHostedProfiles, fetchModels = fetchHostedAgentModels } =
    dependencies;

  if (request.method === "GET" && url.pathname === "/api/agent/api-providers") {
    json(response, 200, { providers: store.listPublic() });
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/api/agent/api-providers") {
    const parsed = saveAgentApiProvidersRequestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: saveProvidersError(parsed.error), code: "invalid_request" });
      return true;
    }
    try {
      const providers = await store.replace(parsed.data.providers);
      applyAgentApiProviders(environmentProfiles, store.list(), applyHostedProfiles);
      json(response, 200, { providers });
    } catch (error) {
      json(response, 400, { error: publicError(error), code: "invalid_request" });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/api-providers/models") {
    const parsed = fetchAgentApiModelsRequestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "拉取模型参数无效", code: "invalid_request" });
      return true;
    }
    const apiKey = parsed.data.apiKey?.trim() || (parsed.data.providerId ? store.getApiKey(parsed.data.providerId) : undefined);
    try {
      const models = await fetchModels({
        driver: parsed.data.driver,
        baseUrl: parsed.data.baseUrl,
        apiKey,
      });
      json(response, 200, { models });
    } catch (error) {
      json(response, 502, { error: publicError(error), code: "models_unavailable" });
    }
    return true;
  }

  return false;
}
