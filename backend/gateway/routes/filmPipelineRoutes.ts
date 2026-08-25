import type { IncomingMessage, ServerResponse } from "node:http";
import { createFilmRunRequestSchema } from "../../../packages/protocol/src/filmPipelineProtocol";
import type { FilmPipelineOrchestrator } from "../film/filmPipelineOrchestrator";
import type { FilmRunStore } from "../film/filmRunStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

export type FilmPipelineRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  store: FilmRunStore;
  /** null while the film providers are not configured. */
  orchestrator: FilmPipelineOrchestrator | null;
  unconfiguredReason?: string;
};

export async function handleFilmPipelineRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: FilmPipelineRouteDependencies,
) {
  const { readBody, json, store, orchestrator } = dependencies;
  if (!url.pathname.startsWith("/api/film/runs")) return false;

  if (request.method === "GET" && url.pathname === "/api/film/runs") {
    json(response, 200, { runs: await store.list() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/film/runs") {
    if (!orchestrator) {
      json(response, 503, {
        error: dependencies.unconfiguredReason ?? "Film pipeline providers 未配置",
        code: "film_pipeline_unconfigured",
      });
      return true;
    }
    const parsed = createFilmRunRequestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "Film run 参数无效", code: "invalid_request", issues: parsed.error.issues });
      return true;
    }
    const run = await orchestrator.create(parsed.data);
    json(response, 202, { run });
    return true;
  }

  const match = url.pathname.match(/^\/api\/film\/runs\/([^/]+)(?:\/(resume|cancel|approve))?$/);
  if (!match) return false;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    json(response, 400, { error: "Film run id 编码无效", code: "invalid_run_id" });
    return true;
  }
  const action = match[2];
  const run = await store.get(id);
  if (!run) {
    json(response, 404, { error: "Film run 不存在", code: "run_not_found" });
    return true;
  }
  if (request.method === "GET" && !action) {
    json(response, 200, { run });
    return true;
  }
  if (request.method === "POST" && action) {
    if (!orchestrator) {
      json(response, 503, {
        error: dependencies.unconfiguredReason ?? "Film pipeline providers 未配置",
        code: "film_pipeline_unconfigured",
      });
      return true;
    }
    if (action === "cancel") {
      json(response, 200, { run: await orchestrator.cancel(id) });
      return true;
    }
    if (action === "resume") {
      json(response, 202, { run: await orchestrator.resume(id) });
      return true;
    }
    json(response, 202, { run: await orchestrator.approve(id) });
    return true;
  }
  return false;
}
