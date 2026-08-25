import type { IncomingMessage, ServerResponse } from "node:http";
import { isFilmRoleId, type FilmRoleId } from "../../../packages/protocol/src/filmRoles";
import { asRecord as record } from "../../../packages/protocol/src/primitives";
import {
  isAgentToolSource,
  recordAgentToolAuditSafely,
  type AgentToolAuditStore,
  type AgentToolSource,
} from "../agentToolAuditStore";
import { DEFAULT_CONFIRM_TOKEN_TTL_MS, type AgentConfirmTokenStore } from "../agentConfirmTokenStore";
import { directorToolPolicyRejection, filmRoleFromEnvironment } from "./filmRoleToolPolicy";

/** Request header carrying the caller's Director film role. */
export const DIRECTOR_FILM_ROLE_HEADER = "x-director-film-role";
/** Request header tagging the tool entry point (`ui | mcp | http | cli`). */
export const DIRECTOR_TOOL_SOURCE_HEADER = "x-director-tool-source";
/** Request header carrying a single-use confirm token for a destructive operation. */
export const DIRECTOR_CONFIRM_TOKEN_HEADER = "x-director-confirm-token";

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
  /** Single-use confirm tokens for destructive/publish operations. */
  confirmTokens?: AgentConfirmTokenStore;
};

/** The outcome of evaluating the shared film-role/plan-mode policy for one HTTP tool call. */
export type HttpToolGovernanceDecision =
  | { allowed: true; roleId: FilmRoleId | null; source: AgentToolSource }
  | {
      allowed: false;
      status: 400 | 403;
      roleId: FilmRoleId | null;
      source: AgentToolSource;
      body: { success: false; code: string; error: string; confirm?: Record<string, unknown> };
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
 * Resolves the effective Director film role for one HTTP request, first match
 * wins: the `x-director-film-role` header when it names a valid film role (an
 * invalid header fails closed), then the injected `filmRoleId` dependency,
 * then the gateway's `DIRECTOR_FILM_ROLE` environment. An unset role stays
 * unrestricted (`null`).
 *
 * Shared by the tool governance evaluation and the confirm-token issuer so a
 * token is always bound to the same role the eventual tool call resolves.
 */
export function resolveHttpFilmRole(
  request: IncomingMessage,
  dependencies?: Pick<HttpToolGovernanceDependencies, "filmRoleId">,
): { ok: true; roleId: FilmRoleId | null } | { ok: false; error: string } {
  const headerRole = headerValue(request, DIRECTOR_FILM_ROLE_HEADER);
  if (headerRole !== undefined) {
    if (!isFilmRoleId(headerRole)) return { ok: false, error: `Unknown Director film role: ${headerRole}` };
    return { ok: true, roleId: headerRole };
  }
  if (dependencies?.filmRoleId !== undefined) return { ok: true, roleId: dependencies.filmRoleId };
  try {
    return { ok: true, roleId: filmRoleFromEnvironment(process.env.DIRECTOR_FILM_ROLE) };
  } catch (error) {
    // A malformed environment role fails closed instead of silently running unrestricted.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
  const resolvedRole = resolveHttpFilmRole(input.request, input.dependencies);
  if (!resolvedRole.ok) {
    return {
      allowed: false,
      status: 400,
      roleId: null,
      source,
      body: { success: false, code: "invalid_film_role", error: resolvedRole.error },
    };
  }
  const roleId = resolvedRole.roleId;
  const planMode = input.dependencies?.planMode ?? process.env.DIRECTOR_PLAN_MODE?.trim() === "1";
  const rejection = directorToolPolicyRejection(roleId, planMode, input.tool, input.toolInput);
  if (rejection) return { allowed: false, status: 403, roleId, source, body: rejection };
  return { allowed: true, roleId, source };
}

/**
 * Closed list of destructive / publish tool operations that require explicit
 * confirmation on every non-UI entry point (HTTP, MCP, CLI).
 *
 * Keys are `<tool>` → confirmable operation keys as produced by
 * {@link confirmableToolOperation}. Operations whose protocol schema already
 * carries a `confirm: true` literal (interchange import, collaboration
 * restore/delete, gallery purge) are satisfied by that literal; `deliver` and
 * interchange `export` have no protocol literal, so they always need a
 * gateway-issued `confirm_token`.
 */
export const CONFIRMABLE_TOOL_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  director_workbench: ["deliver"],
  director_creative: [
    "interchange.export",
    "interchange.import",
    "collaboration.restore-version",
    "collaboration.delete-version",
    "collaboration.delete-comment",
    "gallery.media.purge",
  ],
};

const CONFIRMABLE_COLLABORATION_ACTIONS = new Set(["restore-version", "delete-version", "delete-comment"]);
const CONFIRMABLE_INTERCHANGE_ACTIONS = new Set(["export", "import"]);

function executeBatchSteps(values: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!Array.isArray(values?.steps)) return [];
  return values.steps.map((step) => record(record(step)?.operation)).filter((step): step is Record<string, unknown> => Boolean(step));
}

/**
 * Returns the confirmable operation key for a tool input when it is on the
 * closed destructive/publish list, or `null` for every other operation.
 *
 * @param tool - The tool name from the route path.
 * @param input - The effective tool input (before strict schema validation).
 */
export function confirmableToolOperation(tool: string, input: unknown): string | null {
  const values = record(input);
  const operation = typeof values?.op === "string" ? values.op : "";
  if (tool === "director_workbench") return operation === "deliver" ? "deliver" : null;
  if (tool !== "director_creative") return null;
  if (operation === "interchange" || operation === "collaboration") {
    const action = record(values?.request)?.action;
    if (typeof action !== "string") return null;
    if (operation === "interchange" && CONFIRMABLE_INTERCHANGE_ACTIONS.has(action)) return `interchange.${action}`;
    if (operation === "collaboration" && CONFIRMABLE_COLLABORATION_ACTIONS.has(action)) {
      return `collaboration.${action}`;
    }
    return null;
  }
  if (operation === "execute") {
    return record(values?.operation)?.op === "gallery.media.purge" ? "gallery.media.purge" : null;
  }
  if (operation === "execute_batch") {
    return executeBatchSteps(values).some((step) => step.op === "gallery.media.purge")
      ? "gallery.media.purge"
      : null;
  }
  return null;
}

/**
 * Returns whether the tool input already carries the protocol-level
 * `confirm: true` literal for its confirmable operation. Existing UI modals
 * (import, restore-version, delete-version, delete-comment, gallery purge)
 * pass this literal today and stay valid without a token.
 */
export function toolInputCarriesProtocolConfirm(tool: string, input: unknown, operation: string): boolean {
  if (tool !== "director_creative") return false;
  const values = record(input);
  if (operation.startsWith("interchange.") || operation.startsWith("collaboration.")) {
    if (operation === "interchange.export") return false; // export has no protocol confirm literal
    return record(values?.request)?.confirm === true;
  }
  if (operation !== "gallery.media.purge") return false;
  if (values?.op === "execute") return record(values.operation)?.confirm === true;
  const purgeSteps = executeBatchSteps(values).filter((step) => step.op === "gallery.media.purge");
  return purgeSteps.length > 0 && purgeSteps.every((step) => step.confirm === true);
}

/** The confirmation-rejection subtype of {@link HttpToolGovernanceDecision}. */
export type HttpToolConfirmationRejection = Extract<HttpToolGovernanceDecision, { allowed: false }>;

/**
 * Applies the shared confirmation boundary to one admitted tool call, after
 * the role/plan policy allowed it (policy stays first — a role that cannot
 * execute the operation is rejected before any token is looked at).
 *
 * A destructive/publish operation from the closed
 * {@link CONFIRMABLE_TOOL_OPERATIONS} list executes only when the input
 * carries its protocol `confirm: true` literal, or the caller presents a
 * valid single-use gateway-issued `confirm_token` (top-level body field or
 * `x-director-confirm-token` header) bound to the same tool + operation +
 * role + session. Everything else returns `null` (no confirmation needed).
 *
 * The rejection body uses the stable code `confirm_required` and includes a
 * `confirm` payload describing how to obtain a token and retry. The call is
 * never executed on rejection.
 *
 * @returns `null` when the call may proceed, or a 403 rejection to write.
 */
export async function evaluateHttpToolConfirmation(input: {
  request: IncomingMessage;
  tool: string;
  toolInput: unknown;
  roleId: FilmRoleId | null;
  source: AgentToolSource;
  sessionId?: string;
  /** Top-level `confirm_token` envelope field, when the transport carries one. */
  confirmToken?: string;
  dependencies?: HttpToolGovernanceDependencies;
}): Promise<HttpToolConfirmationRejection | null> {
  const operation = confirmableToolOperation(input.tool, input.toolInput);
  if (!operation) return null;
  if (toolInputCarriesProtocolConfirm(input.tool, input.toolInput, operation)) return null;
  const binding = {
    tool: input.tool,
    operation,
    role: input.roleId,
    sessionId: input.sessionId ?? null,
  };
  const token = input.confirmToken ?? headerValue(input.request, DIRECTOR_CONFIRM_TOKEN_HEADER);
  const store = input.dependencies?.confirmTokens;
  let refusal = "no confirm token was provided";
  if (token && store) {
    const consumed = await store.consume(token, binding);
    if (consumed.ok) return null;
    refusal = `the confirm token was refused (${consumed.reason})`;
  } else if (token) {
    refusal = "this gateway has no confirm-token store configured";
  }
  const ttlMs = store?.ttlMs ?? DEFAULT_CONFIRM_TOKEN_TTL_MS;
  return {
    allowed: false,
    status: 403,
    roleId: input.roleId,
    source: input.source,
    body: {
      success: false,
      code: "confirm_required",
      error: `${input.tool} ${operation} is a destructive/publish operation and requires explicit confirmation; ${refusal}. The call was not executed.`,
      confirm: {
        tool: input.tool,
        operation,
        issue_endpoint: "POST /api/agent/confirm-token",
        issue_body: {
          tool: input.tool,
          operation,
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
        },
        retry_with: "confirm_token (top-level request body field) or the x-director-confirm-token header",
        token_ttl_ms: ttlMs,
        single_use: true,
        ...(toolSupportsProtocolConfirm(operation)
          ? { protocol_confirm: "This operation also accepts the protocol-level confirm: true field on its request." }
          : {}),
      },
    },
  };
}

function toolSupportsProtocolConfirm(operation: string) {
  return operation !== "deliver" && operation !== "interchange.export";
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
