import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { captureReconstructionJobInputSchema } from "../../../packages/protocol/src/captureReconstructionProtocol";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobIdempotencyConflictError, ProductionJobStore } from "../jobs/productionJobStore";
import type { CaptureReconstructionExecutor } from "../reconstruction/captureReconstructionExecutor";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies required by the capture reconstruction route handler. */
export type CaptureReconstructionRouteDependencies = {
  /** Parses the request body into a JSON-compatible value. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The production job store for enqueuing and querying jobs. */
  store: ProductionJobStore;
  /** The capture reconstruction executor, or null if not configured. */
  executor: CaptureReconstructionExecutor | null;
  /** Factory that generates unique job identifiers. */
  createJobId: () => string;
  /** Optional callback for errors that occur in background job execution. */
  onBackgroundError?: (error: unknown) => void;
};

const submitRequestSchema = z.strictObject({
  input: captureReconstructionJobInputSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
});

const EXECUTOR_UNAVAILABLE = {
  code: "scene_reconstruct_executor_unavailable",
  message:
    "采集重建执行器未配置。请启动完整的 Director 网关，并确认已安装带 numpy/pillow/trimesh 的 Python 3.11+（可用 DIRECTOR_SCENERECON_PYTHON 指定解释器）。",
  retryable: false,
} as const;

function jobId(pathname: string, suffix = "") {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^\\/api\\/reconstruction\\/capture\\/jobs\\/([^/]+)${escaped}$`));
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Handles HTTP routes for capture-based scene reconstruction jobs.
 *
 * Routes:
 * - `POST /api/reconstruction/capture/jobs` — submit a new reconstruction job.
 * - `GET /api/reconstruction/capture/jobs` — list recent reconstruction jobs.
 * - `GET /api/reconstruction/capture/jobs/:id` — get a single job status.
 * - `GET /api/reconstruction/capture/jobs/:id/plan` — get the reconstruction plan.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The route dependencies.
 * @returns True if the route was handled, false otherwise.
 */
export async function handleCaptureReconstructionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: CaptureReconstructionRouteDependencies,
): Promise<boolean> {
  const { json, store, executor } = dependencies;

  if (request.method === "POST" && url.pathname === "/api/reconstruction/capture/jobs") {
    const parsed = submitRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { message: "采集重建请求格式无效", issues: parsed.error.issues });
      return true;
    }
    if (!executor) {
      json(response, 503, EXECUTOR_UNAVAILABLE);
      return true;
    }
    let job: ProductionJobRecord;
    try {
      job = await store.enqueue({
        kind: "scene.reconstruct",
        input: parsed.data.input,
        idempotencyKey: parsed.data.idempotencyKey,
        createId: dependencies.createJobId,
      });
    } catch (error) {
      if ((error as ProductionJobIdempotencyConflictError).code === "production_job_idempotency_conflict") {
        json(response, 409, {
          code: "production_job_idempotency_conflict",
          message: (error as Error).message,
          existingJobId: (error as ProductionJobIdempotencyConflictError).existingJobId,
        });
        return true;
      }
      throw error;
    }
    void executor.execute(job).catch((error) => dependencies.onBackgroundError?.(error));
    json(response, 202, { job: productionJobRecordSchema.parse(job) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/reconstruction/capture/jobs") {
    const jobs = await store.list(["scene.reconstruct"]);
    json(response, 200, { jobs: jobs.slice(0, 50) });
    return true;
  }

  const planJobId = jobId(url.pathname, "/plan");
  if (request.method === "GET" && planJobId) {
    const job = await store.get(planJobId);
    if (!job || job.kind !== "scene.reconstruct") {
      json(response, 404, { message: "采集重建任务不存在" });
      return true;
    }
    if (!executor) {
      json(response, 503, EXECUTOR_UNAVAILABLE);
      return true;
    }
    if (job.status !== "succeeded") {
      json(response, 409, { code: "job_not_succeeded", message: `任务当前状态为 ${job.status}`, job });
      return true;
    }
    const plan = await executor.readPlan(job);
    if (!plan) {
      json(response, 404, { message: "该任务没有可用的重建计划工件" });
      return true;
    }
    json(response, 200, { plan });
    return true;
  }

  const statusJobId = jobId(url.pathname);
  if (request.method === "GET" && statusJobId) {
    const job = await store.get(statusJobId);
    if (!job || job.kind !== "scene.reconstruct") {
      json(response, 404, { message: "采集重建任务不存在" });
      return true;
    }
    json(response, 200, { job: productionJobRecordSchema.parse(job) });
    return true;
  }

  return false;
}
