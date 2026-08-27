import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  productionJobArtifactSchema,
  transitionProductionJob,
  type ProductionJobError,
  type ProductionJobRecord,
  type ProductionJobSpec,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import { createLimiter } from "../promiseLimiter";
import { runMediaProcess, type MediaProcessRunner } from "./mediaProcessRunner";
import {
  MediaInputIntegrityError,
  MediaInputMissingError,
  type MediaTranscodeInputStore,
} from "./mediaTranscodeInputStore";

/**
 * Local ffmpeg executor for the unified job kinds `media.transcode` and
 * `media.proxy`. `media.proxy` is executed as a preset of `media.transcode`:
 * both run the exact same probe → transcode → poster pipeline with the
 * editorial-proxy encoder settings (H.264 yuv420p, CRF 23, AAC 128k,
 * +faststart); `media.proxy` additionally honors the maxWidth/maxHeight box
 * from its protocol input, while `media.transcode` reads its resolution
 * ceiling from `targetMimeType` parameters (the protocol input schema is
 * frozen and strict, so mime parameters are the only extension point).
 *
 * Like the ARDY bridge, a missing ffmpeg/ffprobe binary is an expected state:
 * the job fails with a non-retryable configuration error naming the env var
 * instead of crashing the gateway.
 */

/** The two job kinds this executor handles. */
export type MediaTranscodeJobKind = "media.transcode" | "media.proxy";
/** Narrowed job spec for media transcode/proxy jobs. */
export type MediaTranscodeJobSpec = Extract<ProductionJobSpec, { kind: MediaTranscodeJobKind }>;

/** Resolution ceiling bounds for proxy transcoding. */
export const MEDIA_TRANSCODE_MAX_HEIGHT_BOUNDS = { min: 360, max: 2160, fallback: 720 } as const;
/** Timeout bounds for media transcode jobs. */
export const MEDIA_TRANSCODE_TIMEOUT_BOUNDS_MS = { min: 30_000, max: 4 * 60 * 60_000, fallback: 15 * 60_000 } as const;
/** Default bound on ffmpeg pipelines running at once (each is CPU-heavy). */
export const MEDIA_TRANSCODE_DEFAULT_MAX_CONCURRENT_JOBS = 2;

/** Editorial-proxy preset shared by both kinds. */
const PROXY_VIDEO_CRF = 23;
const PROXY_AUDIO_BITRATE_KBPS = 128;
const STDERR_TAIL_CHARS = 1_500;

/** Staged inputs are addressed by content: the id must end in `sha256:<hex>`. */
const STAGED_SOURCE_ID_PATTERN = /^(?:[A-Za-z0-9._-]+:)*sha256:([a-f0-9]{64})$/;

/**
 * Structured error for media transcode failures with a machine-readable code
 * and retryability flag.
 */
export class MediaTranscodeJobError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MediaTranscodeJobError";
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Only the parameters below may extend targetMimeType; unknown ones are
// rejected so typos cannot silently fall back to defaults.
const targetMimeParametersSchema = z.strictObject({
  maxheight: z.coerce.number().int().optional(),
  timeoutsec: z.coerce.number().int().optional(),
});

function parseTargetMimeType(value: string) {
  const [base = "", ...rawParameters] = value.split(";");
  const type = base.trim().toLowerCase();
  const parameters: Record<string, string> = {};
  for (const raw of rawParameters) {
    const separator = raw.indexOf("=");
    const key = separator === -1 ? "" : raw.slice(0, separator).trim().toLowerCase();
    const parameterValue =
      separator === -1
        ? ""
        : raw
            .slice(separator + 1)
            .trim()
            .replace(/^"(.*)"$/, "$1");
    if (!key || !parameterValue) {
      throw new MediaTranscodeJobError(
        `targetMimeType parameter "${raw.trim().slice(0, 80)}" is not a key=value pair`,
        "unsupported_job_input",
        false,
      );
    }
    parameters[key] = parameterValue;
  }
  const parsed = targetMimeParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    throw new MediaTranscodeJobError(
      "targetMimeType parameters are invalid; supported parameters are maxHeight and timeoutSec (integers)",
      "unsupported_job_input",
      false,
    );
  }
  return { type, parameters: parsed.data };
}

/** Resolved parameters for a media transcode operation. */
export interface ResolvedMediaTranscodeParams {
  kind: MediaTranscodeJobKind;
  sourceSha256: string;
  /** Resolution ceiling in rows, clamped to MEDIA_TRANSCODE_MAX_HEIGHT_BOUNDS. */
  maxHeight: number;
  /** Optional column ceiling (media.proxy box); null means height-only fit. */
  maxWidth: number | null;
  videoCrf: number;
  audioBitrateKbps: number;
  timeoutMs: number;
}

/**
 * Derives executor parameters from the frozen protocol input. Out-of-range
 * numbers are clamped into the supported envelope rather than rejected;
 * structurally unsupported targets fail as non-retryable job errors.
 */
export function resolveMediaTranscodeParams(
  spec: MediaTranscodeJobSpec,
  defaultTimeoutMs: number,
): ResolvedMediaTranscodeParams {
  const sourceMatch = spec.input.sourceMediaId.match(STAGED_SOURCE_ID_PATTERN);
  if (!sourceMatch) {
    throw new MediaTranscodeJobError(
      'sourceMediaId must reference a staged media input and end in "sha256:<64 hex>"; ' +
        "stage the bytes via POST /api/production-jobs/media-inputs?sha256=<hex> first",
      "unsupported_job_input",
      false,
    );
  }
  const sourceSha256 = sourceMatch[1]!;
  const clampHeight = (value: number) =>
    clamp(value, MEDIA_TRANSCODE_MAX_HEIGHT_BOUNDS.min, MEDIA_TRANSCODE_MAX_HEIGHT_BOUNDS.max);
  const clampTimeout = (value: number) =>
    clamp(value, MEDIA_TRANSCODE_TIMEOUT_BOUNDS_MS.min, MEDIA_TRANSCODE_TIMEOUT_BOUNDS_MS.max);
  const codec = (spec.kind === "media.proxy" ? spec.input.codec : (spec.input.codec ?? "h264")).trim().toLowerCase();
  if (codec !== "h264") {
    throw new MediaTranscodeJobError(`Only the h264 codec is supported; got "${codec}"`, "unsupported_target", false);
  }

  if (spec.kind === "media.proxy") {
    return {
      kind: spec.kind,
      sourceSha256,
      maxHeight: clampHeight(spec.input.maxHeight),
      maxWidth: spec.input.maxWidth,
      videoCrf: PROXY_VIDEO_CRF,
      audioBitrateKbps: PROXY_AUDIO_BITRATE_KBPS,
      timeoutMs: clampTimeout(defaultTimeoutMs),
    };
  }

  const container = (spec.input.container ?? "mp4").trim().toLowerCase();
  if (container !== "mp4") {
    throw new MediaTranscodeJobError(
      `Only the mp4 container is supported; got "${container}"`,
      "unsupported_target",
      false,
    );
  }
  const target = parseTargetMimeType(spec.input.targetMimeType);
  if (target.type !== "video/mp4") {
    throw new MediaTranscodeJobError(
      `Only video/mp4 output is supported; got "${target.type || spec.input.targetMimeType.slice(0, 80)}"`,
      "unsupported_target",
      false,
    );
  }
  return {
    kind: spec.kind,
    sourceSha256,
    maxHeight: clampHeight(target.parameters.maxheight ?? MEDIA_TRANSCODE_MAX_HEIGHT_BOUNDS.fallback),
    maxWidth: null,
    videoCrf: PROXY_VIDEO_CRF,
    audioBitrateKbps: PROXY_AUDIO_BITRATE_KBPS,
    timeoutMs: clampTimeout(
      target.parameters.timeoutsec !== undefined ? target.parameters.timeoutsec * 1_000 : defaultTimeoutMs,
    ),
  };
}

/**
 * Fit inside the ceiling without ever upscaling: the shared shrink factor
 * preserves aspect and trunc(…/2)*2 keeps both dimensions even for yuv420p.
 * Commas inside min() are escaped because the string is an ffmpeg filtergraph.
 *
 * @param params.maxHeight - Resolution ceiling in rows.
 * @param params.maxWidth - Optional column ceiling; null means height-only fit.
 * @returns An ffmpeg scale filter string.
 */
export function mediaTranscodeScaleFilter(params: Pick<ResolvedMediaTranscodeParams, "maxHeight" | "maxWidth">) {
  const factor =
    params.maxWidth === null
      ? `min(1\\,${params.maxHeight}/ih)`
      : `min(1\\,min(${params.maxHeight}/ih\\,${params.maxWidth}/iw))`;
  return `scale=trunc(iw*${factor}/2)*2:trunc(ih*${factor}/2)*2`;
}

/**
 * Computes the seek position for a representative poster frame: ~1s in, or
 * 10% of duration for very short sources.
 *
 * @param durationSec - The source duration in seconds, or null.
 * @returns The seek position in seconds.
 */
export function posterSeekSeconds(durationSec: number | null) {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.round(Math.min(1, durationSec * 0.1) * 1_000) / 1_000;
}

const probeNumber = z.coerce.number().optional().catch(undefined);

const probeStreamSchema = z.looseObject({
  index: probeNumber,
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: probeNumber,
  height: probeNumber,
  duration: probeNumber,
  sample_rate: probeNumber,
  channels: probeNumber,
  avg_frame_rate: z.string().optional(),
});

const probeOutputSchema = z.looseObject({
  format: z
    .looseObject({
      format_name: z.string().optional(),
      duration: probeNumber,
      size: probeNumber,
      bit_rate: probeNumber,
    })
    .optional(),
  streams: z.array(probeStreamSchema).max(256).default([]),
});

/** Summary of a single media stream from ffprobe output. */
export interface MediaProbeStreamSummary {
  index: number;
  type: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  sampleRate: number | null;
  channels: number | null;
  frameRate: string | null;
}

/** Structured summary of ffprobe output for a media file. */
export interface MediaProbeSummary {
  version: 1;
  container: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  bitRate: number | null;
  streams: MediaProbeStreamSummary[];
}

function positiveOrNull(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function summarizeProbe(raw: unknown): MediaProbeSummary {
  const parsed = probeOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MediaTranscodeJobError("ffprobe returned an unreadable stream description", "ffprobe_failed", false);
  }
  const streams = parsed.data.streams.map((stream, index) => ({
    index: typeof stream.index === "number" && Number.isInteger(stream.index) ? stream.index : index,
    type: stream.codec_type ?? "unknown",
    codec: stream.codec_name ?? null,
    width: positiveOrNull(stream.width),
    height: positiveOrNull(stream.height),
    durationSec: positiveOrNull(stream.duration),
    sampleRate: positiveOrNull(stream.sample_rate),
    channels: positiveOrNull(stream.channels),
    frameRate: stream.avg_frame_rate ?? null,
  }));
  const video = streams.find((stream) => stream.type === "video");
  if (!video) {
    throw new MediaTranscodeJobError(
      "The staged source has no video stream to transcode into a proxy",
      "unsupported_source",
      false,
    );
  }
  const streamDurations = streams
    .map((stream) => stream.durationSec)
    .filter((value): value is number => value !== null);
  return {
    version: 1,
    container: parsed.data.format?.format_name ?? null,
    durationSec:
      positiveOrNull(parsed.data.format?.duration) ?? (streamDurations.length ? Math.max(...streamDurations) : null),
    width: video.width,
    height: video.height,
    sizeBytes: positiveOrNull(parsed.data.format?.size),
    bitRate: positiveOrNull(parsed.data.format?.bit_rate),
    streams,
  };
}

function stderrTail(stderr: string) {
  const trimmed = stderr.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

function toStructuredFailure(error: unknown): ProductionJobError {
  if (error instanceof MediaTranscodeJobError) {
    return {
      code: error.code,
      message: error.message.slice(0, 12_000) || "Media transcode failed",
      retryable: error.retryable,
    };
  }
  if (error instanceof MediaInputMissingError || error instanceof MediaInputIntegrityError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  const message = error instanceof Error && error.message ? error.message.slice(0, 12_000) : "Media transcode failed";
  return { code: "media_transcode_failed", message, retryable: false };
}

async function fileArtifact(input: {
  id: string;
  attemptId: string;
  role: string;
  mimeType: string;
  fileName: string;
  path: string;
  createdAt: string;
}) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(input.path)) hash.update(chunk as Buffer);
  const info = await stat(input.path);
  return productionJobArtifactSchema.parse({
    id: input.id,
    attemptId: input.attemptId,
    role: input.role,
    mimeType: input.mimeType,
    fileName: input.fileName,
    sha256: hash.digest("hex"),
    bytes: info.size,
    createdAt: input.createdAt,
  });
}

/** Executor configuration: paths to ffmpeg/ffprobe binaries and a timeout budget. */
export interface MediaTranscodeExecutorConfig {
  ffmpegPath: string;
  ffprobePath: string;
  /** Whole-job budget; clamped to MEDIA_TRANSCODE_TIMEOUT_BOUNDS_MS. */
  timeoutMs: number;
  /**
   * Bound on transcode pipelines running at once; excess jobs wait in a
   * semaphore and stay `queued` until a slot frees. Defaults to
   * MEDIA_TRANSCODE_DEFAULT_MAX_CONCURRENT_JOBS.
   */
  maxConcurrentJobs?: number;
}

/** Dependencies for the media transcode executor. */
export interface MediaTranscodeExecutorOptions {
  store: ProductionJobStore;
  inputs: MediaTranscodeInputStore;
  config: MediaTranscodeExecutorConfig;
  runProcess?: MediaProcessRunner;
  now?: () => Date;
}

/**
 * Local ffmpeg executor for `media.transcode` and `media.proxy` jobs.
 * Both run the same probe → transcode → poster pipeline with the
 * editorial-proxy encoder settings (H.264 yuv420p, CRF 23, AAC 128k,
 * +faststart). A missing ffmpeg/ffprobe binary fails the job with a
 * non-retryable configuration error instead of crashing the gateway.
 */
export class MediaTranscodeExecutor {
  private readonly running = new Set<string>();
  private readonly runProcess: MediaProcessRunner;
  private readonly now: () => Date;
  private readonly defaultTimeoutMs: number;
  private readonly limitConcurrentJob: <T>(task: () => Promise<T>) => Promise<T>;

  constructor(private readonly options: MediaTranscodeExecutorOptions) {
    this.runProcess = options.runProcess ?? runMediaProcess;
    this.now = options.now ?? (() => new Date());
    this.defaultTimeoutMs = clamp(
      options.config.timeoutMs,
      MEDIA_TRANSCODE_TIMEOUT_BOUNDS_MS.min,
      MEDIA_TRANSCODE_TIMEOUT_BOUNDS_MS.max,
    );
    this.limitConcurrentJob = createLimiter(
      Math.max(1, Math.floor(options.config.maxConcurrentJobs ?? MEDIA_TRANSCODE_DEFAULT_MAX_CONCURRENT_JOBS)),
    );
  }

  /**
   * Executes a queued media transcode or proxy job: verifies the staged
   * source, probes it, transcodes to H.264 proxy, extracts a poster frame,
   * and persists all artifacts.
   *
   * @param jobInput - The queued job record.
   * @returns The updated job record, or null when the job is no longer queued.
   * @throws When the job kind is not media.transcode or media.proxy.
   */
  async execute(jobInput: ProductionJobRecord) {
    if (jobInput.kind !== "media.transcode" && jobInput.kind !== "media.proxy") {
      throw new Error(`Cannot transcode production job ${jobInput.kind}`);
    }
    if (this.running.has(jobInput.id)) return this.options.store.get(jobInput.id);
    this.running.add(jobInput.id);
    try {
      // Bounded concurrency: excess jobs wait here and stay `queued` (the
      // running transition happens inside the slot) instead of launching an
      // unbounded number of parallel ffmpeg pipelines.
      return await this.limitConcurrentJob(() => this.executePipeline(jobInput));
    } finally {
      this.running.delete(jobInput.id);
    }
  }

  private async executePipeline(jobInput: ProductionJobRecord) {
    let workingDirectory: string | null = null;
    try {
      const queued = await this.options.store.get(jobInput.id);
      if (
        !queued ||
        (queued.kind !== "media.transcode" && queued.kind !== "media.proxy") ||
        queued.status !== "queued"
      ) {
        return queued;
      }
      const current = await this.options.store.update(
        transitionProductionJob(queued, "running", { progress: 0.05, message: "Verifying staged source media" }),
      );
      try {
        const params = resolveMediaTranscodeParams(queued, this.defaultTimeoutMs);
        const deadline = Date.now() + params.timeoutMs;
        const sourcePath = await this.options.inputs.verifiedSourcePath(params.sourceSha256);
        workingDirectory = await mkdtemp(join(tmpdir(), "director-media-transcode-"));

        await this.progress(current.id, 0.15, "Probing source media");
        const probe = await this.probeSource(sourcePath, deadline);

        await this.progress(current.id, 0.25, `Transcoding H.264 proxy (${params.maxHeight}p ceiling)`);
        const proxyPath = join(workingDirectory, "proxy.mp4");
        await this.transcodeProxy(sourcePath, proxyPath, params, deadline);

        await this.progress(current.id, 0.8, "Extracting poster frame");
        const posterPath = join(workingDirectory, "poster.jpg");
        await this.extractPoster(sourcePath, posterPath, probe.durationSec, deadline);

        const probePath = join(workingDirectory, "probe.json");
        await writeFile(probePath, `${JSON.stringify(probe, null, 2)}\n`);

        const latest = await this.options.store.get(current.id);
        if (!latest || latest.status !== "running") return latest;
        const attempt = latest.attempts.at(-1)!;
        const createdAt = this.now().toISOString();
        const artifactInputs = [
          {
            id: `${attempt.id}-proxy-mp4`,
            role: "proxy",
            mimeType: "video/mp4",
            fileName: "proxy.mp4",
            path: proxyPath,
          },
          {
            id: `${attempt.id}-poster-jpg`,
            role: "poster",
            mimeType: "image/jpeg",
            fileName: "poster.jpg",
            path: posterPath,
          },
          {
            id: `${attempt.id}-probe-json`,
            role: "probe",
            mimeType: "application/json",
            fileName: "probe.json",
            path: probePath,
          },
        ];
        const artifacts = [];
        for (const input of artifactInputs) {
          const artifact = await fileArtifact({ ...input, attemptId: attempt.id, createdAt });
          const target = this.options.store.artifactFilePath(latest.id, attempt.id, artifact.fileName);
          await mkdir(dirname(target), { recursive: true });
          // copyFile overwrites, so replaying an attempt after a crash between
          // artifact writes and the succeeded transition stays safe.
          await copyFile(input.path, target);
          artifacts.push(artifact);
        }
        return this.options.store.update(
          transitionProductionJob(latest, "succeeded", {
            progress: 1,
            message: `Transcoded ${probe.width ?? "?"}x${probe.height ?? "?"} source into proxy, poster, and probe artifacts`,
            artifacts,
            artifact: artifacts[0],
          }),
        );
      } catch (error) {
        const latest = await this.options.store.get(jobInput.id);
        if (!latest || latest.status === "cancelled") return latest;
        if (latest.status !== "running") throw error;
        const failure = toStructuredFailure(error);
        return this.options.store.update(
          transitionProductionJob(latest, "failed", {
            message: "Media transcode failed",
            error: failure.message,
            structuredError: failure,
          }),
        );
      }
    } finally {
      if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
    }
  }

  /** Progress updates are best-effort and never revive a non-running job. */
  private async progress(jobId: string, progress: number, message: string): Promise<void> {
    const latest = await this.options.store.get(jobId);
    if (!latest || latest.status !== "running") return;
    await this.options.store.update(transitionProductionJob(latest, "running", { progress, message }));
  }

  private async runTool(tool: "ffmpeg" | "ffprobe", args: string[], deadline: number, failureCode: string) {
    const path = tool === "ffmpeg" ? this.options.config.ffmpegPath : this.options.config.ffprobePath;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new MediaTranscodeJobError(
        "The media transcode timeout budget was exhausted",
        "media_transcode_timeout",
        true,
      );
    }
    let result;
    try {
      result = await this.runProcess(path, args, { timeoutMs: remainingMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const envVar = tool === "ffmpeg" ? "DIRECTOR_FFMPEG_PATH" : "DIRECTOR_FFPROBE_PATH";
        throw new MediaTranscodeJobError(
          `${tool} was not found at "${path}"; install FFmpeg or set ${envVar} to the ${tool} binary`,
          `${tool}_not_configured`,
          false,
        );
      }
      throw error;
    }
    if (result.timedOut) {
      throw new MediaTranscodeJobError(
        `${tool} was terminated after exceeding the transcode timeout`,
        "media_transcode_timeout",
        true,
      );
    }
    if (result.code !== 0) {
      const detail = stderrTail(result.stderr);
      throw new MediaTranscodeJobError(
        `${tool} exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`,
        failureCode,
        false,
      );
    }
    return result;
  }

  private async probeSource(sourcePath: string, deadline: number) {
    const result = await this.runTool(
      "ffprobe",
      ["-hide_banner", "-loglevel", "error", "-print_format", "json", "-show_format", "-show_streams", sourcePath],
      deadline,
      "ffprobe_failed",
    );
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new MediaTranscodeJobError("ffprobe did not return valid JSON", "ffprobe_failed", false);
    }
    return summarizeProbe(raw);
  }

  private async transcodeProxy(
    sourcePath: string,
    proxyPath: string,
    params: ResolvedMediaTranscodeParams,
    deadline: number,
  ) {
    await this.runTool(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        sourcePath,
        "-map",
        "0:v:0",
        // The trailing ? keeps audio optional: silent sources still transcode.
        "-map",
        "0:a:0?",
        "-vf",
        mediaTranscodeScaleFilter(params),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        String(params.videoCrf),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        `${params.audioBitrateKbps}k`,
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        proxyPath,
      ],
      deadline,
      "ffmpeg_failed",
    );
  }

  private async extractPoster(sourcePath: string, posterPath: string, durationSec: number | null, deadline: number) {
    await this.runTool(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-ss",
        String(posterSeekSeconds(durationSec)),
        "-i",
        sourcePath,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-q:v",
        "3",
        posterPath,
      ],
      deadline,
      "ffmpeg_failed",
    );
  }
}
