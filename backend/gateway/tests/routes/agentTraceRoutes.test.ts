// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { FilmRun } from "../../../../packages/protocol/src/filmPipelineProtocol";
import type { ProductionJobRecord } from "../../../../packages/protocol/src/productionJobProtocol";
import { AgentTraceStore } from "../../agents/agentTraceStore";
import { handleAgentTraceRoute, type AgentTraceRouteDependencies } from "../../routes/agentTraceRoutes";

function request(method = "GET") {
  return { method } as IncomingMessage;
}

function response() {
  return { end: vi.fn() } as unknown as ServerResponse;
}

async function seededStore() {
  const store = new AgentTraceStore();
  await store.record({
    session_id: "mcp-session-1",
    source: "mcp",
    tool: "director_workbench",
    operation: "observe",
    outcome: "success",
    status_code: 200,
    started_at: "2026-08-25T10:00:00.000Z",
    duration_ms: 20,
    revision_before: "rev-1",
    revision_after: "rev-2",
  });
  await store.record({
    session_id: "mcp-session-1",
    source: "mcp",
    tool: "director_workbench",
    operation: "author",
    outcome: "conflict",
    status_code: 409,
    started_at: "2026-08-25T10:00:01.000Z",
    duration_ms: 15,
    revision_before: "rev-2",
    revision_after: null,
    code: "stale_project_revision",
  });
  await store.recordUsage({
    scope: "production-session-1",
    provider: "anthropic",
    model: "claude-x",
    input_tokens: 100,
    output_tokens: 40,
    total_tokens: 140,
    duration_ms: 1_000,
    retries: 1,
    succeeded: true,
  });
  return store;
}

async function fixture() {
  const json = vi.fn();
  const dependencies: AgentTraceRouteDependencies = {
    json,
    store: await seededStore(),
    listProductionJobs: vi.fn().mockResolvedValue([
      {
        id: "job-1",
        kind: "dcc.export",
        status: "running",
        progress: 0.5,
        message: "导出中",
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T10:00:10.000Z",
      } as unknown as ProductionJobRecord,
    ]),
    listMultiAgentRuns: vi.fn().mockResolvedValue([
      {
        id: "run-1",
        objective: "拍摄一支短片",
        status: "running",
        nodes: [{ status: "succeeded" }, { status: "running" }],
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T10:00:20.000Z",
      },
    ]),
    listFilmRuns: vi.fn().mockResolvedValue([
      {
        version: 1,
        id: "film-run-1",
        workflow: "idea-to-film",
        status: "waiting_approval",
        phase: "await-approval",
        events: [],
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T10:00:30.000Z",
      } as unknown as FilmRun,
    ]),
  };
  return { dependencies, json };
}

function url(path: string) {
  return new URL(`http://127.0.0.1:8787${path}`);
}

describe("agent trace routes", () => {
  it("ignores non-GET methods and unrelated paths", async () => {
    const { dependencies } = await fixture();
    expect(await handleAgentTraceRoute(request("POST"), response(), url("/api/agent/traces"), dependencies)).toBe(
      false,
    );
    expect(await handleAgentTraceRoute(request(), response(), url("/api/other"), dependencies)).toBe(false);
  });

  it("lists trace events newest first with filters", async () => {
    const { dependencies, json } = await fixture();
    expect(await handleAgentTraceRoute(request(), response(), url("/api/agent/traces"), dependencies)).toBe(true);
    const [, status, body] = json.mock.calls[0] as [unknown, number, { events: { operation: string }[] }];
    expect(status).toBe(200);
    expect(body.events.map((event) => event.operation)).toEqual(["author", "observe"]);

    json.mockClear();
    await handleAgentTraceRoute(request(), response(), url("/api/agent/traces?tool=stage_video"), dependencies);
    const [, , filtered] = json.mock.calls[0] as [unknown, number, { events: unknown[] }];
    expect(filtered.events).toHaveLength(0);
  });

  it("rejects invalid trace query parameters", async () => {
    const { dependencies, json } = await fixture();
    await handleAgentTraceRoute(request(), response(), url("/api/agent/traces?source=browser"), dependencies);
    const [, status, body] = json.mock.calls[0] as [unknown, number, { code: string }];
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_trace_query");
  });

  it("lists compact per-session aggregates via the sessions route", async () => {
    const { dependencies, json } = await fixture();
    expect(await handleAgentTraceRoute(request(), response(), url("/api/agent/traces/sessions"), dependencies)).toBe(
      true,
    );
    const [, status, body] = json.mock.calls[0] as [
      unknown,
      number,
      { sessions: { session_id: string; call_count: number; conflict_count: number }[] },
    ];
    expect(status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ session_id: "mcp-session-1", call_count: 2, conflict_count: 1 });
    expect("chain" in body.sessions[0]!).toBe(false);

    json.mockClear();
    await handleAgentTraceRoute(request(), response(), url("/api/agent/traces/sessions?limit=0"), dependencies);
    const [, invalidStatus, invalidBody] = json.mock.calls[0] as [unknown, number, { code: string }];
    expect(invalidStatus).toBe(400);
    expect(invalidBody.code).toBe("invalid_trace_query");
  });

  it("reconstructs the latest session tool chain via the summary route", async () => {
    const { dependencies, json } = await fixture();
    await handleAgentTraceRoute(request(), response(), url("/api/agent/traces/summary"), dependencies);
    const [, status, body] = json.mock.calls[0] as [
      unknown,
      number,
      { summary: { session_id: string; chain: { operation: string }[]; conflict_count: number } },
    ];
    expect(status).toBe(200);
    expect(body.summary.session_id).toBe("mcp-session-1");
    expect(body.summary.chain.map((step) => step.operation)).toEqual(["observe", "author"]);
    expect(body.summary.conflict_count).toBe(1);
  });

  it("returns 404 when no session matches the summary request", async () => {
    const { dependencies, json } = await fixture();
    await handleAgentTraceRoute(
      request(),
      response(),
      url("/api/agent/traces/summary?session_id=missing"),
      dependencies,
    );
    const [, status, body] = json.mock.calls[0] as [unknown, number, { code: string }];
    expect(status).toBe(404);
    expect(body.code).toBe("trace_session_not_found");
  });

  it("returns usage samples plus a token/latency/retry aggregate", async () => {
    const { dependencies, json } = await fixture();
    await handleAgentTraceRoute(request(), response(), url("/api/agent/usage"), dependencies);
    const [, status, body] = json.mock.calls[0] as [
      unknown,
      number,
      { samples: unknown[]; summary: { total_tokens: number; retries: number; failure_count: number } },
    ];
    expect(status).toBe(200);
    expect(body.samples).toHaveLength(1);
    expect(body.summary.total_tokens).toBe(140);
    expect(body.summary.retries).toBe(1);
    expect(body.summary.failure_count).toBe(0);
  });

  it("returns unified progress across jobs, multi-agent runs, and film runs", async () => {
    const { dependencies, json } = await fixture();
    await handleAgentTraceRoute(request(), response(), url("/api/agent/progress"), dependencies);
    const [, status, body] = json.mock.calls[0] as [
      unknown,
      number,
      {
        entries: { kind: string; id: string; state: string; contract: string }[];
        summary: { entry_count: number; by_state: Record<string, number>; by_kind: Record<string, number> };
      },
    ];
    expect(status).toBe(200);
    expect(body.entries.map((entry) => entry.kind)).toEqual(["film_run", "multi_agent_run", "production_job"]);
    expect(body.entries.every((entry) => entry.contract === "director-progress-v1")).toBe(true);
    expect(body.summary.entry_count).toBe(3);
    expect(body.summary.by_state).toMatchObject({ running: 2, waiting: 1, failed: 0 });
    expect(body.summary.by_kind).toEqual({ production_job: 1, multi_agent_run: 1, film_run: 1 });

    json.mockClear();
    await handleAgentTraceRoute(request(), response(), url("/api/agent/progress?kind=production_job"), dependencies);
    const [, , filtered] = json.mock.calls[0] as [
      unknown,
      number,
      { entries: { id: string }[]; summary: { entry_count: number } },
    ];
    expect(filtered.entries.map((entry) => entry.id)).toEqual(["job-1"]);
    // The summary counts everything that matched the kind filter.
    expect(filtered.summary.entry_count).toBe(1);
  });
});
