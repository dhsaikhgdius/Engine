import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  captureReconstructionPlanSchema,
  captureReconstructionReportSchema,
  type CaptureReconstructionPlan,
  type CaptureReconstructionReport,
} from "../../../packages/protocol/src/captureReconstructionProtocol";
import {
  productionJobArtifactSchema,
  transitionProductionJob,
  type ProductionJobArtifact,
  type ProductionJobError,
  type ProductionJobRecord,
  type ProductionJobSpec,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import { runMediaProcess, type MediaProcessRunner } from "../media/mediaProcessRunner";
import { mediaTranscodeScaleFilter } from "../media/mediaTranscodeExecutor";
import {
  MediaInputIntegrityError,
  MediaInputMissingError,
  type MediaTranscodeInputStore,
} from "../media/mediaTranscodeInputStore";
import { composeCaptureReconstructionPlan } from "./captureReconstructionPlan";

/**
 * Local executor for the `scene.reconstruct` production job. It stages the
 * capture (zip bundle or video), pre-extracts video frames with ffmpeg,
 * spawns the deterministic Python worker (`backend/inference/scenerecon`),
 * mirrors the worker's status.json progress into the durable job, validates
 * recon.json, composes the walkable stage plan, and publishes everything as
 * immutable job artifacts (plan, report, key views, shell mesh).
 */

/** Narrowed job spec for scene reconstruction jobs. */
export type CaptureReconstructionJobSpec = Extract<ProductionJobSpec, { kind: "scene.reconstruct" }>;

const STAGED_SOURCE_ID_PATTERN = /^(?:[A-Za-z0-9._-]+:)*sha256:([a-f0-9]{64})$/;
const VIDEO_FRAME_RATE = 2;
const VIDEO_MAX_FRAMES = 96;
const STDERR_TAIL_CHARS = 1_500;

/** Timeout bounds for scene reconstruction jobs. */
export const CAPTURE_RECONSTRUCTION_TIMEOUT_BOUNDS_MS = {
  min: 60_000,
  max: 2 * 60 * 60_000,
  fallback: 10 * 60_000,
} as const;

/** status.json written atomically by the Python worker after every stage. */
const workerStatusSchema = z.looseObject({
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  progress: z.number().min(0).max(1).default(0),
  message: z.string().max(2_000).default(""),
  error: z.string().max(4_000).optional(),
  warnings: z.array(z.string().max(1_000)).max(20).default([]),
});

/**
 * Structured error for scene reconstruction failures with a machine-readable
 * code and retryability flag.
 */
export class CaptureReconstructionJobError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CaptureReconstructionJobError";
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function stderrTail(stderr: string) {
  const trimmed = stderr.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

function toStructuredFailure(error: unknown): ProductionJobError {
  if (error instanceof CaptureReconstructionJobError) {
    return { code: error.code, message: error.message.slice(0, 12_000), retryable: error.retryable };
  }
  if (error instanceof MediaInputMissingError || error instanceof MediaInputIntegrityError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  const message =
    error instanceof Error && error.message ? error.message.slice(0, 12_000) : "Capture reconstruction failed";
  return { code: "scene_reconstruct_failed", message, retryable: false };
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

/** Shell asset extent for the plan: floor bbox plus wall height. */
function reportSizeM(report: CaptureReconstructionReport): [number, number, number] {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const point of report.floor?.polygon ?? []) {
    xs.push(point[0]);
    zs.push(point[1]);
  }
  for (const wall of report.walls) {
    xs.push(wall.start[0], wall.end[0]);
    zs.push(wall.start[1], wall.end[1]);
  }
  if (!xs.length || !zs.length) return [1, 1, 1];
  const height = report.walls.length ? Math.max(...report.walls.map((wall) => wall.heightM)) : 2.6;
  return [
    Math.max(Math.max(...xs) - Math.min(...xs), 0.01),
    Math.max(height, 0.01),
    Math.max(Math.max(...zs) - Math.min(...zs), 0.01),
  ];
}

/** Executor configuration: paths to Python, the worker package, and ffmpeg. */
export interface CaptureReconstructionExecutorConfig {
  pythonBin: string;
  /** PYTHONPATH for the worker package (backend/inference/scenerecon/src). */
  workerDir: string;
  ffmpegPath: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}

/** Dependencies for the capture reconstruction executor. */
export interface CaptureReconstructionExecutorOptions {
  store: ProductionJobStore;
  inputs: MediaTranscodeInputStore;
  config: CaptureReconstructionExecutorConfig;
  runProcess?: MediaProcessRunner;
  now?: () => Date;
}

/**
 * Local executor for `scene.reconstruct` production jobs. Stages the capture
 * (zip bundle or video), pre-extracts video frames with ffmpeg, spawns the
 * deterministic Python worker (`backend/inference/scenerecon`), mirrors the
 * worker's status.json progress into the durable job, validates recon.json,
 * composes the walkable stage plan, and publishes everything as immutable
 * job artifacts.
 */
export class CaptureReconstructionExecutor {
  private readonly running = new Set<string>();
  private readonly runProcess: MediaProcessRunner;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: CaptureReconstructionExecutorOptions) {
    this.runProcess = options.runProcess ?? runMediaProcess;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = clamp(
      options.config.timeoutMs,
      CAPTURE_RECONSTRUCTION_TIMEOUT_BOUNDS_MS.min,
      CAPTURE_RECONSTRUCTION_TIMEOUT_BOUNDS_MS.max,
    );
    this.pollIntervalMs = clamp(options.config.pollIntervalMs ?? 750, 50, 10_000);
  }

  /**
   * Executes a queued scene reconstruction job: stages the capture, extracts
   * frames, runs the Python worker, and publishes artifacts.
   *
   * @param jobInput - The queued job record.
   * @returns The updated job record, or null when the job is no longer queued.
   * @throws When the job kind is not scene.reconstruct.
   */
  async execute(jobInput: ProductionJobRecord) {
    if (jobInput.kind !== "scene.reconstruct") {
      throw new Error(`Cannot reconstruct production job ${jobInput.kind}`);
    }
    if (this.running.has(jobInput.id)) return this.options.store.get(jobInput.id);
    this.running.add(jobInput.id);
    let taskDir: string | null = null;
    try {
      const queued = await this.options.store.get(jobInput.id);
      if (!queued || queued.kind !== "scene.reconstruct" || queued.status !== "queued") return queued;
      const current = await this.options.store.update(
        transitionProductionJob(queued, "running", { progress: 0.03, message: "校验已暂存的采集输入" }),
      );
      try {
        const sourceMatch = queued.input.sourceMediaId.match(STAGED_SOURCE_ID_PATTERN);
        if (!sourceMatch) {
          throw new CaptureReconstructionJobError(
            'sourceMediaId 必须引用已暂存的媒体输入（以 "sha256:<64 hex>" 结尾）；请先 POST /api/production-jobs/media-inputs 上传字节',
            "unsupported_job_input",
            false,
          );
        }
        const sourceSha256 = sourceMatch[1]!;
        const deadline = Date.now() + this.timeoutMs;
        const sourcePath = await this.options.inputs.verifiedSourcePath(sourceSha256);
        taskDir = await mkdtemp(join(tmpdir(), "director-scenerecon-"));
        const outDir = join(taskDir, "out");
        await mkdir(outDir, { recursive: true });

        let framesDir: string | null = null;
        if (queued.input.sourceKind === "rgb-video") {
          await this.progress(current.id, 0.08, "使用 ffmpeg 抽取视频帧");
          framesDir = join(taskDir, "frames");
          await mkdir(framesDir, { recursive: true });
          await this.extractFrames(sourcePath, framesDir, deadline);
          const extracted = await readdir(framesDir);
          if (!extracted.length) {
            throw new CaptureReconstructionJobError(
              "ffmpeg 没有从该视频中抽出任何帧；请确认源文件是可解码的视频",
              "video_decode_failed",
              false,
            );
          }
        }

        await writeFile(
          join(taskDir, "task.json"),
          JSON.stringify({
            kind: queued.input.sourceKind,
            inputPath: queued.input.sourceKind === "rgbd-bundle" ? sourcePath : null,
            framesDir,
            outDir,
            maxKeyViews: queued.input.maxKeyViews,
            maxObjects: queued.input.maxObjects,
            gridResolution: queued.input.gridResolution,
            prompt: queued.input.prompt,
          }),
        );

        await this.progress(current.id, 0.1, "启动确定性重建 worker");
        await this.runWorker(current.id, taskDir, deadline);

        const report = await this.readReport(outDir);
        const latest = await this.options.store.get(current.id);
        if (!latest || latest.status !== "running") return latest;
        const attempt = latest.attempts.at(-1)!;
        const createdAt = this.now().toISOString();

        const keyViewArtifactIds: Record<string, string> = {};
        const artifactInputs: Array<{
          id: string;
          role: string;
          mimeType: string;
          fileName: string;
          path: string;
        }> = [
          {
            id: `${attempt.id}-report-json`,
            role: "report",
            mimeType: "application/json",
            fileName: "recon.json",
            path: join(outDir, "recon.json"),
          },
        ];
        for (const view of report.keyViews) {
          const artifactId = `${attempt.id}-keyview-${view.id}`;
          keyViewArtifactIds[view.id] = artifactId;
          artifactInputs.push({
            id: artifactId,
            role: "keyview",
            mimeType: "image/png",
            fileName: `keyview-${view.fileName}`,
            path: join(outDir, "keyviews", view.fileName),
          });
        }
        const meshArtifactId = report.mesh ? `${attempt.id}-shell-glb` : null;
        if (report.mesh && meshArtifactId) {
          artifactInputs.push({
            id: meshArtifactId,
            role: "shell",
            mimeType: "model/gltf-binary",
            fileName: report.mesh.fileName,
            path: join(outDir, report.mesh.fileName),
          });
        }

        const plan = composeCaptureReconstructionPlan(report, {
          jobId: latest.id,
          planId: `capture-plan-${latest.id}`,
          createdAt,
          source: { kind: queued.input.sourceKind, fileName: queued.input.fileName, sha256: sourceSha256 },
          prompt: queued.input.prompt,
          keyViewArtifactIds,
          meshArtifactId,
          meshSizeM: reportSizeM(report),
        });
        const planPath = join(outDir, "plan.json");
        await writeFile(planPath, JSON.stringify(plan, null, 2));
        artifactInputs.unshift({
          id: `${attempt.id}-plan-json`,
          role: "plan",
          mimeType: "application/json",
          fileName: "plan.json",
          path: planPath,
        });

        await this.progress(current.id, 0.95, "归档重建工件");
        const artifacts: ProductionJobArtifact[] = [];
        for (const input of artifactInputs) {
          const artifact = await fileArtifact({ ...input, attemptId: attempt.id, createdAt });
          const target = this.options.store.artifactFilePath(latest.id, attempt.id, artifact.fileName);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(input.path, target);
          artifacts.push(artifact);
        }
        const refreshed = await this.options.store.get(current.id);
        if (!refreshed || refreshed.status !== "running") return refreshed;
        return this.options.store.update(
          transitionProductionJob(refreshed, "succeeded", {
            progress: 1,
            message:
              report.status === "ready"
                ? `重建完成：${report.metrics.wallCount} 面墙、${report.metrics.objectCount} 个物体、${report.metrics.keyViewCount} 个关键视图`
                : "重建完成（降级）：纯 RGB 输入仅生成关键视图与脚手架计划",
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
            message: "采集重建失败",
            error: failure.message,
            structuredError: failure,
          }),
        );
      }
    } finally {
      if (taskDir) await rm(taskDir, { recursive: true, force: true });
      this.running.delete(jobInput.id);
    }
  }

  /** Reads the composed plan back from a succeeded job's artifacts. */
  /**
   * Reads the composed plan back from a succeeded job's artifacts.
   *
   * @param job - The succeeded job record.
   * @returns The reconstruction plan, or null when no plan artifact exists.
   */
  async readPlan(job: ProductionJobRecord): Promise<CaptureReconstructionPlan | null> {
    const artifact = job.artifacts.find((candidate) => candidate.role === "plan");
    if (!artifact) return null;
    const bytes = await this.options.store.readArtifact(job, artifact);
    return captureReconstructionPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
  }

  private async progress(jobId: string, progress: number, message: string): Promise<void> {
    const latest = await this.options.store.get(jobId);
    if (!latest || latest.status !== "running") return;
    await this.options.store.update(transitionProductionJob(latest, "running", { progress, message }));
  }

  private async extractFrames(sourcePath: string, framesDir: string, deadline: number) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CaptureReconstructionJobError("采集重建超时预算已耗尽", "scene_reconstruct_timeout", true);
    }
    let result;
    try {
      result = await this.runProcess(
        this.options.config.ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-i",
          sourcePath,
          "-vf",
          `fps=${VIDEO_FRAME_RATE},${mediaTranscodeScaleFilter({ maxHeight: 480, maxWidth: 640 })}`,
          "-frames:v",
          String(VIDEO_MAX_FRAMES),
          "-q:v",
          "3",
          join(framesDir, "frame-%04d.jpg"),
        ],
        { timeoutMs: remainingMs },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CaptureReconstructionJobError(
          `ffmpeg 未找到（"${this.options.config.ffmpegPath}"）；请安装 FFmpeg 或设置 DIRECTOR_FFMPEG_PATH`,
          "ffmpeg_not_configured",
          false,
        );
      }
      throw error;
    }
    if (result.timedOut) {
      throw new CaptureReconstructionJobError("视频抽帧超时", "scene_reconstruct_timeout", true);
    }
    if (result.code !== 0) {
      const detail = stderrTail(result.stderr);
      throw new CaptureReconstructionJobError(
        `ffmpeg 抽帧失败（code ${result.code ?? "unknown"}）${detail ? `：${detail}` : ""}`,
        "video_decode_failed",
        false,
      );
    }
  }

  private async runWorker(jobId: string, taskDir: string, deadline: number) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CaptureReconstructionJobError("采集重建超时预算已耗尽", "scene_reconstruct_timeout", true);
    }
    let settled = false;
    const workerPromise = (async () => {
      try {
        return await this.runProcess(this.options.config.pythonBin, ["-m", "scenerecon", "--task-dir", taskDir], {
          timeoutMs: remainingMs,
          env: { PYTHONPATH: this.options.config.workerDir },
        });
      } finally {
        settled = true;
      }
    })();

    // Mirror the worker's status.json into the durable job while it runs.
    const mirror = (async () => {
      while (!settled) {
        await new Promise((resolvePoll) => setTimeout(resolvePoll, this.pollIntervalMs));
        if (settled) break;
        const status = await this.readWorkerStatus(taskDir);
        if (status?.status === "running") {
          await this.progress(jobId, 0.1 + status.progress * 0.8, status.message || "重建进行中");
        }
      }
    })();

    let result;
    try {
      result = await workerPromise;
    } catch (error) {
      await mirror.catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CaptureReconstructionJobError(
          `Python 解释器未找到（"${this.options.config.pythonBin}"）；请安装带 numpy/pillow/trimesh 的 Python 3.11+，或设置 DIRECTOR_SCENERECON_PYTHON`,
          "scenerecon_not_configured",
          false,
        );
      }
      throw error;
    }
    await mirror.catch(() => undefined);

    if (result.timedOut) {
      throw new CaptureReconstructionJobError("重建 worker 超时被终止", "scene_reconstruct_timeout", true);
    }
    if (result.code !== 0) {
      const status = await this.readWorkerStatus(taskDir);
      const detail = status?.error || stderrTail(result.stderr) || `worker 退出码 ${result.code ?? "unknown"}`;
      throw new CaptureReconstructionJobError(`重建 worker 失败：${detail}`, "scenerecon_failed", false);
    }
  }

  private async readWorkerStatus(taskDir: string) {
    try {
      const raw = JSON.parse(await readFile(join(taskDir, "status.json"), "utf8")) as unknown;
      const parsed = workerStatusSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async readReport(outDir: string): Promise<CaptureReconstructionReport> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(outDir, "recon.json"), "utf8"));
    } catch {
      throw new CaptureReconstructionJobError("worker 未写出 recon.json", "scenerecon_failed", false);
    }
    const parsed = captureReconstructionReportSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CaptureReconstructionJobError(
        `recon.json 不符合重建契约：${issue?.path.join(".") ?? "root"} ${issue?.message ?? "格式错误"}`,
        "scenerecon_contract_mismatch",
        false,
      );
    }
    return parsed.data;
  }
}
