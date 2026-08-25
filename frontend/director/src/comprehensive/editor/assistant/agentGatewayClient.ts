import type {
  DirectorAgentBootstrap,
  DirectorAssistantChatResponse,
  DirectorAssistantCommandResult,
  DirectorAssistantConfirmation,
  DirectorPageEvent,
} from "./assistantProtocol";
import {
  directorAgentBootstrapWireSchema,
  directorAgentHealthWireSchema,
  directorAssistantChatWireSchema,
  directorAssistantConfirmationTokenWireSchema,
  directorPageEventsWireSchema,
  gatewayErrorWireSchema,
  type DirectorAgentHealthWire,
  type DirectorAssistantCommandWire,
} from "../../../../../../packages/protocol/src/agentGatewayProtocol";

const AGENT_ROUTE_SUFFIX = "/te-man/director/agent";
const AGENT_SERVICE = "comfyui-3d-director-agent-gateway";
let bootstrap: DirectorAgentBootstrap | null = null;
let bootstrapPromise: Promise<DirectorAgentBootstrap> | null = null;
let tabId: string | null = null;

/**
 * Error thrown by the Agent Gateway client when an HTTP request fails with
 * a structured error body from the gateway.
 */
export class DirectorAgentClientError extends Error {
  status: number;
  code?: string;
  body?: unknown;

  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.name = "DirectorAgentClientError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function requestId() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `director-${Date.now()}-${Math.random().toString(16).slice(2).padEnd(16, "0")}`;
}

/**
 * Get or create the stable browser-tab identity used to correlate
 * Agent Gateway page events and presence signals across page reloads.
 */
export function getDirectorAgentTabId() {
  tabId ??= `tab-${requestId()}`;
  return tabId;
}

/** Resolve ComfyUI's optional reverse-proxy base path without a Vite proxy. */
export function getDirectorAgentBasePath(pathname = window.location.pathname) {
  const marker = "/extensions/";
  const markerIndex = pathname.indexOf(marker);
  const basePath = markerIndex >= 0 ? pathname.slice(0, markerIndex) : "";
  return `${basePath}${AGENT_ROUTE_SUFFIX}`.replace(/\/{2,}/g, "/");
}

async function jsonRequest(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${getDirectorAgentBasePath()}${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      // Observability (M5): attribute browser-issued calls to the UI surface.
      "X-Director-Trace-Source": "ui",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(bootstrap?.browserToken ? { "X-Director-Browser-Token": bootstrap.browserToken } : {}),
      ...init.headers,
    },
  });
  const body: unknown = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function throwResponse(status: number, body: unknown) {
  const parsed = gatewayErrorWireSchema.safeParse(body);
  const failure = parsed.success ? parsed.data : {};
  const code = failure.code || failure.error;
  const safeFailureMessages: Record<string, string> = {
    codex_failed: "Codex 规划进程失败",
    codex_invalid_json: "Codex 没有返回有效的结构化计划",
    codex_missing: "未找到 Codex CLI",
    codex_not_logged_in: "Codex CLI 尚未登录",
    codex_output_limit: "Codex 输出过长",
    codex_timeout: "Codex 规划超时",
    codex_unavailable: "无法确认 Codex CLI 登录状态",
    invalid_schema: "请求格式不正确",
    revision_conflict: "规划后场景 revision 已变化，命令未执行",
  };
  const message =
    code && safeFailureMessages[code]
      ? `${safeFailureMessages[code]}（${code}，HTTP ${status}）`
      : `${failure.message || failure.error || "Agent Gateway 请求失败"}${code ? `（${code}，HTTP ${status}）` : `（HTTP ${status}）`}`;
  throw new DirectorAgentClientError(message, status, code, body);
}

function normalizeHealth(
  browserToken: string,
  health: DirectorAgentHealthWire,
  detail?: string,
): DirectorAgentBootstrap {
  const gatewayReady = health?.gateway?.status === "ready";
  const comfyStatus = health?.comfyui?.status;
  const codexStatus = health?.codex?.status;
  return {
    browserToken,
    service: AGENT_SERVICE,
    gateway: gatewayReady ? "connected" : "disconnected",
    mcp: gatewayReady ? "connected" : "disconnected",
    comfyui: comfyStatus === "connected" ? "connected" : "disconnected",
    codex:
      codexStatus === "ready"
        ? "ready"
        : codexStatus === "missing"
          ? "missing"
          : codexStatus === "not_logged_in"
            ? "not-logged-in"
            : codexStatus === "error"
              ? "unavailable"
              : "unknown",
    ...(health.gateway.epoch ? { epoch: health.gateway.epoch } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Bootstrap the Agent Gateway connection, establishing a browser token
 * and detecting the availability of backend services (gateway, ComfyUI,
 * Codex CLI). The result is cached in memory for the lifetime of the tab.
 *
 * @returns The bootstrap result with service statuses and a browser token.
 */
export async function bootstrapDirectorAgent(): Promise<DirectorAgentBootstrap> {
  if (bootstrap) return bootstrap;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const { status, body } = await jsonRequest("/bootstrap", { method: "POST", body: "{}" });
    if (status < 200 || status >= 300) throwResponse(status, body);
    const parsed = directorAgentBootstrapWireSchema.safeParse(body);
    if (!parsed.success)
      throw new DirectorAgentClientError("Agent Gateway bootstrap response is invalid", 502, undefined, body);
    bootstrap = normalizeHealth(parsed.data.browserToken, parsed.data.health);
    return bootstrap;
  })();
  try {
    return await bootstrapPromise;
  } finally {
    bootstrapPromise = null;
  }
}

function resetDirectorAgentCredentials() {
  bootstrap = null;
  bootstrapPromise = null;
}

/** Authenticated local-gateway fetch with one credential-rotation retry. */
export async function directorAgentFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  retryUnauthorized = true,
): Promise<Response> {
  const current = await bootstrapDirectorAgent();
  const headers = new Headers(init.headers);
  headers.set("X-Director-Browser-Token", current.browserToken);
  headers.set("X-Director-Trace-Source", "ui");
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 && retryUnauthorized) {
    resetDirectorAgentCredentials();
    return directorAgentFetch(input, init, false);
  }
  return response;
}

/**
 * Refresh the gateway health check and re-derive service availability.
 * On auth failure, clears credentials and re-bootstraps.
 *
 * @returns The updated bootstrap result with current service statuses.
 */
export async function getDirectorAgentHealth(): Promise<DirectorAgentBootstrap> {
  if (!bootstrap) return bootstrapDirectorAgent();
  const { status, body } = await jsonRequest("/health");
  if (status === 401 || status === 403) {
    bootstrap = null;
    bootstrapPromise = null;
    return bootstrapDirectorAgent();
  }
  if (status < 200 || status >= 300) throwResponse(status, body);
  const parsed = directorAgentHealthWireSchema.safeParse(body);
  if (!parsed.success)
    throw new DirectorAgentClientError("Agent Gateway health response is invalid", 502, undefined, body);
  bootstrap = normalizeHealth(bootstrap.browserToken, parsed.data);
  return bootstrap;
}

function commandStatus(value: DirectorAssistantCommandWire["status"]): DirectorAssistantCommandResult["status"] {
  if (value === "success") return "applied";
  if (value === "conflict") return "conflict";
  if (value === "confirmation_required") return "confirmation_required";
  return "rejected";
}

function normalizeCommand(request: string, raw: DirectorAssistantCommandWire) {
  const index = raw.index;
  const name = raw.tool;
  const revision = raw.revision;
  const status = commandStatus(raw.status);
  const ok = status === "applied";
  return {
    id: `${request}:${index}`,
    name,
    ok,
    revision,
    status,
    ...(ok
      ? { summary: "已通过统一 Director 服务执行" }
      : {
          error: raw.error?.message ?? "命令执行失败",
        }),
  } satisfies DirectorAssistantCommandResult;
}

function requiredConfirmation(command: DirectorAssistantCommandWire | undefined) {
  const payload = command?.error?.requiredConfirmation;
  if (!payload) return null;
  return "requiredConfirmation" in payload ? payload.requiredConfirmation : payload;
}

function normalizeChat(raw: ReturnType<typeof directorAssistantChatWireSchema.parse>): DirectorAssistantChatResponse {
  const commands = raw.commands.map((value) => normalizeCommand(raw.requestId, value));
  const pending = raw.pendingPlan;
  const pendingCommand = pending ? raw.commands.find((value) => value.index === pending.nextCommandIndex) : undefined;
  const required = requiredConfirmation(pendingCommand);
  const confirmation: DirectorAssistantConfirmation | undefined =
    pending && required
      ? {
          ...required,
          pendingPlanId: pending.id,
          summary: `确认 ${pendingCommand?.tool || pending.tool || required.action}：${required.objectIds.join("、")}`,
          ...(pending.expiresAt ? { expiresAt: pending.expiresAt } : {}),
        }
      : undefined;
  return {
    requestId: raw.requestId,
    sceneId: raw.sceneId,
    revision: raw.endingRevision,
    message: raw.summary,
    commands,
    status: raw.status,
    ...(confirmation ? { confirmation } : {}),
  };
}

async function chatRequest(path: "/chat" | "/execute", body: Record<string, unknown>) {
  if (!bootstrap) await bootstrapDirectorAgent();
  const { status, body: responseBody } = await jsonRequest(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const parsed = directorAssistantChatWireSchema.safeParse(responseBody);
  if (parsed.success) return normalizeChat(parsed.data);
  if (status < 200 || status >= 300) throwResponse(status, responseBody);
  throw new DirectorAgentClientError("Agent Gateway chat response is invalid", status, undefined, responseBody);
}

/**
 * Send a natural-language message to the Director Agent and receive a
 * structured chat response with command results, pending plan, and
 * any required confirmation details.
 *
 * @param input - The scene id, expected revision, and message text.
 * @returns The structured chat response from the agent gateway.
 */
export async function sendDirectorAssistantMessage(input: {
  sceneId: string;
  expectedRevision: number;
  message: string;
}): Promise<DirectorAssistantChatResponse> {
  return chatRequest("/chat", {
    requestId: requestId(),
    sceneId: input.sceneId,
    tabId: getDirectorAgentTabId(),
    expectedRevision: input.expectedRevision,
    message: input.message.trim().slice(0, 8_000),
  });
}

/**
 * Approve a pending confirmation and execute the associated plan step.
 * First obtains a confirmation token from the gateway, then proceeds
 * with the execution request.
 *
 * @param input - The confirmation object from a prior chat response.
 * @returns The structured chat response after executing the approved step.
 */
export async function approveDirectorAssistantCommand(input: {
  confirmation: DirectorAssistantConfirmation;
}): Promise<DirectorAssistantChatResponse> {
  if (!bootstrap) await bootstrapDirectorAgent();
  const { status, body } = await jsonRequest("/confirmations", {
    method: "POST",
    body: JSON.stringify({
      sceneId: input.confirmation.sceneId,
      expectedRevision: input.confirmation.revision,
      action: input.confirmation.action,
      objectIds: input.confirmation.objectIds,
    }),
  });
  if (status < 200 || status >= 300) throwResponse(status, body);
  const parsed = directorAssistantConfirmationTokenWireSchema.safeParse(body);
  if (!parsed.success)
    throw new DirectorAgentClientError("Confirmation service did not issue a token", 502, undefined, body);
  return chatRequest("/execute", {
    requestId: requestId(),
    pendingPlanId: input.confirmation.pendingPlanId,
    sceneId: input.confirmation.sceneId,
    expectedRevision: input.confirmation.revision,
    confirmationToken: parsed.data.confirmationToken,
  });
}

/**
 * Publish or withdraw the tab's presence for a scene so the agent
 * gateway knows which browser tabs are available for page-state sync.
 *
 * @param input - The scene id, revision, and visibility flag.
 */
export async function publishDirectorAgentPresence(input: { sceneId: string; revision: number; visible: boolean }) {
  if (!bootstrap) await bootstrapDirectorAgent();
  const { status, body } = await jsonRequest("/presence", {
    method: "POST",
    body: JSON.stringify({ ...input, tabId: getDirectorAgentTabId() }),
  });
  if (status < 200 || status >= 300) throwResponse(status, body);
}

/**
 * Poll the agent gateway for page events (selection, viewport, playback
 * state) that originated from other tabs or agents. Uses an epoch cursor
 * to return only new events since the last poll.
 *
 * @param input - The scene id, cursor after-sequence, and optional epoch.
 * @returns The current epoch string and any new page events.
 */
export async function getDirectorPageEvents(input: {
  sceneId: string;
  after: number;
  epoch?: string;
}): Promise<{ epoch: string; events: DirectorPageEvent[] }> {
  if (!bootstrap) await bootstrapDirectorAgent();
  const query = new URLSearchParams({
    sceneId: input.sceneId,
    tabId: getDirectorAgentTabId(),
    after: String(input.after),
  });
  if (input.epoch) query.set("epoch", input.epoch);
  const { status, body } = await jsonRequest(`/page-events?${query}`);
  if (status < 200 || status >= 300) throwResponse(status, body);
  const parsed = directorPageEventsWireSchema.safeParse(body);
  if (!parsed.success) throw new DirectorAgentClientError("Page event response is invalid", 502, undefined, body);
  return {
    epoch: parsed.data.epoch,
    events: parsed.data.events,
  };
}

/** Clear all cached credentials and tab identity for the Agent Gateway client. */
export function clearDirectorAgentClient() {
  resetDirectorAgentCredentials();
  tabId = null;
}
