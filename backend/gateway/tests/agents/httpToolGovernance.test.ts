// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditOperationForToolInput,
  evaluateHttpToolGovernance,
  resolveHttpToolSource,
  withHttpToolAudit,
} from "../../agents/httpToolGovernance";
import type { AgentToolAuditEntry, AgentToolAuditStore } from "../../agentToolAuditStore";

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { method: "POST", headers } as unknown as IncomingMessage;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("HTTP tool governance", () => {
  it("resolves the film role from the header first, then injected deps, then the environment", () => {
    vi.stubEnv("DIRECTOR_FILM_ROLE", "production-designer");
    const headerWins = evaluateHttpToolGovernance({
      request: request({ "x-director-film-role": "visual-critic" }),
      tool: "director_workbench",
      toolInput: { op: "author" },
      dependencies: { filmRoleId: null },
    });
    expect(headerWins).toMatchObject({ allowed: false, status: 403, roleId: "visual-critic" });

    const injectedWins = evaluateHttpToolGovernance({
      request: request(),
      tool: "director_workbench",
      toolInput: { op: "author" },
      dependencies: { filmRoleId: null },
    });
    expect(injectedWins).toMatchObject({ allowed: true, roleId: null });

    const environmentFallback = evaluateHttpToolGovernance({
      request: request(),
      tool: "stage_scene",
      toolInput: { op: "reset" },
    });
    expect(environmentFallback).toMatchObject({ allowed: false, status: 403, roleId: "production-designer" });
  });

  it("fails closed with 400 on an invalid film-role header or environment role", () => {
    const invalidHeader = evaluateHttpToolGovernance({
      request: request({ "x-director-film-role": "grip" }),
      tool: "director_workbench",
      toolInput: { op: "observe" },
    });
    expect(invalidHeader).toMatchObject({
      allowed: false,
      status: 400,
      body: { success: false, code: "invalid_film_role" },
    });

    vi.stubEnv("DIRECTOR_FILM_ROLE", "best-boy");
    const invalidEnvironment = evaluateHttpToolGovernance({
      request: request(),
      tool: "director_workbench",
      toolInput: { op: "observe" },
    });
    expect(invalidEnvironment).toMatchObject({ allowed: false, status: 400, body: { code: "invalid_film_role" } });
  });

  it("keeps the MCP rejection shape for role and plan-mode denials", () => {
    const roleDenied = evaluateHttpToolGovernance({
      request: request(),
      tool: "director_workbench",
      toolInput: { op: "author" },
      dependencies: { filmRoleId: "visual-critic" },
    });
    expect(roleDenied).toMatchObject({
      allowed: false,
      status: 403,
      body: {
        success: false,
        code: "tool_policy_rejected",
        error: "visual-critic is not allowed to execute director_workbench with this operation",
      },
    });

    const planDenied = evaluateHttpToolGovernance({
      request: request(),
      tool: "director_workbench",
      toolInput: { op: "author" },
      dependencies: { filmRoleId: null, planMode: true },
    });
    expect(planDenied).toMatchObject({ allowed: false, status: 403, body: { code: "plan_mode_blocked" } });

    const planReadAllowed = evaluateHttpToolGovernance({
      request: request(),
      tool: "director_workbench",
      toolInput: { op: "observe" },
      dependencies: { filmRoleId: null, planMode: true },
    });
    expect(planReadAllowed).toMatchObject({ allowed: true });
  });

  it("reads plan mode from DIRECTOR_PLAN_MODE when no override is injected", () => {
    vi.stubEnv("DIRECTOR_PLAN_MODE", "1");
    const denied = evaluateHttpToolGovernance({
      request: request(),
      tool: "director_workbench",
      toolInput: { op: "author" },
      dependencies: { filmRoleId: null },
    });
    expect(denied).toMatchObject({ allowed: false, body: { code: "plan_mode_blocked" } });
  });

  it("tags the source from the header first and infers it from the session id otherwise", () => {
    expect(resolveHttpToolSource(request({ "x-director-tool-source": "cli" }), "mcp-1")).toBe("cli");
    expect(resolveHttpToolSource(request({ "x-director-tool-source": "carrier" }), "mcp-1")).toBe("mcp");
    expect(resolveHttpToolSource(request(), "mcp-123-abc")).toBe("mcp");
    expect(resolveHttpToolSource(request(), "dsh-session")).toBe("mcp");
    expect(resolveHttpToolSource(request(), "cli-default")).toBe("cli");
    expect(resolveHttpToolSource(request(), "hosted-session")).toBe("http");
    expect(resolveHttpToolSource(request())).toBe("http");
  });

  it("derives the audit operation from op plus nested request/command actions", () => {
    expect(auditOperationForToolInput({ op: "author" })).toBe("author");
    expect(auditOperationForToolInput({ op: "pipeline", request: { action: "start" } })).toBe("pipeline.start");
    expect(auditOperationForToolInput({ op: "generation", command: { action: "submit" } })).toBe("generation.submit");
    expect(auditOperationForToolInput({ prompt: "no op" })).toBeUndefined();
  });

  it("records one success or error audit entry per governed response", async () => {
    const entries: AgentToolAuditEntry[] = [];
    const store = {
      record: (entry: AgentToolAuditEntry) => {
        entries.push(entry);
        return Promise.resolve(entry);
      },
    } as unknown as AgentToolAuditStore;
    const writes: Array<{ status: number; body: unknown }> = [];
    const json = withHttpToolAudit((_response, status, body) => writes.push({ status, body }), {
      store,
      tool: "director_workbench",
      toolInput: { op: "author", idempotency_key: "agent-intent:audit-1" },
      roleId: "stage-director",
      source: "http",
      sessionId: "session-audit",
    });

    json({} as ServerResponse, 200, {
      success: true,
      result: { project_revision: "revision-2", project_revision_before: "revision-1" },
    });
    json({} as ServerResponse, 409, { success: false, code: "stale_project_revision" });

    expect(writes).toHaveLength(2);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: "director_workbench",
      operation: "author",
      role: "stage-director",
      source: "http",
      outcome: "success",
      session_id: "session-audit",
      idempotency_key: "agent-intent:audit-1",
      revision_before: "revision-1",
      revision_after: "revision-2",
    });
  });
});
