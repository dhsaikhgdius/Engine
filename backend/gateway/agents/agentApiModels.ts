import { z } from "zod";
import { hostedAgentDriverSchema, MAX_AGENT_API_PROVIDER_MODELS, type HostedAgentDriver } from "@director/agent-engine";
import {
  fetchModelJson,
  ModelDriverHttpError,
  type FetchImplementation,
} from "@director/model-provider/runtime";

const httpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), "must be an HTTP(S) URL");

/** Request body for `POST /api/agent/api-providers/models`. */
export const fetchAgentApiModelsRequestSchema = z.strictObject({
  driver: hostedAgentDriverSchema,
  baseUrl: httpUrlSchema,
  apiKey: z.string().max(4_096).optional(),
  providerId: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .optional(),
});

const MAX_FETCHED_MODELS = MAX_AGENT_API_PROVIDER_MODELS;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Resolves the OpenAI-compatible or Anthropic `/models` URL from a chat base URL.
 *
 * @param baseUrl - Provider root such as `https://api.openai.com/v1`.
 * @returns The models listing endpoint.
 */
export function hostedAgentModelsEndpoint(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/models")) return trimmed;
  if (trimmed.endsWith("/chat/completions")) return trimmed.replace(/\/chat\/completions$/, "/models");
  if (trimmed.endsWith("/messages")) return trimmed.replace(/\/messages$/, "/models");
  return `${trimmed}/models`;
}

function collectModelIds(value: unknown, output: string[]) {
  if (output.length >= MAX_FETCHED_MODELS) return;
  if (typeof value === "string") {
    const model = value.trim();
    if (model) output.push(model);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectModelIds(entry, output);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") {
    collectModelIds(record.id, output);
    return;
  }
  if (Array.isArray(record.data)) collectModelIds(record.data, output);
  else if (Array.isArray(record.models)) collectModelIds(record.models, output);
}

/**
 * Fetches available model ids from a hosted provider's `/models` endpoint.
 *
 * The Gateway makes this call so the browser never talks to the provider
 * directly (CORS) and so secrets stay server-side.
 *
 * @param input.driver - Protocol used to set auth headers.
 * @param input.baseUrl - Provider HTTP root.
 * @param input.apiKey - Optional bearer / x-api-key credential.
 * @param fetchImpl - Injectable fetch for tests.
 * @returns Deduplicated model ids, capped at 128.
 */
export async function fetchHostedAgentModels(
  input: { driver: HostedAgentDriver; baseUrl: string; apiKey?: string },
  fetchImpl: FetchImplementation = fetch,
): Promise<string[]> {
  const apiKey = input.apiKey?.trim() || undefined;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.driver === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  try {
    const payload = await fetchModelJson({
      fetch: fetchImpl,
      url: hostedAgentModelsEndpoint(input.baseUrl),
      init: { method: "GET", headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      providerId: "agent-api-models",
      secrets: [apiKey],
      maxRetries: 1,
    });
    const models: string[] = [];
    collectModelIds(payload, models);
    return [...new Set(models)];
  } catch (error) {
    if (error instanceof ModelDriverHttpError && error.status === 404) {
      throw new Error("该端点没有模型列表，请手动填写模型 ID");
    }
    throw error;
  }
}
