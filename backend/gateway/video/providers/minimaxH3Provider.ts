import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { VideoProviderCapability } from "../../../../packages/protocol/src/videoGenerationProtocol";
import {
  VideoProviderHttpError,
  parseVideoGenerationRequest,
  parseVideoProviderCapability,
  parseVideoProviderHealth,
  parseVideoProviderJob,
  type VideoGenerationRequest,
  type VideoProvider,
  type VideoProviderHealth,
  type VideoProviderJob,
} from "./videoProvider";

type FetchLike = typeof fetch;

export interface MinimaxH3ProviderOptions {
  apiKey: string;
  /** `https://api.minimax.io` (global) or `https://api.minimaxi.com` (CN). */
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

/** MiniMax task ids are embedded in the provider job id so status polling
 * survives a gateway restart without any provider-side state. */
const JOB_ID_PREFIX = "video-mmx-";

const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io";
const MINIMAX_DEFAULT_MODEL = "MiniMax-H3";
const MIN_DURATION_S = 4;
const MAX_DURATION_S = 15;

/** Concrete ratios the H3 text-to-video contract accepts (`adaptive` is only
 * valid once the task carries image input). */
const TEXT_TO_VIDEO_RATIOS = [
  { ratio: "21:9", value: 21 / 9 },
  { ratio: "16:9", value: 16 / 9 },
  { ratio: "4:3", value: 4 / 3 },
  { ratio: "1:1", value: 1 },
  { ratio: "3:4", value: 3 / 4 },
  { ratio: "9:16", value: 9 / 16 },
] as const;

type MinimaxTask = {
  id?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  content?: { url?: unknown } | null;
  error?: { code?: unknown; message?: unknown } | null;
};

function trimBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("MiniMax base URL must use http or https");
  return trimmed;
}

function isRetriableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function minimaxH3Duration(numFrames: number, frameRate: number) {
  const requested = numFrames / Math.max(frameRate, 1);
  return Math.min(MAX_DURATION_S, Math.max(MIN_DURATION_S, Math.round(requested)));
}

export function minimaxH3Resolution(width: number, height: number): "768P" | "2K" {
  return Math.max(width, height) >= 1_440 ? "2K" : "768P";
}

export function minimaxH3Ratio(width: number, height: number) {
  const requested = width / Math.max(height, 1);
  let closest: (typeof TEXT_TO_VIDEO_RATIOS)[number] = TEXT_TO_VIDEO_RATIOS[0];
  for (const candidate of TEXT_TO_VIDEO_RATIOS) {
    if (Math.abs(candidate.value - requested) < Math.abs(closest.value - requested)) closest = candidate;
  }
  return closest.ratio;
}

function taskStatusToJobStatus(status: string) {
  switch (status) {
    case "queued":
      return "queued" as const;
    case "running":
      return "running" as const;
    case "succeeded":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    case "cancelled":
      return "cancelled" as const;
    default:
      throw new Error(`MiniMax returned an unknown task status: ${status}`);
  }
}

function unixSecondsToIso(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1_000).toISOString();
  }
  return new Date().toISOString();
}

function imageMimeType(uri: string, declared?: string) {
  if (declared) return declared;
  const extension = extname(uri).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

export class MinimaxH3Provider implements VideoProvider {
  readonly id = "minimax-h3" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: MinimaxH3ProviderOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("MiniMax H3 provider requires an API key");
    this.baseUrl = trimBaseUrl(options.baseUrl ?? MINIMAX_DEFAULT_BASE_URL);
    this.model = options.model?.trim() || MINIMAX_DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async capabilities(): Promise<VideoProviderCapability> {
    return parseVideoProviderCapability({
      id: this.id,
      label: "MiniMax H3",
      configured: true,
      supportsImageConditioning: true,
      supportsAudio: true,
      supportsNegativePrompt: false,
      dimensionMultiple: null,
      frameCountRule: "any",
      model: this.model,
    });
  }

  async health(): Promise<VideoProviderHealth> {
    // The hosted API exposes no health probe; a configured key is the only
    // readiness signal available before the first paid request.
    return parseVideoProviderHealth({
      provider: this.id,
      status: "ready",
      modelLoaded: true,
      activeJobId: null,
      detail: `Hosted MiniMax endpoint (${new URL(this.baseUrl).host}); readiness is asserted, not probed.`,
    });
  }

  async submit(rawRequest: VideoGenerationRequest, signal?: AbortSignal): Promise<VideoProviderJob> {
    const request = parseVideoGenerationRequest(rawRequest);
    const warnings: string[] = [];

    const duration = minimaxH3Duration(request.numFrames, request.frameRate);
    const requestedSeconds = request.numFrames / Math.max(request.frameRate, 1);
    if (Math.abs(duration - requestedSeconds) > 0.05) {
      warnings.push(
        `MiniMax H3 renders whole seconds between ${MIN_DURATION_S}s and ${MAX_DURATION_S}s; ${requestedSeconds.toFixed(2)}s became ${duration}s.`,
      );
    }

    const resolution = minimaxH3Resolution(request.width, request.height);
    warnings.push(`MiniMax H3 renders at 768P or 2K; ${request.width}x${request.height} was submitted as ${resolution}.`);

    const reference = request.conditioning.find((input) => input.role === "clean-frame" || input.role === "reference");
    const skippedRoles = [
      ...new Set(request.conditioning.filter((input) => input !== reference).map((input) => input.role)),
    ];
    if (skippedRoles.length) {
      warnings.push(`MiniMax H3 consumed only the first reference frame; ${skippedRoles.join(", ")} inputs were not submitted.`);
    }

    const content: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }];
    if (reference) {
      content.push({
        type: "image_url",
        image_url: { url: await this.resolveImageUrl(reference.uri, reference.mimeType) },
        role: "first_frame",
      });
    }

    const ratio = reference ? "adaptive" : minimaxH3Ratio(request.width, request.height);
    if (request.negativePrompt) {
      warnings.push("MiniMax H3 does not consume a negative prompt; it was retained only as job metadata.");
    }
    if (!request.generateAudio) {
      warnings.push("MiniMax H3 always renders native stereo audio; generate_audio=false could not be honored.");
    }
    if (request.enhancePrompt) {
      warnings.push("Prompt enhancement is not requested from MiniMax; the prompt was submitted verbatim.");
    }
    warnings.push("MiniMax H3 does not accept a seed; the requested seed was retained only as job metadata.");

    const body = (await this.requestJson(
      "POST",
      "/v2/video_generation",
      {
        model: request.model?.startsWith("MiniMax") ? request.model : this.model,
        content,
        resolution,
        duration,
        ratio,
      },
      signal,
    )) as { task_id?: unknown };
    if (typeof body.task_id !== "string" || !body.task_id) {
      throw new Error("MiniMax create-task response did not include a task_id");
    }
    const jobId = `${JOB_ID_PREFIX}${body.task_id}`;
    if (!/^video-[a-z0-9-]{8,80}$/i.test(jobId)) {
      throw new Error(`MiniMax returned a task id that cannot be tracked as a job id: ${body.task_id}`);
    }
    const now = new Date().toISOString();
    return parseVideoProviderJob({
      id: jobId,
      provider: this.id,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      progress: null,
      outputs: [],
      error: null,
      cancelRequested: false,
      warnings,
    });
  }

  async getJob(jobId: string, signal?: AbortSignal): Promise<VideoProviderJob> {
    const taskId = parseTaskId(jobId);
    const body = (await this.requestJson(
      "GET",
      `/v2/query/video_generation/${encodeURIComponent(taskId)}`,
      undefined,
      signal,
    )) as { task?: MinimaxTask };
    const task = body.task;
    if (!task || typeof task.status !== "string") {
      throw new Error("MiniMax query-task response did not include a task status");
    }
    const status = taskStatusToJobStatus(task.status);
    const outputUrl = status === "completed" && typeof task.content?.url === "string" ? task.content.url : null;
    return parseVideoProviderJob({
      id: jobId,
      provider: this.id,
      status,
      createdAt: unixSecondsToIso(task.created_at),
      updatedAt: unixSecondsToIso(task.updated_at),
      progress: null,
      outputs: outputUrl ? [{ kind: "video", uri: outputUrl, mimeType: "video/mp4" }] : [],
      error:
        status === "failed"
          ? {
              code: typeof task.error?.code === "string" && task.error.code ? task.error.code : "minimax_task_failed",
              message:
                typeof task.error?.message === "string" && task.error.message
                  ? task.error.message
                  : "MiniMax reported the task as failed without further detail.",
              retriable: false,
            }
          : null,
      cancelRequested: status === "cancelled",
      warnings:
        outputUrl === null && status === "completed"
          ? ["MiniMax reported success but returned no output URL; query again for a fresh link."]
          : [],
    });
  }

  async cancel(jobId: string, signal?: AbortSignal): Promise<VideoProviderJob> {
    // The v2 API exposes no cancellation endpoint; report the live task state
    // with the cancellation request recorded instead of pretending it stopped.
    const job = await this.getJob(jobId, signal);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
    return parseVideoProviderJob({
      ...job,
      cancelRequested: true,
      warnings: [
        ...job.warnings,
        "MiniMax H3 does not support cancelling a submitted task; it will finish or fail on the provider side.",
      ],
    });
  }

  private async resolveImageUrl(uri: string, declaredMimeType?: string) {
    if (/^https?:\/\//i.test(uri) || uri.startsWith("data:") || uri.startsWith("mm_file://")) return uri;
    const bytes = await readFile(uri);
    return `data:${imageMimeType(uri, declaredMimeType)};base64,${bytes.toString("base64")}`;
  }

  private async requestJson(method: "GET" | "POST", path: string, body: unknown, outerSignal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const error =
        responseBody && typeof responseBody.error === "object" && responseBody.error
          ? (responseBody.error as { message?: unknown; type?: unknown })
          : null;
      const detail =
        error && typeof error.message === "string"
          ? error.message
          : `HTTP ${response.status}`;
      throw new VideoProviderHttpError(
        `MiniMax request failed: ${detail}`,
        response.status,
        isRetriableStatus(response.status),
        responseBody,
      );
    }
    if (responseBody === null) throw new Error("MiniMax returned a non-JSON response body");
    return responseBody;
  }
}

function parseTaskId(jobId: string) {
  if (!jobId.startsWith(JOB_ID_PREFIX)) {
    throw new Error(`Job ${jobId} was not created by the MiniMax H3 provider`);
  }
  const taskId = jobId.slice(JOB_ID_PREFIX.length);
  if (!/^[a-z0-9-]{4,76}$/i.test(taskId)) throw new Error(`Invalid MiniMax task id in job ${jobId}`);
  return taskId;
}
