import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  directorMediaTranscriptSchema,
  mediaTranscriptionJobInputSchema,
  serializeDirectorMediaTranscriptVtt,
  type DirectorMediaTranscript,
  type DirectorMediaTranscriptSegment,
} from "../../../packages/protocol/src/mediaTranscriptionProtocol";
import {
  productionJobArtifactSchema,
  transitionProductionJob,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import {
  splitMediaForTranscription,
  type MediaTranscriptionChunk,
  type MediaTranscriptionChunker,
} from "./mediaTranscriptionChunker";
import type { MediaTranscriptionInputStore } from "./mediaTranscriptionInputStore";

/** Configuration for the OpenAI-compatible transcription provider. */
export interface MediaTranscriptionProviderConfig {
  /** Provider identifier, always "openai-compatible" for this executor. */
  provider: "openai-compatible";
  /** Base URL of the transcription API endpoint. */
  baseUrl: string | undefined;
  /** API key for authenticated requests. */
  apiKey: string | undefined;
  /** Model name to pass to the transcription API. */
  model: string;
  /** Maximum time to wait for a single transcription request, in milliseconds. */
  timeoutMs: number;
  /** Duration threshold in seconds above which media is chunked for transcription. */
  chunkThresholdSec: number;
  /** Target duration per chunk when splitting long media. */
  chunkDurationSec: number;
  /** Maximum number of concurrent chunk transcription requests. */
  chunkConcurrency: number;
  /** Path to the ffmpeg binary used for media splitting. */
  ffmpegPath: string;
}

/** Dependencies required to construct a {@link MediaTranscriptionExecutor}. */
export interface MediaTranscriptionExecutorOptions {
  /** The production job store for persisting job state. */
  store: ProductionJobStore;
  /** The input store for retrieving uploaded source media. */
  inputs: MediaTranscriptionInputStore;
  /** Provider configuration. */
  config: MediaTranscriptionProviderConfig;
  /** Optional fetch implementation for HTTP requests. */
  fetcher?: typeof fetch;
  /** Optional chunker implementation for splitting long media. */
  chunker?: MediaTranscriptionChunker;
  /** Optional clock for deterministic timestamps. */
  now?: () => Date;
}

/**
 * Error thrown when the transcription provider returns a non-successful
 * HTTP response or an invalid transcript.
 */
class TranscriptionProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TranscriptionProviderError";
  }
}

function transcriptionEndpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/audio/transcriptions") ? normalized : `${normalized}/audio/transcriptions`;
}

function finiteNumber(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function normalizeProviderSegments(value: unknown, durationSec: number | null): DirectorMediaTranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: DirectorMediaTranscriptSegment[] = [];
  for (const candidate of value.slice(0, 20_000)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const rawStart = finiteNumber(record.start);
    const rawEnd = finiteNumber(record.end);
    const text = typeof record.text === "string" ? record.text.trim().slice(0, 8_000) : "";
    if (rawStart === null || rawEnd === null || !text) continue;
    const startSec = Math.max(0, rawStart);
    const endSec = Math.min(durationSec ?? Number.POSITIVE_INFINITY, rawEnd);
    if (!Number.isFinite(endSec) || endSec <= startSec) continue;
    const avgLogprob = finiteNumber(record.avg_logprob);
    segments.push({
      startSec,
      endSec,
      text,
      speaker: typeof record.speaker === "string" && record.speaker.trim() ? record.speaker.trim().slice(0, 160) : null,
      confidence: avgLogprob === null ? null : Math.max(0, Math.min(1, Math.exp(avgLogprob))),
    });
  }
  return segments.sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
}

function normalizeProviderTranscript(
  value: unknown,
  input: ReturnType<typeof mediaTranscriptionJobInputSchema.parse>,
  jobId: string,
  provider: string,
  now: Date,
): DirectorMediaTranscript {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TranscriptionProviderError(
      "Transcription provider returned an invalid response",
      "invalid_response",
      true,
    );
  }
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim().slice(0, 1_000_000) : "";
  if (!text) throw new TranscriptionProviderError("Transcription provider returned no text", "empty_transcript", true);
  const providerDuration = finiteNumber(record.duration);
  const durationSec = input.durationSec ?? (providerDuration && providerDuration > 0 ? providerDuration : null);
  let segments = normalizeProviderSegments(record.segments, durationSec);
  if (!segments.length && durationSec) {
    segments = [{ startSec: 0, endSec: durationSec, text, speaker: null, confidence: null }];
  }
  const language =
    input.language ??
    (typeof record.language === "string" && record.language.trim() ? record.language.trim().slice(0, 80) : null);
  return directorMediaTranscriptSchema.parse({
    version: 1,
    jobId,
    sourceMediaId: input.sourceMediaId,
    sourceSha256: input.sourceSha256,
    provider,
    model: input.model,
    language,
    durationSec,
    text,
    segments,
    createdAt: now.toISOString(),
  });
}

function mergeChunkTranscripts(
  transcripts: readonly DirectorMediaTranscript[],
  chunks: readonly MediaTranscriptionChunk[],
  input: ReturnType<typeof mediaTranscriptionJobInputSchema.parse>,
  jobId: string,
  provider: string,
  now: Date,
) {
  const segments = transcripts
    .flatMap((transcript, index) => {
      const chunk = chunks[index]!;
      return transcript.segments.map((segment) => ({
        ...segment,
        startSec: chunk.offsetSec + segment.startSec,
        endSec: Math.min(input.durationSec ?? Number.POSITIVE_INFINITY, chunk.offsetSec + segment.endSec),
      }));
    })
    .filter((segment) => segment.endSec > segment.startSec)
    .slice(0, 20_000);
  return directorMediaTranscriptSchema.parse({
    version: 1,
    jobId,
    sourceMediaId: input.sourceMediaId,
    sourceSha256: input.sourceSha256,
    provider,
    model: input.model,
    language: input.language ?? transcripts.find((transcript) => transcript.language)?.language ?? null,
    durationSec: input.durationSec,
    text: transcripts
      .map((transcript) => transcript.text.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 1_000_000),
    segments,
    createdAt: now.toISOString(),
  });
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function bytesArtifact(input: {
  id: string;
  attemptId: string;
  role: string;
  mimeType: string;
  fileName: string;
  bytes: Uint8Array;
  createdAt: string;
}) {
  return productionJobArtifactSchema.parse({
    id: input.id,
    attemptId: input.attemptId,
    role: input.role,
    mimeType: input.mimeType,
    fileName: input.fileName,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    bytes: input.bytes.byteLength,
    createdAt: input.createdAt,
  });
}

/**
 * Executes media transcription jobs by submitting audio to an
 * OpenAI-compatible transcription API, with support for chunking
 * long media via ffmpeg.
 */
export class MediaTranscriptionExecutor {
  private readonly controllers = new Map<string, AbortController>();
  private readonly fetcher: typeof fetch;
  private readonly chunker: MediaTranscriptionChunker;
  private readonly now: () => Date;

  /**
   * Creates a new media transcription executor.
   *
   * @param options - Dependencies and configuration.
   */
  constructor(private readonly options: MediaTranscriptionExecutorOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.chunker = options.chunker ?? splitMediaForTranscription;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Returns whether a transcription provider is configured.
   *
   * @returns True when a base URL is set.
   */
  configured() {
    return Boolean(this.options.config.baseUrl);
  }

  private async transcribePart(
    input: ReturnType<typeof mediaTranscriptionJobInputSchema.parse>,
    jobId: string,
    source: Uint8Array,
    sourceMimeType: string,
    sourceFileName: string,
    signal: AbortSignal,
  ) {
    const form = new FormData();
    form.append("model", input.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (input.language) form.append("language", input.language);
    form.append("file", new Blob([source], { type: sourceMimeType }), sourceFileName);
    const response = await this.fetcher(transcriptionEndpoint(this.options.config.baseUrl!), {
      method: "POST",
      headers: this.options.config.apiKey ? { authorization: `Bearer ${this.options.config.apiKey}` } : undefined,
      body: form,
      signal,
    });
    if (!response.ok) {
      throw new TranscriptionProviderError(
        `Transcription provider returned HTTP ${response.status}`,
        `provider_http_${response.status}`,
        response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      );
    }
    const raw = (await response.json().catch(() => null)) as unknown;
    return normalizeProviderTranscript(raw, input, jobId, this.options.config.provider, this.now());
  }

  private async transcribeLongMedia(
    current: Extract<ProductionJobRecord, { kind: "media.transcribe" }>,
    source: Uint8Array,
    signal: AbortSignal,
  ) {
    const input = mediaTranscriptionJobInputSchema.parse(current.input);
    const chunks = await this.chunker({
      source,
      sourceFileName: input.sourceFileName,
      durationSec: input.durationSec!,
      chunkDurationSec: this.options.config.chunkDurationSec,
      ffmpegPath: this.options.config.ffmpegPath,
      signal,
    });
    let completed = 0;
    let progressTail = Promise.resolve();
    const transcripts = await mapWithConcurrency(chunks, this.options.config.chunkConcurrency, async (chunk) => {
      const transcript = await this.transcribePart(
        { ...input, durationSec: chunk.durationSec },
        current.id,
        chunk.bytes,
        chunk.mimeType,
        chunk.fileName,
        signal,
      );
      completed += 1;
      progressTail = progressTail.then(async () => {
        const latest = await this.options.store.get(current.id);
        if (!latest || latest.status !== "running") return;
        await this.options.store.update(
          transitionProductionJob(latest, "running", {
            progress: 0.15 + (completed / chunks.length) * 0.75,
            message: `Transcribed ${completed} of ${chunks.length} media chunks`,
          }),
        );
      });
      await progressTail;
      return transcript;
    });
    return mergeChunkTranscripts(transcripts, chunks, input, current.id, this.options.config.provider, this.now());
  }

  /**
   * Executes a transcription job from start to finish.
   *
   * Handles the full lifecycle: transitions the job from queued to running,
   * submits the source media to the provider (with chunking for long media),
   * writes the resulting transcript and VTT captions as artifacts, and
   * transitions to succeeded or failed.
   *
   * @param jobInput - The production job record to execute.
   * @returns The final job state, or null if the job was cancelled mid-execution.
   * @throws When the job is not a transcription job or no provider is configured.
   */
  async execute(jobInput: ProductionJobRecord) {
    if (jobInput.kind !== "media.transcribe") throw new Error(`Cannot transcribe production job ${jobInput.kind}`);
    const input = mediaTranscriptionJobInputSchema.parse(jobInput.input);
    if (!this.options.config.baseUrl) throw new Error("No transcription provider is configured");
    if (this.controllers.has(jobInput.id)) return this.options.store.get(jobInput.id);
    const controller = new AbortController();
    this.controllers.set(jobInput.id, controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Transcription provider timed out", "TimeoutError")),
      this.options.config.timeoutMs,
    );
    try {
      const queued = await this.options.store.get(jobInput.id);
      if (!queued || queued.kind !== "media.transcribe" || queued.status !== "queued") return queued;
      const current = (await this.options.store.update(
        transitionProductionJob(queued, "running", { progress: 0.05, message: "Preparing media for transcription" }),
      )) as Extract<ProductionJobRecord, { kind: "media.transcribe" }>;
      const source = await this.options.inputs.get(input.sourceSha256);
      const transcript =
        input.durationSec !== null && input.durationSec >= this.options.config.chunkThresholdSec
          ? await this.transcribeLongMedia(current, source, controller.signal)
          : await this.transcribePart(
              input,
              current.id,
              source,
              input.sourceMimeType,
              input.sourceFileName,
              controller.signal,
            );
      const transcriptBytes = new TextEncoder().encode(`${JSON.stringify(transcript, null, 2)}\n`);
      const vttBytes = new TextEncoder().encode(serializeDirectorMediaTranscriptVtt(transcript));
      const attempt = current.attempts.at(-1)!;
      const createdAt = this.now().toISOString();
      const artifacts = [
        bytesArtifact({
          id: `${attempt.id}-transcript-json`,
          attemptId: attempt.id,
          role: "transcript",
          mimeType: "application/vnd.director.media-transcript+json",
          fileName: "transcript.json",
          bytes: transcriptBytes,
          createdAt,
        }),
        bytesArtifact({
          id: `${attempt.id}-captions-vtt`,
          attemptId: attempt.id,
          role: "captions",
          mimeType: "text/vtt; charset=utf-8",
          fileName: "captions.vtt",
          bytes: vttBytes,
          createdAt,
        }),
      ];
      for (const [index, artifact] of artifacts.entries()) {
        const bytes = index === 0 ? transcriptBytes : vttBytes;
        const path = this.options.store.artifactFilePath(current.id, attempt.id, artifact.fileName);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
      const latest = await this.options.store.get(current.id);
      if (!latest || latest.status !== "running") return latest;
      return this.options.store.update(
        transitionProductionJob(latest, "succeeded", {
          progress: 1,
          message: `Transcribed ${transcript.segments.length} timed segment${transcript.segments.length === 1 ? "" : "s"}`,
          artifacts,
          artifact: artifacts[0],
        }),
      );
    } catch (error) {
      const latest = await this.options.store.get(jobInput.id);
      if (!latest || latest.status === "cancelled") return latest;
      if (latest.status !== "running") throw error;
      const providerError = error instanceof TranscriptionProviderError ? error : null;
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      const message = timedOut
        ? "Transcription provider timed out"
        : (providerError?.message ?? (error instanceof Error ? error.message : "Transcription failed"));
      return this.options.store.update(
        transitionProductionJob(latest, "failed", {
          message: "Transcription failed",
          error: message,
          structuredError: {
            code: timedOut ? "provider_timeout" : (providerError?.code ?? "transcription_failed"),
            message,
            retryable: timedOut || providerError?.retryable === true,
          },
        }),
      );
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(jobInput.id);
    }
  }

  /**
   * Cancels an in-progress or queued transcription job.
   *
   * Aborts any active HTTP request and transitions the job to cancelled.
   *
   * @param jobId - The job identifier.
   * @returns The cancelled job record, or null if the job does not exist
   *          or is already terminal.
   * @throws When the job is in a state that cannot be cancelled.
   */
  async cancel(jobId: string) {
    const job = await this.options.store.get(jobId);
    if (!job || job.kind !== "media.transcribe") return null;
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return job;
    if (job.status !== "queued" && job.status !== "running")
      throw new Error("Only queued or running transcription jobs can be cancelled");
    this.controllers.get(jobId)?.abort(new DOMException("Transcription cancelled", "AbortError"));
    return this.options.store.update(
      transitionProductionJob(job, "cancelled", {
        progress: job.progress,
        message: "Transcription cancelled",
        error: "Transcription cancelled by the user",
        structuredError: {
          code: "cancelled_by_user",
          message: "Transcription cancelled by the user",
          retryable: true,
        },
      }),
    );
  }
}
