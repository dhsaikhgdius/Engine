import type {
  ProductionJobKind,
  ProductionJobRecord,
  ProductionJobStatus,
} from "../../../../../../packages/protocol/src/productionJobProtocol";

/** Human-readable labels for every production job kind. */
export const TASK_KIND_LABELS: Record<ProductionJobKind, string> = {
  "canvas.image": "画布图像",
  "canvas.video": "画布视频",
  "image.generate": "图像生成",
  "video.generate": "视频生成",
  "model.generate": "3D 生成",
  "audio.generate": "音频生成",
  "scene.reconstruct": "场景重建",
  "media.proxy": "媒体代理",
  "media.transcribe": "语音转写",
  "media.transcode": "媒体转码",
  "dcc.export": "DCC 导出",
  "dcc.import": "DCC 导入",
  "episode.package": "Episode 封装",
};

/** Human-readable labels for every production job status. */
export const TASK_STATUS_LABELS: Record<ProductionJobStatus, string> = {
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  outcome_unknown: "结果待确认",
  reconciling: "正在核对结果",
};

/** Statuses that keep the fast polling loop and the top-bar badge alive. */
export const ACTIVE_TASK_STATUSES: ReadonlySet<ProductionJobStatus> = new Set(["queued", "running", "reconciling"]);

/**
 * Returns a localized label for the given job kind.
 *
 * @param kind - The production job kind.
 * @returns The label, or the raw kind string as a fallback.
 */
export function taskKindLabel(kind: ProductionJobKind): string {
  return TASK_KIND_LABELS[kind] ?? kind;
}

/**
 * Returns a localized label for the given job status.
 *
 * @param status - The production job status.
 * @returns The label, or the raw status as a fallback.
 */
export function taskStatusLabel(status: ProductionJobStatus): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

/**
 * Returns whether a job is still active (queued, running, or reconciling).
 *
 * @param job - The production job record.
 */
export function taskIsActive(job: ProductionJobRecord): boolean {
  return ACTIVE_TASK_STATUSES.has(job.status);
}

/**
 * Returns a human-readable display name for a job, derived from its kind and input.
 *
 * @param job - The production job record.
 * @returns A descriptive name, or the job id as a fallback for unknown kinds.
 */
export function taskDisplayName(job: ProductionJobRecord): string {
  switch (job.kind) {
    case "canvas.image":
    case "canvas.video":
    case "image.generate":
    case "video.generate":
    case "audio.generate":
      return job.input.prompt;
    case "model.generate":
      return job.input.name;
    case "media.transcribe":
      return job.input.sourceFileName;
    case "media.transcode":
      return `转码为 ${job.input.targetMimeType}`;
    case "media.proxy":
      return `代理 ${job.input.maxWidth}×${job.input.maxHeight}`;
    case "dcc.export":
      return `导出为 ${job.input.format.toUpperCase()}`;
    case "dcc.import":
      return job.input.format ? `导入 ${job.input.format.toUpperCase()} 素材` : "导入外部素材";
    case "episode.package":
      return `封装 ${job.input.episodeId}`;
    case "scene.reconstruct":
      return job.input.fileName;
    default:
      // The switch is exhaustive over ProductionJobKind; keep the id as a
      // defensive fallback for kinds added to the protocol later.
      return (job as ProductionJobRecord).id;
  }
}

/**
 * Returns the most precise failure reason for a job.
 * Structured attempt errors take priority; the top-level error field is the fallback.
 *
 * @param job - The production job record.
 * @returns A trimmed error message, or null when no error is available.
 */
export function taskFailureReason(job: ProductionJobRecord): string | null {
  const attemptError = job.attempts.at(-1)?.error?.message;
  const reason = attemptError ?? job.error ?? null;
  return reason?.trim() ? reason.trim() : null;
}

/**
 * Returns the ISO timestamp when the job's most recent attempt started,
 * falling back to the attempt creation time or the job creation time.
 *
 * @param job - The production job record.
 * @returns An ISO 8601 timestamp string.
 */
export function taskStartedAt(job: ProductionJobRecord): string {
  const attempt = job.attempts.at(-1);
  return attempt?.timestamps.startedAt ?? attempt?.timestamps.createdAt ?? job.createdAt;
}

/**
 * Converts the job's progress fraction (0–1) to a clamped 0–100 integer percentage.
 *
 * @param job - The production job record.
 * @returns An integer between 0 and 100.
 */
export function taskProgressPercent(job: ProductionJobRecord): number {
  return Math.max(0, Math.min(100, Math.round(job.progress * 100)));
}

/**
 * Formats an ISO timestamp as a human-readable relative time string in Chinese.
 *
 * @param iso - An ISO 8601 timestamp string.
 * @param now - The reference timestamp in ms (defaults to `Date.now()`).
 * @returns A relative time string like "刚刚", "5 分钟前", or a full date for older timestamps.
 */
export function formatTaskRelativeTime(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const elapsedMs = now - timestamp;
  if (elapsedMs < 60_000) return "刚刚";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}
