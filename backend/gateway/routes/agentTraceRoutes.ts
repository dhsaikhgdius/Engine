import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  agentTraceSourceSchema,
  filmRunToUnifiedProgress,
  multiAgentRunToUnifiedProgress,
  productionJobToUnifiedProgress,
  summarizeAgentUsage,
  unifiedProgressKindSchema,
  type MultiAgentRunProgressSource,
  type UnifiedProgress,
} from "../../../packages/protocol/src/agentObservabilityProtocol";
import type { FilmRun } from "../../../packages/protocol/src/filmPipelineProtocol";
import type { ProductionJobRecord } from "../../../packages/protocol/src/productionJobProtocol";
import type { AgentTraceStore } from "../agents/agentTraceStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies required by the agent observability route handler. */
export type AgentTraceRouteDependencies = {
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The trace and usage store. */
  store: AgentTraceStore;
  /** Lists durable production jobs (video, generation, media, DCC export, …). */
  listProductionJobs: () => Promise<ProductionJobRecord[]>;
  /** Lists multi-agent production runs. */
  listMultiAgentRuns: () => Promise<MultiAgentRunProgressSource[]>;
  /** Lists durable film pipeline runs. */
  listFilmRuns: () => Promise<FilmRun[]>;
};

const limitSchema = z.coerce.number().int().min(1).max(500);

const traceQuerySchema = z.object({
  session_id: z.string().trim().min(1).max(160).optional(),
  source: agentTraceSourceSchema.optional(),
  tool: z.string().trim().min(1).max(160).optional(),
  limit: limitSchema.optional(),
});

const usageQuerySchema = z.object({
  scope: z.string().trim().min(1).max(160).optional(),
  limit: limitSchema.optional(),
});

const progressQuerySchema = z.object({
  kind: unifiedProgressKindSchema.optional(),
  limit: limitSchema.optional(),
});

function queryObject(url: URL) {
  return Object.fromEntries(url.searchParams.entries());
}

/**
 * Handles HTTP routes for agent observability (roadmap M5).
 *
 * Routes:
 * - `GET /api/agent/traces` — recent tool-call trace events, newest first.
 * - `GET /api/agent/traces/summary` — reconstructed tool-chain summary for one
 *   session (`session_id` query) or the most recent session.
 * - `GET /api/agent/usage` — model usage samples plus a token/latency/retry aggregate.
 * - `GET /api/agent/progress` — unified progress for production jobs,
 *   multi-agent runs, and film runs, newest first.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The route dependencies.
 * @returns True if the route was handled, false otherwise.
 */
export async function handleAgentTraceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: AgentTraceRouteDependencies,
): Promise<boolean> {
  const { json, store, listProductionJobs, listMultiAgentRuns, listFilmRuns } = dependencies;
  if (request.method !== "GET") return false;

  if (url.pathname === "/api/agent/traces") {
    const query = traceQuerySchema.safeParse(queryObject(url));
    if (!query.success) {
      json(response, 400, { error: "Trace 查询参数无效", code: "invalid_trace_query" });
      return true;
    }
    const events = await store.list({
      sessionId: query.data.session_id,
      source: query.data.source,
      tool: query.data.tool,
      limit: query.data.limit,
    });
    json(response, 200, { events });
    return true;
  }

  if (url.pathname === "/api/agent/traces/summary") {
    const query = traceQuerySchema.safeParse(queryObject(url));
    if (!query.success) {
      json(response, 400, { error: "Trace 查询参数无效", code: "invalid_trace_query" });
      return true;
    }
    const summary = await store.summarizeSession(query.data.session_id);
    if (!summary) {
      json(response, 404, { error: "没有可回放的 Agent 会话轨迹", code: "trace_session_not_found" });
      return true;
    }
    json(response, 200, { summary });
    return true;
  }

  if (url.pathname === "/api/agent/usage") {
    const query = usageQuerySchema.safeParse(queryObject(url));
    if (!query.success) {
      json(response, 400, { error: "Usage 查询参数无效", code: "invalid_usage_query" });
      return true;
    }
    const samples = await store.listUsage({ scope: query.data.scope, limit: query.data.limit });
    json(response, 200, { samples, summary: summarizeAgentUsage(samples) });
    return true;
  }

  if (url.pathname === "/api/agent/progress") {
    const query = progressQuerySchema.safeParse(queryObject(url));
    if (!query.success) {
      json(response, 400, { error: "Progress 查询参数无效", code: "invalid_progress_query" });
      return true;
    }
    const [jobs, runs, filmRuns] = await Promise.all([listProductionJobs(), listMultiAgentRuns(), listFilmRuns()]);
    const entries: UnifiedProgress[] = [
      ...jobs.map(productionJobToUnifiedProgress),
      ...runs.map(multiAgentRunToUnifiedProgress),
      ...filmRuns.map(filmRunToUnifiedProgress),
    ]
      .filter((entry) => !query.data.kind || entry.kind === query.data.kind)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, query.data.limit ?? 100);
    json(response, 200, { entries });
    return true;
  }

  return false;
}
