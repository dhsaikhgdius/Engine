import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { AgentConfirmTokenStore } from "../agentConfirmTokenStore";
import {
  CONFIRMABLE_TOOL_OPERATIONS,
  resolveHttpFilmRole,
  type HttpToolGovernanceDependencies,
} from "../agents/httpToolGovernance";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies injected into the confirm-token route handler. */
export type AgentConfirmTokenRouteDependencies = {
  /** Reads the JSON request body from the incoming HTTP message. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The single-use confirm-token store shared with the tool routes. */
  store: AgentConfirmTokenStore;
  /** Optional film-role override for tests; production uses header/env. */
  governance?: Pick<HttpToolGovernanceDependencies, "filmRoleId">;
};

const confirmTokenRequestSchema = z.strictObject({
  /** The tool the destructive call will target, e.g. `director_workbench`. */
  tool: z.string().trim().min(1).max(120),
  /** The confirmable operation key, e.g. `deliver` or `interchange.export`. */
  operation: z.string().trim().min(1).max(200),
  /** The session id the destructive call will carry, when any. */
  session_id: z.string().trim().min(1).max(160).optional(),
});

/**
 * Handles `POST /api/agent/confirm-token`: issues one short-lived single-use
 * confirm token for a destructive/publish operation on the closed
 * {@link CONFIRMABLE_TOOL_OPERATIONS} list.
 *
 * The token is bound to tool + operation + role + session. The role resolves
 * exactly like the tool routes (`x-director-film-role` header, then
 * `DIRECTOR_FILM_ROLE`, else unrestricted), so a token can never confirm a
 * call under a different role. Issuance does not bypass the role policy: the
 * tool call itself still checks `filmRoleToolPolicy` first.
 *
 * The path sits under `/api/`, so the shared gateway authorization in
 * `requiresDirectorGatewayAuth` already guards it.
 *
 * @returns `true` when the request was handled, `false` otherwise.
 */
export async function handleAgentConfirmTokenRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: AgentConfirmTokenRouteDependencies,
): Promise<boolean> {
  if (url.pathname !== "/api/agent/confirm-token") return false;
  const { readBody, json, store } = dependencies;
  if (request.method !== "POST") {
    json(response, 405, { success: false, error: "Confirm tokens are issued with POST." });
    return true;
  }
  const parsed = confirmTokenRequestSchema.safeParse(await readBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    json(response, 400, {
      success: false,
      code: "invalid_confirm_token_request",
      error: `Invalid confirm-token request at ${issue?.path.map(String).join(".") || "$"}: ${issue?.message ?? "invalid value"}`,
    });
    return true;
  }
  const confirmable = CONFIRMABLE_TOOL_OPERATIONS[parsed.data.tool];
  if (!confirmable?.includes(parsed.data.operation)) {
    json(response, 400, {
      success: false,
      code: "not_confirmable",
      error: `${parsed.data.tool} ${parsed.data.operation} is not on the destructive/publish confirmation list.`,
      confirmable_operations: CONFIRMABLE_TOOL_OPERATIONS,
    });
    return true;
  }
  const resolvedRole = resolveHttpFilmRole(request, dependencies.governance);
  if (!resolvedRole.ok) {
    json(response, 400, { success: false, code: "invalid_film_role", error: resolvedRole.error });
    return true;
  }
  const issued = await store.issue({
    tool: parsed.data.tool,
    operation: parsed.data.operation,
    role: resolvedRole.roleId,
    sessionId: parsed.data.session_id ?? null,
  });
  json(response, 201, {
    success: true,
    result: {
      confirm_token: issued.token,
      expires_at: issued.expiresAt,
      ttl_ms: issued.ttlMs,
      single_use: true,
      tool: parsed.data.tool,
      operation: parsed.data.operation,
      role: resolvedRole.roleId,
      ...(parsed.data.session_id ? { session_id: parsed.data.session_id } : {}),
    },
  });
  return true;
}
