import type { IncomingMessage, ServerResponse } from "node:http";
import { isFilmRoleId, type FilmRoleId } from "../../../packages/protocol/src/filmRoles";
import { asRecord as record } from "../../../packages/protocol/src/primitives";
import {
  isAgentToolSource,
  recordAgentToolAuditSafely,
  type AgentToolAuditStore,
  type AgentToolSource,
} from "../agentToolAuditStore";
import { directorToolPolicyRejection, filmRoleFromEnvironment } from "./filmRoleToolPolicy";

/** Request header carrying the caller's Director film role. */
export const DIRECTOR_FILM_ROLE_HEADER = "x-director-film-role";
/** Request header tagging the tool entry point (`ui | mcp | http | cli`). */
export const DIRECTOR_TOOL_SOURCE_HEADER = "x-director-tool-source";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/**
 * Optional governance overrides injected on route dependencies so unit tests
 * do not mutate `process.env` globally. When a field is omitted, the request
 * header and gateway environment remain the production defaults.
 */
export type HttpToolGovernanceDependencies = {
  /** Film role override. `null` means explicitly unrestricted; omit to use header/env. */
  filmRoleId?: FilmRoleId | null;
  /** Plan-mode override; omit to read `DIRECTOR_PLAN_MODE` from the environment. */
  planMode?: boolean;
  /** Unified tool-invocation audit trail. Omit to skip audit writes. */
  auditStore?: AgentToolAuditStore;
};

/** The outcome of evaluating the shared film-role/plan-mode policy for one HTTP tool call. */
export type HttpToolGovernanceDecision =
  | { allowed: true; roleId: FilmRoleId | null; source: AgentToolSource }
  | {
      allowed: false;
      status: 400 | 403;
      roleId: FilmRoleId | null;
      source: AgentToolSource;
      body: { success: false; code: string; error: string };
    };

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

/**
 * Resolves the audit source tag for one HTTP tool call: the
 * `x-director-tool-source` header when valid, otherwise inferred from the
 * caller session id (`mcp-`/`dsh-` → mcp, `cli-` → cli), defaulting to `http`.
 *
 * @param request - The incoming HTTP request.
 * @param sessionId - The caller-supplied session id, when any.
 */
export function resolveHttpToolSource(request: IncomingMessage, sessionId?: string): AgentToolSource {
  const header = headerValue(request, DIRECTOR_TOOL_SOURCE_HEADER)?.toLowerCase();
  if (header && isAgentToolSource(header)) return header;
  if (sessionId?.startsWith("mcp-") || sessionId?.startsWith("dsh-")) return "mcp";
  if (sessionId?.startsWith("cli-")) return "cli";
  return "http";
}

/**
 * Applies the shared `filmRoleToolPolicy` to one raw `POST /api/tools/*`
 * call so HTTP and CLI callers obey the same governance as MCP and the
 * hosted harnesses.
 *
 * Role resolution, first match wins: the `x-director-film-role` header when
 * it names a valid film role (an invalid header fails closed with 400), then
 * the injected `filmRoleId` dependency, then the gateway's
 * `DIRECTOR_FILM_ROLE` environment. An unset role stays unrestricted.
 *
 * @param input.request - The incoming HTTP request.
 * @param input.tool - The tool name from the route path.
 * @param input.toolInput - The effective tool input (after envelope unwrap).
 * @param input.sessionId - The caller-supplied session id, when any.
 * @param input.dependencies - Optional injected governance overrides.
 * @returns The decision: allowed, or a 400/403 rejection body to write.
 */
export function evaluateHttpToolGovernance(input: {
  request: IncomingMessage;
  tool: string;
  toolInput: unknown;
  sessionId?: string;
  dependencies?: HttpToolGovernanceDependencies;
}): HttpToolGovernanceDecision {
  const source = resolveHttpToolSource(input.request, input.sessionId);
  const headerRole = headerValue(input.request, DIRECTOR_FILM_ROLE_HEADER);
  let roleId: FilmRoleId | null;
  if (headerRole !== undefined) {
    if (!isFilmRoleId(headerRole)) {
      return {
        allowed: false,
        status: 400,
        roleId: null,
        source,
        body: {
          success: false,
          code: "invalid_film_role",
          error: `Unknown Director film role: ${headerRole}`,
        },
      };
    }
    roleId = headerRole;
  } else if (input.dependencies?.filmRoleId !== undefined) {
    roleId = input.dependencies.filmRoleId;
  } else {
    try {
      roleId = filmRoleFromEnvironment(process.env.DIRECTOR_FILM_ROLE);
    } catch (error) {
      // A malformed environment role fails closed instead of silently running unrestricted.
      return {
        allowed: false,
        status: 400,
        roleId: null,
        source,
        body: {
          success: false,
          code: "invalid_film_role",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  const planMode = input.dependencies?.planMode ?? process.env.DIRECTOR_PLAN_MODE?.trim() === "1";
  const rejection = directorToolPolicyRejection(roleId, planMode, input.tool, input.toolInput);
  if (rejection) return { allowed: false, status: 403, roleId, source, body: rejection };
  return { allowed: true, roleId, source };
}

/**
 * Derives the audit `operation` for a tool input: `input.op`, suffixed with a
 * nested `request.action` or `command.action` when present.
 *
 * @param input - The effective tool input.
 */
export function auditOperationForToolInput(input: unknown): string | undefined {
  const values = record(input);
  const operation = typeof values?.op === "string" && values.op.trim() ? values.op : undefined;
  if (!operation) return undefined;
  const nestedAction = [record(values?.request)?.action, record(values?.command)?.action].find(
    (action): action is string => typeof action === "string" && Boolean(action.trim()),
  );
  return nestedAction ? `${operation}.${nestedAction}` : operation;
}

function auditIdempotencyKeyForToolInput(input: unknown): string | undefined {
  const values = record(input);
  const direct = values?.idempotency_key;
  if (typeof direct === "string" && direct.trim()) return direct;
  const nested = [record(values?.request)?.idempotency_key, record(values?.command)?.idempotency_key].find(
    (key): key is string => typeof key === "string" && Boolean(key.trim()),
  );
  return nested;
}

function auditRevision(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * Extracts revision-before/after evidence from a tool response body when the
 * result carries one (workbench project/production revisions or Blender
 * native receipts). Unknown revisions are omitted, never invented.
 */
function auditRevisionsFromResponse(body: unknown): {
  revision_before?: string | number;
  revision_after?: string | number;
} {
  const root = record(body);
  const result = record(root?.result);
  const receipt = record(result?.receipt);
  const before = auditRevision(result?.project_revision_before) ?? auditRevision(receipt?.revisionBefore);
  const after =
    auditRevision(result?.project_revision) ??
    auditRevision(result?.production_revision) ??
    auditRevision(receipt?.revisionAfter);
  return {
    ...(before !== undefined ? { revision_before: before } : {}),
    ...(after !== undefined ? { revision_after: after } : {}),
  };
}

/** Context shared by the audit helpers for one HTTP tool call. */
export type HttpToolAuditContext = {
  store?: AgentToolAuditStore;
  tool: string;
  toolInput: unknown;
  roleId: FilmRoleId | null;
  source: AgentToolSource;
  sessionId?: string;
};

/**
 * Records one policy rejection (or invalid-role failure) on the audit trail.
 * Best-effort: audit failures never affect the HTTP response.
 *
 * @param decision - The rejected governance decision.
 * @param context - The audit context for the call.
 */
export function recordRejectedHttpToolCall(
  decision: Extract<HttpToolGovernanceDecision, { allowed: false }>,
  context: HttpToolAuditContext,
) {
  recordAgentToolAuditSafely(context.store, {
    tool: context.tool,
    ...(auditOperationForToolInput(context.toolInput) !== undefined
      ? { operation: auditOperationForToolInput(context.toolInput) }
      : {}),
    role: decision.roleId,
    source: decision.source,
    outcome: "rejected",
    code: decision.body.code,
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
    ...(auditIdempotencyKeyForToolInput(context.toolInput) !== undefined
      ? { idempotency_key: auditIdempotencyKeyForToolInput(context.toolInput) }
      : {}),
  });
}

/**
 * Wraps a JSON writer so the first terminal response of a governed tool call
 * is recorded on the audit trail with a `success` or `error` outcome derived
 * from the response body. Audit failures never affect the response.
 *
 * @param json - The route's JSON writer.
 * @param context - The audit context for the call.
 * @returns A writer with identical behavior plus best-effort audit recording.
 */
export function withHttpToolAudit(json: JsonWriter, context: HttpToolAuditContext): JsonWriter {
  if (!context.store) return json;
  let recorded = false;
  return (response, status, body) => {
    json(response, status, body);
    if (recorded) return;
    recorded = true;
    const root = record(body);
    const success = status < 400 && root?.success === true;
    const code = typeof root?.code === "string" && root.code.trim() ? root.code : undefined;
    recordAgentToolAuditSafely(context.store, {
      tool: context.tool,
      ...(auditOperationForToolInput(context.toolInput) !== undefined
        ? { operation: auditOperationForToolInput(context.toolInput) }
        : {}),
      role: context.roleId,
      source: context.source,
      outcome: success ? "success" : "error",
      ...(code ? { code } : {}),
      ...(context.sessionId ? { session_id: context.sessionId } : {}),
      ...(auditIdempotencyKeyForToolInput(context.toolInput) !== undefined
        ? { idempotency_key: auditIdempotencyKeyForToolInput(context.toolInput) }
        : {}),
      ...auditRevisionsFromResponse(body),
    });
  };
}
