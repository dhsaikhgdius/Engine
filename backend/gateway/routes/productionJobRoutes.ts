import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  enqueueCanvasJobRequestSchema,
  enqueueProductionJobRequestSchema,
  productionJobArtifactSchema,
  productionJobErrorSchema,
  productionJobRecordSchema,
  transitionProductionJob,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import { projectProductionJobReceipt } from "../../../packages/protocol/src/productionJobReceipt";
import {
  executeCanvasImageJob,
  ProductionJobIdempotencyConflictError,
  type ProductionJobStore,
} from "../jobs/productionJobStore";
import { registerProductionJobArtifactVersions } from "../artifacts/productionJobArtifactBridge";
import type { ProductionArtifactStore } from "../artifacts/productionArtifactStore";

/**
 * HTTP routes for the unified production job store (`/api/production-jobs`
 * plus the legacy `/api/canvas-jobs` compatibility alias): enqueueing,
 * listing, reconciliation, receipts, artifact-version registration, artifact
 * byte serving, and content-addressed media-input staging.
 *
 * Honesty contracts enforced here:
 * - Enqueueing a kind whose local executor is not configured is refused up
 *   front with a 503 carrying setup instructions, and already-queued jobs of
 *   such kinds are failed deterministically on the next listing rather than
 *   sitting "queued" forever.
 * - Artifact bytes may be reclaimed by retention while the job record
 *   remains; requests for absent bytes answer 410 with the sha256/metadata
 *   evidence, never a 404 that would imply the job did not exist.
 * - Every job response is paired with a live receipt whose storage-presence
 *   flags are checked against the real backend at response time.
 */

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

const ARTIFACT_BYTES_UNAVAILABLE = {
  code: "artifact_bytes_unavailable",
  message:
    "制品字节已不可用（可能已被保留策略回收）；任务回执上的 sha256 / 元数据与 immutable ArtifactVersion 证据仍保留。",
} as const;

// The receipt's storage-presence flags are measured against the live backend
// per request, so a reclaimed artifact is reported absent immediately.
async function projectLiveProductionJobReceipt(store: ProductionJobStore, job: ProductionJobRecord) {
  const artifactStoragePresence = new Map<string, "present" | "absent">();
  await Promise.all(
    job.artifacts.map(async (artifact) => {
      artifactStoragePresence.set(
        artifact.id,
        (await store.artifactBytesPresent(job, artifact)) ? "present" : "absent",
      );
    }),
  );
  return projectProductionJobReceipt(job, { artifactStoragePresence });
}

function isEnoent(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Injected store, executors, and staging/evidence stores for the routes. */
export type ProductionJobRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  store: ProductionJobStore;
  createJobId: () => string;
  executeCanvasImage?: typeof executeCanvasImageJob;
  /** ffmpeg executor for media.transcode / media.proxy. */
  mediaTranscode?: { execute: (job: ProductionJobRecord) => Promise<unknown> };
  /** Python worker executor for scene.reconstruct capture reconstruction. */
  captureReconstruction?: { execute: (job: ProductionJobRecord) => Promise<unknown> };
  /** Content-addressed staging store backing the media-inputs upload endpoint. */
  mediaInputs?: {
    maxInputBytes: number;
    put: (bytes: Uint8Array, expectedSha256: string) => Promise<{ sha256: string; bytes: number }>;
  };
  /** Immutable evidence store backing job → ArtifactVersion registration. */
  artifactVersions?: ProductionArtifactStore;
  onBackgroundError?: (error: unknown) => void;
};

const reconcileRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("begin") }),
  z.strictObject({
    action: z.literal("resolve"),
    status: z.enum(["succeeded", "failed", "queued"]),
    message: z.string().trim().min(1).max(12000).optional(),
    error: productionJobErrorSchema.optional(),
    artifact: productionJobArtifactSchema.optional(),
  }),
]);

// Per-store set of job ids currently executing in-process, so a double
// enqueue/replay cannot start the same job twice concurrently.
const runningJobsByStore = new WeakMap<ProductionJobStore, Set<string>>();
const MEDIA_EXECUTOR_UNAVAILABLE = {
  code: "media_transcode_executor_unavailable",
  message:
    "媒体转码执行器未配置。请启动完整的 Director 网关，并确认已安装 ffmpeg 与 ffprobe；如使用自定义路径，请设置 DIRECTOR_FFMPEG_PATH 和 DIRECTOR_FFPROBE_PATH 后重启网关。",
  retryable: false,
} as const;
const RECONSTRUCTION_EXECUTOR_UNAVAILABLE = {
  code: "scene_reconstruct_executor_unavailable",
  message:
    "采集重建执行器未配置。请启动完整的 Director 网关，并确认已安装带 numpy/pillow/trimesh 的 Python 3.11+（可用 DIRECTOR_SCENERECON_PYTHON 指定解释器）。",
  retryable: false,
} as const;

function requiresMediaTranscodeExecutor(job: Pick<ProductionJobRecord, "kind">) {
  return job.kind === "media.transcode" || job.kind === "media.proxy";
}

function runningJobsFor(store: ProductionJobStore) {
  let jobs = runningJobsByStore.get(store);
  if (!jobs) {
    jobs = new Set<string>();
    runningJobsByStore.set(store, jobs);
  }
  return jobs;
}

/**
 * Detached in-process executor dispatch. Kinds with a local executor run
 * here; anything else stays queued for its registered worker. All failure
 * paths fold back onto the durable job record — see the catch below.
 */
async function runJob(dependencies: ProductionJobRouteDependencies, jobId: string) {
  const runningJobs = runningJobsFor(dependencies.store);
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  try {
    const job = await dependencies.store.get(jobId);
    if (!job || job.status !== "queued") return;
    // canvas.image and the ffmpeg-backed media kinds run in-process; other
    // unified kinds stay queued for their registered local/remote worker.
    if (job.kind === "canvas.image") {
      await (dependencies.executeCanvasImage ?? executeCanvasImageJob)(dependencies.store, job);
    } else if ((job.kind === "media.transcode" || job.kind === "media.proxy") && dependencies.mediaTranscode) {
      // media.proxy is executed as a preset of media.transcode by the same executor.
      await dependencies.mediaTranscode.execute(job);
    } else if (job.kind === "scene.reconstruct" && dependencies.captureReconstruction) {
      await dependencies.captureReconstruction.execute(job);
    }
  } catch (error) {
    // A detached executor must never create an unhandled rejection or leave a
    // locally-known failure looking healthy. If it failed before marking the
    // attempt as running, start and fail that same attempt deterministically.
    try {
      let job = await dependencies.store.get(jobId);
      if (job?.status === "queued") {
        job = await dependencies.store.update(transitionProductionJob(job, "running", { message: "Executor started" }));
      }
      if (job?.status === "running") {
        const message = error instanceof Error ? error.message : "Production job executor failed";
        await dependencies.store.update(
          transitionProductionJob(job, "failed", {
            message: "Executor failed",
            error: message,
            structuredError: {
              code: "local_executor_failed",
              message,
              retryable: true,
            },
          }),
        );
      }
    } catch {
      // Recovery is best-effort; the original error remains the useful signal.
    }
    try {
      dependencies.onBackgroundError?.(error);
    } catch {
      // Observability callbacks cannot be allowed to reject detached work.
    }
  } finally {
    runningJobs.delete(jobId);
  }
}

// Jobs queued for a local executor that this gateway does not have would
// otherwise look "queued" forever; fail them with the setup instructions so
// the task tray reflects reality.
async function failQueuedJobsWithoutLocalExecutor(dependencies: ProductionJobRouteDependencies) {
  if (dependencies.mediaTranscode && dependencies.captureReconstruction) return;
  const queued = (await dependencies.store.list()).filter(
    (job) =>
      job.status === "queued" &&
      ((!dependencies.mediaTranscode && requiresMediaTranscodeExecutor(job)) ||
        (!dependencies.captureReconstruction && job.kind === "scene.reconstruct")),
  );
  for (const job of queued) {
    const unavailable =
      job.kind === "scene.reconstruct" ? RECONSTRUCTION_EXECUTOR_UNAVAILABLE : MEDIA_EXECUTOR_UNAVAILABLE;
    const message =
      job.kind === "scene.reconstruct"
        ? "Capture reconstruction executor unavailable"
        : "Media transcode executor unavailable";
    const running = await dependencies.store.update(transitionProductionJob(job, "running", { progress: 0, message }));
    await dependencies.store.update(
      transitionProductionJob(running, "failed", {
        progress: 0,
        message,
        error: unavailable.message,
        structuredError: unavailable,
      }),
    );
  }
}

const mediaInputQuerySchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const listJobsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Streams the upload with the byte cap enforced on both the declared
// Content-Length and the actual received bytes.
async function readRawMediaBody(request: IncomingMessage, maximumBytes: number) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new RangeError("Media input is too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = new Uint8Array(Buffer.from(chunk));
    size += bytes.byteLength;
    if (size > maximumBytes) throw new RangeError("Media input is too large");
    chunks.push(bytes);
  }
  if (!size) throw new TypeError("Media input is empty");
  const joined = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return joined;
}

/**
 * Stages raw source bytes for media.transcode / media.proxy jobs. The store is
 * content-addressed, so re-uploading the same bytes is idempotent and the
 * returned sourceMediaId (ending in sha256:<hex>) is what job inputs reference.
 */
async function stageMediaInput(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: ProductionJobRouteDependencies,
) {
  const { json, mediaInputs } = dependencies;
  if (!mediaInputs) {
    json(response, 503, { code: "media_inputs_not_configured", message: "Media input staging 未配置" });
    return;
  }
  const parsed = mediaInputQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    json(response, 400, { message: "Media input 查询参数无效", issues: parsed.error.issues });
    return;
  }
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (
    !contentType.startsWith("video/") &&
    !contentType.startsWith("audio/") &&
    contentType !== "application/octet-stream"
  ) {
    json(response, 415, { message: "Media input 必须是视频、音频或 application/octet-stream" });
    return;
  }
  try {
    const bytes = await readRawMediaBody(request, mediaInputs.maxInputBytes);
    const staged = await mediaInputs.put(bytes, parsed.data.sha256);
    json(response, 200, {
      input: { sourceMediaId: `media-input:sha256:${staged.sha256}`, sha256: staged.sha256, bytes: staged.bytes },
    });
  } catch (error) {
    json(response, error instanceof RangeError ? 413 : 400, {
      message: error instanceof Error ? error.message : "Media input 上传失败",
    });
  }
}

/** Extracts the job id from canvas-jobs/production-jobs paths (both aliases). */
function routeJobId(pathname: string, suffix = "") {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^\\/api\\/(?:canvas|production)-jobs\\/([^/]+)${escapedSuffix}$`));
  return match ? decodeURIComponent(match[1]!) : null;
}

// Shared enqueue path for both the canvas compatibility route (narrower
// request schema) and the unified production-jobs route.
async function enqueueJob(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ProductionJobRouteDependencies,
  canvasCompatibilityRoute: boolean,
) {
  const parsed = (
    canvasCompatibilityRoute ? enqueueCanvasJobRequestSchema : enqueueProductionJobRequestSchema
  ).safeParse(await dependencies.readBody(request));
  if (!parsed.success) {
    dependencies.json(response, 400, {
      message: canvasCompatibilityRoute ? "Canvas job 请求格式无效" : "Production job 请求格式无效",
      issues: parsed.error.issues,
    });
    return;
  }
  if (requiresMediaTranscodeExecutor(parsed.data) && !dependencies.mediaTranscode) {
    dependencies.json(response, 503, MEDIA_EXECUTOR_UNAVAILABLE);
    return;
  }
  if (parsed.data.kind === "scene.reconstruct" && !dependencies.captureReconstruction) {
    dependencies.json(response, 503, RECONSTRUCTION_EXECUTOR_UNAVAILABLE);
    return;
  }
  try {
    const job = await dependencies.store.enqueue({ ...parsed.data, createId: dependencies.createJobId });
    void runJob(dependencies, job.id);
    const parsedJob = productionJobRecordSchema.parse(job);
    dependencies.json(response, 202, {
      job: parsedJob,
      receipt: await projectLiveProductionJobReceipt(dependencies.store, parsedJob),
    });
  } catch (error) {
    if (error instanceof ProductionJobIdempotencyConflictError) {
      dependencies.json(response, 409, {
        code: error.code,
        message: error.message,
        existingJobId: error.existingJobId,
      });
      return;
    }
    throw error;
  }
}

/** Routes one request; returns false for URLs outside the job route space. */
export async function handleProductionJobRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: ProductionJobRouteDependencies,
): Promise<boolean> {
  const { json, store } = dependencies;

  if (request.method === "POST" && url.pathname === "/api/canvas-jobs") {
    await enqueueJob(request, response, dependencies, true);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/production-jobs") {
    await enqueueJob(request, response, dependencies, false);
    return true;
  }

  // Read-only listing across every job kind; per-kind routes keep their own
  // scoped listings, this one backs global surfaces such as the task tray.
  if (request.method === "GET" && url.pathname === "/api/production-jobs") {
    const parsedQuery = listJobsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsedQuery.success) {
      json(response, 400, { message: "Production job 列表查询参数无效", issues: parsedQuery.error.issues });
      return true;
    }
    await failQueuedJobsWithoutLocalExecutor(dependencies);
    const jobs = (await store.list()).slice(0, parsedQuery.data.limit);
    json(response, 200, { jobs });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/production-jobs/media-inputs") {
    await stageMediaInput(request, response, url, dependencies);
    return true;
  }

  const reconcileJobId = routeJobId(url.pathname, "/reconcile");
  if (request.method === "POST" && reconcileJobId) {
    const parsed = reconcileRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { message: "Production job reconcile 请求格式无效", issues: parsed.error.issues });
      return true;
    }
    let job;
    try {
      job =
        parsed.data.action === "begin"
          ? await store.beginReconciliation(reconcileJobId)
          : await store.resolveReconciliation(reconcileJobId, parsed.data);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid production job transition")) {
        json(response, 409, { code: "invalid_production_job_transition", message: error.message });
        return true;
      }
      throw error;
    }
    if (!job) {
      json(response, 404, { message: "Production job 不存在" });
      return true;
    }
    const reconciled = productionJobRecordSchema.parse(job);
    json(response, 200, {
      job: reconciled,
      receipt: await projectLiveProductionJobReceipt(store, reconciled),
    });
    return true;
  }

  // The normalized, kind-independent receipt every control surface shares.
  const receiptJobId = routeJobId(url.pathname, "/receipt");
  if (request.method === "GET" && receiptJobId) {
    const job = await store.get(receiptJobId);
    if (!job) {
      json(response, 404, { message: "Production job 不存在" });
      return true;
    }
    json(response, 200, {
      receipt: await projectLiveProductionJobReceipt(store, productionJobRecordSchema.parse(job)),
    });
    return true;
  }

  // Registers a succeeded job's immutable outputs as director_production
  // artifact versions. Replaying the registration is idempotent.
  const artifactVersionsJobId = routeJobId(url.pathname, "/artifact-versions");
  if (request.method === "POST" && artifactVersionsJobId) {
    if (!dependencies.artifactVersions) {
      json(response, 503, {
        code: "artifact_version_store_unavailable",
        message: "Production artifact 版本库未配置",
      });
      return true;
    }
    const job = await store.get(artifactVersionsJobId);
    if (!job) {
      json(response, 404, { message: "Production job 不存在" });
      return true;
    }
    if (job.status !== "succeeded") {
      json(response, 409, {
        code: "job_not_succeeded",
        message: `只有 succeeded 状态的任务可以登记产物版本；当前状态为 ${job.status}`,
      });
      return true;
    }
    try {
      const registrations = await registerProductionJobArtifactVersions(dependencies.artifactVersions, job);
      json(response, 200, {
        registrations: registrations.map((registration) => ({
          version: registration.version,
          replayed: registration.replayed,
        })),
        receipt: await projectLiveProductionJobReceipt(store, productionJobRecordSchema.parse(job)),
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "artifact_conflict" || code === "artifact_validation_error") {
        json(response, code === "artifact_conflict" ? 409 : 400, {
          code,
          message: (error as Error).message,
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  const artifactByIdMatch = url.pathname.match(/^\/api\/(?:canvas|production)-jobs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (request.method === "GET" && artifactByIdMatch) {
    const job = await store.get(decodeURIComponent(artifactByIdMatch[1]!));
    const artifactId = decodeURIComponent(artifactByIdMatch[2]!);
    const artifact = job?.artifacts.find((candidate) => candidate.id === artifactId);
    if (!job || !artifact) {
      json(response, 404, { message: "Production job artifact 不可用" });
      return true;
    }
    if (!(await store.artifactBytesPresent(job, artifact))) {
      json(response, 410, {
        ...ARTIFACT_BYTES_UNAVAILABLE,
        jobId: job.id,
        artifactId: artifact.id,
        sha256: artifact.sha256,
      });
      return true;
    }
    try {
      const bytes = await store.readArtifact(job, artifact);
      response.writeHead(200, {
        "Content-Type": artifact.mimeType,
        "Content-Length": bytes.byteLength,
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch (error) {
      if (isEnoent(error)) {
        json(response, 410, {
          ...ARTIFACT_BYTES_UNAVAILABLE,
          jobId: job.id,
          artifactId: artifact.id,
          sha256: artifact.sha256,
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  // Compatibility endpoint: return the promoted/primary artifact of the job.
  const compatibilityArtifactJobId = routeJobId(url.pathname, "/artifact");
  if (request.method === "GET" && compatibilityArtifactJobId) {
    const job = await store.get(compatibilityArtifactJobId);
    if (!job?.artifact) {
      json(response, 404, { message: "Canvas job artifact 不可用" });
      return true;
    }
    if (!(await store.artifactBytesPresent(job, job.artifact))) {
      json(response, 410, {
        ...ARTIFACT_BYTES_UNAVAILABLE,
        jobId: job.id,
        artifactId: job.artifact.id,
        sha256: job.artifact.sha256,
      });
      return true;
    }
    try {
      const bytes = await store.readArtifact(job, job.artifact);
      response.writeHead(200, {
        "Content-Type": job.artifact.mimeType,
        "Content-Length": bytes.byteLength,
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch (error) {
      if (isEnoent(error)) {
        json(response, 410, {
          ...ARTIFACT_BYTES_UNAVAILABLE,
          jobId: job.id,
          artifactId: job.artifact.id,
          sha256: job.artifact.sha256,
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  const statusJobId = routeJobId(url.pathname);
  if (request.method === "GET" && statusJobId) {
    const job = await store.get(statusJobId);
    if (!job) {
      json(response, 404, { message: "Production job 不存在" });
      return true;
    }
    const parsedJob = productionJobRecordSchema.parse(job);
    json(response, 200, {
      job: parsedJob,
      receipt: await projectLiveProductionJobReceipt(store, parsedJob),
    });
    return true;
  }

  return false;
}
