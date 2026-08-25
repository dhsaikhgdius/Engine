import { asRecord } from "@director/protocol/primitives";
import { z } from "zod";

export type DirectorWorkbenchGatewayConfig = {
  gatewayUrl?: string;
  gatewayToken?: string;
  targetToken?: string;
  sessionId?: string;
  omitScene?: boolean;
  fetchImpl?: typeof fetch;
};

export type DirectorWorkbenchGatewayResult = {
  status: number;
  body: Record<string, unknown>;
};

function trimEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function fetchCauseCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("cause" in error)) return "";
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return cause && typeof cause === "object" && typeof cause.code === "string" ? cause.code : "";
}

function isTransientGatewayFetchError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return false;
  const code = fetchCauseCode(error);
  return (
    message === "fetch failed" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

function wrapGatewayFetchError(error: unknown, gatewayUrl: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = fetchCauseCode(error);
  if (code === "ECONNREFUSED") {
    return new Error(
      `Director gateway at ${gatewayUrl} refused the connection. Start the gateway with npm run dev, then retry.`,
    );
  }
  return new Error(
    `Director gateway request to ${gatewayUrl} failed${code ? ` (${code})` : ""}: ${message}. Retry the same call; if it persists, reload the Director tab.`,
  );
}

async function gatewayFetch(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  gatewayUrl: string,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error) {
    if (!isTransientGatewayFetchError(error)) throw wrapGatewayFetchError(error, gatewayUrl);
    try {
      return await fetchImpl(input, init);
    } catch (retryError) {
      throw wrapGatewayFetchError(retryError, gatewayUrl);
    }
  }
}

const gatewayBootstrapSchema = z.looseObject({ browserToken: z.string().min(24) });
const gatewayTokens = new Map<string, string>();

async function bootstrapGatewayToken(gatewayUrl: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const response = await gatewayFetch(
    fetchImpl,
    `${gatewayUrl}/te-man/director/agent/bootstrap`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal,
    },
    gatewayUrl,
  );
  const payload: unknown = await response.json().catch(() => ({}));
  const parsed = gatewayBootstrapSchema.safeParse(payload);
  if (!response.ok || !parsed.success) {
    throw new Error("Director gateway bootstrap did not return an authorization token");
  }
  gatewayTokens.set(gatewayUrl, parsed.data.browserToken);
  return parsed.data.browserToken;
}

async function getGatewayToken(
  gatewayUrl: string,
  config: DirectorWorkbenchGatewayConfig,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
) {
  const cached = gatewayTokens.get(gatewayUrl);
  if (cached) return cached;
  const configured = config.gatewayToken ?? trimEnv(process.env.DIRECTOR_GATEWAY_TOKEN);
  if (configured) {
    gatewayTokens.set(gatewayUrl, configured);
    return configured;
  }
  return bootstrapGatewayToken(gatewayUrl, fetchImpl, signal);
}

/**
 * POSTs one Director domain tool call to the Gateway `/api/tools/:name` surface.
 * DeepSeek Harness owns the loop; this client is the plugin's only Director hop.
 */
export async function dispatchDirectorWorkbenchTool(
  tool: string,
  input: unknown,
  config: DirectorWorkbenchGatewayConfig = {},
  signal?: AbortSignal,
): Promise<DirectorWorkbenchGatewayResult> {
  const gatewayUrl = (config.gatewayUrl ?? trimEnv(process.env.STAGE_GATEWAY_URL) ?? "http://127.0.0.1:8787").replace(
    /\/$/,
    "",
  );
  const targetToken = config.targetToken ?? trimEnv(process.env.DIRECTOR_TARGET_TOKEN);
  const sessionId = config.sessionId ?? trimEnv(process.env.DIRECTOR_AGENT_SESSION_ID);
  if (!sessionId) throw new Error("Director tools require the current DeepSeek Harness session id");
  const omitScene = config.omitScene ?? (tool === "director_workbench" || tool === "director_creative");
  const fetchImpl = config.fetchImpl ?? fetch;
  const body = JSON.stringify({
    input,
    session_id: `dsh-${sessionId}`,
    ...(targetToken ? { target_token: targetToken } : {}),
    ...(omitScene ? { omit_scene: true } : {}),
  });
  const request = (gatewayToken: string) =>
    gatewayFetch(
      fetchImpl,
      `${gatewayUrl}/api/tools/${encodeURIComponent(tool)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-director-browser-token": gatewayToken,
          // DeepSeek Harness is the MCP-style agent entry point; the gateway
          // tags the unified tool audit trail with this source.
          "x-director-tool-source": "mcp",
        },
        body,
        signal,
      },
      gatewayUrl,
    );

  let response = await request(await getGatewayToken(gatewayUrl, config, fetchImpl, signal));
  if (response.status === 401) {
    gatewayTokens.delete(gatewayUrl);
    response = await request(await bootstrapGatewayToken(gatewayUrl, fetchImpl, signal));
  }
  const raw: unknown = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body: asRecord(raw) ?? { success: false, error: "Director tool returned a non-object response" },
  };
}
