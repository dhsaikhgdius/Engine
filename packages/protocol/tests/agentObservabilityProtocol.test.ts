import { describe, expect, it } from "vitest";
import {
  accumulateAgentUsageSummary,
  agentTraceEventSchema,
  filmRunToUnifiedProgress,
  multiAgentRunToUnifiedProgress,
  parseAgentTraceSource,
  productionJobToUnifiedProgress,
  redactAgentTraceText,
  summarizeAgentTraceSession,
  summarizeAgentTraceSessions,
  summarizeAgentUsage,
  summarizeUnifiedProgress,
  UNIFIED_PROGRESS_CONTRACT,
  type AgentTraceEvent,
  type AgentUsageSample,
  type MultiAgentRunProgressSource,
} from "../src/agentObservabilityProtocol";
import { accumulateFilmRunUsage, emptyFilmRunUsage } from "../src/filmRunUsage";
import type { FilmRun } from "../src/filmPipelineProtocol";
import type { ProductionJobRecord } from "../src/productionJobProtocol";

function traceEvent(overrides: Partial<AgentTraceEvent> = {}): AgentTraceEvent {
  return agentTraceEventSchema.parse({
    id: "trace-1",
    session_id: "mcp-session-1",
    source: "mcp",
    tool: "director_workbench",
    operation: "author",
    outcome: "success",
    status_code: 200,
    started_at: "2026-08-25T10:00:00.000Z",
    duration_ms: 40,
    revision_before: null,
    revision_after: null,
    ...overrides,
  });
}

describe("agent trace source", () => {
  it("parses known source labels and falls back to http", () => {
    expect(parseAgentTraceSource("mcp")).toBe("mcp");
    expect(parseAgentTraceSource(["cli"])).toBe("cli");
    expect(parseAgentTraceSource(" ui ")).toBe("ui");
    expect(parseAgentTraceSource(undefined)).toBe("http");
    expect(parseAgentTraceSource("browser")).toBe("http");
  });
});

describe("trace text redaction", () => {
  it("redacts credential-shaped fragments from error text", () => {
    const redacted = redactAgentTraceText(
      'call failed: {"api_key":"sk-super-secret"} Authorization: Bearer abc.def-123 token=plainsecret',
    );
    expect(redacted).not.toContain("sk-super-secret");
    expect(redacted).not.toContain("abc.def-123");
    expect(redacted).not.toContain("plainsecret");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts token-bearing query strings and caps length", () => {
    const redacted = redactAgentTraceText(
      `preview http://localhost/api/preview?preview_token=tok123 ${"x".repeat(600)}`,
    );
    expect(redacted).not.toContain("tok123");
    expect(redacted.length).toBeLessThanOrEqual(500);
  });
});

describe("session tool-chain summary", () => {
  it("reconstructs an ordered chain with outcome and revision aggregates", () => {
    const events = [
      traceEvent({
        id: "trace-2",
        operation: "production.plan",
        started_at: "2026-08-25T10:00:02.000Z",
        outcome: "conflict",
        status_code: 409,
        duration_ms: 10,
        revision_before: "rev-2",
        code: "stale_project_revision",
      }),
      traceEvent({
        id: "trace-1",
        operation: "observe",
        started_at: "2026-08-25T10:00:00.000Z",
        revision_before: "rev-1",
        revision_after: "rev-2",
        capture_ref: "http://127.0.0.1:8787/api/preview",
      }),
      traceEvent({ id: "trace-3", session_id: "other-session" }),
    ];
    const summary = summarizeAgentTraceSession("mcp-session-1", events);
    expect(summary).not.toBeNull();
    expect(summary?.call_count).toBe(2);
    expect(summary?.conflict_count).toBe(1);
    expect(summary?.error_count).toBe(0);
    expect(summary?.total_duration_ms).toBe(50);
    expect(summary?.sources).toEqual(["mcp"]);
    expect(summary?.revision_start).toBe("rev-1");
    expect(summary?.revision_end).toBe("rev-2");
    expect(summary?.chain.map((step) => step.operation)).toEqual(["observe", "production.plan"]);
    expect(summary?.chain[0]?.capture_ref).toBe("http://127.0.0.1:8787/api/preview");
    expect(summary?.chain[1]?.code).toBe("stale_project_revision");
  });

  it("returns null for a session without events", () => {
    expect(summarizeAgentTraceSession("missing", [traceEvent()])).toBeNull();
  });
});

describe("per-session aggregates", () => {
  it("aggregates every session without chains, newest session first, honoring the limit", () => {
    const events = [
      traceEvent({ id: "trace-1", session_id: "session-a", started_at: "2026-08-25T10:00:00.000Z" }),
      traceEvent({
        id: "trace-2",
        session_id: "session-a",
        started_at: "2026-08-25T10:00:05.000Z",
        outcome: "error",
        status_code: 500,
      }),
      traceEvent({ id: "trace-3", session_id: "session-b", started_at: "2026-08-25T10:00:07.000Z", source: "cli" }),
      traceEvent({ id: "trace-4", session_id: "session-c", started_at: "2026-08-25T09:00:00.000Z" }),
    ];
    const aggregates = summarizeAgentTraceSessions(events);
    expect(aggregates.map((aggregate) => aggregate.session_id)).toEqual(["session-b", "session-a", "session-c"]);
    const sessionA = aggregates[1]!;
    expect(sessionA.call_count).toBe(2);
    expect(sessionA.error_count).toBe(1);
    expect("chain" in sessionA).toBe(false);

    expect(summarizeAgentTraceSessions(events, 1).map((aggregate) => aggregate.session_id)).toEqual(["session-b"]);
    expect(summarizeAgentTraceSessions([])).toEqual([]);
  });
});

describe("usage aggregation", () => {
  it("totals tokens, wall-clock, retries, and failures", () => {
    const samples: AgentUsageSample[] = [
      {
        id: "usage-1",
        scope: "production-session-1",
        provider: "anthropic",
        model: "claude-x",
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        duration_ms: 1_200,
        retries: 1,
        succeeded: true,
        recorded_at: "2026-08-25T10:00:00.000Z",
      },
      {
        id: "usage-2",
        scope: "production-session-1",
        provider: "openai-compatible",
        model: "gpt-x",
        input_tokens: 10,
        output_tokens: 0,
        total_tokens: 10,
        duration_ms: 300,
        retries: 2,
        succeeded: false,
        recorded_at: "2026-08-25T10:00:01.000Z",
      },
    ];
    expect(summarizeAgentUsage(samples)).toEqual({
      sample_count: 2,
      input_tokens: 110,
      output_tokens: 50,
      total_tokens: 160,
      total_duration_ms: 1_500,
      retries: 3,
      failure_count: 1,
    });
  });

  it("folds samples into a running summary and film-run rollup", () => {
    const first = accumulateAgentUsageSummary(
      {
        sample_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        total_duration_ms: 0,
        retries: 0,
        failure_count: 0,
      },
      {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        duration_ms: 100,
        retries: 0,
        succeeded: true,
      },
    );
    expect(first).toEqual({
      sample_count: 1,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      total_duration_ms: 100,
      retries: 0,
      failure_count: 0,
    });
    const usage = accumulateFilmRunUsage(emptyFilmRunUsage(), {
      scope: "film-video",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 400,
      retries: 1,
      succeeded: false,
    });
    expect(usage["film-video"]).toEqual({
      sample_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_duration_ms: 400,
      retries: 1,
      failure_count: 1,
    });
    expect(usage["film-llm"].sample_count).toBe(0);
    const withSpeech = accumulateFilmRunUsage(usage, {
      scope: "film-tts",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 750,
      retries: 0,
      succeeded: true,
    });
    expect(withSpeech["film-tts"].sample_count).toBe(1);
    expect(withSpeech["film-tts"].total_duration_ms).toBe(750);
    expect(withSpeech["film-video"].sample_count).toBe(1);
  });
});

describe("unified progress adapters", () => {
  it("adapts a production job (including DCC export kinds) without breaking source fields", () => {
    const job = {
      id: "canvas-job-1",
      kind: "dcc.export",
      status: "running",
      progress: 0.4,
      message: "正在导出",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:00:05.000Z",
    } as unknown as ProductionJobRecord;
    const progress = productionJobToUnifiedProgress(job);
    expect(progress.contract).toBe(UNIFIED_PROGRESS_CONTRACT);
    expect(progress.kind).toBe("production_job");
    expect(progress.state).toBe("running");
    expect(progress.progress).toBe(0.4);
    expect(progress.source_status).toBe("running");
  });

  it("normalizes succeeded jobs to full progress and reconciling jobs to waiting", () => {
    const base = {
      id: "job-1",
      kind: "video.generate",
      progress: 0.2,
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:00:05.000Z",
    };
    const succeeded = productionJobToUnifiedProgress({
      ...base,
      status: "succeeded",
    } as unknown as ProductionJobRecord);
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.progress).toBe(1);
    const reconciling = productionJobToUnifiedProgress({
      ...base,
      status: "reconciling",
    } as unknown as ProductionJobRecord);
    expect(reconciling.state).toBe("waiting");
    const unknown = productionJobToUnifiedProgress({
      ...base,
      status: "outcome_unknown",
    } as unknown as ProductionJobRecord);
    expect(unknown.state).toBe("unknown");
  });

  it("adapts a multi-agent run using settled-node fraction as progress", () => {
    const run: MultiAgentRunProgressSource = {
      id: "run-alpha",
      objective: "拍一支 20 秒的追逐短片",
      status: "waiting_approval",
      nodes: [{ status: "succeeded" }, { status: "failed" }, { status: "running" }, { status: "pending" }],
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:03:00.000Z",
    };
    const progress = multiAgentRunToUnifiedProgress(run);
    expect(progress.kind).toBe("multi_agent_run");
    expect(progress.state).toBe("waiting");
    expect(progress.progress).toBe(0.5);
    expect(progress.label).toContain("追逐短片");
  });

  it("adapts a film run using phase order as progress and the last event as message", () => {
    const run = {
      version: 1,
      id: "film-run-1",
      workflow: "idea-to-film",
      status: "running",
      phase: "render",
      events: [{ at: "2026-08-25T10:00:00.000Z", phase: "render", message: "开始渲染第 2 镜" }],
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
    } as unknown as FilmRun;
    const progress = filmRunToUnifiedProgress(run);
    expect(progress.kind).toBe("film_run");
    expect(progress.state).toBe("running");
    expect(progress.progress).toBeCloseTo(5 / 7);
    expect(progress.message).toBe("开始渲染第 2 镜");
    expect(progress.usage).toBeUndefined();
  });

  it("projects durable film-run usage onto unified progress when samples exist", () => {
    const empty = {
      sample_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_duration_ms: 0,
      retries: 0,
      failure_count: 0,
    };
    const run = {
      version: 1,
      id: "film-run-usage",
      workflow: "idea-to-film",
      status: "running",
      phase: "render",
      events: [],
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      usage: {
        "film-llm": { ...empty, sample_count: 2, total_tokens: 120, total_duration_ms: 800 },
        "film-image": empty,
        "film-video": { ...empty, sample_count: 1, total_duration_ms: 12_000 },
        "film-tts": empty,
      },
    } as unknown as FilmRun;
    const progress = filmRunToUnifiedProgress(run);
    expect(progress.usage?.["film-llm"].total_tokens).toBe(120);
    expect(progress.usage?.["film-video"].sample_count).toBe(1);
    expect(
      filmRunToUnifiedProgress({
        ...run,
        usage: { "film-llm": empty, "film-image": empty, "film-video": empty, "film-tts": empty },
      } as unknown as FilmRun).usage,
    ).toBeUndefined();
    // A run whose only metered cost is dialogue speech synthesis still
    // surfaces its usage rollup on unified progress.
    const speechOnly = filmRunToUnifiedProgress({
      ...run,
      usage: {
        "film-llm": empty,
        "film-image": empty,
        "film-video": empty,
        "film-tts": { ...empty, sample_count: 4, total_duration_ms: 3_200, retries: 2 },
      },
    } as unknown as FilmRun);
    expect(speechOnly.usage?.["film-tts"].sample_count).toBe(4);
    expect(speechOnly.usage?.["film-tts"].retries).toBe(2);
  });

  it("shares intra-phase film progress with the receipt helper during render", () => {
    const run = {
      version: 1,
      id: "film-run-2",
      workflow: "idea-to-film",
      status: "running",
      phase: "render",
      scenes: [
        { storyboard: null, shotSpecs: null, cameraPlan: null, videoPath: "/a.mp4" },
        { storyboard: null, shotSpecs: null, cameraPlan: null, videoPath: null },
      ],
      events: [],
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
    } as unknown as FilmRun;
    expect(filmRunToUnifiedProgress(run).progress).toBeCloseTo(5 / 7 + 1 / 14);
  });

  it("aggregates unified progress into exhaustive zero-filled state and kind counts", () => {
    const running = filmRunToUnifiedProgress({
      version: 1,
      id: "film-run-1",
      workflow: "idea-to-film",
      status: "running",
      phase: "render",
      events: [],
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
    } as unknown as FilmRun);
    const waiting = multiAgentRunToUnifiedProgress({
      id: "run-alpha",
      objective: "拍一支短片",
      status: "waiting_approval",
      nodes: [],
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:03:00.000Z",
    });
    const summary = summarizeUnifiedProgress([running, waiting]);
    expect(summary.entry_count).toBe(2);
    expect(summary.by_state).toEqual({
      queued: 0,
      running: 1,
      waiting: 1,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      unknown: 0,
    });
    expect(summary.by_kind).toEqual({ production_job: 0, multi_agent_run: 1, film_run: 1 });
  });
});
