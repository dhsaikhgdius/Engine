import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { mediaTranscriptionCapabilitiesSchema } from "../../../packages/protocol/src/mediaTranscriptionProtocol";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import { ProductionJobIdempotencyConflictError, type ProductionJobStore } from "../jobs/productionJobStore";
import type { MediaTranscriptionExecutor } from "../transcription/mediaTranscriptionExecutor";
import type { MediaTranscriptionInputStore } from "../transcription/mediaTranscriptionInputStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies required by the media transcription route handler. */
export interface MediaTranscriptionRouteDependencies {
  /** Parses the request body into a JSON-compatible value. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The production job store for enqueuing and querying jobs. */
  store: ProductionJobStore;
  /** The input store for persisting uploaded source media. */
  inputs: MediaTranscriptionInputStore;
  /** The transcription executor. */
  executor: MediaTranscriptionExecutor;
  /** Transcription provider configuration. */
  config: {
    /** Provider identifier. */
    provider: "openai-compatible";
    /** Base URL of the transcription API. */
    baseUrl: string | undefined;
    /** Model name to pass to the transcription API. */
    model: string;
    /** Maximum bytes allowed for a single upload. */
    maxInputBytes: number;
    /** Duration threshold in seconds above which media is chunked. */
    chunkThresholdSec: number;
    /** Target duration per chunk. */
    chunkDurationSec: number;
    /** Maximum concurrent chunk requests. */
    chunkConcurrency: number;
  };
  /** Optional factory for generating job identifiers. */
  createJobId?: () => string;
  /** Optional callback for errors that occur in background job execution. */
  onBackgroundError?: (error: unknown) => void;
}

const submitQuerySchema = z.strictObject({
  source_media_id: z.string().trim().min(1).max(512),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  file_name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\")),
  duration_seconds: z.coerce
    .number()
    .finite()
    .positive()
    .max(24 * 60 * 60)
    .optional(),
  language: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(240).optional(),
  idempotency_key: z.string().trim().min(8).max(200),
});

const retryRequestSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

function transcriptionJobId(pathname: string, suffix = "") {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^\\/api\\/transcription\\/jobs\\/([^/]+)${escapedSuffix}$`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function isTranscriptionJob(
  job: ProductionJobRecord,
): job is Extract<ProductionJobRecord, { kind: "media.transcribe" }> {
  return job.kind === "media.transcribe";
}

async function readRawBody(request: IncomingMessage, maximumBytes: number) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new RangeError("Transcription source is too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = new Uint8Array(Buffer.from(chunk));
    size += bytes.byteLength;
    if (size > maximumBytes) throw new RangeError("Transcription source is too large");
    chunks.push(bytes);
  }
  if (!size) throw new TypeError("Transcription source is empty");
  const joined = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return joined;
}

function start(executor: MediaTranscriptionExecutor, job: ProductionJobRecord, onError?: (error: unknown) => void) {
  void executor.execute(job).catch((error) => {
    try {
      onError?.(error);
    } catch {
      // Observability must not turn a detached job into an unhandled rejection.
    }
  });
}

/**
 * Handles HTTP routes for media transcription jobs.
 *
 * Routes:
 * - `GET /api/transcription/capabilities` — return the provider's capabilities.
 * - `GET /api/transcription/jobs` — list recent transcription jobs.
 * - `POST /api/transcription/jobs` — submit a new transcription job (body is the source media).
 * - `GET /api/transcription/jobs/:id` — get a single job status.
 * - `POST /api/transcription/jobs/:id/cancel` — cancel a running job.
 * - `POST /api/transcription/jobs/:id/retry` — retry a failed or cancelled job.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The route dependencies.
 * @returns True if the route was handled, false otherwise.
 */
export async function handleMediaTranscriptionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: MediaTranscriptionRouteDependencies,
): Promise<boolean> {
  const { json, store, executor } = dependencies;

  if (request.method === "GET" && url.pathname === "/api/transcription/capabilities") {
    json(
      response,
      200,
      mediaTranscriptionCapabilitiesSchema.parse({
        version: 1,
        configured: executor.configured(),
        provider: dependencies.config.provider,
        model: dependencies.config.model,
        endpointHost: dependencies.config.baseUrl ? new URL(dependencies.config.baseUrl).host : null,
        maxInputBytes: dependencies.config.maxInputBytes,
        supportsSegments: true,
        supportsVtt: true,
        supportsLongMedia: true,
        longMediaStrategy: "adaptive-chunking",
        chunkThresholdSec: dependencies.config.chunkThresholdSec,
        chunkDurationSec: dependencies.config.chunkDurationSec,
        chunkConcurrency: dependencies.config.chunkConcurrency,
      }),
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/transcription/jobs") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50));
    json(response, 200, { jobs: (await store.list(["media.transcribe"])).slice(0, limit) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/transcription/jobs") {
    if (!executor.configured()) {
      json(response, 503, { code: "transcription_not_configured", message: "No transcription provider is configured" });
      return true;
    }
    const parsed = submitQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      json(response, 400, { message: "Transcription submit query is invalid", issues: parsed.error.issues });
      return true;
    }
    const sourceMimeType = String(request.headers["content-type"] ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (!sourceMimeType.startsWith("audio/") && !sourceMimeType.startsWith("video/")) {
      json(response, 415, { message: "Transcription source must be audio or video" });
      return true;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readRawBody(request, dependencies.config.maxInputBytes);
      await dependencies.inputs.put(bytes, parsed.data.source_sha256);
    } catch (error) {
      json(response, error instanceof RangeError ? 413 : 400, {
        message: error instanceof Error ? error.message : "Transcription source upload failed",
      });
      return true;
    }
    try {
      const job = await store.enqueue({
        kind: "media.transcribe",
        input: {
          sourceMediaId: parsed.data.source_media_id,
          sourceSha256: parsed.data.source_sha256,
          sourceMimeType,
          sourceFileName: parsed.data.file_name,
          durationSec: parsed.data.duration_seconds ?? null,
          model: parsed.data.model ?? dependencies.config.model,
          language: parsed.data.language,
        },
        idempotencyKey: parsed.data.idempotency_key,
        provider: dependencies.config.provider,
        sourceRevisions: { source: parsed.data.source_sha256 },
        createId: dependencies.createJobId ?? (() => `transcription-job-${randomUUID()}`),
      });
      if (job.status === "queued") start(executor, job, dependencies.onBackgroundError);
      json(response, 202, { job: productionJobRecordSchema.parse(job) });
    } catch (error) {
      if (error instanceof ProductionJobIdempotencyConflictError) {
        json(response, 409, { code: error.code, message: error.message, existingJobId: error.existingJobId });
        return true;
      }
      throw error;
    }
    return true;
  }

  const cancelId = transcriptionJobId(url.pathname, "/cancel");
  if (request.method === "POST" && cancelId) {
    try {
      const job = await executor.cancel(cancelId);
      if (!job) json(response, 404, { message: "Transcription job does not exist" });
      else json(response, 200, { job: productionJobRecordSchema.parse(job) });
    } catch (error) {
      if (error instanceof ProductionJobIdempotencyConflictError) {
        json(response, 409, { code: error.code, message: error.message, existingJobId: error.existingJobId });
      } else {
        json(response, 409, { message: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }

  const retryId = transcriptionJobId(url.pathname, "/retry");
  if (request.method === "POST" && retryId) {
    const source = await store.get(retryId);
    if (!source || !isTranscriptionJob(source)) {
      json(response, 404, { message: "Transcription job does not exist" });
      return true;
    }
    if (!new Set(["failed", "cancelled", "outcome_unknown"]).has(source.status)) {
      json(response, 409, { message: "Only failed, cancelled, or interrupted transcription jobs can be retried" });
      return true;
    }
    const retryInput = retryRequestSchema.safeParse(await dependencies.readBody(request));
    if (!retryInput.success) {
      json(response, 400, { message: "Transcription retry request is invalid", issues: retryInput.error.issues });
      return true;
    }
    try {
      await dependencies.inputs.get(source.input.sourceSha256);
      const job = await store.enqueue({
        kind: "media.transcribe",
        input: source.input,
        idempotencyKey: retryInput.data.idempotencyKey ?? `${source.id}:retry:${randomUUID()}`,
        provider: dependencies.config.provider,
        sourceRevisions: { source: source.input.sourceSha256, retryOf: source.id },
        createId: dependencies.createJobId ?? (() => `transcription-job-${randomUUID()}`),
      });
      start(executor, job, dependencies.onBackgroundError);
      json(response, 202, { job: productionJobRecordSchema.parse(job) });
    } catch (error) {
      json(response, 409, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const getId = transcriptionJobId(url.pathname);
  if (request.method === "GET" && getId) {
    const job = await store.get(getId);
    if (!job || !isTranscriptionJob(job)) json(response, 404, { message: "Transcription job does not exist" });
    else json(response, 200, { job: productionJobRecordSchema.parse(job) });
    return true;
  }

  return false;
}
