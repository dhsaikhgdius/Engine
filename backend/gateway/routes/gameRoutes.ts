import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  directorGameOperationSchema,
  type DirectorGameEnvelope,
  type DirectorGameOperation,
} from "../../../packages/protocol/src/directorGameProtocol";
import {
  evaluateHttpToolGovernance,
  recordRejectedHttpToolCall,
  withHttpToolAudit,
  type HttpToolGovernanceDependencies,
} from "../agents/httpToolGovernance";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

const envelopeSchema = z.looseObject({
  input: z.unknown().optional(),
  session_id: z.string().trim().min(1).max(160).optional(),
});

/** Dependencies injected into the `director_game` route handler. */
export type GameRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  /** Executes one validated operation against the durable slice store. */
  execute: (operation: DirectorGameOperation) => Promise<DirectorGameEnvelope>;
  /** Film-role/plan-mode policy overrides plus the audit trail for POST /api/tools. */
  governance?: HttpToolGovernanceDependencies;
};

/**
 * Maps machine envelopes to HTTP status. Rejections keep the machine's
 * `code`/`error`/`corrective_call` untouched; only the status is derived.
 */
function statusForEnvelope(envelope: DirectorGameEnvelope): number {
  if (envelope.success) return 200;
  if (envelope.code === "invalid_request" || envelope.code === "unknown_describe_target") return 400;
  if (envelope.code === "game_slice_not_found") return 404;
  return 409;
}

/**
 * Governed HTTP surface for the `director_game` harness tool. Validation and
 * the film-role/plan-mode policy run before any store work; slice semantics
 * stay in the shared host-free machine (`executeDirectorGame`).
 */
export async function handleGameRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: GameRouteDependencies,
): Promise<boolean> {
  const { readBody, execute } = dependencies;
  // Reassigned with an audit-recording wrapper once a governed tool call is admitted.
  let json = dependencies.json;
  if (request.method !== "POST" || url.pathname !== "/api/tools/director_game") return false;

  const body = envelopeSchema.safeParse(await readBody(request));
  if (!body.success) {
    json(response, 400, { success: false, error: "director_game request body must be a JSON object." });
    return true;
  }
  const { input: wrappedInput, session_id: sessionId, ...directInput } = body.data;
  const input = Object.prototype.hasOwnProperty.call(body.data, "input") ? wrappedInput : directInput;
  const parsed = directorGameOperationSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    json(response, 400, {
      success: false,
      error: `Invalid director_game input at ${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid value"}`,
    });
    return true;
  }
  // Same film-role and plan-mode policy as MCP, checked before any slice work.
  const governance = evaluateHttpToolGovernance({
    request,
    tool: "director_game",
    toolInput: parsed.data,
    sessionId,
    dependencies: dependencies.governance,
  });
  const auditContext = {
    store: dependencies.governance?.auditStore,
    tool: "director_game",
    toolInput: parsed.data,
    roleId: governance.roleId,
    source: governance.source,
    sessionId,
  };
  if (!governance.allowed) {
    recordRejectedHttpToolCall(governance, auditContext);
    json(response, governance.status, governance.body);
    return true;
  }
  json = withHttpToolAudit(json, auditContext);
  try {
    const envelope = await execute(parsed.data);
    json(response, statusForEnvelope(envelope), envelope);
  } catch (error) {
    json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
