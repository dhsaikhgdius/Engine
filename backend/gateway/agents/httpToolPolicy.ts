import { isFilmRoleId, type FilmRoleId } from "../../../packages/protocol/src/filmRoles";
import { directorToolPolicyRejection, filmRoleToolPolicyRejection, roleCanSeeTool } from "./filmRoleToolPolicy";

/**
 * The structured rejection returned at the gateway HTTP tool boundary.
 * The body is byte-identical to the MCP rejection payload so every client
 * (MCP, CLI, DSH plugin, raw HTTP) parses one contract.
 */
export type HttpToolPolicyRejection = {
  status: 403;
  body: {
    success: false;
    code: "tool_policy_rejected" | "plan_mode_blocked";
    error: string;
  };
};

/**
 * The film-role/plan-mode context that governs one gateway tool request.
 *
 * `invalidRole` carries a `DIRECTOR_FILM_ROLE` value that is not a known
 * role id; the boundary fails closed instead of silently running unrestricted.
 */
export type HttpToolPolicyContext = {
  role: FilmRoleId | null;
  planMode: boolean;
  invalidRole?: string;
};

/**
 * Resolves the gateway tool-policy context from the environment.
 *
 * The role source is `DIRECTOR_FILM_ROLE` — the same variable the MCP server
 * reads — and plan mode is `DIRECTOR_PLAN_MODE=1`, matching
 * `readAgentSessionPlanMode` in `backend/gateway/mcp-server.ts`. No
 * request-supplied role field is honoured: an unauthenticated payload field
 * would be spoofable, so the deployment environment stays the only trusted
 * role source at this boundary.
 *
 * @param environment - The environment map (defaults to `process.env`).
 */
export function resolveHttpToolPolicyContext(environment: NodeJS.ProcessEnv = process.env): HttpToolPolicyContext {
  const raw = environment.DIRECTOR_FILM_ROLE?.trim() ?? "";
  const planMode = environment.DIRECTOR_PLAN_MODE?.trim() === "1";
  if (!raw) return { role: null, planMode };
  if (!isFilmRoleId(raw)) return { role: null, planMode, invalidRole: raw };
  return { role: raw, planMode };
}

/**
 * Shared film-role/plan-mode gate for every gateway `/api/tools/*` route.
 *
 * Applies the same `directorToolPolicyRejection` the MCP server uses, so a
 * role that is rejected on MCP is rejected identically over raw HTTP, the
 * Stage CLI, and the DSH plugin (which all POST to these routes). Tools a
 * role cannot see on MCP (`roleCanSeeTool`) are rejected outright, and an
 * unrecognized `DIRECTOR_FILM_ROLE` fails closed.
 *
 * @param tool - The gateway tool name (e.g. `director_workbench`).
 * @param input - The raw tool input payload.
 * @param environment - The environment map (defaults to `process.env`).
 * @returns A 403 rejection with the MCP-shaped body, or `null` when allowed.
 */
export function httpToolPolicyRejection(
  tool: string,
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): HttpToolPolicyRejection | null {
  const context = resolveHttpToolPolicyContext(environment);
  if (context.invalidRole !== undefined) {
    return {
      status: 403,
      body: {
        success: false,
        code: "tool_policy_rejected",
        error: `Unknown Director film role: ${context.invalidRole}. The gateway tool boundary fails closed until DIRECTOR_FILM_ROLE is corrected.`,
      },
    };
  }
  if (context.role && !roleCanSeeTool(context.role, tool)) {
    const rejection = filmRoleToolPolicyRejection(context.role, tool, input) ?? {
      success: false as const,
      code: "tool_policy_rejected" as const,
      error: `${context.role} is not allowed to execute ${tool} with this operation`,
    };
    return { status: 403, body: rejection };
  }
  const rejection = directorToolPolicyRejection(context.role, context.planMode, tool, input);
  return rejection ? { status: 403, body: rejection } : null;
}
