/**
 * Agent observability contracts (roadmap M5): session tool-chain traces,
 * model usage (cost/latency) samples, and one unified progress shape shared
 * by production jobs, multi-agent runs, and film pipeline runs.
 *
 * Privacy boundary: trace events carry operation names, guard revisions,
 * idempotency keys, outcome codes, and capture *references* — never raw
 * prompts, tool payloads, credentials, or image bytes. Free-text fields
 * must pass {@link redactAgentTraceText} before they enter a trace record.
 */

import { z } from "zod";
import { isTerminalProductionJobStatus, type ProductionJobRecord } from "./productionJobProtocol";
import { filmRunProgress, type FilmRun } from "./filmPipelineProtocol";

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

// ---- Trace source ----

/** Entry surface that issued a traced tool call. */
export const agentTraceSourceSchema = z.enum(["ui", "mcp", "http", "cli"]);
/** Entry surface label. */
export type AgentTraceSource = z.infer<typeof agentTraceSourceSchema>;

/** HTTP header used by first-party clients to self-identify their entry surface. */
export const AGENT_TRACE_SOURCE_HEADER = "x-director-trace-source";

/**
 * Parses the trace-source header value. Unknown or missing values fall back
 * to `http` — the honest default for a raw HTTP caller.
 *
 * @param value - The raw header value (string, array, or undefined).
 * @returns The validated trace source.
 */
export function parseAgentTraceSource(value: unknown): AgentTraceSource {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = agentTraceSourceSchema.safeParse(typeof candidate === "string" ? candidate.trim() : candidate);
  return parsed.success ? parsed.data : "http";
}

// ---- Redaction ----

const SENSITIVE_KEY_PATTERN = "(?:api[_-]?key|apikey|token|secret|password|credential|authorization|bearer)";

/**
 * Redacts credential-shaped content from free text before it is stored in a
 * trace record. This complements — it does not replace — the structural rule
 * that trace events never carry raw prompts or tool payloads.
 *
 * @param text - The free text (typically an error message).
 * @param maximumLength - Hard cap applied after redaction (default 500).
 * @returns The redacted, length-capped text.
 */
export function redactAgentTraceText(text: string, maximumLength = 500): string {
  return text
    .replace(new RegExp(`("${SENSITIVE_KEY_PATTERN}[^"]*"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi"), '$1"[REDACTED]"')
    .replace(new RegExp(`([?&][^?&#\\s=]*${SENSITIVE_KEY_PATTERN}[^?&#\\s=]*=)[^&#\\s]*`, "gi"), "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(authorization|proxy-authorization|x-api-key|x-auth-token|x-director-browser-token|cookie|set-cookie)\s*[:=]\s*[^\r\n,;&]+/gi,
      "$1=[REDACTED]",
    )
    .replace(new RegExp(`\\b(${SENSITIVE_KEY_PATTERN})\\b\\s*[:=]\\s*([^\\s,;&"']+)`, "gi"), "$1=[REDACTED]")
    .slice(0, maximumLength);
}

// ---- Trace events ----

/** Outcome classification of one traced tool call. */
export const agentTraceOutcomeSchema = z.enum(["success", "conflict", "error"]);
/** Trace outcome label. */
export type AgentTraceOutcome = z.infer<typeof agentTraceOutcomeSchema>;

/**
 * One recorded tool invocation at the gateway boundary. The event is an
 * execution receipt, not a payload log: inputs and prompts are never stored.
 */
export const agentTraceEventSchema = z.strictObject({
  /** Stable event id assigned by the trace store. */
  id: nonEmptyText(160),
  /** Caller session (HTTP envelope `session_id`; `mcp-*`, `cli-*`, `browser-ui`, …). */
  session_id: nonEmptyText(160),
  /** Entry surface that issued the call. */
  source: agentTraceSourceSchema,
  /** Tool name (`director_workbench`, `director_creative`, `stage_video`, …). */
  tool: nonEmptyText(160),
  /** Semantic operation (`author`, `production.observe`, `generation.submit`, …). */
  operation: nonEmptyText(160),
  /** Outcome classification; `conflict` covers stale-guard and idempotency replays. */
  outcome: agentTraceOutcomeSchema,
  /** HTTP status the gateway answered with. */
  status_code: z.number().int().min(100).max(599),
  /** ISO timestamp when the gateway accepted the call. */
  started_at: z.string(),
  /** Wall-clock duration of the gateway-side execution. */
  duration_ms: z.number().int().nonnegative(),
  /** Guard revision observed before the mutation, when one was bound. */
  revision_before: z.string().max(240).nullable(),
  /** Revision reported by the target after the call, when observable. */
  revision_after: z.string().max(240).nullable(),
  /** Idempotency key from the agent boundary receipt, when one was issued. */
  idempotency_key: z.string().max(160).optional(),
  /** Structured result code (`stale_project_revision`, `workbench_unavailable`, …). */
  code: z.string().max(160).optional(),
  /** Redacted error message when the call failed. */
  error: z.string().max(500).optional(),
  /** Reference (URL) to a capture produced by this call — never image bytes. */
  capture_ref: z.string().max(2_000).optional(),
});
/** One recorded tool invocation. */
export type AgentTraceEvent = z.infer<typeof agentTraceEventSchema>;

/** One step in a reconstructed session tool chain. */
export const agentTraceChainStepSchema = z.strictObject({
  tool: nonEmptyText(160),
  operation: nonEmptyText(160),
  outcome: agentTraceOutcomeSchema,
  started_at: z.string(),
  duration_ms: z.number().int().nonnegative(),
  revision_before: z.string().max(240).nullable(),
  revision_after: z.string().max(240).nullable(),
  code: z.string().max(160).optional(),
  capture_ref: z.string().max(2_000).optional(),
});

/** Reconstructed summary of one session's tool chain, ordered oldest-first. */
export const agentTraceSessionSummarySchema = z.strictObject({
  session_id: nonEmptyText(160),
  sources: z.array(agentTraceSourceSchema).min(1),
  started_at: z.string(),
  ended_at: z.string(),
  call_count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  conflict_count: z.number().int().nonnegative(),
  total_duration_ms: z.number().int().nonnegative(),
  /** First bound guard revision seen in the session, when any. */
  revision_start: z.string().max(240).nullable(),
  /** Last observed post-call revision in the session, when any. */
  revision_end: z.string().max(240).nullable(),
  chain: z.array(agentTraceChainStepSchema),
});
/** Reconstructed session tool-chain summary. */
export type AgentTraceSessionSummary = z.infer<typeof agentTraceSessionSummarySchema>;

/**
 * Compact aggregate of one session: the session summary without the
 * per-call chain, sized for listing many sessions cheaply.
 */
export const agentTraceSessionAggregateSchema = agentTraceSessionSummarySchema.omit({ chain: true });
/** Compact per-session aggregate. */
export type AgentTraceSessionAggregate = z.infer<typeof agentTraceSessionAggregateSchema>;

/**
 * Aggregates trace events into per-session summaries without chains,
 * most-recent session first (ordered by each session's last event).
 *
 * @param events - Trace events (any order, any sessions).
 * @param limit - Maximum number of sessions to return (default 50).
 * @returns Compact aggregates, newest session first.
 */
export function summarizeAgentTraceSessions(
  events: readonly AgentTraceEvent[],
  limit = 50,
): AgentTraceSessionAggregate[] {
  const bySession = new Map<string, AgentTraceEvent[]>();
  for (const event of events) {
    const bucket = bySession.get(event.session_id);
    if (bucket) bucket.push(event);
    else bySession.set(event.session_id, [event]);
  }
  const aggregates: AgentTraceSessionAggregate[] = [];
  for (const [sessionId, own] of bySession) {
    const summary = summarizeAgentTraceSession(sessionId, own);
    if (!summary) continue;
    const { chain: _chain, ...aggregate } = summary;
    aggregates.push(agentTraceSessionAggregateSchema.parse(aggregate));
  }
  return aggregates.sort((left, right) => right.ended_at.localeCompare(left.ended_at)).slice(0, limit);
}

/**
 * Reconstructs the tool-chain summary for one session from its trace events.
 *
 * @param sessionId - The session to summarize.
 * @param events - Trace events (any order, any sessions); other sessions are ignored.
 * @returns The summary, or null when the session has no events.
 */
export function summarizeAgentTraceSession(
  sessionId: string,
  events: readonly AgentTraceEvent[],
): AgentTraceSessionSummary | null {
  const own = events
    .filter((event) => event.session_id === sessionId)
    .sort((left, right) => left.started_at.localeCompare(right.started_at));
  if (!own.length) return null;
  const sources = [...new Set(own.map((event) => event.source))];
  const revisions = own.flatMap((event) => (event.revision_before ? [event.revision_before] : []));
  const observed = own.flatMap((event) => (event.revision_after ? [event.revision_after] : []));
  return agentTraceSessionSummarySchema.parse({
    session_id: sessionId,
    sources,
    started_at: own[0].started_at,
    ended_at: own[own.length - 1].started_at,
    call_count: own.length,
    error_count: own.filter((event) => event.outcome === "error").length,
    conflict_count: own.filter((event) => event.outcome === "conflict").length,
    total_duration_ms: own.reduce((total, event) => total + event.duration_ms, 0),
    revision_start: revisions[0] ?? null,
    revision_end: observed[observed.length - 1] ?? null,
    chain: own.map((event) => ({
      tool: event.tool,
      operation: event.operation,
      outcome: event.outcome,
      started_at: event.started_at,
      duration_ms: event.duration_ms,
      revision_before: event.revision_before,
      revision_after: event.revision_after,
      ...(event.code ? { code: event.code } : {}),
      ...(event.capture_ref ? { capture_ref: event.capture_ref } : {}),
    })),
  });
}

// ---- Model usage (cost / latency) ----

/**
 * One metered model-provider call. Recorded by an injectable meter so tests
 * and offline environments aggregate without real credentials.
 */
export const agentUsageSampleSchema = z.strictObject({
  /** Stable sample id assigned by the store. */
  id: nonEmptyText(160),
  /** Session or run scope the call belongs to (production session, film run, …). */
  scope: nonEmptyText(160),
  /** Provider identity (`api`, `anthropic`, `openai-compatible`, …). */
  provider: nonEmptyText(160),
  /** Model name as configured, never the credential. */
  model: nonEmptyText(320),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  /** Wall-clock time of the provider call, including retries. */
  duration_ms: z.number().int().nonnegative(),
  /** Retries after the first attempt (0 when the first attempt settled it). */
  retries: z.number().int().nonnegative(),
  succeeded: z.boolean(),
  recorded_at: z.string(),
});
/** One metered model-provider call. */
export type AgentUsageSample = z.infer<typeof agentUsageSampleSchema>;

/** Input accepted by a usage meter; ids and timestamps are store-assigned. */
export type AgentUsageMeterInput = Omit<AgentUsageSample, "id" | "recorded_at">;

/** Injectable meter callback for model-provider call sites. */
export type AgentUsageMeter = (sample: AgentUsageMeterInput) => void;

/** Aggregated usage across a set of samples. */
export const agentUsageSummarySchema = z.strictObject({
  sample_count: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  total_duration_ms: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  failure_count: z.number().int().nonnegative(),
});
/** Aggregated usage. */
export type AgentUsageSummary = z.infer<typeof agentUsageSummarySchema>;

/**
 * Aggregates usage samples into one summary.
 *
 * @param samples - The samples to aggregate.
 * @returns Token, wall-clock, retry, and failure totals.
 */
export function summarizeAgentUsage(samples: readonly AgentUsageSample[]): AgentUsageSummary {
  return agentUsageSummarySchema.parse({
    sample_count: samples.length,
    input_tokens: samples.reduce((total, sample) => total + sample.input_tokens, 0),
    output_tokens: samples.reduce((total, sample) => total + sample.output_tokens, 0),
    total_tokens: samples.reduce((total, sample) => total + sample.total_tokens, 0),
    total_duration_ms: samples.reduce((total, sample) => total + sample.duration_ms, 0),
    retries: samples.reduce((total, sample) => total + sample.retries, 0),
    failure_count: samples.filter((sample) => !sample.succeeded).length,
  });
}

/** Empty usage summary (zero samples). */
export const EMPTY_AGENT_USAGE_SUMMARY: AgentUsageSummary = {
  sample_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  total_duration_ms: 0,
  retries: 0,
  failure_count: 0,
};

/** Fields from one sample that fold into an {@link AgentUsageSummary}. */
export type AgentUsageAccumulationInput = Pick<
  AgentUsageMeterInput,
  "input_tokens" | "output_tokens" | "total_tokens" | "duration_ms" | "retries" | "succeeded"
>;

/**
 * Folds one usage sample into a running summary (same totals as
 * {@link summarizeAgentUsage} over the accumulating set).
 *
 * @param summary - Current aggregate.
 * @param sample - Sample to add.
 * @returns Updated aggregate.
 */
export function accumulateAgentUsageSummary(
  summary: AgentUsageSummary,
  sample: AgentUsageAccumulationInput,
): AgentUsageSummary {
  return agentUsageSummarySchema.parse({
    sample_count: summary.sample_count + 1,
    input_tokens: summary.input_tokens + sample.input_tokens,
    output_tokens: summary.output_tokens + sample.output_tokens,
    total_tokens: summary.total_tokens + sample.total_tokens,
    total_duration_ms: summary.total_duration_ms + sample.duration_ms,
    retries: summary.retries + sample.retries,
    failure_count: summary.failure_count + (sample.succeeded ? 0 : 1),
  });
}

// ---- Unified progress ----

/** Contract marker for the unified progress shape. */
export const UNIFIED_PROGRESS_CONTRACT = "director-progress-v1" as const;

/** Normalized lifecycle state shared by every long-running Director work item. */
export const unifiedProgressStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
/** Normalized lifecycle state. */
export type UnifiedProgressState = z.infer<typeof unifiedProgressStateSchema>;

/** Kind of work item adapted into the unified progress shape. */
export const unifiedProgressKindSchema = z.enum(["production_job", "multi_agent_run", "film_run"]);
/** Adapted work-item kind. */
export type UnifiedProgressKind = z.infer<typeof unifiedProgressKindSchema>;

/**
 * One long-running work item in the unified progress shape. Existing progress
 * fields are adapted into this shape; the source records keep their own richer
 * status machines untouched.
 */
export const unifiedProgressSchema = z
  .strictObject({
    contract: z.literal(UNIFIED_PROGRESS_CONTRACT),
    kind: unifiedProgressKindSchema,
    /** Source record id (job id, run id). */
    id: nonEmptyText(200),
    /** Short human-readable label (job kind, objective excerpt, workflow). */
    label: nonEmptyText(200),
    state: unifiedProgressStateSchema,
    /** Fractional completion in [0, 1]; null when the source reports no numeric progress. */
    progress: z.number().min(0).max(1).nullable(),
    /** Latest human-readable status message from the source record, when any. */
    message: z.string().max(2_000).nullable(),
    /** Source-native status string preserved verbatim for drill-down. */
    source_status: nonEmptyText(80),
    created_at: z.string(),
    updated_at: z.string(),
    /**
     * Durable per-scope film-run usage (`film-llm` / `film-image` /
     * `film-video` / `film-tts`). Only film_run entries may carry this;
     * omitted when the run has no metered samples yet so Agents/UI do not
     * invent a second meter. Shape matches `filmRunUsageSchema` without
     * importing it (that module imports this file); `film-tts` defaults to
     * zeros for entries projected before speech metering existed.
     */
    usage: z
      .strictObject({
        "film-llm": agentUsageSummarySchema,
        "film-image": agentUsageSummarySchema,
        "film-video": agentUsageSummarySchema,
        "film-tts": agentUsageSummarySchema.default(() => ({ ...EMPTY_AGENT_USAGE_SUMMARY })),
      })
      .optional(),
  })
  .superRefine((entry, context) => {
    if (entry.usage !== undefined && entry.kind !== "film_run") {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "usage is only valid on film_run unified progress entries",
      });
    }
  });
/** One unified progress entry. */
export type UnifiedProgress = z.infer<typeof unifiedProgressSchema>;

/**
 * Lightweight aggregate over unified progress entries: exhaustive
 * (zero-filled) counts per lifecycle state and per work-item kind.
 */
export const unifiedProgressSummarySchema = z.strictObject({
  entry_count: z.number().int().nonnegative(),
  by_state: z.record(unifiedProgressStateSchema, z.number().int().nonnegative()),
  by_kind: z.record(unifiedProgressKindSchema, z.number().int().nonnegative()),
});
/** Aggregated unified progress counts. */
export type UnifiedProgressSummary = z.infer<typeof unifiedProgressSummarySchema>;

/**
 * Aggregates unified progress entries into exhaustive per-state and
 * per-kind counts (every enum key present, zero-filled).
 *
 * @param entries - The unified progress entries to count.
 * @returns The validated aggregate.
 */
export function summarizeUnifiedProgress(entries: readonly UnifiedProgress[]): UnifiedProgressSummary {
  const byState = Object.fromEntries(unifiedProgressStateSchema.options.map((state) => [state, 0])) as Record<
    UnifiedProgressState,
    number
  >;
  const byKind = Object.fromEntries(unifiedProgressKindSchema.options.map((kind) => [kind, 0])) as Record<
    UnifiedProgressKind,
    number
  >;
  for (const entry of entries) {
    byState[entry.state] += 1;
    byKind[entry.kind] += 1;
  }
  return unifiedProgressSummarySchema.parse({ entry_count: entries.length, by_state: byState, by_kind: byKind });
}

/**
 * Adapts a durable production job (video, image, audio, 3D, media, DCC
 * export/import, episode packaging) into the unified progress shape.
 */
export function productionJobToUnifiedProgress(job: ProductionJobRecord): UnifiedProgress {
  const state: UnifiedProgressState =
    job.status === "queued"
      ? "queued"
      : job.status === "running"
        ? "running"
        : job.status === "succeeded"
          ? "succeeded"
          : job.status === "failed"
            ? "failed"
            : job.status === "cancelled"
              ? "cancelled"
              : job.status === "reconciling"
                ? "waiting"
                : "unknown";
  return unifiedProgressSchema.parse({
    contract: UNIFIED_PROGRESS_CONTRACT,
    kind: "production_job",
    id: job.id,
    label: job.kind,
    state,
    progress: isTerminalProductionJobStatus(job.status)
      ? job.status === "succeeded"
        ? 1
        : job.progress
      : job.progress,
    message: job.message ?? null,
    source_status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  });
}

/**
 * Structural view of a multi-agent production run. Declared structurally so
 * the protocol package does not depend on the agent-engine package; the
 * gateway passes its `ProductionRun` records directly.
 */
export type MultiAgentRunProgressSource = {
  id: string;
  objective: string;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
  nodes: ReadonlyArray<{ status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "stale" }>;
  createdAt: string;
  updatedAt: string;
};

/** Adapts a multi-agent production run into the unified progress shape. */
export function multiAgentRunToUnifiedProgress(run: MultiAgentRunProgressSource): UnifiedProgress {
  const state: UnifiedProgressState =
    run.status === "queued"
      ? "queued"
      : run.status === "running"
        ? "running"
        : run.status === "waiting_approval"
          ? "waiting"
          : run.status === "completed"
            ? "succeeded"
            : run.status === "failed"
              ? "failed"
              : run.status === "cancelled"
                ? "cancelled"
                : "unknown";
  const settled = run.nodes.filter(
    (node) => node.status === "succeeded" || node.status === "failed" || node.status === "cancelled",
  ).length;
  return unifiedProgressSchema.parse({
    contract: UNIFIED_PROGRESS_CONTRACT,
    kind: "multi_agent_run",
    id: run.id,
    label: run.objective.slice(0, 200),
    state,
    progress: run.nodes.length ? settled / run.nodes.length : null,
    message: null,
    source_status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  });
}

/** Adapts a durable film pipeline run into the unified progress shape. */
export function filmRunToUnifiedProgress(run: FilmRun): UnifiedProgress {
  const state: UnifiedProgressState =
    run.status === "queued"
      ? "queued"
      : run.status === "running"
        ? "running"
        : run.status === "waiting_approval"
          ? "waiting"
          : run.status === "completed"
            ? "succeeded"
            : run.status === "failed"
              ? "failed"
              : "cancelled";
  const usage = run.usage;
  const hasUsage = Boolean(
    usage &&
    (usage["film-llm"].sample_count > 0 ||
      usage["film-image"].sample_count > 0 ||
      usage["film-video"].sample_count > 0 ||
      usage["film-tts"].sample_count > 0),
  );
  return unifiedProgressSchema.parse({
    contract: UNIFIED_PROGRESS_CONTRACT,
    kind: "film_run",
    id: run.id,
    label: run.workflow,
    state,
    // Shared with the film run receipt (filmRunProgress): phase floor plus
    // durable scene completion inside plan-scenes / render.
    progress: filmRunProgress(run),
    message: run.events.at(-1)?.message ?? null,
    source_status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    ...(hasUsage && usage ? { usage } : {}),
  });
}
