import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createFilmRunRequestSchema,
  type FilmPipelineAvailability,
  type FilmPipelineCapabilities,
  type FilmPipelinePublicErrorCode,
  type FilmRun,
} from "../../../packages/protocol/src/filmPipelineProtocol";
import { projectFilmRunReceipt } from "../../../packages/protocol/src/filmRunReceipt";
import type { FilmPipelineOrchestrator } from "../film/filmPipelineOrchestrator";
import type { FilmRunStore } from "../film/filmRunStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/**
 * Projects the run's receipt with live artifact byte presence: the claimed
 * final-video/timeline paths are probed at read time so receipts never
 * over-claim artifacts whose bytes were cleaned up after the run finished
 * (mirrors the live production-job receipt projection).
 */
async function projectLiveFilmRunReceipt(store: FilmRunStore, run: FilmRun) {
  return projectFilmRunReceipt(run, { artifactStoragePresence: await store.artifactStoragePresence(run) });
}

export type FilmPipelineRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  store: FilmRunStore;
  /** null while the film providers are not configured. */
  orchestrator: FilmPipelineOrchestrator | null;
  unconfiguredReason?: string;
  /** Optional-capability readiness reported on the list surface (dialogue TTS, stage anchoring). */
  capabilities: FilmPipelineCapabilities;
};

/** Every non-2xx film route response carries one frozen public error code. */
function errorBody(code: FilmPipelinePublicErrorCode, error: string, extra: Record<string, unknown> = {}) {
  return { error, code, ...extra };
}

export async function handleFilmPipelineRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: FilmPipelineRouteDependencies,
) {
  const { readBody, json, store, orchestrator } = dependencies;
  if (!url.pathname.startsWith("/api/film/runs")) return false;

  // The unconfigured pipeline is an explicit reported state on the list
  // surface, not a hidden 503 that only shows up on writes. Optional
  // capabilities report alongside so agents learn before create whether
  // enableAudio / autoStageAnchors can be honored.
  const pipeline: FilmPipelineAvailability = orchestrator
    ? { configured: true, reason: null, capabilities: dependencies.capabilities }
    : {
        configured: false,
        reason: dependencies.unconfiguredReason ?? "Film pipeline providers 未配置",
        capabilities: dependencies.capabilities,
      };
  const unconfigured = () =>
    json(response, 503, errorBody("film_pipeline_unconfigured", pipeline.reason ?? "Film pipeline providers 未配置"));

  if (request.method === "GET" && url.pathname === "/api/film/runs") {
    json(response, 200, { runs: await store.list(), pipeline });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/film/runs") {
    if (!orchestrator) {
      unconfigured();
      return true;
    }
    const parsed = createFilmRunRequestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, errorBody("invalid_request", "Film run 参数无效", { issues: parsed.error.issues }));
      return true;
    }
    const run = await orchestrator.create(parsed.data);
    json(response, 202, { run, receipt: await projectLiveFilmRunReceipt(store, run) });
    return true;
  }

  const match = url.pathname.match(/^\/api\/film\/runs\/([^/]+)(?:\/(resume|cancel|approve|receipt))?$/);
  if (!match) return false;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    json(response, 400, errorBody("invalid_run_id", "Film run id 编码无效"));
    return true;
  }
  const action = match[2];
  const run = await store.get(id);
  if (!run) {
    json(response, 404, errorBody("run_not_found", "Film run 不存在"));
    return true;
  }
  if (request.method === "GET" && !action) {
    json(response, 200, { run, receipt: await projectLiveFilmRunReceipt(store, run) });
    return true;
  }
  // The normalized receipt every control surface shares (mirrors
  // GET /api/production-jobs/:id/receipt).
  if (request.method === "GET" && action === "receipt") {
    json(response, 200, { receipt: await projectLiveFilmRunReceipt(store, run) });
    return true;
  }
  if (request.method === "POST" && action && action !== "receipt") {
    if (action === "cancel") {
      // Cancel is a pure state transition; it stays available on an
      // unconfigured gateway so stale runs remain controllable.
      const cancelled = orchestrator ? await orchestrator.cancel(id) : await store.markCancelled(id);
      json(response, 200, { run: cancelled, receipt: await projectLiveFilmRunReceipt(store, cancelled) });
      return true;
    }
    if (!orchestrator) {
      unconfigured();
      return true;
    }
    const updated = action === "resume" ? await orchestrator.resume(id) : await orchestrator.approve(id);
    json(response, 202, { run: updated, receipt: await projectLiveFilmRunReceipt(store, updated) });
    return true;
  }
  return false;
}
