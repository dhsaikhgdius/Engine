import type { IncomingMessage, ServerResponse } from "node:http";
import { agentToolAuditEntrySchema, type AgentToolAuditStore } from "../agentToolAuditStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies injected into the agent tool audit route handler. */
export type AgentToolAuditRouteDependencies = {
  /** Reads the JSON request body from the incoming HTTP message. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The unified tool-invocation audit trail. */
  store: AgentToolAuditStore;
};

const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 200;

function parseListLimit(raw: string | null) {
  if (!raw?.trim()) return DEFAULT_LIST_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(value, MAX_LIST_LIMIT);
}

/**
 * Handles `/api/agent/tool-audit`: `GET` lists redacted audit records
 * (optionally filtered by `session_id`, newest `limit` entries, oldest
 * first), and `POST` ingests one record from a trusted authenticated caller
 * (the Director UI tags `source: "ui"` for store-dispatched authoring).
 *
 * The path sits under `/api/`, so the shared gateway authorization in
 * `requiresDirectorGatewayAuth` already guards it. Records are validated
 * against the redacted audit schema; raw tool inputs are never accepted.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The audit route dependencies.
 * @returns `true` when the request was handled, `false` otherwise.
 */
export async function handleAgentToolAuditRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: AgentToolAuditRouteDependencies,
): Promise<boolean> {
  if (url.pathname !== "/api/agent/tool-audit") return false;
  const { readBody, json, store } = dependencies;

  if (request.method === "GET") {
    const sessionId = url.searchParams.get("session_id")?.trim() || undefined;
    const records = await store.list({ sessionId, limit: parseListLimit(url.searchParams.get("limit")) });
    json(response, 200, { success: true, result: { records } });
    return true;
  }

  if (request.method === "POST") {
    const parsed = agentToolAuditEntrySchema.safeParse(await readBody(request));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      json(response, 400, {
        success: false,
        code: "invalid_audit_record",
        error: `Invalid tool audit record at ${issue?.path.map(String).join(".") || "$"}: ${issue?.message ?? "invalid value"}`,
      });
      return true;
    }
    const record = await store.record(parsed.data);
    json(response, 201, { success: true, result: { id: record.id } });
    return true;
  }

  json(response, 405, { success: false, error: "Agent tool audit requires GET or POST." });
  return true;
}
