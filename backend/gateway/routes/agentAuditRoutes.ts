import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { TOOL_INVOCATION_AUDIT_SOURCES, type ToolInvocationAuditStore } from "../agents/toolInvocationAuditStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies injected into the agent audit route handler. */
export type AgentAuditRouteDependencies = {
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The gateway-local tool invocation audit store. */
  store: ToolInvocationAuditStore;
};

const auditQuerySchema = z.strictObject({
  session_id: z.string().trim().min(1).max(160).optional(),
  source: z.enum(TOOL_INVOCATION_AUDIT_SOURCES).optional(),
  tool: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  after: z.string().trim().min(1).max(80).optional(),
});

/**
 * Handles `GET /api/agent/audit` — the unified gateway tool-invocation audit
 * trail. Lives under `/api/`, so the standard gateway authorization
 * (`directorGatewayRequestAuthorized`) is enforced by the dispatcher before
 * this handler runs; there is no unauthenticated audit access.
 *
 * Query parameters: `session_id`, `source`, `tool`, `limit` (default 50,
 * max 200), and an optional `after` record-id cursor for paging older rows.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The audit route dependencies.
 * @returns `true` when the request was handled, `false` otherwise.
 */
export async function handleAgentAuditRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: AgentAuditRouteDependencies,
): Promise<boolean> {
  if (url.pathname !== "/api/agent/audit") return false;
  const { json, store } = dependencies;
  if (request.method !== "GET") {
    json(response, 405, { success: false, error: "The agent audit trail is read-only; use GET." });
    return true;
  }
  const parsed = auditQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    json(response, 400, {
      success: false,
      error: `Invalid audit query at ${issue?.path.map(String).join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
    });
    return true;
  }
  const { records, next_after } = await store.list(parsed.data);
  json(response, 200, { success: true, records, next_after });
  return true;
}
