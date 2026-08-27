import { randomUUID } from "node:crypto";
import type { VideoProviderCapability } from "../../../../packages/protocol/src/videoGenerationProtocol";
import {
  VideoProviderHttpError,
  parseVideoGenerationRequest,
  parseVideoProviderHealth,
  parseVideoProviderJob,
  type VideoGenerationRequest,
  type VideoProvider,
  type VideoProviderHealth,
  type VideoProviderJob,
} from "./videoProvider";

type FetchLike = typeof fetch;
type WorkflowFactory = (request: VideoGenerationRequest) => unknown | Promise<unknown>;

/** Configuration options for the ComfyUI video provider. */
export interface ComfyUiVideoProviderOptions {
  /** Base URL of the ComfyUI server, including scheme. */
  baseUrl: string;
  /** Factory that builds a ComfyUI workflow payload from a video generation request. */
  workflowFactory: WorkflowFactory;
  /** Optional fetch implementation for HTTP requests. */
  fetchImpl?: FetchLike;
  /** Client identifier sent to ComfyUI; auto-generated when omitted. */
  clientId?: string;
  /** Human-readable model label exposed in the capability report. */
  model?: string;
}

/** In-memory tracking record: Director job plus the ComfyUI prompt id. */
type ComfyJobRecord = {
  job: VideoProviderJob;
  promptId: string;
};

/**
 * Recursively collects video output filenames from a ComfyUI history response.
 *
 * Scans objects and arrays for entries whose key is `"filename"` and whose
 * value ends with a recognised video extension.
 */
function collectOutputs(value: unknown, results = new Set<string>()) {
  if (Array.isArray(value)) value.forEach((entry) => collectOutputs(entry, results));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "filename" && typeof entry === "string" && /\.(mp4|webm|mov)$/i.test(entry)) results.add(entry);
      else collectOutputs(entry, results);
    }
  }
  return [...results];
}

/**
 * A {@link VideoProvider} implementation that submits video generation jobs to
 * a ComfyUI server and polls for completion via the ComfyUI history API.
 */
export class ComfyUiVideoProvider implements VideoProvider {
  /** Provider identifier reported in capabilities and job records. */
  readonly id = "comfyui" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly workflowFactory: WorkflowFactory;
  private readonly clientId: string;
  private readonly model: string | null;
  private readonly jobs = new Map<string, ComfyJobRecord>();
  private readonly idempotency = new Map<string, string>();

  /**
   * Creates a new ComfyUI video provider.
   *
   * @param options - Connection details and workflow factory.
   * @throws When the base URL does not use the http or https scheme.
   */
  constructor(options: ComfyUiVideoProviderOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new Error("ComfyUI URL must use http or https");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.workflowFactory = options.workflowFactory;
    this.clientId = options.clientId ?? `director-${randomUUID()}`;
    this.model = options.model?.trim() || null;
  }

  /**
   * Returns the provider's static capability declaration.
   *
   * @returns A capability object describing this provider's supported features.
   */
  async capabilities(): Promise<VideoProviderCapability> {
    return {
      id: this.id,
      label: "ComfyUI video workflow",
      configured: true,
      supportsImageConditioning: true,
      supportsAudio: true,
      supportsNegativePrompt: true,
      dimensionMultiple: null,
      frameCountRule: "any",
      model: this.model,
    };
  }

  /**
   * Probes the ComfyUI server health by fetching system stats.
   *
   * @param signal - Optional abort signal to cancel the HTTP request.
   * @returns A health report indicating readiness or degradation.
   */
  async health(signal?: AbortSignal): Promise<VideoProviderHealth> {
    const response = await this.fetchImpl(`${this.baseUrl}/system_stats`, { signal });
    return parseVideoProviderHealth({
      provider: this.id,
      status: response.ok ? "ready" : "degraded",
      modelLoaded: response.ok,
      activeJobId: null,
      detail: response.ok ? null : `ComfyUI returned HTTP ${response.status}`,
    });
  }

  /**
   * Submits a video generation request to ComfyUI.
   *
   * Idempotent: if the same idempotency key was already submitted, the
   * existing job is returned instead of creating a duplicate.
   *
   * @param rawRequest - The generation request with prompt, dimensions, and conditioning.
   * @param signal - Optional abort signal to cancel the HTTP request.
   * @returns The created or previously cached job record.
   * @throws {@link VideoProviderHttpError} When the ComfyUI API returns an error.
   */
  async submit(rawRequest: VideoGenerationRequest, signal?: AbortSignal): Promise<VideoProviderJob> {
    const request = parseVideoGenerationRequest(rawRequest);
    const existing = this.idempotency.get(request.idempotencyKey);
    if (existing) return this.getJob(existing, signal);
    const workflow = await this.workflowFactory(request);
    const response = await this.fetchImpl(`${this.baseUrl}/prompt`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    const body = (await response.json().catch(() => null)) as { prompt_id?: unknown; error?: unknown } | null;
    if (!response.ok || typeof body?.prompt_id !== "string") {
      throw new VideoProviderHttpError(
        typeof body?.error === "string" ? body.error : `ComfyUI returned HTTP ${response.status}`,
        response.status,
        response.status >= 500 || response.status === 429,
        body,
      );
    }
    const now = new Date().toISOString();
    const jobId = `video-comfy-${body.prompt_id.replace(/[^a-z0-9-]/gi, "").slice(0, 60)}`;
    const job = parseVideoProviderJob({
      id: jobId,
      provider: this.id,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      progress: { phase: "queued", percent: 0 },
      outputs: [],
      error: null,
      cancelRequested: false,
      warnings: [],
    });
    this.jobs.set(jobId, { job, promptId: body.prompt_id });
    this.idempotency.set(request.idempotencyKey, jobId);
    return job;
  }

  /**
   * Polls the ComfyUI history API for the current status of a submitted job.
   *
   * Terminal jobs (completed, failed, cancelled) are returned from the local
   * cache without contacting the server.
   *
   * @param jobId - The provider-assigned job identifier.
   * @param signal - Optional abort signal to cancel the HTTP request.
   * @returns The current job record with updated status and outputs.
   * @throws {@link VideoProviderHttpError} When the job is unknown or the API returns an error.
   */
  async getJob(jobId: string, signal?: AbortSignal): Promise<VideoProviderJob> {
    const record = this.jobs.get(jobId);
    if (!record) throw new VideoProviderHttpError("Unknown ComfyUI video job", 404, false);
    if (["completed", "failed", "cancelled"].includes(record.job.status)) return record.job;
    const response = await this.fetchImpl(`${this.baseUrl}/history/${encodeURIComponent(record.promptId)}`, { signal });
    if (!response.ok)
      throw new VideoProviderHttpError(`ComfyUI returned HTTP ${response.status}`, response.status, true);
    const history = await response.json().catch(() => ({}));
    const outputs = collectOutputs(history).map((filename) => ({
      kind: "video" as const,
      uri: `${this.baseUrl}/view?filename=${encodeURIComponent(filename)}`,
      mimeType: filename.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4",
    }));
    const entry = history && typeof history === "object" ? (history as Record<string, unknown>)[record.promptId] : null;
    const complete = Boolean(
      entry && typeof entry === "object" && (entry as { status?: { completed?: boolean } }).status?.completed,
    );
    // Outputs are the source of truth: a history entry marked complete but
    // yielding no video file is a failure, not a success.
    record.job = parseVideoProviderJob({
      ...record.job,
      status: outputs.length ? "completed" : complete ? "failed" : "running",
      updatedAt: new Date().toISOString(),
      progress: outputs.length ? { phase: "completed", percent: 100 } : { phase: "generating", percent: 50 },
      outputs,
      error:
        complete && !outputs.length
          ? { code: "empty-output", message: "ComfyUI completed without a video output", retriable: true }
          : null,
    });
    return record.job;
  }

  /**
   * Cancels a running or queued ComfyUI job via the queue API.
   *
   * @param jobId - The provider-assigned job identifier.
   * @param signal - Optional abort signal to cancel the HTTP request.
   * @returns The updated job record with cancelled status.
   * @throws {@link VideoProviderHttpError} When the job is unknown or the API returns an error.
   */
  async cancel(jobId: string, signal?: AbortSignal): Promise<VideoProviderJob> {
    const record = this.jobs.get(jobId);
    if (!record) throw new VideoProviderHttpError("Unknown ComfyUI video job", 404, false);
    const response = await this.fetchImpl(`${this.baseUrl}/queue`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete: [record.promptId] }),
    });
    if (!response.ok)
      throw new VideoProviderHttpError(`ComfyUI cancel returned HTTP ${response.status}`, response.status, true);
    record.job = parseVideoProviderJob({
      ...record.job,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      progress: { phase: "cancelled", percent: record.job.progress?.percent ?? 0 },
      cancelRequested: true,
    });
    return record.job;
  }
}
