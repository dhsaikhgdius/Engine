import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  normalizeLtxDimension,
  normalizeLtxFrameCount,
  type VideoProviderCapability,
} from "../../../../packages/protocol/src/videoGenerationProtocol";
import {
  parseVideoGenerationRequest,
  parseVideoProviderJob,
  type VideoGenerationRequest,
  type VideoProvider,
  type VideoProviderHealth,
  type VideoProviderJob,
} from "./videoProvider";

/**
 * Local LTX-2.3 video provider that spawns the vendored DistilledPipeline as
 * a per-job child process under `uv run` — there is no resident inference
 * worker, so a cold gateway holds no GPU memory between jobs. Job state is
 * in-memory only: the tracked job map does not survive a restart, and the
 * MP4 plus the exact request JSON are persisted under the job directory so a
 * finished render remains inspectable after the process map is gone.
 *
 * Submission is idempotent on the request's idempotency key: replaying the
 * same key with the same request returns the tracked job, while the same key
 * with a *different* request is rejected instead of silently rendering
 * something else. Requests are normalized to the pipeline's hard constraints
 * (dimensions in multiples of 64, frame counts of the form 8k+1, integer
 * frame rates) and every silent adjustment is surfaced as a job warning so
 * callers learn what actually rendered.
 */

export type Ltx23SpawnProviderOptions = {
  /** Root of the vendored LTX source tree (`uv run --project` target). */
  sourceRoot: string;
  distilledCheckpointPath: string;
  spatialUpsamplerPath: string;
  gemmaRoot: string;
  /** Path to the generate entrypoint script executed per job. */
  generateScript: string;
  /** Directory that owns per-job request/output files. */
  dataDirectory: string;
  uvBinary?: string;
  model?: string;
  /** Wall-clock budget per render; the process group is killed past it. */
  timeoutMs?: number;
  device?: string;
  quantization?: string;
  offload?: string;
  repository?: string;
  commit?: string;
  pipelineVersion?: string;
  /** Injectable spawn for tests. */
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
};

/** In-memory record of one spawned render: job state plus process handles. */
type TrackedJob = {
  job: VideoProviderJob;
  /** Digest of the normalized request, used to police idempotency-key reuse. */
  requestDigest: string;
  outputPath: string;
  child?: ChildProcess;
  /** Bounded tail of stderr, kept for the failure message. */
  stderrTail: string[];
};

function nowIso() {
  return new Date().toISOString();
}

function digestRequest(request: VideoGenerationRequest) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

/** Validates the job-id shape; the id doubles as an on-disk directory name. */
function parseJobId(value: string) {
  if (!/^video-[a-z0-9-]{8,80}$/i.test(value)) throw new Error("Invalid video job id");
  return value;
}

/**
 * Terminates the whole detached process group (the pipeline forks workers),
 * escalating SIGTERM → SIGKILL after a grace period. Falls back to killing
 * the direct child when group signalling is unavailable.
 */
function killGroup(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 3_000).unref();
}

/**
 * Local LTX-2.3 provider: Gateway spawns the official DistilledPipeline once per
 * job, the same way ARDY spawns `scripts/generate.py`. There is no resident HTTP worker.
 */
export class Ltx23SpawnProvider implements VideoProvider {
  readonly id = "ltx-2.3" as const;
  private readonly spawnImpl: NonNullable<Ltx23SpawnProviderOptions["spawnImpl"]>;
  private readonly jobs = new Map<string, TrackedJob>();

  constructor(private readonly options: Ltx23SpawnProviderOptions) {
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  }

  async capabilities(_signal?: AbortSignal): Promise<VideoProviderCapability> {
    return {
      id: "ltx-2.3",
      label: "LTX-2.3 DistilledPipeline",
      configured: true,
      supportsImageConditioning: true,
      supportsAudio: true,
      supportsNegativePrompt: false,
      dimensionMultiple: 64,
      frameCountRule: "8k+1",
      model: this.options.model ?? "ltx-2.3-22b",
      ...(this.runtimeSource ? { runtimeSource: this.runtimeSource } : {}),
    };
  }

  async health(_signal?: AbortSignal): Promise<VideoProviderHealth> {
    // Spawn-per-job means the model is never resident between jobs: the
    // provider is "cold" when idle and "loading" while a child is rendering.
    const running = [...this.jobs.values()].find((entry) => entry.job.status === "running");
    return {
      provider: "ltx-2.3",
      status: running ? "loading" : "cold",
      modelLoaded: false,
      activeJobId: running?.job.id ?? null,
      detail: null,
      ...(this.runtimeSource ? { runtimeSource: this.runtimeSource } : {}),
    };
  }

  async submit(rawRequest: VideoGenerationRequest, signal?: AbortSignal): Promise<VideoProviderJob> {
    const request = parseVideoGenerationRequest(rawRequest);
    // Normalize to the pipeline's hard constraints; every adjustment below
    // becomes a warning so the caller learns what actually rendered.
    const width = normalizeLtxDimension(request.width);
    const height = normalizeLtxDimension(request.height);
    const numFrames = normalizeLtxFrameCount(request.numFrames);
    const frameRate = Math.min(60, Math.max(1, Math.round(request.frameRate)));
    const warnings: string[] = [];
    if (width !== request.width || height !== request.height) {
      warnings.push(`LTX-2.3 aligned the render to ${width}x${height} (multiples of 64).`);
    }
    if (numFrames !== request.numFrames) {
      warnings.push(`LTX-2.3 aligned the frame count to ${numFrames} (8k+1).`);
    }
    if (frameRate !== request.frameRate) {
      warnings.push(
        `The current LTX-2.3 MP4 encoder uses an integer frame rate; ${request.frameRate} became ${frameRate}.`,
      );
    }
    if (request.negativePrompt) {
      warnings.push("DistilledPipeline does not consume a negative prompt; it was retained only as job metadata.");
    }
    // DistilledPipeline only consumes plain image conditioning; other control
    // roles (depth, pose, …) are dropped with an explicit warning.
    const conditioning = request.conditioning.filter(
      (input) => input.role === "reference" || input.role === "clean-frame",
    );
    const skippedRoles = [
      ...new Set(request.conditioning.filter((input) => !conditioning.includes(input)).map((input) => input.role)),
    ];
    if (skippedRoles.length) {
      warnings.push(
        `DistilledPipeline does not consume ${skippedRoles.join(", ")} controls; those inputs were not submitted.`,
      );
    }

    const normalized = parseVideoGenerationRequest({
      ...request,
      width,
      height,
      frameRate,
      numFrames,
      conditioning,
    });
    // Idempotency: the same key with the same normalized request replays the
    // tracked job; the same key with different content is a caller bug.
    const requestDigest = digestRequest(normalized);
    const existing = this.jobs.get(normalized.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new Error("Idempotency-Key was already used with a different request");
      }
      return existing.job;
    }

    // The request JSON is persisted next to the output so a finished render
    // stays reproducible and inspectable after the in-memory job map is gone.
    const jobId = parseJobId(normalized.idempotencyKey);
    const jobDirectory = resolve(this.options.dataDirectory, "video-jobs", jobId);
    const outputPath = resolve(jobDirectory, "output.mp4");
    const requestPath = resolve(jobDirectory, "ltx-request.json");
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(
      requestPath,
      `${JSON.stringify(
        {
          prompt: normalized.prompt,
          width,
          height,
          frame_rate: frameRate,
          num_frames: numFrames,
          seed: normalized.seed,
          generate_audio: normalized.generateAudio,
          enhance_prompt: normalized.enhancePrompt,
          images: conditioning.map((input) => ({
            path: input.uri,
            frame_idx: input.frameIndex,
            strength: input.strength,
            crf: input.crf,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const createdAt = nowIso();
    const tracked: TrackedJob = {
      requestDigest,
      outputPath,
      stderrTail: [],
      job: parseVideoProviderJob({
        id: jobId,
        provider: "ltx-2.3",
        status: "running",
        createdAt,
        updatedAt: createdAt,
        progress: { phase: "loading-model", percent: 5 },
        outputs: [],
        error: null,
        cancelRequested: false,
        warnings,
      }),
    };
    this.jobs.set(jobId, tracked);
    this.spawnJob(tracked, requestPath, signal);
    return tracked.job;
  }

  async getJob(jobId: string, _signal?: AbortSignal): Promise<VideoProviderJob> {
    const tracked = this.jobs.get(parseJobId(jobId));
    if (!tracked) throw new Error("Unknown video job");
    return tracked.job;
  }

  async cancel(jobId: string, _signal?: AbortSignal): Promise<VideoProviderJob> {
    const tracked = this.jobs.get(parseJobId(jobId));
    if (!tracked) throw new Error("Unknown video job");
    tracked.job.cancelRequested = true;
    tracked.job.updatedAt = nowIso();
    if (tracked.child) killGroup(tracked.child);
    // Mark cancelled immediately; the exit handler checks this status so a
    // late nonzero exit does not overwrite the cancellation with a failure.
    if (tracked.job.status === "running" || tracked.job.status === "queued") {
      tracked.job.status = "cancelled";
      tracked.job.progress = { phase: "cancelled", percent: tracked.job.progress?.percent ?? 0 };
    }
    return tracked.job;
  }

  /** Provenance of the vendored pipeline, reported only when fully known. */
  private get runtimeSource() {
    if (!this.options.repository || !this.options.commit) return undefined;
    return {
      kind: "official-source" as const,
      repository: this.options.repository,
      commit: this.options.commit,
      packageVersion: this.options.pipelineVersion ?? "unknown",
      pipeline: "ltx_pipelines.distilled.DistilledPipeline",
    };
  }

  /**
   * Launches the render child (detached, so the whole process group can be
   * killed), wires the watchdog timeout and abort signal, and parses
   * `PROGRESS <phase> <percent>` lines from stdout into live job progress.
   */
  private spawnJob(tracked: TrackedJob, requestPath: string, signal?: AbortSignal) {
    const uvBinary = this.options.uvBinary?.trim() || "uv";
    const args = [
      "run",
      "--project",
      this.options.sourceRoot,
      "--frozen",
      "--package",
      "ltx-pipelines",
      "python",
      this.options.generateScript,
      "--request",
      requestPath,
      "--output",
      tracked.outputPath,
    ];
    const child = this.spawnImpl(uvBinary, args, {
      cwd: dirname(this.options.generateScript),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        DIRECTOR_ACCEPT_LTX2_LICENSE: "1",
        LTX23_DISTILLED_CHECKPOINT_PATH: this.options.distilledCheckpointPath,
        LTX23_SPATIAL_UPSAMPLER_PATH: this.options.spatialUpsamplerPath,
        LTX23_GEMMA_ROOT: this.options.gemmaRoot,
        LTX23_DEVICE: this.options.device ?? "",
        LTX23_QUANTIZATION: this.options.quantization ?? "",
        LTX23_OFFLOAD: this.options.offload ?? "none",
        PYTHONUNBUFFERED: "1",
      },
    });
    tracked.child = child;

    const timeout = setTimeout(
      () => {
        killGroup(child);
        this.fail(tracked, `LTX-2.3 generation exceeded ${this.options.timeoutMs ?? 60 * 60_000}ms and was terminated`);
      },
      this.options.timeoutMs ?? 60 * 60_000,
    );
    const onAbort = () => {
      void this.cancel(tracked.job.id);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const match = /^PROGRESS\s+(\S+)\s+(\d+(?:\.\d+)?)\s*$/.exec(line.trim());
        if (!match || tracked.job.status !== "running") continue;
        tracked.job.progress = { phase: match[1]!, percent: Number(match[2]) };
        tracked.job.updatedAt = nowIso();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      tracked.stderrTail.push(chunk.toString("utf8"));
      while (tracked.stderrTail.length > 40) tracked.stderrTail.shift();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      this.fail(tracked, `Failed to launch LTX-2.3: ${error.message}`);
    });
    child.once("exit", (code, exitSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      // A cancelled job already carries its terminal state; the exit of the
      // killed child must not rewrite it.
      if (tracked.job.status === "cancelled") return;
      if (code === 0) {
        void this.complete(tracked);
        return;
      }
      const detail = tracked.stderrTail.join("").trim().split("\n").slice(-6).join("\n");
      this.fail(
        tracked,
        `LTX-2.3 exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`,
      );
    });
  }

  /**
   * Verifies the render actually produced a non-empty MP4 before reporting
   * success — a zero exit code alone is not trusted — and records the file's
   * size and sha256 as the output artifact.
   */
  private async complete(tracked: TrackedJob) {
    try {
      const info = await stat(tracked.outputPath);
      if (!info.isFile() || info.size === 0) {
        this.fail(tracked, "LTX-2.3 finished without writing an MP4");
        return;
      }
      const bytes = await readFile(tracked.outputPath);
      tracked.job.status = "completed";
      tracked.job.progress = { phase: "completed", percent: 100 };
      tracked.job.updatedAt = nowIso();
      tracked.job.outputs = [
        {
          kind: "video",
          uri: tracked.outputPath,
          mimeType: "video/mp4",
          bytes: info.size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ];
    } catch (error) {
      this.fail(tracked, error instanceof Error ? error.message : String(error));
    }
  }

  // Terminal states are sticky: a late failure cannot demote a completed or
  // cancelled job.
  private fail(tracked: TrackedJob, message: string) {
    if (tracked.job.status === "cancelled" || tracked.job.status === "completed") return;
    tracked.job.status = "failed";
    tracked.job.updatedAt = nowIso();
    tracked.job.error = { code: "ltx23-spawn-failed", message: message.slice(0, 4_000), retriable: true };
  }
}
